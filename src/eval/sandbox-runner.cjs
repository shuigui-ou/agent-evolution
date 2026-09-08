/**
 * @module eval/sandbox-runner
 * @layer eval
 * @owner kou
 * 子进程沙箱：一次 spawn 批量执行若干判定用例（纯函数化），
 * 空凭据 env + 临时 cwd + 超时 + 输出截断。判据求值复用 security/sandbox.matchConditions。
 */

'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');
const fsx = require('../util/fsx.cjs');
const { minimalEnv, matchConditions } = require('../security/sandbox.cjs');

const MAX_OUTPUT = 1024 * 1024;

/** 子进程脚本（通过 node -e 执行，不写额外文件） */
const CHILD_SRC = `
let data = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { if (data.length < 1048576) data += c; });
process.stdin.on('end', () => {
  let out;
  try {
    const payload = JSON.parse(data || '{}');
    const judge = require(process.env.AED_JUDGE);
    const cases = Array.isArray(payload.cases) ? payload.cases : [];
    const results = cases.map((c) => {
      try {
        const r = judge.matchConditions(c.conditions || {}, c.input || {}, { neg_match: c.neg_match, expr: c.expr });
        return { id: c.id, ok: true, matched: !!r.matched, fields: r.fields || [], expected: !!c.expect_trigger };
      } catch (e) {
        return { id: c.id, ok: false, matched: false, fields: [], expected: !!c.expect_trigger, error: String((e && e.message) || e) };
      }
    });
    out = { ok: true, results };
  } catch (e) {
    out = { ok: false, error: String((e && e.message) || e), results: [] };
  }
  process.stdout.write(JSON.stringify(out));
});
`;

/**
 * 把用例规范化为子进程可执行的形状。
 * @param {Object} c
 * @returns {{id: string, conditions: Object, neg_match: Object|undefined, input: Object, expect_trigger: boolean}}
 */
function normalizeCase(c) {
  return {
    id: String(c.id || 'case'),
    conditions: c.conditions || {},
    neg_match: c.neg_match || undefined,
    input: c.input || {},
    expect_trigger: !!c.expect_trigger
  };
}

/**
 * 在子进程沙箱中批量执行用例。
 * @param {Object[]} cases
 * @param {{timeoutMs?: number, sandbox?: boolean, tmpDir?: string, cwd?: string}} [opts]
 * @returns {Promise<{results: Object[], stdout: string, stderr: string, sandboxed: boolean, duration_ms: number}>}
 */
function runCases(cases, opts = {}) {
  const started = Date.now();
  const list = (cases || []).map(normalizeCase);
  if (list.length === 0) {
    return Promise.resolve({ results: [], stdout: '', stderr: '', sandboxed: false, duration_ms: 0 });
  }
  if (opts.sandbox === false) {
    // 进程内快速通道（测试/无子进程环境）
    const results = list.map((c) => {
      const r = matchConditions(c.conditions, c.input, { neg_match: c.neg_match });
      return { id: c.id, ok: true, matched: !!r.matched, fields: r.fields, expected: c.expect_trigger };
    });
    return Promise.resolve({ results, stdout: '', stderr: '', sandboxed: false, duration_ms: Date.now() - started });
  }
  const tmpDir = opts.tmpDir || fsx.mkTmpDir('aed-sandbox-');
  fsx.ensureDir(tmpDir);
  const env = minimalEnv({
    tmpDir,
    extra: { AED_JUDGE: path.join(__dirname, '..', 'security', 'sandbox.cjs') }
  });
  const timeoutMs = opts.timeoutMs || 30000;

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const child = spawn(process.execPath, ['-e', CHILD_SRC], {
      cwd: opts.cwd || tmpDir,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try { child.kill('SIGKILL'); } catch (_e) { /* 忽略 */ }
        resolve({ results: [], stdout, stderr: `${stderr}\nSANDBOX_TIMEOUT`, sandboxed: true, duration_ms: Date.now() - started });
      }
    }, timeoutMs);
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fsx.rimraf(tmpDir, { maxRetries: 3 });
      resolve(payload);
    };
    child.stdout.on('data', (b) => { if (stdout.length < MAX_OUTPUT) stdout += b.toString('utf8'); });
    child.stderr.on('data', (b) => { if (stderr.length < MAX_OUTPUT) stderr += b.toString('utf8'); });
    child.on('error', (e) => {
      finish({ results: [], stdout, stderr: `${stderr}\n${e.message}`, sandboxed: true, duration_ms: Date.now() - started });
    });
    child.on('close', () => {
      let results = [];
      try {
        const parsed = JSON.parse(stdout || '{}');
        results = parsed.results || [];
      } catch (_e) {
        results = [];
      }
      finish({ results, stdout: stdout.slice(0, MAX_OUTPUT), stderr: stderr.slice(0, MAX_OUTPUT), sandboxed: true, duration_ms: Date.now() - started });
    });
    try {
      child.stdin.write(JSON.stringify({ cases: list }), 'utf8');
      child.stdin.end();
    } catch (_e) {
      child.kill('SIGKILL');
    }
  });
}

/**
 * 把沙箱结果折算成通过/失败。
 * @param {Object[]} results
 * @returns {{passed: number, total: number, failures: Object[]}}
 */
function tally(results) {
  let passed = 0;
  const failures = [];
  for (const r of results) {
    const ok = r.ok === true && r.matched === r.expected;
    if (ok) passed += 1;
    else failures.push(r);
  }
  return { passed, total: results.length, failures };
}

module.exports = { runCases, tally, CHILD_SRC };

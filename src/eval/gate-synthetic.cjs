/**
 * @module eval/gate-synthetic
 * @layer eval
 * @owner kou
 * G3 合成单测门禁（Memento Automatic Unit-Test Gate）：
 * patch 必须自带 ≥3 条 testcase（2 条正向 + 1 条负向）；不足时从用例集 synthetic 补齐。
 */

'use strict';

const runner = require('./sandbox-runner.cjs');
const suiteRegistry = require('./suite-registry.cjs');
const { AedError } = require('../util/errors.cjs');

/**
 * 把 patch.testcases + experience 条件展开成可执行用例。
 * @param {{patch?: Object, experience?: Object, suite?: Object, minCases?: number}} input
 * @returns {{cases: Object[], problems: string[]}}
 */
function buildCases(input = {}) {
  const patch = input.patch || {};
  const exp = input.experience || {};
  const minCases = input.minCases || 3;
  const conditions = (exp.trigger && exp.trigger.match) || {};
  const negMatch = (exp.trigger && exp.trigger.neg_match) || undefined;
  const problems = [];

  /** @type {Object[]} */
  const cases = [];
  for (const tc of patch.testcases || []) {
    cases.push({
      id: tc.id,
      conditions: tc.conditions || conditions,
      neg_match: negMatch,
      input: tc.input || {},
      expect_trigger: !!tc.expect_trigger
    });
  }

  const positive = cases.filter((c) => c.expect_trigger).length;
  const negative = cases.filter((c) => !c.expect_trigger).length;
  if (cases.length < minCases && input.suite && (input.suite.synthetic || []).length) {
    // 用用例集的合成用例补足到 minCases
    for (const sc of input.suite.synthetic) {
      if (cases.length >= minCases) break;
      cases.push(sc);
    }
  }
  if (cases.length < minCases) problems.push(`用例数 ${cases.length} < ${minCases}`);
  if (positive < 2) problems.push(`正向用例 ${positive} < 2`);
  if (negative < 1) problems.push(`负向用例 ${negative} < 1`);
  if (!patch.testcases || patch.testcases.length === 0) problems.push('patch 未自带 testcases');
  return { cases, problems };
}

/**
 * 执行 G3。
 * @param {{patch?: Object, experience?: Object, suite?: Object, config?: Object, sandbox?: boolean}} ctx
 * @returns {Promise<{stage: string, pass: boolean, reason_code: string|null, detail: string, duration_ms: number, skipped: boolean, metrics: Object}>}
 */
async function run(ctx = {}) {
  const started = Date.now();
  const config = ctx.config || {};
  const minCases = (config.gate && config.gate.syntheticMinCases) || 3;
  let suite = ctx.suite;
  if (!suite && ctx.agent) {
    try {
      suite = suiteRegistry.loadSuite({ agent: ctx.agent, config });
    } catch (_e) {
      suite = null;
    }
  }
  const { cases, problems } = buildCases({ patch: ctx.patch, experience: ctx.experience, suite, minCases });
  if (problems.length) {
    return {
      stage: 'G3_synthetic',
      pass: false,
      reason_code: 'E_GATE_SYNTHETIC_FAIL',
      detail: problems.join(' ;; '),
      duration_ms: Date.now() - started,
      skipped: false,
      metrics: { synthetic_total: cases.length, synthetic_passed: 0 }
    };
  }
  const useSandbox = config.gate ? config.gate.sandbox !== false : true;
  const out = await runner.runCases(cases, {
    timeoutMs: (config.gate && config.gate.timeoutMs) || 30000,
    sandbox: ctx.sandbox === undefined ? useSandbox : ctx.sandbox
  });
  const t = runner.tally(out.results);
  const pass = t.passed === t.total && t.total > 0;
  return {
    stage: 'G3_synthetic',
    pass,
    reason_code: pass ? null : 'E_GATE_SYNTHETIC_FAIL',
    detail: pass
      ? `合成用例 ${t.passed}/${t.total} 通过（正向触发、负向不触发）`
      : `合成用例失败 ${t.total - t.passed}/${t.total}：${t.failures.map((f) => `${f.id}(matched=${f.matched},expected=${f.expected})`).join(',')}`,
    duration_ms: Date.now() - started,
    skipped: false,
    metrics: { synthetic_total: t.total, synthetic_passed: t.passed }
  };
}

/**
 * 断言 patch 自带 testcases 合规（供 patch-infer 自检）。
 * @param {Object} patch
 * @returns {void}
 */
function assertTestcases(patch) {
  const problems = buildCases({ patch, minCases: 3 }).problems;
  if (problems.length) {
    throw new AedError('E_GATE_SYNTHETIC_FAIL', `patch testcases 不合规：${problems.join('; ')}`, { problems });
  }
}

module.exports = { run, buildCases, assertTestcases };

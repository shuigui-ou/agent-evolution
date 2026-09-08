/**
 * @module eval/gate-regression
 * @layer eval
 * @owner kou
 * G2 回归门禁：在沙箱子进程中回放黄金用例集，要求 100% 通过（"必须不更坏"）。
 */

'use strict';

const suiteRegistry = require('./suite-registry.cjs');
const runner = require('./sandbox-runner.cjs');

/**
 * 执行 G2。
 * @param {{agent?: string, suite?: Object, config?: Object, sandbox?: boolean, suiteFile?: string}} ctx
 * @returns {Promise<{stage: string, pass: boolean, reason_code: string|null, detail: string, duration_ms: number, skipped: boolean, metrics: Object}>}
 */
async function run(ctx = {}) {
  const started = Date.now();
  const config = ctx.config || {};
  let suite = ctx.suite;
  if (!suite) {
    try {
      suite = suiteRegistry.loadSuite({ agent: ctx.agent, config, file: ctx.suiteFile });
    } catch (e) {
      return {
        stage: 'G2_regression',
        pass: false,
        reason_code: 'E_GATE_REGRESSION_FAIL',
        detail: `用例集加载失败：${e.message}`,
        duration_ms: Date.now() - started,
        skipped: false,
        metrics: { regression_total: 0, regression_passed: 0 }
      };
    }
  }
  const golden = suite.golden || [];
  if (golden.length === 0) {
    return {
      stage: 'G2_regression',
      pass: true,
      reason_code: null,
      detail: '无黄金用例，跳过',
      duration_ms: Date.now() - started,
      skipped: true,
      metrics: { regression_total: 0, regression_passed: 0 }
    };
  }
  const useSandbox = config.gate ? config.gate.sandbox !== false : true;
  const out = await runner.runCases(golden, {
    timeoutMs: (config.gate && config.gate.timeoutMs) || 30000,
    sandbox: ctx.sandbox === undefined ? useSandbox : ctx.sandbox
  });
  const t = runner.tally(out.results);
  const pass = out.results.length === golden.length && t.passed === golden.length;
  const detail = pass
    ? `黄金用例 ${t.passed}/${t.total} 全部通过`
    : `黄金用例失败 ${t.total - t.passed}/${t.total}：${t.failures.map((f) => f.id).join(',')}${out.stderr ? ` | stderr:${out.stderr.slice(0, 120)}` : ''}`;
  return {
    stage: 'G2_regression',
    pass,
    reason_code: pass ? null : 'E_GATE_REGRESSION_FAIL',
    detail: detail.slice(0, 1000),
    duration_ms: Date.now() - started,
    skipped: false,
    metrics: { regression_total: t.total, regression_passed: t.passed }
  };
}

module.exports = { run };

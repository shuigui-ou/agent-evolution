/**
 * @module eval/gate-shadow
 * @layer eval
 * @owner kou
 * G4 影子 A/B：对最近 N 条真实 trace 做离线回放 —— "若应用该 patch，结果会更好吗"。
 * 通过条件：shadow_regressions === 0 且 expected_gain >= 1。
 */

'use strict';

const { toMatchInput } = require('../evidence/sessionizer.cjs');
const { matchConditions } = require('../security/sandbox.cjs');

/**
 * 执行 G4。
 * @param {{traces?: Object[], experience?: Object, config?: Object}} ctx
 * @returns {{stage: string, pass: boolean, reason_code: string|null, detail: string, duration_ms: number, skipped: boolean, metrics: Object}}
 */
function run(ctx = {}) {
  const started = Date.now();
  const config = ctx.config || {};
  const n = (config.gate && config.gate.shadowCalls) || 30;
  const exp = ctx.experience;
  const traces = ctx.traces || [];
  const conditions = exp && exp.trigger ? exp.trigger.match : {};
  const negMatch = exp && exp.trigger ? exp.trigger.neg_match : null;

  if (!exp || Object.keys(conditions || {}).length === 0) {
    return {
      stage: 'G4_shadow',
      pass: false,
      reason_code: 'E_GATE_SHADOW_FAIL',
      detail: '缺少 experience.trigger.match，无法回放',
      duration_ms: Date.now() - started,
      skipped: false,
      metrics: { shadow_calls: 0, shadow_regressions: 0, expected_gain: 0 }
    };
  }
  if (traces.length === 0) {
    return {
      stage: 'G4_shadow',
      pass: true,
      reason_code: null,
      detail: '无可用轨迹，跳过影子回放',
      duration_ms: Date.now() - started,
      skipped: true,
      metrics: { shadow_calls: 0, shadow_regressions: 0, expected_gain: 0 }
    };
  }

  const sample = traces.slice(Math.max(0, traces.length - n));
  let gain = 0;
  let regressions = 0;
  for (const ev of sample) {
    const input = toMatchInput(ev);
    if (ev.error) input.error_type = String(ev.error.type || '');
    const r = matchConditions(conditions, input, { neg_match: negMatch });
    if (!r.matched) continue;
    if (ev.outcome === 'fail' || ev.outcome === 'timeout') gain += 1;
    else regressions += 1; // 成功路径被误触发 = 回归
  }

  const pass = regressions === 0 && gain >= 1;
  return {
    stage: 'G4_shadow',
    pass,
    reason_code: pass ? null : 'E_GATE_SHADOW_FAIL',
    detail: `回放 ${sample.length} 条：命中失败 ${gain} 次（预期收益），成功路径误触发 ${regressions} 次`,
    duration_ms: Date.now() - started,
    skipped: false,
    metrics: { shadow_calls: sample.length, shadow_regressions: regressions, expected_gain: gain }
  };
}

module.exports = { run };

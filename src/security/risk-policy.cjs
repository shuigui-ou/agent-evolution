/**
 * @module security/risk-policy
 * @layer security
 * @owner kou
 * 高危判定表：任一命中 -> requires_human = true（或 injection 直接 reject）。
 */

'use strict';

/** 高危阈值 */
const THRESHOLDS = Object.freeze({
  maxOps: 3,
  maxChangedBytes: 2000,
  maxChangedRatio: 0.2,
  minConfidence: 0.4,
  maxAppliesTo: 3,
  rollbackWindowDays: 7,
  rollbackCountLimit: 2
});

/**
 * 评估 patch 风险。
 * @param {{patch?: Object, experience?: Object, attribution?: Object, skillBytes?: number,
 *          changedBytes?: number, rollbackCount7d?: number, conflictPending?: boolean}} input
 * @returns {{level: string, blast_radius: string, requires_human: boolean, human_reasons: string[]}}
 */
function assessRisk(input = {}) {
  const patch = input.patch || {};
  const exp = input.experience || {};
  const attr = input.attribution || {};
  const reasons = [];

  const ops = Array.isArray(patch.ops) ? patch.ops : [];
  if (ops.length > THRESHOLDS.maxOps) reasons.push(`op 数量 ${ops.length} > ${THRESHOLDS.maxOps}`);

  const changedBytes = Number.isFinite(input.changedBytes) ? input.changedBytes : (input.skillBytes || 0);
  if (changedBytes > THRESHOLDS.maxChangedBytes) reasons.push(`改动字节 ${changedBytes} > ${THRESHOLDS.maxChangedBytes}`);
  if (Number.isFinite(input.skillBytes) && input.skillBytes > 0 && changedBytes / input.skillBytes > THRESHOLDS.maxChangedRatio) {
    reasons.push(`改动占比 ${(changedBytes / input.skillBytes * 100).toFixed(1)}% > 20%`);
  }

  if (ops.some((o) => o.op === 'add_file')) reasons.push('包含 add_file（新增脚本/文件）');

  const appliesTo = Array.isArray(exp.applies_to) ? exp.applies_to : [];
  if (appliesTo.includes('*') || appliesTo.length >= THRESHOLDS.maxAppliesTo) {
    reasons.push(`影响面过大：${appliesTo.join(',')}`);
  }
  if (Number.isFinite(attr.confidence) && attr.confidence < THRESHOLDS.minConfidence) {
    reasons.push(`归因置信度 ${attr.confidence} < ${THRESHOLDS.minConfidence}`);
  }
  if (input.conflictPending) reasons.push('存在 disputed 对手条目（冲突未裁决）');
  const trust = (exp.origin && exp.origin.trust_level) || 'T0';
  if (trust === 'T2' || trust === 'T3') reasons.push(`信任级 ${trust} 需人工确认`);
  if ((input.rollbackCount7d || 0) >= THRESHOLDS.rollbackCountLimit) {
    reasons.push(`近 7 天已回滚 ${input.rollbackCount7d} 次`);
  }

  const level = reasons.length === 0 ? 'low' : (reasons.length >= 3 ? 'high' : 'medium');
  return {
    level,
    blast_radius: appliesTo.length ? appliesTo.join(',') : 'unknown',
    requires_human: reasons.length > 0,
    human_reasons: reasons
  };
}

module.exports = { assessRisk, THRESHOLDS };

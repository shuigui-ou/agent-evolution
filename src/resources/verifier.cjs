/**
 * @module src/resources/verifier
 * @layer 资源服务（§5 独立复验）
 * @owner Alex（软件工程师，K5）
 *
 * 独立复验（cross-validated credit）：对经验库/解法索引中的条目做"第二读者"复验。
 * 由于当前没有第三方评审者，采用确定性规则评审（第二意见 = 规则引擎重检）：
 *  - 注入重检（detectInjection）→ 命中判 rejected + 大幅降信用 + 建议隔离；
 *  - T4 铁律重检（assertContentT4Safe）→ 命中判 rejected（经验不得改权限）；
 *  - 结构检查（有正文/有 fingerprint/有 probe 或 verify/expectedGain 数值>0）；
 * 通过 ≥3 项结构检查 → cross_validated（信用 +1）；否则 flagged（信用 -1）。
 *
 * 复验只影响"信用分"这类受控元数据，绝不把候选写进任何 agent 知识面。
 */
'use strict';

const path = require('node:path');
const { KernelError, nowIso, genId } = require('../../kernel/src/util.cjs');
const { detectInjection } = require('../../kernel/src/injection-guard.cjs');
const { assertContentT4Safe } = require('../../kernel/src/permission.cjs');

const REVIEWER = 'resource-verify-rule-v1';
const ADJUST_CROSS_VALIDATED = 1;
const ADJUST_FLAGGED = -1;
const ADJUST_REJECTED = -10;
const PASS_THRESHOLD = 3;

/**
 * 创建复验器
 * @param {object} deps
 * @param {object} deps.experiences - createExperienceStore 实例
 * @param {object} deps.solutions - createSolutionPool 实例
 */
function createVerifier({ experiences = null, solutions = null } = {}) {
  /**
   * 对指定条目复验
   * @param {object} q { experience_id }
   * @returns {object} 复验结果
   */
  function verify({ experience_id = '' } = {}) {
    if (!experience_id) {
      throw new KernelError('VERIFY_INVALID', 'POST /verify 必须提供 experience_id');
    }
    let kind = null;
    let target = null;
    let store = null;
    if (experiences) {
      target = experiences.findById(experience_id);
      if (target) {
        kind = 'experience';
        store = experiences;
      }
    }
    if (!target && solutions) {
      target = solutions.findById(experience_id);
      if (target) {
        kind = 'solution';
        store = solutions;
      }
    }
    if (!target) {
      throw new KernelError('VERIFY_NOT_FOUND', `找不到可复验条目: ${experience_id}`, { experience_id });
    }

    const scanText = [
      target.content,
      target.fix,
      target.title,
      target.symptom,
      target.rootCause,
      target.verify,
    ]
      .filter((x) => typeof x === 'string')
      .join('\n');

    const injection = detectInjection(scanText);
    const t4 = assertContentT4Safe(scanText);

    const checks = [
      { key: 'has_content', label: '有正文/修复动作', pass: Boolean((target.content || target.fix || '').trim()) },
      { key: 'has_fingerprint', label: '有 fingerprint/skeleton', pass: Boolean(target.fingerprint || target.skeleton) },
      {
        key: 'has_verify_probe',
        label: '带 probe 生效判据或 verify 验证法',
        pass: Boolean(target.probe || (target.verify && String(target.verify).trim())),
      },
      {
        key: 'gain_positive',
        label: 'expectedGain 为数值且 >0',
        pass: Number.isFinite(Number(target.expectedGain)) && Number(target.expectedGain) > 0,
      },
      { key: 'injection_safe', label: '注入检测通过', pass: injection.safe },
      { key: 't4_safe', label: 'T4 铁律通过（不试图改权限）', pass: t4.ok },
    ];

    const structural = checks.filter((c) => c.pass).length;
    let verdict = 'flagged';
    let adjustment = ADJUST_FLAGGED;
    let reason = '';
    let toStatus = null;

    if (!injection.safe) {
      verdict = 'rejected';
      adjustment = ADJUST_REJECTED;
      reason = `注入检测命中: ${injection.hits.map((h) => h.rule).join(', ')}`;
      toStatus = 'quarantined';
    } else if (!t4.ok) {
      verdict = 'rejected';
      adjustment = ADJUST_REJECTED;
      reason = `T4 铁律命中: ${t4.rule}`;
      toStatus = 'quarantined';
    } else if (structural >= PASS_THRESHOLD) {
      verdict = 'cross_validated';
      adjustment = ADJUST_CROSS_VALIDATED;
      reason = `结构检查通过 ${structural}/${checks.length} 项`;
    } else {
      verdict = 'flagged';
      adjustment = ADJUST_FLAGGED;
      reason = `结构检查仅通过 ${structural}/${checks.length} 项（低于 ${PASS_THRESHOLD}）`;
    }

    // 只对 experience 落地信用/状态调整；solution 索引只返回复验结论不落调整
    let applied = null;
    if (store && kind === 'experience' && typeof store.adjustCredit === 'function') {
      const before = target.credit;
      const adj = store.adjustCredit(target.id, adjustment, 'verify:' + verdict, {
        toStatus: verdict === 'rejected' ? 'quarantined' : null,
      });
      applied = { before, after: adj.credit };
    }

    const afterCredit =
      applied && applied.after != null
        ? applied.after
        : Math.max(0, Math.round((Number(target.credit) + adjustment) * 100) / 100);

    return {
      review_id: genId('VRF'),
      experience_id: target.id,
      kind,
      reviewer: REVIEWER,
      verdict,
      checks: { passed: structural, total: checks.length, items: checks },
      adjustment,
      cross_validated_credit: afterCredit,
      applied: applied || { note: 'solution 索引只读，未落信用调整' },
      reason,
      reviewed_at: nowIso(),
    };
  }

  return { verify };
}

module.exports = {
  createVerifier,
  REVIEWER,
  ADJUST_CROSS_VALIDATED,
  ADJUST_FLAGGED,
  ADJUST_REJECTED,
  PASS_THRESHOLD,
};

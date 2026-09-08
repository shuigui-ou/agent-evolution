/**
 * @module feedback
 * @layer L2 决策层（否决反馈回路 + 目标对齐回路）
 * @owner Kou（工程师，K1）
 *
 * 否决反馈回路（战术）：
 *  - 用户 reject 一个候选 → 记 (fingerprint, candidateId) 否决记录
 *    （append-only 否决账 veto/veto.jsonl，含 reason 与时间戳，审计链挂钩）；
 *  - 排序降权：被否决候选生效值 = expected_gain − 5×min(否决次数,2)（一次 −5，两次封顶 −10）；
 *  - 黑名单：同候选对同指纹被否 ≥2 次 → blacklisted，选优时直接排除；
 *    显式复活接口 revive()（仅 user 来源），复活记审计。
 *
 * 目标对齐回路（战略）：
 *  - 偏好学习通道 preference-update：同类别（category）下某型解法（unit）
 *    被 adopt ≥2 次 → 对应 objective 权重建议 +1（上限 10）；
 *    被 reject ≥2 次 → 建议 −1（下限 0）。产出的是【建议】（写审计 + 返回宿主展示），
 *    不自动改 objectives——修改权只在 user（系统可提议，不能自改）。
 *  - divergence 分支：top1 被呈现后用户否决 top1 的分歧计数（按 category 聚合）；
 *    同 category 分歧 ≥3 次 → 产出 alignment_review 事件（附分歧样本：
 *    top1 是什么、用户选了什么、各因子分解），提示宿主发起目标对齐审查。
 *
 * 账本文件（均在 <dataDir>/veto/ 下，全部 append-only，审计链挂钩）：
 *  - veto.jsonl         否决/复活记录（kind: veto|revive）
 *  - adopt.jsonl        采纳记录（偏好学习素材）
 *  - preferences.jsonl  偏好建议记录（open 状态；应用/不应用由 user 决定）
 *  - divergence.jsonl   分歧样本（top1 vs 用户实际选择 + 因子分解）
 */
'use strict';

const path = require('node:path');
const { KernelError, readJsonl, appendJsonl, genId, nowIso } = require('./util.cjs');

/** 一次否决的降权量 */
const DOWNWEIGHT_PER_VETO = 5;
/** 降权封顶的否决次数（min(否决次数, 此值)） */
const DOWNWEIGHT_CAP_VETOES = 2;
/** 黑名单阈值：同候选对同指纹被否次数 */
const BLACKLIST_THRESHOLD = 2;
/** 偏好建议触发阈值：adopt/reject 次数（每次翻倍再触发一条新建议） */
const PREFERENCE_STEP = 2;
/** 分歧审查触发阈值：同 category 分歧次数（每次 +3 再触发一条 alignment_review） */
const DIVERGENCE_THRESHOLD = 3;

/**
 * 创建反馈引擎（否决账 + 偏好学习 + 分歧计数）
 * @param {object} opts
 * @param {string} [opts.dataDir='runtime']
 * @param {object|null} [opts.audit] - 审计链（所有回路动作记审计）
 * @param {Function|null} [opts.objectiveResolver] - (category)=>objective|null：
 *   把类别映射到目标栈里的 objective（找不到返回 null，建议仍产出但 objective_id 为 null）
 * @param {Function|null} [opts.onAlignmentReview] - (payload)=>void：alignment_review 事件出口
 */
function createFeedbackEngine({
  dataDir = 'runtime',
  audit = null,
  objectiveResolver = null,
  onAlignmentReview = null,
} = {}) {
  const dir = path.join(dataDir, 'veto');
  const vetoFile = path.join(dir, 'veto.jsonl');
  const adoptFile = path.join(dir, 'adopt.jsonl');
  const prefFile = path.join(dir, 'preferences.jsonl');
  const divFile = path.join(dir, 'divergence.jsonl');

  // 启动时装载历史账本（向后兼容：旧运行目录无这些文件时读出空数组）
  const vetoRecords = readJsonl(vetoFile);
  const adoptRecords = readJsonl(adoptFile);
  const prefRecords = readJsonl(prefFile);
  const divergenceRecords = readJsonl(divFile);

  /** 记审计（audit 缺失时静默跳过，回路本身不受影响） */
  function auditAppend(type, payload) {
    if (audit) {
      try {
        audit.append(type, payload);
      } catch (_e) { /* 审计故障不阻断回路 */ }
    }
  }

  /**
   * 身份匹配：否决账优先按【稳定 key】（fingerprint|title|unit 哈希，跨轮次重新生成的
   * 同内容候选同 key）跟随；无 key 时退回 candidate_id 精确匹配。
   */
  function matchesIdentity(rec, fingerprint, candidateKey, candidateId) {
    if (rec.fingerprint !== fingerprint) return false;
    if (candidateKey) return rec.candidate_key === candidateKey;
    return rec.candidate_id === candidateId;
  }

  /** 某 (fingerprint, 候选身份) 的否决记录（排除复活前的历史：只数最近一次 revive 之后的 veto） */
  function activeVetoes(fingerprint, candidateKey, candidateId) {
    let lastReviveIdx = -1;
    for (let i = 0; i < vetoRecords.length; i++) {
      const r = vetoRecords[i];
      if (r.kind === 'revive' && matchesIdentity(r, fingerprint, candidateKey, candidateId)) {
        lastReviveIdx = i;
      }
    }
    return vetoRecords.filter(
      (r, i) => i > lastReviveIdx && r.kind === 'veto' &&
        matchesIdentity(r, fingerprint, candidateKey, candidateId)
    );
  }

  /** 否决计数（黑名单判定与降权共用：复活后重新计数）。candidateKey 优先，缺省退回 candidateId */
  function vetoCount(fingerprint, candidateKey, candidateId) {
    return activeVetoes(fingerprint, candidateKey, candidateId).length;
  }

  /** 黑名单判定：同候选对同指纹被否 ≥2 次（复活后重新累计） */
  function isBlacklisted(fingerprint, candidateKey, candidateId) {
    return vetoCount(fingerprint, candidateKey, candidateId) >= BLACKLIST_THRESHOLD;
  }

  /** 否决降权量（负数）：−5×min(否决次数,2)；无否决为 0 */
  function downweightFor(fingerprint, candidateKey, candidateId) {
    const n = Math.min(vetoCount(fingerprint, candidateKey, candidateId), DOWNWEIGHT_CAP_VETOES);
    return n === 0 ? 0 : -DOWNWEIGHT_PER_VETO * n;
  }

  /**
   * 记一条否决（veto）：append-only + 审计；联动黑名单判定 / 分歧计数 / 偏好建议。
   * @param {object} v
   * @param {string} v.fingerprint - 信号指纹
   * @param {string} v.candidateId - 候选 ID
   * @param {string} [v.reason] - 用户给出的否决理由
   * @param {string} [v.source='user'] - 否决来源（用户裁决）
   * @param {string} [v.category=''] - 类别（信号类型 E/G/P/I 或候选 category）
   * @param {string} [v.unit=''] - 解法型别（E1~E7）
   * @param {string} [v.title=''] - 候选标题（分歧样本展示用）
   * @param {object|null} [v.factors=null] - 候选四因子分解（分歧样本展示用）
   */
  function recordVeto(v = {}) {
    if (!v.fingerprint || !v.candidateId) {
      throw new KernelError('FEEDBACK_INVALID', '否决记录必须带 fingerprint 与 candidateId');
    }
    const rec = {
      id: genId('VETO'),
      kind: 'veto',
      fingerprint: v.fingerprint,
      candidate_id: v.candidateId,
      candidate_key: String(v.candidateKey || ''),
      reason: String(v.reason || ''),
      source: String(v.source || 'user'),
      category: String(v.category || ''),
      unit: String(v.unit || ''),
      title: String(v.title || ''),
      ts: nowIso(),
    };
    vetoRecords.push(rec);
    appendJsonl(vetoFile, rec);
    auditAppend('VETO_RECORDED', {
      fingerprint: rec.fingerprint,
      candidate_id: rec.candidate_id,
      reason: rec.reason,
      source: rec.source,
    });

    // 黑名单判定：达到阈值记 VETO_BLACKLISTED（幂等：只在跨过阈值那一刻记一次）
    const count = vetoCount(rec.fingerprint, rec.candidate_key, rec.candidate_id);
    if (count === BLACKLIST_THRESHOLD) {
      auditAppend('VETO_BLACKLISTED', {
        fingerprint: rec.fingerprint,
        candidate_id: rec.candidate_id,
        veto_count: count,
      });
    }

    // 偏好学习：reject ≥2 → 权重建议 −1
    updatePreferences(rec.category, rec.unit);

    // 分歧计数：top1 被呈现后用户否决了 top1（按 category 聚合）
    if (rec.category) {
      recordDivergence({
        category: rec.category,
        top1_candidate_id: rec.candidate_id,
        top1_title: rec.title,
        top1_factors: v.factors || null,
        user_choice: 'reject',
      });
    }
    return rec;
  }

  /**
   * 复活黑名单候选（仅 user 来源）：append 一条 revive 记录，之后的否决重新累计。
   * 非 user 来源 → 抛 FEEDBACK_FORBIDDEN + 审计。
   */
  function revive(fingerprint, candidateId, { source = 'user', candidateKey = '' } = {}) {
    if (source !== 'user') {
      auditAppend('VETO_REVIVE_FORBIDDEN', { fingerprint, candidate_id: candidateId, source });
      throw new KernelError(
        'FEEDBACK_FORBIDDEN',
        `复活黑名单候选仅限 user 来源，得到 ${source || '(未声明)'}`,
        { fingerprint, candidateId, source }
      );
    }
    if (!fingerprint || !candidateId) {
      throw new KernelError('FEEDBACK_INVALID', '复活必须带 fingerprint 与 candidateId');
    }
    const rec = {
      id: genId('VETO'),
      kind: 'revive',
      fingerprint,
      candidate_id: candidateId,
      candidate_key: String(candidateKey || ''),
      source,
      ts: nowIso(),
    };
    vetoRecords.push(rec);
    appendJsonl(vetoFile, rec);
    auditAppend('VETO_REVIVED', { fingerprint, candidate_id: candidateId, source });
    return rec;
  }

  /**
   * 记一条采纳（adopt）：偏好学习素材（不落知识面——落地由内核原语④负责）。
   */
  function recordAdoption(a = {}) {
    if (!a.fingerprint || !a.candidateId) {
      throw new KernelError('FEEDBACK_INVALID', '采纳记录必须带 fingerprint 与 candidateId');
    }
    const rec = {
      id: genId('ADOPT'),
      fingerprint: a.fingerprint,
      candidate_id: a.candidateId,
      category: String(a.category || ''),
      unit: String(a.unit || ''),
      title: String(a.title || ''),
      ts: nowIso(),
    };
    adoptRecords.push(rec);
    appendJsonl(adoptFile, rec);
    auditAppend('ADOPTION_RECORDED', {
      fingerprint: rec.fingerprint,
      candidate_id: rec.candidate_id,
      category: rec.category,
      unit: rec.unit,
    });
    if (rec.category) updatePreferences(rec.category, rec.unit);
    return rec;
  }

  /** (category, unit) 的 adopt 计数 */
  function adoptCountFor(category, unit) {
    return adoptRecords.filter((r) => r.category === category && r.unit === unit).length;
  }

  /** (category, unit) 的 reject（否决）计数 */
  function rejectCountFor(category, unit) {
    return vetoRecords.filter(
      (r) => r.kind === 'veto' && r.category === category && r.unit === unit
    ).length;
  }

  /**
   * 偏好学习（preference-update）：同 category 下某型解法（unit）被 adopt/reject 达到
   * 新的偶数里程碑（2、4、6…）→ 产出一条权重建议（写账 + 审计），不自动改 objectives。
   */
  function updatePreferences(category, unit) {
    if (!category || !unit) return;
    const adoptN = adoptCountFor(category, unit);
    const rejectN = rejectCountFor(category, unit);
    emitMilestoneSuggestion(category, unit, 'weight_up', adoptN, {
      adopt: adoptN,
      reject: rejectN,
    });
    emitMilestoneSuggestion(category, unit, 'weight_down', rejectN, {
      adopt: adoptN,
      reject: rejectN,
    });
  }

  /** 里程碑判定：count 达到 PREFERENCE_STEP 的新倍数（比上一条同向建议的里程碑更大）才产出 */
  function emitMilestoneSuggestion(category, unit, kind, count, basisCounts) {
    if (count <= 0 || count % PREFERENCE_STEP !== 0) return;
    const last = prefRecords
      .filter((r) => r.kind === kind && r.category === category && r.unit === unit)
      .pop();
    const lastMilestone = last ? (last.basis_counts ? (kind === 'weight_up' ? last.basis_counts.adopt : last.basis_counts.reject) : 0) : 0;
    if (count <= lastMilestone) return; // 同一里程碑不重复建议
    const objective = objectiveResolver ? objectiveResolver(category) : null;
    const rec = {
      id: genId('PREF'),
      kind, // weight_up | weight_down
      category,
      unit,
      delta: kind === 'weight_up' ? 1 : -1,
      objective_id: objective ? objective.id : null,
      objective_title: objective ? objective.title : '',
      basis: kind === 'weight_up'
        ? `类别 ${category} 下 ${unit} 型解法被采纳 ${count} 次（≥2）→ 建议对应目标权重 +1`
        : `类别 ${category} 下 ${unit} 型解法被否决 ${count} 次（≥2）→ 建议对应目标权重 −1`,
      basis_counts: basisCounts,
      status: 'open', // open | applied | dismissed（修改权只在 user）
      ts: nowIso(),
    };
    prefRecords.push(rec);
    appendJsonl(prefFile, rec);
    auditAppend('PREFERENCE_SUGGESTED', {
      suggestion_id: rec.id,
      kind: rec.kind,
      category: rec.category,
      unit: rec.unit,
      delta: rec.delta,
      objective_id: rec.objective_id,
    });
  }

  /** 建议列表（含"从什么行为推断"说明） */
  function suggestions() {
    return prefRecords.slice();
  }

  /** 标记建议已应用（append-only：追加一条 applied 记录，原建议保持 open 历史） */
  function markSuggestionApplied(suggestionId, newWeight) {
    const rec = {
      id: genId('PREFAPPLY'),
      kind: 'applied',
      suggestion_id: suggestionId,
      new_weight: newWeight,
      ts: nowIso(),
    };
    prefRecords.push(rec);
    appendJsonl(prefFile, rec);
    return rec;
  }

  /**
   * 分歧样本记录 + alignment_review 触发：
   * 同 category 分歧数达到 3 的新倍数 → 产出 alignment_review（回调 + 审计），
   * 附带最近 ≤3 条分歧样本（top1 是什么、用户选了什么、各因子分解）。
   */
  function recordDivergence(d = {}) {
    const rec = {
      id: genId('DIV'),
      category: d.category,
      top1_candidate_id: d.top1_candidate_id || '',
      top1_title: d.top1_title || '',
      top1_factors: d.top1_factors || null,
      user_choice: d.user_choice || 'reject',
      ts: nowIso(),
    };
    divergenceRecords.push(rec);
    appendJsonl(divFile, rec);
    auditAppend('DIVERGENCE_RECORDED', {
      category: rec.category,
      top1_candidate_id: rec.top1_candidate_id,
      user_choice: rec.user_choice,
    });
    const count = divergenceCount(rec.category);
    if (count > 0 && count % DIVERGENCE_THRESHOLD === 0) {
      const samples = divergenceRecords
        .filter((r) => r.category === rec.category)
        .slice(-3)
        .map((r) => ({
          top1_candidate_id: r.top1_candidate_id,
          top1_title: r.top1_title,
          top1_factors: r.top1_factors,
          user_choice: r.user_choice,
          ts: r.ts,
        }));
      const payload = {
        kind: 'alignment_review',
        category: rec.category,
        divergence_count: count,
        samples,
        message: `类别 ${rec.category} 已累计 ${count} 次"系统最优 ≠ 用户想要"的分歧，建议发起目标对齐审查（这类任务你按什么排序？）`,
        ts: nowIso(),
      };
      auditAppend('ALIGNMENT_REVIEW_EMITTED', {
        category: payload.category,
        divergence_count: payload.divergence_count,
      });
      if (typeof onAlignmentReview === 'function') {
        try {
          onAlignmentReview(payload);
        } catch (_e) { /* 出口故障不阻断回路 */ }
      }
    }
    return rec;
  }

  /** 同 category 分歧计数 */
  function divergenceCount(category) {
    return divergenceRecords.filter((r) => r.category === category).length;
  }

  /** 分歧汇总：{ category: count } */
  function divergenceSummary() {
    const out = {};
    for (const r of divergenceRecords) {
      out[r.category] = (out[r.category] || 0) + 1;
    }
    return out;
  }

  return {
    recordVeto,
    revive,
    recordAdoption,
    vetoCount,
    isBlacklisted,
    downweightFor,
    suggestions,
    markSuggestionApplied,
    divergenceCount,
    divergenceSummary,
    // 透传（只读用途 / 测试断言）
    files: { vetoFile, adoptFile, prefFile, divFile },
    listVetoes: () => vetoRecords.slice(),
    listAdoptions: () => adoptRecords.slice(),
  };
}

module.exports = {
  createFeedbackEngine,
  DOWNWEIGHT_PER_VETO,
  DOWNWEIGHT_CAP_VETOES,
  BLACKLIST_THRESHOLD,
  PREFERENCE_STEP,
  DIVERGENCE_THRESHOLD,
};

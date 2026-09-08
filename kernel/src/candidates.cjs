/**
 * @module candidates
 * @layer L2 决策层（多候选 + 实证选择）
 * @owner Kou（工程师，K1）
 *
 * 规范 §1.2：
 *  - 一个信号产出 N 个候选解法（本地候选 + 解法池检索的外部同错解法）
 *  - 实证选择：各候选算 expected_gain，选 top1
 *  - 收敛判据：top1 生效值 ≤ 0 → 本轮不进化，信号转人工
 *  - 外部只投候选不决定方向：外部候选与本地候选同池同规则竞争
 *
 * 否决反馈回路（§4 T5）：
 *  - 注入 feedback 引擎后，排序用【生效值】= expected_gain + downweight（否决降权为负），
 *    原始 expected_gain 保留不覆盖；
 *  - 被否 ≥2 次（同指纹）的候选进黑名单，选优时直接排除；
 *  - topCandidates() 暴露 top-N 及四因子分解（success_prob/benefit/cost/risk + 否决降权量），
 *    供宿主端点渲染候选分解展示数据。
 *
 * 约束：
 *  - L1 注入候选（E1/E3/E6）必须自带 probe 生效判据（规范 §1.3：无 probe 的经验不允许注入）
 *  - E2/E4 属 L2 行为变更（强制人审，见 permission.cjs）
 */
'use strict';

const { KernelError, genId, nowIso, shortHash } = require('./util.cjs');

/** 七类可进化单元（规范 §1.1） */
const UNITS = Object.freeze(['E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7']);
/** L2 行为变更单元：改脚本/工具/流程，强制人审 */
const L2_UNITS = Object.freeze(['E2', 'E4']);
/** L1 注入单元：必须自带 probe 生效判据 */
const L1_UNITS = Object.freeze(['E1', 'E3', 'E6']);

/**
 * 计算期望收益：expected_gain = success_prob × benefit − cost − risk（保留两位小数）
 * G3 合成单测 / G4 影子回放都可产出这三个因子，本函数只做统一换算。
 */
function computeExpectedGain({ successProb = 0, benefit = 0, cost = 0, risk = 0 } = {}) {
  for (const v of [successProb, benefit, cost, risk]) {
    if (typeof v !== 'number' || Number.isNaN(v)) {
      throw new KernelError('GAIN_INVALID', 'expected_gain 因子必须是数字', { v });
    }
  }
  if (successProb < 0 || successProb > 1) {
    throw new KernelError('GAIN_INVALID', 'successProb 必须在 [0,1]', { successProb });
  }
  return Math.round((successProb * benefit - cost - risk) * 100) / 100;
}

/**
 * 创建候选池
 * @param {object} [opts]
 * @param {object|null} [opts.feedback] - 反馈引擎（否决账/黑名单/降权；缺省无反馈回路）
 * @returns {object} candidate pool API
 */
function createCandidatePool({ feedback = null } = {}) {
  const items = [];

  /** 候选生效值 = 原始 expected_gain + 否决降权量（无 feedback 时等于原值） */
  function effectiveGainOf(cand) {
    const dw = feedback ? feedback.downweightFor(cand.fingerprint, cand.key) : 0;
    return Math.round((cand.expected_gain + dw) * 100) / 100;
  }

  /**
   * 添加候选
   * @param {object} c
   * @param {string} c.fingerprint - 归属信号指纹
   * @param {string} c.title
   * @param {string} c.content - 经验/解法正文（落地时写入知识面）
   * @param {string} c.unit - E1~E7
   * @param {number} c.expected_gain - 实证期望收益（>0 才可能被选中）
   * @param {object} [c.factors] - 四因子分解 { success_prob, benefit, cost, risk }（展示用，可缺省）
   * @param {string} [c.category=''] - 类别（信号类型 E/G/P/I 或宿主自定义类别）
   * @param {string} [c.source='local'] - local|external（解法池）
   * @param {object} [c.probe] - L1 必填生效判据 { trigger, judge }
   * @param {string} [c.target] - 目标知识面相对路径（缺省由内核决定）
   */
  function add(c = {}) {
    if (!c.fingerprint) {
      throw new KernelError('CANDIDATE_INVALID', '候选必须有 fingerprint');
    }
    const unit = String(c.unit || '').toUpperCase();
    if (!UNITS.includes(unit)) {
      throw new KernelError('CANDIDATE_INVALID', `未知可进化单元: ${c.unit}`, { unit: c.unit });
    }
    if (typeof c.expected_gain !== 'number' || Number.isNaN(c.expected_gain)) {
      throw new KernelError('CANDIDATE_INVALID', '候选必须有数值型 expected_gain');
    }
    const tier = L2_UNITS.includes(unit) ? 'L2' : 'L1';
    if (L1_UNITS.includes(unit) && !c.probe) {
      // 规范 §1.3：无 probe 的经验不允许注入
      throw new KernelError('PROBE_REQUIRED', `L1 注入候选（${unit}）必须自带 probe 生效判据`);
    }
    const cand = {
      id: genId('CAND'),
      // 稳定 key：同 fingerprint+title+unit 的候选跨轮次同 key（否决账按 key 跟随）
      key: shortHash(`${c.fingerprint}|${c.title || ''}|${unit}`),
      fingerprint: c.fingerprint,
      title: String(c.title || ''),
      content: String(c.content || ''),
      unit,
      tier,
      expected_gain: c.expected_gain,
      factors: c.factors || null, // 四因子分解（success_prob/benefit/cost/risk），展示用
      category: String(c.category || ''),
      source: c.source || 'local',
      probe: c.probe || null,
      target: c.target || null,
      created_at: nowIso(),
    };
    items.push(cand);
    return cand;
  }

  /** 按 fingerprint + id 精确取候选（找不到返回 null） */
  function get(fingerprint, id) {
    return items.find((x) => x.fingerprint === fingerprint && x.id === id) || null;
  }

  /** 列出候选，可按 fingerprint / source 过滤 */
  function list(filter = {}) {
    return items.filter(
      (x) =>
        (filter.fingerprint ? x.fingerprint === filter.fingerprint : true) &&
        (filter.source ? x.source === filter.source : true)
    );
  }

  /**
   * 从解法池（资源层）检索外部同错解法并转为候选入池。
   * 外部只投候选不决定方向：外部候选与本地候选同池按生效值竞争。
   * @param {object} resourceClient - 具备 querySolutions 的资源客户端
   */
  async function retrieveExternal(resourceClient, fingerprint) {
    const solutions = await resourceClient.querySolutions({ fingerprint });
    const added = [];
    for (const sol of solutions) {
      try {
        added.push(
          add({
            fingerprint,
            title: sol.title || '外部同错解法',
            content: sol.content || '',
            unit: sol.unit || 'E1',
            expected_gain: typeof sol.expected_gain === 'number' ? sol.expected_gain : 0,
            factors: sol.factors || null,
            category: sol.category || '',
            source: 'external',
            probe: sol.probe || null,
            target: sol.target || null,
          })
        );
      } catch (_e) {
        // 外部候选不合规（缺 probe 等）直接丢弃，不影响本地链路
      }
    }
    return added;
  }

  /**
   * 排序视图：排除黑名单候选后按生效值降序。
   * @returns {{ranked: object[], blacklistedExcluded: number}}
   */
  function ranked(fingerprint) {
    const all = list({ fingerprint });
    const blacklistedExcluded = feedback
      ? all.filter((c) => feedback.isBlacklisted(c.fingerprint, c.key)).length
      : 0;
    const alive = feedback
      ? all.filter((c) => !feedback.isBlacklisted(c.fingerprint, c.key))
      : all.slice();
    alive.sort((a, b) => effectiveGainOf(b) - effectiveGainOf(a));
    return { ranked: alive, blacklistedExcluded };
  }

  /**
   * 实证选择：按生效值（expected_gain − 否决降权）降序取 top1；黑名单候选直接排除
   * @returns {{evolve: true, candidate: object, runner_up: object|null}
   *          |{evolve: false, escalate: 'manual', reason: string}}
   */
  function selectTop(fingerprint) {
    const all = list({ fingerprint });
    const { ranked: sorted, blacklistedExcluded } = ranked(fingerprint);
    const top1 = sorted[0] || null;
    if (!top1) {
      return {
        evolve: false,
        escalate: 'manual',
        reason: blacklistedExcluded > 0 ? 'all_candidates_blacklisted' : 'no_candidate',
      };
    }
    if (effectiveGainOf(top1) <= 0) {
      // 收敛判据：生效值 ≤0 算噪音（含被否决降权压到非正），本轮不进化，信号转人工（规范 §1.2.5）
      return { evolve: false, escalate: 'manual', reason: 'top1_gain_non_positive' };
    }
    return { evolve: true, candidate: top1, runner_up: sorted[1] || null };
  }

  /**
   * 候选分解展示数据：top-N（默认 3）候选 + 四因子分解 + 否决降权量 + 黑名单标记。
   * 含黑名单候选（带 blacklisted=true 与否决明细），排序按生效值降序。
   * @param {string} fingerprint
   * @param {number} [n=3]
   */
  function topCandidates(fingerprint, n = 3) {
    const limit = Math.max(1, Number(n) || 3);
    return list({ fingerprint })
      .map((c) => {
        const vetoCount = feedback ? feedback.vetoCount(c.fingerprint, c.key) : 0;
        const downweight = feedback ? feedback.downweightFor(c.fingerprint, c.key) : 0;
        const blacklisted = feedback ? feedback.isBlacklisted(c.fingerprint, c.key) : false;
        return {
          id: c.id,
          key: c.key,
          title: c.title,
          unit: c.unit,
          category: c.category,
          source: c.source,
          expected_gain: c.expected_gain,
          factors: c.factors
            ? {
                success_prob: c.factors.success_prob,
                benefit: c.factors.benefit,
                cost: c.factors.cost,
                risk: c.factors.risk,
              }
            : null,
          veto_count: vetoCount,
          veto_downweight: downweight,
          effective_gain: Math.round((c.expected_gain + downweight) * 100) / 100,
          blacklisted,
        };
      })
      .sort((a, b) => b.effective_gain - a.effective_gain)
      .slice(0, limit);
  }

  /** 全量清空（测试用） */
  function clear() {
    items.length = 0;
  }

  return { add, get, list, retrieveExternal, selectTop, topCandidates, clear, effectiveGainOf };
}

module.exports = {
  createCandidatePool,
  computeExpectedGain,
  UNITS,
  L2_UNITS,
  L1_UNITS,
};

/**
 * @module outcome
 * @layer L3 演化层（出口选择环：条目服役考核）
 * @owner 工程师（出口选择环，方向 A 之后的第三只脚）
 *
 * 出口选择环（Outcome Loop）：给已落地的知识/偏好条目补上"服役考核"——
 * 注入后观察出口结果，按"再犯 / 不再犯"自动 强化 / 衰减 / 停用，让账本
 * 从 append-only 变成有差分存活。这是"环闭合后持续运转"（相位三）的机制落点。
 *
 * 与既有环的关系（概念卫生）：
 *  - 候选裁决环（feedback/veto/adopt）= 落地前的【准入】——要不要引入这条经验；
 *  - 出口选择环（本模块）= 落地后的【考核】——这条经验服役后有没有用。
 *  两者串成条目完整生命周期：准入 → 服役 → 考核 → 强化/退役。
 *
 * 与 probe/自动回滚的关系（避免撞车）：
 *  - probe 记分（hit_solved/false_trigger…）由宿主显式上报，驱动 checkAutoRollback
 *    做 24h 误触发率 >10% 的字节级快照回滚 —— 那是"宿主报告的考核"；
 *  - 本模块处理"引擎自动推导的考核"：注入（签发）后同因错误再犯 → 自动 refuted。
 *  两套并存但不冲突：回滚动快照/文件，本模块管条目状态与注入面。
 *
 * 安全设计（与内核其余部分同等级）：
 *  1. T4 不变：outcome 只作用于知识/偏好条目的状态，永不触碰权限档位与目标；
 *  2. retired 不物理删除（审计链引用仍在），可 revoke 复活；计数在 revoke 时清零；
 *  3. 自动信号只从事件流推导（pre_action 签发 + 同因再犯），不读取自由文本；
 *  4. fail-open：本账本故障只影响考核层自身，不拖垮宿主主流程；
 *  5. 阈值可配（默认 confirmToStrengthen=3 / refuteToDecay=2 / refuteToRetire=3）。
 *
 * 账本文件（<dataDir>/outcome/entries.jsonl，append-only，重放得到状态）：
 *  - {id, lane, key, kind:'outcome'|'issuance'|'revoke', verdict?, source?, ts}
 */
'use strict';

const path = require('node:path');
const { readJsonl, appendJsonl, genId, nowIso } = require('./util.cjs');

/** 条目生命周期状态 */
const STATUSES = Object.freeze(['active', 'strengthened', 'decayed', 'retired']);

/** 出口选择环默认阈值 */
const OUTCOME_DEFAULTS = Object.freeze({
  /** confirmed 累积 ≥3 且 > refuted → strengthened */
  confirmToStrengthen: 3,
  /** refuted ≥2 且 > confirmed → decayed */
  refuteToDecay: 2,
  /** refuted 累计 ≥3 且 > confirmed → retired */
  refuteToRetire: 3,
  /** behavior 域：签发后连续 N 条异维纠偏无同维再犯 → 自动 confirmed */
  survivalWindow: 3,
});

/**
 * 纯函数：由计数推导下一状态（可单测，不落盘）。
 * @param {string} current - active|strengthened|decayed|retired
 * @param {{confirmed:number, refuted:number}} counts
 * @param {object} [T] - 阈值（默认 OUTCOME_DEFAULTS）
 * @returns {string} 下一状态
 */
function transition(current = 'active', counts = {}, T = OUTCOME_DEFAULTS) {
  const c = Number(counts.confirmed) || 0;
  const r = Number(counts.refuted) || 0;
  const conf = T.confirmToStrengthen || OUTCOME_DEFAULTS.confirmToStrengthen;
  const dec = T.refuteToDecay || OUTCOME_DEFAULTS.refuteToDecay;
  const ret = T.refuteToRetire || OUTCOME_DEFAULTS.refuteToRetire;
  if (current === 'retired') return 'retired';
  // 证伪压倒：先看停用（最重处置）
  if (r >= ret && r > c) return 'retired';
  // 证实压倒：强化
  if (c >= conf && c > r) return 'strengthened';
  // 证伪累积：衰减
  if (r >= dec && r > c) return 'decayed';
  // 证据翻转或持平：衰减态回退 active；强化态持平时保持
  if (current === 'decayed' && c >= r) return 'active';
  if (current === 'strengthened' && c >= r) return 'strengthened';
  return current;
}

/**
 * 创建条目考核账本（通用，experience/behavior 两 lane 复用）。
 * @param {object} opts
 * @param {string} [opts.dataDir='runtime']
 * @param {string} [opts.lane='experience'] - 账本名（决定子目录/文件名）
 * @param {object|null} [opts.audit=null]
 * @param {object} [opts.thresholds=OUTCOME_DEFAULTS]
 */
function createOutcomeLedger({ dataDir = 'runtime', lane = 'experience', audit = null, thresholds = OUTCOME_DEFAULTS } = {}) {
  const dir = path.join(dataDir, 'outcome');
  const file = path.join(dir, `${String(lane).replace(/[^a-z0-9_-]/gi, '')}.jsonl`);
  const rows = readJsonl(file);
  const T = { ...OUTCOME_DEFAULTS, ...(thresholds || {}) };

  /** 重放 → 每 key 计数（revoke 清零） */
  const counts = new Map(); // key → {confirmed, refuted}
  const issued = new Map(); // key → 是否处于"已签发未判决"
  for (const r of rows) {
    if (r.kind === 'revoke') {
      counts.set(r.key, { confirmed: 0, refuted: 0 });
      issued.delete(r.key);
    } else if (r.kind === 'issuance') {
      issued.set(r.key, true);
    } else if (r.kind === 'outcome') {
      const cur = counts.get(r.key) || { confirmed: 0, refuted: 0 };
      cur[r.verdict === 'confirmed' ? 'confirmed' : 'refuted'] += 1;
      counts.set(r.key, cur);
      if (r.verdict === 'refuted') issued.delete(r.key);
    }
  }

  function auditAppend(type, payload) {
    if (audit) {
      try {
        audit.append(type, payload);
      } catch (_e) { /* 审计故障不影响考核层 */ }
    }
  }

  /** 某 key 当前状态（实时由计数推导） */
  function stateOf(key) {
    const cur = counts.get(String(key)) || { confirmed: 0, refuted: 0 };
    return {
      key: String(key),
      ...cur,
      status: STATUSES.includes(cur.status) ? cur.status : transition('active', cur, T),
    };
  }

  /** 是否允许进注入面（active/strengthened 服役；decayed/retired 停用） */
  function injectable(key) {
    const s = stateOf(key).status;
    return s === 'active' || s === 'strengthened';
  }

  /** 登记一次注入签发（开观察窗口；同 key 重复签发幂等覆盖） */
  function markIssued(key, meta = {}) {
    const k = String(key);
    issued.set(k, true);
    const row = { id: genId('OUT'), lane, key: k, kind: 'issuance', ts: nowIso(), ...meta };
    appendJsonl(file, row);
    auditAppend('OUTCOME_ISSUED', { lane, key: k });
    return row;
  }

  /**
   * 尝试"签发后同因再犯"自动证伪：仅当该 key 处于已签发未判决状态时记为 refuted。
   * @returns {object|null} {refuted:true, state} 或 null（无签发/已判决 → 不误伤）
   */
  function autoRefute(key, meta = {}) {
    const k = String(key);
    if (!issued.get(k)) return null;
    const rec = record(k, 'refuted', { source: 'auto', ...meta });
    return { refuted: true, state: rec.state };
  }

  /**
   * 记一次考核结论（confirmed/refuted）。
   * @param {string} key - 条目键（experience: experience_id；behavior: 'dim:dir'）
   * @param {string} verdict - 'confirmed' | 'refuted'
   * @param {object} [opts] { source='host', note='' }
   * @returns {object} {id, key, verdict, state}
   */
  function record(key, verdict, { source = 'host', note = '' } = {}) {
    const k = String(key);
    if (!['confirmed', 'refuted'].includes(verdict)) {
      throw new Error(`OUTCOME_INVALID_VERDICT: ${verdict}`);
    }
    const cur = counts.get(k) || { confirmed: 0, refuted: 0 };
    cur[verdict === 'confirmed' ? 'confirmed' : 'refuted'] += 1;
    counts.set(k, cur);
    const status = transition(statusOf(k), cur, T);
    const row = {
      id: genId('OUT'),
      lane,
      key: k,
      kind: 'outcome',
      verdict,
      source: String(source || 'host'),
      note: String(note || '').slice(0, 300),
      ts: nowIso(),
    };
    appendJsonl(file, row);
    if (verdict === 'refuted') issued.delete(k);
    auditAppend('OUTCOME_RECORDED', { lane, key: k, verdict, source, status });
    return { id: row.id, key: k, verdict, state: { key: k, ...cur, status } };
  }

  /** 状态读取辅助（record 内部用，避免 stateOf 的 transition 双算） */
  function statusOf(k) {
    const cur = counts.get(k) || { confirmed: 0, refuted: 0 };
    return transition('active', cur, T);
  }

  /**
   * revoke 复活（仅 user/显式来源；计数清零，审计留痕）。
   * @returns {object} {revoked:true, key, state}
   */
  function revoke(key, { source = 'user' } = {}) {
    const k = String(key);
    if (source !== 'user') {
      auditAppend('OUTCOME_REVOKE_FORBIDDEN', { lane, key: k, source });
      throw new Error(`OUTCOME_REVOKE_FORBIDDEN: revoke 仅限 user 来源，得到 ${source}`);
    }
    counts.set(k, { confirmed: 0, refuted: 0 });
    issued.delete(k);
    appendJsonl(file, { id: genId('OUT'), lane, key: k, kind: 'revoke', source, ts: nowIso() });
    auditAppend('OUTCOME_REVOKED', { lane, key: k });
    return { revoked: true, key: k, state: stateOf(k) };
  }

  /** 全量视图 */
  function list() {
    return [...counts.entries()].map(([key, c]) => stateOf(key));
  }

  /** 汇总：状态分布 + 总条目数 */
  function summary() {
    const byStatus = { active: 0, strengthened: 0, decayed: 0, retired: 0 };
    let total = 0;
    for (const [, c] of counts) {
      const s = transition('active', c, T);
      byStatus[s] = (byStatus[s] || 0) + 1;
      total += 1;
    }
    return { lane, total, byStatus, file };
  }

  return { stateOf, injectable, markIssued, autoRefute, record, revoke, list, summary, file };
}

module.exports = {
  createOutcomeLedger,
  transition,
  STATUSES,
  OUTCOME_DEFAULTS,
};

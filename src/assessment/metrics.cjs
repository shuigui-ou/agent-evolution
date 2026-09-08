/**
 * @module src/assessment/metrics
 * @layer 评估脚手架（K6）
 * @owner Alex（软件工程师，K5/K6）
 *
 * 纯函数指标聚合：输入内核 JSONL 行数组（ledger / signals / audit / probe / fix-events），
 * 输出四指标数值与明细。全部容空：无数据返回 { status:'na', value:null, ... }，绝不抛错。
 */
'use strict';

const { normalizeFingerprint } = require('../../kernel/src/signals.cjs');

/** 判定样本 outcome（同类错误再现时内核要打的判定） */
const DECISION_OUTCOMES = Object.freeze(['hit_solved', 'hit_invalid', 'miss']);
/** probe 全部 outcome */
const ALL_OUTCOMES = Object.freeze(['hit_solved', 'hit_invalid', 'false_trigger', 'miss']);

function round4(x) {
  return Math.round(x * 10000) / 10000;
}

function naMetric(key, note) {
  return { key, value: null, status: 'na', numerator: 0, denominator: 0, note: note || '数据不足' };
}

function okMetric(key, value, numerator, denominator, note) {
  return { key, value: round4(value), status: 'ok', numerator, denominator, note: note || '' };
}

/** 时间串 → ms（解析失败返回 null） */
function toMs(ts) {
  if (ts == null) return null;
  const t = new Date(ts).getTime();
  return Number.isFinite(t) ? t : null;
}

/** 从账本/信号行提取（fingerprint, tsMs） */
function occurrenceFromRow(row) {
  if (!row || typeof row !== 'object') return null;
  const fp =
    String(row.fingerprint || '') ||
    normalizeFingerprint(String(row.title || '') + ' ' + String(row.detail || ''));
  if (!fp) return null;
  const ts = toMs(row.opened_at || row.ts || row.created_at || row.timestamp);
  if (ts == null) return null;
  return { fp, ts };
}

/**
 * 收集全部错误出现（去重：同指纹同一秒内只算一次）
 * @param {object[]} ledgerRows - 承诺账本行（取 ledger==='error'）
 * @param {object[]} signalRows - signals/*.jsonl 行
 * @returns {{ map: Map<string, number[]>, count: number }}
 */
function collectOccurrences({ ledger = [], signals = [] } = {}) {
  const map = new Map();
  const seen = new Set();
  const push = (fp, ts) => {
    const second = Math.floor(ts / 1000);
    const key = `${fp}@${second}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (!map.has(fp)) map.set(fp, []);
    map.get(fp).push(ts);
  };
  for (const row of ledger) {
    if (row && row.ledger === 'error') {
      const o = occurrenceFromRow(row);
      if (o) push(o.fp, o.ts);
    }
  }
  for (const row of signals) {
    const o = occurrenceFromRow(row);
    if (o) push(o.fp, o.ts);
  }
  for (const arr of map.values()) arr.sort((a, b) => a - b);
  return { map, count: Array.from(map.values()).reduce((s, a) => s + a.length, 0) };
}

/**
 * 收集修复事件：审计 KNOWLEDGE_WRITE + 可选 fix-events 表
 * @param {object[]} auditRows
 * @param {object[]} fixEvents
 * @returns {Map<string, {firstMs: number, events: object[]}>}
 */
function collectFixEvents({ audit = [], fixEvents = [] } = {}) {
  const map = new Map();
  const add = (fp, tsMs, payload) => {
    if (!fp || tsMs == null) return;
    if (!map.has(fp)) map.set(fp, { firstMs: tsMs, events: [] });
    const rec = map.get(fp);
    rec.events.push({ tsMs, ...payload });
    if (tsMs < rec.firstMs) rec.firstMs = tsMs;
  };
  for (const row of audit) {
    if (row && row.type === 'KNOWLEDGE_WRITE' && row.payload && row.payload.fingerprint) {
      add(row.payload.fingerprint, toMs(row.ts), { experience_id: row.payload.experience_id || '', source: 'audit' });
    }
  }
  for (const row of fixEvents) {
    if (!row || typeof row !== 'object') continue;
    const fp = String(row.fingerprint || row.fingerprint_id || '');
    const ts = toMs(row.ts || row.timestamp || row.landed_at);
    if (!fp || ts == null) continue;
    add(fp, ts, { experience_id: row.experience_id || '', source: row.kind || 'fix-events' });
  }
  return map;
}

/**
 * RR 同类问题复发率
 * @returns {object} metric + details
 */
function computeRR(occurrencesMap, fixesMap) {
  const addressed = Array.from(fixesMap.keys());
  if (addressed.length === 0) {
    return { metric: naMetric('rr', '无修复事件（audit KNOWLEDGE_WRITE / fix-events 表均为空）'), details: { addressed_fingerprints: [], pre_fix_total: 0, post_fix_total: 0, recurrent_count: 0, addressed_count: 0 } };
  }
  const per = [];
  let recurrentCount = 0;
  let preTotal = 0;
  let postTotal = 0;
  for (const fp of addressed) {
    const fix = fixesMap.get(fp);
    const firstFixMs = fix.firstMs;
    const occ = (occurrencesMap.get(fp) || []).filter((t) => t != null);
    const pre = occ.filter((t) => t < firstFixMs).length;
    const post = occ.filter((t) => t >= firstFixMs).length;
    const recurrent = post > 0;
    preTotal += pre;
    postTotal += post;
    if (recurrent) recurrentCount += 1;
    per.push({
      fingerprint: fp,
      first_fix_ts: new Date(firstFixMs).toISOString(),
      fix_event_count: fix.events.length,
      occurrences_before_fix: pre,
      occurrences_after_fix: post,
      recurrent,
    });
  }
  const value = recurrentCount / addressed.length;
  return {
    metric: okMetric('rr', value, recurrentCount, addressed.length, '首次修复时刻之后仍出现同指纹错误即计复发'),
    details: { addressed_fingerprints: per, pre_fix_total: preTotal, post_fix_total: postTotal, recurrent_count: recurrentCount, addressed_count: addressed.length },
  };
}

/**
 * probe 指标（FSR / 漏调用率 / 遵循率）
 * @param {object[]} probeRows
 * @returns {object} { fsr, missed_call_rate, adherence_rate, probe_details }
 */
function computeProbeMetrics(probeRows = []) {
  const rows = (probeRows || []).filter((r) => r && DECISION_OUTCOMES.includes(r.outcome));
  const counts = { hit_solved: 0, hit_invalid: 0, miss: 0 };
  for (const r of rows) counts[r.outcome] += 1;
  const decisionTotal = counts.hit_solved + counts.hit_invalid + counts.miss;

  // FSR：按经验聚合
  const byExp = new Map();
  for (const r of rows) {
    if (!r.experience_id) continue;
    if (!byExp.has(r.experience_id)) byExp.set(r.experience_id, { total: 0, solved: false, outcomes: [] });
    const e = byExp.get(r.experience_id);
    e.total += 1;
    e.outcomes.push(r.outcome);
    if (r.outcome === 'hit_solved') e.solved = true;
  }
  const scoredExp = Array.from(byExp.values());
  const successExp = scoredExp.filter((e) => e.solved).length;

  const detailRows = Array.from(byExp.entries()).map(([id, e]) => ({
    experience_id: id,
    probe_records: e.total,
    outcomes: e.outcomes.reduce((acc, o) => {
      acc[o] = (acc[o] || 0) + 1;
      return acc;
    }, {}),
    success: e.solved,
  }));

  const missedCall = decisionTotal > 0 ? okMetric('missed_call_rate', counts.miss / decisionTotal, counts.miss, decisionTotal, '') : naMetric('missed_call_rate', 'probe 判定样本为空');
  const adherence = decisionTotal > 0 ? okMetric('adherence_rate', (counts.hit_solved + counts.hit_invalid) / decisionTotal, counts.hit_solved + counts.hit_invalid, decisionTotal, '') : naMetric('adherence_rate', 'probe 判定样本为空');
  const fsr = scoredExp.length > 0 ? okMetric('fsr', successExp / scoredExp.length, successExp, scoredExp.length, '有 probe 反馈的经验中至少一次 hit_solved 的比例') : naMetric('fsr', '无任何经验有 probe 记分');

  return {
    fsr,
    missed_call_rate: missedCall,
    adherence_rate: adherence,
    probe_details: {
      probe_rows_total: rows.length,
      outcome_counts: counts,
      decision_total: decisionTotal,
      scored_experiences: scoredExp.length,
      success_experiences: successExp,
      by_experience: detailRows,
    },
  };
}

/**
 * 审计交叉核对（信息性次级指标）：已修复指纹的 post-fix 错误出现中，
 * 是否存在紧邻的 PRE_ACTION_HIT（±15s 内），用于辅助解读漏调用/遵循。
 */
function computeAuditCrossCheck({ auditRows = [], occurrencesMap = null, fixesMap = null } = {}) {
  const preHits = (auditRows || [])
    .filter((r) => r && r.type === 'PRE_ACTION_HIT' && r.payload && r.payload.fingerprint)
    .map((r) => ({ fp: r.payload.fingerprint, ts: toMs(r.ts) }))
    .filter((h) => h.ts != null);
  const landed = fixesMap ? Array.from(fixesMap.keys()) : [];
  if (landed.length === 0 || !occurrencesMap) {
    return null;
  }
  let opportunities = 0;
  let answered = 0;
  for (const fp of landed) {
    const firstFix = fixesMap.get(fp).firstMs;
    for (const t of occurrencesMap.get(fp) || []) {
      if (t < firstFix) continue;
      opportunities += 1;
      const within = preHits.some((h) => h.fp === fp && Math.abs(h.ts - t) <= 15000);
      if (within) answered += 1;
    }
  }
  if (opportunities === 0) {
    return { opportunities, answered, rate: null, note: '无 post-fix 错误出现样本，无法做审计交叉核对' };
  }
  return { opportunities, answered, rate: round4(answered / opportunities) };
}

module.exports = {
  collectOccurrences,
  collectFixEvents,
  computeRR,
  computeProbeMetrics,
  computeAuditCrossCheck,
  toMs,
  DECISION_OUTCOMES,
  ALL_OUTCOMES,
  round4,
};

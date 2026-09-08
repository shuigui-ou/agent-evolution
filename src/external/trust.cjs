/**
 * @module external/trust
 * @layer external
 * @owner kou
 * 信任分级 T0–T3 与贡献者声誉 EMA（rep ∈ [0,100]，新贡献者 50，匿名 30）。
 */

'use strict';

const fsx = require('../util/fsx.cjs');
const paths = require('../store/paths.cjs');
const time = require('../util/time.cjs');

/** EMA 系数与均值回归目标 */
const EMA_ALPHA = 0.85;
const REP_BASELINE = 50;
const REP_ANON = 30;

/**
 * 读取声誉表。
 * @returns {Object} { contributors: { [id]: {rep, updated_at, history} } }
 */
function reputationTable() {
  return fsx.readJson(paths.reputationFile(), { contributors: {} });
}

/**
 * 写声誉表。
 * @param {Object} table
 * @returns {void}
 */
function saveReputationTable(table) {
  fsx.ensureDir(paths.creditDir());
  fsx.atomicWriteJson(paths.reputationFile(), table);
}

/**
 * 查询声誉。
 * @param {string} contributorId
 * @returns {number}
 */
function getReputation(contributorId) {
  const table = reputationTable();
  const c = (table.contributors || {})[contributorId];
  if (c && Number.isFinite(c.rep)) return c.rep;
  return String(contributorId || '').startsWith('anon') ? REP_ANON : REP_BASELINE;
}

/**
 * 应用声誉变化（EMA + 均值回归）。
 *   rep_new = clamp(0.85 * rep_old + 0.15 * 50 + delta)
 * @param {string} contributorId
 * @param {number} delta
 * @param {string} [reason]
 * @returns {{before: number, after: number, delta: number}}
 */
function applyReputationDelta(contributorId, delta, reason = 'manual') {
  const table = reputationTable();
  table.contributors = table.contributors || {};
  const before = getReputation(contributorId);
  const after = Math.min(100, Math.max(0, Math.round((EMA_ALPHA * before + (1 - EMA_ALPHA) * REP_BASELINE + delta) * 100) / 100));
  const cur = table.contributors[contributorId] || { rep: before, updated_at: null, history: [] };
  cur.history = (cur.history || []).concat([{ ts: time.nowIso(), delta, reason, before, after }]).slice(-50);
  cur.rep = after;
  cur.updated_at = time.nowIso();
  table.contributors[contributorId] = cur;
  saveReputationTable(table);
  return { before, after, delta };
}

/**
 * 判定信任级别。
 * @param {{contributor?: Object, source?: Object, signature?: Object|null, reputation?: number}} input
 * @returns {'T0'|'T1'|'T2'|'T3'}
 */
function assignTrust(input = {}) {
  const contributor = input.contributor || {};
  const source = input.source || {};
  const id = String(contributor.id || '');
  const rep = Number.isFinite(input.reputation) ? input.reputation : getReputation(id);

  // T0：本机自蒸馏 / 本机人工
  if (source.kind === 'human_feedback' && (id.startsWith('local.') || id === 'local.user')) return 'T0';
  if (source.kind === 'benchmark' && id.startsWith('local.')) return 'T0';
  // T1：已知贡献者（声誉 ≥70）或官方源
  if (rep >= 70) return 'T1';
  if (['upstream_change', 'benchmark'].includes(source.kind) && input.signature && input.signature.alg === 'ed25519') return 'T1';
  if (contributor.reputation_hint != null && contributor.reputation_hint >= 70) return 'T1';
  // T2：有签名但声誉未知
  if (input.signature && input.signature.alg === 'ed25519' && input.signature.sig) return 'T2';
  // T3：匿名 / 无签名 / 签名不匹配
  return 'T3';
}

/**
 * 不同信任级对应的门禁强度。
 * @param {string} level
 * @returns {{gates: string[], autoMerge: boolean|string, quarantineDays: number, sandboxForced: boolean}}
 */
function gateMatrix(level) {
  switch (level) {
    case 'T0': return { gates: ['G1', 'G2', 'G3'], autoMerge: true, quarantineDays: 0, sandboxForced: false };
    case 'T1': return { gates: ['G1', 'G2', 'G3', 'G4'], autoMerge: true, quarantineDays: 1, sandboxForced: false };
    case 'T2': return { gates: ['G1', 'G2', 'G3', 'G4'], autoMerge: 'afterQuarantine7d', quarantineDays: 7, sandboxForced: true };
    default: return { gates: ['G1', 'G2', 'G3', 'G4'], autoMerge: false, quarantineDays: 0, sandboxForced: true };
  }
}

/**
 * 列出全部贡献者声誉。
 * @returns {Array<{id: string, rep: number, updated_at: string|null}>}
 */
function listReputations() {
  const table = reputationTable();
  return Object.keys(table.contributors || {}).map((k) => ({
    id: k,
    rep: table.contributors[k].rep,
    updated_at: table.contributors[k].updated_at
  })).sort((a, b) => b.rep - a.rep);
}

module.exports = {
  assignTrust,
  gateMatrix,
  getReputation,
  applyReputationDelta,
  reputationTable,
  listReputations,
  EMA_ALPHA,
  REP_BASELINE,
  REP_ANON
};

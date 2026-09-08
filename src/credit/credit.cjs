/**
 * @module credit/credit
 * @layer credit
 * @owner kou
 * 信用分：初值、命中奖惩、时间衰减（floor 由 support_count 决定）、流水落盘。
 */

'use strict';

const paths = require('../store/paths.cjs');
const jsonl = require('../store/jsonl.cjs');
const fsx = require('../util/fsx.cjs');
const id = require('../util/id.cjs');
const time = require('../util/time.cjs');

/** 奖惩表 */
const DELTAS = Object.freeze({
  hit_success: 5,
  hit_noop: -3,
  false_trigger: -8,
  miss: -1,
  external_accept: 2,
  external_reject: -5,
  needs_repro: -1,
  rollback_penalty: -20,
  injection_penalty: -40,
  promotion_bonus: 8
});

/** 单日单条奖励上限 */
const DAILY_GAIN_CAP = 20;

/**
 * 按信任级取信用初值。
 * @param {string} trustLevel T0..T3
 * @param {Object} [config]
 * @returns {number}
 */
function initCredit(trustLevel, config = {}) {
  const init = (config.external && config.external.trustInit) || { T0: 55, T1: 52, T2: 48, T3: 40 };
  return init[trustLevel] == null ? (config.credit && config.credit.init) || 50 : init[trustLevel];
}

/**
 * clamp 到 [0,100]。
 * @param {number} v
 * @returns {number}
 */
function clamp(v) {
  return Math.min(100, Math.max(0, Math.round(v * 100) / 100));
}

/**
 * 衰减下限：证据越多的经验越抗衰减。
 * @param {number} supportCount
 * @returns {number}
 */
function decayFloor(supportCount) {
  return Math.min(60, 10 + (supportCount || 0) * 5);
}

/**
 * 读取某 agent 的信用流水。
 * @param {string} agent
 * @returns {Object[]}
 */
function list(agent) {
  return jsonl.readRecords(paths.creditFile(agent)).records;
}

/**
 * 记录一次信用变更。
 * @param {{agent: string, target_type: string, target_id: string, delta: number, reason: string,
 *          before: number, after: number, ref?: Object, actor?: string}} input
 * @returns {Object} CreditRecord
 */
function record(input) {
  const rec = {
    schema: 'aed/credit-record/1.0',
    id: id.creditId(),
    ts: time.nowIso(),
    target_type: input.target_type,
    target_id: input.target_id,
    delta: input.delta,
    reason: input.reason,
    before: clamp(input.before),
    after: clamp(input.after),
    ref: input.ref || {},
    actor: input.actor || 'aed'
  };
  fsx.ensureDir(paths.creditDir());
  jsonl.appendRecord(paths.creditFile(input.agent), rec);
  return rec;
}

/**
 * 应用一次奖惩（含单日上限）。
 * @param {{agent: string, experience: Object, reason: string, ref?: Object, actor?: string}} input
 * @returns {{record: Object, experience: Object, applied: number}}
 */
function applyDelta(input) {
  const exp = input.experience;
  const reason = input.reason;
  const raw = DELTAS[reason];
  if (raw === undefined) {
    throw new Error(`未知信用原因：${reason}`);
  }
  let delta = raw;
  if (delta > 0) {
    const today = time.dayKey();
    const gained = list(input.agent)
      .filter((r) => r.target_id === exp.id && r.delta > 0 && String(r.ts).slice(0, 10) === today)
      .reduce((s, r) => s + r.delta, 0);
    if (gained + delta > DAILY_GAIN_CAP) delta = Math.max(0, DAILY_GAIN_CAP - gained);
  }
  const before = exp.credit == null ? 50 : exp.credit;
  const after = clamp(before + delta);
  const rec = record({
    agent: input.agent,
    target_type: 'experience',
    target_id: exp.id,
    delta,
    reason,
    before,
    after,
    ref: input.ref || {},
    actor: input.actor
  });
  const next = Object.assign({}, exp, { credit: after, updated_at: rec.ts });
  return { record: rec, experience: next, applied: delta };
}

/**
 * 时间衰减：每 7 天 ×0.97，floor = min(60, 10 + support*5)。
 * @param {{agent: string, experience: Object, weeks?: number, config?: Object}} input
 * @returns {{record: Object|null, experience: Object}}
 */
function decay(input) {
  const exp = input.experience;
  const weeks = input.weeks == null ? 1 : input.weeks;
  const rate = (input.config && input.config.credit && input.config.credit.decayPerWeek) || 0.97;
  const support = (exp.stats && exp.stats.support_count) || 0;
  const floor = decayFloor(support);
  const before = exp.credit == null ? 50 : exp.credit;
  const after = clamp(Math.max(floor, before * Math.pow(rate, weeks)));
  if (Math.abs(after - before) < 0.01) return { record: null, experience: exp };
  const rec = record({
    agent: input.agent,
    target_type: 'experience',
    target_id: exp.id,
    delta: Number((after - before).toFixed(2)),
    reason: 'decay',
    before,
    after,
    ref: { weeks }
  });
  return { record: rec, experience: Object.assign({}, exp, { credit: after, updated_at: rec.ts }) };
}

/**
 * 冻结判定：credit < 20 且 support < 2。
 * @param {Object} exp
 * @param {Object} [config]
 * @returns {boolean}
 */
function shouldFreeze(exp, config = {}) {
  const below = (config.credit && config.credit.freezeBelow) || 20;
  const support = (exp.stats && exp.stats.support_count) || 0;
  return (exp.credit || 0) < below && support < 2;
}

module.exports = {
  DELTAS,
  DAILY_GAIN_CAP,
  initCredit,
  clamp,
  decayFloor,
  list,
  record,
  applyDelta,
  decay,
  shouldFreeze
};

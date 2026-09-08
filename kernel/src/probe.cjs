/**
 * @module probe
 * @layer L3 演化层（probe 探针记分）
 * @owner Kou（工程师，K1）
 *
 * 规范 §1.3 probe 探针：每条注入经验自带生效判据（同 fingerprint 错误再现 → 行为是否含 fix 动作）。
 * 记分：命中且解决 +5 / 命中无效 −3 / 误触发 −8 / 漏触发 −1 / 非最优 −2。
 *
 * suboptimal（否决反馈回路新增，§4 T5）：错误被"解决"了但用户标记非最优——
 *  - 不触发自动回滚（falseTriggerRate 只统计 false_trigger，suboptimal 不计入）；
 *  - 但降权记分（−2），反映"能跑但不是用户想要的"这一档落差。
 *  - 旧账本向后兼容：历史记录不含 suboptimal 也能照常读取统计（byOutcome 按需聚合）。
 *
 * 双账本（规范 §8 写入≠遵循的缓解）：
 *  - 写入账本（written）：每次记分都记 —— "写入了"
 *  - 生效账本（effective）：仅带确认标记（effective=true）的记分入账 —— "生效了"
 * 写入与生效分开统计，写入生效率 = 生效命中 / 写入总数。
 */
'use strict';

const path = require('node:path');
const { KernelError, readJsonl, appendJsonl, genId, nowIso } = require('./util.cjs');

/** 记分表（不可变）。suboptimal：错误解决但用户标记非最优 → 不回滚、降权记分 */
const SCORES = Object.freeze({
  hit_solved: 5,
  hit_invalid: -3,
  false_trigger: -8,
  miss: -1,
  suboptimal: -2,
});

/**
 * 创建 probe 记分账本
 * @param {object} opts
 * @param {string} [opts.dataDir='runtime']
 */
function createProbeLedger({ dataDir = 'runtime' } = {}) {
  const file = path.join(dataDir, 'probe', 'probe.jsonl');
  const cache = readJsonl(file);

  /**
   * 记一条 probe 打分
   * @param {string} experienceId - 经验/候选 ID
   * @param {string} outcome - hit_solved|hit_invalid|false_trigger|miss|suboptimal
   * @param {object} [opts] { effective=false, sessionId, taskId, note }
   * @returns {object} 记录
   */
  function record(experienceId, outcome, { effective = false, sessionId = '', taskId = '', note = '' } = {}) {
    if (!experienceId) {
      throw new KernelError('PROBE_INVALID', 'probe 记分必须指定 experienceId');
    }
    if (!(outcome in SCORES)) {
      throw new KernelError('PROBE_INVALID_OUTCOME', `未知 probe 结果: ${outcome}`, { outcome });
    }
    const rec = {
      id: genId('PRB'),
      experience_id: experienceId,
      outcome,
      score: SCORES[outcome],
      effective: Boolean(effective),
      session_id: sessionId,
      task_id: taskId,
      note,
      ts: nowIso(),
    };
    cache.push(rec);
    appendJsonl(file, rec);
    return rec;
  }

  /** 按经验 ID 取记录 */
  function list(experienceId = null) {
    return cache.filter((r) => (experienceId ? r.experience_id === experienceId : true));
  }

  /**
   * 统计双账本：written（全部记录）与 effective（仅 effective=true）
   * @returns {{written: {score, count, byOutcome}, effective: {score, count, byOutcome}}}
   */
  function stats(experienceId) {
    function summarize(recs) {
      const byOutcome = {};
      let score = 0;
      for (const r of recs) {
        byOutcome[r.outcome] = (byOutcome[r.outcome] || 0) + 1;
        score += r.score;
      }
      return { score, count: recs.length, byOutcome };
    }
    const mine = list(experienceId);
    return {
      written: summarize(mine),
      effective: summarize(mine.filter((r) => r.effective)),
    };
  }

  /**
   * 误触发率（自动回滚触发条件之一：24h 内误触发率 > 10%）
   * = false_trigger 次数 / 该经验全部 probe 记录数（无记录为 0）
   */
  function falseTriggerRate(experienceId) {
    const mine = list(experienceId);
    if (!mine.length) return 0;
    const ft = mine.filter((r) => r.outcome === 'false_trigger').length;
    return ft / mine.length;
  }

  /** 写入生效率：生效记录数 / 写入记录数（无写入为 0） */
  function effectivenessRate(experienceId) {
    const mine = list(experienceId);
    if (!mine.length) return 0;
    return mine.filter((r) => r.effective && r.outcome === 'hit_solved').length / mine.length;
  }

  return { record, list, stats, falseTriggerRate, effectivenessRate, file };
}

module.exports = { createProbeLedger, SCORES };

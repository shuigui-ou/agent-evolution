/**
 * @module evidence/evidence-layer
 * @layer evidence
 * @owner kou
 * L1/L2 读写门面：traces（L1）、experiences（L2 + index）、proposals。
 */

'use strict';

const fsx = require('../util/fsx.cjs');
const paths = require('../store/paths.cjs');
const jsonl = require('../store/jsonl.cjs');
const { experienceIndex, resetIndexCache } = require('../store/index-file.cjs');
const time = require('../util/time.cjs');

/**
 * 单个 agent 的证据层。
 */
class EvidenceLayer {
  /**
   * @param {{agent: string, config?: Object}} opts
   */
  constructor(opts = {}) {
    this.agent = opts.agent || 'unknown';
    this.config = opts.config || {};
    /** @type {Object[]|null} */
    this._experiences = null;
  }

  // ===================== L1 traces =====================

  /**
   * 追加轨迹。
   * @param {Object[]} events
   * @returns {number} 写入条数
   */
  appendTraces(events) {
    const byDay = new Map();
    for (const ev of events) {
      const day = String(ev.ts || '').slice(0, 10) || time.dayKey();
      if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day).push(ev);
    }
    let n = 0;
    for (const [day, list] of byDay.entries()) {
      const file = paths.traceFile(this.agent, day);
      for (const ev of list) {
        if (jsonl.appendUnique(file, ev, (r) => `${r.agent}|${r.session_id}|${r.seq}`)) n += 1;
      }
    }
    return n;
  }

  /**
   * 读取某日轨迹。
   * @param {string} day YYYY-MM-DD
   * @returns {Object[]}
   */
  readTracesByDay(day) {
    return jsonl.readRecords(paths.traceFile(this.agent, day)).records;
  }

  /**
   * 列出该 agent 的所有轨迹日文件。
   * @returns {string[]}
   */
  listTraceDays() {
    return fsx.listFiles(paths.tracesDir(this.agent), /^\d{4}-\d{2}-\d{2}\.jsonl$/)
      .map((f) => f.split(/[\\/]/).pop().replace(/\.jsonl$/, ''))
      .sort();
  }

  /**
   * 读取全部轨迹（按时间序）。
   * @returns {Object[]}
   */
  readAllTraces() {
    const out = [];
    for (const day of this.listTraceDays()) out.push(...this.readTracesByDay(day));
    out.sort((a, b) => {
      const ta = Date.parse(a.ts || 0) || 0;
      const tb = Date.parse(b.ts || 0) || 0;
      return ta - tb || (a.seq || 0) - (b.seq || 0);
    });
    return out;
  }

  /**
   * 读取最近 N 条轨迹。
   * @param {number} limit
   * @returns {Object[]}
   */
  readRecentTraces(limit = 30) {
    const all = this.readAllTraces();
    return all.slice(Math.max(0, all.length - limit));
  }

  // ===================== L2 experiences =====================

  /**
   * 加载经验列表（带缓存）。
   * @returns {Object[]}
   */
  listExperiences() {
    if (!this._experiences) {
      this._experiences = jsonl.readRecords(paths.experienceFile(this.agent)).records;
    }
    return this._experiences;
  }

  /**
   * 按条件过滤经验。
   * @param {(exp: Object) => boolean} predicate
   * @returns {Object[]}
   */
  filterExperiences(predicate) {
    return this.listExperiences().filter(predicate);
  }

  /**
   * @param {string} id
   * @returns {Object|null}
   */
  getExperience(id) {
    return this.listExperiences().find((e) => e.id === id) || null;
  }

  /**
   * @param {string} fp
   * @returns {Object|null}
   */
  getExperienceByFingerprint(fp) {
    return this.listExperiences().find((e) => e.fingerprint === fp) || null;
  }

  /**
   * 写入或更新一条经验（全文重写，保证幂等）。
   * @param {Object} exp
   * @returns {{experience: Object, created: boolean}}
   */
  upsertExperience(exp) {
    const list = this.listExperiences();
    const idx = list.findIndex((e) => e.id === exp.id);
    let created = false;
    if (idx >= 0) {
      list[idx] = Object.assign({}, list[idx], exp, { updated_at: time.nowIso() });
    } else {
      list.push(exp);
      created = true;
    }
    this._experiences = list;
    this.flushExperiences();
    const index = experienceIndex(this.agent);
    index.upsert({
      id: exp.id,
      agent: this.agent,
      fingerprint: exp.fingerprint,
      status: exp.status,
      credit: exp.credit
    });
    index.save();
    return { experience: list[idx >= 0 ? idx : list.length - 1], created };
  }

  /**
   * 落盘经验。
   * @returns {void}
   */
  flushExperiences() {
    fsx.ensureDir(paths.experiencesDir());
    jsonl.writeAll(paths.experienceFile(this.agent), this.listExperiences());
  }

  // ===================== proposals =====================

  /**
   * 保存提案。
   * @param {Object} proposal
   * @returns {Object}
   */
  saveProposal(proposal) {
    fsx.ensureDir(paths.proposalsDir());
    fsx.atomicWriteJson(paths.proposalFile(proposal.id), proposal);
    return proposal;
  }

  /**
   * @param {string} id
   * @returns {Object|null}
   */
  getProposal(id) {
    return fsx.readJson(paths.proposalFile(id), null);
  }

  /**
   * 列出提案（可按 agent / state 过滤）。
   * @param {{agent?: string, state?: string|string[]}} [filter]
   * @returns {Object[]}
   */
  listProposals(filter = {}) {
    const files = fsx.listFiles(paths.proposalsDir(), /^pr_[0-9a-z]{16,}\.json$/);
    const out = [];
    for (const f of files) {
      const p = fsx.readJson(f, null);
      if (!p) continue;
      if (filter.agent && p.agent !== filter.agent) continue;
      if (filter.state) {
        const states = Array.isArray(filter.state) ? filter.state : [filter.state];
        if (!states.includes(p.state)) continue;
      }
      out.push(p);
    }
    out.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    return out;
  }

  /**
   * 更新提案。
   * @param {string} id
   * @param {Object} patchObj
   * @returns {Object|null}
   */
  updateProposal(id, patchObj) {
    const cur = this.getProposal(id);
    if (!cur) return null;
    const next = Object.assign({}, cur, patchObj, { updated_at: time.nowIso() });
    fsx.atomicWriteJson(paths.proposalFile(id), next);
    return next;
  }
}

/**
 * 清空全部索引缓存（测试用）。
 * @returns {void}
 */
function resetAll() {
  resetIndexCache();
}

module.exports = { EvidenceLayer, resetAll };

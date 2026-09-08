/**
 * @module external/inbox
 * @layer external
 * @owner kou
 * 统一收件箱：new → triaged → gated → canary → merged，支线 rejected / needs_repro / quarantined / duplicate。
 * SLA：new 24h 内必须 triage，gated 72h 内必须有决定。
 */

'use strict';

const fsx = require('../util/fsx.cjs');
const paths = require('../store/paths.cjs');
const jsonl = require('../store/jsonl.cjs');
const id = require('../util/id.cjs');
const time = require('../util/time.cjs');
const dedupe = require('./dedupe.cjs');
const trust = require('./trust.cjs');
const notifier = require('./notifier.cjs');
const guard = require('../security/injection-guard.cjs');
const { AedError } = require('../util/errors.cjs');

/** 状态机合法迁移 */
const TRANSITIONS = {
  new: ['triaged', 'gated', 'canary', 'merged', 'rejected', 'needs_repro', 'quarantined', 'duplicate'],
  triaged: ['gated', 'canary', 'merged', 'rejected', 'needs_repro', 'quarantined'],
  gated: ['canary', 'merged', 'rejected', 'needs_repro', 'quarantined'],
  canary: ['merged', 'rejected'],
  needs_repro: ['new', 'gated', 'rejected'],
  duplicate: [],
  rejected: [],
  quarantined: [],
  merged: []
};

/** 各决定对应的声誉增减 */
const REPUTATION_DELTA = {
  merged: 2,
  accepted: 2,
  duplicate: 0,
  needs_repro: -1,
  rejected: -5,
  quarantined: -40
};

class Inbox {
  /**
   * @param {{config?: Object, agent?: string}} [opts]
   */
  constructor(opts = {}) {
    this.config = opts.config || {};
    this.agent = opts.agent || null;
  }

  /**
   * 读取全部信号。
   * @returns {Object[]}
   */
  all() {
    return jsonl.readRecords(paths.inboxFile()).records;
  }

  /**
   * 落盘（全量重写，小规模可接受）。
   * @param {Object[]} signals
   * @returns {void}
   */
  flush(signals) {
    fsx.ensureDir(paths.inboxDir());
    jsonl.writeAll(paths.inboxFile(), signals);
    for (const s of signals) fsx.atomicWriteJson(paths.inboxItemFile(s.id), s);
  }

  /**
   * @param {string} signalId
   * @returns {Object|null}
   */
  get(signalId) {
    return this.all().find((s) => s.id === signalId) || null;
  }

  /**
   * @param {string|string[]|null} [status]
   * @returns {Object[]}
   */
  list(status = null) {
    const all = this.all();
    if (!status) return all;
    const wanted = Array.isArray(status) ? status : [status];
    return all.filter((s) => wanted.includes(s.status));
  }

  /**
   * 更新信号（校验状态机）。
   * @param {string} signalId
   * @param {Object} patchObj
   * @returns {Object}
   */
  update(signalId, patchObj) {
    const all = this.all();
    const idx = all.findIndex((s) => s.id === signalId);
    if (idx < 0) throw new AedError('E_NOT_FOUND', `信号不存在：${signalId}`);
    const next = Object.assign({}, all[idx], patchObj);
    if (patchObj.status && patchObj.status !== all[idx].status) {
      const allowed = TRANSITIONS[all[idx].status] || [];
      if (!allowed.includes(patchObj.status)) {
        throw new AedError('E_CONFIG_INVALID', `非法状态迁移 ${all[idx].status} -> ${patchObj.status}`, {
          from: all[idx].status,
          to: patchObj.status,
          allowed
        });
      }
    }
    all[idx] = next;
    this.flush(all);
    return next;
  }

  /**
   * 入队一条外部信号。
   * @param {{source: Object, kind: string, contributor?: Object, payload: Object, repro?: Object, signature?: Object|null}} input
   * @returns {{signal: Object, duplicate: null|Object, injection: Object}}
   */
  enqueue(input) {
    const now = Date.now();
    const signal = {
      schema: 'aed/external-signal/1.0',
      id: id.signalId(now),
      ts: time.nowIso(now),
      received_at: time.nowIso(now),
      source: input.source,
      kind: input.kind,
      contributor: input.contributor || { id: 'anon.unknown', pubkey: null, reputation_hint: null, contact: null },
      payload: input.payload || {},
      repro: input.repro || null,
      dedupe: {
        fingerprint: dedupe.strongFingerprint(input),
        simhash: dedupe.weakSimhash(input)
      },
      signature: input.signature || null,
      trust_level: 'T3',
      status: 'new',
      decision: null,
      notify: { receipt_sent: false, sent_at: null, channel: 'spool' }
    };

    // 1) 注入检测（命中直接隔离，不进人审）
    const injection = guard.scanDeep(signal.payload, 'payload');
    if (injection.length > 0) {
      signal.status = 'quarantined';
      signal.decision = {
        reason_code: 'E_INJECTION_DETECTED',
        reason_text: `注入检测命中：${injection.map((h) => h.rules.join(',')).join('|')}`,
        decided_at: time.nowIso(),
        gate_result_id: null,
        adopted_experience_id: null
      };
      trust.applyReputationDelta(signal.contributor.id, REPUTATION_DELTA.quarantined, 'injection');
      notifier.emitReceipt({ signal, decision: 'quarantined', reason_code: 'E_INJECTION_DETECTED', reason_text: signal.decision.reason_text });
      signal.notify.receipt_sent = true;
      signal.notify.sent_at = time.nowIso();
      this.flush(this.all().concat([signal]));
      return { signal, duplicate: null, injection: { hit: true, hits: injection } };
    }

    // 2) 去重
    const dup = dedupe.findDuplicate(signal, this.all().concat(this.experienceRefs()));
    if (dup.dup === 'strong') {
      signal.status = 'duplicate';
      signal.decision = {
        reason_code: 'E_DUPLICATE',
        reason_text: `与 ${dup.match.id} 强指纹重复（不扣分）`,
        decided_at: time.nowIso(),
        gate_result_id: null,
        adopted_experience_id: (dup.match.id || '').startsWith('exp_') ? dup.match.id : null
      };
      notifier.emitReceipt({ signal, decision: 'duplicate', reason_code: 'E_DUPLICATE', reason_text: signal.decision.reason_text });
      signal.notify.receipt_sent = true;
      signal.notify.sent_at = time.nowIso();
      this.flush(this.all().concat([signal]));
      return { signal, duplicate: dup, injection: { hit: false, hits: [] } };
    }

    // 3) 信任分级
    signal.trust_level = trust.assignTrust({
      contributor: signal.contributor,
      source: signal.source,
      signature: signal.signature
    });
    this.flush(this.all().concat([signal]));
    return { signal, duplicate: dup.dup === 'weak' ? dup : null, injection: { hit: false, hits: [] } };
  }

  /**
   * 供去重比对的已有经验引用（fingerprint/simhash）。
   * @returns {Object[]}
   */
  experienceRefs() {
    const out = [];
    for (const file of fsx.listFiles(paths.experiencesDir(), /\.jsonl$/)) {
      for (const rec of jsonl.readRecords(file).records) {
        out.push({ id: rec.id, fingerprint: rec.fingerprint, simhash: rec.simhash });
      }
    }
    return out;
  }

  /**
   * triage：去重复核 + 信任复核。
   * @param {string} signalId
   * @returns {Object}
   */
  triage(signalId) {
    const s = this.get(signalId);
    if (!s) throw new AedError('E_NOT_FOUND', `信号不存在：${signalId}`);
    const level = trust.assignTrust({ contributor: s.contributor, source: s.source, signature: s.signature });
    return this.update(signalId, { status: 'triaged', trust_level: level });
  }

  /**
   * 决策并回执。
   * @param {string} signalId
   * @param {'merged'|'rejected'|'needs_repro'|'quarantined'|'duplicate'|'canary'} decision
   * @param {{reason_code?: string, reason_text?: string, gate_result_id?: string|null,
   *          adopted_experience_id?: string|null, credit_awarded?: number}} [opts]
   * @returns {{signal: Object, receipt: Object}}
   */
  decide(signalId, decision, opts = {}) {
    const s = this.get(signalId);
    if (!s) throw new AedError('E_NOT_FOUND', `信号不存在：${signalId}`);
    const status = decision === 'accepted' ? 'merged' : decision;
    const delta = REPUTATION_DELTA[decision] == null ? 0 : REPUTATION_DELTA[decision];
    const updated = this.update(signalId, {
      status,
      decision: {
        reason_code: opts.reason_code || null,
        reason_text: opts.reason_text || '',
        decided_at: time.nowIso(),
        gate_result_id: opts.gate_result_id || null,
        adopted_experience_id: opts.adopted_experience_id || null
      },
      notify: { receipt_sent: true, sent_at: time.nowIso(), channel: 'spool' }
    });
    if (delta !== 0) {
      trust.applyReputationDelta(updated.contributor.id, delta, decision);
    }
    const receipt = notifier.emitReceipt({
      signal: updated,
      decision,
      reason_code: opts.reason_code,
      reason_text: opts.reason_text,
      gate_result_id: opts.gate_result_id,
      adopted_experience_id: opts.adopted_experience_id,
      credit_awarded: delta
    });
    return { signal: updated, receipt };
  }

  /**
   * SLA 巡检。
   * @returns {Object[]} 超时信号
   */
  slaCheck() {
    return this.all().filter((s) => notifier.isOverdue(s));
  }
}

module.exports = { Inbox, TRANSITIONS, REPUTATION_DELTA };

/**
 * @module cli/cmd-inbox
 * @layer cli
 * @owner kou
 * aed inbox list / show / import / triage / accept / reject / notify
 */

'use strict';

const path = require('node:path');
const fsx = require('../util/fsx.cjs');
const paths = require('../store/paths.cjs');
const jsonl = require('../store/jsonl.cjs');
const configMod = require('../config.cjs');
const { Inbox } = require('../external/inbox.cjs');
const trust = require('../external/trust.cjs');
const notifier = require('../external/notifier.cjs');
const { AedError } = require('../util/errors.cjs');

/**
 * @param {{sub: string, flags: Object, positional: string[]}} args
 * @returns {Object}
 */
function run(args) {
  const { sub, flags } = args;
  const cfg = configMod.getConfig();
  paths.setRoot(cfg.root);
  const inbox = new Inbox({ config: cfg });

  if (sub === 'list') {
    const list = inbox.list(flags.status || null);
    return {
      count: list.length,
      signals: list,
      __text: list.length === 0
        ? '收件箱为空'
        : list.map((s) => `${s.status.padEnd(11)} ${s.trust_level} ${s.id}  ${s.kind}  ${(s.payload && s.payload.title) || '-'}`).join('\n')
    };
  }

  if (sub === 'show') {
    const idv = flags.signal || flags.id;
    if (!idv) throw new AedError('E_ARG_INVALID', '缺少 --signal');
    const s = inbox.get(String(idv));
    if (!s) throw new AedError('E_NOT_FOUND', `信号不存在：${idv}`);
    return { signal: s };
  }

  if (sub === 'import') {
    const file = flags.file;
    if (!file) throw new AedError('E_ARG_INVALID', '缺少 --file');
    const abs = path.isAbsolute(String(file)) ? String(file) : path.join(paths.getRoot(), String(file));
    const { records, bad } = jsonl.readRecords(abs);
    const out = [];
    for (const r of records) {
      out.push(inbox.enqueue(r));
    }
    return {
      imported: out.length,
      bad,
      results: out.map((r) => ({
        id: r.signal.id,
        status: r.signal.status,
        trust_level: r.signal.trust_level,
        duplicate: r.duplicate ? (r.duplicate.match && r.duplicate.match.id) : null,
        injection: r.injection.hit
      })),
      __text: out.map((r) => `${r.signal.status.padEnd(11)} ${r.signal.trust_level} ${r.signal.id}`).join('\n')
    };
  }

  if (sub === 'triage') {
    const idv = flags.signal || flags.id;
    if (!idv) throw new AedError('E_ARG_INVALID', '缺少 --signal');
    const s = inbox.triage(String(idv));
    return { signal: s, __text: `${s.id} -> ${s.status} (${s.trust_level})` };
  }

  if (sub === 'accept' || sub === 'reject' || sub === 'needs-repro') {
    const idv = flags.signal || flags.id;
    if (!idv) throw new AedError('E_ARG_INVALID', '缺少 --signal');
    const decision = sub === 'accept' ? 'merged' : (sub === 'reject' ? 'rejected' : 'needs_repro');
    const res = inbox.decide(String(idv), decision, {
      reason_code: flags['reason-code'] || null,
      reason_text: flags['reason-text'] || '',
      adopted_experience_id: flags['experience-id'] || null
    });
    return { signal: res.signal, receipt: res.receipt, __text: `${res.signal.id} -> ${res.signal.status}` };
  }

  if (sub === 'notify') {
    if (flags.digest) {
      const out = notifier.buildDigest({
        signals: inbox.all(),
        reputations: trust.listReputations(),
        config: cfg
      });
      return { digest: out.stats, file: out.file, __text: `digest 已生成：${out.file}` };
    }
    const overdue = inbox.slaCheck();
    return {
      overdue: overdue.length,
      signals: overdue,
      __text: overdue.length === 0 ? '无超时信号' : overdue.map((s) => `${s.status} ${s.id}`).join('\n')
    };
  }

  return { __text: '用法: aed inbox list|show|import|triage|accept|reject|needs-repro|notify' };
}

module.exports = { run, Inbox, fsx };

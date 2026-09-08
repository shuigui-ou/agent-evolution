/**
 * @module external/notifier
 * @layer external
 * @owner kou
 * 主动通知：本地 spool（回执 Markdown + notify.jsonl）+ 每日 digest。
 * toast / webhook 为 P2（此处保留开关与占位，不产生外部副作用）。
 */

'use strict';

const path = require('node:path');
const fsx = require('../util/fsx.cjs');
const paths = require('../store/paths.cjs');
const time = require('../util/time.cjs');
const jsonl = require('../store/jsonl.cjs');

/**
 * 写一条 spool 通知。
 * @param {{id: string, title: string, body: string, channel?: string}} input
 * @returns {string} 文件路径
 */
function writeSpool(input) {
  const ts = time.nowIso().replace(/[:.]/g, '-');
  const file = path.join(paths.notifySpoolDir(), `${ts}-${input.id}.md`);
  fsx.ensureDir(paths.notifySpoolDir());
  fsx.atomicWrite(file, `# ${input.title}\n\n${input.body}\n`);
  jsonl.appendRecord(paths.notifyFile(), {
    id: input.id,
    title: input.title,
    channel: input.channel || 'spool',
    file,
    ts: time.nowIso()
  });
  return file;
}

/**
 * 生成并投递一条回执。
 * @param {{signal: Object, decision: string, reason_code?: string, reason_text?: string,
 *          gate_result_id?: string|null, adopted_experience_id?: string|null, credit_awarded?: number}} input
 * @returns {Object} receipt
 */
function emitReceipt(input) {
  const signal = input.signal || {};
  const receipt = {
    signal_id: signal.id || 'unknown',
    decision: input.decision,
    reason_code: input.reason_code || null,
    reason_text: input.reason_text || '',
    gate_result_id: input.gate_result_id || null,
    adopted_experience_id: input.adopted_experience_id || null,
    credit_awarded: input.credit_awarded == null ? 0 : input.credit_awarded,
    decided_at: time.nowIso()
  };
  const body = [
    `- signal_id: \`${receipt.signal_id}\``,
    `- decision: **${receipt.decision}**`,
    `- reason_code: ${receipt.reason_code || '-'}`,
    `- reason_text: ${receipt.reason_text || '-'}`,
    `- gate_result_id: ${receipt.gate_result_id || '-'}`,
    `- adopted_experience_id: ${receipt.adopted_experience_id || '-'}`,
    `- credit_awarded: ${receipt.credit_awarded}`,
    `- decided_at: ${receipt.decided_at}`
  ].join('\n');
  const file = writeSpool({
    id: `receipt-${receipt.signal_id}`,
    title: `AED 回执：${receipt.decision}（${receipt.signal_id}）`,
    body,
    channel: 'spool'
  });
  return Object.assign({}, receipt, { spool_file: file });
}

/**
 * 生成每日 digest Markdown。
 * @param {{day?: string, signals?: Object[], experiences?: Object[], reputations?: Array, budget?: Object, config?: Object}} input
 * @returns {{file: string, markdown: string, stats: Object}}
 */
function buildDigest(input = {}) {
  const day = input.day || time.dayKey();
  const signals = input.signals || [];
  const stats = {
    day,
    new_signals: signals.filter((s) => s.status === 'new').length,
    pending: signals.filter((s) => ['new', 'triaged', 'gated'].includes(s.status)).length,
    merged: signals.filter((s) => s.status === 'merged').length,
    rejected: signals.filter((s) => s.status === 'rejected').length,
    needs_repro: signals.filter((s) => s.status === 'needs_repro').length,
    quarantined: signals.filter((s) => s.status === 'quarantined').length,
    duplicate: signals.filter((s) => s.status === 'duplicate').length,
    overdue: signals.filter((s) => isOverdue(s)).length
  };
  const lines = [];
  lines.push(`# AED 每日 Digest — ${day}`);
  lines.push('');
  lines.push('## 收件箱');
  lines.push('');
  lines.push(`- 新信号：${stats.new_signals}`);
  lines.push(`- 待决：${stats.pending}`);
  lines.push(`- 已采纳：${stats.merged}`);
  lines.push(`- 已拒绝：${stats.rejected}`);
  lines.push(`- 需补充 repro：${stats.needs_repro}`);
  lines.push(`- 隔离中：${stats.quarantined}`);
  lines.push(`- 重复：${stats.duplicate}`);
  if (stats.overdue > 0) lines.push(`- **超 SLA：${stats.overdue}**（标红）`);
  lines.push('');
  lines.push('## 贡献者声誉');
  lines.push('');
  const reps = input.reputations || [];
  if (reps.length === 0) lines.push('- 暂无外部贡献');
  for (const r of reps.slice(0, 20)) lines.push(`- ${r.id}: ${r.rep}`);
  lines.push('');
  lines.push('## 经验库');
  lines.push('');
  const exps = input.experiences || [];
  lines.push(`- 总数：${exps.length}`);
  lines.push(`- active：${exps.filter((e) => e.status === 'active').length}`);
  lines.push(`- frozen：${exps.filter((e) => e.status === 'frozen').length}`);
  lines.push(`- 即将淘汰（credit<30）：${exps.filter((e) => (e.credit || 0) < 30).length}`);
  lines.push('');
  lines.push('## 注入预算');
  lines.push('');
  if (input.budget) lines.push(`- 水位：${input.budget.used || 0}/${input.budget.max || 8000} token，${input.budget.items || 0}/${input.budget.maxItems || 40} 条`);
  else lines.push('- 未计算');

  const markdown = `${lines.join('\n')}\n`;
  const file = paths.digestFile(day);
  fsx.ensureDir(paths.reportsDir());
  fsx.atomicWrite(file, markdown);
  return { file, markdown, stats };
}

/**
 * SLA 超时判定：new 24h 内必须 triage，gated 72h 内必须有决定。
 * @param {Object} signal
 * @param {number} [nowTs]
 * @returns {boolean}
 */
function isOverdue(signal, nowTs = Date.now()) {
  const received = Date.parse(signal.received_at || signal.ts || 0);
  if (!Number.isFinite(received)) return false;
  const hours = (nowTs - received) / 3600000;
  if (signal.status === 'new' || signal.status === 'triaged') return hours > 24;
  if (signal.status === 'gated') return hours > 72;
  return false;
}

module.exports = { writeSpool, emitReceipt, buildDigest, isOverdue };

/**
 * @module src/assessment/assess
 * @layer 评估脚手架（K6）
 * @owner Alex（软件工程师，K5/K6）
 *
 * 回溯式评估主入口：给定内核数据目录（ledger/signals/audit/probe 的 JSONL）
 * + 可选修复事件表，聚合 RR / FSR / 漏调用率 / 遵循率 四指标并产出报告。
 * 空数据也能跑：指标缺分母一律 status='na' + value=null，不崩溃。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { readJsonl } = require('../../kernel/src/util.cjs');
const { METRIC_DEFINITIONS } = require('./definitions.cjs');
const {
  collectOccurrences,
  collectFixEvents,
  computeRR,
  computeProbeMetrics,
  computeAuditCrossCheck,
} = require('./metrics.cjs');

function listJsonlFiles(dir) {
  if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => path.join(dir, f));
}

function readAllJsonl(files) {
  const out = [];
  for (const f of files) out.push(...readJsonl(f));
  return out;
}

/**
 * 执行回溯式评估
 * @param {object} opts
 * @param {string} opts.dataDir - 内核数据目录（应含 ledger/、probe/、audit/、可选 signals/）
 * @param {string} [opts.fixEventsPath] - 修复事件表 JSONL（可选；缺省从 audit KNOWLEDGE_WRITE 提取）
 * @returns {object} 报告
 */
function assess({ dataDir = 'runtime', fixEventsPath = null } = {}) {
  const ledgerRows = readAllJsonl([path.join(dataDir, 'ledger', 'ledger.jsonl')]);
  const auditRows = readAllJsonl([path.join(dataDir, 'audit', 'audit.jsonl')]);
  const probeRows = readAllJsonl([path.join(dataDir, 'probe', 'probe.jsonl')]);
  const signalFiles = listJsonlFiles(path.join(dataDir, 'signals'));
  const signalRows = readAllJsonl(signalFiles);
  const fixEventRows = fixEventsPath ? readJsonl(fixEventsPath) : [];

  const occurrences = collectOccurrences({ ledger: ledgerRows, signals: signalRows });
  const fixes = collectFixEvents({ audit: auditRows, fixEvents: fixEventRows });
  const rr = computeRR(occurrences.map, fixes);
  const probeMetrics = computeProbeMetrics(probeRows);
  const auditCross = computeAuditCrossCheck({ auditRows, occurrencesMap: occurrences.map, fixesMap: fixes });

  const metrics = {
    rr: rr.metric,
    fsr: probeMetrics.fsr,
    missed_call_rate: probeMetrics.missed_call_rate,
    adherence_rate: probeMetrics.adherence_rate,
  };

  const details = {
    recurrence: rr.details,
    probe: probeMetrics.probe_details,
    audit_cross_check: auditCross,
  };

  const summary = buildSummary({
    dataDir,
    fixEventsPath,
    metrics,
    details,
    inputs: {
      ledger_rows: ledgerRows.length,
      signal_rows: signalRows.length,
      audit_rows: auditRows.length,
      probe_rows: probeRows.length,
      fix_event_rows: fixEventRows.length,
      error_occurrences: occurrences.count,
      landed_fingerprints: fixes.size,
    },
  });

  return {
    generated_at: new Date().toISOString(),
    tool: 'evolution-eval',
    spec: 'EVOLUTION-KERNEL-SPEC §7 K6（回溯式，无前置基线窗）',
    scope: { data_dir: dataDir, fix_events: fixEventsPath },
    inputs: {
      ledger_rows: ledgerRows.length,
      signal_rows: signalRows.length,
      audit_rows: auditRows.length,
      probe_rows: probeRows.length,
      fix_event_rows: fixEventRows.length,
      error_occurrences: occurrences.count,
      landed_fingerprints: fixes.size,
    },
    metric_definitions: METRIC_DEFINITIONS,
    metrics,
    details,
    summary,
  };
}

/** 人类可读摘要（含每个指标定义与算法一句话） */
function buildSummary({ dataDir, fixEventsPath, metrics, details, inputs }) {
  const fmt = (m) =>
    m.status === 'ok' ? m.value.toFixed(4) : 'N/A';

  const lines = [];
  lines.push('进化评估报告（K6 回溯式，无前置基线窗）');
  lines.push(`数据目录: ${dataDir}${fixEventsPath ? `　修复事件表: ${fixEventsPath}` : '（修复事件取自 audit KNOWLEDGE_WRITE）'}`);
  lines.push(`样本量: ledger=${inputs.ledger_rows} signals=${inputs.signal_rows} audit=${inputs.audit_rows} probe=${inputs.probe_rows} fix-events=${inputs.fix_event_rows} 错误出现=${inputs.error_occurrences} 已修复指纹=${inputs.landed_fingerprints}`);
  lines.push('');
  lines.push('指标定义与算法（一句话）:');
  for (const d of METRIC_DEFINITIONS) {
    lines.push(`- ${d.name}${d.role === '北极星' ? '（北极星）' : ''}: ${d.algorithm}`);
  }
  lines.push('');
  lines.push('结果:');
  lines.push(`- RR 同类问题复发率(北极星) = ${fmt(metrics.rr)}　（${metrics.rr.denominator > 0 ? `复发 ${metrics.rr.numerator} / 已修复 ${metrics.rr.denominator}` : '无已修复指纹'}）`);
  lines.push(`- FSR 修复成功率 = ${fmt(metrics.fsr)}　（${metrics.fsr.denominator > 0 ? `成功 ${metrics.fsr.numerator} / 有反馈 ${metrics.fsr.denominator}` : '无 probe 反馈'}）`);
  lines.push(`- 漏调用率 = ${fmt(metrics.missed_call_rate)}　（${metrics.missed_call_rate.denominator > 0 ? `漏 ${metrics.missed_call_rate.numerator} / 判定样本 ${metrics.missed_call_rate.denominator}` : '无判定样本'}）`);
  lines.push(`- 遵循率 = ${fmt(metrics.adherence_rate)}　（${metrics.adherence_rate.denominator > 0 ? `遵循 ${metrics.adherence_rate.numerator} / 判定样本 ${metrics.adherence_rate.denominator}` : '无判定样本'}）`);
  lines.push('');
  const rec = details.recurrence || {};
  lines.push(`落地前后复发趋势（回溯式）: 修复前错误出现 ${rec.pre_fix_total ?? 0} 次，修复后 ${rec.post_fix_total ?? 0} 次；复发指纹 ${rec.recurrent_count ?? 0}/${rec.addressed_count ?? 0}。`);
  const cross = details.audit_cross_check;
  if (cross) {
    lines.push(`审计交叉核对（PRE_ACTION_HIT ±15s 内应答）: 机会 ${cross.opportunities}，应答 ${cross.answered}${cross.rate != null ? `，应答率 ${cross.rate.toFixed(4)}` : ''}${cross.note ? `（${cross.note}）` : ''}`);
  } else {
    lines.push('审计交叉核对: 数据不足，跳过。');
  }
  lines.push('');
  lines.push('口径说明: RR 直接衡量"修复后同类问题是否再来"（北极星）；FSR 衡量落地经验是否真解决；漏调用率与遵循率从 probe 判定样本互补刻画"该用时是否用了"。');
  return lines.join('\n');
}

module.exports = { assess, buildSummary, listJsonlFiles, readAllJsonl };

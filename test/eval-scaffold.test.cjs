/**
 * K6 评估脚手架测试：fixture 回溯聚合四指标 + 空数据容错 + 纯函数口径
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { assess } = require('../src/assessment/assess.cjs');
const {
  collectOccurrences,
  collectFixEvents,
  computeProbeMetrics,
  computeRR,
} = require('../src/assessment/metrics.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const FIXTURE_DIR = path.join(REPO_ROOT, 'fixtures', 'eval');

function makeTmpDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `eval-${tag}-`));
}

function rmTmpDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

test('K6 回溯评估：fixtures/eval 聚合出 RR=0.5 / FSR=0.75 / 漏调用率=0.2 / 遵循率=0.8', async () => {
  const report = assess({
    dataDir: FIXTURE_DIR,
    fixEventsPath: path.join(FIXTURE_DIR, 'fix-events.jsonl'),
  });

  // 指标四则全部可用（ok）
  assert.equal(report.metrics.rr.status, 'ok');
  assert.equal(report.metrics.rr.value, 0.5);
  assert.equal(report.metrics.rr.numerator, 2);
  assert.equal(report.metrics.rr.denominator, 4);

  assert.equal(report.metrics.fsr.status, 'ok');
  assert.equal(report.metrics.fsr.value, 0.75);
  assert.equal(report.metrics.fsr.numerator, 3);
  assert.equal(report.metrics.fsr.denominator, 4);

  assert.equal(report.metrics.missed_call_rate.status, 'ok');
  assert.equal(report.metrics.missed_call_rate.value, 0.2);
  assert.equal(report.metrics.missed_call_rate.numerator, 1);
  assert.equal(report.metrics.missed_call_rate.denominator, 5);

  assert.equal(report.metrics.adherence_rate.status, 'ok');
  assert.equal(report.metrics.adherence_rate.value, 0.8);
  assert.equal(report.metrics.adherence_rate.numerator, 4);

  // 定义与摘要
  assert.ok(Array.isArray(report.metric_definitions) && report.metric_definitions.length === 4);
  assert.ok(report.summary.includes('RR 同类问题复发率'));
  assert.ok(report.summary.includes('FSR 修复成功率'));
  assert.ok(report.summary.includes('落地前后复发趋势'));

  // 落地前后趋势
  const rec = report.details.recurrence;
  assert.equal(rec.pre_fix_total, 3);
  assert.equal(rec.post_fix_total, 2);

  // 审计交叉核对（PRE_ACTION_HIT ±15s）：机会 2（A、D 修复后再现），应答 1（A）
  const cross = report.details.audit_cross_check;
  assert.ok(cross);
  assert.equal(cross.opportunities, 2);
  assert.equal(cross.answered, 1);
  assert.equal(cross.rate, 0.5);
});

test('K6 空数据容错：无 ledger/audit/probe 也不崩，指标一律 N/A 数值 0', async () => {
  const dir = makeTmpDir('empty');
  try {
    const report = assess({ dataDir: dir });
    assert.equal(report.inputs.ledger_rows, 0);
    assert.equal(report.inputs.audit_rows, 0);
    assert.equal(report.inputs.probe_rows, 0);
    assert.equal(report.inputs.error_occurrences, 0);
    for (const key of ['rr', 'fsr', 'missed_call_rate', 'adherence_rate']) {
      assert.equal(report.metrics[key].status, 'na');
      assert.equal(report.metrics[key].value, null);
    }
    // 缺省值 path 不存在的 dataDir（assess 内部文件缺失均按空处理）
    const report2 = assess({ dataDir: path.join(dir, 'no-such-sub') });
    assert.equal(report2.metrics.rr.status, 'na');
  } finally {
    rmTmpDir(dir);
  }
});

test('K6 纯函数口径：occurrence 去重、fix 事件合并、probe 计数', async () => {
  const occ = collectOccurrences({
    ledger: [
      { ledger: 'error', title: 'boom', detail: 'x', opened_at: '2026-01-01T00:00:00.000Z' },
      { ledger: 'error', title: 'boom', detail: 'x', opened_at: '2026-01-01T00:00:00.500Z' }, // 同一秒去重
      { ledger: 'error', title: 'boom', detail: 'x', opened_at: '2026-01-02T00:00:00.000Z' }, // 不同秒保留
      { ledger: 'expectation', title: 'not-an-error', detail: '', opened_at: '2026-01-03T00:00:00.000Z' }, // 非 error 账本忽略
    ],
    signals: [],
  });
  assert.equal(occ.count, 2, '同一秒去重后只剩 2 条真实出现');

  const fixes = collectFixEvents({
    audit: [{ type: 'KNOWLEDGE_WRITE', ts: '2026-01-05T00:00:00.000Z', payload: { fingerprint: 'f1', experience_id: 'e1' } }],
    fixEvents: [{ fingerprint: 'f2', ts: '2026-01-06T00:00:00.000Z', experience_id: 'e2' }],
  });
  assert.equal(fixes.size, 2);
  assert.equal(fixes.get('f1').events.length, 1);

  const rr = computeRR(
    new Map([['f1', [new Date('2026-01-01T00:00:00Z').getTime()]], ['f2', [new Date('2026-01-07T00:00:00Z').getTime()]]]),
    fixes
  );
  assert.equal(rr.metric.value, 0.5, 'f1 未复发、f2 在修复后复发 → 1/2');

  const pm = computeProbeMetrics([
    { experience_id: 'e1', outcome: 'hit_solved' },
    { experience_id: 'e2', outcome: 'hit_invalid' },
    { experience_id: 'e3', outcome: 'miss' },
    { experience_id: 'e3', outcome: 'miss' },
    { experience_id: 'e4', outcome: 'false_trigger' }, // 不进判定样本
  ]);
  assert.equal(pm.missed_call_rate.value, 0.5); // 2 miss / (1+1+2)
  assert.equal(pm.adherence_rate.value, 0.5);
  assert.equal(pm.fsr.value, 0.3333); // e1,e2,e3 有反馈；仅 e1 成功（值保留 4 位小数）
  assert.equal(pm.fsr.numerator, 1);
  assert.equal(pm.fsr.denominator, 3);
});

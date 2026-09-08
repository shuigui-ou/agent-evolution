/**
 * probe.cjs 测试：记分表正确性 / 双账本（写入 vs 生效分开记）/ 误触发率
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createProbeLedger, SCORES } = require('../src/probe.cjs');
const { makeTmpDir, rmTmpDir } = require('./helpers.cjs');

test('probe 记分：五类结果得分 +5/−3/−8/−1/−2；未知结果与缺 ID 报错', () => {
  const dir = makeTmpDir('probe-score');
  try {
    const p = createProbeLedger({ dataDir: dir });
    assert.deepEqual(SCORES, { hit_solved: 5, hit_invalid: -3, false_trigger: -8, miss: -1, suboptimal: -2 });
    assert.equal(p.record('EXP-1', 'hit_solved').score, 5);
    assert.equal(p.record('EXP-1', 'hit_invalid').score, -3);
    assert.equal(p.record('EXP-1', 'false_trigger').score, -8);
    assert.equal(p.record('EXP-1', 'miss').score, -1);
    assert.equal(p.record('EXP-1', 'suboptimal').score, -2);
    assert.throws(() => p.record('EXP-1', 'super_hit'), /PROBE_INVALID_OUTCOME/);
    assert.throws(() => p.record('', 'hit_solved'), /PROBE_INVALID/);
    assert.equal(p.stats('EXP-1').written.score, -9); // 5−3−8−1−2
  } finally {
    rmTmpDir(dir);
  }
});

test('双账本：written 记全部，effective 只记带确认标记的（写入≠遵循 分开统计）', () => {
  const dir = makeTmpDir('probe-dual');
  try {
    const p = createProbeLedger({ dataDir: dir });
    p.record('EXP-A', 'hit_solved');                     // 写入了，但没确认生效
    p.record('EXP-A', 'hit_solved', { effective: true }); // 写入且确认生效
    p.record('EXP-A', 'false_trigger');
    const s = p.stats('EXP-A');
    assert.equal(s.written.count, 3);
    assert.equal(s.effective.count, 1);
    assert.equal(s.effective.score, 5);
    // 写入生效率 = 生效命中 / 写入总数 = 1/3
    assert.ok(Math.abs(p.effectivenessRate('EXP-A') - 1 / 3) < 1e-9);
  } finally {
    rmTmpDir(dir);
  }
});

test('误触发率：false_trigger / 总记录；无记录为 0；持久化跨实例可见', () => {
  const dir = makeTmpDir('probe-rate');
  try {
    const p1 = createProbeLedger({ dataDir: dir });
    assert.equal(p1.falseTriggerRate('EXP-X'), 0);
    p1.record('EXP-X', 'hit_solved');
    p1.record('EXP-X', 'hit_invalid');
    p1.record('EXP-X', 'false_trigger');
    p1.record('EXP-X', 'false_trigger');
    assert.equal(p1.falseTriggerRate('EXP-X'), 0.5);

    const p2 = createProbeLedger({ dataDir: dir });
    assert.equal(p2.stats('EXP-X').written.count, 4, 'JSONL 落盘跨实例可见');
  } finally {
    rmTmpDir(dir);
  }
});

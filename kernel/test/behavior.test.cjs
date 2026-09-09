'use strict';
/**
 * 行为贴合层测试（方向 A）
 * 运行：cd kernel && node --test test/*.test.cjs
 *
 * 覆盖：
 *  1. record：合法维度/方向写入 append-only 账本；非法维度/方向抛 KernelError
 *  2. parseCorrection：中文纠偏 → 维度/方向启发式（详尽/简洁/分步/直接）
 *  3. profile：同向 ≥minEvidence 且置信 ≥confidence → stable；滑动窗口生效
 *  4. guidance：模板文本不含用户原文；无稳定偏好时 text=''
 *  5. reset：user 来源可清空；非 user 来源抛 BEHAVIOR_FORBIDDEN
 *  6. kernel 集成：tapBehavior/behaviorProfile/behaviorGuidance 暴露 + kill 后不可写
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createBehaviorLedger,
  parseCorrection,
  BEHAVIOR_DIMENSIONS,
} = require('../src/behavior.cjs');
const { createKernel, KernelError } = require('../src/kernel.cjs');

function tmpData(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'evbeh-' + tag + '-'));
}

// ---------------------------------------------------------------- 1. record
test('record：合法维度写 append-only 账本；非法维度/方向抛 KernelError', () => {
  const dataDir = tmpData('record');
  const ledger = createBehaviorLedger({ dataDir });
  const rec = ledger.record({ dimension: 'verbosity', direction: 'less', text: '太长了' });
  assert.equal(rec.dimension, 'verbosity');
  assert.equal(rec.direction, 'less');
  assert.ok(rec.id && rec.ts);
  // 落盘
  const file = path.join(dataDir, 'behavior', 'observations.jsonl');
  assert.equal(fs.existsSync(file), true);
  assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 1);
  // 非法维度
  assert.throws(
    () => ledger.record({ dimension: 'color', direction: 'less' }),
    (e) => e.code === 'BEHAVIOR_INVALID_DIMENSION'
  );
  // 非法方向
  assert.throws(
    () => ledger.record({ dimension: 'verbosity', direction: 'sideways' }),
    (e) => e.code === 'BEHAVIOR_INVALID_DIRECTION'
  );
});

// ---------------------------------------------------------------- 2. parseCorrection
test('parseCorrection：中文纠偏 → 维度/方向启发式', () => {
  let r = parseCorrection('太长了，简洁一点');
  assert.equal(r.dimension, 'verbosity');
  assert.equal(r.direction, 'less');
  assert.ok(r.matched.includes('简洁'));
  r = parseCorrection('能不能详细展开讲讲');
  assert.equal(r.dimension, 'verbosity');
  assert.equal(r.direction, 'more');
  r = parseCorrection('别分步了，直接给结果');
  assert.equal(r.dimension, 'pace');
  assert.equal(r.direction, 'less');
  r = parseCorrection('先确认再继续，一步步来');
  assert.equal(r.dimension, 'pace');
  assert.equal(r.direction, 'more');
  r = parseCorrection('给数据支撑，有依据吗');
  assert.equal(r.dimension, 'detail');
  assert.equal(r.direction, 'more');
  assert.equal(parseCorrection('今天的天气如何'), null);
  assert.equal(parseCorrection(''), null);
});

// ---------------------------------------------------------------- 3. profile
test('profile：同向 ≥minEvidence 且置信达标 → stable；窗口滑动后旧观察退出', () => {
  const dataDir = tmpData('profile');
  const ledger = createBehaviorLedger({ dataDir, windowSize: 5, minEvidence: 3, confidence: 0.6 });
  // 3 次 less + 1 次 more → majority=3, total=4, conf=0.75 → stable=less
  ledger.record({ dimension: 'verbosity', direction: 'less', text: '太长' });
  ledger.record({ dimension: 'verbosity', direction: 'less', text: '啰嗦' });
  ledger.record({ dimension: 'verbosity', direction: 'less', text: '精简' });
  ledger.record({ dimension: 'verbosity', direction: 'more', text: '详细点' });
  const p = ledger.profile().find((x) => x.dimension === 'verbosity');
  assert.equal(p.stable, true);
  assert.equal(p.direction, 'less');
  assert.equal(p.wording, '更简洁');
  assert.ok(p.confidence >= 0.75);
  // 窗口滑动（windowSize=5）：第 4 条是 more，需再灌 5 条 less 把它挤出窗口
  for (let i = 0; i < 5; i++) ledger.record({ dimension: 'verbosity', direction: 'less', text: '短' + i });
  const p2 = ledger.profile().find((x) => x.dimension === 'verbosity');
  assert.equal(p2.stable, true);
  assert.equal(p2.majority, p2.total); // 窗口内全 less
  // 证据不足维度不 stable
  const p3 = ledger.profile().find((x) => x.dimension === 'pace');
  assert.equal(p3.stable, false);
});

// ---------------------------------------------------------------- 4. guidance
test('guidance：模板文本不含用户原文；无稳定偏好时 text=""', () => {
  const dataDir = tmpData('guid');
  const ledger = createBehaviorLedger({ dataDir, windowSize: 10, minEvidence: 3, confidence: 0.6 });
  // 无稳定偏好
  let g = ledger.guidance();
  assert.equal(g.text, '');
  assert.equal(g.active.length, 0);
  // 灌足 verbosity less
  ledger.record({ dimension: 'verbosity', direction: 'less', text: '用户原话太长太啰嗦请务必精简到极致' });
  ledger.record({ dimension: 'verbosity', direction: 'less', text: '第二句原话' });
  ledger.record({ dimension: 'verbosity', direction: 'less', text: '第三句原话' });
  g = ledger.guidance();
  assert.ok(g.text.includes('输出篇幅'));
  assert.ok(g.text.includes('更简洁'));
  assert.equal(g.active.length, 1);
  assert.ok(!g.text.includes('用户原话太长太啰嗦')); // 模板不拼原文
  assert.ok(!g.text.includes('第二句原话'));
});

// ---------------------------------------------------------------- 5. reset
test('reset：user 来源清空维度/全部；非 user 来源抛 BEHAVIOR_FORBIDDEN', () => {
  const dataDir = tmpData('reset');
  const ledger = createBehaviorLedger({ dataDir });
  ledger.record({ dimension: 'verbosity', direction: 'less' });
  ledger.record({ dimension: 'pace', direction: 'more' });
  // 清空单维度
  const r1 = ledger.reset('verbosity', { source: 'user' });
  assert.equal(r1.removed, 1);
  assert.equal(ledger.list().length, 1);
  // 清空全部
  const r2 = ledger.reset('', { source: 'user' });
  assert.equal(r2.removed, 1);
  assert.equal(ledger.list().length, 0);
  // 非 user 来源
  assert.throws(
    () => ledger.reset('', { source: 'system' }),
    (e) => e.code === 'BEHAVIOR_FORBIDDEN'
  );
});

// ---------------------------------------------------------------- 6. kernel 集成
test('kernel 集成：tapBehavior/behaviorProfile/behaviorGuidance 可用；kill 后拒绝写', () => {
  const dataDir = tmpData('kern');
  const kernel = createKernel({
    dataDir,
    host: { agentId: 'test-agent' },
    knowledgeSurface: { root: path.join(dataDir, 'k'), whitelist: ['errors.jsonl'] },
    behavior: { windowSize: 10, minEvidence: 2, confidence: 0.5 },
  });
  kernel.tapBehavior({ dimension: 'verbosity', direction: 'less', text: '太长了' });
  kernel.tapBehavior({ dimension: 'verbosity', direction: 'less', text: '啰嗦' });
  const prof = kernel.behaviorProfile().find((x) => x.dimension === 'verbosity');
  assert.equal(prof.stable, true);
  const g = kernel.behaviorGuidance();
  assert.ok(g.text.length > 0);
  // kill 后拒绝写
  kernel.killSwitch();
  assert.throws(
    () => kernel.tapBehavior({ dimension: 'verbosity', direction: 'more' }),
    (e) => e.code === 'KERNEL_KILLED'
  );
});

// 额外：BEHAVIOR_DIMENSIONS 导出形状
test('BEHAVIOR_DIMENSIONS 是受控枚举（4 维 × more/less 措辞）', () => {
  const dims = Object.keys(BEHAVIOR_DIMENSIONS);
  assert.deepEqual(dims.sort(), ['detail', 'pace', 'proactivity', 'verbosity']);
  for (const d of dims) {
    assert.ok(BEHAVIOR_DIMENSIONS[d].label);
    assert.ok(BEHAVIOR_DIMENSIONS[d].more);
    assert.ok(BEHAVIOR_DIMENSIONS[d].less);
  }
});

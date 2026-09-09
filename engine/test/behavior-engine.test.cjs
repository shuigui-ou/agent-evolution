'use strict';
/**
 * 共享引擎行为贴合层测试（方向 A 增量）
 * 运行：cd engine && node --test test/*.test.cjs
 *
 * 覆盖：
 *  1. behavior fixture 装配：kernel P4、behavior 段生效（windowSize=10）
 *  2. tapBehavior({text}) 启发式解析 → 记录；无行为信号 → no_behavior_signal
 *  3. tapBehavior({dimension,direction}) 精确上报
 *  4. 积累 ≥minEvidence → behaviorGuidance 产出可注入文本（不含原文）
 *  5. behaviorProfile 只读视图
 *  6. behaviorReset（user 来源清空）
 *  7. 旧 yaml（无 behavior 段）→ 缺省参数，不报错
 *  8. 非法 behavior 段（confidence>1）→ EVOLUTION_SCHEMA_INVALID
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const engine = require('../engine.cjs');

const FIXTURES = path.join(__dirname, 'fixtures');
const BEHAVIOR_YAML = path.join(FIXTURES, 'host-behavior.yaml');
const GOOD_YAML = path.join(FIXTURES, 'host-good.yaml');

function tmpRoot(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'evbeh-' + tag + '-'));
}

// ---------------------------------------------------------------- 1. 装配
test('behavior fixture 装配：schema 通过、内核 P4、behavior 段参数生效', () => {
  const root = tmpRoot('assemble');
  const h = engine.load(BEHAVIOR_YAML, { rootDir: root });
  const m = h.meta();
  assert.equal(m.ok, true);
  assert.equal(m.agent, 'engine-behavior-host');
  assert.equal(m.tier, 'P4');
  const st = h.status();
  assert.equal(st.degraded, false);
});

// ---------------------------------------------------------------- 2. 文本启发式
test('tapBehavior({text})：启发式解析命中则记录；无信号返回 no_behavior_signal', () => {
  const root = tmpRoot('text');
  const h = engine.load(BEHAVIOR_YAML, { rootDir: root });
  const r1 = h.tapBehavior({ text: '太长了，简洁一点' });
  assert.equal(r1.ok, true);
  assert.equal(r1.recorded, true);
  assert.equal(r1.dimension, 'verbosity');
  assert.equal(r1.direction, 'less');
  // 无行为信号
  const r2 = h.tapBehavior({ text: '今天的天气如何' });
  assert.equal(r2.ok, false);
  assert.equal(r2.reason, 'no_behavior_signal');
  // 空输入
  const r3 = h.tapBehavior({});
  assert.equal(r3.ok, false);
});

// ---------------------------------------------------------------- 3. 精确上报
test('tapBehavior({dimension,direction})：精确上报直接记录', () => {
  const root = tmpRoot('exact');
  const h = engine.load(BEHAVIOR_YAML, { rootDir: root });
  const r = h.tapBehavior({ dimension: 'pace', direction: 'less', text: '直接给结果' });
  assert.equal(r.ok, true);
  assert.equal(r.recorded, true);
  assert.equal(r.dimension, 'pace');
  // 非法维度 → kernel_error（不抛，fail-open）
  const bad = h.tapBehavior({ dimension: 'color', direction: 'less' });
  assert.equal(bad.ok, false);
});

// ---------------------------------------------------------------- 4. guidance
test('积累 ≥minEvidence → behaviorGuidance 产出模板文本（不含原文）', () => {
  const root = tmpRoot('guide');
  const h = engine.load(BEHAVIOR_YAML, { rootDir: root }); // minEvidence=2
  h.tapBehavior({ text: '太长了，精简' });
  h.tapBehavior({ text: '别啰嗦，说重点' });
  const g = h.behaviorGuidance();
  assert.equal(g.ok, true);
  assert.equal(g.active.length, 1);
  assert.ok(g.text.includes('输出篇幅'));
  assert.ok(!g.text.includes('太长了')); // 模板不拼原文
  assert.ok(!g.text.includes('别啰嗦'));
});

// ---------------------------------------------------------------- 5. profile
test('behaviorProfile：只读视图含全部受控维度', () => {
  const root = tmpRoot('prof');
  const h = engine.load(BEHAVIOR_YAML, { rootDir: root });
  h.tapBehavior({ text: '直接给结果' });
  const p = h.behaviorProfile();
  assert.equal(p.ok, true);
  const dims = p.profile.map((x) => x.dimension).sort();
  assert.deepEqual(dims, ['detail', 'pace', 'proactivity', 'verbosity']);
  const pace = p.profile.find((x) => x.dimension === 'pace');
  assert.equal(pace.direction, 'less');
});

// ---------------------------------------------------------------- 6. reset
test('behaviorReset：user 来源清空后 guidance 归零', () => {
  const root = tmpRoot('reset');
  const h = engine.load(BEHAVIOR_YAML, { rootDir: root });
  h.tapBehavior({ text: '太长了' });
  h.tapBehavior({ text: '啰嗦' });
  assert.equal(h.behaviorGuidance().active.length, 1);
  const r = h.behaviorReset('verbosity', { source: 'user' });
  assert.equal(r.ok, true);
  assert.equal(r.removed, 2);
  assert.equal(h.behaviorGuidance().active.length, 0);
});

// ---------------------------------------------------------------- 7. 旧 yaml 兼容
test('旧 yaml（无 behavior 段）→ 缺省参数装配，不报错', () => {
  const root = tmpRoot('legacy');
  const h = engine.load(GOOD_YAML, { rootDir: root });
  assert.equal(h.meta().ok, true);
  // behavior 方法仍可用（缺省 windowSize=20/minEvidence=3/confidence=0.6）
  const p = h.behaviorProfile();
  assert.equal(p.ok, true);
  assert.equal(p.profile.length, 4);
  // 缺省阈值下 1 次纠偏不形成稳定偏好
  h.tapBehavior({ text: '太长了' });
  assert.equal(h.behaviorGuidance().active.length, 0);
});

// ---------------------------------------------------------------- 8. schema 非法
test('behavior.confidence>1 → EVOLUTION_SCHEMA_INVALID', () => {
  assert.throws(
    () => engine.load(
      {
        schema: 1,
        meta: { agent: 'x' },
        knowledge: { root: 'k', whitelist: ['a.jsonl'] },
        behavior: { confidence: 1.5 },
      },
      { rootDir: tmpRoot('badconf') }
    ),
    (e) => e && e.code === 'EVOLUTION_SCHEMA_INVALID'
  );
});

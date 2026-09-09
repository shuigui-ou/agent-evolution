'use strict';
/**
 * 出口选择环（服役考核）engine 层验证：
 * 走真实 handle（engine.load + host-verifier.yaml），证明闭环能力对宿主零新增代码可用——
 * 宿主只照常 tapBehavior/behaviorGuidance（方向 A 既有接法），自动考核由内核完成；
 * reportOutcome/outcomeStatus/outcomeSummary/revokeOutcome 是可选增强入口。
 *
 * 运行：cd engine && node --test test/*.test.cjs
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const engine = require('../engine.cjs');

const FIXTURES = path.join(__dirname, 'fixtures');
const VERIFIER_YAML = path.join(FIXTURES, 'host-verifier.yaml');

function tmpRoot(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'evout-' + tag + '-'));
}

// ---------------------------------------------------------------- 1. verifier 域 behavior 闭环（自动考核零宿主代码）
test('verifier 域闭环：同对纠偏反复 → auto refute → decayed 停注 → retired；指引排除；revoke 复活', () => {
  const root = tmpRoot('vbeh');
  const h = engine.load(VERIFIER_YAML, { rootDir: root });
  assert.equal(h.meta().ok, true);

  // 形成稳定偏好并签发（宿主照常调用，无需新增代码）
  h.tapBehavior({ dimension: 'verbosity', direction: 'less' });
  h.tapBehavior({ dimension: 'verbosity', direction: 'less' });
  let g = h.behaviorGuidance();
  assert.equal(g.active.length, 1);
  assert.equal(g.active[0].key, 'verbosity:less');

  // 同对再犯 #1 → auto refuted(1)
  h.tapBehavior({ dimension: 'verbosity', direction: 'less' });
  let st = h.outcomeStatus({ lane: 'behavior', key: 'verbosity:less' });
  assert.equal(st.ok, true);
  assert.equal(st.status, 'active');
  assert.equal(st.refuted, 1);

  // 重新签发后同对再犯 #2 → decayed（指引排除 → 不再唠叨）
  h.behaviorGuidance();
  h.tapBehavior({ dimension: 'verbosity', direction: 'less' });
  st = h.outcomeStatus({ lane: 'behavior', key: 'verbosity:less' });
  assert.equal(st.status, 'decayed');
  g = h.behaviorGuidance();
  assert.equal(g.active.length, 0);

  // 冷却期再犯 #3 → retired
  h.tapBehavior({ dimension: 'verbosity', direction: 'less' });
  st = h.outcomeStatus({ lane: 'behavior', key: 'verbosity:less' });
  assert.equal(st.status, 'retired');
  assert.equal(st.refuted, 3);
  assert.equal(h.behaviorGuidance().active.length, 0);

  // 汇总可见 retired
  const sum = h.outcomeSummary();
  assert.equal(sum.ok, true);
  assert.equal(sum.behavior.byStatus.retired, 1);

  // revoke（user 来源）复活 → 指引恢复
  const rv = h.revokeOutcome({ lane: 'behavior', key: 'verbosity:less' });
  assert.equal(rv.ok, true);
  assert.equal(rv.state.status, 'active');
  assert.equal(h.behaviorGuidance().active.length, 1);
});

// ---------------------------------------------------------------- 2. experience lane 显式考核（可选增强）经 handle
test('experience lane：reportOutcome confirmed×3 → strengthened；outcomeStatus/outcomeSummary 一致', () => {
  const root = tmpRoot('vexp');
  const h = engine.load(VERIFIER_YAML, { rootDir: root });
  for (let i = 0; i < 3; i++) {
    const r = h.reportOutcome({ lane: 'experience', key: 'exp-1', verdict: 'confirmed', source: 'host' });
    assert.equal(r.ok, true);
  }
  const st = h.outcomeStatus({ lane: 'experience', key: 'exp-1' });
  assert.equal(st.ok, true);
  assert.equal(st.status, 'strengthened');
  assert.equal(st.confirmed, 3);
  // 非法 verdict → ok:false（fail-open，不抛）
  const bad = h.reportOutcome({ lane: 'experience', key: 'exp-1', verdict: 'maybe' });
  assert.equal(bad.ok, false);
  const sum = h.outcomeSummary();
  assert.equal(sum.experience.byStatus.strengthened, 1);
});

// ---------------------------------------------------------------- 3. revoke 权限：非 user 来源被拒（behavior lane 由内核硬校验）
test('revokeOutcome 仅 user 来源可用（T4 精神：考核复活不授予 agent）', () => {
  const root = tmpRoot('vrev');
  const h = engine.load(VERIFIER_YAML, { rootDir: root });
  h.reportOutcome({ lane: 'experience', key: 'exp-x', verdict: 'refuted', source: 'auto' });
  h.reportOutcome({ lane: 'experience', key: 'exp-x', verdict: 'refuted', source: 'auto' });
  h.reportOutcome({ lane: 'experience', key: 'exp-x', verdict: 'refuted', source: 'auto' });
  assert.equal(h.outcomeStatus({ lane: 'experience', key: 'exp-x' }).status, 'retired');
  // 内核 revokeOutcome 只接受 user 来源；engine 不暴露 source 参数（默认 user）→ 校验行为可控
  const r = h.revokeOutcome({ lane: 'experience', key: 'exp-x' });
  assert.equal(r.ok, true);
  assert.equal(r.state.status, 'active');
  assert.equal(r.state.refuted, 0);
});

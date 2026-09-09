'use strict';
/**
 * 跨域通用性验证（方向 B）：同一份 engine 代码装配两个不同域宿主，
 * behavior 账本机制域无关 —— 各域独立 dataDir、独立 tap、独立 profile/guidance，互不污染。
 *
 * 域 A（novel/创作）：host-behavior.yaml —— 创作纠偏文本启发式（方向 A 既有）
 * 域 B（verifier/验证）：host-verifier.yaml —— software-verifier 域语义副本，
 *   只走「受控通道」tapBehavior({dimension,direction})（绕过文本解析词表），
 *   模拟用户对验证报告的结构化反馈。
 *
 * 判定通用性成立的标准：
 *   1) 域 B 能以受控通道记录信号并形成稳定偏好（minEvidence 达标 → guidance 可注入）
 *   2) 域 A 与域 B 同进程并存，profile/guidance 各自独立（dataDir 隔离 → 账本不串）
 *   3) 域 B 的 guidance 同样为模板文本、不含原文、审计可验证 —— 与域 A 完全同构
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
const NOVEL_YAML = path.join(FIXTURES, 'host-behavior.yaml');
const VERIFIER_YAML = path.join(FIXTURES, 'host-verifier.yaml');

function tmpRoot(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'evdom-' + tag + '-'));
}

// verifier 域信号映射表（report feedback → 受控维度）：
//   "报告太长了" / "只保留结论"            → { verbosity, less }
//   "每个失败附复现步骤与截图证据"        → { detail, more }
//   "验证步骤先逐步确认再执行"            → { pace, more }
//   "别自作主张改被测软件，只报告"        → { proactivity, less }
const VERIFIER_SIGNALS = [
  { dimension: 'verbosity', direction: 'less', text: '报告太长' },
  { dimension: 'verbosity', direction: 'less', text: '太长不看' },
  { dimension: 'verbosity', direction: 'less', text: '只看关键失败' },
];

// ---------------------------------------------------------------- 1. 域 B 受控通道形成偏好
test('域B(verifier) 受控通道 tap → 积累形成稳定偏好 → guidance 可注入', () => {
  const root = tmpRoot('verifier');
  const h = engine.load(VERIFIER_YAML, { rootDir: root }); // minEvidence=2
  assert.equal(h.meta().ok, true);
  assert.equal(h.meta().agent, 'software-verifier');
  assert.equal(h.meta().tier, 'P4');

  // 逐条喂 verifier 域结构化反馈（受控通道，不走文本解析）
  for (const s of VERIFIER_SIGNALS) {
    const r = h.tapBehavior(s);
    assert.equal(r.ok, true);
    assert.equal(r.recorded, true);
    assert.equal(r.dimension, 'verbosity');
    assert.equal(r.direction, 'less');
  }
  const g = h.behaviorGuidance();
  assert.equal(g.ok, true);
  assert.equal(g.active.length, 1);
  assert.equal(g.active[0].dimension, 'verbosity');
  assert.equal(g.active[0].direction, 'less');
  assert.ok(g.text.includes('输出篇幅')); // 模板措辞
  assert.ok(!g.text.includes('报告太长')); // 不含原文
});

// ---------------------------------------------------------------- 2. 双域并存互不污染
test('域A(novel) 与 域B(verifier) 同进程并存：dataDir 隔离、账本不串', () => {
  const rootA = tmpRoot('novel');
  const rootB = tmpRoot('verifier2');
  const hA = engine.load(NOVEL_YAML, { rootDir: rootA });   // minEvidence=2
  const hB = engine.load(VERIFIER_YAML, { rootDir: rootB }); // minEvidence=2

  // 双域都走受控通道（排除文本启发式拆维干扰，纯验证账本隔离）：
  // 域 A：创作偏好 verbosity: more（与域 B 的 less 相反）
  hA.tapBehavior({ dimension: 'verbosity', direction: 'more' });
  hA.tapBehavior({ dimension: 'verbosity', direction: 'more' });
  // 域 B：验证报告反馈 verbosity: less
  hB.tapBehavior({ dimension: 'verbosity', direction: 'less' });
  hB.tapBehavior({ dimension: 'verbosity', direction: 'less' });

  // 域 A guidance：more（不受域 B 影响）
  const gA = hA.behaviorGuidance();
  assert.equal(gA.active.length, 1);
  assert.equal(gA.active[0].dimension, 'verbosity');
  assert.equal(gA.active[0].direction, 'more');
  // 域 B guidance：less（不受域 A 影响）
  const gB = hB.behaviorGuidance();
  assert.equal(gB.active.length, 1);
  assert.equal(gB.active[0].direction, 'less');

  // profile 各自独立
  const pA = hA.behaviorProfile().profile.find((x) => x.dimension === 'verbosity');
  const pB = hB.behaviorProfile().profile.find((x) => x.dimension === 'verbosity');
  assert.equal(pA.direction, 'more');
  assert.equal(pB.direction, 'less');
  // dataDir 物理隔离：审计链各自可验证
  assert.equal(hA.verifyAudit().ok, true);
  assert.equal(hB.verifyAudit().ok, true);
});

// ---------------------------------------------------------------- 3. 域 B 缺省参数兼容（真实 Host B 契约形态）
test('域B 不声明 behavior 段（真实 software-verifier evolution.yaml 现状）→ 缺省 minEvidence=3，受控通道仍可用', () => {
  // 真实 Host B 契约（~/.workbuddy/skills/software-verifier/evolution.yaml）无 behavior 段；
  // engine 以缺省参数装配（windowSize=20/minEvidence=3/confidence=0.6）。
  const root = tmpRoot('nobeh');
  const h = engine.load({
    schema: 1,
    meta: { agent: 'software-verifier', version: '0.1.0' },
    kernel: { dataDir: 'data/evolution', level: 'auto_report', audit: true, dailyLimit: 20, primitives: ['tap', 'pre_action', 'interrupt', 'write', 'checkpoint', 'audit'], enabled: true },
    knowledge: { root: 'data/evolution/knowledge', whitelist: ['pitfalls.json', 'learnings.jsonl'] },
    objectives: [{ title: '压制验证失败复现率', types: ['E'], weight: 5 }],
  }, { rootDir: root });
  assert.equal(h.meta().ok, true);
  const p = h.behaviorProfile();
  assert.equal(p.profile.length, 4); // 4 维仍齐

  // 缺省 minEvidence=3：2 条不足 → 无 stable；3 条 → stable
  h.tapBehavior({ dimension: 'detail', direction: 'more' });
  h.tapBehavior({ dimension: 'detail', direction: 'more' });
  assert.equal(h.behaviorGuidance().active.length, 0);
  h.tapBehavior({ dimension: 'detail', direction: 'more' });
  const g = h.behaviorGuidance();
  assert.equal(g.active.length, 1);
  assert.equal(g.active[0].dimension, 'detail');
});

// ---------------------------------------------------------------- 4. 审计链：域 B 的 tap 全部入链
test('域B 受控通道 tap 均入审计链（BEHAVIOR_TAPPED），链可验证', () => {
  const root = tmpRoot('audit');
  const h = engine.load(VERIFIER_YAML, { rootDir: root });
  for (const s of VERIFIER_SIGNALS.slice(0, 2)) h.tapBehavior(s);
  const tail = h.getAuditTail(10);
  const taps = tail.records.filter((r) => r.type === 'BEHAVIOR_TAPPED');
  assert.ok(taps.length >= 2);
  assert.equal(h.verifyAudit().ok, true);
});

'use strict';
/**
 * 出口选择环（服役考核）专项测试：条目从 append-only 变成有差分存活。
 *
 * 覆盖用户拍板的三条语义：
 *   A. 全自动推导为主：refuted/confirmed 由事件流自动判定（签发后同因再犯 / 冷却期继续犯 /
 *      异维生存），宿主显式上报只是可选增强。
 *   B. 归档可复活：retired 不物理删除（审计/账本仍在），revoke 回 active 且计数清零。
 *   C. verifier 域闭环证据：经验层"注入 → 同 fp 再犯 → refuted → decayed → retired →
 *      注入面停用"，behavior 层"指引签发 → 同对再犯 → 衰减/停用 → 指引排除"。
 *
 * 运行：cd kernel && node --test test/*.test.cjs
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
  createKernel,
  createBehaviorLedger,
  createOutcomeLedger,
  transition,
  OUTCOME_DEFAULTS,
  STATUSES,
  normalizeFingerprint,
  PRIMITIVES,
} = require('../src/index.cjs');
const { makeTmpDir, rmTmpDir } = require('./helpers.cjs');

// ---------------------------------------------------------------- 1. 状态机纯函数
test('transition：阈值语义（confirmed→strengthened / refuted→decayed / refuted≥3→retired / revoke 后从 active 重算）', () => {
  assert.equal(transition('active', { confirmed: 0, refuted: 0 }), 'active');
  assert.equal(transition('active', { confirmed: 3, refuted: 0 }), 'strengthened');
  assert.equal(transition('active', { confirmed: 2, refuted: 2 }), 'active'); // 平票不迁移
  assert.equal(transition('active', { confirmed: 0, refuted: 2 }), 'decayed');
  assert.equal(transition('decayed', { confirmed: 0, refuted: 3 }), 'retired'); // 冷却期累计
  assert.equal(transition('decayed', { confirmed: 3, refuted: 0 }), 'strengthened'); // 证伪后证实可恢复
  assert.equal(transition('strengthened', { confirmed: 2, refuted: 3 }), 'retired'); // 强化态仍可被证伪压倒
  assert.equal(transition('strengthened', { confirmed: 4, refuted: 3 }), 'strengthened'); // 未压倒则保持
  assert.equal(transition('retired', { confirmed: 9, refuted: 0 }), 'retired'); // retired 不自动回
  assert.ok(STATUSES.includes('retired'));
  assert.equal(OUTCOME_DEFAULTS.refuteToRetire, 3);
});

// ---------------------------------------------------------------- 2. outcome 账本基本读写 + revoke
test('outcome 账本：confirmed×3 → strengthened；revoke 清零回 active；revoke 仅限 user', () => {
  const dir = makeTmpDir('out');
  const ledger = createOutcomeLedger({ dataDir: dir, lane: 'test-lane' });
  assert.equal(ledger.stateOf('x').status, 'active');
  ledger.record('x', 'confirmed', { source: 'host' });
  ledger.record('x', 'confirmed', { source: 'host' });
  let s = ledger.stateOf('x');
  assert.equal(s.status, 'active');
  assert.equal(s.confirmed, 2);
  ledger.record('x', 'confirmed', { source: 'host' });
  s = ledger.stateOf('x');
  assert.equal(s.status, 'strengthened');
  // 持久化：重开账本仍能重放
  const ledger2 = createOutcomeLedger({ dataDir: dir, lane: 'test-lane' });
  assert.equal(ledger2.stateOf('x').status, 'strengthened');
  // revoke 仅限 user
  assert.throws(() => ledger2.revoke('x', { source: 'agent' }));
  const r = ledger2.revoke('x', { source: 'user' });
  assert.equal(r.state.status, 'active');
  assert.equal(r.state.confirmed, 0);
  assert.equal(ledger2.stateOf('x').confirmed, 0);
  rmTmpDir(dir);
});

// ---------------------------------------------------------------- 3. 自定义阈值（outcome 段透传到 experience lane）
test('自定义阈值：confirmToStrengthen=1 → 1 次 confirmed 即 strengthened（账本级 + kernel 装配级）', () => {
  const dir = makeTmpDir('outth');
  // 账本级：createOutcomeLedger 直接传 thresholds
  const ledger = createOutcomeLedger({
    dataDir: dir,
    lane: 'test-th',
    thresholds: { confirmToStrengthen: 1, refuteToDecay: 2, refuteToRetire: 3 },
  });
  assert.equal(ledger.stateOf('x').status, 'active');
  ledger.record('x', 'confirmed', { source: 'host' });
  let s = ledger.stateOf('x');
  assert.equal(s.status, 'strengthened');
  assert.equal(s.confirmed, 1);
  // 持久化重放同样按新阈值
  const ledger2 = createOutcomeLedger({ dataDir: dir, lane: 'test-th', thresholds: { confirmToStrengthen: 1 } });
  assert.equal(ledger2.stateOf('x').status, 'strengthened');
  rmTmpDir(dir);

  // kernel 装配级：createKernel({outcome}) → reportOutcome 透传生效
  const root = makeTmpDir('ekth');
  const k = createKernel({
    dataDir: path.join(root, 'runtime'),
    host: { agentId: 't', primitives: PRIMITIVES.slice() },
    knowledgeSurface: { root: path.join(root, 'k'), whitelist: ['learnings.jsonl'] },
    objectives: [],
    level: 'auto_report',
    outcome: { confirmToStrengthen: 1, refuteToDecay: 2, refuteToRetire: 3 },
  });
  k.reportOutcome({ lane: 'experience', key: 'exp-fast', verdict: 'confirmed', source: 'host' });
  const st = k.outcomeStatus({ lane: 'experience', key: 'exp-fast' });
  assert.equal(st.status, 'strengthened');
  assert.equal(st.confirmed, 1);
  rmTmpDir(root);
});

// ---------------------------------------------------------------- 4. behavior 闭环：同对再犯 → decayed → retired → 指引排除 → revoke 复活
test('behavior 出口闭环：指引签发 → 同对再犯 refute → decayed 停注 → 冷却期继续犯 → retired → 指引排除；revoke 后恢复', () => {
  const dir = makeTmpDir('bcl');
  const ledger = createBehaviorLedger({
    dataDir: dir,
    windowSize: 20,
    minEvidence: 1,
    confidence: 0.5,
    survivalWindow: 99, // 屏蔽生存确认，纯走 refute 路径
  });
  // 1 条 less 即稳定
  ledger.record({ dimension: 'verbosity', direction: 'less', text: '太长' });
  let g = ledger.guidance();
  assert.equal(g.active.length, 1);
  assert.equal(g.active[0].key, 'verbosity:less');
  // 同对再犯 #1 → refute(1)（签发后注入没拦住）
  let r = ledger.record({ dimension: 'verbosity', direction: 'less', text: '还是太长' });
  assert.equal(r.outcome, 'refuted');
  // 重新签发（现实：每个任务开始会再取一次 guidance）
  ledger.guidance();
  // 同对再犯 #2 → refute(2) → decayed（停注：指引随即排除）
  ledger.record({ dimension: 'verbosity', direction: 'less', text: '依然太长' });
  let st = ledger.pairStates().find((x) => x.key === 'verbosity:less');
  assert.equal(st.status, 'decayed');
  assert.equal(st.refuted, 2);
  g = ledger.guidance();
  assert.equal(g.active.length, 0); // decayed 不进指引（防唠叨）
  // 冷却期同对再犯 #3 → retired
  ledger.record({ dimension: 'verbosity', direction: 'less', text: '还是啰嗦' });
  st = ledger.pairStates().find((x) => x.key === 'verbosity:less');
  assert.equal(st.status, 'retired');
  assert.equal(st.refuted, 3);
  assert.equal(ledger.guidance().active.length, 0); // retired 更不进
  // revoke 复活 → 重新服役
  ledger.revokePair('verbosity', 'less');
  st = ledger.pairStates().find((x) => x.key === 'verbosity:less');
  assert.equal(st.status, 'active');
  assert.equal(st.confirmed, 0);
  g = ledger.guidance();
  assert.equal(g.active.length, 1); // 复活后可再次注入
  rmTmpDir(dir);
});

// ---------------------------------------------------------------- 4. behavior 生存确认（异维纠偏无同对再犯 → confirmed）
test('behavior 生存确认：签发后连续异维纠偏无同对再犯 → auto confirmed', () => {
  const dir = makeTmpDir('bsurv');
  const ledger = createBehaviorLedger({
    dataDir: dir,
    windowSize: 20,
    minEvidence: 1,
    confidence: 0.5,
    survivalWindow: 2,
  });
  ledger.record({ dimension: 'verbosity', direction: 'less', text: '太长' });
  ledger.guidance(); // 签发 verbosity:less
  // 1 条异维纠偏：存活 1/2 未达标 → 尚无 outcome 行
  ledger.record({ dimension: 'detail', direction: 'more', text: '给依据' });
  assert.ok(!ledger.pairStates().some((x) => x.key === 'verbosity:less'));
  // 第 2 条异维纠偏：存活 2/2 达标 → auto confirmed(1)
  ledger.record({ dimension: 'pace', direction: 'less', text: '直接给' });
  const st = ledger.pairStates().find((x) => x.key === 'verbosity:less');
  assert.equal(st.confirmed, 1);
  assert.equal(st.status, 'active');
  rmTmpDir(dir);
});

// ---------------------------------------------------------------- 5. 经验层闭环（verifier 域证据）：注入 → 同 fp 再犯 → retired → 注入停用
test('经验层闭环：preAction 签发 → 同 fp 错误再犯 → auto refute → decayed → retired → preAction 停用（不物理删）', async () => {
  const root = makeTmpDir('ekexp');
  const dataDir = path.join(root, 'runtime');
  const surface = path.join(root, 'knowledge');
  fs.mkdirSync(surface, { recursive: true });
  const payload = { action: 'verify', code: 'ERR_FETCH' };
  const fp = normalizeFingerprint(JSON.stringify(payload));
  // 预置一条 active 经验（模拟种子经 auto_report 落地的 learnings.jsonl 行）
  fs.writeFileSync(
    path.join(surface, 'learnings.jsonl'),
    JSON.stringify({ experience_id: 'exp-fetch', fingerprint: fp, content: 'fetch 失败先检查网络代理再重试', status: 'active' }) + '\n',
    'utf8'
  );
  const k = createKernel({
    dataDir,
    host: { agentId: 'verifier-test', primitives: PRIMITIVES.slice() },
    knowledgeSurface: { root: surface, whitelist: ['learnings.jsonl'] },
    objectives: [],
    level: 'auto_report',
  });
  assert.equal(await k.loadExperiences(), 1);

  // 注入 #1 → 再犯 → refute(1)（仍 active，未到衰减阈值）
  assert.equal(k.preAction({ payload }).kind, 'inject_guidance');
  k.tap({ kind: 'error', payload: { message: 'fetch failed', detail: '', fingerprint: fp }, task_id: 't1' });
  let st = k.outcomeStatus({ lane: 'experience', key: 'exp-fetch' });
  assert.equal(st.status, 'active');
  assert.equal(st.refuted, 1);

  // 注入 #2 → 再犯 → refute(2) → decayed
  assert.equal(k.preAction({ payload }).kind, 'inject_guidance');
  k.tap({ kind: 'error', payload: { message: 'fetch failed', detail: '', fingerprint: fp }, task_id: 't2' });
  st = k.outcomeStatus({ lane: 'experience', key: 'exp-fetch' });
  assert.equal(st.status, 'decayed');

  // decayed：注入面停用（preAction 返回 null），但保留计数；再犯 → retired
  assert.equal(k.preAction({ payload }), null);
  k.tap({ kind: 'error', payload: { message: 'fetch failed', detail: '', fingerprint: fp }, task_id: 't3' });
  st = k.outcomeStatus({ lane: 'experience', key: 'exp-fetch' });
  assert.equal(st.status, 'retired');
  assert.equal(st.refuted, 3);
  assert.equal(k.preAction({ payload }), null); // retired 不再注入
  // 汇总可见 retired
  const sum = k.outcomeSummary();
  assert.equal(sum.experience.byStatus.retired, 1);
  rmTmpDir(root);
});

// ---------------------------------------------------------------- 6. 显式上报（可选增强）：confirm×3 → strengthened
test('reportOutcome 显式上报（可选增强）：confirmed 累积 → strengthened', () => {
  const root = makeTmpDir('ekconf');
  const k = createKernel({
    dataDir: path.join(root, 'runtime'),
    host: { agentId: 't', primitives: PRIMITIVES.slice() },
    knowledgeSurface: { root: path.join(root, 'k'), whitelist: ['learnings.jsonl'] },
    objectives: [],
    level: 'auto_report',
  });
  k.reportOutcome({ lane: 'experience', key: 'exp-ok', verdict: 'confirmed', source: 'host' });
  k.reportOutcome({ lane: 'experience', key: 'exp-ok', verdict: 'confirmed', source: 'host' });
  assert.equal(k.outcomeStatus({ lane: 'experience', key: 'exp-ok' }).status, 'active');
  k.reportOutcome({ lane: 'experience', key: 'exp-ok', verdict: 'confirmed', source: 'host' });
  assert.equal(k.outcomeStatus({ lane: 'experience', key: 'exp-ok' }).status, 'strengthened');
  // 非法 lane / verdict 拒绝
  assert.throws(() => k.reportOutcome({ lane: 'nope', key: 'x', verdict: 'confirmed' }));
  assert.throws(() => k.reportOutcome({ lane: 'experience', key: 'x', verdict: 'maybe' }));
  const sum = k.outcomeSummary();
  assert.equal(sum.experience.byStatus.strengthened, 1);
  rmTmpDir(root);
});

// ---------------------------------------------------------------- 8. retired 跨重启仍停用（账本重放驱动注入面过滤）
test('retired 跨重启停用：新内核同 dataDir 重放考核账本 → loadExperiences 不装载 → preAction 停用', async () => {
  const root = makeTmpDir('ekrel');
  const dataDir = path.join(root, 'runtime');
  const surface = path.join(root, 'knowledge');
  fs.mkdirSync(surface, { recursive: true });
  const fp = normalizeFingerprint(JSON.stringify({ action: 'verify' }));
  fs.writeFileSync(
    path.join(surface, 'learnings.jsonl'),
    JSON.stringify({ experience_id: 'exp-dead', fingerprint: fp, content: '旧经验', status: 'active' }) + '\n',
    'utf8'
  );
  // 第一个内核：把该经验打到 retired
  const k1 = createKernel({
    dataDir,
    host: { agentId: 't', primitives: PRIMITIVES.slice() },
    knowledgeSurface: { root: surface, whitelist: ['learnings.jsonl'] },
    objectives: [],
    level: 'auto_report',
  });
  await k1.loadExperiences();
  for (let i = 0; i < 3; i++) k1.reportOutcome({ lane: 'experience', key: 'exp-dead', verdict: 'refuted', source: 'auto' });
  assert.equal(k1.outcomeStatus({ lane: 'experience', key: 'exp-dead' }).status, 'retired');

  // 第二个内核（模拟重启）：账本重放 → retired → 不装载 → 不注入
  const k2 = createKernel({
    dataDir,
    host: { agentId: 't', primitives: PRIMITIVES.slice() },
    knowledgeSurface: { root: surface, whitelist: ['learnings.jsonl'] },
    objectives: [],
    level: 'auto_report',
  });
  await k2.loadExperiences();
  assert.equal(k2.preAction({ payload: { action: 'verify' } }), null);
  assert.equal(k2.outcomeStatus({ lane: 'experience', key: 'exp-dead' }).status, 'retired');
  // revoke 复活（user 来源）→ 重载后可注入
  k2.revokeOutcome({ lane: 'experience', key: 'exp-dead' });
  assert.equal(k2.outcomeStatus({ lane: 'experience', key: 'exp-dead' }).status, 'active');
  rmTmpDir(root);
});

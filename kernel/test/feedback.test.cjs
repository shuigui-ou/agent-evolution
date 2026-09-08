/**
 * feedback.test.cjs —— 否决反馈回路 + 目标对齐回路验收（K1 增量）
 *
 * 覆盖：
 *  1. reject 一次 → 否决账 + 排序下降（生效值 = expected_gain − 5×1）
 *  2. reject 两次 → 黑名单（selectTop 排除，不再进 top1）；user 复活接口生效；非 user 复活被拒
 *  3. probe suboptimal：−2 记分、不触发自动回滚、旧账本向后兼容
 *  4. 偏好学习：adopt ≥2 → 建议 +1；reject ≥2 → 建议 −1；建议不自动改目标；
 *     applySuggestion 仅 user；权重 clamp 0~10
 *  5. 分歧 ≥3（同 category）→ alignment_review 事件（进 pendingInterrupts，附分歧样本）
 *  6. 跨轮次否决跟随：同内容候选重新生成（新 CAND id、同稳定 key）→ 否决仍然生效
 *  7. interruptHandler 裁决路径：adopt/reject 自动落采纳史/否决账
 *
 * 场景数值：候选A gain 12（因子 0.8×16.25−1−0）、候选B gain 8（0.5×18−1−0）；
 * 一次否决降权 −5：A 12→7 < B 8 → 第 2 轮 top1 轮替到 B；两次否决 −10 封顶 + 黑名单。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createKernel } = require('../src/kernel.cjs');
const { createProbeLedger, SCORES } = require('../src/probe.cjs');
const { normalizeFingerprint } = require('../src/signals.cjs');
const { makeTmpDir, rmTmpDir } = require('./helpers.cjs');

const ERR_TITLE = 'AI 调用失败';
const probe = { trigger: '同 fingerprint 错误再现', judge: '行为含重试动作' };
const FACTORS_A = { success_prob: 0.8, benefit: 16.25, cost: 1, risk: 0 }; // gain 12
const FACTORS_B = { success_prob: 0.5, benefit: 18, cost: 1, risk: 0 }; // gain 8
const TITLE_A = '候选A：指数退避重试';
const TITLE_B = '候选B：切换备用模型';

/** 构建 ask 档内核：E 类信号产出两个候选 A(gain 12) / B(gain 8)，均带四因子分解 */
function buildAskKernel(tmp) {
  const knowledgeRoot = path.join(tmp, 'knowledge');
  fs.mkdirSync(knowledgeRoot, { recursive: true });
  return createKernel({
    dataDir: path.join(tmp, 'runtime'),
    host: {
      primitives: ['tap', 'pre_action', 'interrupt', 'write', 'checkpoint', 'audit'],
      agentId: 'feedback-e2e',
    },
    knowledgeSurface: { root: knowledgeRoot, whitelist: ['knowledge.jsonl'] },
    objectives: [{ title: '压制 AI 调用失败复发率 RR≤5%', types: ['E'], weight: 5 }],
    level: 'ask',
    candidateGenerator: async (group) => {
      if (group.type !== 'E') return [];
      return [
        { title: TITLE_A, content: 'AI 调用失败时先降并发，再指数退避重试', unit: 'E1', expected_gain: 12, factors: FACTORS_A, probe },
        { title: TITLE_B, content: '重试仍失败则切换备用模型', unit: 'E3', expected_gain: 8, factors: FACTORS_B, probe },
      ];
    },
  });
}

/** 走一轮：tap 错误 → analyze（ask 挂起）→ 返回批量挂起队列里最新的 top1 询问 */
async function cycleToAsk(kernel, detail) {
  assert.equal(kernel.tap({ kind: 'error', payload: { message: ERR_TITLE, detail }, session_id: 's1' }).accepted, true);
  const report = await kernel.analyze();
  const ask = report.decisions.find((d) => d.action === 'ask');
  assert.ok(ask, 'ask 档下应产生落地询问');
  // 批量模式：interrupt() 返回 {decision:'pending'}，原始问题（含 evidence_summary）在挂起队列
  const pending = kernel.pendingInterrupts();
  assert.ok(pending.length >= 1);
  return pending[pending.length - 1];
}

/** 从分解展示里取指定标题候选（可选要求未黑名单） */
function viewOf(kernel, fp, title, { notBlacklisted = false } = {}) {
  return kernel
    .topCandidates(fp, 20)
    .find((c) => c.title === title && (!notBlacklisted || !c.blacklisted));
}

// ---------------------------------------------------------------- 1+2+6. 否决账
test('否决反馈：reject 一次排序下降；两次黑名单；复活接口（user）与非 user 拒绝；跨轮次否决跟随', async () => {
  const tmp = makeTmpDir('feedback-veto');
  try {
    const kernel = buildAskKernel(tmp);

    // ---- 第 1 轮：top1 = 候选A（gain 12），用户给理由否决一次 ----
    const q1 = await cycleToAsk(kernel, 'timeout 30000ms');
    assert.equal(q1.evidence_summary.top1_gain, 12);
    assert.ok(q1.evidence_summary.candidate_id, '询问应带 candidate_id');
    assert.ok(q1.evidence_summary.candidate_key, '询问应带 candidate_key（跨轮次稳定）');
    assert.deepEqual(q1.evidence_summary.top1_factors, FACTORS_A, '询问应带四因子分解');
    const fp = q1.evidence_summary.fingerprint;
    const v1 = kernel.recordVeto(fp, q1.evidence_summary.candidate_id, { reason: '太慢，不要重试' });
    assert.ok(v1.id, '否决应落账');
    assert.equal(v1.reason, '太慢，不要重试');

    // 分解展示：候选A 降权 −5 → 生效值 7 < 候选B 8
    const a1 = viewOf(kernel, fp, TITLE_A);
    const b1 = viewOf(kernel, fp, TITLE_B);
    assert.equal(a1.veto_count, 1);
    assert.equal(a1.veto_downweight, -5);
    assert.equal(a1.effective_gain, 7);
    assert.equal(b1.veto_downweight, 0);
    assert.equal(a1.blacklisted, false);
    assert.deepEqual(a1.factors, FACTORS_A, '分解展示应含四因子');

    // ---- 第 2 轮：重新生成同内容候选（新 id 同 key）→ 否决跟随 → top1 轮替成候选B ----
    const q2 = await cycleToAsk(kernel, 'timeout 45000ms');
    assert.ok(q2.title.includes('候选B'), '被否一次的候选A 生效值 7 应让位给候选B 8');
    assert.equal(q2.evidence_summary.top1_gain, 8);
    // 否决候选A 第二次（跨轮次、新 id 同 key）→ 黑名单
    const poolA2 = viewOf(kernel, fp, TITLE_A, { notBlacklisted: true });
    kernel.recordVeto(fp, poolA2.id, { reason: '重试方案整体不要' });

    // ---- 第 3 轮：候选A 黑名单 → 不得再进 top1 ----
    const q3 = await cycleToAsk(kernel, 'timeout 60000ms');
    assert.ok(q3.title.includes('候选B'), '黑名单候选A 被排除，top1 应为候选B');
    const a3 = viewOf(kernel, fp, TITLE_A);
    assert.equal(a3.blacklisted, true, '分解展示应带黑名单标记');
    assert.equal(a3.veto_count, 2);
    assert.equal(a3.veto_downweight, -10, '两次否决封顶降权 −10');
    assert.equal(kernel.subsystems.audit.listByType('VETO_BLACKLISTED').length, 1);

    // ---- 复活：非 user 来源被拒 + 审计；user 复活生效 ----
    assert.throws(
      () => kernel.reviveCandidate(fp, poolA2.id, { source: 'candidate' }),
      /FEEDBACK_FORBIDDEN/
    );
    assert.ok(kernel.subsystems.audit.listByType('VETO_REVIVE_FORBIDDEN').length >= 1);
    kernel.reviveCandidate(fp, poolA2.id, { source: 'user' });
    const a4 = viewOf(kernel, fp, TITLE_A);
    assert.equal(a4.blacklisted, false, 'user 复活后应脱离黑名单');
    assert.equal(a4.veto_count, 0, '复活后否决重新累计');
    assert.equal(a4.veto_downweight, 0);

    // 否决账 append-only 落盘 + 审计链完整（2 veto + 1 revive = 3 行）
    const vetoFile = kernel.subsystems.feedback.files.vetoFile;
    assert.ok(fs.existsSync(vetoFile));
    assert.equal(fs.readFileSync(vetoFile, 'utf8').trim().split('\n').filter(Boolean).length, 3);
    assert.ok(kernel.subsystems.audit.verify().ok);
  } finally {
    rmTmpDir(tmp);
  }
});

// ---------------------------------------------------------------- 3. probe suboptimal
test('probe suboptimal：−2 记分、不计入误触发率（不回滚）、旧账本向后兼容', () => {
  const tmp = makeTmpDir('feedback-probe');
  try {
    assert.equal(SCORES.suboptimal, -2);
    const probeLedger = createProbeLedger({ dataDir: tmp });

    // 旧账本向后兼容：手工预置一条不含 suboptimal 的历史记录后可正常读取统计
    const legacy = {
      id: 'PRB-legacy', experience_id: 'EXP-old', outcome: 'hit_solved', score: 5,
      effective: true, session_id: '', task_id: '', note: '历史记录', ts: '2026-01-01T00:00:00.000Z',
    };
    fs.mkdirSync(path.join(tmp, 'probe'), { recursive: true });
    fs.appendFileSync(probeLedger.file, JSON.stringify(legacy) + '\n', 'utf8');
    const reloaded = createProbeLedger({ dataDir: tmp });
    assert.equal(reloaded.stats('EXP-old').written.score, 5, '旧账本（无 suboptimal）可读');

    // suboptimal 记分 −2
    const rec = probeLedger.record('EXP-1', 'suboptimal', { note: '错误解决了但用户标记非最优' });
    assert.equal(rec.score, -2);
    assert.equal(rec.effective, false);
    assert.equal(probeLedger.stats('EXP-1').written.byOutcome.suboptimal, 1);

    // suboptimal 不计入误触发率：3 条 suboptimal + 0 false_trigger → 0（不会触发自动回滚）
    probeLedger.record('EXP-2', 'suboptimal', {});
    probeLedger.record('EXP-2', 'suboptimal', {});
    probeLedger.record('EXP-2', 'suboptimal', {});
    assert.equal(probeLedger.falseTriggerRate('EXP-2'), 0);
    assert.equal(probeLedger.stats('EXP-2').written.score, -6);
  } finally {
    rmTmpDir(tmp);
  }
});

// ---------------------------------------------------------------- 4. 偏好学习
test('偏好学习：adopt≥2 建议+1 / reject≥2 建议−1；不自动改目标；applySuggestion 仅 user；权重 clamp', async () => {
  const tmp = makeTmpDir('feedback-pref');
  try {
    const kernel = buildAskKernel(tmp);
    const objId = kernel.subsystems.objectiveStack.list()[0].id;
    assert.equal(kernel.subsystems.objectiveStack.list()[0].weight, 5);

    // 两次 adopt 候选A（同 category E / unit E1）
    const q1 = await cycleToAsk(kernel, 'timeout 31000ms');
    const fp = q1.evidence_summary.fingerprint;
    const candAId = q1.evidence_summary.candidate_id;
    kernel.recordAdoption(fp, candAId);
    assert.equal(kernel.preferenceSuggestions().length, 0, '1 次 adopt 不产出建议');
    kernel.recordAdoption(fp, candAId);
    const ups = kernel.preferenceSuggestions().filter((s) => s.kind === 'weight_up');
    assert.equal(ups.length, 1, 'adopt ≥2 → 产出 +1 建议');
    assert.equal(ups[0].delta, 1);
    assert.equal(ups[0].objective_id, objId, '建议应映射到 E 类 objective');
    assert.ok(ups[0].basis.includes('采纳'), '建议应含"从什么行为推断"说明');
    assert.equal(kernel.subsystems.objectiveStack.list()[0].weight, 5, '建议不得自动改目标');
    assert.ok(kernel.subsystems.audit.listByType('PREFERENCE_SUGGESTED').length >= 1);

    // 应用建议：非 user 被拒；user 应用 → 权重 6，审计 SUGGESTION_APPLIED
    assert.throws(() => kernel.applySuggestion(ups[0].id, { source: 'external' }), /OBJECTIVE_SOURCE_FORBIDDEN/);
    const applied = kernel.applySuggestion(ups[0].id, { source: 'user' });
    assert.equal(applied.weight, 6);
    assert.equal(kernel.subsystems.objectiveStack.list()[0].weight, 6);
    assert.equal(kernel.subsystems.audit.listByType('SUGGESTION_APPLIED').length, 1);

    // 两次 reject 候选A（E/E1）→ −1 建议
    const q2 = await cycleToAsk(kernel, 'timeout 32000ms');
    const candA2Id = q2.evidence_summary.candidate_id; // 重新生成的同内容候选，同 key
    kernel.recordVeto(fp, candA2Id, { reason: '重试不要' });
    kernel.recordVeto(fp, candA2Id, { reason: '重试还是不要' });
    const downs = kernel.preferenceSuggestions().filter((s) => s.kind === 'weight_down');
    assert.equal(downs.length, 1, 'reject ≥2 → 产出 −1 建议');
    assert.equal(downs[0].delta, -1);
    assert.equal(downs[0].objective_id, objId);

    // clamp 下限：先把权重压到 1，应用 −1 → 0；再造 −1 建议 → clamp 仍为 0
    kernel.updateObjective(objId, { weight: 1 });
    const applied2 = kernel.applySuggestion(downs[0].id, { source: 'user' });
    assert.equal(applied2.weight, 0, '应用 −1 后到 0');
    kernel.recordVeto(fp, candA2Id, { reason: '第三次否决' });
    kernel.recordVeto(fp, candA2Id, { reason: '第四次否决' });
    const downs2 = kernel.preferenceSuggestions().filter((s) => s.kind === 'weight_down' && s.basis_counts.reject === 4);
    assert.equal(downs2.length, 1, 'reject 里程碑 4 应再产出一条 −1 建议');
    const applied3 = kernel.applySuggestion(downs2[0].id, { source: 'user' });
    assert.equal(applied3.weight, 0, '权重下限 clamp 为 0');

    // 上限 clamp：权重压到 10 后再应用 +1 建议 → clamp 为 10
    kernel.updateObjective(objId, { weight: 10 });
    const applied4 = kernel.applySuggestion(ups[0].id, { source: 'user' });
    assert.equal(applied4.weight, 10, '权重上限 clamp 为 10');
    assert.ok(kernel.subsystems.audit.verify().ok);
  } finally {
    rmTmpDir(tmp);
  }
});

// ---------------------------------------------------------------- 5. 分歧 / alignment_review
test('分歧计数：同 category 分歧 ≥3 → alignment_review 进 pendingInterrupts（附分歧样本）', async () => {
  const tmp = makeTmpDir('feedback-divergence');
  try {
    const kernel = buildAskKernel(tmp);
    const VETO_REASON = '不是我想要的';

    // R1: top1 候选A → 否决 → 分歧 1；A 生效 7
    const q1 = await cycleToAsk(kernel, 'timeout 30000ms');
    assert.ok(q1.title.includes('候选A'));
    const fp = q1.evidence_summary.fingerprint;
    kernel.recordVeto(fp, q1.evidence_summary.candidate_id, { reason: VETO_REASON });

    // R2: top1 轮替成候选B（8 > 7）→ 否决 → 分歧 2；B 生效 3
    const q2 = await cycleToAsk(kernel, 'timeout 45000ms');
    assert.ok(q2.title.includes('候选B'));
    kernel.recordVeto(fp, q2.evidence_summary.candidate_id, { reason: VETO_REASON });

    // R3: top1 轮替回候选A（7 > 3）→ 否决 → 分歧 3 → 触发第一次 alignment_review；A 黑名单
    const q3 = await cycleToAsk(kernel, 'timeout 60000ms');
    assert.ok(q3.title.includes('候选A'), '第 3 轮 top1 应回到候选A（7 > 3）');
    kernel.recordVeto(fp, q3.evidence_summary.candidate_id, { reason: VETO_REASON });

    assert.equal(kernel.divergenceSummary().E, 3, '分歧按 category 聚合');
    assert.equal(kernel.alignmentReviews().length, 1, '分歧 ≥3 触发一次 alignment_review');

    // alignment_review 进入批量挂起队列（宿主 /interrupts 视图可见）
    const review = kernel.pendingInterrupts().find((p) => p.kind === 'alignment_review');
    assert.ok(review, 'alignment_review 应出现在批量挂起队列');
    assert.ok(review.title.includes('目标对齐审查'));
    assert.equal(review.evidence_summary.divergence_count, 3);
    assert.ok(Array.isArray(review.evidence_summary.samples) && review.evidence_summary.samples.length === 3,
      '应附最近 3 条分歧样本');
    for (const s of review.evidence_summary.samples) {
      assert.ok(s.top1_candidate_id, '样本应含 top1 是什么');
      assert.ok(s.top1_title, '样本应含 top1 标题');
      assert.equal(s.user_choice, 'reject', '样本应含用户实际选择');
    }
    assert.equal(kernel.subsystems.audit.listByType('ALIGNMENT_REVIEW_EMITTED').length, 1);

    // R4: top1 候选B（A 黑名单，B 生效 3）→ 否决 → 分歧 4（不触发）；B 黑名单
    const q4 = await cycleToAsk(kernel, 'timeout 70000ms');
    assert.ok(q4.title.includes('候选B'));
    kernel.recordVeto(fp, q4.evidence_summary.candidate_id, { reason: VETO_REASON });
    assert.equal(kernel.divergenceSummary().E, 4);
    assert.equal(kernel.alignmentReviews().length, 1, '4 次分歧不触发');

    // R5: A/B 均黑名单 → user 复活候选A → top1 变回候选A；否决 → 分歧 5（不触发）
    const someA = viewOf(kernel, fp, TITLE_A);
    kernel.reviveCandidate(fp, someA.id, { source: 'user' });
    const q5 = await cycleToAsk(kernel, 'timeout 80000ms');
    assert.ok(q5.title.includes('候选A'), '复活后候选A 应回到 top1');
    kernel.recordVeto(fp, q5.evidence_summary.candidate_id, { reason: VETO_REASON });
    assert.equal(kernel.divergenceSummary().E, 5);
    assert.equal(kernel.alignmentReviews().length, 1, '5 次分歧不触发');

    // R6: 再否决候选A（复活后累计到 2 → 再次黑名单）→ 分歧 6 → 第二次 alignment_review
    const q6 = await cycleToAsk(kernel, 'timeout 85000ms');
    assert.ok(q6.title.includes('候选A'));
    kernel.recordVeto(fp, q6.evidence_summary.candidate_id, { reason: VETO_REASON });
    assert.equal(kernel.divergenceSummary().E, 6);
    assert.equal(kernel.alignmentReviews().length, 2, '6 次分歧再次触发');
    assert.ok(kernel.subsystems.audit.verify().ok);
  } finally {
    rmTmpDir(tmp);
  }
});

// ---------------------------------------------------------------- 7. 宿主裁决自动落账（interruptHandler 路径）
test('interruptHandler 裁决：adopt/reject 自动落采纳史/否决账', async () => {
  const tmp = makeTmpDir('feedback-handler');
  try {
    const knowledgeRoot = path.join(tmp, 'knowledge');
    fs.mkdirSync(knowledgeRoot, { recursive: true });
    const decisions = [];
    const kernel = createKernel({
      dataDir: path.join(tmp, 'runtime'),
      host: {
        primitives: ['tap', 'pre_action', 'interrupt', 'write', 'checkpoint', 'audit'],
        interruptHandler: async (question) => {
          decisions.push(question);
          return decisions.length === 1 ? 'reject' : 'adopt';
        },
      },
      knowledgeSurface: { root: knowledgeRoot, whitelist: ['knowledge.jsonl'] },
      objectives: [{ title: '压制 AI 调用失败复发率 RR≤5%', types: ['E'], weight: 5 }],
      level: 'ask', // ask 档：落地询问走 interruptHandler 裁决路径
      candidateGenerator: async (group) => (group.type === 'E'
        ? [{ title: TITLE_A, content: '重试', unit: 'E1', expected_gain: 7, factors: FACTORS_A, probe }]
        : []),
    });
    assert.equal(kernel.tap({ kind: 'error', payload: { message: ERR_TITLE, detail: 'timeout 1ms' } }).accepted, true);
    const rep1 = await kernel.analyze();
    const ask1 = rep1.decisions.find((d) => d.action === 'ask');
    await ask1.decision; // 等 interruptHandler 裁决完成（reject → 否决账）
    assert.equal(kernel.subsystems.feedback.listVetoes().filter((v) => v.kind === 'veto').length, 1,
      '宿主 handler reject 应自动落否决账');
    assert.equal(kernel.subsystems.audit.listByType('VETO_RECORDED').length, 1);

    assert.equal(kernel.tap({ kind: 'error', payload: { message: ERR_TITLE, detail: 'timeout 2ms' } }).accepted, true);
    const rep2 = await kernel.analyze();
    const ask2 = rep2.decisions.find((d) => d.action === 'ask');
    await ask2.decision; // adopt → 采纳史
    assert.equal(kernel.subsystems.feedback.listAdoptions().length, 1, '宿主 handler adopt 应自动落采纳史');
    assert.ok(kernel.subsystems.audit.verify().ok);
  } finally {
    rmTmpDir(tmp);
  }
});

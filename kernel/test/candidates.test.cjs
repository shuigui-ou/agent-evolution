/**
 * candidates.cjs 测试：候选校验（probe 必带） / 实证选优 / 收敛判据（≤0 转人工）
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createCandidatePool,
  computeExpectedGain,
  createLocalResourceClient,
} = require('../src/index.cjs');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { makeTmpDir, rmTmpDir } = require('./helpers.cjs');

const FP = 'a'.repeat(16);
const probe = { trigger: '同 fingerprint 错误再现', judge: '行为含重试动作' };

test('候选校验：L1 缺 probe 拒收；未知单元拒收；L2（E2）可不带 probe 但标 L2', () => {
  const pool = createCandidatePool();
  // 失败路径：L1 注入候选必须自带生效判据
  assert.throws(() => pool.add({ fingerprint: FP, unit: 'E1', expected_gain: 5, content: 'x' }), /PROBE_REQUIRED/);
  assert.throws(() => pool.add({ fingerprint: FP, unit: 'E9', expected_gain: 5, content: 'x' }), /CANDIDATE_INVALID/);
  assert.throws(() => pool.add({ fingerprint: '', unit: 'E1', expected_gain: 5, probe }), /CANDIDATE_INVALID/);
  assert.throws(() => pool.add({ fingerprint: FP, unit: 'E1', expected_gain: 'high', probe }), /CANDIDATE_INVALID/);

  const l2 = pool.add({ fingerprint: FP, unit: 'E2', expected_gain: 5, content: '新验证流程' });
  assert.equal(l2.tier, 'L2');
});

test('实证选择：top1 选最高 expected_gain，runner_up 为次优', () => {
  const pool = createCandidatePool();
  pool.add({ fingerprint: FP, title: '候选A', content: '重试', unit: 'E1', expected_gain: 7, probe });
  pool.add({ fingerprint: FP, title: '候选B', content: '换模型', unit: 'E3', expected_gain: 3, probe });
  pool.add({ fingerprint: 'b'.repeat(16), title: '别的信号', unit: 'E1', expected_gain: 100, probe });

  const pick = pool.selectTop(FP);
  assert.equal(pick.evolve, true);
  assert.equal(pick.candidate.title, '候选A');
  assert.equal(pick.runner_up.title, '候选B');
});

test('收敛判据：top1 expected_gain ≤ 0 或无候选 → 本轮不进化转人工', () => {
  const pool = createCandidatePool();
  // 无候选
  let pick = pool.selectTop(FP);
  assert.equal(pick.evolve, false);
  assert.equal(pick.escalate, 'manual');
  assert.equal(pick.reason, 'no_candidate');
  // 全部 ≤0
  pool.add({ fingerprint: FP, unit: 'E1', expected_gain: -2, content: 'x', probe });
  pick = pool.selectTop(FP);
  assert.equal(pick.evolve, false);
  assert.equal(pick.escalate, 'manual');
  assert.equal(pick.reason, 'top1_gain_non_positive');
});

test('computeExpectedGain 换算与校验；解法池外部候选检索（本地文件适配器）', async () => {
  assert.equal(computeExpectedGain({ successProb: 0.8, benefit: 10, cost: 1, risk: 0 }), 7);
  assert.throws(() => computeExpectedGain({ successProb: 1.5, benefit: 10 }), /GAIN_INVALID/);
  assert.throws(() => computeExpectedGain({ successProb: 0.5, benefit: 'x' }), /GAIN_INVALID/);

  // 本地解法池检索：外部候选入池，与本地同池竞争
  const dir = makeTmpDir('cand-pool');
  try {
    const solutionsPath = path.join(dir, 'solutions.jsonl');
    fs.writeFileSync(
      solutionsPath,
      JSON.stringify({ fingerprint: FP, title: '外部同错解法', content: '先降并发再重试', unit: 'E1', expected_gain: 5, probe }) + '\n' +
      JSON.stringify({ fingerprint: FP, title: '不合规外部解法', content: 'x', unit: 'E1', expected_gain: 50 }) + '\n',
      'utf8'
    );
    const client = createLocalResourceClient({ solutionsPath });
    const pool = createCandidatePool();
    pool.add({ fingerprint: FP, title: '本地候选', content: 'y', unit: 'E1', expected_gain: 4, probe });
    const added = await pool.retrieveExternal(client, FP);
    assert.equal(added.length, 1, '缺 probe 的外部候选被丢弃');
    assert.equal(pool.list({ source: 'external' })[0].source, 'external');
    const pick = pool.selectTop(FP);
    assert.equal(pick.candidate.title, '外部同错解法'); // 5 > 4
  } finally {
    rmTmpDir(dir);
  }
});

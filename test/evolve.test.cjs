/**
 * @module test/evolve
 * @layer test
 * @owner kou
 * patch DSL / infer / apply / 快照回滚 / 状态机。
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const fsx = require('../src/util/fsx.cjs');
const paths = require('../src/store/paths.cjs');
const TMP = fsx.mkTmpDir('aed-test-evolve-');
paths.setRoot(TMP);

const dsl = require('../src/evolve/patch-dsl.cjs');
const { inferPatch } = require('../src/evolve/patch-infer.cjs');
const patchApply = require('../src/evolve/patch-apply.cjs');
const rollback = require('../src/evolve/rollback.cjs');
const configMod = require('../src/config.cjs');
const id = require('../src/util/id.cjs');

const cfg = JSON.parse(JSON.stringify(configMod.DEFAULTS));
cfg.root = TMP;

/**
 * @returns {Object} experience
 */
function exp(over = {}) {
  return Object.assign({
    schema: 'aed/experience/1.0',
    id: id.experienceId(),
    type: 'pitfall',
    layer: 'L2',
    fingerprint: 'a1b2c3d4e5f60718',
    simhash: '0123456789abcdef',
    title: 'TimeoutError: 启动超时',
    trigger: { category: 'tool', match: { error_type: ['TimeoutError'], message_regex: ['Timeout \\d+ms exceeded'] } },
    symptom: 'browserType.launch 超时',
    sample_input: { error_type: 'TimeoutError', message: 'Timeout 30000ms exceeded', tool: 'playwright', os: 'win32', version: 'v22.22.2', file: '', text: '' },
    fix: { kind: 'fallback', text: '重试一次并加超时', steps: ['重试'], patch_ref: null, confidence: 0.7 },
    evidence_refs: [id.traceId()],
    repro: { command: 'node run', expect: '不再超时', artifact: null },
    status: 'candidate',
    credit: 55,
    stats: { support_count: 2, hit: 0, hit_success: 0, false_trigger: 0, miss: 0, trigger_stability: 0, last_hit_at: null },
    origin: { channel: 'self_distill', contributor_id: null, signal_id: null, trust_level: 'T0' },
    applies_to: ['software-verifier'],
    version: '1.0.0',
    supersedes: null,
    superseded_by: null,
    created_at: '2026-09-07T02:00:00.000Z',
    updated_at: '2026-09-07T02:00:00.000Z',
    ttl_days: 180
  }, over);
}

test('patch-dsl：resolveSafePath 拒绝目录穿越与绝对路径', () => {
  const root = path.join(TMP, 'skill');
  fsx.ensureDir(root);
  assert.equal(dsl.resolveSafePath('SKILL.md', root), path.join(root, 'SKILL.md'));
  assert.throws(() => dsl.resolveSafePath('../evil.md', root), (e) => e.code === 'E_SCHEMA_MISMATCH');
  assert.throws(() => dsl.resolveSafePath('a/../../evil.md', root), (e) => e.code === 'E_SCHEMA_MISMATCH');
  assert.throws(() => dsl.resolveSafePath('/etc/passwd', root), (e) => e.code === 'E_SCHEMA_MISMATCH');
});

test('patch-dsl：add_file 只允许 scripts 目录与白名单后缀', () => {
  assert.doesNotThrow(() => dsl.assertAddFileAllowed('scripts/fix.cjs'));
  assert.doesNotThrow(() => dsl.assertAddFileAllowed('scripts/notes.md'));
  assert.throws(() => dsl.assertAddFileAllowed('evil.sh'), (e) => e.code === 'E_SCHEMA_MISMATCH');
  assert.throws(() => dsl.assertAddFileAllowed('src/evil.cjs'), (e) => e.code === 'E_SCHEMA_MISMATCH');
});

test('patch-dsl：op 白名单外一律拒收', () => {
  assert.throws(() => dsl.assertOp({ op: 'exec' }), (e) => e.code === 'E_SCHEMA_MISMATCH');
  assert.doesNotThrow(() => dsl.assertOp({ op: 'append_section' }));
});

test('patch-infer：产出 2 正 1 负共 3 条 testcase，且风险可评估', () => {
  const skillRoot = path.join(TMP, 'skill-infer');
  fsx.ensureDir(skillRoot);
  fsx.writeText(path.join(skillRoot, 'SKILL.md'), `# 技能\n\n${'占位内容，用于把文件撑到合理体积，避免改动占比误判为高危。'.repeat(40)}\n\n## 已知坑 / Pitfalls\n`);
  const p = inferPatch({ experience: exp(), agent: 'software-verifier', skillRoot, targetPath: 'SKILL.md', version: '1.0.0', config: cfg });
  assert.equal(p.schema, 'aed/patch/1.0');
  assert.equal(p.testcases.length, 3);
  assert.equal(p.testcases.filter((t) => t.expect_trigger).length, 2);
  assert.equal(p.testcases.filter((t) => !t.expect_trigger).length, 1);
  assert.ok(Array.isArray(p.reverse_ops));
  assert.equal(typeof p.risk.requires_human, 'boolean');
});

test('patch-infer：environment 类别额外产出 upsert_frontmatter', () => {
  const skillRoot = path.join(TMP, 'skill-env');
  fsx.ensureDir(skillRoot);
  fsx.writeText(path.join(skillRoot, 'SKILL.md'), '---\nname: x\nversion: 1.0.0\n---\n\n# x\n');
  const e = exp({
    type: 'env_fact',
    trigger: { category: 'environment', match: { error_type: ['AssertionError'] } },
    fix: { kind: 'env_requirement', text: '统一 LF', steps: [], patch_ref: null, confidence: 0.6 }
  });
  const p = inferPatch({ experience: e, agent: 'software-verifier', skillRoot, targetPath: 'SKILL.md', version: '1.0.0', config: cfg });
  assert.ok(p.ops.some((o) => o.op === 'upsert_frontmatter'));
});

test('patch-apply：dryRun 不落盘，正式应用后新增章节', () => {
  const skillRoot = path.join(TMP, 'skill-apply');
  fsx.ensureDir(skillRoot);
  const file = path.join(skillRoot, 'SKILL.md');
  fsx.writeText(file, '# 技能\n\n## 已知坑 / Pitfalls\n\n- 旧条目\n\n## 其它\n\n- 其它内容\n');
  const before = fsx.readText(file);

  const p = {
    schema: 'aed/patch/1.0',
    id: id.patchId(),
    target: { agent: 'a', artifact: 'skill-md', path: 'SKILL.md', version: '1.0.0' },
    ops: [{ op: 'append_section', path: 'SKILL.md', anchor: '## 已知坑 / Pitfalls', content: '\n### [fp] 新增坑\n- 处置：重试\n' }],
    testcases: [],
    risk: { level: 'low', requires_human: false, human_reasons: [] }
  };

  const dry = patchApply.apply({ patch: p, skillRoot, dryRun: true });
  assert.equal(dry.applied, false);
  assert.equal(fsx.readText(file), before, '干跑不得写盘');
  assert.equal(dry.changes.length, 1);

  const real = patchApply.apply({ patch: p, skillRoot, dryRun: false });
  assert.equal(real.applied, true);
  const after = fsx.readText(file);
  assert.match(after, /\[fp\] 新增坑/);
  assert.ok(after.indexOf('## 其它') > after.indexOf('[fp] 新增坑'), '新内容必须插入目标章节内部，而不是文件末尾');
});

test('patch-apply：upsert_frontmatter 可新增与覆盖', () => {
  const t1 = patchApply.upsertFrontmatter('# 无 frontmatter\n', 'requires', 'lf');
  assert.match(t1, /^---\nrequires: lf\n---/);
  const t2 = patchApply.upsertFrontmatter('---\nname: x\nversion: 1.0.0\n---\n\nbody\n', 'version', '1.0.1');
  assert.match(t2, /version: 1\.0\.1/);
  assert.match(t2, /name: x/);
});

test('rollback：nextVersion 语义正确', () => {
  assert.equal(rollback.nextVersion('1.2.5', 'patch'), '1.2.6');
  assert.equal(rollback.nextVersion('1.2.5', 'minor'), '1.3.0');
  assert.equal(rollback.nextVersion('1.2.5', 'major'), '2.0.0');
});

test('rollback：快照 -> 改坏 -> 还原（字节级一致）', () => {
  const skillRoot = path.join(TMP, 'skill-rb');
  fsx.ensureDir(skillRoot);
  fsx.writeText(path.join(skillRoot, 'SKILL.md'), '原始内容 A\n');
  fsx.writeText(path.join(skillRoot, 'scripts', 'helper.cjs'), 'module.exports = {};\n');
  const original = fsx.readBytes(path.join(skillRoot, 'SKILL.md'));

  const snap = rollback.snapshot({ agent: 'unit', skill: 'unit-skill', version: '1.0.0', skillRoot });
  assert.ok(snap.files.includes('SKILL.md'));
  assert.ok(snap.files.includes('scripts/helper.cjs'));

  fsx.writeText(path.join(skillRoot, 'SKILL.md'), '被 patch 改坏的内容 B\n');
  fsx.writeText(path.join(skillRoot, 'extra.md'), '多余文件\n');
  assert.notDeepEqual(fsx.readBytes(path.join(skillRoot, 'SKILL.md')), original);

  const res = rollback.restore({ agent: 'unit', skill: 'unit-skill', version: '1.0.0', skillRoot });
  assert.ok(res.restored.includes('SKILL.md'));
  assert.deepEqual(fsx.readBytes(path.join(skillRoot, 'SKILL.md')), original, '必须字节级还原');
  assert.equal(fsx.exists(path.join(skillRoot, 'extra.md')), false, '还原后不应残留新增文件');
  assert.deepEqual(rollback.listSnapshots('unit', 'unit-skill'), ['1.0.0']);
});

test('rollback：shouldAutoRollback 命中任一阈值即触发', () => {
  assert.equal(rollback.shouldAutoRollback({}).trigger, false);
  assert.equal(rollback.shouldAutoRollback({ regressionFailures: 1 }).trigger, true);
  assert.equal(rollback.shouldAutoRollback({ falseTriggerRate: 0.2 }).trigger, true);
  assert.equal(rollback.shouldAutoRollback({ fsrDropPp: 6 }).trigger, true);
  assert.equal(rollback.shouldAutoRollback({ crashRateRisePp: 3 }).trigger, true);
  assert.equal(rollback.shouldAutoRollback({ falseTriggerRate: 0.05, regressionFailures: 0 }).trigger, false);
});

test('risk-policy：改动占比过大 / 信任级低 -> requires_human', () => {
  const { assessRisk } = require('../src/security/risk-policy.cjs');
  const p = { ops: [{ op: 'append_section', path: 'SKILL.md', content: 'x'.repeat(500) }] };
  const r1 = assessRisk({ patch: p, experience: exp(), attribution: { confidence: 0.8 }, skillBytes: 100, changedBytes: 500 });
  assert.equal(r1.requires_human, true);
  assert.ok(r1.human_reasons.some((x) => x.includes('占比')));

  const r2 = assessRisk({ patch: p, experience: exp(), attribution: { confidence: 0.8 }, skillBytes: 100000, changedBytes: 500 });
  assert.equal(r2.requires_human, false);

  const lowTrust = exp();
  lowTrust.origin.trust_level = 'T2';
  const r3 = assessRisk({ patch: p, experience: lowTrust, attribution: { confidence: 0.8 }, skillBytes: 100000, changedBytes: 500 });
  assert.equal(r3.requires_human, true);
});

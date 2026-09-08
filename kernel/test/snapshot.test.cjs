/**
 * snapshot.cjs 测试：字节级回滚（修改/新建/版本号）
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createSnapshotManager, bumpPatch } = require('../src/snapshot.cjs');
const { makeTmpDir, rmTmpDir } = require('./helpers.cjs');

test('字节级回滚：写坏后还原，Buffer 完全一致（含行尾字节）', () => {
  const dir = makeTmpDir('snap-bytes');
  try {
    const file = path.join(dir, 'knowledge.jsonl');
    fs.writeFileSync(file, '{"v":1}\n{"v":2}\n', 'utf8');
    const original = fs.readFileSync(file);
    const mgr = createSnapshotManager({ dataDir: path.join(dir, 'runtime') });
    const snap = mgr.snapshot([file]);

    // 模拟一次写坏（多写了字节 + 改了内容）
    fs.writeFileSync(file, '{"v":1}\n{"v":2}\n{"v":3,"bad":true}\n垃圾数据', 'utf8');
    assert.ok(!fs.readFileSync(file).equals(original));

    const rb = mgr.rollback(snap.id);
    assert.equal(rb.ok, true);
    assert.ok(fs.readFileSync(file).equals(original), '回滚后必须字节级一致');
    assert.deepEqual(rb.restored, [file]);
  } finally {
    rmTmpDir(dir);
  }
});

test('新建文件回滚：快照时不存在 → 回滚删除该文件（还原"不存在"状态）', () => {
  const dir = makeTmpDir('snap-new');
  try {
    const file = path.join(dir, 'new-knowledge.jsonl');
    const mgr = createSnapshotManager({ dataDir: path.join(dir, 'runtime') });
    const snap = mgr.snapshot([file]);
    assert.equal(snap.files[0].existed, false);

    fs.writeFileSync(file, 'created after snapshot\n', 'utf8');
    const rb = mgr.rollback(snap.id);
    assert.equal(fs.existsSync(file), false, '快照时不存在的文件回滚后应被删除');
    assert.deepEqual(rb.removed, [file]);
  } finally {
    rmTmpDir(dir);
  }
});

test('版本管理：commitVersion patch +1（v1.0.0→v1.0.1）；回滚退回快照版本；非法版本号报错', () => {
  const dir = makeTmpDir('snap-ver');
  try {
    const file = path.join(dir, 'k.jsonl');
    fs.writeFileSync(file, 'seed\n', 'utf8');
    const mgr = createSnapshotManager({ dataDir: path.join(dir, 'runtime') });
    assert.equal(mgr.getVersion(), 'v1.0.0');

    const snap = mgr.snapshot([file]);
    assert.equal(mgr.commitVersion(snap.id), 'v1.0.1');
    assert.equal(mgr.getVersion(), 'v1.0.1');

    const rb = mgr.rollback(snap.id);
    assert.equal(rb.version, 'v1.0.0');
    assert.equal(mgr.getVersion(), 'v1.0.0');

    assert.throws(() => mgr.setVersion('1.0.2'), /SNAPSHOT_INVALID_VERSION/);
    assert.throws(() => mgr.rollback('SNAP-nope'), /SNAPSHOT_NOT_FOUND/);
    assert.equal(bumpPatch('v2.3.9'), 'v2.3.10');
    // 1 条快照 + 1 条回滚标记（BUG-2 修复后 rollback 会追加 rollback_marker）
    assert.equal(mgr.list().length, 2);
  } finally {
    rmTmpDir(dir);
  }
});

test('版本元数据重建一致（BUG-2 回归）：回滚后重建 manager，getVersion 与字节态一致', () => {
  const dir = makeTmpDir('snap-rebuild');
  try {
    const file = path.join(dir, 'f.txt');
    fs.writeFileSync(file, 'a', 'utf8');
    const mgr = createSnapshotManager({ dataDir: path.join(dir, 'runtime') });
    const s1 = mgr.snapshot([file]);
    mgr.commitVersion(s1.id); // v1.0.1
    const s2 = mgr.snapshot([file]);
    mgr.commitVersion(s2.id); // v1.0.2
    mgr.rollback(s1.id); // 字节与版本都回到 v1.0.0

    // 重建（模拟宿主重启）：必须读到 v1.0.0，而不是残留的 v1.0.2
    const rebuilt = createSnapshotManager({ dataDir: path.join(dir, 'runtime') });
    assert.equal(rebuilt.getVersion(), 'v1.0.0');

    // 回滚后再写入：新版本从回滚点继续推进，重建后仍一致
    const s3 = rebuilt.snapshot([file]);
    assert.equal(rebuilt.commitVersion(s3.id), 'v1.0.1');
    const rebuilt2 = createSnapshotManager({ dataDir: path.join(dir, 'runtime') });
    assert.equal(rebuilt2.getVersion(), 'v1.0.1');

    // 幂等：对同一快照重复回滚不崩，版本仍正确
    rebuilt2.rollback(s1.id);
    assert.equal(rebuilt2.getVersion(), 'v1.0.0');
    const rebuilt3 = createSnapshotManager({ dataDir: path.join(dir, 'runtime') });
    assert.equal(rebuilt3.getVersion(), 'v1.0.0');
  } finally {
    rmTmpDir(dir);
  }
});

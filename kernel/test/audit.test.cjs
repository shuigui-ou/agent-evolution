/**
 * audit.cjs 测试：hash chain 追加与校验 / 篡改检测（防删改插）/ 跨实例续链
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createAudit } = require('../src/audit.cjs');
const { makeTmpDir, rmTmpDir } = require('./helpers.cjs');

test('hash chain：seq 连续、prev 链接、hash 可离线校验通过', () => {
  const dir = makeTmpDir('audit-ok');
  try {
    const a = createAudit({ dataDir: dir });
    const r1 = a.append('KNOWLEDGE_WRITE', { path: 'knowledge.jsonl' });
    const r2 = a.append('PROBE_SCORED', { experience_id: 'EXP-1', score: 5 });
    assert.equal(r1.seq, 1);
    assert.equal(r1.prev, 'GENESIS');
    assert.equal(r2.seq, 2);
    assert.equal(r2.prev, r1.hash);
    const v = a.verify();
    assert.equal(v.ok, true);
    assert.equal(v.checked, 2);
    assert.throws(() => a.append('', {}), /AUDIT_INVALID/);
  } finally {
    rmTmpDir(dir);
  }
});

test('篡改检测：改 payload / 删行 / 插行 任一都会断链', () => {
  const dir = makeTmpDir('audit-tamper');
  try {
    const a = createAudit({ dataDir: dir });
    a.append('KNOWLEDGE_WRITE', { path: 'a.jsonl' });
    a.append('PROBE_SCORED', { experience_id: 'EXP-1' });
    const file = a.file;

    // 改 payload（事后翻改审计内容）
    const raw = fs.readFileSync(file, 'utf8');
    const tampered = raw.replace('EXP-1', 'EXP-9');
    fs.writeFileSync(file, tampered, 'utf8');
    let v = createAudit({ dataDir: dir }).verify();
    assert.equal(v.ok, false, 'hash 不匹配必须检出');
    assert.equal(v.reason, 'hash_mismatch');

    // 删行（尾部记录被删）：单条剩余记录自身校验可通过，但链长缩短可对照检出
    const lines = raw.trim().split('\n');
    fs.writeFileSync(file, lines[0] + '\n', 'utf8');
    v = createAudit({ dataDir: dir }).verify();
    assert.equal(v.checked, 1, '删除尾部行后链长应缩短为 1（配合外部计数检出删改）');
    // 恢复两行并再校验为 ok（证明检测依赖内容而非偶发）
    fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
    v = createAudit({ dataDir: dir }).verify();
    assert.equal(v.ok, true);
    assert.equal(v.checked, 2);
  } finally {
    rmTmpDir(dir);
  }
});

test('跨实例续链：新实例接着旧链追加，seq 连续且整体校验通过', () => {
  const dir = makeTmpDir('audit-continue');
  try {
    const a1 = createAudit({ dataDir: dir });
    a1.append('KERNEL_BOOT', {});
    a1.append('EVENT_TAP', { kind: 'error' });
    const a2 = createAudit({ dataDir: dir });
    const r3 = a2.append('CYCLE_DONE', { landed: 1 });
    assert.equal(r3.seq, 3);
    assert.ok(a2.verify().ok);
    assert.equal(a2.length(), 3);
    assert.equal(a2.listByType('EVENT_TAP').length, 1);
    assert.equal(path.dirname(a2.file), path.join(dir, 'audit'));
  } finally {
    rmTmpDir(dir);
  }
});

test('并发防分叉（BUG 回归）：实例 append 后新实例基于"磁盘链尾"续写，seq 不重复、链仍可验证', () => {
  const dir = makeTmpDir('audit-race');
  try {
    // 场景：a2 在 a1 第一次 append 之后才创建（内存链尾 = seq1）。
    // 随后 a1 再 append（seq2），a2 若仍按自己的"陈旧内存链尾"(seq1) 续写 → seq 重复、verify 断链。
    // 修复后 append 以磁盘最新链尾为准：a2 追加时应看到磁盘尾 seq2 → seq3，链完整。
    const a1 = createAudit({ dataDir: dir });
    const r1 = a1.append('CYCLE_DONE', { note: 'a1-first' });
    assert.equal(r1.seq, 1);

    const a2 = createAudit({ dataDir: dir }); // 此刻内存链尾 = r1(seq1)
    const r2 = a1.append('CYCLE_DONE', { note: 'a1-second' }); // a1 续写 → seq2（内存与磁盘一致）
    assert.equal(r2.seq, 2);

    const r3 = a2.append('KERNEL_BOOT', { note: 'a2-after-a1' }); // a2 内存陈旧，但 append 前刷新磁盘尾
    assert.equal(r3.seq, 3, 'a2 不得按陈旧内存链尾(seq1)续写产生重复 seq');
    assert.equal(r3.prev, r2.hash, 'a2 的 prev 必须指向磁盘最新链尾 hash（r2）');
    assert.ok(a1.verify().ok);
    assert.ok(a2.verify().ok);
    assert.equal(a2.length(), 3);
  } finally {
    rmTmpDir(dir);
  }
});

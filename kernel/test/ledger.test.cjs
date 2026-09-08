/**
 * ledger.cjs 测试：open→closed 生命周期 / 校验失败路径 / 超期检测（I 型悬挂信号）
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createLedgerStore } = require('../src/ledger.cjs');
const { makeTmpDir, rmTmpDir } = require('./helpers.cjs');

test('ledger 生命周期：open → close，重复闭合与不存在记录报错', () => {
  const dir = makeTmpDir('ledger-lc');
  try {
    const store = createLedgerStore({ dataDir: dir });
    const entry = store.open({ ledger: 'expectation', title: '导出章节为 txt', dueAt: new Date(Date.now() + 60000).toISOString() });
    assert.equal(entry.status, 'open');
    assert.equal(store.listOpen('expectation').length, 1);

    const closed = store.close(entry.id, { outcome: 'done' });
    assert.equal(closed.status, 'closed');
    assert.ok(closed.closed_at);
    assert.equal(store.listOpen('expectation').length, 0);

    // 失败路径：重复闭合 / 不存在
    assert.throws(() => store.close(entry.id), /LEDGER_ALREADY_CLOSED/);
    assert.throws(() => store.close('LG-nope'), /LEDGER_NOT_FOUND/);
  } finally {
    rmTmpDir(dir);
  }
});

test('ledger 校验：未知账本 / 缺 title / thread 必须带 dueAt；addError 直接物化为闭合记录', () => {
  const dir = makeTmpDir('ledger-valid');
  try {
    const store = createLedgerStore({ dataDir: dir });
    assert.throws(() => store.open({ ledger: 'wrong', title: 'x' }), /LEDGER_INVALID/);
    assert.throws(() => store.open({ ledger: 'plan', title: '' }), /LEDGER_INVALID/);
    assert.throws(() => store.open({ ledger: 'thread', title: '长任务' }), /LEDGER_INVALID/);

    const err = store.addError({ title: 'AI 调用超时', detail: 'timeout 30000ms' });
    assert.equal(err.ledger, 'error');
    assert.equal(err.status, 'closed');
    assert.equal(err.outcome.kind, 'error');
  } finally {
    rmTmpDir(dir);
  }
});

test('ledger 超期检测：过期 thread 只上报一次（I 型），二次检测不再重复；未过期不报', () => {
  const dir = makeTmpDir('ledger-overdue');
  try {
    const store = createLedgerStore({ dataDir: dir });
    const past = new Date(Date.now() - 3600 * 1000).toISOString();
    const future = new Date(Date.now() + 3600 * 1000).toISOString();
    const hung = store.open({ ledger: 'thread', title: '拆解任务悬挂', dueAt: past });
    store.open({ ledger: 'expectation', title: '未到期承诺', dueAt: future });

    const found = store.detectOverdue();
    assert.equal(found.length, 1);
    assert.equal(found[0].signalType, 'I'); // 线程悬挂 → I 型信号
    assert.equal(found[0].entry.id, hung.id);
    assert.equal(found[0].entry.status, 'open'); // 只报信号，绝不自动 resume

    // 第二次检测：已上报，不再重复
    assert.equal(store.detectOverdue().length, 0);
  } finally {
    rmTmpDir(dir);
  }
});

test('ledger 持久化：跨实例可见（JSONL 落盘 + 兼容 \\r\\n）', () => {
  const dir = makeTmpDir('ledger-persist');
  try {
    const s1 = createLedgerStore({ dataDir: dir });
    const e = s1.open({ ledger: 'plan', title: '三步拆解', dueAt: new Date(Date.now() + 60000).toISOString() });
    // 模拟 Windows \r\n 写坏：手工改写为 CRLF 行尾
    const fs = require('node:fs');
    const raw = fs.readFileSync(s1.file, 'utf8');
    fs.writeFileSync(s1.file, raw.replace(/\n/g, '\r\n'), 'utf8');

    const s2 = createLedgerStore({ dataDir: dir });
    assert.equal(s2.listOpen('plan').length, 1);
    assert.equal(s2.get(e.id).title, '三步拆解');
  } finally {
    rmTmpDir(dir);
  }
});

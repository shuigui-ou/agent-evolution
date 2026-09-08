/**
 * @module test/ingest
 * @layer test
 * @owner kou
 * normalizer / redactor / file-tail / collector / 指纹稳定性。
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const fsx = require('../src/util/fsx.cjs');
const paths = require('../src/store/paths.cjs');
const TMP = fsx.mkTmpDir('aed-test-ingest-');
paths.setRoot(TMP);

const normalizer = require('../src/ingest/normalizer.cjs');
const redactor = require('../src/ingest/redactor.cjs');
const FileTailAdapter = require('../src/ingest/adapter-file-tail.cjs');
const { Collector } = require('../src/ingest/collector.cjs');
const distiller = require('../src/evidence/distiller.cjs');
const { failureFingerprint } = distiller;

test('normalizer：已是 aed/trace-event/1.0 的 JSON 原样通过', () => {
  const raw = JSON.stringify({
    schema: 'aed/trace-event/1.0',
    id: 'te_0000000000000000000001',
    ts: '2026-09-07T02:00:00.000Z',
    agent: 'software-verifier',
    session_id: 's-1',
    seq: 3,
    kind: 'error',
    payload: { tool: 'playwright', message: 'boom' },
    outcome: 'fail',
    error: { type: 'TimeoutError', message: 'Timeout 30000ms exceeded' }
  });
  const ev = normalizer.normalize({ text: raw, path: 'x.jsonl', line: 1 }, { agent: 'software-verifier' });
  assert.equal(ev.kind, 'error');
  assert.equal(ev.outcome, 'fail');
  assert.equal(ev.error.type, 'TimeoutError');
  assert.equal(ev.session_id, 's-1');
});

test('normalizer：report 风格 JSON 映射为 TraceEvent', () => {
  const raw = JSON.stringify({
    ts: '2026-09-07T02:00:01.000Z',
    level: 'ERROR',
    step: 'launch',
    tool: 'playwright',
    session_id: 's-2',
    seq: 7,
    error: { type: 'TimeoutError', message: 'browserType.launch timeout' }
  });
  const ev = normalizer.normalize({ text: raw, path: 'x.log', line: 7 }, { agent: 'software-verifier' });
  assert.equal(ev.kind, 'error');
  assert.equal(ev.outcome, 'fail');
  assert.equal(ev.payload.tool, 'playwright');
  assert.equal(ev.seq, 7);
});

test('normalizer：文本日志行解析（[ts] [LEVEL] [tool] message）', () => {
  const line = '2026-09-07T02:00:02.000Z [WARN] [playwright] retry 1/2 after failure';
  const ev = normalizer.normalize({ text: line, path: 'x.log', line: 9 }, { agent: 'software-verifier' });
  assert.equal(ev.kind, 'warn');
  assert.equal(ev.payload.tool, 'playwright');
  assert.match(ev.payload.message, /retry 1\/2/);
});

test('normalizer：空行返回 null（不产生垃圾事件）', () => {
  assert.equal(normalizer.normalize({ text: '   ', path: 'x', line: 1 }, { agent: 'a' }), null);
});

test('redactor：命中 sk- / github token / JWT / 环境变量凭据', () => {
  const r1 = redactor.redact('key=sk-abcdefghijklmnopqrstuvwxyz1234');
  assert.match(r1.text, /REDACTED:OPENAI_KEY/);
  assert.equal(r1.redacted, true);

  const r2 = redactor.redact('token ghp_abcdefghijklmnopqrstuvwxyz0123456789');
  assert.match(r2.text, /REDACTED:GITHUB_TOKEN/);

  const r3 = redactor.redact('jwt=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk');
  assert.match(r3.text, /REDACTED:JWT/);

  const r4 = redactor.redact('PASSWORD=hunter2secret');
  assert.match(r4.text, /REDACTED:ENV_CRED/);
});

test('redactor：普通路径与 hex 摘要不被误伤', () => {
  const r1 = redactor.redact('path=C:/Users/foo/bar');
  assert.equal(r1.redacted, false);
  assert.equal(r1.text.includes('C:/Users/foo/bar'), true);

  const r2 = redactor.redact('sha256 摘要为 0123456789abcdef0123456789abcdef0123');
  assert.equal(r2.redacted, false, '纯 hex 摘要不应被当成密钥');
  assert.equal(r2.text.includes('0123456789abcdef0123456789abcdef0123'), true);
});

test('redactor：高熵串被替换（长度 ≥24 且熵 >4.2）', () => {
  const secret = 'qZ7xLp2mVb9Nc4RtY6uI8oP1aS3dF5gH';
  const r = redactor.redact(`blob=${secret}`);
  assert.equal(r.hits.includes('HIGH_ENTROPY'), true);
  assert.equal(r.text.includes(secret), false);
});

test('file-tail：增量读取 + 重复 poll 不重放 + 半行留待下次', async () => {
  const file = path.join(TMP, 'tail.log');
  fs.writeFileSync(file, 'line-1\nline-2\n', 'utf8');
  const got = [];
  const a = new FileTailAdapter({ kind: 'file-tail', path: file, agent: 'unit', pollMs: 0 });
  await a.start((rec) => got.push(rec));
  await a.poll();
  assert.equal(got.length, 2);
  assert.equal(got[0].text, 'line-1');
  assert.equal(got[0].line, 1);

  await a.poll();
  assert.equal(got.length, 2, '无新增内容时不应重复 emit');

  fs.appendFileSync(file, 'line-3\nline-4', 'utf8'); // 最后一行没有换行
  await a.poll();
  assert.equal(got.length, 3, '半行不应提前 emit');
  assert.equal(got[2].text, 'line-3');

  fs.appendFileSync(file, '\n', 'utf8');
  await a.poll();
  assert.equal(got.length, 4);
  assert.equal(got[3].text, 'line-4');
  await a.stop();
});

test('file-tail：文件被截断重建（模拟轮转）后游标归零', async () => {
  const file = path.join(TMP, 'rotate.log');
  fs.writeFileSync(file, 'a\nb\n', 'utf8');
  const got = [];
  const a = new FileTailAdapter({ kind: 'file-tail', path: file, agent: 'unit', pollMs: 0 });
  await a.start((rec) => got.push(rec));
  await a.poll();
  assert.equal(got.length, 2);
  fs.writeFileSync(file, 'c\n', 'utf8'); // 截断重写
  await a.poll();
  await a.stop();
  assert.equal(got.length, 3);
  assert.equal(got[2].text, 'c');
});

test('collector：按 (agent, session_id, seq) 去重，重放安全', () => {
  const c = new Collector({ agent: 'unit', adapters: [] });
  const mk = (n) => ({
    schema: 'aed/trace-event/1.0',
    id: `te_00000000000000000000${n}`,
    ts: '2026-09-07T02:00:00.000Z',
    agent: 'unit',
    session_id: 's-1',
    seq: n,
    kind: 'metric',
    payload: { message: `m${n}` },
    outcome: 'success'
  });
  assert.equal(c.ingestEvents([mk(1), mk(2)]), 2);
  assert.equal(c.ingestEvents([mk(1), mk(2), mk(3)]), 1, '重复事件应被跳过，仅新事件写入');
  const day = '2026-09-07';
  const recs = require('../src/store/jsonl.cjs').readRecords(paths.traceFile('unit', day)).records;
  assert.equal(recs.length, 3);
});

test('fingerprint：数字/路径归一化后保持稳定', () => {
  const a = { error: { type: 'TimeoutError', message: 'Timeout 30000ms exceeded at /tmp/a' }, payload: { tool: 'playwright' }, env: { os: 'win32' } };
  const b = { error: { type: 'TimeoutError', message: 'Timeout 45000ms exceeded at /tmp/b' }, payload: { tool: 'playwright' }, env: { os: 'win32' } };
  const c = { error: { type: 'AssertionError', message: 'Timeout 30000ms exceeded at /tmp/a' }, payload: { tool: 'playwright' }, env: { os: 'win32' } };
  assert.equal(failureFingerprint(a), failureFingerprint(b));
  assert.notEqual(failureFingerprint(a), failureFingerprint(c));
});

test('buildMessageRegex：生成的正则可同时匹配不同数字的同源消息', () => {
  const re = distiller.buildMessageRegex('browserType.launch: Timeout 30000ms exceeded while connecting');
  assert.match('browserType.launch: Timeout 30000ms exceeded while connecting', new RegExp(re, 'i'));
  assert.match('browserType.launch: Timeout 45000ms exceeded while connecting', new RegExp(re, 'i'));
  assert.doesNotMatch('ECONNREFUSED 127.0.0.1:443', new RegExp(re, 'i'));
});

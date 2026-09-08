/**
 * signals.cjs 测试：fingerprint 归一化稳定性 / 四类归类与失败路径 / 聚合排序
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeFingerprint, classifySignal, aggregate } = require('../src/signals.cjs');

test('fingerprint 归一化：数字/UUID/路径差异不影响同指纹；不同问题不同指纹', () => {
  const a = normalizeFingerprint('AI 调用失败 timeout after 30000ms at C:\\Users\\someone\\proj\\novel.cjs id=8f3c9a2e-11b2-4c3d-9e4f-aabbccddeeff');
  const b = normalizeFingerprint('AI 调用失败 timeout after 60000ms at /home/user/other/gen.cjs id=01234567-89ab-cdef-0123-456789abcdef');
  assert.equal(a, b, '同类问题（仅毫秒数/路径/UUID 不同）必须聚到同一指纹');
  assert.match(a, /^[0-9a-f]{16}$/);

  const c = normalizeFingerprint('章节拆解结果为空');
  assert.notEqual(a, c);
});

test('classifySignal：四种 kind 归到 E/G/P/I；未知 kind 报错', () => {
  const e = classifySignal({ kind: 'runtime_error', title: 'exit≠0' });
  const g = classifySignal({ kind: 'expectation_gap', title: '用户要 txt 给了 md' });
  const p = classifySignal({ kind: 'plan_deviation', title: '跳过验证步骤' });
  const i = classifySignal({ kind: 'hanging', title: '导入任务悬挂' });
  assert.deepEqual([e.type, g.type, p.type, i.type], ['E', 'G', 'P', 'I']);
  // 也接受直接给 type
  assert.equal(classifySignal({ type: 'G', title: 'x' }).type, 'G');
  // 失败路径
  assert.throws(() => classifySignal({ kind: 'alien', title: 'x' }), /SIGNAL_INVALID_TYPE/);
  assert.throws(() => classifySignal({ type: 'Z', title: 'x' }), /SIGNAL_INVALID_TYPE/);
});

test('aggregate：同指纹聚合计数，按 count 降序；空输入返回空', () => {
  const mk = (title, detail, ts) => classifySignal({ kind: 'runtime_error', title, detail, ts });
  const s1 = mk('AI 调用失败 timeout 1000ms', '', '2026-09-07T01:00:00.000Z');
  const s2 = mk('AI 调用失败 timeout 2000ms', '', '2026-09-07T02:00:00.000Z');
  const s3 = mk('格式校验失败 md5 999ms', '', '2026-09-07T03:00:00.000Z');
  const groups = aggregate([s1, s2, s3]);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].count, 2); // 同错两次排前
  assert.equal(groups[0].first_ts, '2026-09-07T01:00:00.000Z');
  assert.equal(groups[0].last_ts, '2026-09-07T02:00:00.000Z');
  assert.equal(groups[1].count, 1);
  assert.deepEqual(aggregate([]), []);
});

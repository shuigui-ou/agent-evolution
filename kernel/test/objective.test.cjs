/**
 * objective.cjs 测试：方向闸（无目标只归档） / 达标降权 / 目标栈校验失败路径
 * （目标对齐回路：add/update 均需显式 source:'user'，来源保护细节见 objective-source.test.cjs）
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createObjectiveStack } = require('../src/objective.cjs');
const { normalizeFingerprint } = require('../src/signals.cjs');

const USER = { source: 'user' };

test('方向闸：无 objective 关联的信号 pass=false（只归档不进化）', () => {
  const stack = createObjectiveStack();
  stack.add({ title: '压制指纹复发率 RR≤5%', types: ['E'], weight: 5 }, USER);
  const hit = stack.gate({ type: 'E', title: 'AI 调用失败', fingerprint: normalizeFingerprint('AI 调用失败') });
  assert.equal(hit.pass, true);
  assert.equal(hit.weight, 5);

  const miss = stack.gate({ type: 'P', title: '计划偏离', fingerprint: normalizeFingerprint('计划偏离') });
  assert.equal(miss.pass, false);
  assert.equal(miss.reason, 'no_objective_archive_only');
  assert.equal(miss.weight, 0);
});

test('方向闸：fingerprint 精确关联与 pattern 模糊关联均生效；已达标目标自动降权', () => {
  const fp = normalizeFingerprint('章节拆解为空');
  const stack = createObjectiveStack();
  stack.add({ title: '消灭拆解空结果', fingerprints: [fp], weight: 4 }, USER);
  stack.add({ title: '减少格式类报错', pattern: /格式/, weight: 2 }, USER);

  assert.equal(stack.gate({ type: 'E', title: 'x', fingerprint: fp }).objective.title, '消灭拆解空结果');
  assert.equal(stack.gate({ type: 'G', title: '格式校验失败', fingerprint: 'f'.repeat(16) }).pass, true);

  // 达标降权：weight 4 → 4×0.3 = 1.2
  const obj = stack.list()[0];
  stack.update(obj.id, { met: true }, USER);
  const down = stack.gate({ type: 'E', title: 'x', fingerprint: fp });
  assert.equal(down.pass, true);
  assert.equal(down.reason, 'objective_met_downweighted');
  assert.equal(down.weight, 1.2);
});

test('目标栈校验：缺 title / 权重越界 / 更新不存在目标 均报错', () => {
  const stack = createObjectiveStack();
  assert.throws(() => stack.add({ title: '' }, USER), /OBJECTIVE_INVALID/);
  assert.throws(() => stack.add({ title: 'x', weight: 99 }, USER), /OBJECTIVE_INVALID/);
  assert.throws(() => stack.add({ title: 'x', weight: -1 }, USER), /OBJECTIVE_INVALID/);
  assert.throws(() => stack.update('OBJ-nope', { met: true }, USER), /OBJECTIVE_NOT_FOUND/);
});

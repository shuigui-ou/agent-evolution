/**
 * objective.cjs 来源保护测试（目标对齐回路 · T4 同级铁律）：
 * 非 user 来源改目标 → OBJECTIVE_SOURCE_FORBIDDEN + 审计；初始注入视为 user；user 正常修改。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createObjectiveStack } = require('../src/objective.cjs');
const { createAudit } = require('../src/audit.cjs');
const { makeTmpDir, rmTmpDir } = require('./helpers.cjs');

test('来源保护：非 user 来源 add/update/改权重均被拒 + 记审计', () => {
  const tmp = makeTmpDir('obj-src');
  try {
    const audit = createAudit({ dataDir: tmp });
    // 初始注入视为 user 来源（合法）
    const stack = createObjectiveStack(
      [{ title: '压制错误复发率 RR≤5%', types: ['E'], weight: 5 }],
      { audit }
    );
    assert.equal(stack.list().length, 1);

    // 经验内容来源 add → 拒
    assert.throws(
      () => stack.add({ title: '经验想加的目标', types: ['E'] }, { source: 'experience' }),
      /OBJECTIVE_SOURCE_FORBIDDEN/
    );
    // 候选来源 update 改权重 → 拒
    const id = stack.list()[0].id;
    assert.throws(
      () => stack.update(id, { weight: 9 }, { source: 'candidate' }),
      /OBJECTIVE_SOURCE_FORBIDDEN/
    );
    // 外部来源标记达标 → 拒；未声明来源同样拒（不得默认放行）
    assert.throws(
      () => stack.update(id, { met: true }, { source: 'external' }),
      /OBJECTIVE_SOURCE_FORBIDDEN/
    );
    assert.throws(() => stack.update(id, { met: true }, {}), /OBJECTIVE_SOURCE_FORBIDDEN/);

    // 被拒操作不得生效（权重仍是 5、met 仍 false）
    assert.equal(stack.list()[0].weight, 5);
    assert.equal(stack.list()[0].met, false);

    // 审计链：每条被拒尝试都有 OBJECTIVE_SOURCE_FORBIDDEN，且链完整可校验
    const blocked = audit.listByType('OBJECTIVE_SOURCE_FORBIDDEN');
    assert.equal(blocked.length, 4);
    assert.deepEqual(
      blocked.map((r) => String(r.payload.source)).sort(),
      ['candidate', 'experience', 'external', 'undefined'].sort()
    );
    assert.ok(audit.verify().ok);
  } finally {
    rmTmpDir(tmp);
  }
});

test('来源保护：user 来源正常修改 + 权重越界先校验后写入（原值不被污染）', () => {
  const tmp = makeTmpDir('obj-user');
  try {
    const audit = createAudit({ dataDir: tmp });
    const stack = createObjectiveStack([{ title: '目标A', types: ['E'], weight: 3 }], { audit });
    const id = stack.list()[0].id;

    // user 修改权重/达标 → 生效
    const updated = stack.update(id, { weight: 7, met: true }, { source: 'user' });
    assert.equal(updated.weight, 7);
    assert.equal(updated.met, true);
    // user 添加新目标 → 生效
    stack.add({ title: '目标B', types: ['G'], weight: 2 }, { source: 'user' });
    assert.equal(stack.list().length, 2);

    // 权重越界（user 来源也校验数值域）→ 拒且原值不变
    assert.throws(
      () => stack.update(id, { weight: 11 }, { source: 'user' }),
      /OBJECTIVE_INVALID/
    );
    assert.equal(stack.list()[0].weight, 7);
    assert.ok(audit.verify().ok);
  } finally {
    rmTmpDir(tmp);
  }
});

test('来源保护：无审计链时被拒仅抛错不崩；方向闸只读行为不受来源校验影响', () => {
  const stack = createObjectiveStack([{ title: '目标C', types: ['E'], weight: 4 }]);
  assert.throws(
    () => stack.update(stack.list()[0].id, { weight: 5 }),
    /OBJECTIVE_SOURCE_FORBIDDEN/
  );
  // gate 是只读裁决，不受来源校验影响
  const hit = stack.gate({ type: 'E', title: 'x', fingerprint: 'f'.repeat(16) });
  assert.equal(hit.pass, true);
  assert.equal(hit.weight, 4);
});

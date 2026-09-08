/**
 * @module test/schema
 * @layer test
 * @owner kou
 * 手写校验器与 6 个契约 schema 的正例 / 反例。
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const validate = require('../src/schema/validate.cjs');
const { AedError } = require('../src/util/errors.cjs');
const id = require('../src/util/id.cjs');

/**
 * 最小合法 Experience。
 * @returns {Object}
 */
function exp() {
  return {
    schema: 'aed/experience/1.0',
    id: id.experienceId(),
    type: 'pitfall',
    layer: 'L2',
    fingerprint: 'a1b2c3d4e5f60718',
    simhash: '0123456789abcdef',
    title: 'TimeoutError: 浏览器启动超时',
    trigger: { category: 'tool', match: { error_type: ['TimeoutError'] } },
    symptom: 'browserType.launch 超时',
    fix: { kind: 'fallback', text: '重试一次', steps: ['重试'], patch_ref: null, confidence: 0.7 },
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
  };
}

/**
 * 最小合法 Patch。
 * @returns {Object}
 */
function patch() {
  return {
    schema: 'aed/patch/1.0',
    id: id.patchId(),
    target: { agent: 'software-verifier', artifact: 'skill-md', path: 'SKILL.md', version: '1.0.0' },
    ops: [{ op: 'append_section', path: 'SKILL.md', anchor: '## 已知坑', content: 'x' }],
    testcases: [
      { id: 'tc-1', expect_trigger: true, input: { error_type: 'TimeoutError' } },
      { id: 'tc-2', expect_trigger: true, input: { error_type: 'TimeoutError' } },
      { id: 'tc-3', expect_trigger: false, input: { error_type: 'Other' } }
    ],
    risk: { level: 'low', blast_radius: 'software-verifier', requires_human: false, human_reasons: [] },
    reverse_ops: [],
    created_by: 'test'
  };
}

test('trace-event 正例通过，反例（kind 非法 / 缺字段）失败', () => {
  const ok = {
    schema: 'aed/trace-event/1.0',
    id: id.traceId(),
    ts: '2026-09-07T02:00:00.000Z',
    agent: 'software-verifier',
    session_id: 's-01',
    seq: 1,
    kind: 'tool_call',
    payload: { tool: 'playwright' },
    outcome: 'success'
  };
  assert.equal(validate.validate('aed:schema/trace-event/1.0', ok).valid, true);

  const badKind = Object.assign({}, ok, { kind: 'no_such_kind' });
  assert.equal(validate.validate('aed:schema/trace-event/1.0', badKind).valid, false);

  const missing = Object.assign({}, ok);
  delete missing.session_id;
  const r = validate.validate('aed:schema/trace-event/1.0', missing);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.keyword === 'required'));
});

test('experience 正例通过；id 前缀 / credit 越界 / evidence_refs 为空均失败', () => {
  assert.equal(validate.validate('aed:schema/experience/1.0', exp()).valid, true);

  const badId = Object.assign(exp(), { id: 'xx_1234567890abcdef' });
  assert.equal(validate.validate('aed:schema/experience/1.0', badId).valid, false);

  const badCredit = Object.assign(exp(), { credit: 200 });
  assert.equal(validate.validate('aed:schema/experience/1.0', badCredit).valid, false);

  const noEvidence = Object.assign(exp(), { evidence_refs: [] });
  assert.equal(validate.validate('aed:schema/experience/1.0', noEvidence).valid, false);
});

test('patch 正例通过；op 白名单与 ops 非空校验生效', () => {
  assert.equal(validate.validate('aed:schema/patch/1.0', patch()).valid, true);

  const badOp = patch();
  badOp.ops = [{ op: 'exec_shell', path: 'SKILL.md', content: 'rm -rf /' }];
  assert.equal(validate.validate('aed:schema/patch/1.0', badOp).valid, false);

  const emptyOps = patch();
  emptyOps.ops = [];
  assert.equal(validate.validate('aed:schema/patch/1.0', emptyOps).valid, false);
});

test('external-signal 正例通过；status 非法失败', () => {
  const sig = {
    schema: 'aed/external-signal/1.0',
    id: id.signalId(),
    ts: '2026-09-07T02:00:00.000Z',
    received_at: '2026-09-07T02:00:00.000Z',
    source: { id: 'peer-1', kind: 'peer_pitfall', url: null, registry_version: null },
    kind: 'pitfall',
    contributor: { id: 'peer.zhang', pubkey: null, reputation_hint: 70, contact: null },
    payload: { title: 't', trigger: { error_type: ['X'] }, fix: { kind: 'constraint', text: 'y' } },
    repro: null,
    dedupe: { fingerprint: 'a1b2c3d4e5f60718', simhash: '0123456789abcdef' },
    signature: null,
    trust_level: 'T1',
    status: 'new',
    decision: null,
    notify: { receipt_sent: false, sent_at: null, channel: 'spool' }
  };
  assert.equal(validate.validate('aed:schema/external-signal/1.0', sig).valid, true);
  assert.equal(validate.validate('aed:schema/external-signal/1.0', Object.assign({}, sig, { status: 'weird' })).valid, false);
});

test('proposal 正例通过（含内嵌 patch $ref）；attribution 缺 confidence 失败', () => {
  const p = {
    schema: 'aed/proposal/1.0',
    id: id.proposalId(),
    created_at: '2026-09-07T02:00:00.000Z',
    agent: 'software-verifier',
    trigger: { kind: 'failure', ref_ids: [id.traceId()], fingerprint: 'a1b2c3d4e5f60718' },
    attribution: { category: 'tool', confidence: 0.7, evidence: ['TOOL_ERRNO'] },
    intent: '修复启动超时',
    patch: patch(),
    experience_id: id.experienceId(),
    state: 'draft',
    gate_result_id: null,
    retry_count: 0,
    audit_refs: []
  };
  assert.equal(validate.validate('aed:schema/proposal/1.0', p).valid, true);

  const bad = JSON.parse(JSON.stringify(p));
  delete bad.attribution.confidence;
  assert.equal(validate.validate('aed:schema/proposal/1.0', bad).valid, false);
});

test('gate-result 正例通过；decision 非法失败', () => {
  const gr = {
    schema: 'aed/gate-result/1.0',
    id: id.gateResultId(),
    proposal_id: id.proposalId(),
    ts: '2026-09-07T02:00:00.000Z',
    decision: 'pass',
    stages: [{ stage: 'G1_static', pass: true, duration_ms: 3, skipped: false }],
    metrics: { regression_total: 24, regression_passed: 24 },
    requires_human: false,
    human_reasons: [],
    sandboxed: true
  };
  assert.equal(validate.validate('aed:schema/gate-result/1.0', gr).valid, true);
  assert.equal(validate.validate('aed:schema/gate-result/1.0', Object.assign({}, gr, { decision: 'maybe' })).valid, false);
});

test('schema 版本不匹配抛 E_SCHEMA_MISMATCH', () => {
  assert.throws(() => validate.assertSchemaConst({ schema: 'aed/experience/2.0' }, 'aed/experience/1.0'),
    (e) => e instanceof AedError && e.code === 'E_SCHEMA_MISMATCH');
  assert.doesNotThrow(() => validate.assertSchemaConst({ schema: 'aed/experience/1.0' }, 'aed/experience/1.0'));
});

test('validateOrThrow 抛错时携带错误明细', () => {
  assert.throws(() => validate.validateOrThrow('aed:schema/experience/1.0', { id: 'x' }, { what: 'Experience' }),
    (e) => e instanceof AedError && e.code === 'E_SCHEMA_MISMATCH' && Array.isArray(e.detail.errors));
});

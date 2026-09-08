/**
 * @module eval/evaluator
 * @layer eval
 * @owner kou
 * 四道门禁编排：G1 -> G2 -> G3 -> G4 串行短路，每门独立 try/catch，产出 GateResult。
 */

'use strict';

const path = require('node:path');
const fsx = require('../util/fsx.cjs');
const paths = require('../store/paths.cjs');
const id = require('../util/id.cjs');
const time = require('../util/time.cjs');
const validate = require('../schema/validate.cjs');
const gateStatic = require('./gate-static.cjs');
const gateRegression = require('./gate-regression.cjs');
const gateSynthetic = require('./gate-synthetic.cjs');
const gateShadow = require('./gate-shadow.cjs');
const suiteRegistry = require('./suite-registry.cjs');

/**
 * 估算文本 token 数（1 token ≈ 4 字符，零依赖近似）。
 * @param {string} s
 * @returns {number}
 */
function estimateTokens(s) {
  return Math.ceil(String(s || '').length / 4);
}

/**
 * 执行四道门禁。
 * @param {{proposal: Object, experience?: Object, patch?: Object, agent?: string, config?: Object, traces?: Object[], sandbox?: boolean}} ctx
 * @returns {Promise<Object>} GateResult
 */
async function evaluate(ctx = {}) {
  const config = ctx.config || {};
  const proposal = ctx.proposal;
  const patch = ctx.patch || proposal.patch || null;
  const experience = ctx.experience || null;
  const stages = [];
  const metrics = {};
  let decision = 'pass';
  let requiresHuman = !!(patch && patch.risk && patch.risk.requires_human);
  const humanReasons = (patch && patch.risk && patch.risk.human_reasons) ? patch.risk.human_reasons.slice() : [];

  // ---- G1 静态 ----
  stages.push(safe(() => gateStatic.run({ proposal, experience, patch }), 'G1_static'));

  // ---- G2 回归（仅 G1 通过才继续）----
  if (lastPassed(stages)) {
    let suite = null;
    try {
      suite = suiteRegistry.loadSuite({ agent: ctx.agent || (proposal && proposal.agent), config });
    } catch (e) {
      stages.push({
        stage: 'G2_regression',
        pass: false,
        reason_code: 'E_GATE_REGRESSION_FAIL',
        detail: `用例集加载失败：${e.message}`,
        duration_ms: 0,
        skipped: false
      });
    }
    if (suite) {
      // eslint-disable-next-line no-await-in-loop
      stages.push(await safeAsync(() => gateRegression.run({
        agent: ctx.agent,
        suite,
        config,
        sandbox: ctx.sandbox
      }), 'G2_regression'));
    }
  } else {
    stages.push(skippedStage('G2_regression'));
  }

  // ---- G3 合成单测 ----
  if (lastPassed(stages)) {
    let suite = null;
    try {
      suite = suiteRegistry.loadSuite({ agent: ctx.agent, config });
    } catch (_e) {
      suite = null;
    }
    // eslint-disable-next-line no-await-in-loop
    stages.push(await safeAsync(() => gateSynthetic.run({
      patch,
      experience,
      suite,
      config,
      agent: ctx.agent,
      sandbox: ctx.sandbox
    }), 'G3_synthetic'));
  } else {
    stages.push(skippedStage('G3_synthetic'));
  }

  // ---- G4 影子回放 ----
  if (lastPassed(stages)) {
    const traces = ctx.traces || [];
    stages.push(safe(() => gateShadow.run({ traces, experience, config }), 'G4_shadow'));
  } else {
    stages.push(skippedStage('G4_shadow'));
  }

  // ---- 汇总 ----
  for (const s of stages) {
    if (s.metrics) Object.assign(metrics, s.metrics);
    delete s.metrics;
    // gate-result.schema.json 中 reason_code 为可选 string；门禁通过时为 null，
    // 既不合法也无意义，统一在汇总后剔除，避免 E_SCHEMA_MISMATCH。
    if (s.reason_code === null) delete s.reason_code;
  }

  const failed = stages.filter((s) => !s.pass && !s.skipped);
  if (stages.some((s) => s.stage === 'G1_static' && !s.pass && /注入检测命中/.test(s.detail || ''))) {
    decision = 'fail';
  } else if (failed.length > 0) {
    decision = 'fail';
  } else if (requiresHuman) {
    decision = 'needs_human';
  }

  const result = {
    schema: 'aed/gate-result/1.0',
    id: id.gateResultId(),
    proposal_id: proposal ? proposal.id : 'unknown',
    ts: time.nowIso(),
    decision,
    stages,
    metrics: Object.assign({
      regression_total: 0,
      regression_passed: 0,
      synthetic_total: 0,
      synthetic_passed: 0,
      shadow_calls: 0,
      shadow_regressions: 0,
      expected_gain: 0
    }, metrics),
    budget: {
      token_delta: estimateTokens(`${patch ? JSON.stringify(patch.ops || []) : ''}${experience ? experience.fix && experience.fix.text || '' : ''}`),
      skill_bytes: patch ? JSON.stringify(patch.ops || []).length : 0,
      items_after: 0
    },
    requires_human: requiresHuman,
    human_reasons: humanReasons,
    sandboxed: config.gate ? config.gate.sandbox !== false : true
  };
  validate.validateOrThrow('aed:schema/gate-result/1.0', result, { what: 'GateResult' });
  persist(result);
  return result;
}

/**
 * 持久化 GateResult。
 * @param {Object} result
 * @returns {string} 文件路径
 */
function persist(result) {
  const file = path.join(paths.proposalsDir(), `${result.id}.gate.json`);
  fsx.ensureDir(paths.proposalsDir());
  fsx.atomicWriteJson(file, result);
  return file;
}

/**
 * @param {string} stage
 * @returns {Object}
 */
function skippedStage(stage) {
  return { stage, pass: false, reason_code: 'SHORT_CIRCUIT', detail: '前序门禁未通过，短路跳过', duration_ms: 0, skipped: true };
}

/**
 * @param {Object[]} stages
 * @returns {boolean}
 */
function lastPassed(stages) {
  const last = stages[stages.length - 1];
  return !!last && last.pass !== false;
}

/**
 * 同步 stage 包装（异常转失败）。
 * @param {Function} fn
 * @param {string} stage
 * @returns {Object}
 */
function safe(fn, stage) {
  const started = Date.now();
  try {
    return fn();
  } catch (e) {
    return {
      stage,
      pass: false,
      reason_code: 'E_GATE_STATIC_FAIL',
      detail: `门禁异常：${(e && e.message) || e}`,
      duration_ms: Date.now() - started,
      skipped: false
    };
  }
}

/**
 * 异步 stage 包装。
 * @param {Function} fn
 * @param {string} stage
 * @returns {Promise<Object>}
 */
async function safeAsync(fn, stage) {
  const started = Date.now();
  try {
    return await fn();
  } catch (e) {
    return {
      stage,
      pass: false,
      reason_code: 'E_GATE_STATIC_FAIL',
      detail: `门禁异常：${(e && e.message) || e}`,
      duration_ms: Date.now() - started,
      skipped: false
    };
  }
}

module.exports = { evaluate, estimateTokens, persist };

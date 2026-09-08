/**
 * @module eval/gate-static
 * @layer eval
 * @owner kou
 * G1 静态门禁：schema 校验 + 文本长度 + 结构约束 + 注入检测。
 */

'use strict';

const validate = require('../schema/validate.cjs');
const guard = require('../security/injection-guard.cjs');

/** 长度上限 */
const LIMITS = { symptom: 500, fixText: 2000, title: 120, intent: 300, patchContent: 8000 };

/**
 * 结构约束：Experience 不得携带自由指令字段。
 * @param {Object} exp
 * @returns {string[]} 违规项
 */
function structuralConstraints(exp) {
  const problems = [];
  if (!exp) return problems;
  if (Object.prototype.hasOwnProperty.call(exp, 'instructions')) problems.push('不得包含 instructions 字段');
  if (exp.fix && typeof exp.fix === 'object') {
    if (Object.prototype.hasOwnProperty.call(exp.fix, 'instructions')) problems.push('fix 不得包含 instructions 字段');
    if (exp.fix.kind === 'patch_script' && !exp.fix.patch_ref) {
      problems.push('fix.kind=patch_script 时必须给出 patch_ref');
    }
  }
  if (exp.trigger && exp.trigger.match && Object.keys(exp.trigger.match).length === 0) {
    problems.push('trigger.match 至少需要一个条件');
  }
  return problems;
}

/**
 * 执行 G1。
 * @param {{proposal?: Object, experience?: Object, patch?: Object}} input
 * @returns {{stage: string, pass: boolean, reason_code: string|null, detail: string, duration_ms: number, skipped: boolean}}
 */
function run(input = {}) {
  const started = Date.now();
  const reasons = [];

  // 1) schema
  if (input.experience) {
    const r = validate.validate('aed:schema/experience/1.0', input.experience);
    if (!r.valid) reasons.push(`Experience schema: ${r.errors.map((e) => `${e.path} ${e.message}`).join(' | ').slice(0, 300)}`);
  }
  if (input.patch) {
    const r = validate.validate('aed:schema/patch/1.0', input.patch);
    if (!r.valid) reasons.push(`Patch schema: ${r.errors.map((e) => `${e.path} ${e.message}`).join(' | ').slice(0, 300)}`);
  }
  if (input.proposal) {
    const r = validate.validate('aed:schema/proposal/1.0', input.proposal);
    if (!r.valid) reasons.push(`Proposal schema: ${r.errors.map((e) => `${e.path} ${e.message}`).join(' | ').slice(0, 300)}`);
  }

  // 2) 长度
  const exp = input.experience;
  if (exp) {
    if (typeof exp.title === 'string' && exp.title.length > LIMITS.title) reasons.push(`title 超长 ${exp.title.length}>${LIMITS.title}`);
    if (typeof exp.symptom === 'string' && exp.symptom.length > LIMITS.symptom) reasons.push(`symptom 超长 ${exp.symptom.length}>${LIMITS.symptom}`);
    if (exp.fix && typeof exp.fix.text === 'string' && exp.fix.text.length > LIMITS.fixText) reasons.push(`fix.text 超长 ${exp.fix.text.length}>${LIMITS.fixText}`);
    reasons.push(...structuralConstraints(exp));
  }
  if (input.proposal && typeof input.proposal.intent === 'string' && input.proposal.intent.length > LIMITS.intent) {
    reasons.push(`intent 超长 ${input.proposal.intent.length}>${LIMITS.intent}`);
  }

  // 3) patch op 白名单与路径安全
  const patch = input.patch;
  if (patch && Array.isArray(patch.ops)) {
    if (patch.ops.length > 8) reasons.push(`op 数量 ${patch.ops.length} 超过上限 8`);
    for (const op of patch.ops) {
      if (op.path && /(^|[\\/])\.\.([\\/]|$)/.test(String(op.path))) reasons.push('op.path 含目录穿越 ..');
      if (typeof op.content === 'string' && op.content.length > LIMITS.patchContent) reasons.push('op.content 超过 8000 字符');
    }
  }

  // 4) 注入检测
  const scanTargets = [];
  if (exp) scanTargets.push(['experience', exp]);
  if (patch) scanTargets.push(['patch', patch]);
  if (input.proposal) scanTargets.push(['proposal', input.proposal]);
  for (const [name, obj] of scanTargets) {
    const hits = guard.scanDeep(obj, name);
    if (hits.length) {
      reasons.push(`注入检测命中[${name}]: ${hits.map((h) => `${h.path}(${h.rules.join(',')})`).join(' | ').slice(0, 300)}`);
    }
  }

  const pass = reasons.length === 0;
  return {
    stage: 'G1_static',
    pass,
    reason_code: pass ? null : 'E_GATE_STATIC_FAIL',
    detail: pass ? 'schema / 长度 / 结构 / 注入检测全部通过' : reasons.join(' ;; ').slice(0, 1000),
    duration_ms: Date.now() - started,
    skipped: false
  };
}

module.exports = { run, structuralConstraints, LIMITS };

/**
 * @module evolve/patch-infer
 * @layer evolve
 * @owner kou
 * inferFix 泛化版：归因 category -> 查 rules/patch-templates.json -> 填模板 -> 生成 3 条 testcase -> 风险评估。
 * （LLM 可选增强在 P2，且必须同样产出 3 条 testcase，否则 G3 直接 fail）
 */

'use strict';

const path = require('node:path');
const fsx = require('../util/fsx.cjs');
const id = require('../util/id.cjs');
const time = require('../util/time.cjs');
const { assessRisk } = require('../security/risk-policy.cjs');
const dsl = require('./patch-dsl.cjs');

/** 模板文件路径 */
const TEMPLATE_FILE = path.join(__dirname, 'rules', 'patch-templates.json');

/** @type {Object|null} */
let cachedTemplates = null;

/**
 * 加载模板（带缓存）。
 * @returns {Object}
 */
function loadTemplates() {
  if (!cachedTemplates) cachedTemplates = fsx.readJson(TEMPLATE_FILE, { templates: {} });
  return cachedTemplates;
}

/**
 * 模板变量替换。
 * @param {string} tpl
 * @param {Object} vars
 * @returns {string}
 */
function render(tpl, vars) {
  return String(tpl || '').replace(/\{(\w+)\}/g, (m, k) => (vars[k] === undefined || vars[k] === null ? '' : String(vars[k])));
}

/**
 * 步骤列表渲染为 Markdown。
 * @param {string[]} steps
 * @returns {string}
 */
function renderSteps(steps) {
  return (steps || []).map((s) => `- ${s}`).join('\n');
}

/**
 * 由 experience 构造 3 条确定性测试用例（2 正 1 负）。
 * @param {Object} exp
 * @returns {Object[]}
 */
function buildTestcases(exp) {
  const sample = (exp && exp.sample_input) || {};
  const base = {
    error_type: String(sample.error_type || ''),
    message: String(sample.message || ''),
    tool: String(sample.tool || ''),
    os: String(sample.os || 'win32'),
    version: String(sample.version || ''),
    file: String(sample.file || ''),
    text: String(sample.text || '')
  };
  const varied = Object.assign({}, base, {
    message: /\d/.test(base.message) ? base.message.replace(/\d+/, '99999') : `${base.message} (retry)`
  });
  const negative = {
    error_type: 'NetworkError',
    message: 'ECONNREFUSED 127.0.0.1:443 连接被拒绝（与本次坑无关）',
    tool: 'fetch',
    os: base.os || 'win32',
    version: base.version || '',
    file: '',
    text: ''
  };
  return [
    { id: 'tc-positive-1', expect_trigger: true, input: base, expect_fix_kind: null },
    { id: 'tc-positive-2', expect_trigger: true, input: varied, expect_fix_kind: null },
    { id: 'tc-negative-1', expect_trigger: false, input: negative, expect_fix_kind: null }
  ];
}

/**
 * 推断 patch。
 * @param {{experience: Object, proposal?: Object, agent?: string, skillRoot?: string,
 *          targetPath?: string, version?: string, config?: Object, rollbackCount7d?: number}} input
 * @returns {Object} patch（aed/patch/1.0）
 */
function inferPatch(input = {}) {
  const exp = input.experience;
  if (!exp) throw new Error('inferPatch 需要 experience');
  const category = (exp.trigger && exp.trigger.category) || 'tool';
  const templates = loadTemplates().templates || {};
  const tpl = templates[category] || templates.tool;
  const agent = input.agent || (exp.applies_to && exp.applies_to[0]) || 'unknown';
  const targetPath = input.targetPath || 'SKILL.md';
  const version = input.version || '1.0.0';
  const confidence = Number((exp.fix && exp.fix.confidence) || (exp.trigger && 0.5));

  const steps = renderSteps(tpl.steps);
  const content = render(tpl.content, {
    fingerprint: exp.fingerprint,
    title: render(tpl.title, { error_type: (exp.sample_input && exp.sample_input.error_type) || 'Error' }),
    symptom: String(exp.symptom || '').slice(0, 300),
    confidence: confidence,
    steps,
    repro_command: (exp.repro && exp.repro.command) || 'node bin/aed.cjs agent replay',
    repro_expect: (exp.repro && exp.repro.expect) || '不再复现'
  });

  const ops = [{
    op: 'append_section',
    path: targetPath,
    anchor: tpl.anchor,
    content: `\n${content}\n`
  }];
  for (const extra of tpl.extra_ops || []) {
    if (extra.op === 'upsert_frontmatter') {
      ops.push({
        op: 'upsert_frontmatter',
        path: targetPath,
        key: extra.key || 'requires',
        value: 'lf-lineending;utf-8;node>=22'
      });
    }
  }

  const patch = {
    schema: 'aed/patch/1.0',
    id: id.patchId(),
    target: {
      agent,
      artifact: 'skill-md',
      path: targetPath,
      version
    },
    ops,
    testcases: buildTestcases(exp),
    risk: { level: 'low', blast_radius: (exp.applies_to || []).join(','), requires_human: false, human_reasons: [] },
    reverse_ops: [],
    created_by: 'aed/patch-infer',
    created_at: time.nowIso()
  };

  const testcases = patch.testcases;
  for (const tc of testcases) tc.expect_fix_kind = tpl.fix_kind;

  const risk = assessRisk({
    patch,
    experience: exp,
    attribution: { confidence },
    rollbackCount7d: input.rollbackCount7d || 0,
    changedBytes: content.length,
    skillBytes: input.skillRoot && fsx.exists(path.join(input.skillRoot, targetPath))
      ? fsx.statSafe(path.join(input.skillRoot, targetPath)).size
      : 0
  });
  patch.risk = risk;

  if (input.skillRoot) {
    dsl.validatePatch(patch, { skillRoot: input.skillRoot });
    patch.reverse_ops = dsl.computeReverseOps(patch, {
      before: fsx.readText(path.join(input.skillRoot, targetPath), '')
    });
  }
  return patch;
}

module.exports = { inferPatch, buildTestcases, loadTemplates, render, TEMPLATE_FILE };

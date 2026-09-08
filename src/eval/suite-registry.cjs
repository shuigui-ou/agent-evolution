/**
 * @module eval/suite-registry
 * @layer eval
 * @owner kou
 * 回归/合成用例集加载、校验与统计。
 * 用例形状：{ id, kind:'golden'|'synthetic', conditions, neg_match?, input, expect_trigger, note? }
 */

'use strict';

const path = require('node:path');
const fsx = require('../util/fsx.cjs');
const paths = require('../store/paths.cjs');
const { AedError } = require('../util/errors.cjs');

/** 用例必填字段 */
const REQUIRED = ['id', 'conditions', 'input', 'expect_trigger'];

/**
 * 校验单条用例。
 * @param {Object} c
 * @returns {string[]} 问题列表
 */
function validateCase(c) {
  const problems = [];
  if (!c || typeof c !== 'object') return ['用例必须为对象'];
  for (const f of REQUIRED) {
    if (c[f] === undefined) problems.push(`缺少字段 ${f}`);
  }
  if (c && typeof c.expect_trigger !== 'boolean') problems.push('expect_trigger 必须是布尔值');
  if (c && c.conditions && typeof c.conditions !== 'object') problems.push('conditions 必须是对象');
  if (c && c.input && typeof c.input !== 'object') problems.push('input 必须是对象');
  return problems;
}

/**
 * 加载用例集。
 * @param {{agent?: string, file?: string, config?: Object}} opts
 * @returns {{agent: string, file: string, golden: Object[], synthetic: Object[], all: Object[], problems: string[]}}
 */
function loadSuite(opts = {}) {
  let file = opts.file;
  if (!file) {
    const cfgFile = opts.config && opts.config.gate && opts.config.gate.regressionSuite;
    if (cfgFile) file = path.isAbsolute(cfgFile) ? cfgFile : path.join(paths.getRoot(), cfgFile);
    else file = paths.suiteFile(opts.agent || 'default');
  } else if (!path.isAbsolute(file)) {
    file = path.join(paths.getRoot(), file);
  }
  const raw = fsx.readJson(file, null);
  if (!raw) {
    throw new AedError('E_CONFIG_INVALID', `找不到用例集：${file}`, { file });
  }
  const golden = [];
  const synthetic = [];
  const problems = [];
  const cases = Array.isArray(raw.cases) ? raw.cases : [].concat(raw.golden || [], raw.synthetic || []);
  for (const c of cases) {
    const p = validateCase(c);
    if (p.length) {
      problems.push(`${(c && c.id) || '?'}: ${p.join('; ')}`);
      continue;
    }
    const kind = c.kind || 'golden';
    if (kind === 'synthetic') synthetic.push(c);
    else golden.push(c);
  }
  return {
    agent: raw.agent || opts.agent || 'unknown',
    version: raw.version || '1.0.0',
    file,
    golden,
    synthetic,
    all: golden.concat(synthetic),
    problems
  };
}

/**
 * 统计信息。
 * @param {Object} suite
 * @returns {{total: number, golden: number, synthetic: number, positive: number, negative: number}}
 */
function stats(suite) {
  const all = suite.all || [];
  return {
    total: all.length,
    golden: (suite.golden || []).length,
    synthetic: (suite.synthetic || []).length,
    positive: all.filter((c) => c.expect_trigger === true).length,
    negative: all.filter((c) => c.expect_trigger === false).length
  };
}

module.exports = { loadSuite, validateCase, stats };

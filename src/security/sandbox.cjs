/**
 * @module security/sandbox
 * @layer security
 * @owner kou
 * 沙箱：① 纯函数级 match 条件求值（结构匹配 + node:vm 表达式，不给 require）；
 *      ② 子进程环境约束工具（供 eval/sandbox-runner 使用）。
 */

'use strict';

const vm = require('node:vm');

/**
 * 简易 glob 匹配（支持 * 与 ?）。
 * @param {string} value
 * @param {string} pattern
 * @returns {boolean}
 */
function globMatch(value, pattern) {
  const esc = String(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${esc}$`, 'i').test(String(value));
}

/**
 * 比较版本号（支持 '1.2.3' 与 'v1.2.3'）。
 * @param {string} a
 * @param {string} b
 * @returns {number} -1 / 0 / 1
 */
function compareVersion(a, b) {
  const pa = String(a || '').replace(/^v/, '').split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b || '').replace(/^v/, '').split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i += 1) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

/**
 * 解析版本区间字符串，如 '>=1.2.0 <2.0.0' 或 '^1.2.0' 或 '1.2.3'。
 * @param {string} range
 * @returns {Array<{op: string, ver: string}>}
 */
function parseVersionRange(range) {
  const out = [];
  const re = /(>=|<=|==|=|>|<|\^|~)?\s*v?([0-9]+(?:\.[0-9]+){0,2})/g;
  let m;
  while ((m = re.exec(String(range || ''))) !== null) {
    out.push({ op: m[1] || '=', ver: m[2] });
  }
  return out;
}

/**
 * 判断版本是否落在区间内。
 * @param {string} version
 * @param {string} range
 * @returns {boolean}
 */
function versionInRange(version, range) {
  const clauses = parseVersionRange(range);
  if (clauses.length === 0) return true;
  const v = String(version || '').replace(/^v/, '');
  return clauses.every(({ op, ver }) => {
    const c = compareVersion(v, ver);
    switch (op) {
      case '>=': return c >= 0;
      case '<=': return c <= 0;
      case '>': return c > 0;
      case '<': return c < 0;
      case '^': {
        const [maj] = ver.split('.');
        return c >= 0 && String(v).split('.')[0] === maj;
      }
      case '~': {
        const [maj, min] = ver.split('.');
        const vp = String(v).split('.');
        return c >= 0 && vp[0] === maj && (min === undefined || vp[1] === min);
      }
      default: return c === 0;
    }
  });
}

/**
 * 安全正则测试（防止非法正则 / 超长输入导致 ReDoS）。
 * @param {string} message
 * @param {string} pattern
 * @returns {boolean}
 */
function safeRegexTest(message, pattern) {
  try {
    if (String(pattern).length > 300) return false;
    return new RegExp(pattern, 'i').test(String(message || ''));
  } catch (_e) {
    return false;
  }
}

/**
 * 在受限 vm 中求值简单布尔表达式（不暴露 require / process）。
 * @param {string} expr
 * @param {Object} context 允许的变量白名单
 * @returns {{ok: boolean, value: any, error: string|null}}
 */
function safeEvalExpr(expr, context = {}) {
  const sandbox = Object.freeze(Object.assign(Object.create(null), context));
  try {
    const script = new vm.Script(`(function(){ return (${expr}); })()`, { timeout: 200 });
    const value = script.runInNewContext(sandbox, { timeout: 200, displayErrors: false });
    return { ok: true, value, error: null };
  } catch (e) {
    return { ok: false, value: false, error: (e && e.message) || String(e) };
  }
}

/**
 * 纯函数：判断输入是否命中 trigger.match 条件。
 * 语义：字段内 OR、字段间 AND；neg_match 任一命中则不触发；无任何约束则不触发。
 * @param {Object} conditions trigger.match
 * @param {Object} input {error_type, message, tool, os, version, file}
 * @param {{neg_match?: Object, expr?: string}} [opts]
 * @returns {{matched: boolean, fields: string[]}}
 */
function matchConditions(conditions, input, opts = {}) {
  const c = conditions || {};
  const i = input || {};
  const fields = [];
  const miss = [];

  const anyOf = (list, predicate) => Array.isArray(list) && list.length > 0 && list.some(predicate);

  if (Array.isArray(c.error_type) && c.error_type.length) {
    (anyOf(c.error_type, (x) => String(i.error_type || '') === x) ? fields : miss).push('error_type');
  }
  if (Array.isArray(c.message_regex) && c.message_regex.length) {
    (anyOf(c.message_regex, (re) => safeRegexTest(i.message, re)) ? fields : miss).push('message_regex');
  }
  if (Array.isArray(c.tool) && c.tool.length) {
    (anyOf(c.tool, (x) => String(i.tool || '') === x) ? fields : miss).push('tool');
  }
  if (Array.isArray(c.os) && c.os.length) {
    (anyOf(c.os, (x) => String(i.os || '') === x) ? fields : miss).push('os');
  }
  if (Array.isArray(c.file_glob) && c.file_glob.length) {
    (anyOf(c.file_glob, (g) => globMatch(i.file, g)) ? fields : miss).push('file_glob');
  }
  if (Array.isArray(c.keywords) && c.keywords.length) {
    const hay = `${i.message || ''} ${i.text || ''} ${i.error_type || ''}`.toLowerCase();
    (anyOf(c.keywords, (k) => hay.includes(String(k).toLowerCase())) ? fields : miss).push('keywords');
  }
  if (typeof c.version_range === 'string' && c.version_range.length) {
    (versionInRange(i.version, c.version_range) ? fields : miss).push('version_range');
  }

  let matched = fields.length > 0 && miss.length === 0;

  if (matched && opts.expr) {
    const r = safeEvalExpr(opts.expr, { input: i });
    if (!r.ok || r.value !== true) matched = false;
  }

  if (matched && opts.neg_match) {
    const neg = matchConditions(opts.neg_match, i);
    if (neg.matched) matched = false;
  }

  return { matched, fields };
}

/**
 * 构造子进程最小环境变量（不继承任何凭据）。
 * @param {{tmpDir?: string, extra?: Object}} [opts]
 * @returns {Object}
 */
function minimalEnv(opts = {}) {
  const env = {
    AED_SANDBOX: '1',
    NODE_ENV: 'sandbox',
    TEMP: opts.tmpDir || require('node:os').tmpdir(),
    TMP: opts.tmpDir || require('node:os').tmpdir()
  };
  if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  if (process.env.PATH) env.PATH = process.env.PATH; // 仅用于定位系统 DLL，不含任何凭据
  return Object.assign(env, opts.extra || {});
}

module.exports = {
  matchConditions,
  safeEvalExpr,
  safeRegexTest,
  globMatch,
  compareVersion,
  versionInRange,
  parseVersionRange,
  minimalEnv
};

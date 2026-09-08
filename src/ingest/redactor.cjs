/**
 * @module ingest/redactor
 * @layer ingest
 * @owner kou
 * 敏感信息脱敏：私钥 / API Key / Token / JWT / 环境变量凭据 / 高熵串 / 绝对路径（可选）。
 * 命中即替换为 «REDACTED:xxx»。
 */

'use strict';

const { entropy } = require('../util/hash.cjs');

/** 规则表：顺序执行，命中即替换 */
const PATTERNS = [
  { id: 'PRIVATE_KEY', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*-----/g },
  { id: 'OPENAI_KEY', re: /sk-[A-Za-z0-9]{20,}/g },
  { id: 'ANTHROPIC_KEY', re: /sk-ant-[A-Za-z0-9\-]{20,}/g },
  { id: 'GITHUB_TOKEN', re: /gh[pousr]_[A-Za-z0-9]{30,}/g },
  { id: 'JWT', re: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  { id: 'ENV_CRED', re: /(TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|APIKEY|COOKIE|ACCESS_KEY)=[^\s"']{6,}/g }
];

/**
 * 判断是否像文件路径 / URL / 纯 hex 摘要（这些不该被当成密钥）。
 * @param {string} s
 * @returns {boolean}
 */
function looksBenign(s) {
  if (/^[0-9a-f]+$/i.test(s)) return true;             // 纯 hex（md5/sha 摘要）
  if (/^[\\/]/.test(s) || /^[a-zA-Z]:[\\/]/.test(s)) return true; // 路径
  if (/^https?:\/\//i.test(s)) return true;
  if (/^[a-z]:[0-9a-z]{16,}$/i.test(s)) return true;   // id 前缀
  return false;
}

/**
 * 高熵串检测并替换。
 * @param {string} text
 * @returns {{text: string, hit: boolean}}
 */
function redactHighEntropy(text) {
  let hit = false;
  const out = text.replace(/[^\s"'`,;]{24,}/g, (m) => {
    if (looksBenign(m)) return m;
    if (entropy(m) <= 4.2) return m;
    hit = true;
    return `«REDACTED:HIGH_ENTROPY:${m.length}»`;
  });
  return { text: out, hit };
}

/**
 * 脱敏一段文本。
 * @param {string} text
 * @param {{redactPaths?: boolean, homePattern?: RegExp}} [opts]
 * @returns {{text: string, redacted: boolean, hits: string[]}}
 */
function redact(text, opts = {}) {
  let out = String(text == null ? '' : text);
  const hits = [];
  for (const p of PATTERNS) {
    out = out.replace(p.re, (m) => {
      hits.push(p.id);
      return `«REDACTED:${p.id}»`;
    });
  }
  const r = redactHighEntropy(out);
  if (r.hit) {
    hits.push('HIGH_ENTROPY');
    out = r.text;
  }
  if (opts.redactPaths) {
    const before = out;
    out = out.replace(/[A-Za-z]:[\\/]Users[\\/][^\\/\s"']+/g, '~');
    out = out.replace(/\/home\/[^/\s"']+/g, '~');
    if (out !== before) hits.push('PATH');
  }
  return { text: out, redacted: hits.length > 0, hits: Array.from(new Set(hits)) };
}

/**
 * 递归脱敏对象内所有字符串。
 * @param {*} node
 * @param {Object} [opts]
 * @returns {{value: *, redacted: boolean, hits: string[]}}
 */
function redactDeep(node, opts = {}) {
  const hits = new Set();
  const walk = (v) => {
    if (typeof v === 'string') {
      const r = redact(v, opts);
      r.hits.forEach((h) => hits.add(h));
      return r.text;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out = {};
      for (const k of Object.keys(v)) out[k] = walk(v[k]);
      return out;
    }
    return v;
  };
  const value = walk(node);
  return { value, redacted: hits.size > 0, hits: Array.from(hits) };
}

module.exports = { redact, redactDeep, PATTERNS, looksBenign };

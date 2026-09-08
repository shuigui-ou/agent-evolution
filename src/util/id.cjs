/**
 * @module util/id
 * @layer util
 * @owner kou
 * 时间序 ID 生成：`<prefix>_<22位 base32>`，前 9 位为毫秒时间戳（可排序），后 13 位随机。
 */

'use strict';

const crypto = require('node:crypto');

/** 小写 base32 字母表（满足 schema 的 ^[0-9a-z]{16,}$） */
const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
const ALPHABET_LEN = 32;

/** 各实体 ID 前缀 */
const PREFIX = Object.freeze({
  TRACE: 'te',
  EXPERIENCE: 'exp',
  SIGNAL: 'xs',
  PROPOSAL: 'pr',
  PATCH: 'pt',
  GATE_RESULT: 'gr',
  CREDIT: 'cr',
  SKILL: 'skl'
});

/**
 * 非负整数转 base32 定长串。
 * @param {number} n
 * @param {number} width
 * @returns {string}
 */
function toBase32(n, width) {
  let v = Math.max(0, Math.floor(n));
  let s = '';
  for (let i = 0; i < width; i += 1) {
    s = ALPHABET[v % ALPHABET_LEN] + s;
    v = Math.floor(v / ALPHABET_LEN);
  }
  return s;
}

/**
 * 生成随机后缀（使用 crypto，非 Math.random）。
 * @param {number} len
 * @returns {string}
 */
function randomSuffix(len) {
  const bytes = crypto.randomBytes(len);
  let s = '';
  for (let i = 0; i < len; i += 1) {
    s += ALPHABET[bytes[i] % ALPHABET_LEN];
  }
  return s;
}

/**
 * 生成时间序 ID。
 * @param {string} prefix 前缀，如 'te'
 * @param {number} [ts] 毫秒时间戳，默认 Date.now()
 * @returns {string} 形如 te_1a2b3c4d5abcdefghijklmn
 */
function newId(prefix, ts = Date.now()) {
  return `${prefix}_${toBase32(ts, 9)}${randomSuffix(13)}`;
}

const ID_BUILDERS = {
  traceId: (ts) => newId(PREFIX.TRACE, ts),
  experienceId: (ts) => newId(PREFIX.EXPERIENCE, ts),
  signalId: (ts) => newId(PREFIX.SIGNAL, ts),
  proposalId: (ts) => newId(PREFIX.PROPOSAL, ts),
  patchId: (ts) => newId(PREFIX.PATCH, ts),
  gateResultId: (ts) => newId(PREFIX.GATE_RESULT, ts),
  creditId: (ts) => newId(PREFIX.CREDIT, ts),
  skillId: (ts) => newId(PREFIX.SKILL, ts)
};

/**
 * 解析 ID，取回前缀与时间戳。
 * @param {string} id
 * @returns {{prefix: string, ts: number}|null}
 */
function parseId(id) {
  if (typeof id !== 'string') return null;
  const idx = id.indexOf('_');
  if (idx <= 0) return null;
  const prefix = id.slice(0, idx);
  const body = id.slice(idx + 1);
  if (body.length < 9) return null;
  let ts = 0;
  for (let i = 0; i < 9; i += 1) {
    const p = ALPHABET.indexOf(body[i]);
    if (p < 0) return null;
    ts = ts * ALPHABET_LEN + p;
  }
  return { prefix, ts };
}

module.exports = {
  PREFIX,
  newId,
  parseId,
  toBase32,
  randomSuffix,
  ...ID_BUILDERS
};

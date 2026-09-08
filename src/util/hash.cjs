/**
 * @module util/hash
 * @layer util
 * @owner kou
 * sha256 / canonical_json / 64 位 SimHash / 汉明距离 / 香农熵。
 */

'use strict';

const crypto = require('node:crypto');

/**
 * sha256 hex。
 * @param {string|Buffer} data
 * @returns {string}
 */
function sha256(data) {
  return crypto.createHash('sha256').update(data, 'utf8').digest('hex');
}

/**
 * canonical JSON：key 升序、无多余空白，保证同一对象恒定得到同一字节串。
 * @param {*} value
 * @returns {string}
 */
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value)
    .filter((k) => value[k] !== undefined)
    .sort();
  const body = keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',');
  return `{${body}}`;
}

/**
 * 由若干片段生成 16 位指纹。
 * @param {Array<string|number|undefined|null>} parts
 * @returns {string}
 */
function fingerprint(parts) {
  return sha256(parts.map((p) => String(p == null ? '' : p)).join('|')).slice(0, 16);
}

/**
 * 归一化：去掉数字、路径、UUID、空白，统一小写（用于失败指纹稳定性）。
 * @param {string} text
 * @returns {string}
 */
function normalizeForFingerprint(text) {
  return String(text == null ? '' : text)
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
    .replace(/\b[0-9a-f]{16,}\b/gi, '<hex>')
    .replace(/\d+/g, '<n>')
    .replace(/[a-zA-Z]:[\\/][^\s'"]*/g, '<path>')
    .replace(/\/[^\s'"]*/g, '<path>')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * 生成 3-gram 词元（兼容中文：归一化后去掉空白与标点，按字符滑窗）。
 * 不额外加入整段“巨词”：无空格中文整段一旦被整枚哈希，尾部追加会让该词元
 * 整体变化并放大 SimHash 汉明距离，因此只保留规格约定的字符 3-gram。
 * @param {string} text
 * @returns {string[]}
 */
function tokens3(text) {
  const s = normalizeForFingerprint(text).replace(/<path>|<n>|<uuid>|<hex>/g, ' ');
  const cleaned = s.replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  if (!cleaned) return [];
  const compact = cleaned.replace(/\s+/g, '');
  const out = [];
  for (let i = 0; i + 3 <= compact.length; i += 1) out.push(compact.slice(i, i + 3));
  return out;
}

/**
 * 按字段加权生成 64 位 SimHash，返回 16 位 hex。
 * 弱指纹用于“疑似重复”候选，应以问题描述（标题/现象）为主；修复文案措辞
 * 天然多变，权重应低于标题/现象，避免“同标题+symptom、fix 尾部小幅追加”
 * 被放大成不可忽略的汉明距离。
 * @param {Array<{text?: string, weight?: number}>} fields
 * @returns {string}
 */
function simhashWeighted(fields) {
  const vec = new Array(64).fill(0);
  let total = 0;
  for (const f of fields || []) {
    const w = (f && Number.isFinite(f.weight)) ? f.weight : 1;
    for (const t of tokens3((f && f.text) || '')) {
      total += 1;
      const h = crypto.createHash('sha256').update(t, 'utf8').digest();
      for (let i = 0; i < 64; i += 1) {
        const byte = h[i >> 3];
        const bit = (byte >> (7 - (i & 7))) & 1;
        vec[i] += (bit ? 1 : -1) * w;
      }
    }
  }
  if (total === 0) return '0'.repeat(16);
  let out = '';
  for (let i = 0; i < 64; i += 4) {
    let nibble = 0;
    for (let j = 0; j < 4; j += 1) nibble = (nibble << 1) | (vec[i + j] > 0 ? 1 : 0);
    out += nibble.toString(16);
  }
  return out;
}

/**
 * 64 位 SimHash，返回 16 位 hex（等价于整段文本权重 1 的加权 SimHash）。
 * @param {string} text
 * @returns {string}
 */
function simhash(text) {
  return simhashWeighted([{ text: String(text == null ? '' : text), weight: 1 }]);
}

/**
 * 两个 hex 串的汉明距离（按 bit 计算）。
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function hammingDistanceHex(a, b) {
  const len = Math.min(String(a).length, String(b).length);
  let dist = 0;
  for (let i = 0; i < len; i += 1) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (x) {
      dist += x & 1;
      x >>= 1;
    }
  }
  return dist + (String(a).length - len + String(b).length - len) * 4;
}

/**
 * 香农熵（bit/char）。
 * @param {string} text
 * @returns {number}
 */
function entropy(text) {
  const s = String(text == null ? '' : text);
  if (s.length === 0) return 0;
  const freq = new Map();
  for (const ch of s) freq.set(ch, (freq.get(ch) || 0) + 1);
  let h = 0;
  for (const c of freq.values()) {
    const p = c / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/**
 * 稳定分桶（不用 Math.random）。
 * @param {string} key
 * @param {number} buckets
 * @returns {number} [0, buckets)
 */
function stableBucket(key, buckets) {
  const n = parseInt(sha256(String(key)).slice(0, 8), 16);
  return n % Math.max(1, buckets);
}

module.exports = {
  sha256,
  canonicalJson,
  fingerprint,
  normalizeForFingerprint,
  tokens3,
  simhash,
  simhashWeighted,
  hammingDistanceHex,
  entropy,
  stableBucket
};

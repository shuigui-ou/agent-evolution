/**
 * @module external/dedupe
 * @layer external
 * @owner kou
 * 双层去重：强指纹（精确重复）+ 64 位 SimHash（疑似重复，汉明距离 ≤3）。
 */

'use strict';

const hash = require('../util/hash.cjs');

/**
 * 弱指纹中 fix 文本的权重：fix 措辞/篇幅天然多变（追加说明、换种写法很常见），
 * 权重低于标题与现象，确保“同标题+symptom 的小幅 fix 变化”不会被 SimHash 放大。
 */
const WEAK_FIX_WEIGHT = 0.4;

/**
 * 归一化触发条件。
 * @param {*} trigger
 * @returns {string}
 */
function normalizeTrigger(trigger) {
  if (!trigger) return '';
  if (typeof trigger === 'string') return hash.normalizeForFingerprint(trigger);
  const match = trigger.match || trigger;
  const keys = Object.keys(match).sort();
  return hash.normalizeForFingerprint(keys.map((k) => `${k}=${JSON.stringify(match[k])}`).join('&'));
}

/**
 * 归一化修复内容。
 * @param {*} fix
 * @returns {string}
 */
function normalizeFix(fix) {
  if (!fix) return '';
  if (typeof fix === 'string') return hash.normalizeForFingerprint(fix);
  return hash.normalizeForFingerprint(`${fix.kind || ''}|${fix.text || ''}|${(fix.steps || []).join(';')}`);
}

/**
 * 强指纹。
 * @param {{kind?: string, payload?: Object, source?: Object}} signal
 * @returns {string}
 */
function strongFingerprint(signal) {
  const payload = signal.payload || {};
  return hash.fingerprint([
    signal.kind || '',
    normalizeTrigger(payload.trigger),
    normalizeFix(payload.fix)
  ]);
}

/**
 * 弱指纹（SimHash）：标题 + symptom + fix 的 3-gram；fix 权重较低以抑制尾部追加。
 * @param {{payload?: Object}} signal
 * @returns {string}
 */
function weakSimhash(signal) {
  const p = signal.payload || {};
  const fix = (p.fix && p.fix.text) || p.fix || '';
  return hash.simhashWeighted([
    { text: p.title || '', weight: 1 },
    { text: p.symptom || '', weight: 1 },
    { text: fix, weight: WEAK_FIX_WEIGHT }
  ]);
}

/**
 * 在已有信号/经验中查找重复。
 * @param {Object} signal
 * @param {Object[]} existing 数组元素需含 id 与 (fingerprint|simhash)
 * @param {{hammingThreshold?: number}} [opts]
 * @returns {{dup: 'strong'|'weak'|null, match: Object|null, hamming: number|null}}
 */
function findDuplicate(signal, existing, opts = {}) {
  const threshold = opts.hammingThreshold == null ? 3 : opts.hammingThreshold;
  const fp = (signal.dedupe && signal.dedupe.fingerprint) || signal.fingerprint || strongFingerprint(signal);
  const sh = (signal.dedupe && signal.dedupe.simhash) || signal.simhash || weakSimhash(signal);
  for (const e of existing || []) {
    const efp = (e.dedupe && e.dedupe.fingerprint) || e.fingerprint;
    if (efp && efp === fp) return { dup: 'strong', match: e, hamming: 0 };
  }
  let best = null;
  let bestD = 99;
  for (const e of existing || []) {
    const esh = (e.dedupe && e.dedupe.simhash) || e.simhash;
    if (!esh) continue;
    const d = hash.hammingDistanceHex(esh, sh);
    if (d < bestD) {
      bestD = d;
      best = e;
    }
  }
  if (best && bestD <= threshold) return { dup: 'weak', match: best, hamming: bestD };
  return { dup: null, match: null, hamming: best ? bestD : null };
}

module.exports = { strongFingerprint, weakSimhash, findDuplicate, normalizeTrigger, normalizeFix, WEAK_FIX_WEIGHT };

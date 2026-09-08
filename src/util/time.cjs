/**
 * @module util/time
 * @layer util
 * @owner kou
 * ISO 8601 UTC 时间工具、时间窗与 TTL 判定。
 */

'use strict';

/**
 * 当前时间 ISO 字符串。
 * @param {number} [ts]
 * @returns {string}
 */
function nowIso(ts = Date.now()) {
  return new Date(ts).toISOString();
}

/**
 * ISO -> 毫秒；非法返回 NaN。
 * @param {string} iso
 * @returns {number}
 */
function parseIso(iso) {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : NaN;
}

/**
 * 日期键 YYYY-MM-DD（UTC）。
 * @param {number} [ts]
 * @returns {string}
 */
function dayKey(ts = Date.now()) {
  return new Date(ts).toISOString().slice(0, 10);
}

/**
 * 月份键 YYYY-MM（UTC）。
 * @param {number} [ts]
 * @returns {string}
 */
function monthKey(ts = Date.now()) {
  return new Date(ts).toISOString().slice(0, 7);
}

/**
 * 加减天数。
 * @param {number|string} base 时间戳或 ISO
 * @param {number} days 可为负
 * @returns {number} 毫秒时间戳
 */
function addDays(base, days) {
  const t = typeof base === 'number' ? base : parseIso(base);
  return t + days * 86400000;
}

/**
 * 两个时间相差天数（a - b，保留小数）。
 * @param {number|string} a
 * @param {number|string} b
 * @returns {number}
 */
function diffDays(a, b) {
  const ta = typeof a === 'number' ? a : parseIso(a);
  const tb = typeof b === 'number' ? b : parseIso(b);
  return (ta - tb) / 86400000;
}

/**
 * 判断是否已过期。
 * @param {string} iso 起始时间
 * @param {number} ttlDays TTL 天数
 * @param {number} [nowTs]
 * @returns {boolean}
 */
function isExpired(iso, ttlDays, nowTs = Date.now()) {
  const t = parseIso(iso);
  if (!Number.isFinite(t)) return false;
  if (!Number.isFinite(ttlDays) || ttlDays <= 0) return false;
  return nowTs - t > ttlDays * 86400000;
}

/**
 * 解析 'HH:MM'（24 小时制）为当天毫秒时间戳。
 * @param {string} hhmm
 * @param {number} [nowTs]
 * @returns {number|null}
 */
function hhmmToTs(hhmm, nowTs = Date.now()) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  const d = new Date(nowTs);
  d.setUTCHours(h, mi, 0, 0);
  return d.getTime();
}

module.exports = {
  nowIso,
  parseIso,
  dayKey,
  monthKey,
  addDays,
  diffDays,
  isExpired,
  hhmmToTs
};

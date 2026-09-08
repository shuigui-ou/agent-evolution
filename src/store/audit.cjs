/**
 * @module store/audit
 * @layer store
 * @owner kou
 * 审计日志：append-only + hash chain（prev_hash -> sha256(prev_hash + canonical_json(rec))）+ 完整性校验。
 */

'use strict';

const fsx = require('../util/fsx.cjs');
const paths = require('./paths.cjs');
const { sha256, canonicalJson } = require('../util/hash.cjs');
const time = require('../util/time.cjs');
const id = require('../util/id.cjs');
const { AedError } = require('../util/errors.cjs');

const GENESIS = '0'.repeat(64);

/**
 * 计算某条记录的链哈希。
 * @param {string} prevHash
 * @param {Object} rec 不含 hash 字段的记录
 * @returns {string}
 */
function chainHash(prevHash, rec) {
  return sha256(`${prevHash}${canonicalJson(rec)}`);
}

/**
 * 读取某月审计文件的全部记录。
 * @param {string} month YYYY-MM
 * @returns {Object[]}
 */
function readMonth(month) {
  return fsx.readJsonLines(paths.auditFile(month)).records;
}

/**
 * 列出所有审计月份文件（排序）。
 * @returns {string[]} 月份键数组
 */
function listMonths() {
  return fsx.listFiles(paths.auditDir(), /^\d{4}-\d{2}\.jsonl$/)
    .map((f) => f.split(/[\\/]/).pop().replace(/\.jsonl$/, ''))
    .sort();
}

/**
 * 读取全部审计记录（跨月，按时间升序）。
 * @returns {Object[]}
 */
function readAll() {
  const out = [];
  for (const m of listMonths()) out.push(...readMonth(m));
  return out;
}

/**
 * 追加一条审计事件（自动补 ts / prev_hash / hash）。
 * @param {{action: string, actor?: string, target?: Object, detail?: Object}} event
 * @param {{month?: string, ts?: number}} [opts]
 * @returns {Object} 完整记录
 */
function append(event, opts = {}) {
  const month = opts.month || time.monthKey(opts.ts || Date.now());
  const file = paths.auditFile(month);
  const prevRecords = fsx.readJsonLines(file).records;
  const prevHash = prevRecords.length ? (prevRecords[prevRecords.length - 1].hash || GENESIS) : GENESIS;
  const rec = Object.assign({}, event, {
    id: event.id || id.creditId(opts.ts || Date.now()),
    ts: event.ts || time.nowIso(opts.ts || Date.now()),
    prev_hash: prevHash
  });
  const recHash = chainHash(prevHash, Object.assign({}, rec, { hash: undefined }));
  const full = Object.assign({}, rec, { hash: recHash });
  fsx.appendLine(file, JSON.stringify(full));
  return full;
}

/**
 * 校验审计链完整性。
 * @param {{month?: string}} [opts]
 * @returns {{ok: boolean, checked: number, broken_at: string|null, reason: string|null}}
 */
function verify(opts = {}) {
  const months = opts.month ? [opts.month] : listMonths();
  let checked = 0;
  let prevHash = GENESIS;
  for (const m of months) {
    const records = readMonth(m);
    for (const rec of records) {
      const { hash, ...rest } = rec;
      if (rest.prev_hash !== prevHash) {
        return { ok: false, checked, broken_at: rec.id, reason: 'PREV_HASH_MISMATCH' };
      }
      if (chainHash(prevHash, rest) !== hash) {
        return { ok: false, checked, broken_at: rec.id, reason: 'HASH_MISMATCH' };
      }
      prevHash = hash;
      checked += 1;
    }
  }
  return { ok: true, checked, broken_at: null, reason: null };
}

/**
 * 断言审计链完整，否则抛错。
 * @param {{month?: string}} [opts]
 * @returns {Object} verify 结果
 */
function verifyOrThrow(opts) {
  const res = verify(opts);
  if (!res.ok) {
    throw new AedError('E_AUDIT_BROKEN', `审计链校验失败：${res.reason} @ ${res.broken_at}`, res);
  }
  return res;
}

module.exports = { GENESIS, append, readAll, readMonth, listMonths, verify, verifyOrThrow, chainHash };

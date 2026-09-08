/**
 * @module store/jsonl
 * @layer store
 * @owner kou
 * JSONL 读写：追加（\n 换行）、读取（兼容 \r\n）、按唯一键去重、按日轮转、gzip 归档。
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const fsx = require('../util/fsx.cjs');

/** 已加载过的唯一键集合：file -> Set<string> */
const KEY_CACHE = new Map();

/**
 * 追加一条记录（JSON 单行 + \n）。
 * @param {string} file
 * @param {Object} record
 * @returns {void}
 */
function appendRecord(file, record) {
  fsx.ensureDir(path.dirname(file));
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
}

/**
 * 追加记录，带进程内唯一键去重（重放安全）。
 * @param {string} file
 * @param {Object} record
 * @param {(rec: Object) => string} keyFn
 * @returns {boolean} true=实际写入，false=重复被跳过
 */
function appendUnique(file, record, keyFn) {
  if (!KEY_CACHE.has(file)) {
    const set = new Set();
    for (const line of fsx.readLines(file)) {
      try {
        set.add(keyFn(JSON.parse(line)));
      } catch (_e) { /* 坏行忽略 */ }
    }
    KEY_CACHE.set(file, set);
  }
  const set = KEY_CACHE.get(file);
  const key = keyFn(record);
  if (set.has(key)) return false;
  set.add(key);
  appendRecord(file, record);
  return true;
}

/**
 * 清空某文件的去重缓存（文件被轮转/删除后调用）。
 * @param {string} file
 * @returns {void}
 */
function resetUniqueCache(file) {
  if (file) KEY_CACHE.delete(file);
  else KEY_CACHE.clear();
}

/**
 * 读取全部记录。
 * @param {string} file
 * @returns {{records: Object[], bad: number}}
 */
function readRecords(file) {
  return fsx.readJsonLines(file);
}

/**
 * 追加一批记录。
 * @param {string} file
 * @param {Object[]} records
 * @returns {number} 写入条数
 */
function appendAll(file, records) {
  let n = 0;
  for (const r of records) {
    appendRecord(file, r);
    n += 1;
  }
  return n;
}

/**
 * 覆写整个文件（原子）。
 * @param {string} file
 * @param {Object[]} records
 * @returns {void}
 */
function writeAll(file, records) {
  const body = records.map((r) => JSON.stringify(r)).join('\n');
  fsx.atomicWrite(file, body.length ? `${body}\n` : '');
}

/**
 * 体积超阈值则按日轮转（file -> file.YYYY-MM-DD）。
 * @param {string} file
 * @param {number} maxBytes
 * @returns {string|null} 轮转后的旧文件路径，未轮转返回 null
 */
function rotateBySize(file, maxBytes = 200 * 1024 * 1024) {
  const st = fsx.statSafe(file);
  if (!st || st.size < maxBytes) return null;
  const day = new Date().toISOString().slice(0, 10);
  const target = `${file}.${day}`;
  fs.renameSync(file, target);
  resetUniqueCache(file);
  return target;
}

/**
 * gzip 归档（归档后删除原文件）。
 * @param {string} file
 * @returns {string|null} 生成的 .gz 路径
 */
function gzipArchive(file) {
  if (!fsx.exists(file)) return null;
  const raw = fs.readFileSync(file);
  const gz = zlib.gzipSync(raw, { level: 9 });
  const out = `${file}.gz`;
  fs.writeFileSync(out, gz);
  fs.unlinkSync(file);
  resetUniqueCache(file);
  return out;
}

module.exports = {
  appendRecord,
  appendUnique,
  appendAll,
  writeAll,
  readRecords,
  resetUniqueCache,
  rotateBySize,
  gzipArchive
};

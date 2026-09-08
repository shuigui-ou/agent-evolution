/**
 * @module util/fsx
 * @layer util
 * @owner kou
 * 文件与目录工具：原子写、JSONL 追加、目录保障、递归拷贝与删除。
 * 所有写入统一 utf8；JSONL 换行统一 \n；读取兼容 \r\n。
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

/**
 * 保障目录存在（递归）。
 * @param {string} dir
 * @returns {string} dir
 */
function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 判断路径是否存在。
 * @param {string} p
 * @returns {boolean}
 */
function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch (_e) {
    return false;
  }
}

/**
 * 读取文本，不存在返回 fallback。
 * @param {string} file
 * @param {string} [fallback]
 * @returns {string}
 */
function readText(file, fallback = '') {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (_e) {
    return fallback;
  }
}

/**
 * 读取并解析 JSON，失败返回 fallback。
 * @param {string} file
 * @param {*} [fallback]
 * @returns {*}
 */
function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_e) {
    return fallback;
  }
}

/**
 * 普通写文本（非原子）。
 * @param {string} file
 * @param {string} data
 * @returns {void}
 */
function writeText(file, data) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, data, 'utf8');
}

/**
 * 原子写：tmp 文件 + rename。
 * @param {string} file
 * @param {string} data
 * @param {{encoding?: BufferEncoding}} [opts]
 * @returns {void}
 */
function atomicWrite(file, data, opts = {}) {
  const encoding = opts.encoding || 'utf8';
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
  fs.writeFileSync(tmp, data, encoding);
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_e2) { /* 忽略清理失败 */ }
    throw e;
  }
}

/**
 * 原子写 JSON（带缩进，便于人工查看）。
 * @param {string} file
 * @param {*} value
 * @returns {void}
 */
function atomicWriteJson(file, value) {
  atomicWrite(file, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * 追加一行到文件（换行统一 \n）。
 * @param {string} file
 * @param {string} line
 * @returns {void}
 */
function appendLine(file, line) {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, `${line}\n`, 'utf8');
}

/**
 * 读取所有非空行（兼容 \r\n），自动去掉 BOM。
 * @param {string} file
 * @returns {string[]}
 */
function readLines(file) {
  if (!exists(file)) return [];
  let raw = readText(file, '');
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  return raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
}

/**
 * 逐行解析 JSON，跳过坏行。
 * @param {string} file
 * @returns {{records: any[], bad: number}}
 */
function readJsonLines(file) {
  const records = [];
  let bad = 0;
  for (const line of readLines(file)) {
    try {
      records.push(JSON.parse(line));
    } catch (_e) {
      bad += 1;
    }
  }
  return { records, bad };
}

/**
 * 列出目录下匹配正则的文件（非递归，除非 pattern 含分隔符）。
 * @param {string} dir
 * @param {RegExp} [pattern]
 * @returns {string[]} 排序后的绝对路径
 */
function listFiles(dir, pattern = /.*/) {
  if (!exists(dir)) return [];
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    let st;
    try { st = fs.statSync(full); } catch (_e) { continue; }
    if (st.isFile() && pattern.test(name)) out.push(full);
  }
  return out.sort();
}

/**
 * 简易通配展开：仅支持最后一段的 `*` 与 `?`。
 * @param {string} pattern
 * @returns {string[]}
 */
function expandGlob(pattern) {
  const p = path.resolve(pattern);
  const base = path.dirname(p);
  const tail = path.basename(p);
  if (!tail.includes('*') && !tail.includes('?')) {
    return exists(p) ? [p] : [];
  }
  if (!exists(base)) return [];
  const re = new RegExp(`^${tail.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/\\\\]*').replace(/\?/g, '[^/\\\\]')}$`);
  return listFiles(base).filter((f) => re.test(path.basename(f)));
}

/**
 * 获取文件 stat，不存在返回 null。
 * @param {string} file
 * @returns {fs.Stats|null}
 */
function statSafe(file) {
  try {
    return fs.statSync(file);
  } catch (_e) {
    return null;
  }
}

/**
 * 递归创建临时目录。
 * @param {string} [prefix]
 * @returns {string}
 */
function mkTmpDir(prefix = 'aed-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * 递归拷贝目录（src -> dst，dst 不存在则创建）。
 * @param {string} src
 * @param {string} dst
 * @param {(relPath: string) => boolean} [filter] 返回 false 则跳过
 * @returns {string[]} 拷贝的相对路径列表
 */
function copyDir(src, dst, filter = null) {
  ensureDir(dst);
  const copied = [];
  const walk = (cur, rel) => {
    for (const name of fs.readdirSync(cur)) {
      const from = path.join(cur, name);
      const relPath = rel ? `${rel}/${name}` : name;
      const st = fs.statSync(from);
      if (st.isDirectory()) {
        walk(from, relPath);
      } else {
        if (filter && !filter(relPath)) continue;
        const to = path.join(dst, relPath);
        ensureDir(path.dirname(to));
        fs.copyFileSync(from, to);
        copied.push(relPath);
      }
    }
  };
  walk(src, '');
  return copied;
}

/**
 * 递归删除目录/文件，带重试（Windows 文件占用场景）。
 * @param {string} target
 * @param {{maxRetries?: number, retryDelayMs?: number}} [opts]
 * @returns {void}
 */
function rimraf(target, opts = {}) {
  const maxRetries = opts.maxRetries == null ? 3 : opts.maxRetries;
  const delay = opts.retryDelayMs == null ? 50 : opts.retryDelayMs;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      fs.rmSync(target, { recursive: true, force: true });
      return;
    } catch (e) {
      if (attempt === maxRetries) return; // 尽力而为，不抛出
      const until = Date.now() + delay * (attempt + 1);
      while (Date.now() < until) { /* 同步退避 */ }
    }
  }
}

/**
 * 读取文件字节（用于字节级还原校验）。
 * @param {string} file
 * @returns {Buffer}
 */
function readBytes(file) {
  return fs.readFileSync(file);
}

module.exports = {
  ensureDir,
  exists,
  readText,
  readJson,
  writeText,
  atomicWrite,
  atomicWriteJson,
  appendLine,
  readLines,
  readJsonLines,
  listFiles,
  expandGlob,
  statSafe,
  mkTmpDir,
  copyDir,
  rimraf,
  readBytes
};

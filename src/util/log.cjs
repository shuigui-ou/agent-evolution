/**
 * @module util/log
 * @layer util
 * @owner kou
 * 结构化日志：控制台 + 可选 JSONL 文件（默认关闭文件输出，避免测试污染 runtime/）。
 */

'use strict';

const LEVELS = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40, silent: 100 });

let currentLevel = LEVELS.info;
let fileSink = null; // 绝对文件路径，null 表示不写文件
const ring = [];
const RING_MAX = 200;

/**
 * 设置全局日志级别。
 * @param {string} level
 * @returns {void}
 */
function setLevel(level) {
  const v = LEVELS[String(level || '').toLowerCase()];
  currentLevel = v == null ? LEVELS.info : v;
}

/**
 * 设置文件输出路径（传 null 关闭）。
 * @param {string|null} file
 * @returns {void}
 */
function setFileSink(file) {
  fileSink = file || null;
}

/** @returns {string} */
function getLevel() {
  return Object.keys(LEVELS).find((k) => LEVELS[k] === currentLevel) || 'info';
}

/**
 * 写入一条日志。
 * @param {string} lvl
 * @param {string} mod
 * @param {string} msg
 * @param {Object} [ctx]
 * @param {number} [code]
 * @returns {Object} 日志记录
 */
function write(lvl, mod, msg, ctx = {}, code = 0) {
  const rec = {
    ts: new Date().toISOString(),
    lvl,
    mod,
    msg,
    ctx: ctx || {},
    code: code || 0
  };
  if (LEVELS[lvl] >= currentLevel) {
    const line = JSON.stringify(rec);
    const stream = lvl === 'error' || lvl === 'warn' ? process.stderr : process.stdout;
    try { stream.write(`${line}\n`); } catch (_e) { /* 忽略 */ }
  }
  ring.push(rec);
  if (ring.length > RING_MAX) ring.shift();
  if (fileSink) {
    try {
      // 延迟 require，避免与 store/paths 形成循环依赖
      const fsx = require('./fsx.cjs');
      fsx.appendLine(fileSink, JSON.stringify(rec));
    } catch (_e) { /* 日志失败不影响主流程 */ }
  }
  return rec;
}

/**
 * 创建模块 logger。
 * @param {string} mod
 * @returns {{debug: Function, info: Function, warn: Function, error: Function}}
 */
function createLogger(mod) {
  return {
    debug: (msg, ctx, code) => write('debug', mod, msg, ctx, code),
    info: (msg, ctx, code) => write('info', mod, msg, ctx, code),
    warn: (msg, ctx, code) => write('warn', mod, msg, ctx, code),
    error: (msg, ctx, code) => write('error', mod, msg, ctx, code)
  };
}

/** @returns {Object[]} 最近 200 条日志（测试用） */
function recent() {
  return ring.slice();
}

module.exports = { LEVELS, setLevel, setFileSink, getLevel, createLogger, write, recent };

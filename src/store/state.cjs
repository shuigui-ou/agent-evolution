/**
 * @module store/state
 * @layer store
 * @owner kou
 * 运行期状态：daemon 状态、采集游标、灰度观测、文件锁（单实例）。
 */

'use strict';

const fs = require('node:fs');
const fsx = require('../util/fsx.cjs');
const paths = require('./paths.cjs');
const { AedError } = require('../util/errors.cjs');

/**
 * 读取状态 JSON（不存在返回默认值）。
 * @param {string} name 状态名（不含扩展名）
 * @param {Object} [defaults]
 * @returns {Object}
 */
function loadState(name, defaults = {}) {
  return fsx.readJson(paths.stateFile(name), defaults);
}

/**
 * 原子写状态 JSON。
 * @param {string} name
 * @param {Object} value
 * @returns {void}
 */
function saveState(name, value) {
  fsx.ensureDir(paths.stateDir());
  fsx.atomicWriteJson(paths.stateFile(name), value);
}

/**
 * 更新状态（读-改-写）。
 * @param {string} name
 * @param {(prev: Object) => Object} mutator
 * @param {Object} [defaults]
 * @returns {Object} 新状态
 */
function updateState(name, mutator, defaults = {}) {
  const prev = loadState(name, defaults);
  const next = mutator(prev) || prev;
  saveState(name, next);
  return next;
}

/**
 * 判断进程是否存活。
 * @param {number} pid
 * @returns {boolean}
 */
function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/**
 * 获取文件锁（非阻塞）。
 * @param {string} name 锁名
 * @param {{staleMs?: number}} [opts] staleMs 超过该时长的锁视为过期（默认 6 小时）
 * @returns {{name: string, pid: number, file: string, acquired_at: string}}
 */
function acquireLock(name, opts = {}) {
  const staleMs = opts.staleMs == null ? 6 * 3600 * 1000 : opts.staleMs;
  const file = paths.lockFile(name);
  fsx.ensureDir(paths.lockDir());
  if (fsx.exists(file)) {
    const info = fsx.readJson(file, null);
    if (info && Number.isInteger(info.pid) && info.pid !== process.pid && isPidAlive(info.pid)) {
      const age = Date.now() - Date.parse(info.acquired_at || 0);
      if (Number.isFinite(age) && age < staleMs) {
        throw new AedError('E_LOCK_HELD', `锁 ${name} 被进程 ${info.pid} 持有`, { file, holder: info });
      }
    }
  }
  const info = {
    name,
    pid: process.pid,
    host: require('node:os').hostname(),
    acquired_at: new Date().toISOString()
  };
  fsx.atomicWriteJson(file, info);
  return Object.assign({ file }, info);
}

/**
 * 释放锁（仅当持有者为当前进程）。
 * @param {string} name
 * @returns {boolean}
 */
function releaseLock(name) {
  const file = paths.lockFile(name);
  if (!fsx.exists(file)) return false;
  const info = fsx.readJson(file, null);
  if (info && Number.isInteger(info.pid) && info.pid !== process.pid) return false;
  try { fs.unlinkSync(file); } catch (_e) { return false; }
  return true;
}

/**
 * 读取锁信息。
 * @param {string} name
 * @returns {Object|null}
 */
function peekLock(name) {
  return fsx.readJson(paths.lockFile(name), null);
}

/**
 * 读取采集游标表。
 * @returns {Object} { [key: string]: { path, offset, inode, mtime, line } }
 */
function getCursors() {
  return loadState('cursors', {});
}

/**
 * 写入单个游标。
 * @param {string} key
 * @param {{path: string, offset: number, inode: string, mtime: number, line?: number}} cursor
 * @returns {void}
 */
function setCursor(key, cursor) {
  updateState('cursors', (prev) => Object.assign({}, prev, { [key]: cursor }), {});
}

/**
 * 读取单个游标。
 * @param {string} key
 * @returns {Object|null}
 */
function getCursor(key) {
  const all = getCursors();
  return all[key] || null;
}

/**
 * 读取灰度观测。
 * @returns {Object}
 */
function getCanary() {
  return loadState('canary', { proposals: {} });
}

/**
 * 更新某提案的灰度观测。
 * @param {string} proposalId
 * @param {Object} patchObj
 * @returns {Object}
 */
function updateCanary(proposalId, patchObj) {
  return updateState('canary', (prev) => {
    const next = Object.assign({ proposals: {} }, prev);
    next.proposals[proposalId] = Object.assign({}, next.proposals[proposalId], patchObj);
    return next;
  }, { proposals: {} });
}

/**
 * 读取 daemon 状态。
 * @returns {{running: boolean, started_at: string|null, ticks: number, last_tick_at: string|null, last_error: Object|null}}
 */
function getDaemonState() {
  return loadState('daemon', {
    running: false,
    started_at: null,
    ticks: 0,
    last_tick_at: null,
    last_error: null
  });
}

/**
 * 更新 daemon 状态。
 * @param {Object} patchObj
 * @returns {Object}
 */
function updateDaemonState(patchObj) {
  return updateState('daemon', (prev) => Object.assign({
    running: false, started_at: null, ticks: 0, last_tick_at: null, last_error: null
  }, prev, patchObj), {});
}

module.exports = {
  loadState,
  saveState,
  updateState,
  acquireLock,
  releaseLock,
  peekLock,
  isPidAlive,
  getCursors,
  setCursor,
  getCursor,
  getCanary,
  updateCanary,
  getDaemonState,
  updateDaemonState
};

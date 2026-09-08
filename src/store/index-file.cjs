/**
 * @module store/index-file
 * @layer store
 * @owner kou
 * Experience 索引：fingerprint / status / credit 维度的内存索引 + 落盘幂等。
 */

'use strict';

const fsx = require('../util/fsx.cjs');
const paths = require('./paths.cjs');

/**
 * 通用 JSON 索引文件（落盘为 { version, updated_at, byId, byFingerprint }）。
 */
class IndexFile {
  /**
   * @param {string} file 索引文件绝对路径
   */
  constructor(file) {
    this.file = file;
    this.version = 1;
    this.updatedAt = null;
    /** @type {Map<string, Object>} */
    this.byId = new Map();
    /** @type {Map<string, string>} fingerprint -> id */
    this.byFingerprint = new Map();
    this.dirty = false;
    this.load();
  }

  /** 从磁盘加载（不存在则空索引）。 @returns {void} */
  load() {
    const raw = fsx.readJson(this.file, null);
    this.byId = new Map();
    this.byFingerprint = new Map();
    if (raw && Array.isArray(raw.items)) {
      for (const item of raw.items) {
        if (!item || !item.id) continue;
        this.byId.set(item.id, item);
        if (item.fingerprint) this.byFingerprint.set(item.fingerprint, item.id);
      }
      this.version = raw.version || 1;
      this.updatedAt = raw.updated_at || null;
    }
    this.dirty = false;
  }

  /**
   * 插入或更新一条索引项（内容相同则不标记为脏，保证落盘幂等）。
   * @param {{id: string, fingerprint?: string, status?: string, credit?: number, agent?: string}} item
   * @returns {boolean} 是否发生了变化
   */
  upsert(item) {
    if (!item || !item.id) return false;
    const prev = this.byId.get(item.id);
    const next = {
      id: item.id,
      agent: item.agent || (prev && prev.agent) || null,
      fingerprint: item.fingerprint || (prev && prev.fingerprint) || null,
      status: item.status || (prev && prev.status) || null,
      credit: typeof item.credit === 'number' ? item.credit : (prev ? prev.credit : null),
      updated_at: item.updated_at || new Date().toISOString()
    };
    if (prev && prev.fingerprint === next.fingerprint && prev.status === next.status
      && prev.credit === next.credit && prev.agent === next.agent) {
      return false;
    }
    this.byId.set(item.id, next);
    if (next.fingerprint) this.byFingerprint.set(next.fingerprint, item.id);
    this.dirty = true;
    return true;
  }

  /**
   * 按 fingerprint 查找。
   * @param {string} fp
   * @returns {Object|null}
   */
  findByFingerprint(fp) {
    const id = this.byFingerprint.get(fp);
    return id ? this.byId.get(id) || null : null;
  }

  /**
   * 按任意字段查找全部匹配项。
   * @param {string} field
   * @param {*} value
   * @returns {Object[]}
   */
  findAllBy(field, value) {
    const out = [];
    for (const item of this.byId.values()) {
      if (item[field] === value) out.push(item);
    }
    return out;
  }

  /** @returns {Object[]} */
  all() {
    return Array.from(this.byId.values());
  }

  /**
   * 持久化（无变化则跳过写入，保证幂等）。
   * @returns {boolean} 是否实际写盘
   */
  save() {
    if (!this.dirty) return false;
    this.updatedAt = new Date().toISOString();
    const payload = {
      version: this.version,
      updated_at: this.updatedAt,
      items: this.all().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    };
    fsx.atomicWriteJson(this.file, payload);
    this.dirty = false;
    return true;
  }
}

/** agent -> IndexFile 缓存 */
const CACHE = new Map();

/**
 * 获取某 agent 的经验索引（进程内缓存）。
 * @param {string} agent
 * @returns {IndexFile}
 */
function experienceIndex(agent) {
  const key = String(agent);
  if (!CACHE.has(key)) {
    fsx.ensureDir(paths.experiencesDir());
    CACHE.set(key, new IndexFile(paths.experienceIndexPath()));
  }
  return CACHE.get(key);
}

/**
 * 清空索引缓存（测试用）。
 * @returns {void}
 */
function resetIndexCache() {
  CACHE.clear();
}

module.exports = { IndexFile, experienceIndex, resetIndexCache };

/**
 * @module ingest/adapter-base
 * @layer ingest
 * @owner kou
 * 采集适配器基类：所有适配器必须实现 start / stop / health，并向 emit 输出原始记录。
 */

'use strict';

/** 支持的适配器类型 */
const KINDS = Object.freeze(['file-tail', 'jsonl', 'http-hook', 'cli-wrap']);

/**
 * 原始记录（适配器的统一输出）。
 * @typedef {Object} RawRecord
 * @property {string} text 原始文本（日志行或 JSON 行）
 * @property {string} path 来源文件路径
 * @property {number} line 行号（从 1 开始）
 * @property {string} [ts] 若来源自带时间
 * @property {Object} [meta] 附加元信息
 */

class Adapter {
  /** @type {string} */
  static kind = 'base';

  /**
   * @param {{kind?: string, path?: string, glob?: string, pollMs?: number, agent?: string, [k: string]: any}} opts
   */
  constructor(opts = {}) {
    this.opts = opts;
    this.kind = opts.kind || this.constructor.kind || 'base';
    this.agent = opts.agent || 'unknown';
    this.pollMs = Number.isFinite(opts.pollMs) ? opts.pollMs : 1000;
    this.running = false;
    /** @type {((rec: RawRecord) => void)|null} */
    this.emit = null;
    this.timer = null;
    this.lastError = null;
  }

  /**
   * 启动（默认按 pollMs 周期调用 poll）。
   * @param {(rec: RawRecord) => void} emit
   * @param {Object} [ctx]
   * @returns {Promise<void>}
   */
  async start(emit, ctx = {}) {
    this.emit = emit;
    this.ctx = ctx;
    this.running = true;
    if (this.timer) clearInterval(this.timer);
    if (this.pollMs > 0) {
      this.timer = setInterval(() => {
        this.safePoll().catch(() => { /* 已在 safePoll 内记录 */ });
      }, this.pollMs);
      if (this.timer.unref) this.timer.unref();
    }
  }

  /** 单次安全轮询（异常不抛出）。 @returns {Promise<number>} 产出条数 */
  async safePoll() {
    try {
      return await this.poll();
    } catch (e) {
      this.lastError = (e && e.message) || String(e);
      return 0;
    }
  }

  /**
   * 拉取新数据并 emit（子类实现）。
   * @returns {Promise<number>}
   */
  async poll() {
    return 0;
  }

  /**
   * 停止。
   * @returns {Promise<void>}
   */
  async stop() {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.emit = null;
  }

  /**
   * 健康检查。
   * @returns {Promise<{ok: boolean, detail: Object}>}
   */
  async health() {
    return { ok: true, detail: { kind: this.kind, running: this.running, lastError: this.lastError } };
  }
}

/**
 * 适配器工厂。
 * @param {{kind: string, agent?: string}} spec
 * @returns {Adapter}
 */
function createAdapter(spec) {
  const kind = (spec && spec.kind) || 'file-tail';
  if (!KINDS.includes(kind)) {
    const err = new Error(`未知适配器类型：${kind}`);
    err.code = 'E_ADAPTER_UNAVAILABLE';
    throw err;
  }
  if (kind === 'file-tail') {
    const FileTailAdapter = require('./adapter-file-tail.cjs');
    return new FileTailAdapter(spec);
  }
  const JsonlAdapter = require('./adapter-jsonl.cjs');
  return new JsonlAdapter(spec);
}

module.exports = { Adapter, createAdapter, KINDS };

/**
 * @module ingest/collector
 * @layer ingest
 * @owner kou
 * 采集编排：适配器 -> normalizer -> redactor -> 去重写入 runtime/traces/<agent>/YYYY-MM-DD.jsonl
 */

'use strict';

const paths = require('../store/paths.cjs');
const jsonl = require('../store/jsonl.cjs');
const { createAdapter } = require('./adapter-base.cjs');
const normalizer = require('./normalizer.cjs');
const redactor = require('./redactor.cjs');
const log = require('../util/log.cjs').createLogger('ingest.collector');

/**
 * 单个 agent 的采集器。
 */
class Collector {
  /**
   * @param {{agent: string, agent_version?: string, adapters?: Object[], redactPaths?: boolean, env?: Object, onEvent?: Function}} opts
   */
  constructor(opts = {}) {
    this.agent = opts.agent || 'unknown';
    this.agentVersion = opts.agent_version || '0.0.0';
    this.redactPaths = opts.redactPaths !== false;
    this.env = opts.env || {};
    this.onEvent = opts.onEvent || null;
    this.adapters = (opts.adapters || []).map((a) => createAdapter(Object.assign({ agent: this.agent }, a)));
    /** @type {Object[]} 本次进程内新采集到的事件 */
    this.buffer = [];
    this.stats = { raw: 0, normalized: 0, written: 0, duplicate: 0, redacted: 0 };
  }

  /**
   * 由 agent 配置构造采集器。
   * @param {Object} agentCfg
   * @param {Object} [config]
   * @returns {Collector}
   */
  static fromAgentConfig(agentCfg, config = {}) {
    return new Collector({
      agent: agentCfg.name,
      agent_version: agentCfg.version || agentCfg.agent_version || '0.0.0',
      adapters: agentCfg.adapters || [],
      redactPaths: agentCfg.redactPaths !== false
    });
  }

  /**
   * 启动全部适配器。
   * @returns {Promise<void>}
   */
  async start() {
    for (const a of this.adapters) {
      await a.start((rec) => this.handleRaw(rec), { agent: this.agent });
    }
  }

  /**
   * 停止全部适配器。
   * @returns {Promise<void>}
   */
  async stop() {
    for (const a of this.adapters) await a.stop();
  }

  /**
   * 处理一条原始记录。
   * @param {{text: string, path: string, line: number}} rec
   * @returns {Object|null} 写入的 TraceEvent
   */
  handleRaw(rec) {
    this.stats.raw += 1;
    const ev = normalizer.normalize(rec, {
      agent: this.agent,
      agent_version: this.agentVersion,
      adapter: 'file-tail',
      sourcePath: rec.path,
      env: this.env
    });
    if (!ev) return null;
    this.stats.normalized += 1;

    const r = redactor.redactDeep(ev, { redactPaths: this.redactPaths });
    const safe = r.value;
    if (r.redacted) {
      safe.redacted = true;
      this.stats.redacted += 1;
      log.warn('轨迹命中脱敏规则', { agent: this.agent, hits: r.hits });
    }
    this.persist(safe);
    this.buffer.push(safe);
    if (this.onEvent) this.onEvent(safe);
    return safe;
  }

  /**
   * 落盘（按事件日期分文件，唯一键去重）。
   * @param {Object} ev
   * @returns {boolean} 是否真正写入
   */
  persist(ev) {
    const day = String(ev.ts || '').slice(0, 10) || new Date().toISOString().slice(0, 10);
    const file = paths.traceFile(this.agent, day);
    const written = jsonl.appendUnique(file, ev, (r) => `${r.agent}|${r.session_id}|${r.seq}`);
    if (written) this.stats.written += 1;
    else this.stats.duplicate += 1;
    return written;
  }

  /**
   * 手动注入一批事件（测试与 fixtrue 导入用）。
   * @param {Object[]} events
   * @returns {number} 写入条数
   */
  ingestEvents(events) {
    let n = 0;
    for (const ev of events) {
      const safe = Object.assign({}, ev, {
        schema: ev.schema || 'aed/trace-event/1.0',
        agent: ev.agent || this.agent,
        env: Object.assign(normalizer.defaultEnv(), this.env, ev.env || {})
      });
      if (!safe.id) safe.id = require('../util/id.cjs').traceId();
      if (this.persist(safe)) n += 1;
      this.buffer.push(safe);
    }
    return n;
  }

  /**
   * 拉取一次增量。
   * @returns {Promise<{emitted: number, written: number}>}
   */
  async pollOnce() {
    const before = this.stats.written;
    for (const a of this.adapters) await a.safePoll();
    return { emitted: this.stats.normalized, written: this.stats.written - before };
  }

  /**
   * 健康检查。
   * @returns {Promise<{ok: boolean, adapters: Object[]}>}
   */
  async health() {
    const out = [];
    let ok = this.adapters.length > 0;
    for (const a of this.adapters) {
      const h = await a.health();
      if (!h.ok) ok = false;
      out.push({ kind: a.kind, ...h });
    }
    return { ok, adapters: out };
  }
}

module.exports = { Collector };

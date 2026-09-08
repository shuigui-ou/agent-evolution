/**
 * @module daemon
 * @layer core
 * @owner kou
 * 守护进程主循环：单实例文件锁、tick 调度、每日 digest、SIGINT/SIGTERM 优雅退出。
 * 每个 tick 独立 try/catch，单模块异常不导致进程退出。
 */

'use strict';

const log = require('./util/log.cjs').createLogger('daemon');
const state = require('./store/state.cjs');
const time = require('./util/time.cjs');
const { normalizeError } = require('./util/errors.cjs');
const notifier = require('./external/notifier.cjs');
const trust = require('./external/trust.cjs');
const { Inbox } = require('./external/inbox.cjs');

class Daemon {
  /**
   * @param {{config: Object, contexts?: Object[], tickMs?: number}} opts
   */
  constructor(opts = {}) {
    this.config = opts.config || {};
    this.contexts = opts.contexts || [];
    this.tickMs = opts.tickMs || (this.config.daemon && this.config.daemon.tickMs) || 5000;
    this.timer = null;
    this.running = false;
    this.ticks = 0;
    this.lastError = null;
    this.lock = null;
  }

  /**
   * 启动（获取单实例锁）。
   * @returns {Promise<void>}
   */
  async start() {
    if (this.running) return;
    this.lock = state.acquireLock('daemon');
    this.running = true;
    state.updateDaemonState({ running: true, started_at: time.nowIso(), pid: process.pid });
    for (const c of this.contexts) {
      if (c.collector) await c.collector.start();
    }
    this.timer = setInterval(() => {
      this.tick().catch((e) => {
        this.lastError = normalizeError(e);
        log.error('tick 异常', { error: this.lastError.message });
      });
    }, this.tickMs);
    if (this.timer.unref) this.timer.unref();
    log.info('daemon 已启动', { tickMs: this.tickMs, agents: this.contexts.map((c) => c.agent) });
  }

  /**
   * 停止并释放锁。
   * @returns {Promise<void>}
   */
  async stop() {
    if (!this.running) return;
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    for (const c of this.contexts) {
      if (c.collector) await c.collector.stop();
    }
    state.releaseLock('daemon');
    state.updateDaemonState({ running: false, stopped_at: time.nowIso() });
    log.info('daemon 已停止', { ticks: this.ticks });
  }

  /**
   * 注册进程信号，优雅退出。
   * @returns {void}
   */
  registerSignals() {
    const onSignal = (sig) => {
      log.info(`收到 ${sig}，准备退出`);
      this.stop().finally(() => process.exit(0));
    };
    process.once('SIGINT', () => onSignal('SIGINT'));
    process.once('SIGTERM', () => onSignal('SIGTERM'));
  }

  /**
   * 单个 tick：采集 → 进化 → 巡检。
   * @returns {Promise<Object>}
   */
  async tick() {
    const started = Date.now();
    const summary = { ts: time.nowIso(), agents: [], digest: null, errors: [] };
    for (const ctx of this.contexts) {
      try {
        if (ctx.collector) {
          // eslint-disable-next-line no-await-in-loop
          const ing = await ctx.collector.pollOnce();
          summary.agents.push({ agent: ctx.agent, ingested: ing.written });
        }
        if (ctx.engine) {
          // eslint-disable-next-line no-await-in-loop
          const res = await ctx.engine.cycle();
          summary.agents[summary.agents.length - 1] = Object.assign(
            summary.agents[summary.agents.length - 1] || { agent: ctx.agent },
            { proposals: res.results.length, released: res.results.filter((r) => r.state === 'released').length, stats: res.stats }
          );
        }
      } catch (e) {
        const err = normalizeError(e);
        summary.errors.push({ agent: ctx.agent, ...err });
        log.error('agent tick 失败', { agent: ctx.agent, error: err.message });
      }
    }
    summary.digest = this.maybeDigest();
    this.ticks += 1;
    state.updateDaemonState({
      ticks: this.ticks,
      last_tick_at: time.nowIso(),
      last_error: summary.errors.length ? summary.errors[0] : null
    });
    summary.duration_ms = Date.now() - started;
    return summary;
  }

  /**
   * 执行恰好一个 tick（不启动定时器）。
   * @returns {Promise<Object>}
   */
  async once() {
    const summary = await this.tick();
    log.info('once 完成', { duration_ms: summary.duration_ms });
    return summary;
  }

  /**
   * 到点则生成当日 digest（每天一次）。
   * @returns {Object|null}
   */
  maybeDigest() {
    const cfg = this.config.external && this.config.external.notify ? this.config.external.notify : {};
    if (cfg.digest === false) return null;
    const at = (this.config.daemon && this.config.daemon.digestAt) || '09:00';
    const target = time.hhmmToTs(at);
    const marker = state.loadState('digest', { last_day: null });
    const today = time.dayKey();
    if (marker.last_day === today) return null;
    if (target != null && Date.now() < target && marker.last_day !== null) return null;
    try {
      const inbox = new Inbox({ config: this.config });
      const signals = inbox.all();
      const experiences = this.contexts.reduce((all, c) => (c.evidence ? all.concat(c.evidence.listExperiences()) : all), []);
      const out = notifier.buildDigest({
        signals,
        experiences,
        reputations: trust.listReputations(),
        config: this.config
      });
      state.saveState('digest', { last_day: today, file: out.file });
      log.info('digest 已生成', { file: out.file });
      return out.stats;
    } catch (e) {
      log.error('digest 生成失败', { error: normalizeError(e).message });
      return null;
    }
  }
}

module.exports = { Daemon };

/**
 * @module cli/cmd-run
 * @layer cli
 * @owner kou
 * aed run once / start / stop / status
 */

'use strict';

const index = require('../index.cjs');
const state = require('../store/state.cjs');
const log = require('../util/log.cjs').createLogger('cli.run');
const { AedError } = require('../util/errors.cjs');

/**
 * @param {{sub: string, flags: Object, positional: string[]}} args
 * @returns {Promise<Object>}
 */
async function run(args) {
  const { sub, flags } = args;

  if (sub === 'status') {
    const daemon = state.getDaemonState();
    const lock = state.peekLock('daemon');
    const app = index.bootstrap();
    const agents = [];
    for (const ctx of app.contexts) {
      // eslint-disable-next-line no-await-in-loop
      const health = await ctx.collector.health();
      const info = require('../evolve/rollback.cjs').getSkill(ctx.agent, ctx.engine.skillName);
      agents.push({
        name: ctx.agent,
        skillRoot: ctx.skillRoot,
        version: info ? info.version : null,
        adapter_ok: health.ok,
        adapters: health.adapters
      });
    }
    return {
      daemon,
      lock_held: !!lock,
      lock,
      agents,
      __text: [
        `running=${daemon.running} ticks=${daemon.ticks} last_tick=${daemon.last_tick_at || '-'}`,
        `lock=${lock ? `pid ${lock.pid}` : 'free'}`,
        ...agents.map((a) => `  ${a.name} v${a.version || '-'} adapter=${a.adapter_ok ? 'ok' : 'FAIL'} skillRoot=${a.skillRoot}`)
      ].join('\n')
    };
  }

  if (sub === 'once') {
    const app = index.bootstrap();
    // 修复：once 必须先启动采集器再 tick。collector.start() 会给每个 adapter
    // 注入 emit 回调；若不启动，adapter 的 poll 直接返回 0
    // （见 adapter-file-tail 的 `if (!this.emit) return 0;` 守卫），
    // 导致 `aed run once` 恒采集不到轨迹。此处只做「启动采集器 + 单次 tick」，
    // 不走 daemon.start()，因此不获取文件锁、不启动定时器。
    for (const ctx of app.contexts) {
      if (ctx.collector) await ctx.collector.start();
    }
    let summary;
    try {
      summary = await app.once();
    } finally {
      // 释放 emit 回调与轮询定时器，避免进程悬挂 / 定时器残留。
      for (const ctx of app.contexts) {
        if (ctx.collector) await ctx.collector.stop();
      }
    }
    log.info('once 结束', { agents: summary.agents.length });
    return {
      summary,
      __text: [
        `tick 完成（${summary.duration_ms}ms）`,
        ...summary.agents.map((a) => `  ${a.agent}: 采集 ${a.ingested || 0} 条，提案 ${(a.proposals || 0)} 个，发布 ${(a.released || 0)} 个`),
        summary.errors && summary.errors.length ? `  错误：${JSON.stringify(summary.errors)}` : ''
      ].filter(Boolean).join('\n')
    };
  }

  if (sub === 'start' || sub === 'run') {
    const app = index.bootstrap();
    app.daemon.registerSignals();
    await app.daemon.start();
    const ticks = Number(flags.ticks || 0);
    if (ticks > 0) {
      for (let i = 0; i < ticks; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await app.daemon.tick();
      }
      await app.daemon.stop();
      return { started: false, ticks };
    }
    return {
      started: true,
      tickMs: app.daemon.tickMs,
      agents: app.contexts.map((c) => c.agent),
      __text: `daemon 已启动（tickMs=${app.daemon.tickMs}），Ctrl+C 退出`
    };
  }

  if (sub === 'stop') {
    state.releaseLock('daemon');
    state.updateDaemonState({ running: false, stopped_at: new Date().toISOString() });
    return { stopped: true };
  }

  throw new AedError('E_ARG_INVALID', `未知子命令：run ${sub}`);
}

module.exports = { run };

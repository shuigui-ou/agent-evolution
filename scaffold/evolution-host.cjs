'use strict';
/**
 * @module evolution-host
 * @layer 宿主接入层（turnkey 脚手架）
 *
 * 任意新项目接入 agent-evolution 只需三步：
 *   1. 把本文件 + evolution.yaml + seeds/ 放进项目根
 *   2. 在入口/构建脚本里 require 本文件并 init()
 *   3. 在报错点调用 evo.tapError(err) / evo.tapToolResult(res)
 *
 * 内核/引擎解析顺序（无需手写接线）：
 *   - 引擎：ENV EVOLUTION_ENGINE_PATH > 项目内 lib/evolution-engine/engine.cjs
 *   - 内核：ENV EVOLUTION_KERNEL_ROOT > evolution.yaml 的 kernel.kernelRoot > 引擎内置共享内核
 *
 * 失败全部 fail-open：引擎未就绪时所有方法返回 { ok:false } 且不抛，宿主主流程不受影响。
 */

const path = require('node:path');
const fs = require('node:fs');

let _engine = null;
let _tapHelpers = null;

/** 解析引擎模块路径 */
function resolveEnginePath() {
  if (process.env.EVOLUTION_ENGINE_PATH) return process.env.EVOLUTION_ENGINE_PATH;
  const vendored = path.join(__dirname, 'lib', 'evolution-engine', 'engine.cjs');
  if (fs.existsSync(vendored)) return vendored;
  throw new Error(
    '[evolution-host] 未找到 evolution-engine：请 vendor 到 lib/evolution-engine/engine.cjs，或设置 ENV EVOLUTION_ENGINE_PATH'
  );
}

/**
 * 初始化（幂等）。可多次调用以覆盖 opts。
 * @param {object} [opts]
 * @param {string} [opts.yamlPath] - evolution.yaml 路径（缺省 = 同目录 evolution.yaml）
 * @param {string} [opts.rootDir] - 宿主根目录（缺省 = yaml 所在目录）
 * @param {string} [opts.kernelRoot] - 内核目录（可经 ENV EVOLUTION_KERNEL_ROOT 覆盖）
 * @param {boolean} [opts.autoStart] - 是否立即启动周期分析调度（analyze.intervalMs）
 * @param {number} [opts.autoStartMs] - 覆盖调度间隔
 */
function init(opts = {}) {
  const yamlPath = opts.yamlPath || path.join(__dirname, 'evolution.yaml');
  const enginePath = resolveEnginePath();
  const { load } = require(enginePath);
  _engine = load(yamlPath, {
    rootDir: opts.rootDir || path.dirname(path.resolve(yamlPath)),
    kernelRoot: opts.kernelRoot || process.env.EVOLUTION_KERNEL_ROOT || undefined,
  });
  _tapHelpers = require('./tap-helpers.cjs');
  if (opts.autoStart) start(opts.autoStartMs);
  return _engine;
}

/** 取已初始化的引擎 handle（未 init 抛错） */
function engine() {
  if (!_engine) throw new Error('[evolution-host] 尚未 init()，请先调用 init()');
  return _engine;
}

/** 引擎是否就绪（enabled 且未降级） */
function ready() {
  try {
    return !!_engine && _engine.isEnabled();
  } catch (_e) {
    return false;
  }
}

/**
 * 通用错误 tap：接受 Error / string / 含 message 的对象，归一为 E 类信号。
 * 这是宿主接入最低成本入口——直接把 catch 到的 err 喂进来即可。
 * @param {Error|string|object} err
 * @param {object} [ctx] { taskId, source }
 */
function tapError(err, ctx = {}) {
  if (!ready()) return { ok: false, reason: 'not_ready' };
  const e = err || {};
  const title = String(e.message || e.code || (typeof err === 'string' ? err : 'unknown error')).slice(0, 300);
  const detail = String(e.stack || (typeof err === 'string' ? err : JSON.stringify(err))).slice(0, 2000);
  return engine().tapE({ title, detail, taskId: ctx.taskId || '', source: ctx.source || 'host' });
}

/**
 * 工具/命令结果 tap：传入执行结果对象，按约定字段判定是否失败并 tap。
 * 约定：{ ok:false, error } / { exitCode:非0 } / { stderr } 视为失败。
 * 返回 null 表示未触发 tap（结果成功或无法判定）。
 */
function tapToolResult(res, ctx = {}) {
  if (!ready()) return { ok: false, reason: 'not_ready' };
  const r = res || {};
  const failed =
    r.ok === false ||
    (typeof r.exitCode === 'number' && r.exitCode !== 0) ||
    (typeof r.code === 'number' && r.code !== 0) ||
    (typeof r.stderr === 'string' && r.stderr.trim().length > 0 && r.ok === undefined);
  if (!failed) return null;
  const title = String(r.error || r.stderr || r.message || 'tool_result_failure').slice(0, 300);
  return engine().tapE({ title, detail: String(JSON.stringify(r)).slice(0, 2000), taskId: ctx.taskId || '', source: ctx.source || 'tool' });
}

/** 启动周期自动分析（内核 analyze 调度；依赖 yaml 的 analyze.intervalMs 或 autoStartMs） */
function start(intervalMs) {
  if (!ready()) return { ok: false, reason: 'not_ready' };
  return engine().startAutoAnalyze({ intervalMs });
}

/** 停止周期自动分析 */
function stop() {
  if (!_engine) return { ok: false, reason: 'not_ready' };
  return engine().stopAutoAnalyze();
}

/** 手动跑一轮八步链路 */
async function runCycle() {
  if (!ready()) return { ok: false, reason: 'not_ready' };
  return engine().runCycle();
}

/** 读取当前知识面广角（playbook）：返回各白名单文件行数 + 解析行 */
function playbook() {
  if (!ready()) return [];
  return engine().listKnowledge();
}

/** 触发一次在报错点前的快照（关键文件保护） */
function checkpoint(files, label) {
  if (!ready()) return { ok: false, reason: 'not_ready' };
  return engine().checkpoint(label || 'host-checkpoint', files || []);
}

/** 行为纠偏上报（用户对输出的显式反馈） */
function tapBehavior(input) {
  if (!ready()) return { ok: false, reason: 'not_ready' };
  return engine().tapBehavior(input);
}

/** 只读状态（供宿主在 /status 或日志里展示） */
function status() {
  if (!_engine) return { ok: false, reason: 'not_initialized' };
  return engine().status();
}

module.exports = {
  init,
  engine,
  ready,
  tapError,
  tapToolResult,
  start,
  stop,
  runCycle,
  playbook,
  checkpoint,
  tapBehavior,
  status,
  _tapHelpers: () => _tapHelpers,
};

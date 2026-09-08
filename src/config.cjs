/**
 * @module config
 * @layer core
 * @owner kou
 * 唯一配置源 aed.config.json：加载、默认值深度合并、校验。
 */

'use strict';

const path = require('node:path');
const fsx = require('./util/fsx.cjs');
const paths = require('./store/paths.cjs');
const { AedError } = require('./util/errors.cjs');

/** 全量默认值，保证每个配置项在代码内都有兜底 */
const DEFAULTS = Object.freeze({
  version: 1,
  root: '.',
  daemon: { port: 7878, tickMs: 5000, digestAt: '09:00', logLevel: 'info' },
  agents: [],
  evidence: {
    l1TtlDays: 30,
    l2TtlDays: 180,
    minSupportForProposal: 2,
    promotion: { minSupport: 5, minCredit: 60, minTriggerStability: 0.7 }
  },
  gate: {
    regressionSuite: 'fixtures/suites/software-verifier.json',
    syntheticMinCases: 3,
    shadowCalls: 30,
    sandbox: true,
    timeoutMs: 30000
  },
  canary: { steps: [10, 50, 100], minCallsPerStep: 20 },
  credit: {
    init: 50,
    decayPerWeek: 0.97,
    freezeBelow: 20,
    quarantineDays: 90,
    hitSuccess: 5,
    hitNoop: -3,
    falseTrigger: -8,
    miss: -1,
    rollbackPenalty: -20
  },
  budget: { maxItems: 40, maxTokens: 8000 },
  external: {
    trustInit: { T0: 55, T1: 52, T2: 48, T3: 40 },
    autoMerge: { T0: true, T1: true, T2: 'afterQuarantine7d', T3: false },
    registries: [],
    notify: { spool: true, digest: true, toast: false, webhook: null },
    identity: { contributorId: 'local.user', privKeyPath: 'runtime/state/keys/ed25519.pem' }
  },
  llm: { enabled: false, provider: 'none', model: '', apiKeyEnv: 'AED_LLM_KEY' }
});

/**
 * 深度合并（source 覆盖 base，仅合并普通对象）。
 * @param {Object} base
 * @param {Object} source
 * @returns {Object}
 */
function deepMerge(base, source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    return source === undefined ? base : source;
  }
  const out = Object.assign({}, base);
  for (const key of Object.keys(source)) {
    const sv = source[key];
    const bv = out[key];
    if (bv && typeof bv === 'object' && !Array.isArray(bv) && sv && typeof sv === 'object' && !Array.isArray(sv)) {
      out[key] = deepMerge(bv, sv);
    } else if (sv !== undefined) {
      out[key] = sv;
    }
  }
  return out;
}

/** @type {Object|null} */
let cached = null;

/**
 * 校验配置结构，失败抛 E_CONFIG_INVALID。
 * @param {Object} cfg
 * @returns {Object} cfg
 */
function validateConfig(cfg) {
  const problems = [];
  if (!cfg || typeof cfg !== 'object') problems.push('config 必须是对象');
  else {
    if (cfg.version !== 1) problems.push(`不支持的 config.version: ${cfg.version}`);
    if (!Array.isArray(cfg.agents)) problems.push('agents 必须是数组');
    if (cfg.daemon && !Number.isFinite(cfg.daemon.tickMs)) problems.push('daemon.tickMs 必须是数字');
    if (cfg.gate && !Number.isFinite(cfg.gate.timeoutMs)) problems.push('gate.timeoutMs 必须是数字');
    for (const a of cfg.agents || []) {
      if (!a || typeof a.name !== 'string' || !a.name) problems.push('agent.name 必填');
      if (a && a.artifact && !a.artifact.skillRoot) problems.push(`agent ${a.name} 缺少 artifact.skillRoot`);
    }
  }
  if (problems.length) {
    throw new AedError('E_CONFIG_INVALID', `配置校验失败：${problems.join('; ')}`, { problems });
  }
  return cfg;
}

/**
 * 加载配置。
 * @param {{root?: string, configPath?: string, reload?: boolean}} [opts]
 * @returns {Object} 合并后的配置（已冻结浅层）
 */
function loadConfig(opts = {}) {
  if (cached && !opts.reload) return cached;
  const configPath = opts.configPath
    ? path.resolve(opts.configPath)
    : path.join(opts.root ? path.resolve(opts.root) : paths.getRoot(), 'aed.config.json');
  const raw = fsx.readJson(configPath, null);
  if (!raw) {
    throw new AedError('E_CONFIG_INVALID', `找不到配置文件：${configPath}`, { configPath });
  }
  const cfg = deepMerge(JSON.parse(JSON.stringify(DEFAULTS)), raw);
  // root 解析：相对路径相对配置文件所在目录
  const baseDir = path.dirname(configPath);
  cfg.root = path.isAbsolute(cfg.root) ? path.resolve(cfg.root) : path.resolve(baseDir, cfg.root);
  cfg.__configPath = configPath;
  paths.setRoot(cfg.root);
  validateConfig(cfg);
  cached = cfg;
  return cfg;
}

/**
 * 获取当前配置（未加载则自动加载）。
 * @returns {Object}
 */
function getConfig() {
  return cached || loadConfig();
}

/**
 * 覆盖当前配置（测试与 CLI 用）。
 * @param {Object} cfg
 * @returns {Object}
 */
function setConfig(cfg) {
  cached = validateConfig(cfg);
  if (cached.root) paths.setRoot(cached.root);
  return cached;
}

/**
 * 清空配置缓存。
 * @returns {void}
 */
function resetConfig() {
  cached = null;
}

/**
 * 取某个 agent 的配置。
 * @param {Object} cfg
 * @param {string} name
 * @returns {Object|null}
 */
function findAgent(cfg, name) {
  for (const a of (cfg && cfg.agents) || []) {
    if (a.name === name) return a;
  }
  return null;
}

module.exports = {
  DEFAULTS,
  deepMerge,
  loadConfig,
  getConfig,
  setConfig,
  resetConfig,
  validateConfig,
  findAgent
};

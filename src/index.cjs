/**
 * @module index
 * @layer core
 * @owner kou
 * 组装入口：加载配置 -> 构造采集器/证据层/进化引擎上下文 -> 暴露 once / daemon。
 */

'use strict';

const path = require('node:path');
const config = require('./config.cjs');
const paths = require('./store/paths.cjs');
const state = require('./store/state.cjs');
const log = require('./util/log.cjs');
const { Collector } = require('./ingest/collector.cjs');
const { EvidenceLayer } = require('./evidence/evidence-layer.cjs');
const { Engine } = require('./evolve/engine.cjs');
const { Inbox } = require('./external/inbox.cjs');
const { Daemon } = require('./daemon.cjs');

/**
 * 读取运行期注册的 agent（CLI `agent register` 写入）。
 * @returns {Object[]}
 */
function registeredAgents() {
  return state.loadState('agents', []);
}

/**
 * 保存运行期注册的 agent。
 * @param {Object[]} agents
 * @returns {void}
 */
function saveRegisteredAgents(agents) {
  state.saveState('agents', agents);
}

/**
 * 合并配置内 agent 与运行期注册 agent（后者优先）。
 * @param {Object} cfg
 * @returns {Object[]}
 */
function allAgents(cfg) {
  const out = [];
  const seen = new Set();
  const runtime = registeredAgents();
  for (const a of runtime.concat(cfg.agents || [])) {
    if (!a || !a.name || seen.has(a.name)) continue;
    seen.add(a.name);
    out.push(a);
  }
  return out.filter((a) => a.enabled !== false);
}

/**
 * 解析 agent 的 skillRoot（相对路径按项目根解析）。
 * @param {Object} agentCfg
 * @returns {string}
 */
function resolveSkillRoot(agentCfg) {
  const root = (agentCfg.artifact && agentCfg.artifact.skillRoot) || agentCfg.skillRoot || '';
  return path.isAbsolute(root) ? root : path.resolve(paths.getRoot(), root || '.');
}

/**
 * 组装全部运行上下文。
 * @param {{root?: string, config?: Object, configPath?: string}} [opts]
 * @returns {{config: Object, contexts: Object[], inbox: Inbox, daemon: Daemon, once: Function}}
 */
function bootstrap(opts = {}) {
  const cfg = opts.config || config.loadConfig({ root: opts.root, configPath: opts.configPath });
  paths.setRoot(cfg.root);
  log.setLevel((cfg.daemon && cfg.daemon.logLevel) || 'info');

  const contexts = [];
  for (const agentCfg of allAgents(cfg)) {
    const skillRoot = resolveSkillRoot(agentCfg);
    const collector = new Collector({
      agent: agentCfg.name,
      agent_version: agentCfg.version || agentCfg.agent_version || '0.0.0',
      adapters: agentCfg.adapters || []
    });
    const evidence = new EvidenceLayer({ agent: agentCfg.name, config: cfg });
    const engine = new Engine({
      agent: agentCfg.name,
      config: cfg,
      evidence,
      skillRoot,
      skillName: (agentCfg.artifact && agentCfg.artifact.name) || agentCfg.name,
      artifact: agentCfg.artifact
    });
    contexts.push({ agent: agentCfg.name, agentCfg, skillRoot, collector, evidence, engine });
  }

  const inbox = new Inbox({ config: cfg });
  const daemon = new Daemon({ config: cfg, contexts });

  /**
   * 执行一次完整闭环（采集 + 进化）。
   * @returns {Promise<Object>}
   */
  async function once() {
    return daemon.once();
  }

  return { config: cfg, contexts, inbox, daemon, once };
}

module.exports = Object.assign({
  bootstrap,
  allAgents,
  registeredAgents,
  saveRegisteredAgents,
  resolveSkillRoot,
  config,
  paths,
  state,
  log,
  Collector,
  EvidenceLayer,
  Engine,
  Inbox,
  Daemon
}, {
  util: {
    id: require('./util/id.cjs'),
    time: require('./util/time.cjs'),
    fsx: require('./util/fsx.cjs'),
    hash: require('./util/hash.cjs'),
    errors: require('./util/errors.cjs')
  },
  store: {
    paths: require('./store/paths.cjs'),
    jsonl: require('./store/jsonl.cjs'),
    state: require('./store/state.cjs'),
    audit: require('./store/audit.cjs'),
    indexFile: require('./store/index-file.cjs')
  },
  schema: { validate: require('./schema/validate.cjs') },
  ingest: {
    Collector,
    normalizer: require('./ingest/normalizer.cjs'),
    redactor: require('./ingest/redactor.cjs'),
    adapterBase: require('./ingest/adapter-base.cjs')
  },
  evidence: {
    EvidenceLayer,
    Distiller: require('./evidence/distiller.cjs').Distiller,
    attribution: require('./evidence/failure-attribution.cjs'),
    sessionizer: require('./evidence/sessionizer.cjs')
  },
  eval: { evaluator: require('./eval/evaluator.cjs'), suiteRegistry: require('./eval/suite-registry.cjs') },
  evolve: {
    Engine,
    patchDsl: require('./evolve/patch-dsl.cjs'),
    patchInfer: require('./evolve/patch-infer.cjs'),
    patchApply: require('./evolve/patch-apply.cjs'),
    rollback: require('./evolve/rollback.cjs')
  },
  external: {
    Inbox,
    dedupe: require('./external/dedupe.cjs'),
    trust: require('./external/trust.cjs'),
    notifier: require('./external/notifier.cjs')
  },
  credit: { credit: require('./credit/credit.cjs') },
  security: {
    injectionGuard: require('./security/injection-guard.cjs'),
    sandbox: require('./security/sandbox.cjs'),
    riskPolicy: require('./security/risk-policy.cjs')
  }
});

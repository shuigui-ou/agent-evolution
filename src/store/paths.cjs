/**
 * @module store/paths
 * @layer store
 * @owner kou
 * 唯一路径来源。所有模块必须经本模块解析路径，禁止硬编码。
 * 根路径优先级：显式 setRoot() > 环境变量 AED_ROOT > process.cwd()。
 */

'use strict';

const path = require('node:path');

/** @type {string|null} */
let _root = null;

/**
 * 默认根：环境变量或 cwd。
 * @returns {string}
 */
function defaultRoot() {
  return process.env.AED_ROOT ? path.resolve(process.env.AED_ROOT) : path.resolve(process.cwd());
}

/**
 * 获取当前根路径。
 * @returns {string}
 */
function getRoot() {
  if (!_root) _root = defaultRoot();
  return _root;
}

/**
 * 设置根路径（测试与 CLI 用）。
 * @param {string} root
 * @returns {string}
 */
function setRoot(root) {
  _root = path.resolve(String(root));
  return _root;
}

/**
 * 重置为默认根。
 * @returns {string}
 */
function resetRoot() {
  _root = null;
  return getRoot();
}

/**
 * 在根路径下拼接。
 * @param {...string} parts
 * @returns {string}
 */
function under(...parts) {
  return path.join(getRoot(), ...parts);
}

const P = {
  // ---- 根与配置 ----
  root: () => getRoot(),
  configFile: () => under('aed.config.json'),

  // ---- 运行期 ----
  runtime: () => under('runtime'),
  logsDir: () => under('runtime', 'logs'),
  daemonLogFile: (day) => under('runtime', 'logs', `daemon-${day}.log`),

  // ---- L1 轨迹 ----
  tracesDir: (agent) => under('runtime', 'traces', String(agent)),
  traceFile: (agent, day) => under('runtime', 'traces', String(agent), `${day}.jsonl`),

  // ---- 外部收件箱 ----
  inboxDir: () => under('runtime', 'inbox'),
  inboxFile: () => under('runtime', 'inbox', 'inbox.jsonl'),
  inboxItemFile: (signalId) => under('runtime', 'inbox', `${signalId}.json`),

  // ---- L2 经验 ----
  experiencesDir: () => under('runtime', 'experiences'),
  experienceFile: (agent) => under('runtime', 'experiences', `${agent}.jsonl`),
  policyFile: () => under('runtime', 'experiences', '_policy.jsonl'),
  experienceIndexPath: () => under('runtime', 'experiences', 'index.json'),

  // ---- 提案 ----
  proposalsDir: () => under('runtime', 'proposals'),
  proposalFile: (id) => under('runtime', 'proposals', `${id}.json`),

  // ---- skill 快照 ----
  skillsDir: () => under('runtime', 'skills'),
  skillDir: (agent, skill) => under('runtime', 'skills', String(agent), String(skill)),
  skillVersionDir: (agent, skill, version) => under('runtime', 'skills', String(agent), String(skill), `v${version}`),
  skillVersionMeta: (agent, skill, version) => under('runtime', 'skills', String(agent), String(skill), `v${version}`, 'meta.json'),
  skillRegistryFile: () => under('runtime', 'skills', 'registry.json'),

  // ---- 审计 ----
  auditDir: () => under('runtime', 'audit'),
  auditFile: (month) => under('runtime', 'audit', `${month}.jsonl`),

  // ---- 状态与锁 ----
  stateDir: () => under('runtime', 'state'),
  stateFile: (name) => under('runtime', 'state', `${name}.json`),
  lockDir: () => under('runtime', 'state', 'locks'),
  lockFile: (name) => under('runtime', 'state', 'locks', `${name}.lock`),
  keysDir: () => under('runtime', 'state', 'keys'),

  // ---- 信用流水 ----
  creditDir: () => under('runtime', 'credit'),
  creditFile: (agent) => under('runtime', 'credit', `${agent}.jsonl`),
  reputationFile: () => under('runtime', 'credit', 'reputation.json'),

  // ---- 报告与通知 ----
  reportsDir: () => under('runtime', 'reports'),
  digestFile: (day) => under('runtime', 'reports', `digest-${day}.md`),
  metricsFile: (day) => under('runtime', 'reports', `metrics-${day}.md`),
  notifyDir: () => under('runtime', 'notify'),
  notifySpoolDir: () => under('runtime', 'notify', 'spool'),
  notifyFile: () => under('runtime', 'notify', 'notify.jsonl'),

  // ---- 沙箱 skill 副本（e2e 演示用，绝不使用真实用户目录） ----
  sandboxSkillsDir: (agent) => under('runtime', 'sandbox-skills', String(agent)),

  // ---- 只读样例 ----
  fixturesDir: () => under('fixtures'),
  suiteFile: (agent) => under('fixtures', 'suites', `${agent}.json`)
};

module.exports = Object.assign(P, {
  getRoot,
  setRoot,
  resetRoot,
  under
});

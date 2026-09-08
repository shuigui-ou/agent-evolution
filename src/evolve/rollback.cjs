/**
 * @module evolve/rollback
 * @layer evolve
 * @owner kou
 * skill 快照（semver）与还原：应用 patch 前打快照，触发回滚阈值时字节级还原。
 */

'use strict';

const path = require('node:path');
const fsx = require('../util/fsx.cjs');
const paths = require('../store/paths.cjs');
const time = require('../util/time.cjs');
const { AedError } = require('../util/errors.cjs');

/**
 * 读取 skill 注册表。
 * @returns {Object} { agents: { [agent]: { [skill]: {version, skillRoot, updated_at} } } }
 */
function registry() {
  return fsx.readJson(paths.skillRegistryFile(), { agents: {} });
}

/**
 * 写 skill 注册表。
 * @param {Object} reg
 * @returns {void}
 */
function saveRegistry(reg) {
  fsx.ensureDir(paths.skillsDir());
  fsx.atomicWriteJson(paths.skillRegistryFile(), reg);
}

/**
 * 获取某 agent 的 skill 信息。
 * @param {string} agent
 * @param {string} skill
 * @returns {{version: string, skillRoot: string, updated_at: string|null}|null}
 */
function getSkill(agent, skill) {
  const reg = registry();
  return (((reg.agents || {})[agent] || {})[skill]) || null;
}

/**
 * 写入 skill 信息。
 * @param {string} agent
 * @param {string} skill
 * @param {{version?: string, skillRoot?: string}} info
 * @returns {Object} 合并后的信息
 */
function setSkill(agent, skill, info) {
  const reg = registry();
  reg.agents = reg.agents || {};
  reg.agents[agent] = reg.agents[agent] || {};
  const prev = reg.agents[agent][skill] || { version: '1.0.0', skillRoot: '', updated_at: null };
  const next = Object.assign({}, prev, info, { updated_at: time.nowIso() });
  reg.agents[agent][skill] = next;
  saveRegistry(reg);
  return next;
}

/**
 * semver 递增。
 * @param {string} prev 形如 1.2.5
 * @param {'patch'|'minor'|'major'} [kind]
 * @returns {string}
 */
function nextVersion(prev, kind = 'patch') {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(prev || '0.0.0'));
  let major = 1;
  let minor = 0;
  let patch = 0;
  if (m) {
    major = Number(m[1]);
    minor = Number(m[2]);
    patch = Number(m[3]);
  }
  if (kind === 'major') return `${major + 1}.0.0`;
  if (kind === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

/**
 * 打快照：把 skillRoot 整棵树复制到 runtime/skills/<agent>/<skill>/v<version>/。
 * @param {{agent: string, skill: string, version: string, skillRoot: string, meta?: Object}} input
 * @returns {{dir: string, files: string[], meta: Object}}
 */
function snapshot(input) {
  const dir = paths.skillVersionDir(input.agent, input.skill, input.version);
  fsx.ensureDir(dir);
  const files = fsx.copyDir(path.resolve(input.skillRoot), dir, (rel) => rel !== 'meta.json');
  const meta = Object.assign({
    agent: input.agent,
    skill: input.skill,
    version: input.version,
    skill_root: path.resolve(input.skillRoot),
    created_at: time.nowIso(),
    files
  }, input.meta || {});
  fsx.atomicWriteJson(paths.skillVersionMeta(input.agent, input.skill, input.version), meta);
  return { dir, files, meta };
}

/**
 * 列出某 skill 的所有快照版本（升序）。
 * @param {string} agent
 * @param {string} skill
 * @returns {string[]}
 */
function listSnapshots(agent, skill) {
  const dir = paths.skillDir(agent, skill);
  if (!fsx.exists(dir)) return [];
  const versions = [];
  for (const name of require('node:fs').readdirSync(dir)) {
    const m = /^v(\d+\.\d+\.\d+)$/.exec(name);
    if (m) versions.push(m[1]);
  }
  return versions.sort((a, b) => {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    return pa[0] - pb[0] || pa[1] - pb[1] || pa[2] - pb[2];
  });
}

/**
 * 还原：清空 skillRoot 后整树拷回（字节级还原）。
 * @param {{agent: string, skill: string, version: string, skillRoot: string}} input
 * @returns {{restored: string[], dir: string}}
 */
function restore(input) {
  const dir = paths.skillVersionDir(input.agent, input.skill, input.version);
  if (!fsx.exists(dir)) {
    throw new AedError('E_NOT_FOUND', `快照不存在：${dir}`, { dir });
  }
  const target = path.resolve(input.skillRoot);
  fsx.rimraf(target, { maxRetries: 3 });
  fsx.ensureDir(target);
  const restored = fsx.copyDir(dir, target, (rel) => rel !== 'meta.json');
  return { restored, dir };
}

/** 自动回滚阈值 */
const ROLLBACK_THRESHOLDS = Object.freeze({
  falseTriggerRate: 0.1,
  regressionFailures: 1,
  fsrDropPp: 5,
  crashRateRisePp: 2
});

/**
 * 判定是否触发自动回滚。
 * @param {{falseTriggerRate?: number, regressionFailures?: number, fsrDropPp?: number, crashRateRisePp?: number}} metrics
 * @param {Object} [thresholds]
 * @returns {{trigger: boolean, reason_code: string|null, reasons: string[]}}
 */
function shouldAutoRollback(metrics = {}, thresholds = ROLLBACK_THRESHOLDS) {
  const reasons = [];
  if (Number.isFinite(metrics.falseTriggerRate) && metrics.falseTriggerRate > thresholds.falseTriggerRate) {
    reasons.push(`误触发率 ${metrics.falseTriggerRate} > ${thresholds.falseTriggerRate}`);
  }
  if ((metrics.regressionFailures || 0) >= thresholds.regressionFailures) {
    reasons.push(`回归集失败 ${metrics.regressionFailures} 条`);
  }
  if (Number.isFinite(metrics.fsrDropPp) && metrics.fsrDropPp > thresholds.fsrDropPp) {
    reasons.push(`首触成功率下降 ${metrics.fsrDropPp}pp`);
  }
  if (Number.isFinite(metrics.crashRateRisePp) && metrics.crashRateRisePp > thresholds.crashRateRisePp) {
    reasons.push(`崩溃率上升 ${metrics.crashRateRisePp}pp`);
  }
  return {
    trigger: reasons.length > 0,
    reason_code: reasons.length ? 'E_ROLLBACK_TRIGGERED' : null,
    reasons
  };
}

module.exports = {
  registry,
  saveRegistry,
  getSkill,
  setSkill,
  nextVersion,
  snapshot,
  listSnapshots,
  restore,
  shouldAutoRollback,
  ROLLBACK_THRESHOLDS
};

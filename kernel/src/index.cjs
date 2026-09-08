/**
 * @module index
 * @layer L0 入口
 * @owner Kou（工程师，K1）
 *
 * 进化内核库统一出口：导出内核工厂与各子模块（全部零依赖 CommonJS）。
 */
'use strict';

const { createKernel, resolveTier, PRIMITIVES, EVENT_KINDS } = require('./kernel.cjs');
const { createLedgerStore, LEDGERS, LEDGER_SIGNAL_TYPE } = require('./ledger.cjs');
const { SIGNAL_TYPES, normalizeFingerprint, classifySignal, aggregate } = require('./signals.cjs');
const { createObjectiveStack, MET_DOWNWEIGHT } = require('./objective.cjs');
const {
  createCandidatePool,
  computeExpectedGain,
  UNITS,
  L2_UNITS,
  L1_UNITS,
} = require('./candidates.cjs');
const {
  createPermissionKnob,
  assertContentT4Safe,
  T4_PATTERNS,
  LEVELS,
} = require('./permission.cjs');
const { createProbeLedger, SCORES } = require('./probe.cjs');
const { createFeedbackEngine, DOWNWEIGHT_PER_VETO, BLACKLIST_THRESHOLD, DIVERGENCE_THRESHOLD } = require('./feedback.cjs');
const { createAudit, GENESIS } = require('./audit.cjs');
const { createSnapshotManager, bumpPatch } = require('./snapshot.cjs');
const { detectInjection, sanitizeForPrompt, RULES } = require('./injection-guard.cjs');
const { createLocalResourceClient, createHttpClient } = require('./resource-client.cjs');
const { KernelError, sha256hex, shortHash } = require('./util.cjs');

module.exports = {
  // 内核
  createKernel,
  resolveTier,
  PRIMITIVES,
  EVENT_KINDS,
  // 子模块工厂
  createLedgerStore,
  createObjectiveStack,
  createCandidatePool,
  createPermissionKnob,
  createProbeLedger,
  createAudit,
  createSnapshotManager,
  createLocalResourceClient,
  createHttpClient,
  // 纯函数
  normalizeFingerprint,
  classifySignal,
  aggregate,
  computeExpectedGain,
  assertContentT4Safe,
  detectInjection,
  sanitizeForPrompt,
  bumpPatch,
  sha256hex,
  shortHash,
  // 常量
  LEDGERS,
  LEDGER_SIGNAL_TYPE,
  SIGNAL_TYPES,
  UNITS,
  L2_UNITS,
  L1_UNITS,
  LEVELS,
  T4_PATTERNS,
  SCORES,
  GENESIS,
  RULES,
  MET_DOWNWEIGHT,
  DOWNWEIGHT_PER_VETO,
  BLACKLIST_THRESHOLD,
  DIVERGENCE_THRESHOLD,
  // 错误类型
  KernelError,
};

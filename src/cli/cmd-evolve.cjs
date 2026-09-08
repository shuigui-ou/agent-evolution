/**
 * @module cli/cmd-evolve
 * @layer cli
 * @owner kou
 * aed evolve list / show / gate / release / rollback / auto-rollback / run
 */

'use strict';

const index = require('../index.cjs');
const configMod = require('../config.cjs');
const paths = require('../store/paths.cjs');
const { EvidenceLayer } = require('../evidence/evidence-layer.cjs');
const { Engine } = require('../evolve/engine.cjs');
const { AedError } = require('../util/errors.cjs');

/**
 * 定位 agent 上下文。
 * @param {string|undefined} name
 * @returns {{agent: string, evidence: Object, engine: Object, skillRoot: string}}
 */
function contextFor(name) {
  const cfg = configMod.getConfig();
  paths.setRoot(cfg.root);
  const agents = index.allAgents(cfg);
  const target = name ? agents.find((a) => a.name === name) : agents[0];
  if (!target) throw new AedError('E_NOT_FOUND', `没有可用 agent${name ? `：${name}` : ''}`);
  const skillRoot = index.resolveSkillRoot(target);
  const evidence = new EvidenceLayer({ agent: target.name, config: cfg });
  const engine = new Engine({
    agent: target.name,
    config: cfg,
    evidence,
    skillRoot,
    skillName: (target.artifact && target.artifact.name) || target.name,
    artifact: target.artifact
  });
  return { agent: target.name, evidence, engine, skillRoot };
}

/**
 * @param {{sub: string, flags: Object, positional: string[]}} args
 * @returns {Promise<Object>}
 */
async function run(args) {
  const { sub, flags } = args;
  const ctx = contextFor(flags.agent);

  if (sub === 'list') {
    const list = ctx.evidence.listProposals({ agent: ctx.agent, state: flags.state || undefined });
    return {
      count: list.length,
      proposals: list,
      __text: list.length === 0
        ? '无提案'
        : list.map((p) => `${p.state.padEnd(11)} ${p.id}  ${p.attribution.category}(${p.attribution.confidence})  ${p.intent || ''}`).join('\n')
    };
  }

  const proposalId = flags.proposal || flags.id;

  if (sub === 'show') {
    if (!proposalId) throw new AedError('E_ARG_INVALID', '缺少 --proposal');
    const p = ctx.evidence.getProposal(String(proposalId));
    if (!p) throw new AedError('E_NOT_FOUND', `提案不存在：${proposalId}`);
    return { proposal: p };
  }

  if (sub === 'run' || sub === 'propose') {
    const res = await ctx.engine.cycle();
    return {
      stats: res.stats,
      results: res.results,
      __text: [
        `蒸馏：失败 ${res.stats.failures} 条 / 指纹 ${res.stats.groups} 个 / 新建经验 ${res.stats.created} / 提案 ${res.stats.proposals}`,
        ...res.results.map((r) => `  ${r.id} -> ${r.state}${r.released_version ? ` (v${r.released_version})` : ''}`)
      ].join('\n')
    };
  }

  if (sub === 'gate') {
    if (!proposalId) throw new AedError('E_ARG_INVALID', '缺少 --proposal');
    const res = await ctx.engine.runProposal(String(proposalId));
    return { result: res, __text: `${res.id} -> ${res.state}（decision=${res.decision}）` };
  }

  if (sub === 'release') {
    if (!proposalId) throw new AedError('E_ARG_INVALID', '缺少 --proposal');
    const res = await ctx.engine.releaseProposal(String(proposalId));
    return { result: res, __text: `${proposalId} -> released v${res.version}` };
  }

  if (sub === 'rollback') {
    if (!proposalId) throw new AedError('E_ARG_INVALID', '缺少 --proposal');
    const res = ctx.engine.rollbackProposal(
      String(proposalId),
      flags.reason || 'MANUAL_ROLLBACK',
      { reason_text: flags['reason-text'] || '' }
    );
    return { result: res, __text: `${proposalId} -> rolled_back，还原自 ${res.restored_from}（v${res.version}）` };
  }

  if (sub === 'auto-rollback') {
    if (!proposalId) throw new AedError('E_ARG_INVALID', '缺少 --proposal');
    const metrics = {
      regressionFailures: Number(flags['regression-failures'] || 0),
      falseTriggerRate: flags['false-trigger-rate'] == null ? undefined : Number(flags['false-trigger-rate']),
      fsrDropPp: flags['fsr-drop'] == null ? undefined : Number(flags['fsr-drop']),
      crashRateRisePp: flags['crash-rise'] == null ? undefined : Number(flags['crash-rise'])
    };
    const res = ctx.engine.checkRollbackTriggers(String(proposalId), metrics);
    return {
      result: res,
      __text: res.triggered
        ? `${proposalId} 触发自动回滚：${res.verdict.reasons.join('; ')}`
        : `${proposalId} 未触发回滚阈值`
    };
  }

  return { __text: '用法: aed evolve list|show|run|gate|release|rollback|auto-rollback' };
}

module.exports = { run, contextFor };

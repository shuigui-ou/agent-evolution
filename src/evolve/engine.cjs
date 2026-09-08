/**
 * @module evolve/engine
 * @layer evolve
 * @owner kou
 * 进化状态机：draft → gated → (needs_human) → canary → released → rolled_back。
 * 负责 归因 → patch → 四门 → 快照 → 应用 → 发布 → 监控 → 自动回滚。
 */

'use strict';

const path = require('node:path');
const time = require('../util/time.cjs');
const log = require('../util/log.cjs').createLogger('evolve.engine');
const { AedError } = require('../util/errors.cjs');
const { Distiller } = require('../evidence/distiller.cjs');
const { inferPatch } = require('./patch-infer.cjs');
const patchApply = require('./patch-apply.cjs');
const rollback = require('./rollback.cjs');
const { evaluate } = require('../eval/evaluator.cjs');
const credit = require('../credit/credit.cjs');
const notifier = require('../external/notifier.cjs');
const audit = require('../store/audit.cjs');

/**
 * 由 ops 推断版本递增类型。
 * @param {Object[]} ops
 * @returns {'patch'|'minor'|'major'}
 */
function bumpKind(ops = []) {
  if (ops.some((o) => o.op === 'deprecate')) return 'major';
  if (ops.some((o) => o.op === 'add_file' || o.op === 'upsert_frontmatter')) return 'minor';
  return 'patch';
}

class Engine {
  /**
   * @param {{agent: string, config?: Object, evidence: Object, skillRoot: string, skillName?: string, artifact?: Object}} opts
   */
  constructor(opts = {}) {
    this.agent = opts.agent || 'unknown';
    this.config = opts.config || {};
    this.evidence = opts.evidence;
    this.skillRoot = path.resolve(opts.skillRoot || '.');
    this.skillName = opts.skillName || this.agent;
    this.targetPath = (opts.artifact && opts.artifact.targets && opts.artifact.targets[0]) || 'SKILL.md';
  }

  /**
   * 当前 skill 版本信息（不存在则注册为 1.0.0）。
   * @returns {{version: string, skillRoot: string, updated_at: string|null}}
   */
  skillInfo() {
    let info = rollback.getSkill(this.agent, this.skillName);
    if (!info) {
      info = rollback.setSkill(this.agent, this.skillName, { version: '1.0.0', skillRoot: this.skillRoot });
    } else if (!info.skillRoot) {
      info = rollback.setSkill(this.agent, this.skillName, { skillRoot: this.skillRoot });
    }
    return info;
  }

  /**
   * 近 N 天回滚次数。
   * @param {number} [days]
   * @returns {number}
   */
  countRecentRollbacks(days = 7) {
    const since = Date.now() - days * 86400000;
    return this.evidence.listProposals({ agent: this.agent })
      .filter((p) => p.state === 'rolled_back' && p.rollback && Date.parse(p.rollback.at || 0) >= since)
      .length;
  }

  /**
   * 一轮完整进化：蒸馏 → 提案 → 门禁 → 发布。
   * @param {{now?: number, traces?: Object[]}} [opts]
   * @returns {Promise<{stats: Object, experiences: Object[], results: Object[]}>}
   */
  async cycle(opts = {}) {
    const now = opts.now || Date.now();
    const distiller = new Distiller({ agent: this.agent, evidence: this.evidence, config: this.config });
    const distilled = distiller.distill({ now, events: opts.traces });
    for (const p of distilled.proposals) this.evidence.saveProposal(p);

    const pending = this.evidence.listProposals({ agent: this.agent, state: 'draft' });
    const results = [];
    for (const p of pending) {
      // eslint-disable-next-line no-await-in-loop
      results.push(await this.runProposal(p.id, { now }));
    }
    return {
      stats: distilled.stats,
      experiences: distilled.experiences,
      results
    };
  }

  /**
   * 处理单个提案（门禁 + 发布）。
   * @param {string} proposalId
   * @param {{now?: number}} [opts]
   * @returns {Promise<{id: string, state: string, decision: string|null, released_version: string|null}>}
   */
  async runProposal(proposalId, opts = {}) {
    const p = this.evidence.getProposal(proposalId);
    if (!p) throw new AedError('E_NOT_FOUND', `提案不存在：${proposalId}`);
    const exp = p.experience_id ? this.evidence.getExperience(p.experience_id) : null;
    if (!exp) {
      this.evidence.updateProposal(proposalId, {
        state: 'rejected',
        rollback: { reason_code: 'NO_EXPERIENCE', at: time.nowIso(), restored_from: null }
      });
      return { id: proposalId, state: 'rejected', decision: 'fail', released_version: null };
    }

    const info = this.skillInfo();
    let patch = p.patch;
    if (!patch) {
      patch = inferPatch({
        experience: exp,
        proposal: p,
        agent: this.agent,
        skillRoot: this.skillRoot,
        targetPath: this.targetPath,
        version: info.version,
        config: this.config,
        rollbackCount7d: this.countRecentRollbacks()
      });
      patch.target.version = info.version;
      // patch_script 类修复必须回填 patch_ref，否则 G1 结构约束会拒收
      this.evidence.upsertExperience(Object.assign({}, exp, {
        fix: Object.assign({}, exp.fix, { patch_ref: patch.id, kind: patch.testcases[0].expect_fix_kind || exp.fix.kind }),
        updated_at: time.nowIso()
      }));
      this.evidence.updateProposal(proposalId, { patch, state: 'gated' });
    }

    const expForGate = this.evidence.getExperience(p.experience_id) || exp;

    const traces = opts.traces || this.evidence.readRecentTraces((this.config.gate && this.config.gate.shadowCalls) || 30);
    const gate = await evaluate({
      proposal: Object.assign({}, p, { patch }),
      experience: expForGate,
      patch,
      agent: this.agent,
      config: this.config,
      traces
    });

    const auditRec = audit.append({
      action: 'proposal.gate',
      actor: 'aed/engine',
      target: { proposal_id: proposalId, experience_id: exp.id },
      detail: { decision: gate.decision, stages: gate.stages.map((s) => ({ stage: s.stage, pass: s.pass, skipped: !!s.skipped })) }
    });

    if (gate.decision === 'fail') {
      this.evidence.updateProposal(proposalId, {
        state: 'rejected',
        gate_result_id: gate.id,
        audit_refs: (p.audit_refs || []).concat([auditRec.id])
      });
      log.warn('提案被门禁拒绝', { proposal_id: proposalId, gate: gate.id });
      return { id: proposalId, state: 'rejected', decision: 'fail', released_version: null };
    }
    if (gate.decision === 'needs_human') {
      this.evidence.updateProposal(proposalId, {
        state: 'needs_human',
        gate_result_id: gate.id,
        audit_refs: (p.audit_refs || []).concat([auditRec.id])
      });
      notifier.writeSpool({
        id: `needs-human-${proposalId}`,
        title: `AED 需人工批准：${proposalId}`,
        body: `- 原因：${(gate.human_reasons || []).join('; ')}\n- 提案：${proposalId}\n- 门禁：${gate.id}\n`
      });
      return { id: proposalId, state: 'needs_human', decision: 'needs_human', released_version: null };
    }

    const rel = await this.releaseProposal(proposalId, { gate });
    return { id: proposalId, state: rel.state, decision: 'pass', released_version: rel.version };
  }

  /**
   * 发布：快照 → 应用 patch → 新版本快照 → 更新注册表。
   * @param {string} proposalId
   * @param {{gate?: Object}} [opts]
   * @returns {Promise<{state: string, version: string, changes: Object[], snapshot_dir: string}>}
   */
  async releaseProposal(proposalId, opts = {}) {
    const p = this.evidence.getProposal(proposalId);
    if (!p || !p.patch) throw new AedError('E_NOT_FOUND', `提案或 patch 不存在：${proposalId}`);
    const info = this.skillInfo();
    const preVersion = info.version;
    const patch = p.patch;

    const res = patchApply.apply({
      patch,
      skillRoot: this.skillRoot,
      dryRun: false,
      snapshotFn: () => rollback.snapshot({
        agent: this.agent,
        skill: this.skillName,
        version: preVersion,
        skillRoot: this.skillRoot,
        meta: { proposal_id: proposalId, phase: 'pre-apply' }
      })
    });

    const newVersion = rollback.nextVersion(preVersion, bumpKind(patch.ops));
    rollback.snapshot({
      agent: this.agent,
      skill: this.skillName,
      version: newVersion,
      skillRoot: this.skillRoot,
      meta: { proposal_id: proposalId, phase: 'post-apply', changes: res.changes }
    });
    rollback.setSkill(this.agent, this.skillName, { version: newVersion, skillRoot: this.skillRoot });

    const exp = p.experience_id ? this.evidence.getExperience(p.experience_id) : null;
    if (exp) {
      this.evidence.upsertExperience(Object.assign({}, exp, {
        status: 'active',
        version: newVersion,
        updated_at: time.nowIso()
      }));
    }

    const updated = this.evidence.updateProposal(proposalId, {
      state: 'released',
      gate_result_id: opts.gate ? opts.gate.id : p.gate_result_id,
      release: {
        version: newVersion,
        from_version: preVersion,
        snapshot_dir: rollback.registry() && path.dirname(paths_skillVersionDir(this.agent, this.skillName, newVersion)),
        released_at: time.nowIso()
      }
    });

    audit.append({
      action: 'proposal.release',
      actor: 'aed/engine',
      target: { proposal_id: proposalId, version: newVersion },
      detail: { changes: res.changes, from_version: preVersion }
    });
    notifier.writeSpool({
      id: `release-${proposalId}`,
      title: `AED 已发布 ${this.skillName} v${newVersion}`,
      body: `- 提案：${proposalId}\n- 版本：v${preVersion} → v${newVersion}\n- 变更：${res.changes.map((c) => `${c.rel}(${c.delta_bytes}B)`).join(', ')}\n`
    });
    log.info('提案已发布', { proposal_id: proposalId, version: newVersion, changes: res.changes.length });
    return {
      state: updated.state,
      version: newVersion,
      changes: res.changes,
      snapshot_dir: updated.release.snapshot_dir
    };
  }

  /**
   * 回滚：字节级还原 + 经验冻结 + 信用扣分 + 审计 + 通知。
   * @param {string} proposalId
   * @param {string} [reasonCode]
   * @param {{reason_text?: string}} [opts]
   * @returns {{state: string, restored_from: string, version: string}}
   */
  rollbackProposal(proposalId, reasonCode = 'E_ROLLBACK_TRIGGERED', opts = {}) {
    const p = this.evidence.getProposal(proposalId);
    if (!p) throw new AedError('E_NOT_FOUND', `提案不存在：${proposalId}`);
    const fromVersion = (p.release && p.release.from_version) || null;
    if (!fromVersion) {
      throw new AedError('E_NOT_FOUND', `提案尚无发布记录，无法回滚：${proposalId}`);
    }
    const restored = rollback.restore({
      agent: this.agent,
      skill: this.skillName,
      version: fromVersion,
      skillRoot: this.skillRoot
    });
    rollback.setSkill(this.agent, this.skillName, { version: fromVersion, skillRoot: this.skillRoot });

    const exp = p.experience_id ? this.evidence.getExperience(p.experience_id) : null;
    if (exp) {
      const applied = credit.applyDelta({
        agent: this.agent,
        experience: exp,
        reason: 'rollback_penalty',
        ref: { proposal_id: proposalId }
      });
      this.evidence.upsertExperience(Object.assign({}, applied.experience, {
        status: 'frozen',
        updated_at: time.nowIso()
      }));
    }

    const updated = this.evidence.updateProposal(proposalId, {
      state: 'rolled_back',
      rollback: {
        reason_code: reasonCode,
        reason_text: opts.reason_text || '',
        at: time.nowIso(),
        restored_from: restored.dir
      }
    });
    audit.append({
      action: 'proposal.rollback',
      actor: 'aed/engine',
      target: { proposal_id: proposalId, version: fromVersion },
      detail: { reason_code: reasonCode, restored_from: restored.dir, files: restored.restored.length }
    });
    notifier.writeSpool({
      id: `rollback-${proposalId}`,
      title: `AED 已回滚 ${this.skillName} → v${fromVersion}`,
      body: `- 提案：${proposalId}\n- 原因：${reasonCode} ${opts.reason_text || ''}\n- 还原自：${restored.dir}\n`
    });
    log.warn('提案已回滚', { proposal_id: proposalId, version: fromVersion, reason: reasonCode });
    return { state: updated.state, restored_from: restored.dir, version: fromVersion };
  }

  /**
   * 自动回滚判定（命中任一阈值即回滚）。
   * @param {string} proposalId
   * @param {{falseTriggerRate?: number, regressionFailures?: number, fsrDropPp?: number, crashRateRisePp?: number}} metrics
   * @returns {{triggered: boolean, verdict: Object, result: Object|null}}
   */
  checkRollbackTriggers(proposalId, metrics = {}) {
    const verdict = rollback.shouldAutoRollback(metrics);
    if (!verdict.trigger) return { triggered: false, verdict, result: null };
    const result = this.rollbackProposal(proposalId, verdict.reason_code, { reason_text: verdict.reasons.join('; ') });
    return { triggered: true, verdict, result };
  }
}

/**
 * 快照目录（避免与 paths 命名冲突的局部工具）。
 * @param {string} agent
 * @param {string} skill
 * @param {string} version
 * @returns {string}
 */
function paths_skillVersionDir(agent, skill, version) {
  return require('../store/paths.cjs').skillVersionDir(agent, skill, version);
}

module.exports = { Engine, bumpKind };

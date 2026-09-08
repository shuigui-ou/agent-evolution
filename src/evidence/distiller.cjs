/**
 * @module evidence/distiller
 * @layer evidence
 * @owner kou
 * L1 -> L2 蒸馏：失败指纹聚合 -> Experience -> 达到最小支持度时产出 EvolutionProposal(draft)。
 */

'use strict';

const id = require('../util/id.cjs');
const time = require('../util/time.cjs');
const hash = require('../util/hash.cjs');
const { sessionize, failureWindows, toMatchInput } = require('./sessionizer.cjs');
const attribution = require('./failure-attribution.cjs');

/**
 * 由错误消息构造稳定的 message_regex。
 * @param {string} message
 * @param {number} [maxLen]
 * @returns {string}
 */
function buildMessageRegex(message, maxLen = 80) {
  const norm = hash.normalizeForFingerprint(message);
  let core = norm.slice(0, maxLen);
  if (norm.length > maxLen) {
    const cut = core.lastIndexOf(' ');
    if (cut > 20) core = core.slice(0, cut);
  }
  const escaped = core
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/<n>/g, '\\d+')
    .replace(/<uuid>/g, '[0-9a-f-]+')
    .replace(/<hex>/g, '[0-9a-f]+')
    .replace(/<path>/g, '.*')
    .replace(/\s+/g, '\\s+');
  return escaped;
}

/**
 * 计算失败指纹。
 * @param {{error?: Object, payload?: Object, env?: Object}} ev
 * @returns {string}
 */
function failureFingerprint(ev) {
  const err = ev.error || {};
  const mi = toMatchInput(ev);
  return hash.fingerprint([
    hash.normalizeForFingerprint(err.type || ''),
    hash.normalizeForFingerprint(err.message || mi.message || ''),
    mi.tool,
    mi.os
  ]);
}

/**
 * 蒸馏器。
 */
class Distiller {
  /**
   * @param {{agent: string, evidence: Object, config?: Object}} opts
   */
  constructor(opts = {}) {
    this.agent = opts.agent || 'unknown';
    this.evidence = opts.evidence;
    this.config = opts.config || {};
  }

  /**
   * 执行蒸馏。
   * @param {{events?: Object[], now?: number}} [opts]
   * @returns {{experiences: Object[], proposals: Object[], stats: Object}}
   */
  distill(opts = {}) {
    const now = opts.now || Date.now();
    const events = opts.events || (this.evidence ? this.evidence.readAllTraces() : []);
    const minSupport = (this.config.evidence && this.config.evidence.minSupportForProposal) || 2;

    const sessions = sessionize(events);
    const sessionById = new Map(sessions.map((s) => [s.session_id, s]));
    const windows = failureWindows(events);

    // 1) 按 fingerprint 聚合失败
    /** @type {Map<string, Object[]>} */
    const groups = new Map();
    for (const w of windows) {
      const fp = failureFingerprint(w.event);
      if (!groups.has(fp)) groups.set(fp, []);
      groups.get(fp).push(w);
    }

    const experiences = [];
    const proposals = [];
    const stats = { failures: windows.length, groups: groups.size, created: 0, updated: 0, proposals: 0 };

    // 每个失败组 +1ms：保证 created_at 互不相同且严格按分组产生顺序递增，
    // 下游 listProposals 按 created_at 排序即可得到确定性的发布顺序（不依赖文件系统 readdir 顺序）。
    let seq = 0;
    for (const [fp, items] of groups.entries()) {
      const t = now + seq;
      seq += 1;
      const first = items[0];
      const session = sessionById.get(first.event.session_id) || { events: first.window };
      const attr = attribution.attribute({
        event: first.event,
        window: first.window,
        session
      });

      const existing = this.evidence ? this.evidence.getExperienceByFingerprint(fp) : null;
      const evidenceRefs = items.map((it) => it.event.id).slice(0, 50);
      if (existing) {
        const merged = Object.assign({}, existing, {
          evidence_refs: dedupePush(existing.evidence_refs || [], evidenceRefs).slice(0, 50),
          stats: Object.assign({}, existing.stats, {
            support_count: (existing.stats && existing.stats.support_count || 0) + items.length,
            last_hit_at: time.nowIso(t)
          }),
          updated_at: time.nowIso(t)
        });
        this.evidence.upsertExperience(merged);
        experiences.push(merged);
        stats.updated += 1;
        continue;
      }

      const exp = this.buildExperience({ fp, items, attr, now: t });
      if (this.evidence) this.evidence.upsertExperience(exp);
      experiences.push(exp);
      stats.created += 1;

      // 2) 达到最小支持度 -> 产出 draft 提案
      const support = exp.stats.support_count;
      const conf = attr.confidence;
      if (support >= minSupport && attr.category !== 'unknown' && conf >= 0.4) {
        proposals.push(this.buildProposal({ exp, attr, items, now: t }));
        stats.proposals += 1;
      }
    }

    return { experiences, proposals, stats };
  }

  /**
   * 构造 Experience。
   * @param {{fp: string, items: Object[], attr: Object, now: number}} p
   * @returns {Object}
   */
  buildExperience({ fp, items, attr, now }) {
    const first = items[0];
    const ev = first.event;
    const mi = toMatchInput(ev);
    const err = ev.error || {};
    const support = items.length;
    const trustInit = (this.config.external && this.config.external.trustInit) || { T0: 55 };
    const regexes = Array.from(new Set(items.map((it) => buildMessageRegex((it.event.error || {}).message || mi.message))));
    const tools = Array.from(new Set(items.map((it) => toMatchInput(it.event).tool).filter(Boolean)));
    const oses = Array.from(new Set(items.map((it) => toMatchInput(it.event).os).filter(Boolean)));
    const errTypes = Array.from(new Set(items.map((it) => (it.event.error || {}).type).filter(Boolean)));

    const match = {};
    if (errTypes.length) match.error_type = errTypes;
    if (regexes.length) match.message_regex = regexes.slice(0, 3);
    if (tools.length) match.tool = tools;
    if (oses.length) match.os = oses;
    if (Object.keys(match).length === 0) match.keywords = [mi.message.slice(0, 40)].filter(Boolean);

    const fixKind = defaultFixKind(attr.category);
    const symptom = String(err.message || mi.message || '').slice(0, 500);
    const title = `${attr.category}/${errTypes[0] || 'Error'}: ${symptom}`.slice(0, 120);

    return {
      schema: 'aed/experience/1.0',
      id: id.experienceId(now),
      type: attr.category === 'environment' ? 'env_fact' : 'pitfall',
      layer: 'L2',
      fingerprint: fp,
      simhash: hash.simhash(`${title}\n${symptom}`),
      title,
      trigger: {
        category: attr.category === 'unknown' ? 'tool' : attr.category,
        match
      },
      symptom,
      // 触发样本（P0 扩展字段）：供 patch-infer 生成确定性正/负向用例
      sample_input: {
        error_type: String(err.type || ''),
        message: String(err.message || mi.message || ''),
        tool: mi.tool,
        os: mi.os,
        version: mi.version,
        file: mi.file,
        text: mi.text
      },
      fix: {
        kind: fixKind,
        text: defaultFixText(attr.category, symptom),
        steps: [],
        patch_ref: null,
        confidence: attr.confidence
      },
      evidence_refs: items.map((it) => it.event.id).slice(0, 50),
      repro: {
        command: `node bin/aed.cjs agent replay --agent ${this.agent}`,
        expect: `失败指纹 ${fp} 不再复现`,
        artifact: null
      },
      status: 'candidate',
      credit: trustInit.T0 == null ? 50 : trustInit.T0,
      stats: {
        support_count: support,
        hit: 0,
        hit_success: 0,
        false_trigger: 0,
        miss: 0,
        trigger_stability: 0,
        last_hit_at: time.nowIso(now)
      },
      origin: {
        channel: 'self_distill',
        contributor_id: null,
        signal_id: null,
        trust_level: 'T0'
      },
      applies_to: [this.agent],
      version: '1.0.0',
      supersedes: null,
      superseded_by: null,
      created_at: time.nowIso(now),
      updated_at: time.nowIso(now),
      ttl_days: (this.config.evidence && this.config.evidence.l2TtlDays) || 180
    };
  }

  /**
   * 构造 draft 提案。
   * @param {{exp: Object, attr: Object, items: Object[], now: number}} p
   * @returns {Object}
   */
  buildProposal({ exp, attr, items, now }) {
    return {
      schema: 'aed/proposal/1.0',
      id: id.proposalId(now),
      created_at: time.nowIso(now),
      updated_at: time.nowIso(now),
      agent: this.agent,
      trigger: {
        kind: 'failure',
        ref_ids: items.map((it) => it.event.id),
        fingerprint: exp.fingerprint
      },
      attribution: {
        category: attr.category,
        confidence: attr.confidence,
        evidence: attr.evidence,
        rationale: attr.rationale
      },
      intent: `修复指纹 ${exp.fingerprint}：${exp.title}`.slice(0, 300),
      patch: null,
      experience_id: exp.id,
      state: 'draft',
      gate_result_id: null,
      canary: {
        percent: 10,
        min_calls: (this.config.canary && this.config.canary.minCallsPerStep) || 20,
        observed_calls: 0,
        observed_regressions: 0,
        abort_on: { false_trigger_rate: 0.1, regression_failures: 1 }
      },
      release: null,
      rollback: null,
      retry_count: 0,
      audit_refs: []
    };
  }
}

/**
 * 归因类别 -> 默认修复类型。
 * @param {string} category
 * @returns {string}
 */
function defaultFixKind(category) {
  switch (category) {
    case 'tool': return 'fallback';
    case 'planning': return 'constraint';
    case 'reasoning': return 'constraint';
    case 'knowledge': return 'patch_script';
    case 'environment': return 'env_requirement';
    default: return 'constraint';
  }
}

/**
 * 归因类别 -> 默认修复文案（无 LLM 基线版模板）。
 * @param {string} category
 * @param {string} symptom
 * @returns {string}
 */
function defaultFixText(category, symptom) {
  const s = String(symptom || '').slice(0, 200);
  switch (category) {
    case 'tool':
      return `工具调用失败（${s}）。前置检查：确认进程/端口/路径可用；失败后切换到备用工具或退避重试，单次任务重试不超过 2 次。`;
    case 'planning':
      return `规划失控（${s}）。加步骤上限与去重：同一参数等价的工具调用不得超过 3 次，出现 A→B→A 回环立即终止并改换策略。`;
    case 'reasoning':
      return `结果解析失败（${s}）。强制结构化输出：先输出 JSON 代码块再自检字段完整性，解析失败时重试一次并附原始片段。`;
    case 'knowledge':
      return `已知知识点变更（${s}）。改用最新 API / 选择器，并在动手前先查一次版本说明。`;
    case 'environment':
      return `环境相关问题（${s}）。显式声明前置依赖：统一换行符为 LF、显式设置编码 UTF-8、路径使用 path.join 而非字符串拼接。`;
    default:
      return `未知归因（${s}）。需人工补充 repro 后再决定是否生成 patch。`;
  }
}

/**
 * 去重追加。
 * @param {string[]} base
 * @param {string[]} add
 * @returns {string[]}
 */
function dedupePush(base, add) {
  const set = new Set(base);
  for (const x of add) set.add(x);
  return Array.from(set);
}

module.exports = { Distiller, failureFingerprint, buildMessageRegex, defaultFixKind, defaultFixText };

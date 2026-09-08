/**
 * @module src/resources/experience-store
 * @layer 资源服务（§5 外置记忆）
 * @owner Alex（软件工程师，K5）
 *
 * 外置记忆（experience store）——只读/受控接口背后的本地账本：
 *  - 条目带 status（active/retired/quarantined）与 credit（信用）；
 *  - 入库前过注入防护（复用 kernel injection-guard.cjs），命中即拒 + 贡献者扣分；
 *  - 增删查均在本模块完成（HTTP 只暴露只读 GET，写路径留给受控模块/CLI/未来宿主内嵌调用）。
 *
 * 持久化（JSONL / JSON）：
 *  - experiences.jsonl   外置记忆条目
 *  - contributors.json   贡献者信用表 { contributor: credit }
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  KernelError,
  genId,
  nowIso,
  readJsonl,
  writeJsonl,
} = require('../../kernel/src/util.cjs');
const { detectInjection } = require('../../kernel/src/injection-guard.cjs');

/** 新经验缺省信用 */
const DEFAULT_INIT_CREDIT = 1;
/** 注入命中时贡献者扣分 */
const DEFAULT_INJECTION_PENALTY = -5;

/** 汇总待检文本（含正文与标题/修复等字段，防止注入藏匿在元数据里） */
function buildScanText(rec) {
  return [rec.content, rec.title, rec.fix, rec.verify, rec.rootCause, rec.symptom]
    .filter((x) => typeof x === 'string')
    .join('\n');
}

/**
 * 创建外置记忆账本
 * @param {object} opts
 * @param {string} [opts.storeFile='experiences.jsonl']
 * @param {string} [opts.contributorsFile='contributors.json']
 * @param {number} [opts.initCredit=DEFAULT_INIT_CREDIT]
 * @param {number} [opts.injectionPenalty=DEFAULT_INJECTION_PENALTY]
 */
function createExperienceStore({
  storeFile = 'experiences.jsonl',
  contributorsFile = 'contributors.json',
  initCredit = DEFAULT_INIT_CREDIT,
  injectionPenalty = DEFAULT_INJECTION_PENALTY,
} = {}) {
  let items = [];
  let contributors = {};
  let initialized = false;

  function persist() {
    fs.mkdirSync(path.dirname(storeFile), { recursive: true });
    writeJsonl(storeFile, items);
  }

  function persistContributors() {
    fs.mkdirSync(path.dirname(contributorsFile), { recursive: true });
    fs.writeFileSync(contributorsFile, JSON.stringify({ version: 1, contributors }, null, 2), 'utf8');
  }

  function load() {
    items = readJsonl(storeFile);
    contributors = {};
    if (fs.existsSync(contributorsFile)) {
      try {
        const data = JSON.parse(fs.readFileSync(contributorsFile, 'utf8'));
        if (data && typeof data.contributors === 'object') contributors = data.contributors;
      } catch (_e) {
        contributors = {};
      }
    }
    initialized = true;
  }

  function ensureInitialized() {
    if (!initialized) load();
  }

  /** 读某个贡献者当前信用（缺省为 initCredit 基线） */
  function contributorCredit(name) {
    ensureInitialized();
    const key = String(name || 'anonymous');
    return Number.isFinite(Number(contributors[key])) ? Number(contributors[key]) : initCredit;
  }

  /** 给贡献者加减分并落盘 */
  function adjustContributorCredit(name, delta, reason = '') {
    ensureInitialized();
    const key = String(name || 'anonymous');
    const cur = contributorCredit(key);
    contributors[key] = Math.max(0, Math.round((cur + delta) * 100) / 100);
    persistContributors();
    return { contributor: key, credit: contributors[key], delta, reason };
  }

  /** 信用表全量 */
  function contributorStats() {
    ensureInitialized();
    return { ...contributors };
  }

  /**
   * 新增经验：入库前注入检测，命中即拒 + 贡献者扣分。
   * @param {object} input
   * @param {string} [input.agent] 归属 agent（该经验适用于谁）
   * @param {string} [input.contributor] 贡献者
   * @param {string} [input.fingerprint]
   * @param {string} input.content 经验正文
   * @param {string} [input.title] [input.env]
   * @param {number} [input.expectedGain]
   * @returns {object} { ok, code, record? , injection_hits?, contributor_delta?, contributor? }
   */
  function add(input = {}) {
    ensureInitialized();
    const record = {
      agent: String(input.agent || 'unknown'),
      contributor: String(input.contributor || input.agent || 'anonymous'),
      fingerprint: String(input.fingerprint || input.skeleton || ''),
      content: String(input.content || input.fix || ''),
      title: String(input.title || ''),
      fix: String(input.fix || ''),
      verify: String(input.verify || ''),
      rootCause: String(input.rootCause || ''),
      symptom: String(input.symptom || ''),
      expectedGain: Number.isFinite(Number(input.expectedGain ?? input.expected_gain))
        ? Number(input.expectedGain ?? input.expected_gain)
        : 0,
      env: String(input.env || 'unknown'),
      unit: String(input.unit || 'E1'),
      probe: input.probe || null,
    };
    const scanText = buildScanText(record);
    const scan = detectInjection(scanText);
    if (!scan.safe) {
      const adj = adjustContributorCredit(record.contributor, injectionPenalty, 'injection_rejected');
      return {
        ok: false,
        code: 'INJECTION_REJECTED',
        injection_hits: scan.hits,
        contributor_delta: injectionPenalty,
        contributor: adj.contributor,
        contributor_credit: adj.credit,
      };
    }
    const entry = {
      id: genId('EXP'),
      ...record,
      status: 'active',
      credit: initCredit,
      hits: 0,
      created_at: nowIso(),
      updated_at: nowIso(),
    };
    // 贡献者信用基线：入库即记一次正向动作（轻量 +1 表示活跃贡献者）
    adjustContributorCredit(entry.contributor, 0, 'baseline');
    items.push(entry);
    persist();
    return { ok: true, code: 'ADDED', record: entry };
  }

  /**
   * 查询（HTTP GET /resources/experiences）：按 fingerprint/agent 过滤，
   * 只回 active 且 credit>0 的条目（与本地文件适配器语义一致）
   */
  function query({ fingerprint = '', agent = '', includeInactive = false } = {}) {
    ensureInitialized();
    return items
      .filter(
        (e) =>
          (!fingerprint || e.fingerprint === fingerprint) &&
          (!agent || e.agent === agent) &&
          (includeInactive || (e.status ? e.status === 'active' : true)) &&
          (typeof e.credit === 'number' ? e.credit > 0 : true)
      )
      .map((e) => ({ ...e }));
  }

  /** 全量（管理用途） */
  function listAll() {
    ensureInitialized();
    return items.map((e) => ({ ...e }));
  }

  /** 按 id 查找（含非 active，供复验使用） */
  function findById(id) {
    ensureInitialized();
    return items.find((e) => e.id === id) || null;
  }

  /** 删除（软删：status → retired；默认查询不再返回） */
  function remove(id, { hard = false } = {}) {
    ensureInitialized();
    const entry = findById(id);
    if (!entry) {
      throw new KernelError('EXP_NOT_FOUND', `经验不存在: ${id}`, { id });
    }
    if (hard) {
      items = items.filter((e) => e.id !== id);
    } else {
      entry.status = 'retired';
      entry.updated_at = nowIso();
    }
    persist();
    return { ok: true, id, status: hard ? 'deleted' : 'retired' };
  }

  /** 信用调整（复验/人工仲裁/注入扣分共用） */
  function adjustCredit(id, delta, reason = '', { toStatus = null } = {}) {
    ensureInitialized();
    const entry = findById(id);
    if (!entry) {
      throw new KernelError('EXP_NOT_FOUND', `经验不存在: ${id}`, { id });
    }
    entry.credit = Math.max(0, Math.round((entry.credit + delta) * 100) / 100);
    if (toStatus) entry.status = toStatus;
    entry.updated_at = nowIso();
    persist();
    return { id, credit: entry.credit, delta, reason, status: entry.status };
  }

  return {
    add,
    query,
    listAll,
    findById,
    remove,
    adjustCredit,
    contributorCredit,
    adjustContributorCredit,
    contributorStats,
    files: { storeFile, contributorsFile },
    get initialized() {
      return initialized;
    },
  };
}

module.exports = {
  createExperienceStore,
  buildScanText,
  DEFAULT_INIT_CREDIT,
  DEFAULT_INJECTION_PENALTY,
};

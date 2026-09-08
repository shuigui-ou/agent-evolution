/**
 * @module src/resources/solution-pool
 * @layer 资源服务（§5 解法索引）
 * @owner Alex（软件工程师，K5）
 *
 * 解法索引（solution pool）：
 *  - 种子入池：服务启动时把 fixtures/solution-seeds/*.jsonl 灌成初始解法索引，
 *    每条按 skeleton 计算检索指纹（normalizeFingerprint(skeleton)），种子 credit 初始 1；
 *  - 命中统计：每次 /resources/solutions 命中都向 hits 账本追加 {agent, env, ts}，
 *    落盘后回写命中数；跨 agent 命中（querying agent ≠ 贡献 agent）单列统计；
 *  - 只读/受控：本池是"外置解法索引"，任何请求都不写 agent 的知识面，
 *    候选只经 resource-client 交给内核裁决落地。
 *
 * 持久化（JSONL）：
 *  - solutions.jsonl        解法索引（每次变更全量重写，规模小）
 *  - solution-hits.jsonl    命中账本（append-only）
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
  appendJsonl,
} = require('../../kernel/src/util.cjs');
const { normalizeFingerprint } = require('../../kernel/src/signals.cjs');

/** 种子缺省 credit（K5 验收：种子 credit 初始 1） */
const DEFAULT_CREDIT = 1;

/** 贡献者缺省标签：种子为全局预置，不属于任何单 agent（对外即"他人解法"） */
const DEFAULT_AGENT = 'seed';

/** 列出 seeds 目录下全部 *.jsonl 文件的绝对路径 */
function listSeedFiles(seedsDir) {
  if (!seedsDir || !fs.existsSync(seedsDir)) return [];
  return fs
    .readdirSync(seedsDir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => path.join(seedsDir, f));
}

/** 把一条种子/外部解法原始行规范化为解法索引记录 */
function toSolutionRecord(raw = {}, { defaultAgent = DEFAULT_AGENT, baseSeed = false } = {}) {
  const skeleton = String(raw.skeleton || raw.fingerprint_key || raw.title || '').trim();
  const fingerprint = String(raw.fingerprint || (skeleton ? normalizeFingerprint(skeleton) : ''));
  const fix = String(raw.fix || raw.content || raw.content_text || '');
  const expectedGain = Number.isFinite(Number(raw.expectedGain ?? raw.expected_gain))
    ? Number(raw.expectedGain ?? raw.expected_gain)
    : 0;
  const probe = raw.probe || {
    trigger: `错误骨架「${skeleton || '未知'}」再现`,
    judge: '同错误再现时行为是否包含该修复动作',
  };
  return {
    id: raw.id || genId('SOL'),
    agent: String(raw.agent || defaultAgent),
    fingerprint,
    skeleton,
    category: String(raw.category || '未分类'),
    symptom: String(raw.symptom || raw.title || ''),
    rootCause: String(raw.rootCause || raw.root_cause || ''),
    fix,
    verify: String(raw.verify || ''),
    expectedGain,
    // 供内核候选池（candidates.cjs retrieveExternal）消费的字段别名
    expected_gain: expectedGain,
    content: fix,
    title: String(raw.title || skeleton || '外部解法'),
    unit: String(raw.unit || 'E1'),
    probe,
    target: raw.target || null,
    credit: Number.isFinite(Number(raw.credit)) ? Number(raw.credit) : DEFAULT_CREDIT,
    confidence: raw.confidence || null,
    source: String(raw.source || (baseSeed ? 'seed:' + baseSeed : 'unknown')),
    env: String(raw.env || 'unknown'),
    env_tags: Array.isArray(raw.env_tags) ? raw.env_tags.map(String) : [],
    origin: baseSeed ? 'seed' : String(raw.origin || 'external'),
    status: raw.status || 'active',
    hits: Number.isFinite(Number(raw.hits)) ? Number(raw.hits) : 0,
    created_at: raw.created_at || nowIso(),
  };
}

/**
 * 创建解法索引
 * @param {object} opts
 * @param {string} [opts.storeFile] - 解法索引 JSONL 路径
 * @param {string} [opts.hitsFile] - 命中账本 JSONL 路径
 * @param {string} [opts.seedsDir] - 种子目录（*.jsonl）
 * @param {string} [opts.defaultAgent='seed']
 */
function createSolutionPool({
  storeFile = 'solutions.jsonl',
  hitsFile = 'solution-hits.jsonl',
  seedsDir = null,
  defaultAgent = DEFAULT_AGENT,
} = {}) {
  let items = [];
  let initialized = false;

  function persist() {
    fs.mkdirSync(path.dirname(storeFile), { recursive: true });
    writeJsonl(storeFile, items);
  }

  /** 从命中账本重算每条解法命中数（保证落盘一致性） */
  function rebuildHitCounts() {
    const counts = {};
    for (const h of readJsonl(hitsFile)) {
      if (h && h.solution_id) counts[h.solution_id] = (counts[h.solution_id] || 0) + 1;
    }
    for (const it of items) it.hits = counts[it.id] || 0;
  }

  function load() {
    items = readJsonl(storeFile);
    rebuildHitCounts();
    initialized = true;
  }

  function ensureInitialized() {
    if (!initialized) load();
  }

  /**
   * 种子入池：索引文件不存在（或 force=true）时从 seedsDir 全部 *.jsonl 重建。
   * force 模式下同时清空命中账本（种子重灌，旧命中失去关联）。
   * @returns {{loaded: number, fromSeeds: number, force: boolean}}
   */
  function seedIfEmpty({ force = false } = {}) {
    ensureInitialized();
    if (items.length > 0 && !force) {
      return { loaded: items.length, fromSeeds: 0, force: false };
    }
    const seedFiles = listSeedFiles(seedsDir);
    const next = [];
    for (const file of seedFiles) {
      const base = path.basename(file, '.jsonl');
      for (const raw of readJsonl(file)) {
        if (!raw || typeof raw !== 'object') continue;
        const rec = toSolutionRecord(raw, { defaultAgent, baseSeed: base });
        if (!rec.fingerprint && !rec.skeleton) continue;
        next.push(rec);
      }
    }
    if (force && hitsFile && fs.existsSync(hitsFile)) {
      fs.rmSync(hitsFile, { force: true });
    }
    items = next;
    persist();
    return { loaded: items.length, fromSeeds: next.length, force: Boolean(force) };
  }

  /** 登记一条新解法（外部 agent 贡献或人工导入；不回灌种子） */
  function add(raw = {}) {
    ensureInitialized();
    if (!raw || typeof raw !== 'object') {
      throw new KernelError('POOL_INVALID', '解法记录必须是对象');
    }
    const rec = toSolutionRecord(raw, { defaultAgent });
    if (!rec.fingerprint && !rec.skeleton) {
      throw new KernelError('POOL_INVALID', '解法必须提供 fingerprint 或 skeleton');
    }
    if (!rec.fix && !rec.content) {
      throw new KernelError('POOL_INVALID', '解法必须提供 fix/content（可执行建议）');
    }
    items.push(rec);
    persist();
    return rec;
  }

  /** 按 id 查找 */
  function findById(id) {
    ensureInitialized();
    return items.find((it) => it.id === id) || null;
  }

  /** 索引全量 */
  function listAll() {
    ensureInitialized();
    return items.map((it) => ({ ...it }));
  }

  /**
   * 解法索引检索（§5）：同 fingerprint 他人解法 + 命中统计 + 环境标签。
   * 每次命中都会追加 hit 账本（agent/env 标签）并回写计数。
   * @param {object} q
   * @param {string} [q.fingerprint] - 检索指纹（16 hex）
   * @param {string} [q.skeleton] - 骨架文本（可选，人工友好）
   * @param {string} [q.agent] - 查询方 agent（用于跨 agent 判定）
   * @param {string} [q.env] - 查询方环境标签
   * @param {boolean} [q.recordHit=true] - 是否记录命中
   */
  function query({ fingerprint = '', skeleton = '', agent = '', env = '', recordHit = true } = {}) {
    ensureInitialized();
    const matched = items.filter((it) => {
      if (it.status && it.status !== 'active') return false;
      if (fingerprint) {
        if (it.fingerprint !== fingerprint) return false;
      } else if (skeleton) {
        const a = String(it.skeleton || '').toLowerCase();
        const b = String(skeleton).toLowerCase();
        if (!(a === b || a.includes(b) || b.includes(a))) return false;
      }
      return true;
    });

    const hits = [];
    for (const it of matched) {
      let isCross = false;
      if (agent && it.agent && String(it.agent) !== String(agent)) isCross = true;
      if (recordHit && (fingerprint || skeleton)) {
        const hitRec = {
          id: genId('HIT'),
          solution_id: it.id,
          fingerprint: it.fingerprint,
          agent: agent || 'unknown',
          env: env || 'unknown',
          cross_agent: isCross,
          ts: nowIso(),
        };
        hits.push(hitRec);
        appendJsonl(hitsFile, hitRec);
        it.hits = (it.hits || 0) + 1;
      }
    }
    if (hits.length) persist();

    const itemsOut = matched.map((it) => {
      const isCross = Boolean(agent) && Boolean(it.agent) && String(it.agent) !== String(agent);
      return {
        ...it,
        hit_count: it.hits,
        is_cross_agent: isCross,
        env_tags: it.env_tags,
        expected_gain: it.expected_gain,
        expectedGain: it.expectedGain,
      };
    });
    return {
      items: itemsOut,
      matched_count: matched.length,
      total_hits: matched.reduce((sum, it) => sum + (it.hits || 0), 0),
      recorded_hits: hits.length,
      cross_agent_hits: hits.filter((h) => h.cross_agent).length,
      query: { fingerprint, skeleton, agent, env },
    };
  }

  /** 索引统计 */
  function stats() {
    ensureInitialized();
    const hitsByAgent = {};
    const cross = {};
    let crossAgentHitCount = 0;
    for (const h of readJsonl(hitsFile)) {
      if (!h) continue;
      const ag = h.agent || 'unknown';
      hitsByAgent[ag] = (hitsByAgent[ag] || 0) + 1;
      if (h.cross_agent) {
        cross[ag] = (cross[ag] || 0) + 1;
        crossAgentHitCount += 1;
      }
    }
    return {
      pool_size: items.length,
      by_status: items.reduce((acc, it) => {
        acc[it.status || 'active'] = (acc[it.status || 'active'] || 0) + 1;
        return acc;
      }, {}),
      total_hits: Object.values(hitsByAgent).reduce((a, b) => a + b, 0),
      hits_by_agent: hitsByAgent,
      cross_agent_hits: crossAgentHitCount,
      cross_agent_hits_by_agent: cross,
    };
  }

  /** 调整解法信用（独立复验等受控路径使用；索引本身只读不对外暴露调整） */
  function adjustCredit(id, delta, reason = '') {
    ensureInitialized();
    const it = findById(id);
    if (!it) {
      throw new KernelError('POOL_NOT_FOUND', `解法不存在: ${id}`, { id });
    }
    it.credit = Math.max(0, Math.round((it.credit + delta) * 100) / 100);
    persist();
    return { id, credit: it.credit, delta, reason };
  }

  return {
    seedIfEmpty,
    add,
    findById,
    listAll,
    query,
    stats,
    adjustCredit,
    files: { storeFile, hitsFile },
    get initialized() {
      return initialized;
    },
  };
}

module.exports = { createSolutionPool, toSolutionRecord, listSeedFiles, DEFAULT_CREDIT, DEFAULT_AGENT };

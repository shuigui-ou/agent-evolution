/**
 * @module src/resources/service
 * @layer 资源服务（§5 四接口编排）
 * @owner Alex（软件工程师，K5）
 *
 * AED 资源服务装配入口：把解法索引/外置记忆/批分析/独立复验四个模块串成
 * 一个可被 HTTP 层或仓库内嵌调用的服务对象。形态 = 仓库内模块 + 可选 HTTP 进程。
 *
 * 原则（规范 §5 / T3）：外挂只提供只读/受控接口；任何方法都不写 agent 知识面，
 * 分析候选一律标 source=resource-* 供内核裁决。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createSolutionPool } = require('./solution-pool.cjs');
const { createExperienceStore } = require('./experience-store.cjs');
const { createAnalyzer } = require('./analyzer.cjs');
const { createVerifier } = require('./verifier.cjs');

const SERVICE_VERSION = '0.2.0';

/**
 * 创建资源服务
 * @param {object} opts
 * @param {string} [opts.root] - 仓库根（默认 process.cwd()）
 * @param {string} [opts.storeDir] - 资源数据目录（默认 <root>/runtime/resources）
 * @param {string} [opts.seedsDir] - 种子目录（默认 <root>/fixtures/solution-seeds）
 * @param {object} [opts.llm] - { enabled=false, provider='none' }
 * @param {object} [opts.store] - 可注入文件路径覆盖（测试用）
 */
function createResourceService({
  root = process.cwd(),
  storeDir = null,
  seedsDir = null,
  llm = { enabled: false, provider: 'none' },
  store = {},
} = {}) {
  const resolvedRoot = path.resolve(root);
  const dir = storeDir ? path.resolve(root, storeDir) : path.join(resolvedRoot, 'runtime', 'resources');
  const seeds = seedsDir ? path.resolve(root, seedsDir) : path.join(resolvedRoot, 'fixtures', 'solution-seeds');
  fs.mkdirSync(dir, { recursive: true });

  const solutions = createSolutionPool({
    storeFile: store.solutionsFile || path.join(dir, 'solutions.jsonl'),
    hitsFile: store.hitsFile || path.join(dir, 'solution-hits.jsonl'),
    seedsDir: seeds,
  });
  const experiences = createExperienceStore({
    storeFile: store.experiencesFile || path.join(dir, 'experiences.jsonl'),
    contributorsFile: store.contributorsFile || path.join(dir, 'contributors.json'),
  });
  const analyzer = createAnalyzer({ llm });
  const verifier = createVerifier({ experiences, solutions });

  /** 初始化：确保目录 + 种子入池（只灌一次） */
  function init({ resetSeeds = false } = {}) {
    fs.mkdirSync(dir, { recursive: true });
    const seeded = solutions.seedIfEmpty({ force: resetSeeds });
    return { ok: true, dir, seedsDir: seeds, seeded };
  }

  /** 服务状态 */
  function status() {
    const poolStats = solutions.stats();
    const exps = experiences.listAll();
    const contributors = experiences.contributorStats();
    return {
      service: 'agent-evolution-resource',
      version: SERVICE_VERSION,
      spec: 'EVOLUTION-KERNEL-SPEC §5',
      mode: 'external-resource（外挂不写知识面，落地归内核原语④）',
      dir,
      seeds_dir: seeds,
      llm: { enabled: Boolean(llm && llm.enabled), provider: (llm && llm.provider) || 'none' },
      solutions: poolStats,
      experiences: {
        total: exps.length,
        by_status: exps.reduce((acc, e) => {
          acc[e.status || 'active'] = (acc[e.status || 'active'] || 0) + 1;
          return acc;
        }, {}),
      },
      contributors,
    };
  }

  // ---- 四接口（HTTP 层与仓库内嵌都走这里） ----

  /** 外置记忆查询（GET /resources/experiences） */
  function queryExperiences(params = {}) {
    const items = experiences.query(params);
    return { items, count: items.length, ok: true };
  }

  /** 解法索引查询（GET /resources/solutions）：命中即记 hit 账本 */
  function querySolutions(params = {}) {
    const out = solutions.query({
      fingerprint: params.fingerprint || '',
      skeleton: params.skeleton || '',
      agent: params.agent || '',
      env: params.env || '',
      recordHit: params.recordHit !== false,
    });
    return {
      ok: true,
      items: out.items,
      matched_count: out.matched_count,
      total_hits: out.total_hits,
      recorded_hits: out.recorded_hits,
      cross_agent_hits: out.cross_agent_hits,
      query: out.query,
    };
  }

  /** 定时批分析（POST /jobs/analyze） */
  function analyzeTraces(params = {}) {
    return analyzer.analyzeTraces({
      tracesRef: params.traces_ref || params.tracesRef || '',
      agent: params.agent || 'unknown',
      env: params.env || 'unknown',
      baseDir: params.base_dir || resolvedRoot,
    });
  }

  /** 独立复验（POST /verify） */
  function verifyExperience(params = {}) {
    return verifier.verify({ experience_id: params.experience_id || params.experienceId || '' });
  }

  // ---- 经验库写路径（受控模块/CLI/未来宿主内嵌用；HTTP 不暴露） ----

  function addExperience(input = {}) {
    return experiences.add(input);
  }

  function removeExperience(id, opts = {}) {
    return experiences.remove(id, opts);
  }

  function listExperiences(params = {}) {
    return experiences.query(params);
  }

  /** 解法索引登记（受控写入；种子之外的补充候选） */
  function addSolution(input = {}) {
    return solutions.add(input);
  }

  function solutionStats() {
    return solutions.stats();
  }

  return {
    init,
    status,
    queryExperiences,
    querySolutions,
    analyzeTraces,
    verifyExperience,
    addExperience,
    removeExperience,
    listExperiences,
    addSolution,
    solutionStats,
    // 透传（测试/高级用途）
    subsystems: { solutions, experiences, analyzer, verifier },
    paths: { dir, seedsDir: seeds },
  };
}

module.exports = { createResourceService, SERVICE_VERSION };

/**
 * @module engine
 * @owner Kou（工程师，共享 engine K8）
 *
 * 共享进化引擎加载器（零依赖 CommonJS，可整体复制到任意宿主）。
 *
 * 设计目标（数据即接入）：
 *   宿主不再写"接线代码"——只需提供一份声明式 evolution.yaml：
 *     engine.load(yamlPath | yamlObj, opts)
 *       → 解析并校验 schema（失败抛 EngineError，带 EVOLUTION_* 错误码）
 *       → 定位并装配内核（kernelRoot 可指向 vendored 内核目录或复用共享内核）
 *       → 按 yaml 声明构建统一 handle（覆盖 Host A 的 ~25 个导出能力）
 *   失败路径 fail-safe 且"绝不静默吞"：schema/yaml 错误抛错；
 *   内核初始化故障降级为 degraded（宿主主流程不受影响）；
 *   写入越权/T4/注入由内核硬拒返回 code（不吞、不改写）。
 *
 * 本文件是 Host A（ai-novel-studio）evolution.cjs 语义的**配置化收敛版**：
 *   原硬编码常量（THREAD_TTL_MS / KNOWLEDGE_WHITELIST / SEED_SOURCE_NAME /
 *   DEFAULT_OBJECTIVES / dataDir / level）全部改由 evolution.yaml 声明。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { EngineError } = require('./errors.cjs');
const yamlMin = require('./yaml-min.cjs');

/** 引擎版本 */
const ENGINE_VERSION = '1.0.0';

/** yaml schema 版本（evolution.yaml 顶层 schema 字段） */
const SCHEMA_VERSION = 1;

/** 权限档位全集（与 kernel permission LEVELS 一致，仅用于 schema 校验） */
const LEVELS = Object.freeze(['auto', 'auto_report', 'ask', 'suggest', 'off']);

/** 六原语标识（与 kernel PRIMITIVES 一致） */
const PRIMITIVES = Object.freeze([
  'tap', 'pre_action', 'interrupt', 'write', 'checkpoint', 'audit',
]);

/** 统一日志前缀（只进 stderr，不污染宿主业务日志） */
function log(...args) {
  console.warn('[engine]', ...args);
}

// =====================================================================
// schema 校验（evolve.yaml v1 契约）
// =====================================================================

/**
 * 校验并规范化 evolution.yaml 配置对象。
 * @param {object} raw - 解析后的 yaml 对象
 * @param {string} yamlDir - yaml 所在目录（相对路径解析锚点）
 * @returns {object} 规范化配置
 * @throws {EngineError} EVOLUTION_SCHEMA_INVALID
 */
function validateConfig(raw, yamlDir) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new EngineError('EVOLUTION_SCHEMA_INVALID', 'evolution.yaml 顶层必须是对象');
  }
  if (!(raw.schema === SCHEMA_VERSION)) {
    throw new EngineError(
      'EVOLUTION_SCHEMA_INVALID',
      `schema 版本不匹配：期望 ${SCHEMA_VERSION}，得到 ${raw.schema}`,
      { expected: SCHEMA_VERSION, got: raw.schema }
    );
  }
  const meta = raw.meta || {};
  if (!meta.agent || typeof meta.agent !== 'string') {
    throw new EngineError('EVOLUTION_SCHEMA_INVALID', '缺少 meta.agent（agentId 必填）');
  }
  const kernel = raw.kernel || {};
  if (kernel.level !== undefined && !LEVELS.includes(kernel.level)) {
    throw new EngineError(
      'EVOLUTION_SCHEMA_INVALID',
      `kernel.level 非法：期望 ${LEVELS.join('|')}，得到 ${kernel.level}`,
      { level: kernel.level }
    );
  }
  if (kernel.primitives !== undefined) {
    if (!Array.isArray(kernel.primitives) || kernel.primitives.some((p) => !PRIMITIVES.includes(p))) {
      throw new EngineError('EVOLUTION_SCHEMA_INVALID', 'kernel.primitives 非法：只允许 ' + PRIMITIVES.join(','));
    }
  }
  if (kernel.audit !== undefined && typeof kernel.audit !== 'boolean') {
    throw new EngineError('EVOLUTION_SCHEMA_INVALID', 'kernel.audit 必须是布尔值');
  }
  if (kernel.dailyLimit !== undefined && (typeof kernel.dailyLimit !== 'number' || kernel.dailyLimit <= 0)) {
    throw new EngineError('EVOLUTION_SCHEMA_INVALID', 'kernel.dailyLimit 必须是正整数');
  }
  const knowledge = raw.knowledge || {};
  const whitelist = knowledge.whitelist || knowledge.files || [];
  if (!Array.isArray(whitelist) || !whitelist.length) {
    throw new EngineError('EVOLUTION_SCHEMA_INVALID', 'knowledge.whitelist 缺失或为空（必须声明可写知识面）');
  }
  const whitelistEntries = whitelist.map((w) => {
    if (typeof w === 'string') return { path: w };
    if (w && typeof w === 'object' && typeof w.path === 'string') return w;
    throw new EngineError('EVOLUTION_SCHEMA_INVALID', `knowledge.whitelist 条目非法：${JSON.stringify(w)}`);
  });
  for (const e of whitelistEntries) {
    if (path.isAbsolute(e.path)) {
      throw new EngineError('EVOLUTION_SCHEMA_INVALID', `knowledge.whitelist 必须是相对路径（相对 knowledge.root）：${e.path}`);
    }
  }
  const objectives = raw.objectives;
  if (objectives !== undefined) {
    if (!Array.isArray(objectives)) {
      throw new EngineError('EVOLUTION_SCHEMA_INVALID', 'objectives 必须是数组');
    }
    for (const o of objectives) {
      if (!o || typeof o !== 'object' || !o.title) {
        throw new EngineError('EVOLUTION_SCHEMA_INVALID', 'objective 必须含 title');
      }
      if (!Array.isArray(o.types)) {
        throw new EngineError('EVOLUTION_SCHEMA_INVALID', `objective「${o.title}」必须含 types 数组`);
      }
    }
  }
  const server = raw.server || {};
  if (server.enabled !== undefined && typeof server.enabled !== 'boolean') {
    throw new EngineError('EVOLUTION_SCHEMA_INVALID', 'server.enabled 必须是布尔值');
  }
  return {
    schema: SCHEMA_VERSION,
    meta: {
      agent: meta.agent,
      version: typeof meta.version === 'string' ? meta.version : '',
    },
    kernel: {
      dataDir: typeof kernel.dataDir === 'string' && kernel.dataDir ? kernel.dataDir : 'data/evolution',
      kernelRoot: typeof kernel.kernelRoot === 'string' && kernel.kernelRoot ? kernel.kernelRoot : null,
      level: kernel.level || 'auto_report',
      audit: kernel.audit !== false,
      dailyLimit: typeof kernel.dailyLimit === 'number' ? kernel.dailyLimit : 20,
      primitives: Array.isArray(kernel.primitives) ? kernel.primitives.slice() : PRIMITIVES.slice(),
      enabled: kernel.enabled !== false,
      configFile: typeof kernel.configFile === 'string' && kernel.configFile ? kernel.configFile : null,
    },
    knowledge: {
      root: typeof knowledge.root === 'string' && knowledge.root ? knowledge.root : 'data/evolution/knowledge',
      whitelist: whitelistEntries.map((e) => e.path),
      whitelistMeta: whitelistEntries,
    },
    seeds: raw.seeds && typeof raw.seeds === 'object' ? raw.seeds : null,
    objectives: objectives || [],
    signals: raw.signals && typeof raw.signals === 'object' ? raw.signals : {},
    thread: raw.thread && typeof raw.thread === 'object' ? raw.thread : {},
    analyze: raw.analyze && typeof raw.analyze === 'object' ? raw.analyze : {},
    server: {
      enabled: server.enabled === true,
      prefix: typeof server.prefix === 'string' && server.prefix ? server.prefix : '/api/evolution',
    },
    yamlDir,
  };
}

/** 读取 yaml 文件或对象 */
function parseSource(source) {
  if (source && typeof source === 'object') return source;
  if (typeof source === 'string') {
    const abs = path.resolve(source);
    if (!fs.existsSync(abs)) {
      throw new EngineError('EVOLUTION_YAML_NOT_FOUND', `evolution.yaml 不存在: ${abs}`, { path: abs });
    }
    const text = fs.readFileSync(abs, 'utf8');
    try {
      return yamlMin.parse(text);
    } catch (e) {
      if (e && e.code === 'YAML_PARSE_ERROR') throw e;
      throw new EngineError('EVOLUTION_YAML_INVALID', `evolution.yaml 解析失败: ${e.message}`);
    }
  }
  throw new EngineError('EVOLUTION_SCHEMA_INVALID', 'engine.load 需要 yaml 路径或配置对象');
}

// =====================================================================
// 引擎 handle 工厂（宿主无需再写内核接线；全部能力由 yaml 驱动）
// =====================================================================

/**
 * 创建引擎实例（等价于宿主 evolution.cjs 的 init + 全部导出）
 * @param {object} cfg - 规范化配置
 * @param {object} opts - 运行时覆盖（来自宿主 init(opts)）
 * @returns {object} handle（含全部能力方法与 meta）
 */
function createEngineHandle(cfg, opts = {}) {
  const yamlDir = cfg.yamlDir || process.cwd();
  const rootDir = opts.rootDir ? path.resolve(opts.rootDir) : yamlDir;
  const configFile = opts.configFile
    ? path.resolve(opts.configFile)
    : cfg.kernel.configFile
      ? path.resolve(yamlDir, cfg.kernel.configFile)
      : path.join(rootDir, 'config.json');
  const dataDir = opts.dataDir
    ? path.resolve(opts.dataDir)
    : path.resolve(rootDir, cfg.kernel.dataDir);

  const state = {
    inited: false,
    enabled: true,
    degraded: false,
    kernel: null,
    kernelModule: null, // 内核 index 模块（normalizeFingerprint 等导出）
    rootDir,
    configFile,
    dataDir,
    level: cfg.kernel.level,
    audit: cfg.kernel.audit,
    seedRecords: [],
    seedByFp: new Map(),
    signalTextByFp: new Map(),
    candidateByFp: new Map(),
    resolvedInterruptKeys: new Set(),
    timers: [],
    lastReport: null,
    // yaml 声明快照（status/meta 展示用）
    cfg,
  };

  /** 从宿主 config 文件读 evolution.enabled（缺省按 yaml kernel.enabled） */
  function readEnabledFromConfig() {
    try {
      if (fs.existsSync(configFile)) {
        const fileCfg = JSON.parse(fs.readFileSync(configFile, 'utf8'));
        if (fileCfg && fileCfg.evolution && typeof fileCfg.evolution.enabled === 'boolean') {
          return fileCfg.evolution.enabled;
        }
      }
    } catch (e) {
      log('读取 evolution.enabled 失败，按 yaml 默认处理：', e.message);
    }
    return cfg.kernel.enabled;
  }

  /** 从宿主 config 文件读 evolution.level（可选；缺省 yaml kernel.level） */
  function readLevelFromConfig() {
    try {
      if (fs.existsSync(configFile)) {
        const fileCfg = JSON.parse(fs.readFileSync(configFile, 'utf8'));
        if (fileCfg && fileCfg.evolution && typeof fileCfg.evolution.level === 'string') {
          return fileCfg.evolution.level;
        }
      }
    } catch (e) {
      log('读取 evolution.level 失败，按 yaml 默认处理：', e.message);
    }
    return cfg.kernel.level;
  }

  /** thread 账本默认生命周期（ms）：yaml thread.ttlMs 可覆盖，默认 24h */
  function threadTtlMs() {
    const v = Number(cfg.thread && cfg.thread.ttlMs);
    return v && v > 0 ? v : 24 * 3600 * 1000;
  }

  /** 自动周期批分析默认间隔（ms）：yaml analyze.intervalMs 可覆盖，默认 5 分钟 */
  function analyzeIntervalMs() {
    const v = Number(cfg.analyze && cfg.analyze.intervalMs);
    return v && v > 0 ? v : 5 * 60 * 1000;
  }

  /** 种子源文件默认名（导入 dataDir/seeds/ 用）：yaml seeds.fileName 优先，缺省固定名 */
  function seedFileName() {
    const fn = cfg.seeds && cfg.seeds.fileName;
    if (typeof fn === 'string' && fn) return fn;
    return String(cfg.meta.agent || 'agent').replace(/[^\w.-]/g, '_') + '.seeds.jsonl';
  }

  /** 解析种子源：opts.seedsFile 显式优先；否则 yaml seeds.source；否则根目录 seeds/ 下 *.jsonl */
  function resolveSeedSource() {
    if (opts.seedsFile && fs.existsSync(path.resolve(opts.seedsFile))) {
      return path.resolve(opts.seedsFile);
    }
    const src = cfg.seeds && cfg.seeds.source;
    if (typeof src === 'string' && src) {
      const candidate = path.resolve(yamlDir, src);
      if (fs.existsSync(candidate)) return candidate;
      // 兼容相对 rootDir 的写法
      const candidate2 = path.resolve(rootDir, src);
      if (fs.existsSync(candidate2)) return candidate2;
    }
    const dir = path.join(rootDir, 'seeds');
    const primary = path.join(dir, seedFileName());
    if (fs.existsSync(primary)) return primary;
    try {
      const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort();
      if (files.length) return path.join(dir, files[0]);
    } catch (_e) { /* 无 seeds 目录 */ }
    return null;
  }

  /** 种子导入：复制到 dataDir/seeds/<fileName>（幂等：目标已存在且内容一致则不动） */
  function importSeeds(source) {
    if (!source) return 0;
    const dest = path.join(state.dataDir, 'seeds', seedFileName());
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    let changed = false;
    if (!fs.existsSync(dest)) {
      changed = true;
    } else {
      try {
        if (fs.readFileSync(dest, 'utf8') !== fs.readFileSync(source, 'utf8')) changed = true;
      } catch (_e) {
        changed = true;
      }
    }
    if (changed) fs.copyFileSync(source, dest);
    return changed ? 1 : 0;
  }

  /** 读 JSONL 文件为对象数组（损坏行跳过，绝不抛异常） */
  function readJsonlSafe(file) {
    try {
      if (!file || !fs.existsSync(file)) return [];
      const out = [];
      for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
        const t = line.trim();
        if (!t) continue;
        try { out.push(JSON.parse(t)); } catch (_e) { /* 损坏行跳过 */ }
      }
      return out;
    } catch (_e) {
      return [];
    }
  }

  /** 装载种子记录并建 skeleton fingerprint 索引（内核已加载成功后调用） */
  function loadSeedRecords(kernel) {
    state.seedRecords = [];
    state.seedByFp.clear();
    const dir = path.join(state.dataDir, 'seeds');
    let files = [];
    try {
      files = fs.existsSync(dir)
        ? fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort().map((f) => path.join(dir, f))
        : [];
    } catch (_e) { files = []; }
    // normalizeFingerprint 由内核 index.cjs 导出（subsystems.signals 只含 classifySignal/aggregate）
    const normalizeFp =
      (state.kernelModule && typeof state.kernelModule.normalizeFingerprint === 'function')
        ? state.kernelModule.normalizeFingerprint
        : null;
    const seen = new Set();
    for (const file of files) {
      for (const rec of readJsonlSafe(file)) {
        if (!rec || !rec.skeleton || seen.has(rec.skeleton)) continue;
        seen.add(rec.skeleton);
        state.seedRecords.push(rec);
        if (normalizeFp) state.seedByFp.set(normalizeFp(String(rec.skeleton)), rec);
      }
    }
    return state.seedRecords.length;
  }

  /** 把一条 seed 记录转成宿主可读、可审计的经验正文 */
  function buildSeedContent(seed) {
    const lines = [`# ${seed.skeleton}`];
    if (seed.category) lines.push(`- 类别：${seed.category}`);
    if (seed.symptom) lines.push(`- 症状：${seed.symptom}`);
    if (seed.rootCause) lines.push(`- 根因：${seed.rootCause}`);
    if (seed.fix) lines.push(`- 修复：${seed.fix}`);
    if (seed.verify) lines.push(`- 验证：${seed.verify}`);
    if (seed.expectedGain != null) lines.push(`- 期望收益：${seed.expectedGain}`);
    if (seed.source) lines.push(`- 来源：${seed.source}`);
    return lines.join('\n');
  }

  /**
   * 本地候选生成器（engine 内置）：E 类信号 → 种子匹配检索；其余类型不产候选。
   * 行为与 Host A evolution.cjs 的 hostCandidateGenerator 完全一致。
   */
  async function hostCandidateGenerator(group) {
    if (!group || group.type !== 'E') return [];
    const fp = String(group.fingerprint || '');
    const text = String(group.title || '') + ' ' + String(state.signalTextByFp.get(fp) || '').toLowerCase();
    const out = [];
    for (const seed of state.seedRecords) {
      const sk = String(seed.skeleton || '').toLowerCase().trim();
      if (!sk) continue;
      const matched = text.includes(sk) || (state.seedByFp.has(fp) && state.seedByFp.get(fp) === seed);
      if (!matched) continue;
      const cand = {
        title: `修复「${seed.skeleton}」（${seed.category || '经验'}）`,
        content: buildSeedContent(seed),
        unit: 'E1',
        expected_gain: typeof seed.expectedGain === 'number' ? seed.expectedGain : 0.05,
        source: `seed:${seed.source || 'host'}`,
        probe: { trigger: String(seed.skeleton || ''), judge: String(seed.verify || '') },
      };
      out.push(cand);
      state.candidateByFp.set(fp, cand);
    }
    return out;
  }

  /** 内核懒加载：kernelRoot 解析 + require */
  function loadKernelModule() {
    let kernelRoot = null;
    if (opts.kernelRoot) {
      kernelRoot = path.resolve(opts.kernelRoot);
    } else if (cfg.kernel.kernelRoot) {
      kernelRoot = path.resolve(yamlDir, cfg.kernel.kernelRoot);
    } else {
      // 共享内核默认：engine 在 agent-evolution 仓库内时 = ../kernel/src
      const builtin = path.resolve(__dirname, '..', 'kernel', 'src');
      if (fs.existsSync(path.join(builtin, 'index.cjs'))) kernelRoot = builtin;
    }
    if (!kernelRoot || !fs.existsSync(kernelRoot)) {
      throw new EngineError(
        'EVOLUTION_KERNEL_NOT_FOUND',
        `无法定位内核目录（kernel.kernelRoot / opts.kernelRoot 均无效）`,
        { kernelRoot }
      );
    }
    const indexFile = path.join(kernelRoot, 'index.cjs');
    const kernelFile = path.join(kernelRoot, 'kernel.cjs');
    if (fs.existsSync(indexFile)) {
      const mod = require(indexFile);
      if (mod && typeof mod.createKernel === 'function') return mod;
    }
    if (fs.existsSync(kernelFile)) {
      const mod = require(kernelFile);
      if (mod && typeof mod.createKernel === 'function') return mod;
    }
    throw new EngineError(
      'EVOLUTION_KERNEL_NOT_FOUND',
      `内核模块缺少 createKernel 导出: ${kernelRoot}`,
      { kernelRoot }
    );
  }

  // ---- 装配内核（失败 → degraded，不影响宿主主流程；调用方负责 schema 校验先行） ----
  function assemble() {
    state.inited = true;
    state.degraded = false;
    state.kernel = null;
    state.seedRecords = [];
    state.seedByFp.clear();
    state.signalTextByFp.clear();
    state.candidateByFp.clear();
    state.resolvedInterruptKeys.clear();
    state.lastReport = null;
    for (const t of state.timers) { try { clearInterval(t); } catch (_e) { /* ignore */ } }
    state.timers = [];

    state.enabled = readEnabledFromConfig();
    state.level = opts.level || readLevelFromConfig();
    if (!state.enabled) {
      log('evolution.enabled=false，引擎完全旁路');
      return;
    }
    try {
      importSeeds(resolveSeedSource());
      const kernelMod = loadKernelModule();
      state.kernelModule = kernelMod;
      const knowledgeRoot = path.resolve(rootDir, cfg.knowledge.root);
      fs.mkdirSync(knowledgeRoot, { recursive: true });
      state.kernel = kernelMod.createKernel({
        dataDir: state.dataDir,
        host: {
          agentId: cfg.meta.agent,
          primitives: cfg.kernel.primitives.slice(),
        },
        knowledgeSurface: { root: knowledgeRoot, whitelist: cfg.knowledge.whitelist.slice() },
        objectives: (cfg.objectives || []).map((o) => ({ ...o })),
        level: state.level,
        dailyLimit: cfg.kernel.dailyLimit,
        candidateGenerator: hostCandidateGenerator,
      });
      loadSeedRecords(state.kernel);
      try {
        state.kernel.loadExperiences().catch((e) => log('loadExperiences 失败（不影响主流程）：', e.message));
      } catch (e) {
        log('loadExperiences 同步失败（不影响主流程）：', e.message);
      }
    } catch (e) {
      state.degraded = true;
      state.kernel = null;
      log('内核初始化失败，进入降级旁路（不影响宿主主流程）：', e.message);
    }
  }

  /** 集成层是否就绪 */
  function ready() {
    return !!(state.enabled && state.inited && state.kernel);
  }

  /** 开关是否生效（含降级判断） */
  function isEnabled() {
    return ready() && !state.degraded;
  }

  /** 未就绪时的统一失败返回（区分「关了」与「坏了」） */
  function notReady() {
    return { ok: false, reason: state.enabled ? 'degraded' : 'disabled' };
  }

  /** 内核子系统访问器（异常返回 null） */
  function subs() {
    if (!state.kernel) return null;
    try {
      return state.kernel.subsystems;
    } catch (e) {
      log('访问内核子系统失败：', e.message);
      return null;
    }
  }

  /** interrupt 问题 key（去重裁决用） */
  function interruptKey(q) {
    return String(q.title || '') + '|' + String(q.ts || '');
  }

  /** 未裁决的 interrupt 问题 */
  function unresolvedInterrupts() {
    if (!ready()) return [];
    try {
      return (state.kernel.pendingInterrupts() || []).filter((q) => !state.resolvedInterruptKeys.has(interruptKey(q)));
    } catch (_e) {
      return [];
    }
  }

  /** 把 write 分配的 experience_id 回填进知识面最后一行 */
  function backfillExperienceId(surfaceAbs, experienceId) {
    try {
      if (!surfaceAbs || !experienceId || !fs.existsSync(surfaceAbs)) return;
      const raw = fs.readFileSync(surfaceAbs, 'utf8');
      const lines = raw.split(/\r?\n/);
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i].trim()) continue;
        try {
          const obj = JSON.parse(lines[i]);
          if (!obj.experience_id) {
            obj.experience_id = experienceId;
            lines[i] = JSON.stringify(obj);
          }
          break;
        } catch (_e) {
          break;
        }
      }
      fs.writeFileSync(surfaceAbs, lines.join('\n'), 'utf8');
    } catch (e) {
      log('backfillExperienceId 失败（不影响主流程）：', e.message);
    }
  }

  /** 用户裁决落地 */
  function landCandidate(cand, fingerprint) {
    try {
      const kernel = state.kernel;
      const target = kernel.paths.defaultSurface;
      if (!target) return { ok: false, reason: 'no_surface' };
      const perm = kernel.subsystems.permission;
      const orig = perm.getLevel();
      const switched = orig !== 'auto_report';
      if (switched) perm.setLevel('auto_report', { source: 'user' });
      let result;
      try {
        result = kernel.write(target, {
          content: JSON.stringify({
            experience_id: '',
            fingerprint: String(fingerprint || ''),
            title: cand.title || '',
            content: cand.content || '',
            unit: cand.unit || 'E1',
            status: 'active',
            probe: cand.probe || null,
          }),
          unit: cand.unit || 'E1',
          mode: 'append',
          probe: cand.probe || { trigger: '', judge: '' },
          fingerprint: String(fingerprint || ''),
        });
        if (result && result.ok) backfillExperienceId(result.path, result.experience_id);
      } finally {
        if (switched) perm.setLevel(orig, { source: 'user' });
      }
      return result;
    } catch (e) {
      log('landCandidate 失败（不影响宿主主流程）：', e.message);
      return { ok: false, reason: 'kernel_error', error: e.message };
    }
  }

  // =====================================================================
  // 以下各方法与 Host A evolution.cjs 导出语义一一对应（yaml 驱动）
  // =====================================================================

  /** 原语① E 类 tap */
  function tapE({ title, detail = '', taskId = '', source = 'host' } = {}) {
    if (!ready()) return notReady();
    const s = subs();
    if (!s) return notReady();
    try {
      const signal = s.signals.classifySignal({
        kind: 'runtime_error',
        title: String(title || 'host error'),
        detail: String(detail || ''),
        source: String(source || 'host'),
        taskId: String(taskId || ''),
      });
      const textKey = String(signal.title + ' ' + signal.detail).toLowerCase();
      if (!state.signalTextByFp.has(signal.fingerprint)) {
        state.signalTextByFp.set(signal.fingerprint, textKey);
      }
      state.kernel.tap({
        kind: 'error',
        payload: {
          message: signal.title,
          detail: signal.detail,
          source: signal.source,
          fingerprint: signal.fingerprint,
        },
        task_id: signal.task_id,
        session_id: signal.session_id,
      });
      const signalsFile = path.join(state.dataDir, 'signals', 'signals.jsonl');
      fs.mkdirSync(path.dirname(signalsFile), { recursive: true });
      fs.appendFileSync(signalsFile, JSON.stringify(signal) + '\n', 'utf8');
      s.audit.append('HOST_TAP_E', {
        fingerprint: signal.fingerprint,
        title: signal.title,
        taskId: signal.task_id,
        source: signal.source,
      });
      return { ok: true, signalId: signal.id, fingerprint: signal.fingerprint, tier: state.kernel.tier() };
    } catch (e) {
      log('tapE 采集失败（不影响宿主主流程）：', e.message);
      return { ok: false, reason: 'kernel_error' };
    }
  }

  /** 原语① I 类 tap：长任务开始 */
  function openThread({ taskId = '', title, detail = '', ttlMs } = {}) {
    if (!ready()) return notReady();
    const s = subs();
    if (!s) return notReady();
    try {
      const ttl = Math.max(1000, Number(ttlMs) || threadTtlMs());
      const entry = s.ledger.open({
        ledger: 'thread',
        title: String(title || '未命名长任务'),
        detail: String(detail || ''),
        dueAt: new Date(Date.now() + ttl).toISOString(),
        taskId: String(taskId || ''),
      });
      s.audit.append('HOST_THREAD_OPEN', { entry_id: entry.id, title: entry.title, taskId: entry.task_id });
      return { ok: true, threadId: entry.id };
    } catch (e) {
      log('openThread 失败（不影响宿主主流程）：', e.message);
      return { ok: false, reason: 'kernel_error' };
    }
  }

  /** 长任务结束 → 闭合 thread 记录 */
  function closeThread(threadId, outcome = null) {
    if (!ready() || !threadId) return notReady();
    const s = subs();
    if (!s) return notReady();
    try {
      const entry = s.ledger.close(threadId, { outcome });
      s.audit.append('HOST_THREAD_CLOSE', { entry_id: entry.id, outcome });
      return { ok: true, entry };
    } catch (e) {
      log('closeThread 失败（不影响宿主主流程）：', e.message);
      return { ok: false, reason: 'kernel_error' };
    }
  }

  /** 原语⑤ checkpoint */
  function checkpoint(label = '', files = []) {
    if (!ready()) return notReady();
    const s = subs();
    if (!s) return notReady();
    try {
      const abs = (Array.isArray(files) ? files : [])
        .map((f) => path.resolve(String(f)))
        .filter((f) => {
          try {
            return fs.statSync(f).isFile();
          } catch (_e) {
            return false;
          }
        });
      if (!abs.length) return { ok: false, reason: 'no_files' };
      const rec = s.snapshot.snapshot(abs);
      s.audit.append('HOST_CHECKPOINT', { snapshot_id: rec.id, version: rec.version, label, files: abs });
      return { ok: true, snapshotId: rec.id, version: rec.version };
    } catch (e) {
      log('checkpoint 失败（不影响宿主主流程）：', e.message);
      return { ok: false, reason: 'kernel_error' };
    }
  }

  /** 便利：对宿主小说数据文件（data/novels/<id>.json）做快照（rootDir 相对） */
  function checkpointNovel(novel, label = '长任务前') {
    try {
      if (!novel || !novel.id) return { ok: false, reason: 'no_novel_id' };
      return checkpoint(label, [path.join(rootDir, 'data', 'novels', String(novel.id) + '.json')]);
    } catch (e) {
      log('checkpointNovel 失败（不影响宿主主流程）：', e.message);
      return { ok: false, reason: 'kernel_error' };
    }
  }

  /** 原语⑥ 回滚 */
  function rollback(snapshotId) {
    if (!ready()) return notReady();
    try {
      const result = state.kernel.rollback(snapshotId);
      return { ok: true, ...result };
    } catch (e) {
      log('rollback 失败（不影响宿主主流程）：', e.message);
      return { ok: false, reason: 'kernel_error' };
    }
  }

  /** 原语⑥ 审计 */
  function audit(type, payload = {}) {
    if (!ready()) return notReady();
    const s = subs();
    if (!s) return notReady();
    try {
      const rec = s.audit.append(String(type || 'HOST_EVENT'), payload || {});
      return { ok: true, seq: rec.seq, hash: rec.hash };
    } catch (e) {
      log('audit 追加失败（不影响宿主主流程）：', e.message);
      return { ok: false, reason: 'kernel_error' };
    }
  }

  /** 审计只读视图 */
  function getAuditTail(n = 50) {
    if (!ready()) return { ...notReady(), total: 0, records: [], verify: null };
    const s = subs();
    if (!s) return { ...notReady(), total: 0, records: [], verify: null };
    try {
      const all = s.audit.list();
      const limit = Math.max(1, Math.min(Number(n) || 50, 1000));
      return { ok: true, total: all.length, records: all.slice(-limit), verify: s.audit.verify() };
    } catch (e) {
      log('getAuditTail 失败（不影响宿主主流程）：', e.message);
      return { ok: false, reason: 'kernel_error', total: 0, records: [], verify: null };
    }
  }

  /** 审计链完整性校验 */
  function verifyAudit() {
    if (!ready()) return { ok: false, reason: state.enabled ? 'degraded' : 'disabled' };
    const s = subs();
    if (!s) return { ok: false, reason: 'degraded' };
    try {
      return s.audit.verify();
    } catch (e) {
      log('verifyAudit 失败（不影响宿主主流程）：', e.message);
      return { ok: false, reason: 'kernel_error' };
    }
  }

  /** /api/config 保存时保留 evolution 字段（host config.json 场景） */
  function preserveConfigKey(nextCfg) {
    try {
      if (!nextCfg || typeof nextCfg !== 'object') return nextCfg;
      if (nextCfg.evolution) return nextCfg;
      if (fs.existsSync(configFile)) {
        const prev = JSON.parse(fs.readFileSync(configFile, 'utf8'));
        if (prev && prev.evolution) nextCfg.evolution = prev.evolution;
      }
    } catch (e) {
      log('preserveConfigKey 失败（不影响宿主主流程）：', e.message);
    }
    return nextCfg;
  }

  /** 只读状态视图 */
  function status() {
    const base = {
      enabled: state.enabled,
      degraded: state.degraded,
      dataDir: state.dataDir,
      agent: cfg.meta.agent,
      schema: SCHEMA_VERSION,
      engine: ENGINE_VERSION,
      server: cfg.server,
    };
    if (!ready()) return base;
    const s = subs();
    if (!s) return { ...base, degraded: true };
    try {
      const all = s.ledger.list();
      let tier = '', level = '', version = '', seedCount = 0, pendingCount = 0;
      try { tier = state.kernel.tier(); } catch (_e) { tier = 'P0'; }
      try { level = s.permission.getLevel(); } catch (_e) { level = state.level; }
      try { version = state.kernel.version(); } catch (_e) { version = ''; }
      seedCount = state.seedRecords.length;
      pendingCount = unresolvedInterrupts().length;
      return {
        ...base,
        tier,
        level,
        version,
        seedCount,
        pendingCount,
        auditLength: s.audit.length(),
        auditVerify: s.audit.verify().ok,
        openThreads: s.ledger.listOpen('thread').length,
        errorSignals: all.filter((x) => x.ledger === 'error').length,
        snapshots: s.snapshot.list().length,
        lastCycleAt: state.lastReport ? state.lastReport.ended_at : null,
        divergence: divergenceSummary(),
        alignmentPending: unresolvedInterrupts().filter((q) => q.kind === 'alignment_review').length,
      };
    } catch (e) {
      log('status 读取失败（不影响宿主主流程）：', e.message);
      return { ...base, degraded: true };
    }
  }

  function getTier() {
    if (!ready()) return 'P0';
    try {
      return state.kernel.tier();
    } catch (_e) {
      return 'P0';
    }
  }

  function getLevel() {
    if (!ready()) return state.level;
    try {
      return state.kernel.subsystems.permission.getLevel();
    } catch (_e) {
      return state.level;
    }
  }

  function getSeedCount() {
    return state.seedRecords.length;
  }

  /** 周期批分析（八步链路主入口） */
  async function runCycle() {
    if (!ready()) return { ok: false, ...notReady() };
    try {
      const report = await state.kernel.analyze();
      state.lastReport = report;
      persistCycleReport(report);
      return { ok: true, ...report };
    } catch (e) {
      log('runCycle 失败（不影响宿主主流程）：', e.message);
      return { ok: false, reason: 'kernel_error', error: e.message };
    }
  }

  /** auto_report 周期报告落盘 */
  function persistCycleReport(report) {
    try {
      if (!report || (!report.decisions && !report.groups)) return;
      const decisions = Array.isArray(report.decisions) ? report.decisions : [];
      if (!decisions.length) return;
      const file = path.join(state.dataDir, 'reports', 'reports.jsonl');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(
        file,
        JSON.stringify({
          ts: new Date().toISOString(),
          started_at: report.started_at,
          ended_at: report.ended_at,
          signal_count: report.signal_count,
          groups: (report.groups || []).length,
          landed: decisions.filter((d) => d.action === 'land' || d.action === 'land_report').length,
          decisions: decisions.map((d) => ({
            fingerprint: d.fingerprint,
            action: d.action,
            reason: d.reason || (d.result ? d.result.code : '') || '',
            version: d.version || null,
            candidate_id: d.candidate_id || null,
          })),
        }) + '\n',
        'utf8'
      );
    } catch (e) {
      log('周期报告落盘失败（不影响主流程）：', e.message);
    }
  }

  /** 周期再评估：probe 误触发自动回滚检查 */
  function evaluate(opts = {}) {
    if (!ready()) return notReady();
    try {
      return state.kernel.checkAutoRollback(opts);
    } catch (e) {
      log('evaluate 失败（不影响宿主主流程）：', e.message);
      return { ok: false, reason: 'kernel_error', rolledBack: [] };
    }
  }

  /** 启动周期自动批分析 */
  function startAutoAnalyze({ intervalMs } = {}) {
    if (!ready()) return { ok: false, ...notReady() };
    const ms = Math.max(5000, Number(intervalMs) || analyzeIntervalMs());
    const timer = setInterval(() => {
      runCycle().catch((_e) => { /* runCycle 内部已兜住 */ });
    }, ms);
    if (typeof timer.unref === 'function') timer.unref();
    state.timers.push(timer);
    return { ok: true, intervalMs: ms };
  }

  /** 停止周期自动批分析 */
  function stopAutoAnalyze() {
    for (const t of state.timers) {
      try { clearInterval(t); } catch (_e) { /* ignore */ }
    }
    state.timers = [];
    return { ok: true, stopped: state.timers.length };
  }

  /** 原语④ 知识面写入（host 白名单内） */
  function knowledgeWrite(relPath, change = {}, opts = {}) {
    if (!ready()) return notReady();
    if (!relPath || typeof relPath !== 'string') return { ok: false, reason: 'no_path' };
    try {
      const root = state.kernel.paths.surfaceRoot;
      const target = path.resolve(root, String(relPath));
      let payload = change || {};
      const isJsonl = String(relPath).toLowerCase().endsWith('.jsonl');
      if (isJsonl && typeof change.content === 'string' && !change.rawJsonl) {
        const unit = String(change.unit || 'E1').toUpperCase();
        payload = {
          content: JSON.stringify({
            experience_id: '',
            fingerprint: String(change.fingerprint || ''),
            title: change.title || `经验条目（${unit}）`,
            content: change.content,
            unit,
            status: 'active',
            probe: change.probe || null,
          }),
          unit,
          mode: change.mode || 'append',
          probe: change.probe,
          fingerprint: String(change.fingerprint || ''),
        };
      }
      const result = state.kernel.write(target, payload, opts);
      if (result && result.ok && result.path && result.experience_id) {
        backfillExperienceId(result.path, result.experience_id);
      }
      return result;
    } catch (e) {
      log('knowledgeWrite 失败（不影响宿主主流程）：', e.message);
      return { ok: false, reason: 'kernel_error', error: e.message };
    }
  }

  /** 知识面只读视图 */
  function listKnowledge() {
    if (!ready()) return [];
    try {
      const out = [];
      for (const w of state.kernel.paths.whitelistAbs || []) {
        if (!w || !fs.existsSync(w)) continue;
        let st = null;
        try { st = fs.statSync(w); } catch (_e) { st = null; }
        if (!st || !st.isFile()) continue;
        const text = fs.readFileSync(w, 'utf8');
        const lines = text.split(/\r?\n/).filter((l) => l.trim());
        const rows = [];
        for (const line of lines) {
          try { rows.push(JSON.parse(line)); } catch (_e) { rows.push({ raw: line }); }
        }
        out.push({ file: path.basename(w), absPath: w, lineCount: lines.length, rows });
      }
      return out;
    } catch (e) {
      log('listKnowledge 读取失败（不影响宿主主流程）：', e.message);
      return [];
    }
  }

  /**
   * 白名单内知识面原始读取（供宿主按需解析，如 pitfalls.json / learnings.jsonl）。
   * @param {string} relPath - 相对 knowledge.root 的路径（必须命中白名单前缀）
   * @returns {{ok:boolean, code?:string, path?:string, ext?:string, text?:string, rows?:object[], reason?:string}}
   *   越权返回 { ok:false, code:'PATH_NOT_WHITELISTED' }（fail-safe，绝不静默）。
   */
  function readKnowledge(relPath) {
    if (!ready()) return notReady();
    if (!relPath || typeof relPath !== 'string') return { ok: false, code: 'NO_PATH', reason: 'no_path' };
    try {
      const root = state.kernel.paths.surfaceRoot;
      const target = path.resolve(root, String(relPath));
      const allowed = (state.kernel.paths.whitelistAbs || []).find(
        (w) => target === w || target.startsWith(w + path.sep)
      );
      if (!allowed) {
        return { ok: false, code: 'PATH_NOT_WHITELISTED', reason: 'path_not_whitelisted', path: target };
      }
      if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
        return { ok: false, code: 'FILE_NOT_FOUND', reason: 'file_not_found', path: target };
      }
      const text = fs.readFileSync(target, 'utf8');
      const ext = path.extname(target).toLowerCase();
      if (ext === '.jsonl') {
        const rows = [];
        for (const line of text.split(/\r?\n/)) {
          const t = line.trim();
          if (!t) continue;
          try { rows.push(JSON.parse(t)); } catch (_e) { rows.push({ raw: line }); }
        }
        return { ok: true, path: target, ext, text, rows };
      }
      if (ext === '.json' || ext === '.md' || ext === '.txt') {
        return { ok: true, path: target, ext, text };
      }
      return { ok: true, path: target, ext, text };
    } catch (e) {
      log('readKnowledge 读取失败（不影响宿主主流程）：', e.message);
      return { ok: false, code: 'KERNEL_ERROR', reason: 'kernel_error', error: e.message };
    }
  }

  /** probe 双账本记分 */
  function scoreProbe(experienceId, outcome, opts = {}) {
    if (!ready()) return notReady();
    try {
      const rec = state.kernel.scoreProbe(String(experienceId || ''), String(outcome || ''), opts || {});
      return { ok: true, id: rec.id, outcome: rec.outcome, score: rec.score, effective: rec.effective, ts: rec.ts };
    } catch (e) {
      log('scoreProbe 失败（不影响宿主主流程）：', e.message);
      return { ok: false, reason: 'kernel_error' };
    }
  }

  /** probe 双账本统计 */
  function probeStats(experienceId) {
    if (!ready()) return { ok: false, ...notReady(), written: null, effective: null };
    try {
      const stats = state.kernel.subsystems.probe.stats(String(experienceId || ''));
      return { ok: true, written: stats.written, effective: stats.effective };
    } catch (e) {
      log('probeStats 失败（不影响宿主主流程）：', e.message);
      return { ok: false, reason: 'kernel_error', written: null, effective: null };
    }
  }

  /** 批量读取待裁决 interrupt */
  function pendingInterrupts() {
    return unresolvedInterrupts().map((q) => ({
      kind: q.kind || 'landing',
      title: q.title,
      ts: q.ts,
      options: q.options || ['adopt', 'reject'],
      evidence_summary: q.evidence_summary || {},
    }));
  }

  /** 原语③ interrupt 批量裁决 */
  function resolveInterrupt(index, decision = 'reject', opts = {}) {
    if (!ready()) return notReady();
    try {
      const all = unresolvedInterrupts();
      const q = all[Number(index)];
      if (!q) return { ok: false, reason: 'not_found' };
      const key = interruptKey(q);
      const fp = (q.evidence_summary && q.evidence_summary.fingerprint) || '';
      const candId = (q.evidence_summary && q.evidence_summary.candidate_id) || '';
      if (decision !== 'adopt') {
        state.resolvedInterruptKeys.add(key);
        let vetoed = false;
        if (fp && candId) {
          try {
            state.kernel.recordVeto(fp, candId, { reason: String(opts.reason || '') });
            vetoed = true;
          } catch (ve) {
            log('recordVeto 失败（不影响裁决主流程）：', ve.message);
          }
        }
        state.kernel.subsystems.audit.append('HOST_INTERRUPT_REJECT', {
          title: q.title,
          fingerprint: fp,
          candidate_id: candId,
          reason: String(opts.reason || ''),
          veto_recorded: vetoed,
        });
        return { ok: true, decision: 'reject', title: q.title, veto_recorded: vetoed };
      }
      const cand = state.candidateByFp.get(fp);
      if (!cand) {
        state.resolvedInterruptKeys.add(key);
        state.kernel.subsystems.audit.append('HOST_INTERRUPT_ADOPT_FAIL', {
          title: q.title,
          fingerprint: fp,
          reason: 'no_candidate',
        });
        return { ok: false, reason: 'no_candidate' };
      }
      const result = landCandidate(cand, fp);
      state.resolvedInterruptKeys.add(key);
      if (fp && candId) {
        try {
          state.kernel.recordAdoption(fp, candId);
        } catch (ae) {
          log('recordAdoption 失败（不影响裁决主流程）：', ae.message);
        }
      }
      state.kernel.subsystems.audit.append('HOST_INTERRUPT_ADOPT', {
        title: q.title,
        fingerprint: fp,
        candidate_id: candId,
        experience_id: (result && result.experience_id) || null,
        ok: !!(result && result.ok),
      });
      return { ok: true, decision: 'adopt', title: q.title, result };
    } catch (e) {
      log('resolveInterrupt 失败（不影响宿主主流程）：', e.message);
      return { ok: false, reason: 'kernel_error', error: e.message };
    }
  }

  /** 原语② pre_action 前置同步 hook（gate 版：含待落地拦截） */
  function preActionGate(ctx = {}) {
    if (!ready()) return { ok: false, ...notReady(), intercept: false };
    const action = String(ctx.action || 'host');
    const guidance = [];
    let inject = null;
    try {
      inject = state.kernel.preAction({
        payload: {
          action,
          novelId: String(ctx.novelId || ''),
          ...(ctx.payload || {}),
        },
      });
      if (inject && inject.kind === 'inject_guidance') {
        guidance.push(`已有可用经验：${inject.text}`);
      }
    } catch (e) {
      log('preAction 查询失败（不影响宿主主流程）：', e.message);
      inject = null;
    }
    const pending = unresolvedInterrupts();
    const intercept = pending.length > 0;
    if (intercept) {
      guidance.push(`有 ${pending.length} 条待用户裁决的进化落地询问（原语③），请在处理 interrupts 后再执行写型动作 "${action}"。`);
    }
    return {
      ok: true,
      action,
      intercept,
      pending: pending.length,
      reason: intercept ? 'pending_interrupt_intercept' : 'ok',
      guidance: guidance.join('\n'),
      inject,
    };
  }

  /** 直接调用内核 preAction */
  function preAction(event = {}) {
    if (!ready()) return notReady();
    try {
      return state.kernel.preAction(event);
    } catch (e) {
      log('preAction 失败（不影响宿主主流程）：', e.message);
      return null;
    }
  }

  /** 候选分解展示数据 */
  function topCandidates(fingerprint, n = 3) {
    if (!ready()) return { ok: false, ...notReady(), candidates: [] };
    if (!fingerprint) return { ok: false, reason: 'no_fingerprint', candidates: [] };
    try {
      return {
        ok: true,
        fingerprint: String(fingerprint),
        candidates: state.kernel.topCandidates(String(fingerprint), Number(n) || 3),
      };
    } catch (e) {
      log('topCandidates 读取失败（不影响宿主主流程）：', e.message);
      return { ok: false, reason: 'kernel_error', candidates: [] };
    }
  }

  /** 目标栈只读视图 */
  function listObjectives() {
    if (!ready()) return { ok: false, ...notReady(), objectives: [] };
    try {
      return { ok: true, objectives: state.kernel.subsystems.objectiveStack.list() };
    } catch (e) {
      log('listObjectives 读取失败（不影响宿主主流程）：', e.message);
      return { ok: false, reason: 'kernel_error', objectives: [] };
    }
  }

  /** user 语义修改目标 */
  function updateObjective(id, patch = {}) {
    if (!ready()) return notReady();
    if (!id || typeof patch !== 'object' || !Object.keys(patch).length) {
      return { ok: false, reason: 'invalid_patch' };
    }
    try {
      const obj = state.kernel.updateObjective(String(id), patch);
      return { ok: true, objective: obj };
    } catch (e) {
      log('updateObjective 失败（不影响宿主主流程）：', e.message);
      return { ok: false, reason: 'kernel_error', error: e.message };
    }
  }

  /** 偏好学习建议列表 */
  function preferenceSuggestions() {
    if (!ready()) return { ok: false, ...notReady(), suggestions: [] };
    try {
      return { ok: true, suggestions: state.kernel.preferenceSuggestions() };
    } catch (e) {
      log('preferenceSuggestions 读取失败（不影响宿主主流程）：', e.message);
      return { ok: false, reason: 'kernel_error', suggestions: [] };
    }
  }

  /** 应用偏好建议 */
  function applySuggestion(id) {
    if (!ready()) return notReady();
    if (!id) return { ok: false, reason: 'no_suggestion_id' };
    try {
      const result = state.kernel.applySuggestion(String(id), { source: 'user' });
      return { ok: true, ...result };
    } catch (e) {
      log('applySuggestion 失败（不影响宿主主流程）：', e.message);
      return { ok: false, reason: 'kernel_error', error: e.message };
    }
  }

  /** 分歧汇总 */
  function divergenceSummary() {
    if (!ready()) return {};
    try {
      return state.kernel.divergenceSummary();
    } catch (_e) {
      return {};
    }
  }

  /** kill-switch */
  function killSwitch() {
    if (!ready()) return notReady();
    try {
      return state.kernel.killSwitch();
    } catch (e) {
      log('killSwitch 失败：', e.message);
      return { ok: false, reason: 'kernel_error' };
    }
  }

  /** init 结果 / 元信息（对应宿主 evolution.init 返回值 + engine 扩展字段） */
  function meta() {
    return {
      ok: !state.degraded && state.inited,
      enabled: state.enabled,
      degraded: state.degraded,
      dataDir: state.dataDir,
      rootDir,
      configFile,
      agent: cfg.meta.agent,
      schema: SCHEMA_VERSION,
      engine: ENGINE_VERSION,
      level: getLevel(),
      tier: getTier(),
    };
  }

  // 装配（读 config 开关 + 建内核）
  assemble();

  return {
    // engine 元信息
    meta,
    isEnabled,
    status,
    // 事件采集 / 线程
    tapE,
    openThread,
    closeThread,
    // 快照 / 回滚 / 审计
    checkpoint,
    checkpointNovel,
    rollback,
    audit,
    getAuditTail,
    verifyAudit,
    preserveConfigKey,
    // 知识面 / probe
    knowledgeWrite,
    listKnowledge,
    readKnowledge,
    scoreProbe,
    probeStats,
    // interrupt / pre_action
    pendingInterrupts,
    resolveInterrupt,
    preActionGate,
    preAction,
    // 周期分析 / 评估
    runCycle,
    evaluate,
    startAutoAnalyze,
    stopAutoAnalyze,
    // 目标 / 偏好 / 分歧 / kill
    topCandidates,
    listObjectives,
    updateObjective,
    preferenceSuggestions,
    applySuggestion,
    divergenceSummary,
    killSwitch,
    // 供宿主扩展使用的底层访问（谨慎；宿主一般不需要）
    ready: () => ready(),
    notReady,
    getSeedCount,
    getTier,
    getLevel,
    state: () => state,
  };
}

// =====================================================================
// engine 公共 API
// =====================================================================

/**
 * 加载 evolution.yaml 并装配共享进化引擎。
 * @param {string|object} source - evolution.yaml 绝对路径 / 相对路径 / 配置对象
 * @param {object} [opts]
 * @param {string} [opts.rootDir] - 宿主根目录（覆盖 yaml 相对解析的 dataDir 锚点）
 * @param {string} [opts.configFile] - 宿主 config.json 绝对路径（enabled/level 运行开关）
 * @param {string} [opts.seedsFile] - 种子 JSONL 绝对路径（覆盖 yaml seeds.source）
 * @param {string} [opts.level] - 权限档位覆盖
 * @param {string} [opts.dataDir] - dataDir 覆盖（测试隔离用）
 * @param {string} [opts.kernelRoot] - 内核目录覆盖
 * @returns {object} handle
 * @throws {EngineError} EVOLUTION_YAML_NOT_FOUND / EVOLUTION_SCHEMA_INVALID / EVOLUTION_KERNEL_NOT_FOUND
 */
function load(source, opts = {}) {
  const raw = parseSource(source);
  const yamlDir = typeof source === 'string' ? path.dirname(path.resolve(source)) : process.cwd();
  const cfg = validateConfig(raw, yamlDir);
  return createEngineHandle(cfg, opts);
}

module.exports = {
  load,
  validateConfig,
  parseSource,
  SCHEMA_VERSION,
  ENGINE_VERSION,
  LEVELS,
  PRIMITIVES,
  EngineError,
};

/**
 * @module kernel
 * @layer L3 演化层（内核状态机 + 六原语）
 * @owner Kou（工程师，K1）
 *
 * 规范 §3.1 八步链路（主状态机）：
 *   事件(E/G/P/I) → 记录入账本(异步不卡流程)
 *     → [定时批分析] 归因 + fingerprint
 *     → 评估候选解法(本地 N 个) + 检索解法池(外部同错解法)
 *     → 取最优(expected_gain 实证) → 权限判断(§1.4)
 *     → [auto] 直接落地 / [ask] 原语③打断 / [suggest] 只出建议
 *     → 落地(快照+热写) → 周期再评估
 *         → probe 命中且解决=保留；误触发=降级/回滚；更优外部解法=提议升级
 *
 * 六原语（§3）：宿主按能力声明支持的原语集合，内核自动降档（§6 矩阵）：
 *   P4 = 六原语齐全；P3 = 缺②(前置同步 hook)；P2 = 再缺①tap(日志回流)与⑤checkpoint；
 *   P0 = 仅⑥审计（文件快照 + 只出报告），kill-switch 一键降到 P0。
 *
 * 安全约束（§4，全部写死在本层）：
 *   - 原语④只写白名单知识面；path.resolve 前缀校验防穿越；拒绝可执行文件
 *   - T4 铁律：经验内容不得修改权限配置（permission.cjs assertContentT4Safe）
 *   - 注入检测命中即拒；频率上限 ≤20 次/天；每次写入前快照
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { KernelError, genId, nowIso, readJsonl } = require('./util.cjs');
const { createLedgerStore, LEDGER_SIGNAL_TYPE } = require('./ledger.cjs');
const { classifySignal, aggregate } = require('./signals.cjs');
const { createObjectiveStack, MAX_WEIGHT } = require('./objective.cjs');
const { createCandidatePool, L2_UNITS } = require('./candidates.cjs');
const { createPermissionKnob, assertContentT4Safe, LEVELS } = require('./permission.cjs');
const { createProbeLedger, SCORES } = require('./probe.cjs');
const { createFeedbackEngine } = require('./feedback.cjs');
const { createAudit } = require('./audit.cjs');
const { createSnapshotManager } = require('./snapshot.cjs');
const { detectInjection, sanitizeForPrompt } = require('./injection-guard.cjs');

/** 六原语标识 */
const PRIMITIVES = Object.freeze([
  'tap',
  'pre_action',
  'interrupt',
  'write',
  'checkpoint',
  'audit',
]);

/** tap 接受的事件种类（规范 §3 原语①） */
const EVENT_KINDS = Object.freeze([
  'tool_call',
  'tool_result',
  'error',
  'llm_call',
  'task_start',
  'task_end',
]);

/** 拒绝写入的可执行文件扩展名（E4 走建议，不落知识面） */
const EXECUTABLE_EXTS = Object.freeze([
  '.exe', '.dll', '.bat', '.cmd', '.ps1', '.sh', '.msi',
  '.js', '.cjs', '.mjs', '.ts', '.py', '.jar',
]);

/** 自动回滚默认参数（规范 §4：24h 内误触发率 > 10%） */
const ROLLBACK_WINDOW_MS = 24 * 3600 * 1000;
const ROLLBACK_RATE_THRESHOLD = 0.1;

/**
 * 按宿主声明的能力集合推导档位（规范 §6 降档矩阵）
 * @param {string[]} primitives - 宿主支持的原语名列表
 * @returns {'P4'|'P3'|'P2'|'P0'}
 */
function resolveTier(primitives = []) {
  const has = (p) => primitives.includes(p);
  if (
    has('tap') && has('pre_action') && has('interrupt') &&
    has('write') && has('checkpoint') && has('audit')
  ) {
    return 'P4';
  }
  // P3：缺②，其余齐全（③为任务边界批量）
  if (has('tap') && has('interrupt') && has('write') && has('checkpoint') && has('audit')) {
    return 'P3';
  }
  // P2：①tap 缺（日志回流）、⑤checkpoint 缺（提示级）；③④⑥保留
  if (has('interrupt') && has('write') && has('audit')) {
    return 'P2';
  }
  // P0：只保审计（外挂代写文件 + 只出报告）
  return 'P0';
}

/**
 * 创建进化内核
 * @param {object} opts
 * @param {string} [opts.dataDir='runtime'] - 运行期数据目录（只写库自己的 runtime/）
 * @param {object} [opts.host] - 宿主声明
 * @param {string[]} [opts.host.primitives] - 支持的原语集合（缺省 = P4 全量）
 * @param {Function|null} [opts.host.interruptHandler] - async (question)=>decision；P4 任务中打断用
 * @param {string} [opts.host.agentId='default']
 * @param {object} [opts.knowledgeSurface] - 知识面声明
 * @param {string} opts.knowledgeSurface.root - 知识面根目录（绝对路径）
 * @param {string[]} opts.knowledgeSurface.whitelist - 白名单相对路径
 * @param {object[]} [opts.objectives] - 初始目标栈
 * @param {string} [opts.level='auto_report'] - 权限档位
 * @param {number} [opts.dailyLimit=20]
 * @param {object|null} [opts.resources] - 资源层客户端（本地文件适配器/HTTP stub）
 * @param {Function|null} [opts.candidateGenerator] - async (signal)=>candidate 输入数组（本地候选生成）
 */
function createKernel({
  dataDir = 'runtime',
  host = {},
  knowledgeSurface = null,
  objectives = [],
  level = 'auto_report',
  dailyLimit = 20,
  resources = null,
  candidateGenerator = null,
} = {}) {
  const primitives = host.primitives || PRIMITIVES.slice();
  const tier = resolveTier(primitives);
  const hasPrim = (p) => primitives.includes(p) && tier !== 'P0';
  const agentId = host.agentId || 'default';

  // ---- 子系统装配 ----
  const audit = createAudit({ dataDir });
  const ledger = createLedgerStore({ dataDir });
  const probe = createProbeLedger({ dataDir });
  const snapshot = createSnapshotManager({ dataDir });
  // 目标栈：来源保护（T4 同级）需要审计链记录违规尝试
  const objectiveStack = createObjectiveStack(objectives, { audit });
  // 否决反馈 + 目标对齐回路（建议产出 / 分歧计数 / 黑名单；候选池排序消费其降权与黑名单）
  const alignmentReviews = [];
  const feedback = createFeedbackEngine({
    dataDir,
    audit,
    // 类别 → 目标映射：偏好建议需要落到具体 objective（找不到则 objective_id=null）
    objectiveResolver: (category) =>
      objectiveStack.list().find((o) => o.types.includes(category)) || null,
    // 分歧 ≥3 → alignment_review 进批量挂起队列（宿主 /interrupts 可见）+ 专用账
    onAlignmentReview: (payload) => {
      alignmentReviews.push(payload);
      pendingInterrupts.push({
        kind: 'alignment_review',
        title: `目标对齐审查（类别 ${payload.category}）`,
        evidence_summary: {
          category: payload.category,
          divergence_count: payload.divergence_count,
          samples: payload.samples,
          message: payload.message,
        },
        options: ['review', 'dismiss'],
        ts: payload.ts,
      });
    },
  });
  const candidatePool = createCandidatePool({ feedback });
  const permission = createPermissionKnob({ level, dailyLimit, audit });

  // ---- 内核状态 ----
  let killed = false; // kill-switch：一键降级 P0，agent 回到纯知识面文件模式
  /** tap 事件队列（原语①只读排队，分析阶段批量消化，不阻塞主流程） */
  const eventQueue = [];
  /** suggest 模式产出 / 归档区 */
  const suggestions = [];
  const archived = [];
  /** ask 打断记录（宿主无 interruptHandler 时挂起，任务边界批量处理） */
  const pendingInterrupts = [];
  /** 经验缓存（原语②前置同步 hook 的本地查询源，≤50ms） */
  const experienceCache = new Map();
  /** 经验 ID → 落地信息（写入账本：快照/版本/目标面），供自动回滚用 */
  const writtenExperiences = new Map();

  audit.append('KERNEL_BOOT', { tier, primitives, agentId, level: permission.getLevel() });

  // ---- 知识面解析 ----
  const surfaceRoot = knowledgeSurface ? path.resolve(knowledgeSurface.root) : null;
  const whitelistAbs = knowledgeSurface
    ? knowledgeSurface.whitelist.map((w) => path.resolve(surfaceRoot, w))
    : [];
  /** 默认写入目标：白名单第一个 .jsonl 条目 */
  const defaultSurface = whitelistAbs.find((p) => p.endsWith('.jsonl')) || whitelistAbs[0] || null;

  /** assert(): 内核未被 kill-switch 关停 */
  function assertAlive() {
    if (killed) {
      throw new KernelError('KERNEL_KILLED', '内核已被 kill-switch 停用（P0），仅审计可用');
    }
  }

  // =====================================================================
  // 原语① tap（只读，不阻塞主流程）
  // =====================================================================
  /**
   * 事件 tap：所有事件流经内核，实时打标入账本。轻量同步入队（<5ms），
   * 重活留给 analyze() 批处理；error 事件立即物化进承诺账本（E 类信号源）。
   */
  function tap(event) {
    if (!hasPrim('tap')) {
      return { accepted: false, reason: 'tier_no_tap' }; // P2/P0：日志回流模式，宿主自行喂日志
    }
    assertAlive();
    if (!event || !EVENT_KINDS.includes(event.kind)) {
      throw new KernelError('EVENT_INVALID_KIND', `未知事件种类: ${event && event.kind}`, {
        kind: event && event.kind,
      });
    }
    const wrapped = {
      seq: eventQueue.length + 1,
      kind: event.kind,
      payload: event.payload || {},
      session_id: event.session_id || '',
      task_id: event.task_id || '',
      env: event.env || 'local',
      ts: event.ts || nowIso(),
    };
    eventQueue.push(wrapped);
    if (event.kind === 'error') {
      // E 类信号源：运行错误立即入账本（open→closed 一步完成）
      ledger.addError({
        title: String(event.payload.message || 'runtime error'),
        detail: String(event.payload.detail || ''),
        sessionId: wrapped.session_id,
        taskId: wrapped.task_id,
        payload: wrapped.payload,
      });
    }
    audit.append('EVENT_TAP', { kind: wrapped.kind, session_id: wrapped.session_id });
    return { accepted: true, reason: 'queued' };
  }

  // =====================================================================
  // 原语② 前置同步 hook（可干预，P4 核心）
  // =====================================================================
  /**
   * 出错当下同步查本地经验缓存：命中即注入兜底方案，不等下一轮 LLM 推理。
   * 预算：单次 ≤50ms（缓存查询，不打外挂）；超预算视为 null。
   */
  function preAction(event) {
    assertAlive();
    if (!hasPrim('pre_action')) return null; // P3 以下无同步兜底
    const start = Date.now();
    const text = JSON.stringify(event.payload || {});
    const fp = require('./signals.cjs').normalizeFingerprint(text);
    const hit = experienceCache.get(fp);
    if (!hit) return null;
    if (Date.now() - start > 50) return null; // 超时视为 null（规范预算约束）
    audit.append('PRE_ACTION_HIT', { fingerprint: fp, experience_id: hit.id });
    return { kind: 'inject_guidance', text: sanitizeForPrompt(hit.content) };
  }

  // =====================================================================
  // 原语③ 打断询问通道
  // =====================================================================
  /**
   * 任务中暂停 → 用户裁决 → 继续。仅用于：ask 权限项 / L2 变更 / I 型悬挂 / 冲突裁决。
   * P4：宿主 interruptHandler 即时裁决；P3/P2：任务边界批量（挂起）；P0：只出报告。
   * kill 后本函数【同步】抛 KERNEL_KILLED（普通函数而非 async）：
   * 宿主即使不 await 也不会产生 unhandledRejection。
   */
  function interrupt(question) {
    assertAlive();
    if (!hasPrim('interrupt')) {
      pendingInterrupts.push({ ...question, ts: nowIso() });
      return { decision: 'reported_only', reason: 'tier_no_interrupt' };
    }
    if (typeof host.interruptHandler === 'function') {
      // 宿主裁决是异步的：包成 Promise 返回，调用方 await 即可
      return Promise.resolve()
        .then(() => host.interruptHandler(question))
        .then((decision) => {
          audit.append('INTERRUPT_RESOLVED', { title: question.title, decision });
          // 否决反馈/目标对齐回路：裁决落反馈账（adopt→采纳史 / reject→否决账+分歧计数）
          applyInterruptDecision(question, decision);
          return { decision, reason: 'host_handler' };
        });
    }
    pendingInterrupts.push({ ...question, ts: nowIso() });
    audit.append('INTERRUPT_PENDING', { title: question.title });
    return { decision: 'pending', reason: 'batch_mode' };
  }

  // =====================================================================
  // 原语④ 知识热写（白名单 + 快照 + T4 + 注入检测 + 频率上限）
  // =====================================================================
  /**
   * @param {string} surfacePath - 白名单内知识面路径（绝对或相对知识面根）
   * @param {object} change - { content, unit='E1', mode='append', probe }
   * @param {object} [opts] { snapshot=true }
   * @returns {object} ApplyResult { ok, code, version, snapshotId, path }
   */
  function write(surfacePath, change, opts = { snapshot: true }) {
    assertAlive();
    if (!hasPrim('write')) {
      return { ok: false, code: 'PRIMITIVE_UNAVAILABLE', version: null, snapshotId: null, path: surfacePath };
    }
    const content = String((change && change.content) || '');
    const unit = String((change && change.unit) || 'E1').toUpperCase();

    // 1) 写入白名单校验：path.resolve 前缀匹配防穿越（规范 §4）
    const target = path.resolve(String(surfacePath || ''));
    const allowed = whitelistAbs.find(
      (w) => target === w || target.startsWith(w + path.sep)
    );
    if (!allowed) {
      return { ok: false, code: 'PATH_NOT_WHITELISTED', version: null, snapshotId: null, path: target };
    }

    // 2) 拒绝可执行文件（E4 走建议，不落知识面）
    if (EXECUTABLE_EXTS.includes(path.extname(target).toLowerCase())) {
      return { ok: false, code: 'EXECUTABLE_REJECTED', version: null, snapshotId: null, path: target };
    }

    // 3) T4 铁律：经验内容不得修改权限配置（写死校验，命中即拒 + 记审计）
    const t4 = assertContentT4Safe(content);
    if (!t4.ok) {
      audit.append('T4_CONTENT_BLOCKED', { rule: t4.rule, matched: t4.matched, path: target });
      return { ok: false, code: 'T4_VIOLATION', version: null, snapshotId: null, path: target };
    }

    // 4) 注入检测：命中即拒 + 记审计（外部贡献者扣分由宿主侧执行）
    const inj = detectInjection(content);
    if (!inj.safe) {
      audit.append('INJECTION_REJECTED', { hits: inj.hits, path: target });
      return { ok: false, code: 'INJECTION_REJECTED', version: null, snapshotId: null, path: target };
    }

    // 5) L1 注入必须带 probe 生效判据（规范 §1.3）
    if (!L2_UNITS.includes(unit) && !(change && change.probe)) {
      return { ok: false, code: 'PROBE_REQUIRED', version: null, snapshotId: null, path: target };
    }

    // 6) 权限裁决（resolve 内含 L2 强制 ask 与频率上限）
    const verdict = permission.resolve({ unit });
    if (verdict.action === 'off') {
      return { ok: false, code: 'EVOLUTION_OFF', version: null, snapshotId: null, path: target };
    }
    if (verdict.action === 'suggest' || verdict.action === 'ask' || verdict.action === 'queue') {
      return { ok: false, code: 'NEEDS_' + verdict.action.toUpperCase(), version: null, snapshotId: null, path: target };
    }

    // 7) 写入前强制快照（字节级）；opts.snapshot=false 可显式跳过（默认快照，契约取安全侧）
    const wantSnapshot = opts.snapshot !== false;
    const snap = wantSnapshot ? snapshot.snapshot([target]) : null;
    // 8) 应用变更：append 追加一行 / overwrite 整体重写；换行显式 \n
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if ((change && change.mode) === 'overwrite') {
      fs.writeFileSync(target, content.endsWith('\n') ? content : content + '\n', 'utf8');
    } else {
      fs.appendFileSync(target, content.endsWith('\n') ? content : content + '\n', 'utf8');
    }
    const version = snapshot.commitVersion(wantSnapshot ? snap.id : null); // v1.0.0 → v1.0.1
    permission.countLanding();

    const experienceId = (change && change.experience_id) || genId('EXP');
    writtenExperiences.set(experienceId, {
      path: target,
      snapshot_id: wantSnapshot ? snap.id : null,
      version,
      unit,
      ts: nowIso(),
    });
    audit.append('KNOWLEDGE_WRITE', {
      experience_id: experienceId,
      path: target,
      version,
      snapshot_id: wantSnapshot ? snap.id : null,
      unit,
      fingerprint: (change && change.fingerprint) || '',
    });
    return { ok: true, code: 'APPLIED', version, snapshotId: wantSnapshot ? snap.id : null, path: target, experience_id: experienceId };
  }

  // =====================================================================
  // 原语⑤ 计划 checkpoint（强制）
  // =====================================================================
  /**
   * 任务开始：强制读进化知识（写入≠遵循 → 机制而非自觉）
   * @returns {object[]} RequiredKnowledge[]
   */
  function onTaskStart(task) {
    assertAlive();
    if (!hasPrim('checkpoint')) {
      return []; // P2 提示级：由宿主自行决定是否读取
    }
    audit.append('TASK_START', { task_id: task && task.id, title: task && task.title });
    // 从知识面读出全部 active 经验作为必读知识（原型：全量读取）
    if (!defaultSurface || !fs.existsSync(defaultSurface)) return [];
    return readJsonl(defaultSurface)
      .filter((k) => (k.status ? k.status === 'active' : true))
      .map((k) => ({
        fingerprint: k.fingerprint || '',
        content: sanitizeForPrompt(k.content || k.title || ''),
        experience_id: k.experience_id || k.id || '',
      }));
  }

  /**
   * 任务结束：强制自检对账 + 上报 + probe 记分建议
   * @returns {object} SelfReport
   */
  function onTaskEnd(task, outcome = {}) {
    assertAlive();
    audit.append('TASK_END', { task_id: task && task.id, outcome });
    // 自检对账：任务中新错误立即入账本
    for (const err of outcome.errors || []) {
      ledger.addError({
        title: String(err.message || err.title || 'task error'),
        detail: String(err.detail || ''),
        sessionId: task && task.session_id,
        taskId: task && task.id,
        payload: err,
      });
    }
    return {
      task_id: (task && task.id) || '',
      outcome,
      open_commitments: ledger.listOpen(),
      probe_hint: '请宿主对本任务用到的经验调用 kernel.scoreProbe() 完成记分',
    };
  }

  // =====================================================================
  // 原语⑥ 审计与回滚
  // =====================================================================
  /** 审计（透传 hash chain append） */
  function auditRecord(type, payload = {}) {
    return audit.append(type, payload);
  }

  /** 字节级回滚到快照 */
  function rollback(snapshotId) {
    assertAlive();
    const result = snapshot.rollback(snapshotId);
    audit.append('ROLLBACK', { snapshot_id: snapshotId, restored: result.restored, removed: result.removed });
    return result;
  }

  // =====================================================================
  // 八步主状态机（定时批分析入口）
  // =====================================================================
  /**
   * 执行一轮完整链路。幂等：只消化队列内事件与未上报超期。
   * @returns {Promise<object>} 周期报告
   */
  async function analyze() {
    assertAlive();
    const startedAt = nowIso();

    // 步骤1+2：事件/超期 → 归类为 E/G/P/I 信号 → fingerprint 归一
    const signals = [];
    // 1a. 承诺账本超期检测（I 型悬挂信号 / G、P 落差）
    for (const { entry, signalType } of ledger.detectOverdue()) {
      signals.push(
        classifySignal({
          type: signalType,
          title: entry.title,
          detail: entry.detail || '',
          source: 'ledger:' + entry.ledger,
          sessionId: entry.session_id,
          taskId: entry.task_id,
        })
      );
    }
    // 1b. tap 队列里的 error 事件（已在 tap 时入账本）→ E 信号
    const drained = eventQueue.splice(0, eventQueue.length);
    for (const ev of drained) {
      if (ev.kind !== 'error') continue;
      signals.push(
        classifySignal({
          kind: 'runtime_error',
          title: String(ev.payload.message || 'runtime error'),
          detail: String(ev.payload.detail || ''),
          source: 'tap',
          sessionId: ev.session_id,
          taskId: ev.task_id,
          ts: ev.ts,
        })
      );
    }

    // 步骤2：fingerprint 聚合
    const groups = aggregate(signals);

    // 步骤3：方向闸
    const passed = [];
    for (const g of groups) {
      const gate = objectiveStack.gate({
        type: g.type,
        title: g.title,
        detail: signals.find((s) => s.fingerprint === g.fingerprint)?.detail || '',
        fingerprint: g.fingerprint,
      });
      if (gate.pass) {
        g.weight = gate.weight;
        passed.push(g);
      } else {
        archived.push({ ...g, archive_reason: gate.reason });
      }
    }

    // 步骤4+5：候选评估（本地生成 + 解法池检索）→ expected_gain 实证选优
    const decisions = [];
    for (const g of passed) {
      // 4a. 本地候选生成（宿主注入的生成器；缺省无本地候选，仅依赖解法池）
      //     category 记录信号类型（E/G/P/I），供否决反馈回路的分歧聚合与偏好学习归类
      let local = [];
      if (typeof candidateGenerator === 'function') {
        local = await candidateGenerator(g);
        for (const c of local) {
          candidatePool.add({ ...c, fingerprint: g.fingerprint, category: c.category || g.type });
        }
      }
      // 4b. 解法池检索（外部只投候选不决定方向）
      if (resources && typeof resources.querySolutions === 'function') {
        await candidatePool.retrieveExternal(resources, g.fingerprint);
      }
      // 5. 实证选优
      const pick = candidatePool.selectTop(g.fingerprint);

      // 步骤6：权限判断 → 三级落地
      if (!pick.evolve) {
        decisions.push({ fingerprint: g.fingerprint, action: 'manual', reason: pick.reason });
        audit.append('CYCLE_MANUAL_ESCALATION', { fingerprint: g.fingerprint, reason: pick.reason });
        continue;
      }
      const cand = pick.candidate;
      const verdict = permission.resolve({ unit: cand.unit, tier: cand.tier });
      if (verdict.action === 'land' || verdict.action === 'land_report') {
        // 步骤7：落地（快照 + 热写），目标面 = 候选指定或默认面
        const surfacePath = cand.target || defaultSurface;
        const result = write(surfacePath, {
          content: JSON.stringify({
            experience_id: '', // write() 会分配并回填到返回值
            fingerprint: g.fingerprint,
            title: cand.title,
            content: cand.content,
            unit: cand.unit,
            status: 'active',
            probe: cand.probe,
          }),
          unit: cand.unit,
          mode: 'append',
          probe: cand.probe,
          fingerprint: g.fingerprint,
        });
        if (result.ok) {
          // 回填 experience_id 到知识面行（重写该行，保证 probe 记分可关联）
          appendExperienceIdToSurface(result.path, result.experience_id);
        }
        decisions.push({
          fingerprint: g.fingerprint,
          action: verdict.action,
          result,
          candidate_id: cand.id,
          version: result.version,
        });
        audit.append('CYCLE_LANDED', {
          fingerprint: g.fingerprint,
          candidate_id: cand.id,
          version: result.version,
          ok: result.ok,
        });
      } else if (verdict.action === 'ask') {
        // 原语③打断询问，附对比证据（含 candidate_id/category/四因子分解：供否决账与宿主分解展示）
        const q = await interrupt({
          title: `是否落地候选「${cand.title}」`,
          evidence_summary: {
            fingerprint: g.fingerprint,
            candidate_id: cand.id,
            candidate_key: cand.key || '',
            category: cand.category || g.type,
            top1_gain: cand.expected_gain,
            top1_factors: cand.factors || null,
            runner_up: pick.runner_up ? pick.runner_up.expected_gain : null,
            tier: verdict.tier,
            reason: verdict.reason,
          },
          options: ['adopt', 'reject'],
        });
        decisions.push({ fingerprint: g.fingerprint, action: 'ask', decision: q });
      } else if (verdict.action === 'suggest') {
        suggestions.push({
          fingerprint: g.fingerprint,
          candidate_id: cand.id,
          title: cand.title,
          content: cand.content,
          expected_gain: cand.expected_gain,
          ts: nowIso(),
        });
        decisions.push({ fingerprint: g.fingerprint, action: 'suggest' });
      } else {
        decisions.push({ fingerprint: g.fingerprint, action: verdict.action, reason: verdict.reason });
      }
    }

    // 步骤8：周期再评估（默认 7 天）的入口在 evaluateProbes / checkAutoRollback，
    // analyze 本身只输出本轮报告。
    const report = {
      started_at: startedAt,
      ended_at: nowIso(),
      signal_count: signals.length,
      groups: groups.map((g) => ({ fingerprint: g.fingerprint, type: g.type, count: g.count })),
      archived_count: archived.length,
      decisions,
      suggestions_count: suggestions.length,
      version: snapshot.getVersion(),
    };
    audit.append('CYCLE_DONE', {
      signals: report.signal_count,
      groups: report.groups.length,
      landed: decisions.filter((d) => d.action === 'land' || d.action === 'land_report').length,
    });
    return report;
  }

  /** 把 write() 分配的 experience_id 回填进知识面刚追加的行（保持账本可关联） */
  function appendExperienceIdToSurface(surfaceAbs, experienceId) {
    if (!fs.existsSync(surfaceAbs)) return;
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
        break; // 只修正最后一行有效 JSON
      } catch (_e) {
        break;
      }
    }
    fs.writeFileSync(surfaceAbs, lines.join('\n'), 'utf8');
  }

  /**
   * 把用户裁决落进反馈回路（adopt→采纳史 / reject→否决账+分歧计数）。
   * 仅处理带 evidence_summary.fingerprint+candidate_id 的落地询问；其他问题类型跳过。
   */
  function applyInterruptDecision(question, decision) {
    const ev = (question && question.evidence_summary) || {};
    if (!ev.fingerprint || !ev.candidate_id) return;
    try {
      if (decision === 'adopt') {
        recordAdoption(ev.fingerprint, ev.candidate_id);
      } else if (decision === 'reject') {
        recordVeto(ev.fingerprint, ev.candidate_id, { reason: String(ev.reason || ''), source: 'user' });
      }
    } catch (_e) { /* 反馈账故障不影响裁决主流程（账本体已有独立审计） */ }
  }

  // =====================================================================
  // 否决反馈回路 + 目标对齐回路（公开 API）
  // =====================================================================
  /**
   * 记一条用户否决：写否决账（append-only + 审计），联动排序降权/黑名单/分歧计数。
   * @param {string} fingerprint
   * @param {string} candidateId
   * @param {object} [opts] { reason='', source='user' }
   */
  function recordVeto(fingerprint, candidateId, { reason = '', source = 'user' } = {}) {
    assertAlive();
    const cand = candidatePool.get(fingerprint, candidateId);
    return feedback.recordVeto({
      fingerprint,
      candidateId,
      candidateKey: (cand && cand.key) || '',
      reason,
      source,
      category: (cand && cand.category) || '',
      unit: (cand && cand.unit) || '',
      title: (cand && cand.title) || '',
      factors: cand ? cand.factors : null,
    });
  }

  /** 记一条用户采纳（偏好学习素材；落地由原语④另行负责） */
  function recordAdoption(fingerprint, candidateId) {
    assertAlive();
    const cand = candidatePool.get(fingerprint, candidateId);
    return feedback.recordAdoption({
      fingerprint,
      candidateId,
      category: (cand && cand.category) || '',
      unit: (cand && cand.unit) || '',
      title: (cand && cand.title) || '',
    });
  }

  /**
   * 复活黑名单候选（仅 user 来源；复活记审计，之后否决重新累计）
   */
  function reviveCandidate(fingerprint, candidateId, { source = 'user' } = {}) {
    assertAlive();
    const cand = candidatePool.get(fingerprint, candidateId);
    return feedback.revive(fingerprint, candidateId, {
      source,
      candidateKey: (cand && cand.key) || '',
    });
  }

  /** 候选分解展示数据：top-N（默认 3）+ 四因子分解 + 否决降权量 + 黑名单标记 */
  function topCandidates(fingerprint, n = 3) {
    return candidatePool.topCandidates(fingerprint, n);
  }

  /** 偏好学习建议列表（含"从什么行为推断"说明；不自动改目标） */
  function preferenceSuggestions() {
    return feedback.suggestions();
  }

  /**
   * 应用偏好建议（user 来源专用）：把建议的权重增减落到对应 objective（clamp 0~10）。
   * 非 user 来源 → OBJECTIVE_SOURCE_FORBIDDEN + 审计。
   */
  function applySuggestion(id, { source = 'user' } = {}) {
    assertAlive();
    if (source !== 'user') {
      audit.append('OBJECTIVE_SOURCE_FORBIDDEN', { op: 'apply_suggestion', source, suggestion_id: id });
      throw new KernelError(
        'OBJECTIVE_SOURCE_FORBIDDEN',
        `目标对齐铁律：建议只能由 user 应用，得到 ${source || '(未声明)'}`
      );
    }
    const sug = feedback.suggestions().find((s) => s.id === id && s.kind !== 'applied');
    if (!sug) {
      throw new KernelError('SUGGESTION_NOT_FOUND', `偏好建议不存在: ${id}`, { id });
    }
    if (!sug.objective_id) {
      throw new KernelError('SUGGESTION_NO_OBJECTIVE', '该建议无可关联 objective（类别无对应目标），无法应用');
    }
    const obj = objectiveStack.list().find((o) => o.id === sug.objective_id);
    if (!obj) {
      throw new KernelError('OBJECTIVE_NOT_FOUND', `建议指向的目标不存在: ${sug.objective_id}`);
    }
    const nextWeight = Math.max(0, Math.min(MAX_WEIGHT, obj.weight + sug.delta));
    objectiveStack.update(sug.objective_id, { weight: nextWeight }, { source });
    audit.append('SUGGESTION_APPLIED', {
      suggestion_id: sug.id,
      objective_id: sug.objective_id,
      delta: sug.delta,
      weight: nextWeight,
      source,
    });
    feedback.markSuggestionApplied(sug.id, nextWeight);
    return { suggestion_id: sug.id, objective_id: sug.objective_id, delta: sug.delta, weight: nextWeight };
  }

  /**
   * user 语义修改目标（宿主 PUT /api/evolution/objectives 的落点；来源标记 user）
   */
  function updateObjective(id, patch = {}) {
    assertAlive();
    const obj = objectiveStack.update(id, patch, { source: 'user' });
    audit.append('OBJECTIVE_UPDATED', { id, patch_keys: Object.keys(patch), weight: obj.weight, source: 'user' });
    return obj;
  }

  /** 分歧汇总：{ category: count }（"系统最优 ≠ 用户想要"按类别聚合） */
  function divergenceSummary() {
    return feedback.divergenceSummary();
  }

  /** 已产出的 alignment_review 事件（专用账，同时进了批量挂起队列） */
  function listAlignmentReviews() {
    return alignmentReviews.slice();
  }

  // =====================================================================
  // 步骤8：周期再评估 —— probe 记分 + 自动回滚
  // =====================================================================
  /** probe 记分（写入账本 + 生效账本分开记）；outcome 含 suboptimal（否决反馈回路：不回滚但降权记分） */
  function scoreProbe(experienceId, outcome, opts = {}) {
    assertAlive();
    const rec = probe.record(experienceId, outcome, opts);
    audit.append('PROBE_SCORED', {
      experience_id: experienceId,
      outcome,
      score: rec.score,
      effective: rec.effective,
    });
    return rec;
  }

  /**
   * 自动回滚检查（规范 §4）：24h 窗口内某经验误触发率 > 10% → 字节级回滚该经验对应的快照，
   * 并把知识面里该经验标记为 downgraded。
   * @returns {{rolledBack: {experience_id, snapshot_id, version}[]}}
   */
  function checkAutoRollback({ windowMs = ROLLBACK_WINDOW_MS, threshold = ROLLBACK_RATE_THRESHOLD, nowMs = Date.now() } = {}) {
    assertAlive();
    const rolledBack = [];
    for (const [experienceId, info] of writtenExperiences) {
      const writtenAt = new Date(info.ts).getTime();
      if (nowMs - writtenAt > windowMs) continue; // 只看 24h 窗口
      const rate = probe.falseTriggerRate(experienceId);
      if (rate > threshold) {
        const rb = rollback(info.snapshot_id);
        downgradeExperienceOnSurface(info.path, experienceId);
        audit.append('AUTO_ROLLBACK', {
          experience_id: experienceId,
          snapshot_id: info.snapshot_id,
          false_trigger_rate: rate,
          version: rb.version,
        });
        rolledBack.push({ experience_id: experienceId, snapshot_id: info.snapshot_id, version: rb.version });
      }
    }
    return { rolledBack };
  }

  /** 知识面上把该经验标记为 downgraded（回滚后行为不再生效）；无匹配行则不重写（保护字节级还原结果） */
  function downgradeExperienceOnSurface(surfaceAbs, experienceId) {
    if (!fs.existsSync(surfaceAbs)) return;
    const rows = readJsonl(surfaceAbs);
    let changed = false;
    for (const row of rows) {
      if (row.experience_id === experienceId) {
        row.status = 'downgraded';
        changed = true;
      }
    }
    if (!changed) return; // 回滚后经验行已不存在（字节级还原），保持文件原样
    const body = rows.map((r) => JSON.stringify(r)).join('\n');
    fs.writeFileSync(surfaceAbs, rows.length ? body + '\n' : '', 'utf8');
  }

  // =====================================================================
  // 经验缓存装载（原语②数据源）
  // =====================================================================
  /**
   * 装载经验到本地缓存（fingerprint → experience）。
   * 来源优先级：资源层客户端 > 知识面文件。
   */
  async function loadExperiences() {
    assertAlive();
    let items = [];
    if (resources && typeof resources.queryExperiences === 'function') {
      items = await resources.queryExperiences({});
    }
    if (!items.length && defaultSurface && fs.existsSync(defaultSurface)) {
      items = readJsonl(defaultSurface)
        .filter((r) => (r.status ? r.status === 'active' : true))
        .map((r) => ({ id: r.experience_id || r.id, fingerprint: r.fingerprint, content: r.content }));
    }
    for (const it of items) {
      if (it.fingerprint) experienceCache.set(it.fingerprint, it);
    }
    audit.append('EXPERIENCES_LOADED', { count: items.length });
    return items.length;
  }

  // =====================================================================
  // kill-switch（规范 §4：一键降级 P0，agent 本体不受影响）
  // =====================================================================
  function killSwitch() {
    audit.append('KILL_SWITCH', { from_tier: tier });
    killed = true;
    eventQueue.length = 0;
    return { ok: true, tier: 'P0' };
  }

  // ---- 对外 API ----
  return {
    // 元信息
    tier: () => (killed ? 'P0' : tier),
    primitives: () => primitives.slice(),
    isKilled: () => killed,
    version: () => snapshot.getVersion(),
    // 六原语
    tap,
    preAction,
    interrupt,
    write,
    onTaskStart,
    onTaskEnd,
    audit: auditRecord,
    rollback,
    // 状态机与演化
    analyze,
    scoreProbe,
    checkAutoRollback,
    loadExperiences,
    killSwitch,
    // 否决反馈回路 + 目标对齐回路
    recordVeto,
    recordAdoption,
    reviveCandidate,
    topCandidates,
    preferenceSuggestions,
    applySuggestion,
    updateObjective,
    divergenceSummary,
    alignmentReviews: listAlignmentReviews,
    // 透传子系统（宿主/测试可检查内部状态）
    subsystems: {
      ledger,
      probe,
      snapshot,
      audit,
      objectiveStack,
      candidatePool,
      permission,
      feedback,
      signals: { classifySignal, aggregate },
    },
    // 状态读取
    suggestions: () => suggestions.slice(),
    archived: () => archived.slice(),
    pendingInterrupts: () => pendingInterrupts.slice(),
    writtenExperiences: () => new Map(writtenExperiences),
    paths: { surfaceRoot, whitelistAbs, defaultSurface, dataDir },
  };
}

module.exports = {
  createKernel,
  resolveTier,
  PRIMITIVES,
  EVENT_KINDS,
  EXECUTABLE_EXTS,
  ROLLBACK_WINDOW_MS,
  ROLLBACK_RATE_THRESHOLD,
};

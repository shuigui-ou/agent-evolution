/**
 * @module behavior
 * @layer L1 数据层（行为贴合账本）
 * @owner 工程师（方向 A：行为贴合层）
 *
 * 行为贴合层（Behavior Fit Layer）：让用户体感"越用越懂我"。
 *
 * 与 knowledge（错误修复经验）的边界：
 *  - knowledge 解决"同类任务错误不复发"（fingerprint → fix，进知识面白名单）；
 *  - behavior 解决"输出风格贴合用户"（verbosity/detail/proactivity/pace），
 *    是用户对 agent 输出方式的显式纠偏沉淀，与具体任务错误无关。
 *
 * 安全设计（与内核其余部分同等级）：
 *  1. 维度受控枚举：dimension ∈ {verbosity, detail, proactivity, pace}，
 *     direction ∈ {more, less}——不接受自由文本维度（防注入/防自改）。
 *  2. 注入文本只由模板 + 受控措辞生成，绝不拼接用户原文（evidence 原文只存档与审计）。
 *  3. 不改宿主本体、不改权限/目标档位（与 T4 同级的精神：行为层只有"建议权"）。
 *  4. append-only 账本 + 审计挂钩；kill 后不可写。
 *  5. fail-open：账本故障只影响行为层自身，不拖垮宿主。
 *
 * 出口选择环（服役考核，方向 A 之后的第三只脚）：
 *  - 每个稳定偏好对 (dimension:direction) 是行为域的一条"条目"；
 *  - guidance() 被调用并把某偏好对写进指引 → 视为一次【注入签发】（开观察窗口）；
 *  - 签发后再次收到同维度同方向纠偏 → 上次没拦住 → 自动 refuted（衰减/停用，
 *    指引随后排除该对——防"反复唠叨同一个没用的偏好"）；
 *  - 签发后连续 survivalWindow 条异维纠偏都没有再犯该对 → 自动 confirmed（强化）；
 *  - 状态迁移只发生在偏好对上，不碰 observations 原文；revoke 可复活。
 *
 * 账本文件（append-only）：
 *  - <dataDir>/behavior/observations.jsonl  纠偏观察 {dimension, direction, text, source, ts}
 *  - <dataDir>/outcome/behavior.jsonl       偏好对考核（outcome.cjs 管理）
 *
 * 偏好推断（实时重算，不落盘）：
 *  对每个维度取最近 windowSize 条观察，多数方向置信度 ≥ confidence 且
 *  多数票数 ≥ minEvidence → 该维度产出稳定偏好（strength=置信度）。
 */
'use strict';

const path = require('node:path');
const { KernelError, readJsonl, appendJsonl, genId, nowIso } = require('./util.cjs');
const { createOutcomeLedger, OUTCOME_DEFAULTS } = require('./outcome.cjs');

/** 行为维度（受控枚举）：标签 + 双向措辞（模板生成用，禁止自由文本） */
const BEHAVIOR_DIMENSIONS = Object.freeze({
  verbosity: { label: '输出篇幅', more: '更详尽', less: '更简洁' },
  detail: { label: '论据与细节', more: '更多细节/依据', less: '更少细节/要点为主' },
  proactivity: { label: '主动性', more: '更主动多走一步', less: '更克制只答所问' },
  pace: { label: '节奏', more: '更分步、逐步确认', less: '更直接给结果' },
});

/** 方向（受控枚举） */
const BEHAVIOR_DIRECTIONS = Object.freeze(['more', 'less']);

/** 维度默认值：windowSize 取最近 N 条观察 */
const DEFAULT_WINDOW_SIZE = 20;
/** 形成稳定偏好的最少多数票数 */
const DEFAULT_MIN_EVIDENCE = 3;
/** 多数方向置信度阈值（0.5~1） */
const DEFAULT_CONFIDENCE = 0.6;

/**
 * 解析用户纠偏文本 → 结构化观察（启发式最佳猜测；精确上报请用 tapBehavior 直传）。
 * 命中多个维度时取命中条数最多的维度；同维度双向命中则抵消后看净方向。
 * @param {string} text - 用户对输出的纠偏原文
 * @returns {{dimension: string, direction: 'more'|'less', matched: string[]}|null}
 *   null = 未识别出行为纠偏（不是所有反馈都是行为反馈）
 */
function parseCorrection(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  const KEYWORDS = {
    verbosity: {
      less: ['太长了', '太长', '啰嗦', '废话', '太啰嗦', '简洁', '简练', '短一点', '少说', '精简', '别啰嗦', '太长不看', '概括', '简短'],
      more: ['详细点', '详细些', '更详细', '展开讲', '展开说', '多说', '具体点', '讲全', '充分展开', '多写', '详细'],
    },
    detail: {
      less: ['不用细节', '别展开细节', '少点细节', '要点即可', '只要要点', '别抠细节', '点到为止'],
      more: ['有依据吗', '证据', '数据支撑', '给数据', '举例', '论证', '核实', '查证', '来源', '出处', '细节'],
    },
    proactivity: {
      less: ['只回答', '别自作主张', '不要额外', '别主动', '我问什么答什么', '别乱做', '别加戏', '不用管'],
      more: ['主动点', '主动帮我', '一并', '顺手', '多帮我', '你决定', '替我想', '自己看着办'],
    },
    pace: {
      less: ['直接给', '别分步', '一次性', '直接说', '不要确认', '直接做', '别问', '一口气'],
      more: ['分步', '先确认', '逐步', '一步步', '每步确认', '先问', '先列计划', '走一步确认一步'],
    },
  };
  const hits = []; // {dimension, direction, kw}
  for (const [dim, dirs] of Object.entries(KEYWORDS)) {
    for (const [dir, kws] of Object.entries(dirs)) {
      for (const kw of kws) {
        if (t.includes(kw)) hits.push({ dimension: dim, direction: dir, kw });
      }
    }
  }
  if (!hits.length) return null;
  // 按维度净方向：同维度双向都命中时，票多者胜（平票取 first）
  const byDim = new Map();
  for (const h of hits) {
    if (!byDim.has(h.dimension)) byDim.set(h.dimension, { more: 0, less: 0, matched: [] });
    const acc = byDim.get(h.dimension);
    acc[h.direction] += 1;
    acc.matched.push(h.kw);
  }
  let best = null;
  for (const [dimension, acc] of byDim) {
    const net = acc.more - acc.less;
    if (net === 0) continue;
    const direction = net > 0 ? 'more' : 'less';
    const total = acc.more + acc.less;
    if (!best || total > best.total) {
      best = { dimension, direction, total, matched: acc.matched };
    }
  }
  return best ? { dimension: best.dimension, direction: best.direction, matched: best.matched } : null;
}

/**
 * 创建行为贴合账本
 * @param {object} opts
 * @param {string} [opts.dataDir='runtime'] - 运行期数据目录（账本在 <dataDir>/behavior/）
 * @param {object|null} [opts.audit=null] - 审计链（可选）
 * @param {number} [opts.windowSize=20] - 偏好推断滑动窗口
 * @param {number} [opts.minEvidence=3] - 形成稳定偏好的最少多数票数
 * @param {number} [opts.confidence=0.6] - 多数方向置信度阈值
 * @param {number} [opts.survivalWindow=3] - 签发后连续异维纠偏数 → 自动 confirmed
 * @param {object} [opts.outcome] - 考核阈值 { confirmToStrengthen, refuteToDecay, refuteToRetire }
 */
function createBehaviorLedger({
  dataDir = 'runtime',
  audit = null,
  windowSize = DEFAULT_WINDOW_SIZE,
  minEvidence = DEFAULT_MIN_EVIDENCE,
  confidence = DEFAULT_CONFIDENCE,
  survivalWindow = OUTCOME_DEFAULTS.survivalWindow,
  outcome = null,
} = {}) {
  const dir = path.join(dataDir, 'behavior');
  const obsFile = path.join(dir, 'observations.jsonl');
  const observations = readJsonl(obsFile);
  const win = Math.max(1, Math.floor(windowSize) || DEFAULT_WINDOW_SIZE);
  const minEv = Math.max(1, Math.floor(minEvidence) || DEFAULT_MIN_EVIDENCE);
  const conf = Math.min(1, Math.max(0.5, Number(confidence) || DEFAULT_CONFIDENCE));
  const survive = Math.max(1, Math.floor(survivalWindow) || OUTCOME_DEFAULTS.survivalWindow);

  /** 偏好对考核账本（出口选择环：签发后同维再犯=refuted / 异维生存=confirmed） */
  const pairOutcome = createOutcomeLedger({ dataDir, lane: 'behavior', audit, thresholds: outcome || OUTCOME_DEFAULTS });
  /** 已签发待判决的偏好对：key('dim:dir') → { survived }（内存态；重启后由下次 guidance 重开） */
  const pendingIssuances = new Map();

  /** 记审计（audit 缺失时静默跳过，不阻断行为层） */
  function auditAppend(type, payload) {
    if (audit) {
      try {
        audit.append(type, payload);
      } catch (_e) { /* 审计故障不影响行为层 */ }
    }
  }

  /**
   * 记录一次用户行为纠偏观察（append-only + 审计）。
   * @param {object} o
   * @param {string} o.dimension - 受控维度
   * @param {string} o.direction - 'more' | 'less'
   * @param {string} [o.text] - 纠偏原文（只存档/审计，绝不进注入文本）
   * @param {string} [o.source='user'] - 观察来源（默认用户显式纠偏）
   * @returns {object} 观察记录
   */
  function record(o = {}) {
    const dimension = String(o.dimension || '');
    const direction = String(o.direction || '');
    if (!BEHAVIOR_DIMENSIONS[dimension]) {
      throw new KernelError('BEHAVIOR_INVALID_DIMENSION', `行为维度非法：${dimension}`, {
        dimension,
        allowed: Object.keys(BEHAVIOR_DIMENSIONS),
      });
    }
    if (!BEHAVIOR_DIRECTIONS.includes(direction)) {
      throw new KernelError('BEHAVIOR_INVALID_DIRECTION', `行为方向非法：${direction}`, {
        direction,
        allowed: BEHAVIOR_DIRECTIONS,
      });
    }
    const rec = {
      id: genId('BEH'),
      dimension,
      direction,
      text: String(o.text || '').slice(0, 500), // 原文截断存档，仅审计用途
      source: String(o.source || 'user'),
      ts: nowIso(),
    };
    observations.push(rec);
    appendJsonl(obsFile, rec);
    auditAppend('BEHAVIOR_TAPPED', { dimension: rec.dimension, direction: rec.direction, source: rec.source });

    // 出口选择环自动关联：本次纠偏对着哪些"已签发待判决"的偏好对？
    //  同对再犯 → 上次注入没拦住 → auto refuted（衰减/停用，指引随后排除该对）
    //  异对纠偏 → 该对又"多存活"一条；连续 survive 条无同对再犯 → auto confirmed
    //  冷却期同对再犯 → 即使无新签发也继续累计证伪（2 次后已停注防唠叨，但 3 次
    //    证明该偏好对确实无效 → retired，防反复改回同一句没用的指引）
    const key = `${rec.dimension}:${rec.direction}`;
    let outcomeNote = null;
    const own = pairOutcome.stateOf(key);
    if (own.status === 'decayed') {
      pairOutcome.record(key, 'refuted', { source: 'auto', note: 'continued_failure_while_cooled' });
      outcomeNote = 'refuted';
      pendingIssuances.delete(key);
    } else if (pendingIssuances.size) {
      for (const [pk, p] of [...pendingIssuances]) {
        if (pk === key) {
          pairOutcome.record(pk, 'refuted', { source: 'auto', note: 'same_pair_recurrence_after_injection' });
          pendingIssuances.delete(pk);
          outcomeNote = 'refuted';
        } else {
          p.survived = (p.survived || 0) + 1;
          if (p.survived >= survive) {
            pairOutcome.record(pk, 'confirmed', { source: 'auto', note: 'survival_without_recurrence' });
            pendingIssuances.delete(pk);
          }
        }
      }
    }
    rec.outcome = outcomeNote; // null=未命中任何待判决签发（不产生考核）
    return rec;
  }

  /**
   * 实时推断稳定偏好（不落盘）。
   * @returns {object[]} [{dimension, direction, majority, minority, confidence, stable, label, wording}]
   *   stable=true 表示该维度已形成可注入的稳定偏好。
   */
  function profile() {
    const out = [];
    for (const [dimension, meta] of Object.entries(BEHAVIOR_DIMENSIONS)) {
      const rows = observations.filter((r) => r.dimension === dimension).slice(-win);
      const more = rows.filter((r) => r.direction === 'more').length;
      const less = rows.filter((r) => r.direction === 'less').length;
      const total = more + less;
      const majority = Math.max(more, less);
      const direction = majority === more ? 'more' : 'less';
      const confNow = total === 0 ? 0 : majority / total;
      const stable = total > 0 && majority >= minEv && confNow >= conf;
      out.push({
        dimension,
        label: meta.label,
        direction,
        majority,
        minority: total - majority,
        total,
        confidence: Number(confNow.toFixed(2)),
        stable,
        wording: stable ? meta[direction] : '',
      });
    }
    return out;
  }

  /**
   * 生成可注入的行为指引（模板生成，绝不拼接用户原文）。
   * 服役过滤：被考核为 decayed/retired 的偏好对不进入指引（防反复唠叨没用的偏好）；
   * 每次把某对写进指引 = 一次【注入签发】，为出口选择环开观察窗口。
   * @returns {{text: string, active: object[]}}
   *   text 供宿主拼入 system prompt / 任务上下文；无服役中稳定偏好时 text=''。
   */
  function guidance() {
    const candidates = profile().filter((p) => p.stable);
    const active = [];
    for (const p of candidates) {
      const key = `${p.dimension}:${p.direction}`;
      const st = pairOutcome.stateOf(key);
      if (!pairOutcome.injectable(key)) continue; // decayed/retired：停用，不进指引
      active.push({ ...p, key, status: st.status });
    }
    pendingIssuances.clear();
    if (!active.length) return { text: '', active: [] };
    for (const p of active) {
      pairOutcome.markIssued(p.key, { dimension: p.dimension, direction: p.direction });
      pendingIssuances.set(p.key, { survived: 0 });
    }
    const lines = active.map(
      (p) => `- ${p.label}：用户近期偏好「${p.wording}」（${p.majority}/${p.total} 次反馈）`
    );
    const text = '用户行为偏好（来自显式纠偏，任务有特定要求时以任务为准）：\n' + lines.join('\n');
    return { text, active };
  }

  /**
   * 清空某维度（或全部）的行为观察（仅 user 来源；清空记审计）。
   * 非 user 来源 → BEHAVIOR_FORBIDDEN。
   */
  function reset(dimension = '', { source = 'user' } = {}) {
    if (source !== 'user') {
      auditAppend('BEHAVIOR_RESET_FORBIDDEN', { dimension, source });
      throw new KernelError(
        'BEHAVIOR_FORBIDDEN',
        `行为账本重置仅限 user 来源，得到 ${source || '(未声明)'}`,
        { dimension, source }
      );
    }
    const target = dimension
      ? String(dimension)
      : '';
    if (target && !BEHAVIOR_DIMENSIONS[target]) {
      throw new KernelError('BEHAVIOR_INVALID_DIMENSION', `行为维度非法：${target}`, { dimension: target });
    }
    const before = observations.length;
    if (target) {
      // 只移除该维度记录
      for (let i = observations.length - 1; i >= 0; i--) {
        if (observations[i].dimension === target) observations.splice(i, 1);
      }
    } else {
      observations.length = 0;
    }
    const removed = before - observations.length;
    // 原子重写剩余记录（清空/裁剪后写回）
    const fs = require('node:fs');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(obsFile, observations.map((r) => JSON.stringify(r)).join('\n') + (observations.length ? '\n' : ''), 'utf8');
    // 出口选择环联动：被清空维度的考核状态一并 revoke（防 stale retired 阻断重建同向偏好）
    pendingIssuances.clear();
    const revoked = [];
    for (const st of pairOutcome.list()) {
      const [dim] = String(st.key).split(':');
      if (!target || dim === target) {
        try {
          pairOutcome.revoke(st.key, { source });
          revoked.push(st.key);
        } catch (_e) { /* 非 user 来源已在前面拒绝 */ }
      }
    }
    auditAppend('BEHAVIOR_RESET', { dimension: target || '*', removed, source, revoked });
    return { removed, dimension: target || '*', revoked };
  }

  /**
   * 偏好对考核视图（出口选择环只读）
   * @returns {object[]} [{key, confirmed, refuted, status}]
   */
  function pairStates() {
    return pairOutcome.list();
  }

  /**
   * 显式上报偏好对考核（可选增强；自动信号来自签发后同维再犯/异维生存）。
   * @param {string} key - 'dimension:direction'（如 'verbosity:less'）
   * @param {string} verdict - 'confirmed' | 'refuted'
   * @returns {object} {key, verdict, state}
   */
  function reportOutcome(key, verdict, opts = {}) {
    const k = String(key || '');
    const [dim, dir] = k.split(':');
    if (!BEHAVIOR_DIMENSIONS[dim] || !BEHAVIOR_DIRECTIONS.includes(dir)) {
      throw new KernelError('BEHAVIOR_INVALID_KEY', `偏好对键非法：${k}（应为 dimension:direction）`, { key: k });
    }
    return pairOutcome.record(k, verdict, { source: opts.source || 'host', note: opts.note || '' });
  }

  /**
   * 手动复活某偏好对（仅 user 来源；计数清零，审计留痕）
   */
  function revokePair(dimension, direction) {
    const key = `${String(dimension)}:${String(direction)}`;
    if (!BEHAVIOR_DIMENSIONS[String(dimension)] || !BEHAVIOR_DIRECTIONS.includes(String(direction))) {
      throw new KernelError('BEHAVIOR_INVALID_KEY', `偏好对键非法：${key}`, { key });
    }
    return pairOutcome.revoke(key, { source: 'user' });
  }

  return {
    record,
    profile,
    guidance,
    reset,
    // 出口选择环（服役考核）
    pairStates,
    reportOutcome,
    revokePair,
    // 只读用途
    list: () => observations.slice(),
    files: { obsFile, outcomeFile: pairOutcome.file },
    config: { windowSize: win, minEvidence: minEv, confidence: conf, survivalWindow: survive },
  };
}

module.exports = {
  createBehaviorLedger,
  parseCorrection,
  BEHAVIOR_DIMENSIONS,
  BEHAVIOR_DIRECTIONS,
  DEFAULT_WINDOW_SIZE,
  DEFAULT_MIN_EVIDENCE,
  DEFAULT_CONFIDENCE,
};

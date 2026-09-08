/**
 * @module objective
 * @layer L2 决策层（目标栈 + 方向闸）
 * @owner Kou（工程师，K1）
 *
 * 规范 §1.2：
 *  - 目标栈：系统显式持有目标（带权重、可度量）
 *  - 方向闸：无 objective 关联的信号 → 只归档不进化（pass=false）
 *  - 已达标（met）目标自动降权（权重 ×0.3），但仍允许关联进化（保持续航观察）
 *  - 外部只投候选不决定方向——方向裁决永远在本地（目标栈是本地唯一裁决依据）
 *
 * 目标对齐回路（T4 同级铁律，§4）：目标只能由 user 修改。
 *  - update/add/权重修改仅接受 opts.source='user'；其他来源
 *    （经验内容/候选/内核内部/外部）改目标 → 抛 OBJECTIVE_SOURCE_FORBIDDEN + 审计记录。
 *  - 初始注入（createObjectiveStack(initial)）视为 user 来源。
 *  - 原则：系统可提议（preference-update 产出建议），不能自改目标；修改权只在 user。
 */
'use strict';

const { KernelError, genId } = require('./util.cjs');

/** 目标权重上限 */
const MAX_WEIGHT = 10;
/** 已达标目标降权系数 */
const MET_DOWNWEIGHT = 0.3;

/**
 * 创建目标栈
 * @param {object[]} [initial] - 初始目标列表（视为 user 来源注入）
 * @param {object} [opts]
 * @param {object|null} [opts.audit] - 审计链（来源违规拒绝必须记审计）
 * @returns {object} objective API
 */
function createObjectiveStack(initial = [], { audit = null } = {}) {
  const items = [];

  /**
   * T4 同级来源校验：目标修改权只在 user。非 user 来源一律拒绝并记审计。
   * @param {string} op - 操作名（add/update），进审计 payload
   * @param {string} source - 调用方声明来源
   */
  function assertUserSource(op, source) {
    if (source !== 'user') {
      if (audit) audit.append('OBJECTIVE_SOURCE_FORBIDDEN', { op, source });
      throw new KernelError(
        'OBJECTIVE_SOURCE_FORBIDDEN',
        `目标对齐铁律：目标只能由 user 修改。来源 ${source || '(未声明)'} 试图 ${op} 目标，已拒绝并记审计`,
        { op, source }
      );
    }
  }

  /**
   * 添加目标（user 来源专用；初始注入内部以 user 身份调用）
   * @param {object} o
   * @param {string} o.title - 目标描述
   * @param {number} [o.weight=1] - 0~10
   * @param {string[]} [o.types=[]] - 关联的信号类型 E/G/P/I
   * @param {string[]} [o.fingerprints=[]] - 关联的具体指纹
   * @param {RegExp|string|null} [o.pattern=null] - 关联的正则（对 title+detail 匹配）
   * @param {string} [o.metric] - 度量名（如 RR30d）
   * @param {string} [o.threshold] - 度量阈值（如 "RR≤5%"）
   * @param {boolean} [o.met=false] - 是否已达标
   * @param {object} [opts] { source='(required)' } - 必须显式声明来源
   */
  function add(o = {}, opts = {}) {
    assertUserSource('add', opts.source);
    if (!o.title || typeof o.title !== 'string') {
      throw new KernelError('OBJECTIVE_INVALID', '目标必须有 title');
    }
    const weight = typeof o.weight === 'number' ? o.weight : 1;
    if (weight < 0 || weight > MAX_WEIGHT) {
      throw new KernelError('OBJECTIVE_INVALID', `目标权重须在 0~${MAX_WEIGHT}，得到 ${weight}`);
    }
    const obj = {
      id: o.id || genId('OBJ'),
      title: o.title,
      weight,
      types: Array.isArray(o.types) ? o.types.slice() : [],
      fingerprints: Array.isArray(o.fingerprints) ? o.fingerprints.slice() : [],
      pattern: o.pattern || null,
      metric: o.metric || '',
      threshold: o.threshold || '',
      met: Boolean(o.met),
      created_at: new Date().toISOString(),
    };
    items.push(obj);
    return obj;
  }

  /**
   * 更新目标（如标记达标、调权重）。user 来源专用；其他来源抛 OBJECTIVE_SOURCE_FORBIDDEN。
   * @param {string} id - 目标 ID
   * @param {object} patch - 允许字段：title/weight/types/fingerprints/pattern/metric/threshold/met
   * @param {object} [opts] { source='(required)' } - 必须显式声明来源
   */
  function update(id, patch = {}, opts = {}) {
    assertUserSource('update', opts.source);
    const obj = items.find((x) => x.id === id);
    if (!obj) {
      throw new KernelError('OBJECTIVE_NOT_FOUND', `目标不存在: ${id}`, { id });
    }
    // 先校验后写入：weight 非法时不得污染原值
    if ('weight' in patch && (typeof patch.weight !== 'number' || patch.weight < 0 || patch.weight > MAX_WEIGHT)) {
      throw new KernelError('OBJECTIVE_INVALID', `目标权重须在 0~${MAX_WEIGHT}，得到 ${patch.weight}`);
    }
    const allowed = ['title', 'weight', 'types', 'fingerprints', 'pattern', 'metric', 'threshold', 'met'];
    for (const key of allowed) {
      if (key in patch) obj[key] = patch[key];
    }
    return obj;
  }

  /** 全部目标 */
  function list() {
    return items.slice();
  }

  /**
   * 方向闸：判定一个信号是否有资格进入进化链路
   * @param {object} signal - 含 type/title/detail/fingerprint
   * @returns {{pass: boolean, reason: string, weight: number, objective: object|null}}
   *   - pass=false：无关联目标，只归档不进化
   *   - pass=true & weight=原值×1：正常关联
   *   - pass=true & weight=原值×0.3：目标已达标，自动降权
   */
  function gate(signal) {
    const text = `${signal.title || ''} ${signal.detail || ''}`;
    const obj = items.find((o) => {
      if (o.types.includes(signal.type)) return true;
      if (signal.fingerprint && o.fingerprints.includes(signal.fingerprint)) return true;
      if (o.pattern) {
        const re = o.pattern instanceof RegExp ? o.pattern : new RegExp(o.pattern, 'i');
        if (re.test(text)) return true;
      }
      return false;
    });
    if (!obj) {
      return { pass: false, reason: 'no_objective_archive_only', weight: 0, objective: null };
    }
    if (obj.met) {
      return {
        pass: true,
        reason: 'objective_met_downweighted',
        weight: Math.round(obj.weight * MET_DOWNWEIGHT * 100) / 100,
        objective: obj,
      };
    }
    return { pass: true, reason: 'objective_match', weight: obj.weight, objective: obj };
  }

  // 初始注入（opts.objectives / createObjectiveStack(initial)）视为 user 来源
  for (const o of initial) add(o, { source: 'user' });

  return { add, update, list, gate };
}

module.exports = { createObjectiveStack, MET_DOWNWEIGHT, MAX_WEIGHT };

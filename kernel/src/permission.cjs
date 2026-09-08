/**
 * @module permission
 * @layer L2 决策层（权限旋钮 + T4 铁律）
 * @owner Kou（工程师，K1）
 *
 * 规范 §1.4 权限旋钮（采纳自主度，两维组合的第二维 = 落地态 L0/L1/L2）：
 *  - auto         自动落地，仅审计
 *  - auto_report  自动落地 + 生成报告（推荐默认）
 *  - ask          原语③打断询问，附对比证据
 *  - suggest      只出建议不改
 *  - off          进化关停
 *
 * 两个固定例外（权限再高也压不住）：
 *  ① L2 行为变更永远升级 ask（E2/E4）
 *  ② auto 落地后 24h 自动回滚窗保留（由 kernel 的 checkAutoRollback 实现）
 *
 * T4 铁律（规范 §0/§4）：行为可进化，权限不可进化。
 *  - 经验内容的任何文本都不得修改权限配置 / 工具白名单 / 原语开关（写死校验）
 *  - setLevel 只接受 source='user'；经验/内核内部发起的提权一律拒绝并记审计
 */
'use strict';

const { KernelError, todayKey, nowIso } = require('./util.cjs');

/** 权限档位全集（从严到松无序，off 为关停） */
const LEVELS = Object.freeze(['auto', 'auto_report', 'ask', 'suggest', 'off']);

/** L2 行为变更单元（与 candidates.cjs 保持一致；本地定义避免跨层依赖） */
const L2_UNITS_LOCAL = Object.freeze(['E2', 'E4']);

/** T4 检测规则：命中任一即视为"经验试图修改权限配置" */
const T4_PATTERNS = Object.freeze([
  { rule: 'permission_modify', re: /修改.{0,8}(权限|permission)/i },
  { rule: 'permission_modify', re: /(permission)[_.]?(level|config|setting)/i },
  { rule: 'permission_escalate', re: /(提升|扩大|放开).{0,6}权限/i },
  { rule: 'whitelist_modify', re: /(加入|添加|修改|移出).{0,4}白名单/i },
  { rule: 'whitelist_modify', re: /whitelist[_.]?(add|push|append|remove)/i },
  { rule: 'primitive_toggle', re: /(启用|关闭|开启|停用|enable|disable).{0,6}(原语|primitive)/i },
  { rule: 'killswitch', re: /kill[._ ]?switch/i },
  { rule: 'tool_grant', re: /(grant|授权|授予).{0,8}(工具|tool|白名单)/i },
  // 中文语义顺序逃逸：权限/档位/level 词在前 + 变更动词在后 + 目标档位词
  // （目标档位词必须出现：防"权限校验改用缓存""把日志级别调到 warn"这类正常经验误伤）
  {
    rule: 'permission_order_cn',
    re: /(权限|档位|permission|level)[^\n。；！？]{0,10}(改为|改成|设置成|设置为|设为|调成|调整成|切成|切到|换成|置为|改|设|调|置|切|换)\s*(为|成|到|作)?\s*(auto_report|auto|ask|suggest|off)\b/i,
  },
  // 调用形态逃逸：setLevel(...) / permission.xxx / level = xxx / permission = xxx
  {
    rule: 'permission_call',
    re: /setLevel\s*\(|permission\s*\.\s*(level|config|setLevel)|\blevel\s*=[^=]|\bpermission\s*=/i,
  },
  // 英文祈使句：set the permission/level to <档位>
  {
    rule: 'permission_set_en',
    re: /set\s+(the\s+)?(permission|level)\s+(to|as)\s+(auto_report|auto|ask|suggest|off)\b/i,
  },
]);

/**
 * T4 内容校验：扫描经验正文是否试图修改权限配置/白名单/原语开关
 * @param {string} content - 经验正文
 * @returns {{ok: boolean, rule: string|null, matched: string|null}}
 */
function assertContentT4Safe(content) {
  const text = String(content || '');
  for (const p of T4_PATTERNS) {
    const m = text.match(p.re);
    if (m) {
      return { ok: false, rule: p.rule, matched: m[0] };
    }
  }
  return { ok: true, rule: null, matched: null };
}

/**
 * 创建权限旋钮
 * @param {object} opts
 * @param {string} [opts.level='auto_report'] - 初始档位（推荐默认）
 * @param {number} [opts.dailyLimit=20] - 落地动作 ≤ N 次/天（规范 §4 频率上限）
 * @param {object|null} [opts.audit] - 审计链（T4 拒绝必须记审计）
 */
function createPermissionKnob({ level = 'auto_report', dailyLimit = 20, audit = null } = {}) {
  if (!LEVELS.includes(level)) {
    throw new KernelError('PERMISSION_INVALID_LEVEL', `未知权限档位: ${level}`, { level });
  }
  let current = level;
  /** 按天计数落地次数：key = yyyy-mm-dd */
  const landingDays = new Map();

  /** 今日键 */
  function today() {
    return todayKey(new Date());
  }

  /**
   * 切换档位。T4 铁律：只有 user 来源能改权限；经验/内核内部提权一律拒绝并记审计。
   * @param {string} next
   * @param {object} [opts] { source='user' }
   */
  function setLevel(next, { source = 'user' } = {}) {
    if (source !== 'user') {
      if (audit) audit.append('T4_BLOCKED', { from: current, to: next, source });
      throw new KernelError(
        'T4_VIOLATION',
        `T4 铁律：权限不可进化。来源 ${source} 试图把权限 ${current} → ${next}，已拒绝并记审计`
      );
    }
    if (!LEVELS.includes(next)) {
      throw new KernelError('PERMISSION_INVALID_LEVEL', `未知权限档位: ${next}`, { next });
    }
    const from = current;
    current = next;
    if (audit) audit.append('PERMISSION_CHANGED', { from, to: next });
    return current;
  }

  /** 当前档位 */
  function getLevel() {
    return current;
  }

  /** 频率上限检查：今日落地次数是否还有额度（规范 §4：超限转人审队列） */
  function hasQuota() {
    return (landingDays.get(today()) || 0) < dailyLimit;
  }

  /** 记一次落地动作（内核在成功写入后调用） */
  function countLanding(n = 1) {
    const key = today();
    landingDays.set(key, (landingDays.get(key) || 0) + n);
  }

  /**
   * 权限裁决：给定候选的落地态（tier），决定内核动作
   * @param {object} input
   * @param {string} [input.unit] - 可进化单元 E1~E7（可从单元推导 tier）
   * @param {string} [input.tier] - 直接指定 L1|L2（优先于 unit 推导）
   * @returns {{action: 'land'|'land_report'|'ask'|'suggest'|'off'|'queue',
   *            level: string, tier: string, reason: string}}
   */
  function resolve({ unit = 'E1', tier = null } = {}) {
    const effTier = tier || (L2_UNITS_LOCAL.includes(String(unit).toUpperCase()) ? 'L2' : 'L1');
    const base = { level: current, tier: effTier };
    if (current === 'off') {
      return { action: 'off', ...base, reason: 'evolution_off' };
    }
    // 固定例外①：L2 行为变更永远升级 ask，权限再高也压不住
    if (effTier === 'L2') {
      return { action: 'ask', ...base, reason: 'L2_forced_ask' };
    }
    if (current === 'ask') return { action: 'ask', ...base, reason: 'level_ask' };
    if (current === 'suggest') return { action: 'suggest', ...base, reason: 'level_suggest' };
    // auto / auto_report：检查频率上限
    if (!hasQuota()) {
      return { action: 'queue', ...base, reason: 'daily_limit_exceeded' };
    }
    return {
      action: current === 'auto' ? 'land' : 'land_report',
      ...base,
      reason: current === 'auto' ? 'auto_land' : 'auto_land_with_report',
    };
  }

  return { setLevel, getLevel, resolve, hasQuota, countLanding };
}

module.exports = { createPermissionKnob, assertContentT4Safe, T4_PATTERNS, LEVELS };

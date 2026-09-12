/**
 * @module signals
 * @layer L1 数据层（落差信号）
 * @owner Kou（工程师，K1）
 *
 * 四类落差信号归类 E/G/P/I（规范 §2）：
 *  - E 错误：异常/超时/exit≠0（机器可检，人审低）
 *  - G 期望落差：用户要点未满足（显式纠错/对账）
 *  - P 计划偏离：声明步骤 vs 实际轨迹
 *  - I 悬挂未完结：open 承诺超期（默认人审，必须 ask）
 *
 * fingerprint 归一化：去数字 / 去 UUID / 去路径 → sha256 前 16 位，
 * 使"同类问题"（错误文案含不同 ID/路径/毫秒数）聚合到同一指纹上。
 */
'use strict';

const crypto = require('node:crypto');
const { KernelError, shortHash, genId, nowIso } = require('./util.cjs');

/** 四类信号类型 */
const SIGNAL_TYPES = Object.freeze(['E', 'G', 'P', 'I']);

/**
 * 归一化 fingerprint：把易变细节抹掉，只留"错误骨架"
 * 步骤：剥调用栈帧 → 去 UUID → 去文件/URL 路径 → 去数字 → 折叠空白 → 小写 → sha256 前 16 位
 *
 * 跨宿主一致性（关键）：`detail` 通常是 Error.stack，含函数名/文件结构/帧数——
 * 这些**随宿主不同而不同**；若不剥离，同一错误在两个宿主上会得到不同指纹，
 * 共享知识库就永远命中不了。故先整体剥离栈帧，只保留宿主无关的"错误骨架"。
 * @param {string} text - 原始错误/落差描述
 * @returns {string} 16 位 hex 指纹
 */
function normalizeFingerprint(text) {
  let s = String(text);
  // 1) 调用栈帧（Node/V8："    at fn (path:1:2)" / "    at async foo"）
  s = s.replace(/(?:^|[\r\n])[ \t]*at\s+[^\r\n]*/g, ' ');
  // 2) Playwright "Call log:" 下的 "  - navigating to ..." 之类，同样对齐为宿主噪声
  s = s.replace(/(?:^|[\r\n])[ \t]*-\s+[^\r\n]*/g, ' ');
  // 3) 残留的 file:line:col
  s = s.replace(/\S+:\d+:\d+/g, ' <loc> ');
  s = s.replace(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g, ' <uuid> ');
  // Windows 盘符路径 与 POSIX 绝对路径
  s = s.replace(/[A-Za-z]:\\[^\s"'<>|*?]+/g, ' <path> ');
  s = s.replace(/(?:\/[\w.\-]+){2,}/g, ' <path> ');
  s = s.replace(/https?:\/\/\S+/g, ' <url> ');
  s = s.replace(/\d+/g, '#'); // 去数字：30000ms / 端口 / 行号 → #
  s = s.toLowerCase().replace(/[\s]+/g, ' ').trim();
  return shortHash(s, 16);
}

/**
 * 信号归类：接受上游检测结果（错误事件 / 显式纠错 / 计划比对 / 超期检测）并归到 E/G/P/I
 * @param {object} raw
 * @param {string} raw.kind - runtime_error|expectation_gap|plan_deviation|hanging（或直接给 type）
 * @param {string} raw.title
 * @param {string} [raw.detail]
 * @param {string} [raw.source]
 * @returns {object} 信号（含 fingerprint）
 */
function classifySignal(raw) {
  const KIND_TO_TYPE = {
    runtime_error: 'E',
    error: 'E',
    expectation_gap: 'G',
    user_correction: 'G',
    plan_deviation: 'P',
    hanging: 'I',
    overdue: 'I',
  };
  const type = raw.type || KIND_TO_TYPE[raw.kind];
  if (!type || !SIGNAL_TYPES.includes(type)) {
    throw new KernelError('SIGNAL_INVALID_TYPE', `未知信号类型: kind=${raw.kind} type=${raw.type}`, {
      kind: raw.kind,
      type: raw.type,
    });
  }
  const title = String(raw.title || '');
  const detail = String(raw.detail || '');
  return {
    id: genId('SIG'),
    type,
    title,
    detail,
    source: raw.source || raw.kind || 'unknown',
    fingerprint: normalizeFingerprint(title + ' ' + detail),
    session_id: raw.sessionId || '',
    task_id: raw.taskId || '',
    ts: raw.ts || nowIso(),
  };
}

/**
 * 按 fingerprint 聚合信号（八步链路第 2 步的产出）：同指纹 = 同类问题，进同一条候选链路
 * @param {object[]} signals
 * @returns {object[]} 聚合组 [{fingerprint, type, count, title, first_ts, last_ts, signal_ids}]
 */
function aggregate(signals) {
  const map = new Map();
  for (const sig of signals) {
    if (!map.has(sig.fingerprint)) {
      map.set(sig.fingerprint, {
        fingerprint: sig.fingerprint,
        type: sig.type,
        count: 0,
        title: sig.title,
        first_ts: sig.ts,
        last_ts: sig.ts,
        signal_ids: [],
      });
    }
    const g = map.get(sig.fingerprint);
    g.count += 1;
    g.signal_ids.push(sig.id);
    if (sig.ts < g.first_ts) g.first_ts = sig.ts;
    if (sig.ts > g.last_ts) g.last_ts = sig.ts;
  }
  // 按 count 降序：最响的同类问题优先进入候选评估
  return Array.from(map.values()).sort((a, b) => b.count - a.count);
}

/** 摘要指纹（用于日志展示，不参与聚合） */
function fingerprintPreview(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex').slice(0, 8);
}

module.exports = { SIGNAL_TYPES, normalizeFingerprint, classifySignal, aggregate, fingerprintPreview };

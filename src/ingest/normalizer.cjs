/**
 * @module ingest/normalizer
 * @layer ingest
 * @owner kou
 * 异构记录 -> TraceEvent。支持三类来源：
 *   ① 已是 aed/trace-event/1.0 的 JSON；
 *   ② agent report 风格 JSON（step/status/error/message）；
 *   ③ 文本日志行（[ts] [LEVEL] [tool] message 或 LEVEL: message）。
 */

'use strict';

const id = require('../util/id.cjs');
const time = require('../util/time.cjs');

const KIND_ENUM = ['task_start', 'tool_call', 'tool_result', 'llm_call', 'llm_result', 'assert', 'error', 'warn', 'metric', 'human_feedback', 'task_end'];
const OUTCOME_ENUM = ['success', 'fail', 'timeout', 'aborted', 'unknown'];

/** LEVEL -> kind / outcome */
const LEVEL_MAP = {
  error: { kind: 'error', outcome: 'fail' },
  err: { kind: 'error', outcome: 'fail' },
  fail: { kind: 'error', outcome: 'fail' },
  failed: { kind: 'error', outcome: 'fail' },
  warn: { kind: 'warn', outcome: 'success' },
  warning: { kind: 'warn', outcome: 'success' },
  info: { kind: 'metric', outcome: 'success' },
  debug: { kind: 'metric', outcome: 'unknown' },
  trace: { kind: 'metric', outcome: 'unknown' }
};

/**
 * 兜底环境信息。
 * @returns {Object}
 */
function defaultEnv() {
  return {
    os: process.platform,
    node: process.version,
    arch: process.arch,
    cwd: process.cwd(),
    locale: 'zh-CN'
  };
}

/**
 * 规范化 outcome 字符串。
 * @param {*} v
 * @param {string} fallback
 * @returns {string}
 */
function normOutcome(v, fallback = 'unknown') {
  const s = String(v == null ? '' : v).toLowerCase();
  if (['success', 'ok', 'passed', 'pass', 'succeeded', 'done'].includes(s)) return 'success';
  if (['fail', 'failed', 'failure', 'error'].includes(s)) return 'fail';
  if (['timeout', 'timedout', 'timed_out'].includes(s)) return 'timeout';
  if (['aborted', 'cancelled', 'canceled', 'skipped'].includes(s)) return 'aborted';
  return OUTCOME_ENUM.includes(s) ? s : fallback;
}

/**
 * 规范化 kind 字符串。
 * @param {*} v
 * @param {string} fallback
 * @returns {string}
 */
function normKind(v, fallback = 'metric') {
  const s = String(v == null ? '' : v).toLowerCase();
  if (KIND_ENUM.includes(s)) return s;
  if (s === 'tool_use' || s === 'tool') return 'tool_call';
  if (s === 'assertion') return 'assert';
  if (s === 'warning') return 'warn';
  return fallback;
}

/**
 * 解析文本日志行。
 * @param {string} text
 * @returns {{ts: string|null, level: string|null, tool: string|null, message: string}}
 */
function parseLogLine(text) {
  const s = String(text || '');
  let rest = s;
  let ts = null;
  let level = null;
  let tool = null;

  // 去掉前导时间戳（方括号内或裸 ISO）
  const tsMatch = /^\s*\[?(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)\]?\s*/.exec(rest);
  if (tsMatch) {
    ts = new Date(tsMatch[1].replace(' ', 'T')).toISOString();
    rest = rest.slice(tsMatch[0].length);
  }
  // 反复剥离 [XXX] 形式的标签：第一个作为 level，其余作为 tool
  let tag;
  const tags = [];
  const tagRe = /^\s*\[([^\]]{1,32})\]\s*/;
  while ((tag = tagRe.exec(rest)) !== null) {
    tags.push(tag[1].trim());
    rest = rest.slice(tag[0].length);
  }
  if (tags.length > 0) {
    level = tags[0];
    if (tags.length > 1) tool = tags[1];
  } else {
    const lv = /^\s*(ERROR|ERR|WARN|WARNING|INFO|DEBUG|TRACE|FATAL)\s*[:\-]?\s*/i.exec(rest);
    if (lv) {
      level = lv[1];
      rest = rest.slice(lv[0].length);
    }
  }
  return { ts, level, tool, message: rest.trim() };
}

/**
 * 从 report JSON 中提取错误对象。
 * @param {Object} obj
 * @returns {{type: string, message: string, stack?: string}|null}
 */
function extractError(obj) {
  if (!obj) return null;
  if (obj.error && typeof obj.error === 'object') {
    return {
      type: String(obj.error.type || obj.error.name || obj.error.code || 'Error'),
      message: String(obj.error.message || obj.error.msg || obj.error.detail || ''),
      stack: obj.error.stack ? String(obj.error.stack) : undefined
    };
  }
  if (typeof obj.error === 'string') {
    return { type: obj.error_type || 'Error', message: obj.error };
  }
  return null;
}

/**
 * 归一化一条原始记录为 TraceEvent。
 * @param {{text: string, path?: string, line?: number, ts?: string}} raw
 * @param {{agent: string, agent_version?: string, adapter?: string, env?: Object, sourcePath?: string, seqBase?: number}} ctx
 * @returns {Object|null} TraceEvent；无法解析时返回 null
 */
function normalize(raw, ctx = {}) {
  const text = raw && raw.text != null ? String(raw.text) : '';
  if (text.trim().length === 0) return null;
  const nowTs = Date.now();
  const source = {
    adapter: ctx.adapter || 'file-tail',
    path: raw.path || ctx.sourcePath || '',
    line: Number.isFinite(raw.line) ? raw.line : 0
  };
  const base = {
    schema: 'aed/trace-event/1.0',
    agent: ctx.agent || 'unknown',
    agent_version: ctx.agent_version || '0.0.0',
    env: Object.assign(defaultEnv(), ctx.env || {}),
    redacted: false,
    source
  };

  const trimmed = text.trim();

  // ① JSON 行
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    let obj = null;
    try { obj = JSON.parse(trimmed); } catch (_e) { obj = null; }
    if (obj && !Array.isArray(obj) && typeof obj === 'object') {
      if (obj.schema === 'aed/trace-event/1.0') {
        const ev = Object.assign({}, base, obj);
        ev.env = Object.assign(defaultEnv(), ctx.env || {}, obj.env || {});
        ev.source = Object.assign({}, source, obj.source || {});
        if (!ev.id) ev.id = id.traceId();
        if (!ev.ts) ev.ts = time.nowIso();
        if (!Number.isFinite(ev.seq)) ev.seq = Number(raw.line) || 0;
        if (!ev.session_id) ev.session_id = 'unknown-session';
        if (!ev.payload || typeof ev.payload !== 'object') ev.payload = {};
        if (!KIND_ENUM.includes(ev.kind)) ev.kind = 'metric';
        if (!OUTCOME_ENUM.includes(ev.outcome)) ev.outcome = 'unknown';
        return ev;
      }
      // report 风格
      const level = String(obj.level || obj.status || obj.outcome || '').toLowerCase();
      const mapped = LEVEL_MAP[level] || {};
      const err = extractError(obj);
      const ts = obj.ts || obj.timestamp || obj.time || (raw.ts || null);
      const ev = Object.assign({}, base, {
        id: obj.id || id.traceId(),
        ts: ts ? new Date(ts).toISOString() : time.nowIso(nowTs),
        session_id: String(obj.session_id || obj.sessionId || obj.run_id || 'unknown-session'),
        task_id: obj.task_id || obj.taskId || obj.step_id || null,
        seq: Number.isFinite(obj.seq) ? obj.seq : (Number.isFinite(obj.index) ? obj.index : (Number(raw.line) || 0)),
        kind: normKind(obj.kind || (err ? 'error' : mapped.kind), 'metric'),
        payload: Object.assign({}, obj.payload || {}, {
          step: obj.step || obj.name || obj.action || null,
          tool: obj.tool || obj.tool_name || null,
          message: obj.message || obj.msg || (err ? err.message : obj.step || ''),
          detail: obj.detail || null
        }),
        outcome: normOutcome(obj.outcome || obj.status, err ? 'fail' : (mapped.outcome || 'success')),
        error: err || null,
        cost_ms: Number(obj.cost_ms || obj.duration_ms || obj.durationMs || 0) || 0
      });
      if (ev.payload.tool === null) delete ev.payload.tool;
      return ev;
    }
  }

  // ② 文本日志行
  const p = parseLogLine(text);
  const levelKey = String(p.level || '').toLowerCase();
  const mapped = LEVEL_MAP[levelKey] || {};
  const isErr = ['error', 'err', 'fail', 'failed', 'fatal'].includes(levelKey);
  const ev = Object.assign({}, base, {
    id: id.traceId(nowTs),
    ts: p.ts || raw.ts || time.nowIso(nowTs),
    session_id: 'unknown-session',
    task_id: null,
    seq: Number(raw.line) || 0,
    kind: mapped.kind || 'metric',
    payload: {
      tool: p.tool || null,
      message: p.message,
      level: (p.level || 'INFO').toUpperCase()
    },
    outcome: mapped.outcome || 'unknown',
    error: isErr ? { type: obj0(p), message: p.message } : null,
    cost_ms: 0
  });
  if (ev.payload.tool === null) delete ev.payload.tool;
  return ev;
}

/**
 * 文本行错误类型兜底。
 * @param {{level: string|null}} p
 * @returns {string}
 */
function obj0(p) {
  const lv = String(p.level || 'ERROR').toUpperCase();
  return lv === 'FATAL' ? 'FatalError' : 'Error';
}

/**
 * 批量归一化。
 * @param {Array<{text: string, path?: string, line?: number}>} raws
 * @param {Object} ctx
 * @returns {Object[]} TraceEvent 数组（自动去掉 null）
 */
function normalizeAll(raws, ctx) {
  const out = [];
  for (const r of raws || []) {
    const ev = normalize(r, ctx);
    if (ev) out.push(ev);
  }
  return out;
}

module.exports = { normalize, normalizeAll, parseLogLine, normOutcome, normKind, defaultEnv, KIND_ENUM, OUTCOME_ENUM };

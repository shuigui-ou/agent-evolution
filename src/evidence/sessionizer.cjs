/**
 * @module evidence/sessionizer
 * @layer evidence
 * @owner kou
 * trace -> session/task 分段；失败点上下文窗口；TraceEvent -> 匹配输入。
 */

'use strict';

/**
 * 把事件按 session_id 分段（保持时间序）。
 * @param {Object[]} events
 * @returns {Array<{session_id: string, events: Object[], task_ids: string[], outcomes: Object, started_at: string, ended_at: string}>}
 */
function sessionize(events) {
  const map = new Map();
  for (const ev of events || []) {
    const key = String(ev.session_id || 'unknown-session');
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(ev);
  }
  const sessions = [];
  for (const [session_id, list] of map.entries()) {
    list.sort((a, b) => {
      const ta = Date.parse(a.ts || 0) || 0;
      const tb = Date.parse(b.ts || 0) || 0;
      if (ta !== tb) return ta - tb;
      return (a.seq || 0) - (b.seq || 0);
    });
    const taskIds = Array.from(new Set(list.map((e) => e.task_id).filter(Boolean)));
    const outcomes = { success: 0, fail: 0, timeout: 0, aborted: 0, unknown: 0 };
    for (const e of list) {
      const o = outcomes[e.outcome] == null ? 'unknown' : e.outcome;
      outcomes[o] += 1;
    }
    sessions.push({
      session_id,
      events: list,
      task_ids: taskIds,
      outcomes,
      started_at: list[0].ts,
      ended_at: list[list.length - 1].ts
    });
  }
  sessions.sort((a, b) => String(a.started_at).localeCompare(String(b.started_at)));
  return sessions;
}

/**
 * 找出所有失败点及其上下文窗口。
 * @param {Object[]} events 已排序
 * @param {{before?: number, after?: number}} [opts]
 * @returns {Array<{index: number, event: Object, window: Object[], session_id: string}>}
 */
function failureWindows(events, opts = {}) {
  const before = opts.before == null ? 5 : opts.before;
  const after = opts.after == null ? 5 : opts.after;
  const out = [];
  const list = events || [];
  for (let i = 0; i < list.length; i += 1) {
    const ev = list[i];
    if (ev.outcome !== 'fail' && ev.outcome !== 'timeout') continue;
    if (!ev.error && ev.kind !== 'error' && ev.kind !== 'assert') continue;
    out.push({
      index: i,
      event: ev,
      session_id: ev.session_id,
      window: list.slice(Math.max(0, i - before), Math.min(list.length, i + after + 1))
    });
  }
  return out;
}

/**
 * TraceEvent -> 统一的匹配输入（供 matchConditions 使用）。
 * @param {Object} ev
 * @returns {{error_type: string, message: string, tool: string, os: string, version: string, file: string, text: string}}
 */
function toMatchInput(ev) {
  const payload = (ev && ev.payload) || {};
  const err = ev && ev.error ? ev.error : null;
  return {
    error_type: err ? String(err.type || '') : '',
    message: String(err ? err.message || '' : payload.message || ''),
    tool: String(payload.tool || payload.name || ''),
    os: String((ev.env && ev.env.os) || ''),
    version: String((ev.env && ev.env.node) || ev.agent_version || ''),
    file: String(payload.file || payload.path || ''),
    text: String(payload.message || payload.step || '')
  };
}

module.exports = { sessionize, failureWindows, toMatchInput };

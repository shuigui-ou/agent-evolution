/**
 * @module evidence/failure-attribution
 * @layer evidence
 * @owner kou
 * 五类失败归因（tool / planning / reasoning / knowledge / environment）+ 置信度。
 * 规则优先，LLM 可选增强（P2）。
 */

'use strict';

const { toMatchInput } = require('./sessionizer.cjs');

/** 命中即记一条判据 */
const RULES = [
  // ---- tool ----
  { id: 'TOOL_SOURCE', category: 'tool', weight: 0.5, test: (c) => c.error && c.error.source === 'tool' },
  {
    id: 'TOOL_ERRNO',
    category: 'tool',
    weight: 0.6,
    test: (c) => /EACCES|ENOENT|ETIMEDOUT|ECONNREFUSED|ECONNRESET|EPIPE|ENOTDIR|EISDIR|EMFILE|CalledProcessError|non-zero exit|exit code \d+|Command failed|Timeout \d+ms exceeded|timed out after/i.test(c.text)
  },
  { id: 'TOOL_RESULT_FAIL', category: 'tool', weight: 0.4, test: (c) => c.hasFailedToolResult },

  // ---- planning ----
  { id: 'PLAN_REPEAT', category: 'planning', weight: 0.6, test: (c) => c.repeatToolCalls >= 3 },
  { id: 'PLAN_LOOP', category: 'planning', weight: 0.5, test: (c) => c.hasLoop },
  { id: 'PLAN_OVER_BUDGET', category: 'planning', weight: 0.5, test: (c) => c.stepBudget > 0 && c.steps > c.stepBudget * 2 },

  // ---- reasoning ----
  {
    id: 'REASON_PARSE',
    category: 'reasoning',
    weight: 0.6,
    test: (c) => /JSON\.parse|Unexpected token|is not valid JSON|schema mismatch|schema 校验失败|Failed to parse/i.test(c.text)
  },
  {
    id: 'REASON_ASSERT',
    category: 'reasoning',
    weight: 0.4,
    test: (c) => c.kinds.includes('assert') && c.failed && c.allToolsSucceeded
  },

  // ---- knowledge ----
  {
    id: 'KNOW_DEPRECATED',
    category: 'knowledge',
    weight: 0.7,
    test: (c) => /deprecated|no longer supported|has been renamed|renamed to|moved to|removed in v?\d/i.test(c.text)
  },
  { id: 'KNOW_UNKNOWN_API', category: 'knowledge', weight: 0.4, test: (c) => /is not a function|undefined is not|unknown option|unsupported selector|no such method/i.test(c.text) },

  // ---- environment ----
  {
    id: 'ENV_OS_SPECIFIC',
    category: 'environment',
    weight: 0.6,
    test: (c) => /\r\n|CRLF|encoding|utf-?8|gbk|locale|LANG=|path separator|backslash|NODE_ENV|proxy|HTTPS_PROXY|permission denied|read-only file system|EPERM/i.test(c.text)
  },
  { id: 'ENV_OS_ONLY', category: 'environment', weight: 0.35, test: (c) => ['win32', 'darwin', 'linux'].includes(c.os) && /only on|仅在|on windows|on macos|on linux/i.test(c.text) }
];

/**
 * 构造归因上下文。
 * @param {{window?: Object[], session?: Object, event: Object, allEvents?: Object[]}} input
 * @returns {Object} 上下文
 */
function buildContext(input) {
  const win = input.window || [eventOnly(input.event)];
  const session = input.session || { events: win, outcomes: {} };
  const all = session.events || win;
  const error = (input.event && input.event.error) || null;
  const texts = [];
  const kinds = [];
  let steps = 0;
  let allToolsSucceeded = true;
  let toolResults = 0;
  let hasFailedToolResult = false;
  const toolCallSignatures = [];

  for (const ev of all) {
    kinds.push(ev.kind);
    steps += 1;
    const mi = toMatchInput(ev);
    texts.push(`${mi.error_type} ${mi.message} ${mi.text}`);
    if (ev.kind === 'tool_result' || ev.kind === 'tool_call') {
      toolResults += 1;
      if (ev.outcome === 'fail' || ev.outcome === 'timeout') {
        allToolsSucceeded = false;
        if (ev.kind === 'tool_result') hasFailedToolResult = true;
      }
    }
    if (ev.kind === 'tool_call') {
      const sig = JSON.stringify({
        tool: mi.tool,
        args: (ev.payload && ev.payload.args) || (ev.payload && ev.payload.input) || {}
      });
      toolCallSignatures.push(sig);
    }
  }

  // 同一 task 内重复（参数等价）的 tool_call 次数
  const freq = new Map();
  for (const sig of toolCallSignatures) freq.set(sig, (freq.get(sig) || 0) + 1);
  const repeatToolCalls = freq.size ? Math.max(...freq.values()) : 0;

  // A -> B -> A 回环
  let hasLoop = false;
  for (let i = 0; i + 2 < toolCallSignatures.length; i += 1) {
    if (toolCallSignatures[i] === toolCallSignatures[i + 2] && toolCallSignatures[i] !== toolCallSignatures[i + 1]) {
      hasLoop = true;
      break;
    }
  }

  const mi = toMatchInput(input.event);
  return {
    event: input.event,
    error,
    text: texts.join('\n'),
    kinds,
    steps,
    stepBudget: Number((input.event && input.event.payload && input.event.payload.step_budget) || 0),
    allToolsSucceeded: allToolsSucceeded && toolResults > 0,
    hasFailedToolResult,
    repeatToolCalls,
    hasLoop,
    os: mi.os,
    failed: true
  };
}

/**
 * @param {Object} ev
 * @returns {Object[]}
 */
function eventOnly(ev) {
  return ev ? [ev] : [];
}

/**
 * 归因主入口。
 * @param {{event: Object, window?: Object[], session?: Object}} input
 * @returns {{category: string, confidence: number, evidence: string[], rationale: string}}
 */
function attribute(input) {
  const ctx = buildContext(input);
  const scores = new Map();
  const evidence = [];

  for (const rule of RULES) {
    let hit = false;
    try {
      hit = !!rule.test(ctx);
    } catch (_e) {
      hit = false;
    }
    if (!hit) continue;
    scores.set(rule.category, (scores.get(rule.category) || 0) + rule.weight);
    evidence.push(rule.id);
  }

  if (scores.size === 0) {
    return {
      category: 'unknown',
      confidence: 0,
      evidence: [],
      rationale: '未命中任何归因规则，转人工队列'
    };
  }

  let best = null;
  let bestScore = -1;
  for (const [cat, score] of scores.entries()) {
    if (score > bestScore) {
      bestScore = score;
      best = cat;
    }
  }
  const topWeight = Math.max(...RULES.filter((r) => r.category === best && evidence.includes(r.id)).map((r) => r.weight));
  const hitCount = evidence.filter((eid) => (RULES.find((r) => r.id === eid) || {}).category === best).length;
  const confidence = Math.min(1, Math.max(0, topWeight + 0.1 * Math.max(0, hitCount - 1)));
  return {
    category: best,
    confidence: Number(confidence.toFixed(3)),
    evidence,
    rationale: `命中判据 ${evidence.join(',')}；累计权重 ${bestScore.toFixed(2)}`
  };
}

module.exports = { attribute, buildContext, RULES };

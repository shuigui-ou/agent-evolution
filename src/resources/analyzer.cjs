/**
 * @module src/resources/analyzer
 * @layer 资源服务（§5 定时批分析）
 * @owner Alex（软件工程师，K5）
 *
 * 定时批分析 = 算力外包：输入 traces_ref（内核 tap 事件或 AED 轨迹 JSONL 的路径），
 * 产出 归因 → 蒸馏 → 候选生成（全部规则化、确定性；llm.enabled=false 默认）。
 * 产出候选只是 L0 建议，采纳与否由内核按权限旋钮裁决；本模块绝不写知识面。
 *
 * 支持两种常见行格式：
 *  1) 内核事件：{ kind:'error', payload:{ message, detail }, session_id, task_id, ts, env }
 *  2) AED 轨迹：{ kind:'error', payload:{ message }, error:{ message }, ts, env }
 *  3) 裸错误：  { message, detail, skeleton, ts }
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { KernelError, genId, nowIso } = require('../../kernel/src/util.cjs');
const { classifySignal, aggregate } = require('../../kernel/src/signals.cjs');

/** 归因类别关键词规则（确定性规则版，无 LLM） */
const CATEGORY_RULES = Object.freeze([
  {
    category: 'AI_调用失败',
    gain: 0.3,
    suggestion:
      '校验 API key/凭证与网络可达性前置；失败自动 fallback 本地模型；指数退避重试 1 次后仍未恢复则转人工。',
    re: /fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket|proxy|api[_-]?key|invalid key|unauthorized|401|403|429|5\d\d|网络不可达|云端|deepseek|ollama/i,
  },
  {
    category: '格式错误',
    gain: 0.2,
    suggestion:
      '解析前剥离 ```json 围栏与首尾噪音；失败降级重试一次（要求仅输出 JSON）；仍失败则记录可读错误并归类。',
    re: /json|parse|syntax|unexpected token|Unexpected|围栏|markdown|格式错误/i,
  },
  {
    category: '超时/悬挂',
    gain: 0.15,
    suggestion:
      '为长调用设置显式超时 + 可中断；任务侧 finally 闭合与断点记录；超时单独指纹而非笼统归类。',
    re: /timeout|timed out|ETIMEDOUT|超时|悬挂|hang|ttl|overdue|deadline/i,
  },
  {
    category: '宿主技术债',
    gain: 0.1,
    suggestion:
      'API 契约变更（同步→Promise 等）需同步更新调用方与测试，纳入回归集；重大变更走审计 + 知识面记录。',
    re: /is not a function|TypeError|undefined|contract|契约|async|await|同步调用|map of|promises/i,
  },
]);

/** 兜底类别 */
const FALLBACK_CATEGORY = Object.freeze({
  category: '其他/待人工',
  gain: 0.05,
  suggestion:
    '记录现场完整信息（输入/输出/堆栈/环境）并归档；同类错误再次出现时建议人工确认根因后灌入解法池。',
});

/**
 * 确定性归因：扫关键词规则，返回首个命中类别
 * @param {string} text
 * @returns {{category: string, gain: number, suggestion: string, matched: string|null}}
 */
function classifyErrorCategory(text) {
  const s = String(text || '');
  for (const rule of CATEGORY_RULES) {
    const m = s.match(rule.re);
    if (m) {
      return { category: rule.category, gain: rule.gain, suggestion: rule.suggestion, matched: m[0] };
    }
  }
  return { ...FALLBACK_CATEGORY, matched: null };
}

/** 从任意轨迹行提取"错误文本"（无错误语义则返回 null） */
function extractErrorText(line) {
  if (!line || typeof line !== 'object') return null;
  const kind = String(line.kind || '');
  const isErrorLike =
    kind === 'error' ||
    kind === 'E' ||
    Boolean(line.error) ||
    Boolean(line.message) ||
    Boolean(line.title);
  if (!isErrorLike) return null;
  const message =
    (line.payload && line.payload.message) ||
    (line.error && line.error.message) ||
    line.message ||
    line.title ||
    '';
  const detail =
    (line.payload && line.payload.detail) ||
    (line.payload && line.payload.message) ||
    line.detail ||
    '';
  if (!message && !detail) return null;
  return { message: String(message), detail: String(detail), raw: line };
}

/**
 * 创建批分析器
 * @param {object} [opts]
 * @param {object} [opts.llm={enabled:false, provider:'none'}]
 * @param {number} [opts.maxGroups=10] - 候选组上限（防爆炸）
 */
function createAnalyzer({ llm = { enabled: false, provider: 'none' }, maxGroups = 10 } = {}) {
  /**
   * 执行一轮批分析。
   * @param {object} params
   * @param {string} params.tracesRef - 轨迹 JSONL 路径（相对 baseDir 或绝对）
   * @param {string} [params.agent='unknown']
   * @param {string} [params.env='unknown']
   * @param {string} [params.baseDir=process.cwd()]
   * @returns {Promise<object>} job report
   */
  async function analyzeTraces({ tracesRef = '', agent = 'unknown', env = 'unknown', baseDir = process.cwd() } = {}) {
    const startedAt = Date.now();
    if (!tracesRef) {
      throw new KernelError('ANALYZE_INVALID', 'POST /jobs/analyze 必须提供 traces_ref', { traces_ref: tracesRef });
    }
    const abs = path.isAbsolute(tracesRef) ? tracesRef : path.resolve(baseDir, tracesRef);
    if (!fs.existsSync(abs)) {
      throw new KernelError('ANALYZE_NOT_FOUND', `轨迹文件不存在: ${abs}`, { traces_ref: tracesRef });
    }
    const raw = fs.readFileSync(abs, 'utf8');
    const signals = [];
    let linesTotal = 0;
    let linesError = 0;
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      linesTotal += 1;
      let obj = null;
      try {
        obj = JSON.parse(trimmed);
      } catch (_e) {
        continue; // 损坏行跳过
      }
      const errText = extractErrorText(obj);
      if (!errText) continue;
      linesError += 1;
      const signal = classifySignal({
        kind: obj.kind === 'error' ? 'runtime_error' : 'error',
        title: errText.message,
        detail: errText.detail,
        source: 'resource-analyze',
        sessionId: obj.session_id || (obj.payload && obj.payload.session_id) || '',
        taskId: obj.task_id || (obj.payload && obj.payload.task_id) || '',
        ts: obj.ts || undefined,
      });
      signals.push(signal);
    }

    const groups = aggregate(signals).slice(0, maxGroups);
    const candidates = groups.map((g) => {
      const first = signals.find((s) => s.fingerprint === g.fingerprint);
      const attribution = classifyErrorCategory(first ? first.title + ' ' + first.detail : g.title);
      const probe = {
        trigger: `错误骨架 fingerprint=${g.fingerprint} 再现`,
        judge: '同错误再现时行为是否包含归因建议中的修复动作',
      };
      const content = [
        `【批分析候选 L0-建议，供内核裁决】`,
        `同类问题 fingerprint=${g.fingerprint} 出现 ${g.count} 次（type=${g.type}）`,
        `归因类别：${attribution.category}`,
        `建议动作：${attribution.suggestion}`,
      ].join('\n');
      return {
        candidate_id: genId('CAND'),
        fingerprint: g.fingerprint,
        type: g.type,
        count: g.count,
        category: attribution.category,
        title: `批分析候选[${attribution.category}] 出现${g.count}次`,
        content,
        fix_hint: attribution.suggestion,
        unit: 'E1',
        expected_gain: Math.round(attribution.gain * 100) / 100,
        probe,
        source: 'resource-analyze',
        first_ts: g.first_ts,
        last_ts: g.last_ts,
      };
    });

    return {
      job_id: genId('JOB'),
      status: 'done',
      traces_ref: tracesRef,
      agent,
      env,
      llm: { enabled: Boolean(llm && llm.enabled), provider: (llm && llm.provider) || 'none', mode: 'rules' },
      lines_total: linesTotal,
      lines_error: linesError,
      signal_count: signals.length,
      groups: groups.map((g) => ({
        fingerprint: g.fingerprint,
        type: g.type,
        count: g.count,
        title: g.title,
      })),
      candidates,
      duration_ms: Date.now() - startedAt,
      created_at: nowIso(),
    };
  }

  return { analyzeTraces, classifyErrorCategory };
}

module.exports = { createAnalyzer, classifyErrorCategory, CATEGORY_RULES, FALLBACK_CATEGORY, extractErrorText };

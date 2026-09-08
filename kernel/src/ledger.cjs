/**
 * @module ledger
 * @layer L1 数据层（承诺账本）
 * @owner Kou（工程师，K1）
 *
 * 承诺账本 = 错误信号模型的统一抽象（规范 §2）：
 *  - 期望账本（expectation）：用户请求中可验收要点，超期未闭合 → G 期望落差
 *  - 计划账本（plan）：agent 声明的步骤，超期未闭合 → P 计划偏离
 *  - 线程账本（thread）：开启未收尾的项目/会话，超期未闭合 → I 悬挂未完结（默认人审，绝不自动 resume）
 *  - 运行错误（error）：异常/超时/exit≠0，直接物化为已闭合记录 → E 错误
 *
 * 记录生命周期：open → closed；open 且过 due_at = 超期（I 型悬挂信号的主要来源）。
 * 持久化：runtime/ledger/ledger.jsonl，全量重写（原型规模足够，读取兼容 \r\n）。
 */
'use strict';

const path = require('node:path');
const { KernelError, readJsonl, writeJsonl, genId, nowIso } = require('./util.cjs');

/** 四类账本标识 */
const LEDGERS = Object.freeze(['expectation', 'plan', 'thread', 'error']);

/** 账本 → 信号类型映射（规范 §2 表格） */
const LEDGER_SIGNAL_TYPE = Object.freeze({
  expectation: 'G',
  plan: 'P',
  thread: 'I',
  error: 'E',
});

/**
 * 创建承诺账本存储
 * @param {object} opts
 * @param {string} opts.dataDir - 运行期数据目录（默认 ./runtime）
 * @returns {object} ledger API
 */
function createLedgerStore({ dataDir = 'runtime' } = {}) {
  const file = path.join(dataDir, 'ledger', 'ledger.jsonl');
  let cache = readJsonl(file);

  /** 全量重写持久化 */
  function persist() {
    writeJsonl(file, cache);
  }

  /** 校验账本类型 */
  function assertLedger(name) {
    if (!LEDGERS.includes(name)) {
      throw new KernelError('LEDGER_INVALID', `未知账本类型: ${name}`, { ledger: name });
    }
  }

  /**
   * 开一条承诺记录（open）
   * @param {object} e
   * @param {string} e.ledger - expectation|plan|thread
   * @param {string} e.title - 承诺内容摘要
   * @param {string} [e.detail]
   * @param {string} [e.dueAt] - ISO 截止时刻；thread 类必须有（超期即 I 型信号）
   * @param {string} [e.sessionId] [e.taskId]
   * @returns {object} 记录
   */
  function open({ ledger, title, detail = '', dueAt = null, sessionId = '', taskId = '' }) {
    assertLedger(ledger);
    if (!title || typeof title !== 'string') {
      throw new KernelError('LEDGER_INVALID', '承诺记录必须有 title');
    }
    if (ledger === 'thread' && !dueAt) {
      // 线程账本必须有生命周期巡检点，否则悬挂永远检不出来
      throw new KernelError('LEDGER_INVALID', 'thread 账本记录必须带 dueAt（生命周期巡检点）');
    }
    const entry = {
      id: genId('LG'),
      ledger,
      title,
      detail,
      due_at: dueAt,
      opened_at: nowIso(),
      closed_at: null,
      status: 'open',
      outcome: null,
      overdue_reported: false,
      session_id: sessionId,
      task_id: taskId,
    };
    cache.push(entry);
    persist();
    return entry;
  }

  /**
   * 闭合一条记录（open → closed）
   * @param {string} id
   * @param {object} [result] - { outcome }
   * @returns {object} 更新后的记录
   */
  function close(id, { outcome = null } = {}) {
    const entry = cache.find((x) => x.id === id);
    if (!entry) {
      throw new KernelError('LEDGER_NOT_FOUND', `承诺记录不存在: ${id}`, { id });
    }
    if (entry.status === 'closed') {
      throw new KernelError('LEDGER_ALREADY_CLOSED', `承诺记录已闭合，不可重复闭合: ${id}`, {
        id,
      });
    }
    entry.status = 'closed';
    entry.closed_at = nowIso();
    entry.outcome = outcome;
    persist();
    return entry;
  }

  /**
   * 记录一条运行错误（异常/超时/exit≠0）：直接物化为已闭合记录 → E 类信号源
   */
  function addError({ title, detail = '', sessionId = '', taskId = '', payload = null }) {
    assertLedger('error');
    const entry = {
      id: genId('LG'),
      ledger: 'error',
      title,
      detail,
      due_at: null,
      opened_at: nowIso(),
      closed_at: nowIso(),
      status: 'closed',
      outcome: { kind: 'error', payload },
      overdue_reported: false,
      session_id: sessionId,
      task_id: taskId,
    };
    cache.push(entry);
    persist();
    return entry;
  }

  /** 列出 open 记录，可按账本过滤 */
  function listOpen(ledger = null) {
    return cache.filter(
      (e) => e.status === 'open' && (ledger ? e.ledger === ledger : true)
    );
  }

  /** 全量记录 */
  function list() {
    return cache.slice();
  }

  /** 按 ID 取记录 */
  function get(id) {
    return cache.find((x) => x.id === id) || null;
  }

  /**
   * 超期检测（I 型悬挂信号 / G、P 落差信号的机器可检来源）：
   * 扫描 open 且 due_at 已过且尚未上报的记录，标记 overdue_reported 并返回。
   * thread 账本只上报信号，绝不自动 resume（规范 §2：默认人审，必须 ask）。
   * @param {number} [nowMs] - 当前毫秒时间戳（默认系统时钟）
   * @returns {{entry: object, signalType: string}[]}
   */
  function detectOverdue(nowMs = Date.now()) {
    const out = [];
    for (const e of cache) {
      if (e.status !== 'open' || !e.due_at || e.overdue_reported) continue;
      if (new Date(e.due_at).getTime() < nowMs) {
        e.overdue_reported = true;
        out.push({ entry: e, signalType: LEDGER_SIGNAL_TYPE[e.ledger] });
      }
    }
    if (out.length) persist();
    return out;
  }

  return { open, close, addError, listOpen, list, get, detectOverdue, file };
}

module.exports = { createLedgerStore, LEDGERS, LEDGER_SIGNAL_TYPE };

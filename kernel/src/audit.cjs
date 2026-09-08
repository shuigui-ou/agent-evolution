/**
 * @module audit
 * @layer L1 数据层（审计链）
 * @owner Kou（工程师，K1）
 *
 * 规范 §4 审计链：append-only hash chain，可离线校验完整性。
 * 记录结构：{ seq, ts, type, payload, prev, hash }
 *   hash = sha256(JSON({seq, ts, type, payload, prev}))
 *   prev = 上一条 hash（首条为 'GENESIS'）
 * 任何篡改（改内容 / 删行 / 插行）都会导致 verify() 断链。
 */
'use strict';

const path = require('node:path');
const { KernelError, sha256hex, readJsonl, appendJsonl, nowIso } = require('./util.cjs');

/** 创世 prev 值 */
const GENESIS = 'GENESIS';

function computeRecordHash(rec) {
  return sha256hex(
    JSON.stringify({ seq: rec.seq, ts: rec.ts, type: rec.type, payload: rec.payload, prev: rec.prev })
  );
}

/**
 * 创建审计链
 * @param {object} opts
 * @param {string} [opts.dataDir='runtime']
 */
function createAudit({ dataDir = 'runtime' } = {}) {
  const file = path.join(dataDir, 'audit', 'audit.jsonl');
  const chain = readJsonl(file);

  /** 末条记录 */
  function last() {
    return chain.length ? chain[chain.length - 1] : null;
  }

  /**
   * 追加一条审计记录（append-only：只 push，不提供任何改/删接口）
   * @param {string} type - 事件类型（如 KNOWLEDGE_WRITE / T4_BLOCKED / ROLLBACK）
   * @param {object} [payload]
   * @returns {object} 完整记录（含 hash）
   */
  function append(type, payload = {}) {
    if (!type || typeof type !== 'string') {
      throw new KernelError('AUDIT_INVALID', '审计记录必须有 type');
    }
    const prev = last() ? last().hash : GENESIS;
    const rec = {
      seq: chain.length ? last().seq + 1 : 1,
      ts: nowIso(),
      type,
      payload,
      prev,
      hash: '',
    };
    rec.hash = computeRecordHash(rec);
    chain.push(rec);
    appendJsonl(file, rec);
    return rec;
  }

  /**
   * 离线校验链完整性：逐条重算 hash + 校验 prev 链接 + seq 连续
   * @returns {{ok: boolean, checked: number, brokenAt: number|null, reason: string|null}}
   */
  function verify() {
    let prevHash = GENESIS;
    let expectSeq = 1;
    for (const rec of chain) {
      if (rec.seq !== expectSeq) {
        return { ok: false, checked: expectSeq - 1, brokenAt: rec.seq, reason: 'seq_gap' };
      }
      if (rec.prev !== prevHash) {
        return { ok: false, checked: expectSeq - 1, brokenAt: rec.seq, reason: 'prev_mismatch' };
      }
      if (computeRecordHash(rec) !== rec.hash) {
        return { ok: false, checked: expectSeq - 1, brokenAt: rec.seq, reason: 'hash_mismatch' };
      }
      prevHash = rec.hash;
      expectSeq += 1;
    }
    return { ok: true, checked: chain.length, brokenAt: null, reason: null };
  }

  /** 全量记录 */
  function list() {
    return chain.slice();
  }

  /** 链长度 */
  function length() {
    return chain.length;
  }

  /** 按类型过滤 */
  function listByType(type) {
    return chain.filter((r) => r.type === type);
  }

  return { append, verify, list, listByType, length, file };
}

module.exports = { createAudit, GENESIS, computeRecordHash };

/**
 * @module util/errors
 * @layer util
 * @owner kou
 * 统一错误码表与 AedError 类。所有可预期错误必须使用 AedError，禁止裸 throw new Error。
 */

'use strict';

/** 错误码 -> HTTP 语义状态 */
const ERROR_CODES = Object.freeze({
  AED_OK: 0,
  E_CONFIG_INVALID: 500,
  E_SCHEMA_MISMATCH: 400,
  E_ADAPTER_UNAVAILABLE: 503,
  E_GATE_STATIC_FAIL: 422,
  E_GATE_REGRESSION_FAIL: 422,
  E_GATE_SYNTHETIC_FAIL: 422,
  E_GATE_SHADOW_FAIL: 422,
  E_INJECTION_DETECTED: 422,
  E_RISK_REQUIRES_HUMAN: 409,
  E_CANARY_ABORTED: 409,
  E_ROLLBACK_TRIGGERED: 409,
  E_SIGNATURE_INVALID: 401,
  E_TRUST_INSUFFICIENT: 403,
  E_DUPLICATE: 200,
  E_CONFLICT_PENDING: 409,
  E_BUDGET_EXCEEDED: 413,
  E_LOCK_HELD: 423,
  E_AUDIT_BROKEN: 500,
  E_NOT_FOUND: 404,
  E_ARG_INVALID: 400,
  E_IO_FAIL: 500
});

/**
 * AED 统一错误类型。
 */
class AedError extends Error {
  /**
   * @param {string} code 错误码，必须在 ERROR_CODES 中定义
   * @param {string} message 人类可读说明
   * @param {Object} [detail] 结构化上下文
   */
  constructor(code, message, detail = {}) {
    const known = Object.prototype.hasOwnProperty.call(ERROR_CODES, code);
    super(message || code);
    this.name = 'AedError';
    this.code = known ? code : 'E_CONFIG_INVALID';
    this.detail = detail || {};
    this.http = ERROR_CODES[this.code];
    if (!known) {
      this.detail = Object.assign({ originalCode: code }, this.detail);
    }
  }

  /** @returns {Object} 可落盘的 JSON 表示 */
  toJSON() {
    return {
      code: this.code,
      message: this.message,
      detail: this.detail,
      http: this.http
    };
  }
}

/** @param {*} e @returns {boolean} */
function isAedError(e) {
  return e instanceof AedError;
}

/**
 * 抛出一个 AedError（便于 return fail(...) 风格调用）。
 * @param {string} code
 * @param {string} message
 * @param {Object} [detail]
 * @returns {never}
 */
function fail(code, message, detail) {
  throw new AedError(code, message, detail);
}

/**
 * 把任意异常归一化成 { code, message }。
 * @param {*} e
 * @returns {{code: string, message: string}}
 */
function normalizeError(e) {
  if (isAedError(e)) {
    return { code: e.code, message: e.message };
  }
  return { code: 'E_IO_FAIL', message: (e && e.message) || String(e) };
}

module.exports = {
  AedError,
  ERROR_CODES,
  isAedError,
  fail,
  normalizeError
};

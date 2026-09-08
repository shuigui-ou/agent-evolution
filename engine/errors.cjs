/**
 * @module errors
 * @owner Kou（工程师，共享 engine K8）
 *
 * Engine 层统一错误类型（KernelError 风格）：所有失败路径都抛 EngineError，
 * code 用于跨模块判别（如 EVOLUTION_YAML_INVALID / EVOLUTION_SCHEMA_INVALID），
 * message 统一携带 [CODE] 前缀便于 assert.throws(/CODE/) 匹配。
 * 零依赖、可随 engine/ 目录整体复制到任意宿主。
 */
'use strict';

class EngineError extends Error {
  /**
   * @param {string} code - 错误码（如 EVOLUTION_SCHEMA_INVALID / PATH_NOT_WHITELISTED）
   * @param {string} message - 人类可读信息
   * @param {object|null} [detail] - 附加上下文
   */
  constructor(code, message, detail = null) {
    super(`[${code}] ${message}`);
    this.name = 'EngineError';
    this.code = code;
    this.detail = detail;
  }
}

module.exports = { EngineError };

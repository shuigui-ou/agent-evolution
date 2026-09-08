/**
 * @module util
 * @layer L0 基础工具层
 * @owner Kou（工程师，K1）
 *
 * 内核公共工具：统一错误类型、hash、JSONL 读写（换行显式 \n，读取兼容 \r\n）、ID 生成。
 * 全库零第三方依赖，仅用 Node 内置模块。
 */
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

/** 内核统一错误类型：所有模块的失败路径都抛 KernelError，code 用于跨模块判别 */
class KernelError extends Error {
  /**
   * @param {string} code  - 错误码（如 T4_VIOLATION / PATH_NOT_WHITELISTED）
   * @param {string} message - 人类可读信息
   * @param {object|null} [detail] - 附加上下文
   */
  constructor(code, message, detail = null) {
    // message 统一携带 [CODE] 前缀：assert.throws(/CODE/) 可直接匹配
    super(`[${code}] ${message}`);
    this.name = 'KernelError';
    this.code = code;
    this.detail = detail;
  }
}

/** sha256 摘要（hex） */
function sha256hex(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

/** 取 sha256 前 n 位（默认 16），用于 fingerprint 归一化 */
function shortHash(text, n = 16) {
  return sha256hex(text).slice(0, n);
}

/** 当前时刻 ISO 字符串（可被测试时钟替换，但本函数本身固定） */
function nowIso() {
  return new Date().toISOString();
}

/**
 * 读 JSONL：显式按 \r?\n 切行（兼容 \r\n），跳过空行与损坏行（不中断整体读取）
 * @param {string} file - JSONL 文件绝对路径
 * @returns {object[]}
 */
function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  const raw = fs.readFileSync(file, 'utf8');
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch (_e) {
      // 损坏行跳过：审计与账本宁可缺一行也不让全库崩溃
    }
  }
  return out;
}

/** 追加一条 JSON 到 JSONL 文件（换行显式 \n），目录不存在则自动创建 */
function appendJsonl(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(obj) + '\n', 'utf8');
}

/** 整体重写 JSONL 文件（换行显式 \n），用于账本等需要原位更新的小规模存储 */
function writeJsonl(file, arr) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = arr.map((o) => JSON.stringify(o)).join('\n');
  fs.writeFileSync(file, arr.length ? body + '\n' : '', 'utf8');
}

/** 生成带前缀的短 ID：前缀-时间戳36进制-6位随机 */
function genId(prefix) {
  return (
    prefix + '-' + Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex')
  );
}

/** 今天的日期键（本地时区，yyyy-mm-dd），用于频率上限按天计数 */
function todayKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

module.exports = {
  KernelError,
  sha256hex,
  shortHash,
  nowIso,
  readJsonl,
  appendJsonl,
  writeJsonl,
  genId,
  todayKey,
};

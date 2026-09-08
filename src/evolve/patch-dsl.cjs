/**
 * @module evolve/patch-dsl
 * @layer evolve
 * @owner kou
 * Patch DSL：只允许 5 种 op，路径必须在 skillRoot 内（防目录穿越），
 * add_file 仅限 scripts/ 目录且后缀在白名单内。
 */

'use strict';

const path = require('node:path');
const { AedError } = require('../util/errors.cjs');

/** 允许的 op */
const OPS = Object.freeze(['append_section', 'replace_regex', 'upsert_frontmatter', 'add_file', 'deprecate']);
/** add_file 允许目录 */
const FILE_DIR_WHITELIST = Object.freeze(['scripts', 'scripts/', 'tests']);
/** add_file 允许后缀 */
const FILE_EXT_WHITELIST = Object.freeze(['.cjs', '.md', '.json']);

/**
 * 校验 op 名称。
 * @param {Object} op
 * @returns {void}
 */
function assertOp(op) {
  if (!op || typeof op !== 'object') {
    throw new AedError('E_SCHEMA_MISMATCH', 'op 必须是对象');
  }
  if (!OPS.includes(op.op)) {
    throw new AedError('E_SCHEMA_MISMATCH', `不支持的 patch op：${op.op}`, { allowed: OPS.slice() });
  }
}

/**
 * 解析并校验相对路径，防止目录穿越。
 * @param {string} relPath patch 中的相对路径
 * @param {string} skillRoot 技能根目录（绝对路径）
 * @returns {string} 绝对路径
 */
function resolveSafePath(relPath, skillRoot) {
  const root = path.resolve(skillRoot);
  const rel = String(relPath || '').replace(/\\/g, '/');
  if (!rel || rel.startsWith('/') || /^[a-zA-Z]:/.test(rel)) {
    throw new AedError('E_SCHEMA_MISMATCH', `非法路径（必须为相对路径）：${relPath}`);
  }
  if (rel.split('/').includes('..')) {
    throw new AedError('E_SCHEMA_MISMATCH', `路径含目录穿越：${relPath}`);
  }
  const full = path.resolve(root, rel);
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (full !== root && !full.startsWith(rootWithSep)) {
    throw new AedError('E_SCHEMA_MISMATCH', `路径越出 skillRoot：${relPath}`, { skillRoot, full });
  }
  return full;
}

/**
 * 校验 add_file 的目录与后缀白名单。
 * @param {string} relPath
 * @returns {void}
 */
function assertAddFileAllowed(relPath) {
  const rel = String(relPath || '').replace(/\\/g, '/');
  const idx = rel.lastIndexOf('/');
  const dir = idx >= 0 ? rel.slice(0, idx) : '';
  const ext = path.extname(rel).toLowerCase();
  const dirOk = dir === '' || FILE_DIR_WHITELIST.some((d) => dir === d || dir.startsWith(`${d}/`));
  if (!dirOk) {
    throw new AedError('E_SCHEMA_MISMATCH', `add_file 只允许写入 ${FILE_DIR_WHITELIST.join('/')} 目录：${relPath}`);
  }
  if (!FILE_EXT_WHITELIST.includes(ext)) {
    throw new AedError('E_SCHEMA_MISMATCH', `add_file 后缀不允许：${ext}`, { allowed: FILE_EXT_WHITELIST.slice() });
  }
}

/**
 * 校验整个 patch。
 * @param {Object} patch
 * @param {{skillRoot?: string}} [opts]
 * @returns {{ok: boolean, paths: string[]}}
 */
function validatePatch(patch, opts = {}) {
  if (!patch || patch.schema !== 'aed/patch/1.0') {
    throw new AedError('E_SCHEMA_MISMATCH', `patch.schema 必须为 aed/patch/1.0，实际 ${patch && patch.schema}`);
  }
  const ops = patch.ops || [];
  if (!Array.isArray(ops) || ops.length === 0) {
    throw new AedError('E_SCHEMA_MISMATCH', 'patch.ops 不能为空');
  }
  if (ops.length > 8) {
    throw new AedError('E_SCHEMA_MISMATCH', `patch.ops 最多 8 条，实际 ${ops.length}`);
  }
  const resolved = [];
  for (const op of ops) {
    assertOp(op);
    if (op.op === 'add_file') assertAddFileAllowed(op.path);
    if (typeof op.content === 'string' && op.content.length > 8000) {
      throw new AedError('E_SCHEMA_MISMATCH', 'op.content 超过 8000 字符');
    }
    const rel = op.path || (patch.target && patch.target.path);
    if (rel && opts.skillRoot) resolved.push(resolveSafePath(rel, opts.skillRoot));
  }
  return { ok: true, paths: resolved };
}

/**
 * 计算反向 op（best-effort；权威还原依赖 rollback 快照）。
 * @param {Object} patch
 * @param {{before?: string}} [ctx] 变更前的目标文件内容
 * @returns {Object[]}
 */
function computeReverseOps(patch, ctx = {}) {
  const targetPath = (patch.target && patch.target.path) || 'SKILL.md';
  const out = [];
  for (const op of patch.ops || []) {
    switch (op.op) {
      case 'append_section':
        out.push({
          op: 'replace_regex',
          path: op.path || targetPath,
          pattern: escapeRegex(op.content || ''),
          replacement: ''
        });
        break;
      case 'replace_regex':
        out.push({
          op: 'replace_regex',
          path: op.path || targetPath,
          pattern: escapeRegex(op.replacement || ''),
          replacement: op.pattern || ''
        });
        break;
      case 'upsert_frontmatter':
        out.push({
          op: 'upsert_frontmatter',
          path: op.path || targetPath,
          key: op.key,
          value: (ctx.before && readFrontmatterValue(ctx.before, op.key)) ?? null
        });
        break;
      case 'add_file':
        out.push({ op: 'deprecate', path: op.path, content: `revert add_file ${op.path}` });
        break;
      case 'deprecate':
        out.push({ op: 'replace_regex', path: op.path || targetPath, pattern: escapeRegex(op.content || 'DEPRECATED'), replacement: '' });
        break;
      default:
        break;
    }
  }
  return out;
}

/**
 * 转义正则元字符。
 * @param {string} s
 * @returns {string}
 */
function escapeRegex(s) {
  return String(s == null ? '' : s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 读取 frontmatter 中的标量值。
 * @param {string} text
 * @param {string} key
 * @returns {string|null}
 */
function readFrontmatterValue(text, key) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(text || ''));
  if (!m) return null;
  const line = m[1].split(/\r?\n/).find((l) => l.startsWith(`${key}:`));
  if (!line) return null;
  return line.slice(key.length + 1).trim();
}

module.exports = {
  OPS,
  FILE_DIR_WHITELIST,
  FILE_EXT_WHITELIST,
  assertOp,
  resolveSafePath,
  assertAddFileAllowed,
  validatePatch,
  computeReverseOps,
  escapeRegex,
  readFrontmatterValue
};

/**
 * @module evolve/patch-apply
 * @layer evolve
 * @owner kou
 * patch 应用：dryRun / 路径前缀校验 / 快照 / 变更清单。
 * 只支持 patch-dsl 定义的 5 种 op，禁止任意文件写。
 */

'use strict';

const path = require('node:path');
const fsx = require('../util/fsx.cjs');
const dsl = require('./patch-dsl.cjs');
const { AedError } = require('../util/errors.cjs');

/**
 * 判断是否含 frontmatter。
 * @param {string} text
 * @returns {RegExpMatchArray|null}
 */
function frontmatterMatch(text) {
  return /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(String(text || ''));
}

/**
 * YAML 标量格式化。
 * @param {*} v
 * @returns {string}
 */
function toYamlScalar(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  if (Array.isArray(v) || typeof v === 'object') return JSON.stringify(v);
  const s = String(v);
  if (/^[A-Za-z0-9_\-\.]+$/.test(s)) return s;
  return `"${s.replace(/"/g, '\\"')}"`;
}

/**
 * upsert frontmatter 键。
 * @param {string} text
 * @param {string} key
 * @param {*} value
 * @returns {string}
 */
function upsertFrontmatter(text, key, value) {
  const line = `${key}: ${toYamlScalar(value)}`;
  const m = frontmatterMatch(text);
  if (!m) {
    return `---\n${line}\n---\n\n${String(text || '').replace(/^\s+/, '')}`;
  }
  const body = m[1];
  const lines = body.split(/\r?\n/);
  const idx = lines.findIndex((l) => new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:`).test(l));
  if (idx >= 0) lines[idx] = line;
  else lines.push(line);
  const newBody = `---\n${lines.join('\n')}\n---\n`;
  return String(text).replace(m[0], newBody);
}

/**
 * 在指定标题章节末尾追加内容；章节不存在则创建。
 * @param {string} text
 * @param {{anchor: string, content: string}} op
 * @returns {{text: string, created: boolean}}
 */
function appendSection(text, op) {
  const raw = String(text || '');
  const anchorTitle = String(op.anchor || '').replace(/^#{1,6}\s*/, '').trim();
  const lines = raw.split(/\r?\n/);
  let idx = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^(#{1,6})\s+(.*)$/.exec(lines[i]);
    if (!m) continue;
    if (m[2].trim() === anchorTitle) {
      idx = i;
      level = m[1].length;
      break;
    }
  }
  if (idx < 0) {
    const heading = `## ${anchorTitle}`;
    const body = String(op.content || '').replace(/^\n+/, '').replace(/\s*$/, '');
    const glued = `${raw.replace(/\s*$/, '')}\n\n${heading}\n\n${body}\n`;
    return { text: glued, created: true };
  }
  let end = lines.length;
  for (let i = idx + 1; i < lines.length; i += 1) {
    const m = /^(#{1,6})\s+/.exec(lines[i]);
    if (m && m[1].length <= level) {
      end = i;
      break;
    }
  }
  const body = String(op.content || '').replace(/\s*$/, '');
  const next = lines.slice(0, end).concat([body.replace(/^\n/, '')], lines.slice(end));
  return { text: next.join('\n').replace(/\s*$/, '\n'), created: false };
}

/**
 * 应用 patch。
 * @param {{patch: Object, skillRoot: string, dryRun?: boolean, snapshotFn?: Function}} input
 * @returns {{applied: boolean, dryRun: boolean, changes: Object[], errors: string[], snapshot: Object|null}}
 */
function apply(input = {}) {
  const patch = input.patch;
  const skillRoot = path.resolve(input.skillRoot || '.');
  const dryRun = !!input.dryRun;
  dsl.validatePatch(patch, { skillRoot });

  const errors = [];
  /** @type {Map<string, string>} */
  const working = new Map();
  const textOf = (abs) => {
    if (!working.has(abs)) working.set(abs, fsx.exists(abs) ? fsx.readText(abs) : '');
    return working.get(abs);
  };

  for (const op of patch.ops) {
    const rel = op.path || (patch.target && patch.target.path) || 'SKILL.md';
    try {
      if (op.op === 'add_file') {
        dsl.assertAddFileAllowed(rel);
      }
      const abs = dsl.resolveSafePath(rel, skillRoot);
      if (op.op === 'add_file') {
        working.set(abs, String(op.content || ''));
        continue;
      }
      let text = textOf(abs);
      switch (op.op) {
        case 'append_section': {
          const r = appendSection(text, op);
          text = r.text;
          break;
        }
        case 'replace_regex': {
          const re = new RegExp(op.pattern || '', 'g');
          if (!re.test(text)) errors.push(`replace_regex 未命中：${op.pattern}`);
          text = text.replace(new RegExp(op.pattern || '', 'g'), op.replacement == null ? '' : op.replacement);
          break;
        }
        case 'upsert_frontmatter': {
          text = upsertFrontmatter(text, op.key || 'key', op.value === undefined ? null : op.value);
          break;
        }
        case 'deprecate': {
          text = upsertFrontmatter(text, 'deprecated', true);
          const note = String(op.content || '<!-- DEPRECATED by AED -->');
          text = `${note}\n${text}`;
          break;
        }
        default:
          errors.push(`未处理的 op：${op.op}`);
      }
      working.set(abs, text);
    } catch (e) {
      if (e && e.code && String(e.code).startsWith('E_')) throw e;
      errors.push(`${op.op}@${rel}: ${(e && e.message) || e}`);
    }
  }

  const changes = [];
  for (const [abs, after] of working.entries()) {
    const before = fsx.exists(abs) ? fsx.readText(abs) : '';
    if (before === after) continue;
    changes.push({
      path: abs,
      rel: path.relative(skillRoot, abs).replace(/\\/g, '/'),
      before_bytes: Buffer.byteLength(before, 'utf8'),
      after_bytes: Buffer.byteLength(after, 'utf8'),
      delta_bytes: Buffer.byteLength(after, 'utf8') - Buffer.byteLength(before, 'utf8')
    });
  }

  // 先快照、后落盘：保证任何写盘动作之前都存在可还原点
  let snapshot = null;
  if (!dryRun && changes.length > 0 && typeof input.snapshotFn === 'function') {
    snapshot = input.snapshotFn();
  }
  if (!dryRun) {
    for (const [abs, after] of working.entries()) {
      if (!changes.some((c) => c.path === abs)) continue;
      fsx.ensureDir(path.dirname(abs));
      fsx.atomicWrite(abs, after);
    }
  }

  if (errors.length && changes.length === 0) {
    throw new AedError('E_SCHEMA_MISMATCH', `patch 应用失败：${errors.join('; ')}`, { errors });
  }
  return { applied: !dryRun, dryRun, changes, errors, snapshot };
}

module.exports = { apply, appendSection, upsertFrontmatter, frontmatterMatch, toYamlScalar };

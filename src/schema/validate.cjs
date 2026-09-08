/**
 * @module schema/validate
 * @layer schema
 * @owner kou
 * 手写极简 JSON Schema 校验器（零依赖）。
 * 支持的关键词：type / required / enum / const / pattern / minLength / maxLength /
 * minimum / maximum / minItems / maxItems / minProperties / properties / items / $ref。
 * 不支持：anyOf / oneOf / if-then / $defs 以外的复杂组合。
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { AedError } = require('../util/errors.cjs');

/** schema $id -> schema 对象 */
const REGISTRY = new Map();

/**
 * 加载目录下所有 *.schema.json 到注册表。
 * @param {string} [dir] 默认 src/schema
 * @returns {Map<string, Object>}
 */
function loadRegistry(dir = __dirname) {
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.schema.json')) continue;
    const schema = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
    if (schema.$id) REGISTRY.set(schema.$id, schema);
    REGISTRY.set(name.replace(/\.schema\.json$/, ''), schema);
  }
  return REGISTRY;
}

/**
 * 注册单个 schema。
 * @param {string} id
 * @param {Object} schema
 * @returns {void}
 */
function register(id, schema) {
  REGISTRY.set(id, schema);
}

/**
 * 解析 $ref（优先注册表，其次本地 #/$defs）。
 * @param {string} ref
 * @param {Object} root
 * @returns {Object|null}
 */
function resolveRef(ref, root) {
  if (REGISTRY.has(ref)) return REGISTRY.get(ref);
  if (ref.startsWith('#/')) {
    const parts = ref.slice(2).split('/');
    let cur = root;
    for (const p of parts) {
      if (cur == null) return null;
      cur = cur[p];
    }
    return cur || null;
  }
  return null;
}

/**
 * 类型判定。
 * @param {*} v
 * @returns {string}
 */
function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (Number.isInteger(v)) return 'integer';
  if (typeof v === 'number') return 'number';
  return typeof v;
}

/**
 * 类型匹配（支持 type 为字符串或数组；integer 时 number 也算通过）。
 * @param {*} v
 * @param {string|string[]} t
 * @returns {boolean}
 */
function typeMatches(v, t) {
  const types = Array.isArray(t) ? t : [t];
  const actual = typeOf(v);
  return types.some((x) => x === actual || (x === 'number' && actual === 'integer'));
}

/**
 * 核心校验递归。
 * @param {*} data
 * @param {Object} schema
 * @param {string} ptr JSON pointer 路径
 * @param {Object[]} errors 输出
 * @param {Object} root 根 schema（用于本地 $ref）
 * @returns {void}
 */
function check(data, schema, ptr, errors, root) {
  if (!schema || typeof schema !== 'object') return;

  if (schema.$ref) {
    const target = resolveRef(schema.$ref, root);
    if (!target) {
      errors.push({ path: ptr, keyword: '$ref', message: `无法解析 $ref: ${schema.$ref}` });
      return;
    }
    check(data, target, ptr, errors, root);
    return;
  }

  if (schema.type && !typeMatches(data, schema.type)) {
    errors.push({ path: ptr, keyword: 'type', message: `类型应为 ${JSON.stringify(schema.type)}，实际 ${typeOf(data)}` });
    return;
  }
  if (Object.prototype.hasOwnProperty.call(schema, 'const') && data !== schema.const) {
    errors.push({ path: ptr, keyword: 'const', message: `应等于 ${JSON.stringify(schema.const)}` });
  }
  if (schema.enum && !schema.enum.some((e) => e === data)) {
    errors.push({ path: ptr, keyword: 'enum', message: `取值应为 ${JSON.stringify(schema.enum)} 之一` });
  }
  if (typeof data === 'string') {
    if (Number.isFinite(schema.minLength) && data.length < schema.minLength) {
      errors.push({ path: ptr, keyword: 'minLength', message: `长度应 ≥ ${schema.minLength}` });
    }
    if (Number.isFinite(schema.maxLength) && data.length > schema.maxLength) {
      errors.push({ path: ptr, keyword: 'maxLength', message: `长度应 ≤ ${schema.maxLength}` });
    }
    if (schema.pattern && !new RegExp(schema.pattern).test(data)) {
      errors.push({ path: ptr, keyword: 'pattern', message: `不匹配 ${schema.pattern}` });
    }
  }
  if (typeof data === 'number') {
    if (Number.isFinite(schema.minimum) && data < schema.minimum) {
      errors.push({ path: ptr, keyword: 'minimum', message: `应 ≥ ${schema.minimum}` });
    }
    if (Number.isFinite(schema.maximum) && data > schema.maximum) {
      errors.push({ path: ptr, keyword: 'maximum', message: `应 ≤ ${schema.maximum}` });
    }
  }
  if (Array.isArray(data)) {
    if (Number.isFinite(schema.minItems) && data.length < schema.minItems) {
      errors.push({ path: ptr, keyword: 'minItems', message: `元素数应 ≥ ${schema.minItems}` });
    }
    if (Number.isFinite(schema.maxItems) && data.length > schema.maxItems) {
      errors.push({ path: ptr, keyword: 'maxItems', message: `元素数应 ≤ ${schema.maxItems}` });
    }
    if (schema.items) {
      data.forEach((item, i) => check(item, schema.items, `${ptr}/${i}`, errors, root));
    }
  }
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const keys = Object.keys(data);
    for (const req of schema.required || []) {
      if (!keys.includes(req)) {
        errors.push({ path: `${ptr}/${req}`, keyword: 'required', message: '必填字段缺失' });
      }
    }
    if (Number.isFinite(schema.minProperties) && keys.length < schema.minProperties) {
      errors.push({ path: ptr, keyword: 'minProperties', message: `属性数应 ≥ ${schema.minProperties}` });
    }
    if (schema.properties) {
      for (const key of Object.keys(schema.properties)) {
        if (keys.includes(key)) {
          check(data[key], schema.properties[key], `${ptr}/${key}`, errors, root);
        }
      }
    }
    if (schema.additionalProperties === false && schema.properties) {
      for (const key of keys) {
        if (!Object.prototype.hasOwnProperty.call(schema.properties, key)) {
          errors.push({ path: `${ptr}/${key}`, keyword: 'additionalProperties', message: '不允许的额外字段' });
        }
      }
    }
  }
}

/**
 * 校验数据。
 * @param {Object|string} schema schema 对象或注册表 id
 * @param {*} data
 * @returns {{valid: boolean, errors: Array<{path: string, keyword: string, message: string}>}}
 */
function validate(schema, data) {
  if (REGISTRY.size === 0) loadRegistry();
  const target = typeof schema === 'string' ? resolveRef(schema, schema) : schema;
  if (!target) {
    return { valid: false, errors: [{ path: '', keyword: '$ref', message: `未知 schema: ${schema}` }] };
  }
  const errors = [];
  check(data, target, '#', errors, target);
  return { valid: errors.length === 0, errors };
}

/**
 * 校验失败则抛 E_SCHEMA_MISMATCH。
 * @param {Object|string} schema
 * @param {*} data
 * @param {{what?: string}} [opts]
 * @returns {{valid: true, errors: []}}
 */
function validateOrThrow(schema, data, opts = {}) {
  const res = validate(schema, data);
  if (!res.valid) {
    throw new AedError('E_SCHEMA_MISMATCH', `${opts.what || '对象'} schema 校验失败`, {
      errors: res.errors.slice(0, 10),
      total: res.errors.length
    });
  }
  return res;
}

/**
 * 断言 schema 版本标识（major 不匹配直接拒收）。
 * @param {*} data
 * @param {string} expected 形如 'aed/experience/1.0'
 * @returns {void}
 */
function assertSchemaConst(data, expected) {
  const actual = data && data.schema;
  if (actual !== expected) {
    const majorOf = (s) => String(s || '').split('/')[2];
    throw new AedError('E_SCHEMA_MISMATCH', `schema 版本不匹配：期望 ${expected}，实际 ${actual}`, {
      expected,
      actual,
      majorMismatch: majorOf(actual) !== majorOf(expected)
    });
  }
}

loadRegistry();

module.exports = {
  validate,
  validateOrThrow,
  assertSchemaConst,
  register,
  loadRegistry,
  REGISTRY
};

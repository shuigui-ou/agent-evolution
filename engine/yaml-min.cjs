/**
 * @module yaml-min
 * @owner Kou（工程师，共享 engine K8）
 *
 * 极简 YAML 子集解析器（零第三方依赖，仅 Node 内置）。
 * 支持 evolution.yaml v1 契约所需子集：
 *   - 顶层/嵌套 block mapping（key: value）
 *   - block sequence（- item；含 list-of-maps：`- key: value` + 缩进续行）
 *   - flow sequence（[a, b, c]）与 flow mapping（{k: v}）
 *   - 标量：双引号/单引号字符串、布尔、数字、null、纯文本
 *   - 注释（# 至行尾，引号内不剥离）
 *   - 兼容 JSON 输入（首字符 {/[ 时直接 JSON.parse）
 *
 * 刻意不实现：锚点/别名、多行字符串块 | >、tag、制表符缩进、复杂转义。
 * 解析失败抛 EngineError 风格错误（code=YAML_PARSE_ERROR）。
 */
'use strict';

const { EngineError } = require('./errors.cjs');

// ---------------------------------------------------------------------------
// 预处理：切行、剥注释、记录缩进（空格；制表符拒绝）
// ---------------------------------------------------------------------------

/** 剥掉行内注释（引号外 # 起始），返回清理后文本 */
function stripComment(text) {
  let out = '';
  let quote = null; // null | "'" | '"'
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      out += ch;
      if (ch === quote) {
        // 单引号内 '' 是转义引号（不闭合）；双引号内 \" 已在上轮作为普通字符吞掉，此处不处理反斜杠细节
        if (quote === "'" && text[i + 1] === "'") {
          out += text[i + 1];
          i += 1;
        } else {
          quote = null;
        }
      } else if (ch === '\\' && quote === '"' && i + 1 < text.length) {
        out += text[i + 1];
        i += 1;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === '#') {
      // 行内注释需前面是空白或行首
      if (i === 0 || /\s/.test(text[i - 1])) break;
    }
    out += ch;
  }
  return out.trimEnd();
}

/** 预处理：返回 [{ indent, text }]（去除空行与纯注释行） */
function preprocess(source) {
  const rawLines = String(source || '').split(/\r?\n/);
  const lines = [];
  for (let raw of rawLines) {
    if (/\t/.test(raw)) {
      throw new EngineError('YAML_PARSE_ERROR', '不支持制表符缩进（请用空格）');
    }
    const indentMatch = /^ */.exec(raw);
    const indent = indentMatch ? indentMatch[0].length : 0;
    const text = stripComment(raw).trimEnd();
    if (!text.trim()) continue;
    lines.push({ indent, text: text.trim() });
  }
  return lines;
}

// ---------------------------------------------------------------------------
// 标量解析
// ---------------------------------------------------------------------------

/** 解析带引号字符串（返回 {value, rest}），rest 为右引号后的剩余内容 */
function parseQuoted(text, quote) {
  let value = '';
  let i = 1; // 跳过起始引号
  while (i < text.length) {
    const ch = text[i];
    if (quote === "'") {
      if (ch === "'") {
        if (text[i + 1] === "'") {
          value += "'";
          i += 2;
          continue;
        }
        return { value, rest: text.slice(i + 1) };
      }
      value += ch;
      i += 1;
      continue;
    }
    // double quote
    if (ch === '\\' && i + 1 < text.length) {
      const n = text[i + 1];
      const map = { n: '\n', t: '\t', r: '\r', '\\': '\\', '"': '"', "'": "'", '0': '\0' };
      value += Object.prototype.hasOwnProperty.call(map, n) ? map[n] : n;
      i += 2;
      continue;
    }
    if (ch === '"') return { value, rest: text.slice(i + 1) };
    value += ch;
    i += 1;
  }
  throw new EngineError('YAML_PARSE_ERROR', '引号字符串未闭合: ' + text);
}

/** 切 flow sequence [a, b] / flow mapping {k: v}；按逗号切分（引号内不切） */
function splitFlow(text) {
  const parts = [];
  let depth = 0;
  let cur = '';
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      cur += ch;
      if (quote === "'" && ch === "'" && text[i + 1] === "'") { cur += text[i + 1]; i += 1; }
      else if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"' && i + 1 < text.length) { cur += text[i + 1]; i += 1; }
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === '[' || ch === '{') depth += 1;
    if (ch === ']' || ch === '}') depth -= 1;
    if (ch === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

/** flow mapping {k: v, k2: v2} 解析为 JS 对象 */
function parseFlowMap(inner) {
  const obj = {};
  for (const part of splitFlow(inner)) {
    const sep = findMappingSep(part);
    if (sep < 0) throw new EngineError('YAML_PARSE_ERROR', 'flow mapping 缺少冒号: ' + part);
    const key = parseScalar(part.slice(0, sep).trim()).value;
    obj[key] = parseScalar(part.slice(sep + 1).trim());
  }
  return obj;
}

/**
 * 解析内联标量（非 block 值）：引号串 / 数字 / bool / null / flow 集合 / 纯文本
 * @returns {{type:'scalar'|'flow_seq'|'flow_map', value:*}}
 */
function parseScalar(raw) {
  const text = String(raw).trim();
  if (!text) return { type: 'scalar', value: null };
  if (text[0] === '"' || text[0] === "'") {
    const { value, rest } = parseQuoted(text, text[0]);
    if (rest.trim()) throw new EngineError('YAML_PARSE_ERROR', '引号后有多余内容: ' + rest);
    return { type: 'scalar', value };
  }
  if (text === 'null' || text === '~' || text === 'Null' || text === 'NULL') {
    return { type: 'scalar', value: null };
  }
  if (text === 'true' || text === 'True' || text === 'TRUE') return { type: 'scalar', value: true };
  if (text === 'false' || text === 'False' || text === 'FALSE') return { type: 'scalar', value: false };
  if (/^-?(0|[1-9]\d*)(\.\d+)?$/.test(text)) return { type: 'scalar', value: Number(text) };
  if (text[0] === '[' && text.endsWith(']')) {
    const inner = text.slice(1, -1).trim();
    const arr = [];
    if (inner) for (const part of splitFlow(inner)) arr.push(parseScalar(part).value);
    return { type: 'flow_seq', value: arr };
  }
  if (text[0] === '{' && text.endsWith('}')) {
    const inner = text.slice(1, -1).trim();
    return { type: 'flow_map', value: inner ? parseFlowMap(inner) : {} };
  }
  return { type: 'scalar', value: text };
}

// ---------------------------------------------------------------------------
// Block 结构解析（递归下降）
// ---------------------------------------------------------------------------

/** 是否为 mapping 行（不含列表标记） */
function isMappingLine(text) {
  if (text === '-' || text.startsWith('- ')) return false;
  return findMappingSep(text) >= 0;
}

/** 找 key: value 的分隔冒号位置（引号外、不在 flow 内） */
function findMappingSep(text) {
  let quote = null;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (quote === "'" && ch === "'" && text[i + 1] === "'") { i += 1; continue; }
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"' && i + 1 < text.length) i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '[' || ch === '{') depth += 1;
    else if (ch === ']' || ch === '}') depth -= 1;
    else if (ch === ':' && depth === 0) return i;
  }
  return -1;
}

/** 解析主文档 */
function parse(source) {
  if (typeof source === 'object' && source !== null) return source; // 已是对象
  const text = String(source || '').trim();
  if (!text) return {};
  // JSON 兼容：首字符为 { 或 [ 时直接 JSON.parse
  if (text[0] === '{' || text[0] === '[') {
    try {
      return JSON.parse(text);
    } catch (e) {
      throw new EngineError('YAML_PARSE_ERROR', 'JSON 解析失败: ' + e.message);
    }
  }
  const lines = preprocess(text);
  if (!lines.length) return {};
  let pos = 0;

  /** 当前行 */
  function cur() { return lines[pos]; }

  function parseNode(indent) {
    if (!cur() || cur().indent !== indent) return null;
    const t = cur().text;
    if (t === '-' || t.startsWith('- ')) return parseSequence(indent);
    if (isMappingLine(t)) return parseMapping(indent);
    // 裸标量（少见，顶层非 map）
    return parseScalar(t).value;
  }

  function parseMapping(indent) {
    const obj = {};
    while (cur() && cur().indent === indent && isMappingLine(cur().text)) {
      const sep = findMappingSep(cur().text);
      const keyRaw = cur().text.slice(0, sep).trim();
      let key = parseScalar(keyRaw).value;
      if (key == null) key = keyRaw;
      const rest = cur().text.slice(sep + 1).trim();
      pos += 1;
      if (rest === '') {
        // 值在更深缩进的 block 里，或为 null
        if (cur() && cur().indent > indent) obj[key] = parseNode(cur().indent);
        else obj[key] = null;
      } else {
        obj[key] = parseScalar(rest).value;
      }
    }
    return obj;
  }

  /** 解析 list-of-maps 的续行 key（在 dash 行之后的更深缩进 mapping 行） */
  function parseMapContinuation(obj, keyIndent) {
    while (cur() && cur().indent === keyIndent && isMappingLine(cur().text)) {
      const sep = findMappingSep(cur().text);
      const k = cur().text.slice(0, sep).trim();
      const rest = cur().text.slice(sep + 1).trim();
      pos += 1;
      if (rest === '') {
        if (cur() && cur().indent > keyIndent) obj[k] = parseNode(cur().indent);
        else obj[k] = null;
      } else {
        obj[k] = parseScalar(rest).value;
      }
    }
  }

  function parseSequence(indent) {
    const arr = [];
    while (cur() && cur().indent === indent && (cur().text === '-' || cur().text.startsWith('- '))) {
      const rest = cur().text === '-' ? '' : cur().text.slice(2).trim();
      pos += 1;
      if (rest === '') {
        if (cur() && cur().indent > indent) arr.push(parseNode(cur().indent));
        else arr.push(null);
        continue;
      }
      // dash 行内联 map：- key: value，续行 key 缩进 = indent + 2（'- ' 占 2 列）
      if (findMappingSep(rest) >= 0) {
        const sep = findMappingSep(rest);
        const k = rest.slice(0, sep).trim();
        const vRest = rest.slice(sep + 1).trim();
        const item = {};
        if (vRest === '') {
          if (cur() && cur().indent > indent + 2) item[k] = parseNode(cur().indent);
          else item[k] = null;
        } else {
          item[k] = parseScalar(vRest).value;
        }
        parseMapContinuation(item, indent + 2);
        arr.push(item);
        continue;
      }
      arr.push(parseScalar(rest).value);
    }
    return arr;
  }

  const doc = parseNode(lines[0].indent);
  return doc;
}

/** 便捷：解析字符串/文件读取由调用方负责 */
function parseText(text) {
  return parse(text);
}

module.exports = { parse, parseText, stripComment, parseScalar };

/**
 * @module security/injection-guard
 * @layer security
 * @owner kou
 * Prompt Injection 检测与净化（结构约束之外的内容侧防线）。
 */

'use strict';

/** 检测规则表：id / 正则 / 说明 */
const RULES = [
  {
    id: 'IGNORE_PREVIOUS',
    re: /ignore\s+(all\s+)?(previous|prior|above)\s+(instructions|prompts|rules)|disregard\s+(all\s+)?(previous|prior)|忽略(以上|上面|之前|前面)(的)?(指令|提示|说明|规则)/i,
    desc: '忽略上文类指令'
  },
  {
    id: 'ROLE_HIJACK',
    re: /(^|\n)\s*(system|developer)\s*:\s*|<\|im_start\|>|<\|im_end\|>|<\/?\|?(system|assistant|user)\|?>/i,
    desc: '角色劫持标记'
  },
  {
    id: 'DATA_EXFIL',
    re: /把\s*(token|密钥|密码|凭据)\s*(发|传|提交)到|send\s+(the\s+)?(token|key|secret|password)\s+to|curl[^\n]*\|\s*(ba)?sh\b|wget[^\n]*\|\s*(ba)?sh\b|base64\s+-d/i,
    desc: '数据外泄 / 远程执行'
  },
  {
    id: 'HIDDEN_CHARS',
    re: /[​-‏‪-‮⁠-⁤﻿]/,
    desc: '零宽或 RTL 隐藏字符'
  },
  {
    id: 'BASE64_LONG',
    re: /[A-Za-z0-9+/]{120,}={0,2}/,
    desc: '超长 base64 混淆'
  },
  {
    id: 'HIGH_PRIV',
    re: /rm\s+-rf|del\s+\/f\b|format\s+[a-z]:|\bid_rsa\b|\.aws[\\/]credentials|\benv\b\s*文件|sudo\s+|\bchmod\s+777\b/i,
    desc: '高权限危险词'
  }
];

/** 文本长度硬上限 */
const MAX_TEXT = 2000;

/**
 * 检测一段文本是否命中注入规则。
 * @param {string} text
 * @returns {{hit: boolean, rules: string[], score: number, details: Array<{id: string, desc: string}>}}
 */
function detect(text) {
  const s = String(text == null ? '' : text);
  const hits = [];
  for (const rule of RULES) {
    if (rule.re.test(s)) hits.push({ id: rule.id, desc: rule.desc });
  }
  if (s.length > MAX_TEXT) hits.push({ id: 'TOO_LONG', desc: `文本超长（${s.length} > ${MAX_TEXT}）` });
  return {
    hit: hits.length > 0,
    rules: hits.map((h) => h.id),
    score: hits.length,
    details: hits
  };
}

/**
 * 扫描对象中的若干文本字段。
 * @param {Object} obj
 * @param {string[]} fields
 * @returns {{hit: boolean, rules: string[], fieldHits: Array<{field: string, rules: string[]}>}}
 */
function scanFields(obj, fields) {
  const fieldHits = [];
  const allRules = new Set();
  for (const f of fields) {
    const v = obj && obj[f];
    if (typeof v === 'string') {
      const r = detect(v);
      if (r.hit) {
        fieldHits.push({ field: f, rules: r.rules });
        r.rules.forEach((x) => allRules.add(x));
      }
    }
  }
  return { hit: fieldHits.length > 0, rules: Array.from(allRules), fieldHits };
}

/**
 * 递归扫描对象内所有字符串（用于外部信号整体体检）。
 * @param {*} node
 * @param {string} [path]
 * @returns {Array<{path: string, rules: string[]}>}
 */
function scanDeep(node, path = '$') {
  const out = [];
  if (typeof node === 'string') {
    const r = detect(node);
    if (r.hit) out.push({ path, rules: r.rules });
    return out;
  }
  if (Array.isArray(node)) {
    node.forEach((v, i) => out.push(...scanDeep(v, `${path}[${i}]`)));
    return out;
  }
  if (node && typeof node === 'object') {
    for (const k of Object.keys(node)) out.push(...scanDeep(node[k], `${path}.${k}`));
  }
  return out;
}

/**
 * 注入 agent 上下文前的净化：去隐藏字符、折叠空行、加边界包裹、截断。
 * @param {string} text
 * @param {{maxLength?: number, wrap?: boolean}} [opts]
 * @returns {string}
 */
function sanitizeForPrompt(text, opts = {}) {
  const maxLength = opts.maxLength || MAX_TEXT;
  let s = String(text == null ? '' : text);
  // 1) 去掉零宽与双向控制字符
  s = s.replace(/[​-‏‪-‮⁠-⁤﻿]/g, '');
  // 2) 去掉 ANSI 转义序列
  s = s.replace(/\[[0-9;]*[A-Za-z]/g, '');
  // 3) 折叠连续空行
  s = s.replace(/\n{3,}/g, '\n\n');
  // 4) 截断
  if (s.length > maxLength) s = `${s.slice(0, maxLength)}…`;
  if (opts.wrap === false) return s;
  return `<<AED_EXPERIENCE>>\n${s}\n<<END_AED_EXPERIENCE>>`;
}

module.exports = { RULES, MAX_TEXT, detect, scanFields, scanDeep, sanitizeForPrompt };

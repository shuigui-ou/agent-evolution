/**
 * @module injection-guard
 * @layer L0 安全层（注入检测 + 消毒）
 * @owner Kou（工程师，K1）
 *
 * 规范 §4 注入防护：外部经验入库前过注入检测，
 * 覆盖："忽略上文" / 角色劫持 / 数据外泄 / 隐藏字符 / 高危词 / 超长。
 * 命中即拒（由调用方拒收并给贡献者扣分），本文本模块只负责检测与消毒。
 */
'use strict';

/** 检测规则集（每条 {rule, re}） */
const RULES = Object.freeze([
  {
    rule: 'ignore_context',
    // "忽略/无视之前(所有/全部/上文/以上)的指令/提示/内容/上下文/规则"，含英文变体
    re: /(忽略|无视)\s*((之前|上文|以上|前面|全部|先前|所有)(的|所有|全部)?\s*)*(指令|提示|内容|上下文|规则)|(disregard|ignore)\s+(all\s+)?(previous|above|prior)\s+(instructions?|prompts?|rules?)/i,
  },
  {
    rule: 'role_hijack',
    // 角色劫持：改写 agent 身份 / 伪装 system 消息
    re: /(你现在是|你扮演|新角色|你不是(一个)?(助手|AI)|(you are now|act as|pretend to be))|(^\s*(system|assistant|developer)\s*[:：])/im,
  },
  {
    rule: 'data_exfiltration',
    // 数据外泄：动词 + 外部目标，或裸 URL
    re: /(发送|上传|上报|回传|外传|泄露|post|send|upload|curl|wget|fetch)[^。\n]{0,30}(http|外部|远程|服务器|server|url)|(https?:\/\/\S+)/i,
  },
  {
    rule: 'hidden_chars',
    // 隐藏字符：零宽空格/连接符、双向控制符、BOM、不可见分隔符
    re: /[\u200B-\u200F\u202A-\u202E\u2060\u2061-\u2064\uFEFF]/,
  },
  {
    rule: 'high_risk_words',
    // 高危命令词：递归删除 / 磁盘格式化 / 关机 / 注册表删除 / 宽权限
    re: /(rm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)|del\s+\/[fsq]|rd\s+\/s|format\s+[a-zA-Z]:|mkfs|shutdown\s+(-[a-z]|\/[a-z])|reg\s+delete|chmod\s+777|sudo\s+rm)/i,
  },
]);

/** 默认超长阈值（字符数） */
const DEFAULT_MAX_LEN = 8000;

/**
 * 注入检测
 * @param {string} text - 待检文本
 * @param {object} [opts] { maxLen=8000 }
 * @returns {{safe: boolean, hits: {rule: string, matched: string}[], length: number}}
 */
function detectInjection(text, { maxLen = DEFAULT_MAX_LEN } = {}) {
  const s = String(text || '');
  const hits = [];
  for (const r of RULES) {
    const m = s.match(r.re);
    if (m) hits.push({ rule: r.rule, matched: m[0] });
  }
  if (s.length > maxLen) {
    hits.push({ rule: 'overlong', matched: `length=${s.length}>${maxLen}` });
  }
  return { safe: hits.length === 0, hits, length: s.length };
}

/**
 * 消毒：把可疑文本清洗净化后仍可用于提示词（不保证通过 detectInjection，调用方仍应先检测）
 * - 去隐藏字符
 * - 去控制字符（保留换行/制表）
 * - 折叠连续空白
 * - 超长截断并标注
 * @param {string} text
 * @param {object} [opts] { maxLen=4000 }
 * @returns {string}
 */
function sanitizeForPrompt(text, { maxLen = 4000 } = {}) {
  let s = String(text || '');
  // 去隐藏字符
  s = s.replace(/[\u200B-\u200F\u202A-\u202E\u2060\u2061-\u2064\uFEFF]/g, '');
  // 去控制字符（保留 \n \t）
  s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  // 折叠空白（保留换行结构：先按行折叠行内空白）
  s = s
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
  if (s.length > maxLen) {
    s = s.slice(0, maxLen) + '\n[已截断]';
  }
  return s;
}

module.exports = { detectInjection, sanitizeForPrompt, RULES, DEFAULT_MAX_LEN };

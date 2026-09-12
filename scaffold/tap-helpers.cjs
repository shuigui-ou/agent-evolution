'use strict';
/**
 * @module tap-helpers
 * @layer 宿主接入层（turnkey 脚手架）
 *
 * 可复用的「高频失败点」tap 助手。宿主不必自己解析错误形状——
 * 直接把 catch 到的 err 或命令结果丢进来，助手负责归一成 engine 能识别的信号。
 *
 * 覆盖四类宿主最常见、且最该被进化内核记住的错误：
 *   - 端口/网络（EADDRINUSE / ETIMEDOUT / 502）
 *   - 打包/构建（PowerShell 多行粘贴 >> 解析、PyInstaller 依赖锁）
 *   - 跨 shell 调用（Git Bash→PowerShell 被安全策略拦截）
 *   - 版本控制/路径（Git Bash /c/ 路径传 Python 报 FileNotFoundError）
 */

/**
 * 把一个错误归一为 { title, detail, category }。
 * category 用于宿主侧分流/统计；engine 内部仍按 fingerprint 归类。
 * @param {Error|string|object} err
 * @returns {{title:string, detail:string, category:string}}
 */
function normalizeError(err) {
  const e = err || {};
  const message = String(e.message || e.code || (typeof err === 'string' ? err : 'unknown error')).slice(0, 400);
  const detail = String(e.stack || (typeof err === 'string' ? err : JSON.stringify(err))).slice(0, 3000);
  return { title: message, detail, category: categorize(message + ' ' + detail) };
}

/** 按错误文本推断类别（git / 网络 / 打包 / 权限 / 其他） */
function categorize(text) {
  const t = String(text || '').toLowerCase();
  if (/eaddrinuse|port .* already|address already in use|emfile|too many open files/.test(t)) return 'network_port';
  if (/etimedout|econnrefused|fetch failed|bad gateway|502|503|tunnel|connect econn/.test(t)) return 'network_transport';
  if (/powershell|\.ps1|>>|redirect|stdin|here-string|clipboard/.test(t)) return 'packaging_shell';
  if (/git bash|\/c\/|filereference|filenotfounderror|module not found|can't find module|no such file/.test(t)) return 'vcs_path';
  if (/permission|eacces|access is denied|拒绝访问|operation not permitted/.test(t)) return 'permission';
  if (/pyinstaller|pip install|dependency|lock|missing module|\.spec\b|spec file|pyinstaller spec/.test(t)) return 'packaging_python';
  if (/cross.shell|跨shell|安全策略|sec.*policy|blocked by/.test(t)) return 'cross_shell';
  return 'other';
}

/**
 * 命令/工具结果归一（约定失败形状）：
 *   { ok:false, error } | { exitCode:非0 } | { code:非0 } | { stderr 非空 }
 * @param {object} res
 * @returns {{failed:boolean, title:string, detail:string, category:string}}
 */
function normalizeToolResult(res) {
  const r = res || {};
  const failed =
    r.ok === false ||
    (typeof r.exitCode === 'number' && r.exitCode !== 0) ||
    (typeof r.code === 'number' && r.code !== 0) ||
    (typeof r.stderr === 'string' && r.stderr.trim().length > 0 && r.ok === undefined);
  const text = String(r.error || r.stderr || r.message || (failed ? 'tool_result_failure' : '')).slice(0, 400);
  return { failed, title: text, detail: String(JSON.stringify(r)).slice(0, 3000), category: categorize(text) };
}

/** 类别 → 宿主展示用中文标签 */
const CATEGORY_LABELS = {
  network_port: '端口/网络占用',
  network_transport: '网络/网关不通',
  packaging_shell: '打包/Shell 解析',
  vcs_path: '版本控制/路径',
  permission: '权限',
  packaging_python: 'Python 打包',
  cross_shell: '跨 Shell 调用',
  other: '其他',
};

function categoryLabel(cat) {
  return CATEGORY_LABELS[cat] || CATEGORY_LABELS.other;
}

module.exports = {
  normalizeError,
  normalizeToolResult,
  categorize,
  categoryLabel,
  CATEGORY_LABELS,
};

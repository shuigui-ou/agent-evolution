/**
 * 测试共享工具：临时目录创建与清理（测试只写 os.tmpdir()，严禁写真实 agent 目录）
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** 在系统临时目录下创建本用例专属目录 */
function makeTmpDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `evok-${tag}-`));
}

/** 递归清理临时目录（after 钩子中调用） */
function rmTmpDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

module.exports = { makeTmpDir, rmTmpDir };

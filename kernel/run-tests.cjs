/**
 * 临时测试运行器：绕开宿主 shell stdout 丢失问题，
 * 用 spawnSync 同步执行 node --test 并把 TAP 输出落盘到 full-run.log。
 */
'use strict';
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const here = __dirname;
const testDir = path.join(here, 'test');
const files = fs
  .readdirSync(testDir)
  .filter((f) => f.endsWith('.test.cjs'))
  .map((f) => path.join(testDir, f));

// 额外参数（如 QA 对抗套件路径）从命令行透传
const extra = process.argv.slice(2);
const allArgs = ['--test', ...files, ...extra];

const r = spawnSync(process.execPath, allArgs, { encoding: 'utf8', timeout: 120000 });
const out = (r.stdout || '') + '\n===== STDERR =====\n' + (r.stderr || '');
fs.writeFileSync(path.join(here, 'full-run.log'), out, 'utf8');
fs.writeFileSync(
  path.join(here, 'run-status.txt'),
  `status=${r.status} error=${r.error ? r.error.message : 'none'}\n`,
  'utf8'
);

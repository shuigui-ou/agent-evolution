#!/usr/bin/env node
/**
 * @module bin/evolution-eval
 * @layer cli
 * @owner Alex（软件工程师，K5/K6）
 *
 * K6 评估脚手架 CLI（回溯式口径，无前置基线窗）。
 * 用法：
 *   node bin/evolution-eval.cjs \
 *     --data-dir fixtures/eval \
 *     [--fix-events fixtures/eval/fix-events.jsonl] \
 *     [--out runtime/reports/evolution-eval.json] \
 *     [--text runtime/reports/evolution-eval.txt]
 * 输出：JSON 报告（默认 stdout）+ 人类可读摘要（--text 或 stdout）。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { assess } = require('../src/assessment/assess.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');

const USAGE = `evolution-eval（K6 回溯式评估脚手架）

用法:
  node bin/evolution-eval.cjs --data-dir <dir> [--fix-events <file>] [--out <json>] [--text <file>]

参数:
  --data-dir <dir>      内核数据目录（默认 fixtures/eval；含 ledger/signals/audit/probe 子目录）
  --fix-events <file>   可选修复事件表 JSONL
  --out <file>          可选：把 JSON 报告写到文件（默认 stdout 打 JSON）
  --text <file>         可选：把人类可读摘要写到文件
  --no-json             out 缺省时只打人类可读摘要（默认同时打 JSON）
`;

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const cur = argv[i];
    if (cur.startsWith('--')) {
      const body = cur.slice(2);
      const eq = body.indexOf('=');
      if (eq >= 0) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        flags[body] = argv[i + 1];
        i += 1;
      } else {
        flags[body] = true;
      }
    } else {
      positional.push(cur);
    }
  }
  return { flags, positional };
}

function main() {
  const { flags } = parseArgs(process.argv.slice(2));
  if (flags.help || flags.h) {
    process.stdout.write(USAGE);
    return 0;
  }
  const dataDir = path.resolve(String(flags['data-dir'] || 'fixtures/eval'));
  const fixEventsPath = flags['fix-events'] ? path.resolve(String(flags['fix-events'])) : null;
  if (!fs.existsSync(dataDir)) {
    throw new Error(`数据目录不存在: ${dataDir}`);
  }

  const report = assess({ dataDir, fixEventsPath });

  const outFile = flags.out ? path.resolve(String(flags.out)) : null;
  const textFile = flags.text ? path.resolve(String(flags.text)) : null;

  if (outFile) {
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, JSON.stringify(report, null, 2) + '\n', 'utf8');
    process.stdout.write(`JSON 报告已写入: ${outFile}\n`);
  }
  if (textFile) {
    fs.mkdirSync(path.dirname(textFile), { recursive: true });
    fs.writeFileSync(textFile, report.summary + '\n', 'utf8');
    process.stdout.write(`人类可读摘要已写入: ${textFile}\n`);
  }
  if (!outFile && !flags['no-json']) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else if (!outFile) {
    process.stdout.write(`${report.summary}\n`);
  }
  if (outFile || textFile) {
    process.stdout.write('\n' + report.summary + '\n');
  }
  return 0;
}

try {
  const code = main();
  if (code) process.exitCode = code;
} catch (e) {
  process.stderr.write(`${(e && e.message) || String(e)}\n`);
  process.exitCode = 1;
}

#!/usr/bin/env node
/**
 * @module bin/aed
 * @layer cli
 * @owner kou
 * AED CLI 入口：aed <group> <sub> [flags]
 *   group: agent | run | inbox | evolve
 */

'use strict';

const path = require('node:path');

const GROUPS = ['agent', 'run', 'inbox', 'evolve'];

const USAGE = `AED (Agent Evolution Daemon) — 零第三方依赖

用法:
  aed agent register --name <agent> --skill-root <dir> [--traces <file>] [--watch <glob>] [--agent-version <v>]
  aed agent list | enable <name> | disable <name> | unregister <name>
  aed run once [--json]                一次完整闭环：采集 -> 蒸馏 -> 归因 -> 门禁 -> 发布
  aed run start | stop | status
  aed inbox list [--status new] | show --signal <id> | import --file <jsonl>
  aed inbox triage|accept|reject --signal <id> [--reason-code CODE] [--reason-text TEXT]
  aed inbox notify --digest
  aed evolve list [--state draft] | show|gate|release|rollback --proposal <id>
  aed evolve auto-rollback --proposal <id> [--regression-failures N] [--false-trigger-rate R]

通用参数:
  --json            以 JSON 输出结果
  --root <dir>      指定项目根（默认 cwd）
`;

/**
 * 简易参数解析（自研，零依赖）。
 * @param {string[]} argv
 * @returns {{flags: Object, positional: string[]}}
 */
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

/**
 * 输出。
 * @param {*} out
 * @param {boolean} asJson
 * @returns {void}
 */
function print(out, asJson) {
  if (out && typeof out === 'object' && typeof out.__text === 'string' && !asJson) {
    process.stdout.write(`${out.__text}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
}

/**
 * @returns {Promise<number>} 退出码
 */
async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === 'help' || argv[0] === '--help' || argv[0] === '-h') {
    process.stdout.write(USAGE);
    return 0;
  }
  const [group, sub, ...rest] = argv;
  if (!GROUPS.includes(group)) {
    process.stderr.write(`未知命令组：${group}\n\n${USAGE}`);
    return 2;
  }
  const { flags, positional } = parseArgs(rest);
  if (flags.root) process.env.AED_ROOT = path.resolve(String(flags.root));

  const mod = require(path.join(__dirname, '..', 'src', 'cli', `cmd-${group}.cjs`));
  const out = await mod.run({ sub: sub || 'help', flags, positional });
  print(out, !!flags.json);
  return 0;
}

main().catch((e) => {
  const payload = e && e.toJSON ? e.toJSON() : { code: 'E_IO_FAIL', message: (e && e.message) || String(e) };
  process.stderr.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exitCode = 1;
});

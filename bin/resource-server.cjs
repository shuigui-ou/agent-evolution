#!/usr/bin/env node
/**
 * @module bin/resource-server
 * @layer cli
 * @owner Alex（软件工程师，K5）
 *
 * AED 资源服务 CLI（K5 形态：仓库内模块 + HTTP 进程 + CLI）
 * 用法：
 *   node bin/resource-server.cjs serve --port 7879           启动 HTTP 四接口服务（默认命令）
 *   node bin/resource-server.cjs status                       打印资源服务状态
 *   node bin/resource-server.cjs seed --reset                 从种子强制重建解法索引
 *   node bin/resource-server.cjs verify --id <exp|sol id>     对条目做独立复验
 *   node bin/resource-server.cjs exp-add --agent x --contributor y --content z ...
 *   node bin/resource-server.cjs exp-list [--agent x]
 *
 * 通用参数：--root <repo>（默认本仓库根） --store-dir <dir> --seeds-dir <dir> --json
 */
'use strict';

const path = require('node:path');
const { createResourceService } = require('../src/resources/service.cjs');
const { createResourceServer } = require('../src/resources/http-server.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');

const USAGE = `AED 资源服务（Evolution Kernel §5，外挂只读/受控四接口）

用法:
  resource-server serve   --port 7879 [--host 127.0.0.1]   启动 HTTP 服务（默认）
  resource-server status                                    打印资源服务状态
  resource-server seed    [--reset]                         种子入池 / 强制重建
  resource-server verify  --id <experience_id>              独立复验（cross-validated credit）
  resource-server exp-add --agent <a> --contributor <c> --content <正文> [--title ..]
  resource-server exp-list [--agent <a>]

通用参数:
  --root <dir>      仓库根（默认 = 本仓库根）
  --store-dir <dir> 资源数据目录（默认 <root>/runtime/resources）
  --seeds-dir <dir> 种子目录（默认 <root>/fixtures/solution-seeds）
  --json            以 JSON 输出
`;

/** 简易参数解析（自研，零依赖） */
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

function buildService(flags) {
  return createResourceService({
    root: flags.root ? path.resolve(String(flags.root)) : REPO_ROOT,
    storeDir: flags['store-dir'] ? String(flags['store-dir']) : null,
    seedsDir: flags['seeds-dir'] ? String(flags['seeds-dir']) : null,
  });
}

function printJson(obj) {
  process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
}

async function main() {
  const argv = process.argv.slice(2);
  const { flags, positional } = parseArgs(argv);
  const cmd = positional[0] || 'serve';
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    process.stdout.write(USAGE);
    return 0;
  }

  const service = buildService(flags);
  service.init({ resetSeeds: Boolean(flags.reset || flags['reset-seeds']) });

  if (cmd === 'serve') {
    const port = Number(flags.port || 7879);
    const host = String(flags.host || '127.0.0.1');
    const srv = createResourceServer({ service, host, port });
    const { port: actualPort } = await srv.listen();
    const base = `http://${host}:${actualPort}`;
    const msg = {
      ok: true,
      message: 'AED 资源服务已启动（§5 四接口）',
      endpoints: {
        experiences: `${base}/resources/experiences?fingerprint=&agent=`,
        solutions: `${base}/resources/solutions?fingerprint=`,
        analyze: `${base}/jobs/analyze  (POST {traces_ref})`,
        verify: `${base}/verify  (POST {experience_id})`,
        healthz: `${base}/healthz`,
      },
      llm_enabled: false,
      data_dir: service.paths.dir,
      pool: service.solutionStats().pool_size,
    };
    if (flags.json) printJson(msg);
    else process.stdout.write(`${msg.message}: ${base}\n数据目录: ${msg.data_dir}\n解法池种子: ${msg.pool} 条\n按 Ctrl+C 退出。\n`);
    // 保持进程存活，直到信号
    await new Promise((resolve) => {
      const stop = async () => {
        await srv.close().catch(() => {});
        resolve();
      };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    });
    return 0;
  }

  if (cmd === 'status') {
    printJson(service.status());
    return 0;
  }

  if (cmd === 'seed') {
    const seeded = service.subsystems.solutions.seedIfEmpty({ force: Boolean(flags.reset) });
    printJson({ ok: true, ...seeded, stats: service.solutionStats() });
    return 0;
  }

  if (cmd === 'verify') {
    if (!flags.id) {
      throw new Error('verify 需要 --id <experience_id>');
    }
    printJson(service.verifyExperience({ experience_id: String(flags.id) }));
    return 0;
  }

  if (cmd === 'exp-add') {
    if (!flags.content) {
      throw new Error('exp-add 需要 --content <正文>');
    }
    const out = service.addExperience({
      agent: String(flags.agent || 'unknown'),
      contributor: String(flags.contributor || flags.agent || 'anonymous'),
      content: String(flags.content),
      title: flags.title ? String(flags.title) : '',
      fingerprint: flags.fingerprint ? String(flags.fingerprint) : '',
      env: flags.env ? String(flags.env) : 'cli',
    });
    printJson(out);
    return 0;
  }

  if (cmd === 'exp-list') {
    printJson({ items: service.listExperiences({ agent: flags.agent ? String(flags.agent) : '', includeInactive: true }) });
    return 0;
  }

  process.stderr.write(`未知命令：${cmd}\n\n${USAGE}`);
  return 2;
}

main()
  .then((code) => {
    process.exitCode = code || 0;
  })
  .catch((e) => {
    process.stderr.write(`${(e && e.message) || String(e)}\n`);
    process.exitCode = 1;
  });

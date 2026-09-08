/**
 * @module test/run-once
 * @layer test
 * @owner kou
 * 回归测试：`aed run once` 必须能真正采集到轨迹。
 *
 * 背景 bug：cmd-run 的 once 分支只调用 daemon.tick()，而 tick 里的
 * collector.pollOnce() 依赖 adapter 的 emit 回调（由 collector.start() 注入）；
 * 未 start 时 adapter.poll 直接返回 0（见 adapter-file-tail 的 `if (!this.emit) return 0;`），
 * 导致 `aed run once` 采集恒为 0。本用例走真实 cmd-run once 分支，
 * 注册 jsonl adapter 指向 fixtures/software-verifier/traces.sample.jsonl，
 * 断言 summary.agents[0].ingested === 60，防止该缺陷回归。
 *
 * 全程跑在 os.tmpdir() 的独立临时目录，绝不影响真实 runtime。
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const fsx = require('../src/util/fsx.cjs');
const paths = require('../src/store/paths.cjs');
const configMod = require('../src/config.cjs');
const index = require('../src/index.cjs');

const PROJECT = process.cwd();
const AGENT = 'software-verifier';
const FIXTURE_TRACES = path.join(PROJECT, 'fixtures', 'software-verifier', 'traces.sample.jsonl');
const FIXTURE_SUITE = path.join(PROJECT, 'fixtures', 'suites', 'software-verifier.json');

test('run once：jsonl adapter 链路先 start 再 tick，采集 60 条', async () => {
  const TMP = fsx.mkTmpDir('aed-test-run-once-');
  try {
    // ---------- 1) 临时根 + aed.config.json（隔离真实 runtime） ----------
    // evidence.minSupportForProposal 调大：本用例只关心「采集」链路，
    // 不让蒸馏产生的提案进入四道门禁（避免沙箱子进程，测试更快更稳）。
    const cfg = JSON.parse(JSON.stringify(configMod.DEFAULTS));
    cfg.root = '.';
    cfg.gate.regressionSuite = FIXTURE_SUITE;
    cfg.evidence.minSupportForProposal = 9999;
    fsx.writeText(path.join(TMP, 'aed.config.json'), `${JSON.stringify(cfg, null, 2)}\n`);
    paths.setRoot(TMP);
    configMod.resetConfig();

    // ---------- 2) 注册沙箱 agent（真实 CLI 同款入口） ----------
    const cmdAgent = require('../src/cli/cmd-agent.cjs');
    const reg = cmdAgent.run({
      sub: 'register',
      flags: {
        name: AGENT,
        'skill-root': path.join(TMP, 'runtime', 'sandbox-skills', AGENT),
        traces: FIXTURE_TRACES,
        'agent-version': '1.2.5'
      },
      positional: []
    });
    assert.equal(reg.agent.adapters[0].kind, 'jsonl', '注册的 adapter 应为 jsonl');
    assert.ok(fsx.exists(path.join(TMP, 'runtime', 'sandbox-skills', AGENT, 'SKILL.md')), '沙箱 SKILL.md 应已生成');
    assert.equal(index.registeredAgents().length, 1, '运行期应注册 1 个 agent');

    // ---------- 3) 走真实 cmd-run once 分支 ----------
    const cmdRun = require('../src/cli/cmd-run.cjs');
    const out = await cmdRun.run({ sub: 'once', flags: {}, positional: [] });

    const summary = out.summary;
    assert.equal(summary.agents.length, 1, `应有 1 个 agent 汇总，实际 ${summary.agents.length}`);
    const a = summary.agents[0];
    assert.equal(a.ingested, 60, `once 应采集 60 条，实际 ${a.ingested}（bug 复现：采集恒为 0）`);
    assert.deepEqual(summary.errors, [], `once 不应报错，实际 ${JSON.stringify(summary.errors)}`);

    // ---------- 4) 落盘证据：runtime/traces 下确实有 60 行 ----------
    const dir = paths.tracesDir(AGENT);
    const files = fsx.listFiles(dir, /\.jsonl$/);
    const total = files.reduce((n, f) => n + fsx.readLines(f).length, 0);
    assert.equal(total, 60, `runtime/traces/<agent> 下应累计 60 行，实际 ${total}`);

    // ---------- 5) 输出文本包含「采集 60 条」 ----------
    assert.match(out.__text, /software-verifier: 采集 60 条/, `输出文本应含采集 60 条，实际：\n${out.__text}`);
  } finally {
    fsx.rimraf(TMP);
  }
});

test('run once 机制：collector.start() 接线后 pollOnce 才有效（start 前 poll 恒 0）', async () => {
  const TMP = fsx.mkTmpDir('aed-test-run-once-mech-');
  try {
    paths.setRoot(TMP);
    const { Collector } = require('../src/ingest/collector.cjs');
    // 直接驱动 Collector（cmd-run once 分支的等价物）：
    // adapters 显式传 { kind:'jsonl', glob: 绝对路径, agent }，与 agent register 产物一致。
    const collector = new Collector({
      agent: AGENT,
      agent_version: '1.2.5',
      adapters: [{ kind: 'jsonl', glob: FIXTURE_TRACES, agent: AGENT }]
    });

    // start 之前 emit 未接线，poll 必须为 0（复现 bug 根源）
    const before = await collector.pollOnce();
    assert.equal(before.written, 0, `start 前 pollOnce 应写 0 条（emit 未接线），实际 ${before.written}`);

    // start() 注入 emit 回调 -> pollOnce 才能把 fixture 的 60 行全部写入
    await collector.start();
    try {
      const r = await collector.pollOnce();
      assert.equal(r.written, 60, `start 后 pollOnce 应写 60 条，实际 ${r.written}`);
    } finally {
      await collector.stop();
    }

    // 落盘证据
    const files = fsx.listFiles(paths.tracesDir(AGENT), /\.jsonl$/);
    const total = files.reduce((n, f) => n + fsx.readLines(f).length, 0);
    assert.equal(total, 60, `runtime/traces/<agent> 下应累计 60 行，实际 ${total}`);
  } finally {
    fsx.rimraf(TMP);
  }
});

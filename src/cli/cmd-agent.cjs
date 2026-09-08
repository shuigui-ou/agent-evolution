/**
 * @module cli/cmd-agent
 * @layer cli
 * @owner kou
 * aed agent register / list / enable / disable / unregister
 */

'use strict';

const path = require('node:path');
const fsx = require('../util/fsx.cjs');
const paths = require('../store/paths.cjs');
const index = require('../index.cjs');
const configMod = require('../config.cjs');
const { AedError } = require('../util/errors.cjs');

/** 最小 SKILL.md 模板（仅在目标文件不存在时生成，用于沙箱演示） */
const SKILL_TEMPLATE = `---
name: {name}
description: AED 托管的最小 skill 骨架（沙箱副本）
version: 1.0.0
---

# {name}

> 本文件是 AED 的进化输出目标。AED 只通过受控 patch（append_section /
> replace_regex / upsert_frontmatter / add_file / deprecate）修改本文件，
> 每次修改前都会打快照，可一键回滚。

## 职责

1. 承接被观测 agent 的技能说明与守门规则；
2. 作为 AED 经验（Experience）落地为可执行知识的载体；
3. 保持结构稳定：章节标题是 patch 的锚点，请勿重命名。

## 工作流程

- 读取任务说明，明确验证目标与验收标准；
- 按步骤执行，每一步记录关键输出；
- 遇到失败时先归因（tool / planning / reasoning / knowledge / environment），
  再按下述已知坑章节选择处置动作；
- 输出结构化报告，包含结论、证据与改进建议。

## 已知坑 / Pitfalls

本段由 AED 自动维护，请勿手工编辑。每条坑包含：现象、归因、处置、验证。

### [seed] 首次接入基线

- **现象**：尚未积累任何经验条目。
- **归因**：baseline
- **处置**：先跑一轮 \`aed run once\` 采集基线，再开启自动进化。
- **验证**：\`node bin/aed.cjs run once\` → 期望产出 ≥1 条候选经验。

## 环境要求 / Environment

- 换行符统一 LF（git core.autocrlf=input）
- 文件编码统一 UTF-8
- 路径一律使用 path.join / path.resolve，禁止字符串拼接
- Node >= 22（使用 node:test 与 node:crypto ed25519）

## 变更约定

- 所有自动变更都会写入 \`runtime/skills/<agent>/<skill>/v<semver>/\` 快照；
- 回滚命令：\`node bin/aed.cjs evolve rollback --proposal <id>\`；
- 审计链：\`runtime/audit/YYYY-MM.jsonl\`（hash chain，可离线校验）。
`;

/**
 * 确保 skillRoot 与 SKILL.md 存在（不覆盖已有文件）。
 * @param {string} skillRoot
 * @param {string} name
 * @returns {{created: boolean, skillFile: string}}
 */
function ensureSkill(skillRoot, name) {
  fsx.ensureDir(skillRoot);
  const skillFile = path.join(skillRoot, 'SKILL.md');
  if (!fsx.exists(skillFile)) {
    fsx.writeText(skillFile, SKILL_TEMPLATE.replace(/\{name\}/g, name));
    return { created: true, skillFile };
  }
  return { created: false, skillFile };
}

/**
 * @param {{sub: string, flags: Object, positional: string[]}} args
 * @returns {Object}
 */
function run(args) {
  const { sub, flags } = args;
  const cfg = configMod.getConfig();
  paths.setRoot(cfg.root);

  if (sub === 'list') {
    const agents = index.allAgents(cfg).map((a) => ({
      name: a.name,
      enabled: a.enabled !== false,
      skillRoot: index.resolveSkillRoot(a),
      adapters: (a.adapters || []).map((x) => x.kind)
    }));
    return {
      __text: agents.length === 0
        ? '尚未注册任何 agent'
        : agents.map((a) => `${a.enabled ? '[on ]' : '[off]'} ${a.name}  skillRoot=${a.skillRoot}  adapters=${a.adapters.join(',') || '-'}`).join('\n'),
      agents
    };
  }

  if (sub === 'register') {
    const name = flags.name;
    if (!name) throw new AedError('E_ARG_INVALID', '缺少 --name');
    const skillRootRaw = flags['skill-root'] || flags.skillRoot;
    if (!skillRootRaw) throw new AedError('E_ARG_INVALID', '缺少 --skill-root');
    const skillRoot = path.isAbsolute(String(skillRootRaw))
      ? path.resolve(String(skillRootRaw))
      : path.resolve(paths.getRoot(), String(skillRootRaw));
    const adapters = [];
    if (flags.traces) {
      adapters.push({ kind: 'jsonl', glob: path.resolve(paths.getRoot(), String(flags.traces)), pollMs: 1000 });
    }
    if (flags.watch) {
      adapters.push({ kind: 'file-tail', glob: String(flags.watch), pollMs: 1000 });
    }
    if (adapters.length === 0) {
      // 默认：扫描 skillRoot 同级 runtime/logs/*.log
      adapters.push({ kind: 'file-tail', glob: path.join(skillRoot, 'runtime', 'logs', '*.log'), pollMs: 1000 });
    }
    const skill = ensureSkill(skillRoot, String(name));
    const agents = index.registeredAgents().filter((a) => a.name !== name);
    const agent = {
      name: String(name),
      enabled: true,
      version: flags['agent-version'] || '1.0.0',
      adapters,
      artifact: {
        format: flags['artifact-format'] || 'markdown-frontmatter',
        name: String(name),
        skillRoot,
        targets: ['SKILL.md']
      },
      registered_at: new Date().toISOString()
    };
    agents.push(agent);
    index.saveRegisteredAgents(agents);
    return {
      __text: `已注册 agent ${name}\n  skillRoot: ${skillRoot}\n  SKILL.md: ${skill.skillFile}${skill.created ? '（已生成模板）' : '（已存在）'}\n  adapters: ${adapters.map((a) => a.kind).join(',')}`,
      agent
    };
  }

  const name = flags.name || args.positional[0];
  if (sub === 'enable' || sub === 'disable') {
    if (!name) throw new AedError('E_ARG_INVALID', '缺少 --name');
    const agents = index.registeredAgents();
    const hit = agents.find((a) => a.name === name);
    if (hit) hit.enabled = sub === 'enable';
    index.saveRegisteredAgents(agents);
    return { name, enabled: sub === 'enable', persisted: !!hit };
  }

  if (sub === 'unregister') {
    if (!name) throw new AedError('E_ARG_INVALID', '缺少 --name');
    const agents = index.registeredAgents().filter((a) => a.name !== name);
    index.saveRegisteredAgents(agents);
    return { name, removed: true };
  }

  return { __text: '用法: aed agent register|list|enable|disable|unregister' };
}

/**
 * @param {string} v
 * @returns {string}
 */
function skillRootRoot(v) {
  return String(v);
}

module.exports = { run, ensureSkill, SKILL_TEMPLATE };

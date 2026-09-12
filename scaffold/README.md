# agent-evolution 接入脚手架（turnkey）

让一个**全新/独立项目**用最小成本接入 agent-evolution，拿到「 recurring 错误自动捕获 → 经验 playbook → 审计留痕」的能力。无需写接线代码。

## 三步接入

1. 把本目录的 `evolution-host.cjs` + `evolution.yaml` + `seeds/` + `EVOLUTION.md` 放进项目根（接入文档会写成 `EVOLUTION.md`，不会覆盖你既有的 `README.md`）。
2. 在入口或构建脚本里：

   ```js
   const evo = require('./evolution-host.cjs');
   evo.init({ autoStart: true });   // autoStart 启动 5 分钟周期分析
   ```

3. 在报错点把错误喂进来（一行，零语法负担）：

   ```js
   try { await doBuild(); }
   catch (err) { evo.tapError(err, { taskId: 'build' }); }
   // 或命令结果：
   evo.tapToolResult(result, { taskId: 'test' });
   ```

## 引擎 / 内核从哪来（无需手写）

`evolution-host.cjs` 按以下顺序解析，**宿主不用管路径**：

- 引擎：`EVOLUTION_ENGINE_PATH`（ENV）> 项目内 `lib/evolution-engine/engine.cjs`
- 内核：`EVOLUTION_KERNEL_ROOT`（ENV）> `evolution.yaml` 的 `kernel.kernelRoot` > 引擎内置共享内核

生产建议：把 `agent-evolution/engine` 与 `agent-evolution/kernel/src` 复制到宿主 `lib/evolution-engine` 与 `lib/evolution-kernel`（vendor），再提交。验证期可临时设置 ENV 指向 agent-evolution 仓库免 vendor。

## 拿到什么（从宿主视角）

| 能力 | 触发 | 产出 |
|------|------|------|
| recurring 错误捕获 | `tapError` / `tapE` | 指纹归一入账本，同类错误自动归并 |
| 即时 playbook | 种子 `seeds/common-pitfalls.jsonl` | 命中已知坑 → 候选修复建议（如 EADDRINUSE→查端口杀进程） |
| 周期分析 | `analyze.intervalMs` / `start()` | 自动跑八步链路：归因→候选→实证选优→落地 |
| 审计留痕 | 每条动作 | 哈希链可 `status().auditVerify` 校验 |
| 失败兜底 | 全部 | **fail-open**：引擎未就绪/降级时方法返回 `{ok:false}` 不抛，宿主主流程不受影响 |

## 可调项（evolution.yaml）

- `meta.agent`：改成你的项目名（进审计）。
- `knowledge.whitelist`：声明受管知识面（越权写/读被拒）。
- `objectives`：声明你想压制的错误类型与权重。
- `analyze.intervalMs`：周期分析间隔（默认 5 分钟）。
- `kernel.level`：`auto_report`（默认，自动落地+报告）/ `ask` / `off`。

详见仓库 `docs/EVOLUTION-YAML.md`。

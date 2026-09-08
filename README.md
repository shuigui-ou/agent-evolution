# agent-evolution

> **Agent 进化内核 + 共享接入引擎**：让 agent / skill 从自身运行轨迹中持续蒸馏经验，按声明式 `evolution.yaml` 安全落地进化——接入 = 放一份配置，而不是写一套接线代码。

本仓库把「接入进化能力」从「每个宿主各写 ~1000 行接线代码」收敛为 **共享 engine + 数据即接入**：

```text
宿主侧只需：
  1. 放一份 evolution.yaml
  2. 调 engine.load(yamlPath)   ← 共享引擎统一装配
  3. 把返回的 handle 暴露成自己的 API
```

---

## 核心模块

| 目录 / 文件 | 说明 |
|---|---|
| `kernel/` | **evolution-kernel v1.1.0**（零依赖 CommonJS）：进化内核运行时。八步主状态机（错误→记录→定时分析→对比他解→最优→权限→落地→周期再评估）；承诺账本（ledger）+ 审计链（audit）；快照/回滚；权限档位（T4 铁律：*行为可进化，权限不可进化*）；六原语 P0–P4 分级。入口 `kernel/src/index.cjs`。 |
| `engine/` | **evolution-engine v1.0.0**（零依赖 CommonJS）：共享引擎加载器。读取 `evolution.yaml` → schema 校验 → 定位并装配内核 → 返回统一 `handle`。入口 `engine/engine.cjs`。 |
| `docs/EVOLUTION-YAML.md` | **evolution.yaml v1 契约**：接入的唯一必读文档。字段表、完整示例、错误码与降级语义。 |
| `docs/EVOLUTION-KERNEL-SPEC.md` | 内核规范：八步链路、六原语分级、T4 铁律、权限档位定义。 |
| `src/` | **AED 守护进程主线**（Agent Evolution Daemon）：`daemon` / `cli` / `ingest` / `evidence` / `evolve` / `external` / `credit` / `eval` / `resources` / `assessment` / `security` / `store` 等子模块 + `schema/` JSON Schema。 |
| `bin/` | AED CLI（`aed`）、资源服务（`aed-resource`）、回溯评估（`evolution-eval`）。 |
| `fixtures/` | 固定件与样例：`eval/` 回溯评估夹具、`suites/` 黄金回归集、`solution-seeds/` 种子样例、`software-verifier/traces.sample.jsonl` 轨迹样例。 |
| `test/` | AED 主线测试（仓库根 `package.json` → `npm test`）。 |

> `runtime/`（运行期数据）与 `qa-scratch/`（QA 临时对抗文件）为可重建产物，已通过 `.gitignore` 排除，不进版本库。

---

## 快速上手：三步接入一个新 skill / host

以 software-verifier 类 skill 为例（完整契约见 [`docs/EVOLUTION-YAML.md`](docs/EVOLUTION-YAML.md)）：

**第 1 步：放一份 `evolution.yaml`**

在宿主/skill 根目录声明接入契约：

```yaml
schema: 1
meta:
  agent: my-skill
  version: 1.0.0
kernel:
  dataDir: data/evolution     # 运行期数据目录（相对宿主根）
  level: auto_report          # 权限档位：auto / auto_report / ask / suggest / off
  audit: true
knowledge:
  root: evolution             # 知识面根目录
  whitelist:                  # 白名单（越界写/读被内核硬拒）
    - learnings.jsonl
    - pitfalls.json
seeds:
  source: evolution/seeds.sample.jsonl
objectives:
  - title: 提升稳定性
    types: [E, G]
    weight: 1.0
```

**第 2 步：用共享引擎装配**

```js
const { load } = require('evolution-engine/engine.cjs'); // 或 vendored 到宿主的 engine

const handle = load('evolution.yaml', { kernelRoot: 'path/to/evolution-kernel/src' });
```

**第 3 步：把 handle 暴露成宿主 API**

```js
module.exports = {
  meta: handle.meta,                     // 元信息：ok / enabled / level / tier / dataDir
  tapE: handle.tapE,                     // 记录一条运行轨迹/错误事件
  runCycle: handle.runCycle,             // 周期批分析（定时触发即可）
  status: handle.status,                 // 查看进化状态/最近落地
  pendingInterrupts: handle.pendingInterrupts, // 待人工裁决队列（分歧/越权场景）
  rollback: handle.rollback,             // 回滚到最近检查点
};
```

内核随后会从运行轨迹中自动蒸馏经验、按 `kernel.level` 档位落地到白名单知识面，全程审计、可回滚。

---

## 测试矩阵

零第三方依赖，直接使用 Node 内置 test runner：

| 组件 | 命令 | 结果 |
|---|---|---|
| evolution-kernel | `cd kernel && node --test test/*.test.cjs` | ✅ 47/47 |
| evolution-engine | `cd engine && node --test test/*.test.cjs` | ✅ 10/10 |

```text
kernel : # tests 47  # pass 47  # fail 0
engine : # tests 10  # pass 10  # fail 0
```

---

## 环境要求

- **Node.js ≥ 18**（kernel / engine 均在 `engines` 声明 `>=18`；实测于 Node 22；仓库根 AED 主线包声明 `>=22`）。
- **零第三方依赖**：`dependencies` 与 `devDependencies` 均为空，克隆后无需 `npm install` 即可跑测试。
- **Windows 注意**：直接运行 `node --test test/*.test.cjs`（由 Node 自行展开 glob，**不要带尾部斜杠**）。
- 仓库通过 `.gitattributes` 统一 LF 行尾，保证跨平台检出一致、测试字节级可复现。

---

## License

[MIT](./LICENSE) © 2026 shuigui-ou

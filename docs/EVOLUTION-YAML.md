# evolution.yaml v1 契约 —— 数据即接入

> 版本：v1 ｜ 状态：定稿 ｜ 2026-09-08 ｜ 配套代码：`agent-evolution/engine/engine.cjs`（共享引擎加载器）  
> 目的：把 skill / host 接入进化内核的方式，从「每个 skill 写一套接线代码」收敛为  
> **共享 engine + 一份声明式 evolution.yaml = 数据即接入**。



---

## 0. 为什么需要这份契约

改造前，Host A（ai-novel-studio）在 `src/evolution.cjs` 里写了约 1100 行**宿主侧接线代码**：  
内核懒加载、种子导入/索引、候选生成器、knowledgeSurface 声明、interrupt 批量裁决、  
probe 回填、report 落盘……其中 90% 与"这个宿主是 ai-novel-studio"无关，而是**接入内核的通用骨架**。  
新宿主接入时若复制粘贴改一版，就会陷入「今天做这个 skill 要改一下，明天接哪个 skill 也要改一下」。

本契约把「接入 = 写代码」改成「接入 = 写一份 yaml」：

```text
宿主侧（每个 skill / host）只需：
  1. 放一份 evolution.yaml
  2. 调 engine.load(yamlPath)   ← 共享引擎统一装配
  3. 把返回的 handle 暴露成自己的 API
```

共享引擎（`engine/engine.cjs`）负责 schema 校验、内核定位、知识面声明、种子导入、  
目标栈、权限档位、审计开关、降级语义——全部由 evolution.yaml 驱动。

---

## 1. Schema v1 字段表

顶层 `schema: 1` 固定。以下字段中 **加粗** 为必填；其余有默认值。

| 字段                        | 类型       | 必填 | 说明                                                                           |
| ------------------------- | -------- | -- | ---------------------------------------------------------------------------- |
| `schema`                  | int      | ✔  | 契约版本，当前必须为 `1`                                                               |
| `meta.agent`              | string   | ✔  | agentId（进入内核 host.agentId / 审计）                                              |
| `meta.version`            | string   |    | 宿主/agent 版本号（展示用）                                                            |
| `kernel.dataDir`          | string   |    | 运行期数据目录（相对宿主根；默认 `data/evolution`）                                           |
| `kernel.kernelRoot`       | string   |    | 内核模块目录（相对 evolution.yaml；缺省=引擎内置共享内核或 vendored 约定路径）                         |
| `kernel.level`            | string   |    | 权限档位：`auto` / `auto_report` / `ask` / `suggest` / `off`（默认 `auto_report`）    |
| `kernel.enabled`          | bool     |    | 默认开（可被宿主 config.json `evolution.enabled` 覆盖）                                 |
| `kernel.audit`            | bool     |    | 审计链开关（默认 true）                                                               |
| `kernel.dailyLimit`       | int      |    | 每日落地次数上限（默认 20）                                                              |
| `kernel.primitives`       | string[] |    | 声明支持的原语子集（默认六原语齐 → P4）                                                       |
| `kernel.configFile`       | string   |    | 宿主运行期开关文件（相对 evolution.yaml，可选；enabled/level 运行时可改）                          |
| **`knowledge.root`**      | string   | ✔  | 知识面根目录（相对宿主根）                                                                |
| **`knowledge.whitelist`** | string[] | ✔  | 白名单相对路径列表（必须至少一项；越界写/读均被拒）                                                   |
| `knowledge.whitelistMeta` | object[] |    | 可选：每个白名单条目的附加说明（读法/格式）                                                       |
| `seeds.source`            | string   |    | solution-seeds JSONL 源（相对 evolution.yaml 或宿主根）                               |
| `seeds.fileName`          | string   |    | 导入到 dataDir/seeds 后的文件名（默认 `<agent>.seeds.jsonl`）                            |
| `objectives`              | object[] |    | 目标栈：`{title, types:[E/G/P/I], weight}`（无 objective 的信号只归档不进化）                |
| `signals`                 | object   |    | 信号源声明：`source`(tap/result.json/event)、`pointer`、`triggers`（当前驱动 tapE/事件 API） |
| `thread.ttlMs`            | int      |    | thread 账本默认生命周期 ms（默认 24h）                                                   |
| `analyze.intervalMs`      | int      |    | 自动周期批分析间隔 ms（默认 5 分钟）                                                        |
| `behavior.windowSize`     | int      |    | 行为贴合层：偏好推断滑动窗口（默认 20 条观察）                                                  |
| `behavior.minEvidence`    | int      |    | 行为贴合层：形成稳定偏好的最少多数票数（默认 3）                                                |
| `behavior.confidence`     | number   |    | 行为贴合层：多数方向置信度阈值 (0,1]（默认 0.6）                                            |
| `server.enabled`          | bool     |    | 是否声明 HTTP 端点面（默认 false）                                                      |
| `server.prefix`           | string   |    | HTTP API 前缀（默认 `/api/evolution`）                                             |

### 1.1 kernel.kernelRoot 解析顺序

共享引擎在装配内核时按以下顺序定位 `createKernel` 模块：

1. `opts.kernelRoot`（调用方显式覆盖，测试/QA 用）
2. `kernel.kernelRoot`（evolution.yaml 内声明，相对 yaml 所在目录；**推荐 host 用它指向 vendored kernel**）
3. 引擎内置：`<engine>/../kernel/src`（共享内核在 agent-evolution 仓库内时的缺省路径）
4. 解析失败 → 抛 `EVOLUTION_KERNEL_NOT_FOUND`（fail-safe，不静默）

> 与既有约定一致：Host A 已有 `lib/evolution-kernel/` vendored 内核，  
> 因此它的 evolution.yaml 用 `kernel.kernelRoot: lib/evolution-kernel/src` 指回项目内内核即可。

### 1.2 knowledge.whitelist 语义

- 白名单条目为**相对 knowledge.root 的路径**，禁止绝对路径。
- 首个 `.jsonl` 条目会被内核选为默认落地面（`paths.defaultSurface`）。
- 写入 / 读取越过白名单前缀 → 内核硬拒 `PATH_NOT_WHITELISTED`（fail-safe，绝不静默吞）。
- 目录型白名单（如 `notes`）允许其前缀下非可执行文件；可执行扩展名（.js/.cjs/.py/.sh…）被内核 E4 黑名单拒绝。

### 1.3 behavior 行为贴合层（方向 A，v1 增量）

**解决什么**：让用户体感"越用越懂我"。宿主把**用户对输出的显式纠偏**（"太长了/详细点/直接给结果/先分步确认"）喂给引擎，引擎沉淀成输出风格偏好，返回一段**可注入的行为指引**；宿主在每次任务/回复前拼进上下文即可。与 knowledge 的边界：knowledge 修"同类任务错误"，behavior 调"输出风格"。

**接入**（宿主侧，不改宿主本体）：

```js
// 1. 用户输出被纠偏时上报（两种入参任选）
handle.tapBehavior({ text: '太长了，简洁一点' });          // 文本启发式解析
handle.tapBehavior({ dimension: 'verbosity', direction: 'less' }); // 精确上报
// 2. 每次任务/回复前取指引，拼进 system prompt
const g = handle.behaviorGuidance();  // { ok, text, active }
if (g.text) prompt += '\n' + g.text;
// 3. （可选）查看/清空偏好
handle.behaviorProfile();             // 全部 4 维度实时偏好
handle.behaviorReset('verbosity');    // user 来源清空
```

**受控枚举**（安全边界，不接受自由文本维度）：

| dimension | label | more（措辞） | less（措辞） |
| --- | --- | --- | --- |
| `verbosity` | 输出篇幅 | 更详尽 | 更简洁 |
| `detail` | 论据与细节 | 更多细节/依据 | 更少细节/要点为主 |
| `proactivity` | 主动性 | 更主动多走一步 | 更克制只答所问 |
| `pace` | 节奏 | 更分步、逐步确认 | 更直接给结果 |

**安全保证**：
- 维度/方向受控枚举，非法输入抛 `BEHAVIOR_INVALID_DIMENSION / BEHAVIOR_INVALID_DIRECTION`（engine 层转 `{ok:false, reason:'kernel_error'}` fail-open）；
- 注入文本由模板 + 受控措辞生成，**绝不拼接用户原文**（原文只存档/审计）→ 无注入面；
- append-only 账本 `<dataDir>/behavior/observations.jsonl` + 审计挂钩（`BEHAVIOR_TAPPED`）；
- kill-switch 后行为层不可写；不改宿主本体/权限/目标档位。

**偏好推断规则**：每维度取最近 `behavior.windowSize` 条观察，多数方向票数 ≥ `behavior.minEvidence` 且占比 ≥ `behavior.confidence` → 该维度稳定（`stable=true`），进入 guidance。

**向后兼容**：`behavior` 段整体可选。旧 evolution.yaml 不写该段 → 引擎按缺省参数装配（windowSize=20/minEvidence=3/confidence=0.6），其余行为零变化。

---

## 2. 完整示例 A：ai-novel-studio（Host A，P4/auto_report）

文件位置：`<host-root>/evolution.yaml`（与 config.json 同级）

```yaml
schema: 1
meta:
  agent: ai-novel-studio
  version: 0.1.0
kernel:
  dataDir: data/evolution          # 相对宿主根 → <root>/data/evolution
  kernelRoot: lib/evolution-kernel/src   # 项目内 vendored 内核
  level: auto_report               # 自动落地 + 报告；config.json evolution.level 可运行覆盖
  enabled: true
  audit: true
  dailyLimit: 20
  primitives: [tap, pre_action, interrupt, write, checkpoint, audit]  # → resolveTier P4
  configFile: config.json          # 运行期开关（evolution.enabled / evolution.level）
knowledge:
  root: data/evolution/knowledge   # 相对宿主根 → <root>/data/evolution/knowledge
  whitelist:
    - errors.jsonl                 # 默认落地面（首个 .jsonl）
    - fixes.md
    - runbook.md
    - notes                        # 受控目录：可写 .md/.txt 等，可执行被拒
seeds:
  source: seeds/ai-novel-studio.seeds.jsonl
  fileName: ai-novel-studio.seeds.jsonl
objectives:
  - title: 压制宿主 AI 调用/解析类错误复发率 RR≤5%
    types: [E]
    weight: 5
  - title: 长任务不再悬挂（I 型人审）
    types: [I]
    weight: 4
  - title: 满足作者显式创作期望
    types: [G]
    weight: 3
  - title: 宿主声明步骤与执行轨迹对齐
    types: [P]
    weight: 2
signals:
  source: tap                      # E 类信号来自宿主 tapE() 事件通道
  triggers: [post-run, http, manual]
server:
  enabled: true
  prefix: /api/evolution
```

Host A 的 `src/evolution.cjs` 从约 1100 行收敛为薄适配层：加载 yaml → `engine.load` → 用返回 handle 提供原导出。

---

## 3. 完整示例 B：software-verifier（Host B，声明式接入骨架）

文件位置：`<skill-root>/evolution.yaml`（与 SKILL.md 同级）

```yaml
schema: 1
meta:
  agent: software-verifier
  version: 0.1.0
kernel:
  dataDir: .evolution              # 离线数据目录（相对 skill 根，避免污染 evolution/ 资产）
  kernelRoot: lib/evolution-kernel/src   # 注：B 档第二步 vendor 内核后启用；当前 QA 用共享内核装配
  level: auto_report
  enabled: true
  audit: true
  dailyLimit: 20
  primitives: [tap, pre_action, interrupt, write, checkpoint, audit]
knowledge:
  root: evolution                  # <skill>/evolution/（既有资产目录）
  whitelist:
    - pitfalls.json                # 核心资产：可复用解法 playbook
    - learnings.jsonl              # 原始学习流
  whitelistMeta:
    - { path: pitfalls.json, format: json, note: 由宿主既有 evolve.cjs 维护，只经内核读/快照 }
    - { path: learnings.jsonl, format: jsonl, note: 保留为宿主侧原始流 }
objectives:
  - title: 压制验证失败复现率（同一失败模式不再反复出现）
    types: [E]
    weight: 5
signals:
  source: result.json              # 每次验证产物 OUT/result.json
  pointer: /features               # JSON pointer 到失败功能列表（B 档第二步接入）
  triggers: [post-run, manual]
server:
  enabled: true
  prefix: /api/evolution
```

> 本文件即「声明式接入骨架」。`verify.cjs` 默认仍静默（`opt.evolve=false` 不回改）；  
> 本次只证明 engine 能基于该 yaml 装配并正确读到 pitfalls 白名单（engine 测试覆盖）。

---

## 4. 接入一个新 skill 只需三步

1. **放一份 evolution.yaml**（抄 §3 模板，改 `meta.agent`、`knowledge.root/whitelist`、`objectives`）；
2. **调用共享引擎**：`const h = require('evolution-engine/engine.cjs').load('./evolution.yaml')`  
   —— engine 自动完成 schema 校验 / 内核定位 / 知识面声明 / 种子导入 / 权限档位 / 审计；
3. **把 handle 暴露成宿主 API**：`module.exports = { init: ..., tapE: h.tapE, ... }`（薄透传即可）。

之后的任何内核升级 / 新能力（K5 资源层、K6 评估）都落在**共享 engine** 里，宿主 yaml 不用动。

### 对比

| 维度              | 旧方式（写 host 代码）      | 新方式（evolution.yaml + engine）                                     |
| --------------- | ------------------- | ---------------------------------------------------------------- |
| 接入一个 skill 的代码量 | ~1000 行接线           | ~20 行 yaml + 薄透传                                                 |
| 内核路径/知识面/种子/目标  | host 代码硬编码          | yaml 声明                                                          |
| 新宿主接入           | 复制粘贴一版再改            | 写一份 yaml                                                         |
| 内核升级            | 逐 host 改接线          | engine 一处升级，yaml 不变                                              |
| 错误处理            | 各 host 自行 fail-open | engine 统一：schema 抛 `EVOLUTION_*`；内核故障降级 `degraded`；越权/T4 硬拒 code |

---

## 5. 错误码与 fail-safe 约定

| 场景                  | 行为                                           | 错误码                          |
| ------------------- | -------------------------------------------- | ---------------------------- |
| yaml 文件不存在          | `engine.load` 抛错                             | `EVOLUTION_YAML_NOT_FOUND`   |
| yaml 语法坏            | 抛错                                           | `YAML_PARSE_ERROR`（解析器内）     |
| schema 缺必填 / 版本不符   | 抛错                                           | `EVOLUTION_SCHEMA_INVALID`   |
| 内核定位失败              | 抛错（宿主 init catch → degraded）                 | `EVOLUTION_KERNEL_NOT_FOUND` |
| 内核初始化故障             | 降级 `degraded`（后续调用 fail-open，不抛）             | meta.degraded=true           |
| 写/读越过 knowledge 白名单 | 返回 `{ok:false, code:'PATH_NOT_WHITELISTED'}` | 不抛、不改写                       |
| 写入可执行文件             | `EXECUTABLE_REJECTED`                        | 同上                           |
| 经验内容触碰权限/工具/原语（T4）  | `T4_VIOLATION`                               | 同上                           |
| 注入检测命中              | `INJECTION_REJECTED`                         | 同上                           |

原则：**schema/配置错误绝不静默吞**；**内核运行期故障降级不崩宿主**；**越权/T4/注入写入失败即报错**。

---

## 6. 配套交付物

- 共享引擎：`agent-evolution/engine/engine.cjs`（零依赖 CJS，可整体复制到 host）
- 极简 YAML 解析：`engine/yaml-min.cjs`（零依赖；不支持锚点/多行块等复杂特性，见文件头）
- 引擎测试：`agent-evolution/engine/test/engine.test.cjs`（10 用例全绿）
- Host A 收敛样板：`ai-novel-studio/src/evolution.yaml` + `src/evolution.cjs` 薄适配  
  （vendored engine：`ai-novel-studio/lib/evolution-engine/`）
- Host B 声明式接入：`software-verifier/evolution.yaml`（skill 根，见 §7 取舍）

---

## 7. Host B（software-verifier）收敛取舍记录

**背景**：`docs/HOST-B-software-verifier.md`（更早的架构勘察）曾提出重接线方案——在 skill 内  
vendor 内核 + 新增 `evolution-bridge.cjs`（把 `evolve.cjs` 的 `runEvolution` 拆成 plan/apply、  
落地改走内核 write、verify 触发点改调 bridge）。

**实施决定（本次收敛）**：采用「最小侵入 + 通用 engine」，只新增一份声明式  
`software-verifier/evolution.yaml`，**不改动** `evolve.cjs` 的 pitfalls 匹配/合并算法，  
`verify.cjs` 维持默认静默（`opt.evolve` 为真才触发旧 runEvolution，此行为为先前已合入的改动，  
本收敛不改变它）。

**取舍理由**：

1. 「数据即接入」的核心是让**知识面先被声明、被白名单约束、可被统一 engine 读取**，而不是  
   马上把 skill 的运行期写盘切到内核。`evolution/pitfalls.json`（35 条 playbook）与  
   `learnings.jsonl`（原始流）已经是既有资产，先声明它们为受管知识面，后续接原语零改 yaml。
2. 直接重构 `evolve.cjs`（拆 plan/apply + bridge）属于 Host B 的行为变更，回归面大、需配套  
   测试与真实验证回归；与 #4「勿重写 pitfall 算法、verify 默认静默」边界冲突。先收敛到  
   「声明 + 可装配 + 可白名单读取」，把 bridge/落地迁移留作下一增量（低成本：yaml 无需再改）。
3. 代价（已记录）：在 bridge 落地前，pitfalls/learnings 的写入仍由 `evolve.cjs` 直写，尚不享受  
   内核审计链/快照/权限档。这是**阶段取舍**，不是架构回退——白名单与 knowledge.root 已按最终  
   形态声明，未来接内核时不需要 host 再改接线常量。

**可验证证明**：engine 在真实 skill 目录上装配该 yaml → `readKnowledge('pitfalls.json')` 返回  
35 条、`readKnowledge('learnings.jsonl')` 返回 13 行；未入白名单的同目录 `evolution.md` 与越权  
`../` 均返回 `PATH_NOT_WHITELISTED`；装配数据目录指向临时目录，不污染 skill 目录。

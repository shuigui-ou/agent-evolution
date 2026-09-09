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
| `kernel/` | **evolution-kernel v1.4.0**（零依赖 CommonJS）：进化内核运行时。八步主状态机（错误→记录→定时分析→对比他解→最优→权限→落地→周期再评估）；承诺账本（ledger）+ 审计链（audit，**append 并发防分叉**：以磁盘链尾为准 + 进程级互斥）；快照/回滚；权限档位（T4 铁律：*行为可进化，权限不可进化*）；六原语 P0–P4 分级；**行为贴合层**（从用户显式纠偏提炼输出风格偏好；**域词表声明式注入**，`behavior.keywords` 只扩词、不扩维度）；**出口选择环**（条目服役考核：注入签发 → 同因再犯自动衰减/停用，**阈值可经 yaml `outcome` 段配置**，见 §出口选择环）。入口 `kernel/src/index.cjs`。 |
| `engine/` | **evolution-engine v1.3.0**（零依赖 CommonJS）：共享引擎加载器。读取 `evolution.yaml` → schema 校验（含 `behavior.keywords` 结构 / `outcome` 阈值）→ 定位并装配内核 → 返回统一 `handle`（含 `tapBehavior` / `behaviorGuidance` / `reportOutcome` / `outcomeSummary` 等）。入口 `engine/engine.cjs`。 |
| `docs/EVOLUTION-YAML.md` | **evolution.yaml v1 契约**：接入的唯一必读文档。字段表、完整示例、错误码与降级语义。 |
| `docs/EVOLUTION-SCOPE.md` | **范围定义文档**：对象=血统 / 范围=任务→输出→验收回路 / 成功=出口被选择改善；出口选择环状态机、自动信号规则、与候选裁决环的职责划分。 |
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

## 行为贴合层（让用户体感"越用越懂我"）

> v1.2.0 新增（方向 A）。内核不再只修"任务错误"——它还能学"输出风格"。
>
> v1.4.0（kernel）/ v1.3.0（engine）增量：**域词表声明式注入** —— evolution.yaml `behavior.keywords`
> 可为各维度追加域词（`{dimension:{more:[词],less:[词]}}`），解决创作/专业域表达（"太单薄了/展开写/心理铺垫不够"）
> 拆不中内置通用词表的失配；只扩词、不扩维度/方向，缺省 = 内核内置通用词表，旧 yaml 零影响（详见
> [`docs/EVOLUTION-YAML.md`](docs/EVOLUTION-YAML.md) §1.3.1）。

宿主把**用户对输出的显式纠偏**喂给引擎，引擎沉淀成输出风格偏好并返回可注入指引：

```js
// 1. 用户说"太长了 / 详细点 / 直接给结果 / 先分步确认"时上报（文本启发式 或 精确上报）
handle.tapBehavior({ text: '太长了，简洁一点' });
handle.tapBehavior({ dimension: 'verbosity', direction: 'less' }); // 受控枚举
// 2. 每次任务/回复前取指引拼进 system prompt
const g = handle.behaviorGuidance();   // { ok, text, active }
if (g.text) prompt += '\n' + g.text;   // 模板文本，绝不拼接用户原文
// 3. 查看/清空偏好
handle.behaviorProfile();              // verbosity/detail/proactivity/pace × more/less
handle.behaviorReset('verbosity');     // user 来源清空
```

受控枚举（安全边界，不接受自由文本维度）：`verbosity`（篇幅）/ `detail`（论据）/ `proactivity`（主动）/ `pace`（节奏），方向 `more|less`。偏好形成需同向 ≥`behavior.minEvidence`（默认 3）且置信 ≥`behavior.confidence`（默认 0.6），窗口 `behavior.windowSize`（默认 20）。`behavior` 段可选，旧 yaml 零影响。详见 [`docs/EVOLUTION-YAML.md`](docs/EVOLUTION-YAML.md) §1.3。

---

## 出口选择环（让"进化"名副其实：有差分存活）

> v1.3.0（kernel）/ v1.2.0（engine）新增。范围定义见 [`docs/EVOLUTION-SCOPE.md`](docs/EVOLUTION-SCOPE.md)。
>
> v1.4.0（kernel）/ v1.3.0（engine）增量：**outcome 阈值 yaml 可配** —— 考核阈值
> `confirmToStrengthen`/`refuteToDecay`/`refuteToRetire`/`survivalWindow` 可经 evolution.yaml `outcome`
> 段覆盖（缺省 3/2/3/3 = 内核 OUTCOME_DEFAULTS，行为不变）；同版内核**审计链 append 并发防分叉**
> （以磁盘最新链尾为准 + 进程级互斥锁），消除跨进程并发写同一 audit.jsonl 的 seq 重复/prev 断链。

行为贴合层解决"越用越懂我"（前馈 shaping），出口选择环解决"错了自动停用、对了自动强化"
（反馈 selection）——没有后者，账本 append-only，落地与注入只是累积（有变异、无差分存活），
严格说不是进化。宿主**零新增代码**：自动信号由内核从事件流推导。

```js
// 自动发生（宿主无需调用）：
//   preAction 注入经验后，同 fingerprint 错误再 tap        → 该经验 auto refuted
//   behaviorGuidance 签发后，同对再纠偏                    → 该偏好对 auto refuted
//   behaviorGuidance 签发后，连续 survivalWindow 条异维纠偏 → 该偏好对 auto confirmed
// 条目状态：active →(refuted≥2) decayed（冷却停注）→(refuted≥3) retired（停用、审计可查）
//          active →(confirmed≥3) strengthened；retired 可由 user revoke 复活（计数清零）

// 可选增强（显式上报考核结论 / 只读视图 / 复活）
handle.reportOutcome({ lane: 'experience', key: 'exp-1', verdict: 'confirmed' }); // 或 'refuted'
handle.outcomeStatus({ lane: 'behavior', key: 'verbosity:less' }); // {status, confirmed, refuted}
handle.outcomeSummary();  // 两 lane 状态分布
handle.revokeOutcome({ lane: 'experience', key: 'exp-1' }); // 仅 user 来源
```

T4 不变：outcome 只作用于条目状态（注入面/指引面），永不触碰权限档位与目标。详见
[`docs/EVOLUTION-SCOPE.md`](docs/EVOLUTION-SCOPE.md)。

---

## 测试矩阵

零第三方依赖，直接使用 Node 内置 test runner：

| 组件 | 命令 | 结果 |
|---|---|---|
| evolution-kernel | `cd kernel && node --test test/*.test.cjs` | ✅ 65/65 |
| evolution-engine | `cd engine && node --test test/*.test.cjs` | ✅ 29/29 |

```text
kernel : # tests 65  # pass 65  # fail 0
engine : # tests 29  # pass 29  # fail 0
```

> engine 29 例含 **4 例跨域通用性验证**（`behavior-domain.test.cjs`）+ **3 例出口选择环**
> （`behavior-outcome.test.cjs`，verifier 域闭环：同对纠偏反复 → decayed 停注 → retired →
> revoke 复活）。同一份 engine 分别装配创作域（novel）与验证域（verifier，语义对齐
> software-verifier Host B 契约），双域并存 dataDir 隔离、账本不串；验证域走受控通道
> `tapBehavior({dimension,direction})` 即可形成偏好（不依赖文本词表），证明 behavior
> 账本机制域无关。
>
> v1.4.0（kernel）/ v1.3.0（engine）新增覆盖：**outcome 阈值可配**（`outcome` 段合法透传 → 1 次
> confirmed 即 strengthened；非法值 → `EVOLUTION_SCHEMA_INVALID`）、**behavior 域词表注入**
> （`behavior.keywords` 合法装配 + 创作表达命中；非法结构拒绝）、**audit 并发防分叉**
> （两实例交替 append 同一链仍 seq 连续、verify 通过）。

---

## 环境要求

- **Node.js ≥ 18**（kernel / engine 均在 `engines` 声明 `>=18`；实测于 Node 22；仓库根 AED 主线包声明 `>=22`）。
- **零第三方依赖**：`dependencies` 与 `devDependencies` 均为空，克隆后无需 `npm install` 即可跑测试。
- **Windows 注意**：直接运行 `node --test test/*.test.cjs`（由 Node 自行展开 glob，**不要带尾部斜杠**）。
- 仓库通过 `.gitattributes` 统一 LF 行尾，保证跨平台检出一致、测试字节级可复现。

---

## License

[MIT](./LICENSE) © 2026 shuigui-ou

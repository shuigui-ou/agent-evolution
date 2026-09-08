# software-verifier B 档（知识面桥接）接线方案

> 状态：勘察完成，待确认 ｜ 日期：2026-09-08 ｜ 目标：把软件验证器既有散装自进化收敛进进化内核

## 0. 现状（勘察结论）

software-verifier **已有自进化雏形**，非零起点：

| 组件 | 现状 | 缺什么 |
|---|---|---|
| `evolve.cjs` | 每次验证后读 result.json → 失败与 `pitfalls.json` 已知坑匹配 → 命中累加/未命中自动生成新坑 → 写回 | **无审计链、无快照回滚、无权限档**（`consent:'granted'` 全自动落地）、无 probe 双账（只记 hits 不验"修复是否真生效"） |
| `evolution/pitfalls.json` | 核心资产：可复用解法 playbook | 被 `savePitfalls` 整文件覆写，无版本/回滚 |
| `evolution/learnings.jsonl` | 原始运行流 | 无哈希链 |
| `verify.cjs:185` | 跑完自动 `runEvolution(result.json)` | 触发点是天然 tap 位，但信号未进内核 |
| `contribute.cjs --make` | 手动打包回传维护者 | **无资源服务对接**（外驱源现成但没接） |

## 1. 接线点（代码级锚点）

```
verify.cjs:185  runEvolution(OUT+'/result.json')   ← 唯一触发点（tap 面）
        ↓
evolve.cjs  runEvolution()  ← 拆成 plan(纯函数) + apply(落地) 两半
   ├─ plan:  读 result.json → anonymize → matchPitfall → extractPatterns
   │         → inferFix → findMergeTarget → 产出 {matched, newOnes, nextPitfalls}
   └─ apply: savePitfalls / 累加 hits / append learnings   ← 改走内核落地
```

内核桥（新增 `evolution-bridge.cjs`）取代 evolve.cjs 的直接写盘：
- **E 信号**：每次验证的失败 feature/error → `kernel.tap`（error 事件）；
- **候选检索**：matchPitfall 命中 = 内核候选命中（expected_gain 由 hits 折算）；
- **知识面声明**：root = `<skill>/evolution/`，白名单 = `['pitfalls.json','evolution.md']`；
- **落地**：新坑/命中累加 → 内核 `write`（快照先行 + 审计追加 + 哈希链），权限 auto_report；
- **learnings.jsonl**：保留为宿主侧原始流（不动语义）。

## 2. 改动面清单

| 文件 | 动作 | 改动量 |
|---|---|---|
| `lib/evolution-kernel/`（skill 内） | 新增（vendor 内核 13 src + test） | 复制，不动逻辑 |
| `evolution-bridge.cjs`（skill 根） | 新增：init(knowledgeSurface)/recordRun(resultPath)/poolsync | ~250 行 |
| `evolve.cjs` | 重构：`runEvolution` 拆成 `planEvolution`（纯）+ 落地改调 bridge | ~40 行 diff，导出加 planEvolution |
| `verify.cjs:185` | `runEvolution(...)` → `bridge.recordRun(...)` | 1 行 |
| `SKILL.md` | 补一段"进化内核已接入/开关"说明 | ~10 行 |
| 测试 | 新增 `test/evolution-bridge.test.cjs` | ~80 行 |

**不动**：engine.cjs、drivers/*、contribute.cjs 主逻辑、pitfalls 数据结构与匹配算法（内核不重写既有玩法，只外包审计/快照/权限）。

## 3. 外驱接线（第二步，与上解耦）

- `--share` 回流保持原通道（pitfall 回维护者），**另加**：本地 K5 资源服务已就绪时，把 consent='granted' 的新坑匿名同步到 `/resources/experiences` → 与其他 agent（ai-novel-studio 等）互为外驱；
- 运行时可选 `GET /resources/solutions` 富化匹配（默认 soft-fail 不影响验证主链）。

## 4. 权限与安全

- 档位 auto_report（落地留审计，不打扰）；T4 由内核硬保证（pitfall 内容无权限通道）；
- pitfalls.json 白名单外路径拒写 + 快照回滚（若某次 auto-merge 产生噪声坑，可回滚到上一版本）；
- 离线数据目录（evolution/ 现无敏感数据，anon 已做）。

## 5. 成本

~0.5-1 天（含 bridge 测试 + 一次真实验证回归 + 内核 39 测试随 vendor 复跑）。

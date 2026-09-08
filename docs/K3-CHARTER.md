# K3 立项文档：事件驱动闭环首跑（ai-novel-studio）

> 状态：立项（2026-09-08）｜ 前置：K2 已放行 ✅ ｜ 口径：事件驱动，无前置观测窗（§7 修订版）

## 1. 一句话目标

让 ai-novel-studio 的**第一个真实错误**当天就能走完"记录 → 归因 → 候选对比 → 人工确认 → 落地 → 周期再评估"完整闭环——原语④热写 + 知识面 + probe 双账本。

## 2. 范围（K3 该做的）

| 项 | 说明 | 验收 |
|---|---|---|
| 原语④ 热写 | 内核 L1 write 能力接入宿主，只写声明过的知识面路径（E1 知识文件） | 白名单外路径拒绝；可执行文件拒绝 |
| 知识面定义 | 声明 ai-novel-studio 的知识面：如 `data/evolution/knowledge/`（错误处置知识文件）+ 会话注入点 | 写入即下次任务生效 |
| probe 双账本 | "写入了"（hot-write 账）与"生效了"（probe 命中账）分开记；命中且解决=保留，误触发=降级/回滚 | probe.jsonl 双账齐全 |
| 权限 | suggest/ask 起步（人审闸门），K4 再开 auto_report | 每个落地动作有审计 + 快照 |
| 周期再评估 | 落地后默认 7 天 probe 复查，自动给出保留/升级/回滚建议 | 复查有输出 |

## 3. Step 0（外驱第一步，可与 K3 工程并行）：解法池种子预置

**原则**：候选不靠自然累积，K2 放行即可人工灌入已知踩坑 + 修复。种子权威文件：`agent-evolution/fixtures/solution-seeds/ai-novel-studio.jsonl`。

每条种子 schema（对齐内核 fingerprint / candidates / expected_gain）：
```jsonc
{
  "skeleton": "错误骨架/指纹（同骨架错误聚合键，如 'fetch failed'）",
  "category": "归因类别（AI_调用失败/格式错误/长任务悬挂/…）",
  "symptom": "现象",
  "rootCause": "根因",
  "fix": "修复动作（必须可写进知识面/可执行）",
  "verify": "验证法（怎么确认修好了）",
  "expectedGain": "预期收益（省去重试/用户等待/…的量化估计）",
  "source": "来源（自踩/外部 agent/…）",
  "credit": 1
}
```

首批种子来源（ai-novel-studio 已见，K2/QA 两轮已实证）：
- `fetch failed` / 无效 Key → AI 调用失败（E）
- 拆分结果 JSON 解析失败（E，QA 验证路径）
- AI 导入拆分超时（E，单独指纹）
- 批量续写/导入悬挂（I，thread TTL 24h 超期）
- `prompts.js buildChapterMessages` 异步化引发的 selftest 旧版同步调用（宿主技术债，E/G 双类）

## 4. 与 K4/K5 的边界

- K3 **不接**原语②③（preAction / interrupt），**不**开 auto_report——那都是 K4；
- 解法池**种子**先于资源服务落地，K5 只负责把种子池升级为"四接口资源层 + 跨 agent 互为外驱"，不改变种子 schema。

## 5. 验收总纲

1. 造一个真实 E 信号（坏 Key 调一次生成）→ 当天触发一轮完整闭环（含人工确认步骤），非"记录即止"；
2. 种子池命中：该 E 的 fingerprint 命中预置种子，候选列表非空；
3. 知识面写入受白名单约束，越权/可执行文件被拒并有审计；
4. probe 双账本：落地修复后 7 天复查脚本可跑、有输出；
5. 宿主原有功能回归全绿（selftest 14 + 宿主套件 + 内核 39）。

## 6. 遗留（K5 清理项，非 K3 范围）

AED 旧文档与 seed 文案仍带"先跑基线再开进化"的 v1 口径（ARCHITECTURE.md R7、cmd-agent.cjs、runtime/sandbox-skills 副本）——AED 已降级为资源服务，相关表述在 K5 改造时一并清理。

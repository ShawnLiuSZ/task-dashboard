# 活路线图：下 3 版意图

> 性质：**活文档（living doc）**——记录「下 3 版想往哪走」的取舍依据，填补
> [CHANGELOG](./CHANGELOG.md)（事后记录）与 [PRD](../PRD.md)（停在 v0.3）之间的空档。
> **不是排期、不是承诺**；每条意图标注「依据」，便于回头审视当初为什么这么定。
> 迭代仍由临场反馈驱动，本表只保证「不紧急但重要」的事不被系统性挤掉。
>
> 维护约定：每发一版，把「正在做」推进到「已完成」并在 [CHANGELOG](./CHANGELOG.md)
> 落条目；顶部版本号随之更新。依据变了就改意图，不硬撑。

---

## 基线（2026-11-11）

- 当前版本：**v0.8.8**（2026-11-10）。有效 backlog **0 条**（僵尸 #489 已关闭）。
- 已落地未发版的 P1 批次（合并进 `main`，随下一版发布）：
  - [`docs/product-usage-minimal-metric.md`](./product-usage-minimal-metric.md) — `status_events` 状态流转度量（P1-1）
  - [`docs/resume-session-consolidated.md`](./resume-session-consolidated.md) — `resume` 派生对象，恢复会话收成一个整体（P1-2）
  - [`docs/prd-readme-alignment.md`](./prd-readme-alignment.md) — PRD/README 3 处硬约束对齐（P1-3）
- 核心判断（见 [`PRODUCT-REVIEW-2026-11-11.md`](../PRODUCT-REVIEW-2026-11-11.md)）：
  看板/阅读层已做得较满；PRD §1 第二支柱「AI 执行辅助」能力层就位，但**价值闭环没合上、
  从未验证跑没跑通**。P1 批次补的是「度量 + 恢复入口 + 口径」，让闭环**可被观测**。

---

## 下 3 版意图

| 版本 | 意图（一句话） | 为什么值得做 | 依据 | 状态 |
|---|---|---|---|---|
| **v0.8.9** | 发布 P1 批次：给产品装上「有没有在用」的最小度量 + 恢复会话一次到位 + 口径对齐 | 先让「AI 闭环通没通」从「算不出来」变成「可查」，后续投向才有数据支撑 | 盘点 §4.1（关键数据从未采集）、§4.2（恢复要拼 5 处）、§4.3（约束两版会挑一个执行） | 🔜 待发版（已在 `main`） |
| **v0.8.x+** | 补齐度量的另一半：同步侧 `status_events(source=sync)` 插桩 + 复用 `api_logs` 量「MCP 工具调用次数」 | P1-1 只量了 agent 驱动（`mcp`）；补上远程权威覆盖（`sync`）后，`count_status_events_by_source` 才能直接回答「AI 驱动 vs 远程覆盖」占比 | P1-1 KB「未做」一节；盘点 §4.1「MCP 工具调用次数目前算不出来」 | ⚪ 意图，待 P1-1 数据回收后确认 |
| **v0.9** | 用真实度量数据**验证 PRD §1 第二支柱**：AI 自动维护到底通没通，据此决定下阶段投向 | 这是两个月来一直缺的「做完之后有没有用」的验收；数据说话，而非凭感觉加功能 | 盘点 §1 一句话判断、§5 AS-01（已用 DB 部分验证：看板在用、AI 闭环靠单一 agent 驱动） | ⚪ 意图，依赖前两行数据 |

---

## 明确不做（本阶段）

- **Skill 形态**：MCP 能力层已就位、指令文件是跨 Agent 复用等价物（见 README MCP 章节），
  再包一层 Skill 边际收益低。除非有具体 Agent 工作流强需求。
- **看板 UI 展示流转历史**：`status_events` 本阶段只落数据 + MCP 暴露；UI 呈现等
  「度量证明有价值」后再决定，避免在未验证的闭环上继续堆阅读层功能（盘点的核心批评）。
- **PRD 整体重写到 v0.9**：P1-3 只对齐了 3 处硬约束矛盾；全面重写是更大工程，留作独立事项。

---

## 相关链接

- 事后记录：[CHANGELOG](./CHANGELOG.md)
- 长期需求与决策演进：[PRD](../PRD.md)（停在 v0.3，硬约束以 [AGENTS](../AGENTS.md)/[README](../README.md) 为准）
- 本路线图依据：[`PRODUCT-REVIEW-2026-11-11.md`](../PRODUCT-REVIEW-2026-11-11.md)
- 已落地 P1 批次：[最小度量](./product-usage-minimal-metric.md) ·
  [恢复会话](./resume-session-consolidated.md) · [口径对齐](./prd-readme-alignment.md)

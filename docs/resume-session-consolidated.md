# 恢复会话收成一个整体：`get_task_status` 的 `resume` 派生对象

> 来源：`PRODUCT-REVIEW-2026-11-11.md` 想法清单 P1 第 2 条 ——「把『恢复会话』收敛成一次查询」。
> 本文是该想法的落地实现记录。

## 背景 / 动机

PRD §6.4 假设「`get_task_status` → 恢复会话」一步到位。能力层（7 个 MCP 工具 + 触发规则）
已齐备，但实际恢复一个会话要拼 **status、session、handoff、work_branch**（外加 work_dir、
关联 PR）——分别散在不同字段里。这是「能力层就位、价值闭环没合上」最具体的一处：
数据都在，但 agent 得自己拼 5 处字段才能判断「能不能恢复、怎么恢复」。

## 设计 / 方案

**加一个预计算的 `resume` 派生对象，而非新工具 / 新表 / 新查询。**

关键决策：

- **不新增 MCP 工具、不新增表、不改 `SELECT_COLS`。** 恢复所需的数据 `get_task_status`
  全都返回了，缺的只是把散字段**收成一个明确的恢复入口**。所以在 `row_to_value` 里
  用已有的 `session_id` / `session_agent` / `handoff` / `work_branch` / `work_dir` / `status`
  预计算出一个 `resume` 对象，纯派生、零 schema 改动。
- **三字段足够指导下一步**：
  - `resumable`（bool）—— 有 `session_id` **或** `handoff` 即可恢复（前者续跑同一会话，
    后者接手上下文）。
  - `reason`（string）—— 为什么可/不可恢复（`session id` + `handoff` 的组合说明）。
  - `hint`（string）—— 把 work_branch / work_dir / session / 当前状态串成一句话，
    直接指导「恢复后 `update_task_status(处理中)`」。
- **顺带接上 P1-1 的 `statusEvents`**：`get_task_status` 现在同时给出「状态经历 +
  恢复入口」，恢复会话所需的上下文基本一次到位。

`resume` 形状：

```json
{
  "resumable": true,
  "reason": "有记录的 session id + handoff 交接详情",
  "hint": "续跑会话 sess-abc（原 agent: claude-code），读 handoff 交接详情接手，分支 feat/x，目录 /w；当前状态 doing，恢复后 update_task_status(处理中)"
}
```

## 接口 / 行为变更

- **MCP `get_task_status`**：响应新增 `resume` 对象字段（`resumable` / `reason` / `hint`）。
  纯新增字段，未改动 `SELECT_COLS`，`check-mcp-columns.py` 不受影响。
- **Tauri command / DB**：无变化。`resume` 是 `row_to_value` 内的派生计算，不落库。

## 数据 / Schema 变更

无。`resume` 由既有列实时派生，不新增表 / 列 / 索引。

## 测试 / 验收

已跑（`cargo test --lib`，278 通过，含 4 个新用例）：

- `build_resume_with_session_is_resumable` —— 有 session ⇒ `resumable=true`，
  `hint` 含 session_id / work_branch / work_dir / status。
- `build_resume_with_handoff_only_is_resumable` —— 仅 handoff ⇒ 也可恢复。
- `build_resume_with_neither_is_not_resumable` —— 都无 ⇒ `resumable=false`，
  `hint` 明说「无可恢复上下文」。
- `build_resume_session_and_handoff_reason_combines` —— 两者都有 ⇒ `reason` 同时点明。

边界：

- 空串字段（老任务没记 session/handoff）⇒ `resumable=false`，不 panic。
- `check-mcp-columns.py` / `check-doc-links.py` / `clippy -D warnings` / `fmt --check` 全绿。

## 未做 / 后续

- **`list_my_tasks` 未加 `resume`**：列表场景一次返回多行，逐行算 hint 意义不大；
  恢复是单任务动作，只在 `get_task_status`（单查）给。保持列表精简。
- **关联 PR 的恢复语义**：`resume.hint` 目前不含 PR 信息（PR 已在响应顶层 `prs`）。
  若未来要「恢复即带 PR 上下文」，可在 `hint` 追加，本版未做。

## 相关链接

- 想法来源：`PRODUCT-REVIEW-2026-11-11.md`（§3 想法清单 P1-2、§4.2 展开）
- 代码：`app/src-tauri/src/mcp.rs`（`build_resume` + `row_to_value` 挂载 + 4 测试）
- 同批：P1-1 `docs/product-usage-minimal-metric.md`（`status_events`，`get_task_status`
  已暴露 `statusEvents`，与本版 `resume` 共同构成「恢复会话一次到位」）

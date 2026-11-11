# 产品使用最小度量：status_events 状态流转记录

> 来源：`PRODUCT-REVIEW-2026-11-11.md` 想法清单 P1 第 1 条 ——「给产品装一个『有没有在用』的最小度量」。
> 本文是该想法的落地实现记录（为什么这么做、怎么做、怎么验收）。

## 背景 / 动机

PRD 里所有数字都是 2026-09-03 的拉取基线，两个多月、8 个版本过去，没有任何
「做完之后有没有用」的数据。更根本的一点：`tasks.status` 只是**当前快照**，
`db.rs` 里没有状态迁移事件表 ⇒「状态流转时长」「AI 自动维护状态通没通」
**目前根本算不出来**。不只是没人看数据，是关键数据从未被采集。

本次先用现有数据自查（见 `PRODUCT-REVIEW-2026-11-11.md` §5 AS-01 已验证），
结论是「看板在用、AI 闭环靠 claude-code 单一 agent 驱动、但缺可度量的状态迁移」，
故补一个**最小**度量：记录 `tasks.status` 的每一次流转。

## 设计 / 方案

关键决策：

- **只加一张表，不 bump `SCHEMA_VERSION`、不写迁移。**
  与 `sync_logs` / `api_logs` / `meta` 同机制：`CREATE TABLE IF NOT EXISTS` 放进
  `SCHEMA` 常量 ⇒ 老库在下次 `open_db` 时由 `execute_batch(SCHEMA)` **自动补齐**。
  这是 db.rs 注释里明确支持的低摩擦路径，避免为一张纯新增表去动版本门控。
- **在写入收口插桩，而非到处埋点。** `common.rs::set_task_status` 是 MCP 写状态的
  单一入口（`validate → UPDATE → 返回行数`），在这里记一条即可覆盖全部 agent 驱动的
  状态变更。`source` 字段区分驱动方：
  - `mcp` —— agent 经 MCP 工具驱动（回答「AI 自动维护通没通」）
  - `sync` —— 远程权威覆盖（保留字段，当前同步路径尚未插桩，见「未做」）
- **度量失败不反噬主流程。** 记录失败只 `eprintln!`，绝不因度量把状态写入搞失败。
- **暴露在 `get_task_status`**：响应新增 `statusEvents`（camelCase，最多 20 条，新→旧），
  让「恢复会话」一次看到该任务经历了哪些状态、由谁驱动 —— 顺带缓解 P1 第 2 条
  「恢复会话要拼 4 处」的一环。

表结构（`app/src-tauri/src/db.rs` SCHEMA）：

```sql
CREATE TABLE IF NOT EXISTS status_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_key  TEXT NOT NULL,
  old_status TEXT NOT NULL DEFAULT '',
  new_status TEXT NOT NULL,
  source     TEXT NOT NULL DEFAULT 'mcp',
  created_at INTEGER NOT NULL
);
```

新增函数（`db.rs`）：`record_status_event` / `list_status_events` /
`count_status_events_by_source` / 结构体 `StatusEvent`。

## 接口 / 行为变更

- **Tauri command**：无变化（`set_task_status` 签名不变，仅内部多记一条事件）。
- **MCP `get_task_status`**：响应新增 `statusEvents` 数组字段
  （`{issueKey, oldStatus, newStatus, source, createdAt}`，≤20 条，新→旧）。
  这是**纯新增字段**，未改动 `SELECT_COLS`，故 `check-mcp-columns.py` 不受影响。
- **DB**：新增 `status_events` 表 + 两个索引，老库自动补齐。

## 数据 / Schema 变更

- 新增 `status_events` 表 + `idx_status_events_key` / `idx_status_events_created`。
- **迁移方式**：无显式迁移。靠 `CREATE TABLE IF NOT EXISTS` 在 `open_db` 的
  `execute_batch(SCHEMA)` 里对老库自动建表（与 `sync_logs`/`api_logs` 一致）。
- 无数据回填（历史流转无从恢复，从部署本版起才开始记）。

## 测试 / 验收

已跑（`cargo test --lib`，274 通过）：

- `status_events_record_list_and_count_by_source` —— 记录 → 倒序查询 → 按 source 统计。
- `set_task_status_records_transition_event` —— 写状态自动记 `source=mcp` 流转；
  key 不存在（`n==0`）不记。
- `cargo check` / `clippy -D warnings` / `fmt --check` 全绿。
- `scripts/check-mcp-columns.py` / `check-doc-links.py` 全绿。

边界：

- 度量写入失败 → 仅 `eprintln!`，状态写入照常成功（不反噬主流程）。
- 老库首启 → `status_events` 自动建表，`list_status_events` 返回空而非报错。

## 未做 / 后续

- **同步路径（`sync` source）尚未插桩**：`commands.rs` 里 Project 写回那条
  `UPDATE tasks SET project_status, status`（远程权威覆盖）当前不记事件。
  这是刻意的最小化 —— 先把 agent 驱动（`mcp`）这条主线量起来，验证价值后再决定
  是否补同步侧。补齐后 `count_status_events_by_source` 即可直接回答
  「AI 驱动 vs 远程覆盖」的占比。
- **无 UI 呈现**：本版只落数据 + MCP 暴露，看板 UI 不展示流转历史。
- 「MCP 工具调用次数」仍未采集（需另一张表或复用 `api_logs` 语义），不在本版范围。

## 相关链接

- 想法来源：`PRODUCT-REVIEW-2026-11-11.md`（§3 想法清单 P1-1、§4.1 展开、§5 AS-01）
- 代码：`app/src-tauri/src/db.rs`（SCHEMA + 函数 + 测试）、
  `app/src-tauri/src/common.rs`（`set_task_status` 插桩）、
  `app/src-tauri/src/mcp.rs`（`get_task_status` 暴露 `statusEvents`）
- 同批交付的其余想法见 `PRODUCT-REVIEW-2026-11-11.md` §3

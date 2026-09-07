# update_task_status 校验 status 合法性（#70）

> 关联：[Issue #70](https://github.com/ShawnLiuSZ/task-dashboard/issues/70)、[docs/CHANGELOG.md](./CHANGELOG.md)

## 背景 / 动机

`commands.rs::update_task_status`（Tauri command，前端调用）之前只拦截空串，把传入的 `status` 字符串**直接写入** `tasks.status`，不校验合法性。前端或 agent 传入拼错的值（如 `donee`）或已被删除的自定义列名时，`UPDATE tasks SET status = ...` 依旧落库。

由于看板列只匹配「四态 todo/doing/processed/done ∪ 该账号自定义列」，落库的任务不属于任何列，界面上静默「消失」，直到下次同步才可能被覆盖/清理。

`mcp::tool_update`（agent 走 MCP 通道）之前只放行四态，会拒绝自定义列——校验过严，且与 `commands.rs` 的校验口径不一致。

## 设计 / 方案

统一两处入口的校验口径为：**status ∈ 四态 ∪ 中文四态 ∪ 该任务所属账号的 `account_columns::col_key`**。

### commands.rs（前端入口）
- 中文四态先归一化到英文四态（待处理→todo … 已完成→done），避免中文/英文混存到 status 导致渲染失配。
- 新增 `validate_task_status(conn, key, status)`：四态放行；否则从 `tasks` 按 `key` 取 `account_id`，再查 `db::list_account_columns` 校验 `col_key`；不命中返回 `Err`，`UPDATE` 不执行。任务不存在时非四态一律拒绝。

### mcp.rs（agent 入口）
- `tool_update` 保持 `resolve_status` 四态归一化；非四态时同样查该任务账号的 `account_columns`，命中 `col_key` 放行，否则拒绝。

## 接口 / 行为变更

- `update_task_status` 对非法状态不再静默写入，而是返回错误，DB 不改动。
- 中文四态会被归一化后写入英文四态（不再以中文落库）。
- `mcp::update_task_status` 现支持该账号自定义列的 `col_key` 更新（此前会被拒绝）；非法状态仍拒绝。

## 数据 / Schema 变更

无。

## 测试 / 验收

- 新增单测 `validate_status_accepts_four_states_and_account_columns`（[commands.rs](../app/src-tauri/src/commands.rs) tests）：
  - 四态 `todo` / `done` → 放行
  - 该账号自定义列 `col_alpha` → 放行
  - 拼错 `donee` → 拒绝
  - 该任务账号不存在的列 `col_beta` → 拒绝
  - 任务不存在时非四态 → 拒绝
- `cargo check` 通过；`cargo test` lib 22 passed、0 failed（2 ignored）；仅 `db_test` 两个基线失败（`insert_account_validates_required_fields`、`delete_account_blocks_default_and_orphan_task_id_kept`，与本次无关）。

## 相关链接

- [Issue #70](https://github.com/ShawnLiuSZ/task-dashboard/issues/70)
- [docs/CHANGELOG.md](./CHANGELOG.md) v0.3.34
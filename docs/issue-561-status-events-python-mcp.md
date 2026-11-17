# issue-561：Python MCP 补齐 status_events（双实现一致性）

> 关联：[#561](https://github.com/ShawnLiuSZ/task-dashboard/issues/561) ｜ 2026-11-17 全量核查报告 中危-1

## 背景 / 动机

`mcp_server/server.py`（Python 标准库兜底实现）在 `tool_update_task_status` / `tool_get_task_status`
上缺少 `status_events` 支持，与 Rust 权威实现（`app/src-tauri/src/`）不一致：

- Rust `common.rs::set_task_status`（L329-353）每次状态写入都经 `db.rs::record_status_event` 插桩
  （`source=mcp`），`mcp.rs::tool_get`（L372-378）响应附 `status_events` 字段。
- Python 侧 `status_events` 出现 0 处。

后果：用 Python 兜底 MCP 时，产品盘点 P1 最小度量「AI 自动维护状态通没通」漏记；
`get_task_status` 响应缺 `status_events` 字段，agent 拿到的契约与 Rust 侧分歧。
违反 AGENTS.md §8.6「双实现一致性」。

## 设计 / 方案

1. `ensure_schema` 补 `CREATE TABLE IF NOT EXISTS status_events`（与 `db.rs::SCHEMA` L373-382
   逐列对齐 + `idx_status_events_key` / `idx_status_events_created` 两个索引）。
2. `tool_update_task_status`：UPDATE 前读旧值，成功后 `INSERT INTO status_events`
   （`old_status`/`new_status`/`source='mcp'`/`created_at`）。度量失败只写 stderr、不反噬主流程
   （同 Rust `eprintln!` 语义）。
3. `tool_get_task_status`：两个 found 分支都附 `status_events`（`ORDER BY id DESC LIMIT 20`，
   查询失败降级空数组）。
4. 修正 `docs/CHANGELOG.md` 键名 `statusEvents` → `status_events`（与实际代码键一致）。

## 接口 / 行为变更

- `get_task_status` 响应新增 `status_events: Array<{issue_key, old_status, new_status, source, created_at}>`。
- 写路径新增副作用：每次 `update_task_status` 成功落一行 `status_events`（source=mcp）。
- 无 `SELECT_COLS` 变更、无新工具。

## 数据 / Schema 变更

`status_events` 表由 Python MCP `ensure_schema` 自建（Python MCP 是独立进程、不走 Rust
`db::open_db`），与 Rust `SCHEMA` 定义一致。老库（该表未创建、其后未再被新版 Rust 打开）
在 Python MCP 首次 `ensure_schema` 时自动补齐。

## 测试 / 验收

- `test_server.py::OnDemandTest::test_status_events_recorded_and_returned`：update 后
  `status_events` 有且仅有一行（old=todo/new=done/source=mcp），`get_task_status` 返回该字段。
- `setUp` 的 `_reset_conn` 清库清单补 `DELETE FROM status_events`（防跨用例累积）。
- 全量 `python3 -m unittest discover -s mcp_server -p 'test_server.py'` 73 例全绿。
- `scripts/check-mcp-columns.py` / `check-doc-links.py` 通过。

## 相关链接

- Issue：[#561](https://github.com/ShawnLiuSZ/task-dashboard/issues/561)
- 核查报告：`CODE-REVIEW-2026-11-17.md`（中危-1）
- Rust 参考：`common.rs::set_task_status` / `db.rs::record_status_event` / `mcp.rs::tool_get`
- CHANGELOG：`docs/CHANGELOG.md`（v0.9.0 起，P1-1 条目）

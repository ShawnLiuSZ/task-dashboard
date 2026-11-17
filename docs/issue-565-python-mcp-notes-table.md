# issue-565：Python MCP 自建 notes 表（旧库 note 工具全失败）

> 关联：[#565](https://github.com/ShawnLiuSZ/task-dashboard/issues/565) ｜ 2026-11-17 全量核查报告 中危-3

## 背景 / 动机

`mcp_server/server.py` 的 6 个 note 工具（`tool_list_notes` / `tool_add_note` /
`tool_update_note` / `tool_update_note_label` / `tool_delete_note`，L1124-1195）全读写
`notes` 表，但 `ensure_schema`（L226-338）只建 `sessions` / `task_prs` / `task_comments`，
**漏了 `notes`**。

`ensure_schema` 注释明写「Python MCP 是**独立进程**、不走 Rust 的 `db::open_db`，故必须
自建表」—— 唯独 `notes` 没进清单（Rust `db.rs::SCHEMA` L384-390 才建）。旧库（notes 表
加入前创建、其后未再被新版 Rust 打开）→ Python MCP 首次 `ensure_schema` 后 note 工具仍
`no such table: notes`。

## 设计 / 方案

1. `ensure_schema` 补 `CREATE TABLE IF NOT EXISTS notes`（与 `db.rs:384-390` 逐列对齐：
   `id` / `content` / `label DEFAULT 'low'` / `created_at` / `updated_at`）。
2. `label` 列容错 ALTER（早期无标签版本，对应 Rust `MIGRATION_DDL`）。
3. `idx_notes_content` 唯一索引（`db.rs:408`）：老库若有重复 content，Rust 侧先去重再建；
   Python 侧 `try/except` 跳过，不硬失败 `ensure_schema`（否则整个 MCP 起不来）。
4. `test_server.py` 补 note CRUD 冒烟用例。

## 接口 / 行为变更

无（`ensure_schema` 只是补齐建表，note 工具对外行为不变）。

## 数据 / Schema 变更

`notes` 表由 Python MCP `ensure_schema` 自建，与 Rust `SCHEMA` 一致。旧库在 Python MCP
首次 `ensure_schema` 时自动补齐。

## 测试 / 验收

- `test_server.py::OnDemandTest::test_notes_crud_smoke`：add / list / update / update_label /
  delete 全链路，验证 notes 表已由 ensure_schema 自建。
- 全量 `python3 -m unittest discover -s mcp_server -p 'test_server.py'` 74 例全绿。

## 相关链接

- Issue：[#565](https://github.com/ShawnLiuSZ/task-dashboard/issues/565)
- 核查报告：`CODE-REVIEW-2026-11-17.md`（中危-3）
- Rust 参考：`db.rs::SCHEMA`（notes 表）/ `db.rs::idx_notes_content`

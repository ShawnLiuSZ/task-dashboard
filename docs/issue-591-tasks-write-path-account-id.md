# issue-591：tasks 写路径只按 issue_key 过滤不带 account_id —— 记录已知设计

> 关联：[#591](https://github.com/ShawnLiuSZ/task-dashboard/issues/591) ｜ 2026-11-17 全量核查报告 低危-9

## 背景 / 动机

`tasks` 表的写 / 查路径（`UPDATE tasks ... WHERE issue_key=?`、`SELECT ... FROM tasks
WHERE issue_key=?`）**只按 `issue_key` 过滤，不带 `account_id`**。多账号下同一
`issue_key` 可跨账号重复（同一 repo 的 issue 被不同账号各存一份），UPDATE / 查询可能
**跨账号命中**。

两侧共有设计，非 Python 独有；#546 已给关系表（task_prs 等）加 `account_id` 键，
tasks 写路径未加。

## 设计 / 方案

**记录为已知设计**（文档 / 注释，非行为变更）：

1. `app/src-tauri/src/common.rs::touch_session` 文档注释补「已知设计」段：tasks 写路径
   只按 `issue_key`，跨账号可重复命中；**两侧共有设计**（`mcp_server/server.py`
   同路径同理）；后续加 `account_id` 条件必须**两侧同步**（mcp.rs + server.py）并跑
   `scripts/check-mcp-columns.py`。
2. `mcp_server/server.py::tool_record_session` 补同段注释（对齐 Rust 侧）。
3. 注明当前按 `issue_key` 过滤是刻意权衡 —— 单账号场景下 `issue_key` 全局唯一，行为正确。

**不改变任何 SQL / 行为。**

## 接口 / 行为变更

- 无（纯注释 + KB 文档，不改 SQL）。

## 测试 / 验收

- `cargo check --manifest-path app/src-tauri/Cargo.toml` 通过（Rust 注释变更编译正常）。
- `python3 -m unittest discover -s mcp_server -p 'test_server.py'` 81 例全绿。
- `scripts/check-mcp-columns.py` / `scripts/check-doc-links.py` 通过。

## 相关链接

- Issue：[#591](https://github.com/ShawnLiuSZ/task-dashboard/issues/591)
- 核查报告：`CODE-REVIEW-2026-11-17.md`（低危-9）
- 既有：#546（关系表加 account_id 键）

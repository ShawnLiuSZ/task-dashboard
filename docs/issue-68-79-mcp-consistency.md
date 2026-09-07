# MCP 双实现一致性修复（#68 #79）

> 关联：[Issue #68](https://github.com/ShawnLiuSZ/task-dashboard/issues/68)、[Issue #79](https://github.com/ShawnLiuSZ/task-dashboard/issues/79)、[docs/CHANGELOG.md](./CHANGELOG.md)

## 背景 / 动机

TaskBoard 的 MCP Server 存在两套实现：
- 内置：[`app/src-tauri/src/mcp.rs`](../app/src-tauri/src/mcp.rs)（随 app 二进制，Rust）
- 便携兜底：[`mcp_server/server.py`](../mcp_server/server.py)（Python 标准库）

二次审计发现两处行为不一致，会导致同一 MCP 调用在两种环境（内置 app / 便携 server）下得到不同结果。

## 设计 / 方案

### #68 · `delete_note` 返回键漂移

- **Rust** `mcp.rs::tool_delete_note`：`{ "ok": true, "note_id": id }`
- **Python** `server.py::tool_delete_note`：`{ "ok": true, "id": note_id }`（漂移）

MCP 工具入参 Schema 统一用 `note_id`，返回也用 `note_id` 更一致。修复：`server.py` 返回键 `id` → `note_id`，与 Rust 端对齐。

### #79 · 空标签归一化行为不一致

- **Rust** `mcp.rs::normalize_note_label`：`None` / 空串均回落到 `"low"`（宽容）。
- **Python**：
  - `tool_add_note`：`(label or "low")` 空串回落 `"low"` —— 与 Rust 一致 ✅
  - `tool_update_note_label`：`(label or "")` 空串**不回落**，落入 `if label not in VALID_NOTE_LABELS: raise` → 报错 —— 与 Rust 不一致 ❌

修复：`server.py::tool_update_note_label` 改为 `(label or "low")`，空串回落 `"low"`，与 `tool_add_note` 及 Rust 端统一。

## 接口 / 行为变更

- `delete_note` 返回值键由 `id` 改为 `note_id`（仅影响消费返回的 agent/客户端，行为语义一致）。
- `update_note_label(label="")` 由报错改为回落 `low`。
- 无 Schema / 表结构变更。

## 数据 / Schema 变更

无。

## 测试 / 验收

- `python3 -m py_compile mcp_server/server.py` 通过。
- Rust 端未改动（`delete_note` 已是 `note_id`、`normalize_note_label` 已回落 `low`）。
- 手工验收点：
  - 内置 app 与便携 server 对以下调用返回一致：
    - `delete_note` → `{ "ok": true, "note_id": <id> }`
    - `update_note_label(note_id, label="")` → 记录标签变为 `low`
    - `add_note(content, label="")` → 记录标签为 `low`

## 相关链接

- [Issue #68](https://github.com/ShawnLiuSZ/task-dashboard/issues/68)、[Issue #79](https://github.com/ShawnLiuSZ/task-dashboard/issues/79)
- [docs/CHANGELOG.md](./CHANGELOG.md) v0.3.33
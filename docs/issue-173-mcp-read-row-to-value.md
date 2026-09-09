# issue-173 — Rust 内置 MCP 读路径字段错位（`row_to_value` 未同步 24 列 `SELECT_COLS`）

> 关联：issue [#173](https://github.com/ShawnLiuSZ/task-dashboard/issues/173) · #155 tasks 表重建 · #169 Python MCP 列名一致性 · #171 record_session 工作分支 · [CHANGELOG v0.3.54](./CHANGELOG.md)

## 背景 / 动机

随 app 打包的内置 MCP（`taskboard mcp`，AGENT_INSTRUCTIONS 标注的「首选形态」）里，
`list_my_tasks` / `get_task_status` 返回的字段**几乎全部错位**：

`repo` 填的是 `owner`、`number` 填的是 `repo`（字符串）、`title` 填的是 `number`、
`status` 填的是 `title`、`ownership` / `session_id` 等也依次错开；只有 `issue_key`
（索引 0）是对的，`work_branch` / `handoff` 虽在 SELECT_COLS 里却读不到。

Agent 用内置 MCP 读看板拿到的是张冠李戴的字段，`work_branch` 写进去也查不出来
（#171 功能半残）。

## 设计 / 方案

根因是**位置索引映射**没有跟着 `SELECT_COLS` 演进：

1. #155 重建 `tasks` 表，并在查询里插入 `url` / `issue_state` / `project_status` / `pr_number`
   等中间列，列序大变。
2. #169 / #171 把 `SELECT_COLS` 从老的精简列序扩成 24 列，但 `mcp.rs::row_to_value`
   仍按老的精简列序用位置 `get(0..10)` 取值。
3. `check-mcp-columns.py` 只比对两侧 `SELECT_COLS` **字符串**逐字一致 + 列名存在于
   SCHEMA，对「位置 → 列名」这一层映射是盲的 → CI 全程绿色，功能却坏了。

修复：重写 `row_to_value`，严格按 SELECT_COLS 的 24 列顺序逐一映射，并补 Rust 单测。

**为什么 Python 侧没事**：`server.py` 用 `sqlite3.Row`（`row_factory`）+ `dict(row)`，
按**列名**取值，天然不受列序影响；Rust 用手写位置索引，才需要与 SELECT_COLS 强一致。

## 接口 / 行为变更

零接口变更、零前端改动。修复后内置 MCP 返回字段从「错位值」恢复为「字段名 → 正确值」：

| 字段 | 修复前（错） | 修复后（对） |
|---|---|---|
| `repo` | owner 值 | repo 值 |
| `number` | repo 字符串 | number 数值 |
| `title` | number 值 | title 值 |
| `status` | title 值 | 本地看板四态 |
| `work_branch` | 读不到 | agent 记录的工作分支 |
| `handoff` | 读不到 | 交接详情 |
| `mentioned` / `pr_number` / … | 错位 | 各自正确值 |

## 数据 / Schema 变更

无。未改 SCHEMA、无迁移；只是修复读取层的位置映射。

## 测试 / 验收

- 新增 2 个 Rust 单测（lib 34 → 36 例），内存库建一张覆盖 SELECT_COLS 全部 24 列的
  `tasks` 表、每列填互不相同且可辨识的值，逐字段断言 `list_my_tasks` / `get_task_status`
  返回正确：
  - `list_my_tasks_returns_correct_column_values`
  - `get_task_status_returns_correct_column_values`（含 `missing` 的 `found:false` 分支）
- `cargo check`、`cargo test`（lib 36 通过 + db_test 18 通过）均绿。
- `python3 scripts/check-mcp-columns.py` 通过（24 列双侧一致）——注意该脚本管「列名一致」，
  **本次修复的位置映射由 Rust 单测承担**，二者边界清晰。

> 验收提醒：该 bug 只影响内置 MCP 读路径，Python MCP 不受影响；发版后可用
> `taskboard mcp` 手动发一个 `list_my_tasks` 验证字段值。

## 相关链接

- issue：[#173](https://github.com/ShawnLiuSZ/task-dashboard/issues/173)
- 根因链：#155（表重建）→ #169（字符串层列名统一）→ #171（扩到 24 列）→ #173（值映射）
- [docs/issue-155-tasks-schema-rebuild.md](./issue-155-tasks-schema-rebuild.md)
- [docs/issue-169-mcp-server-schema-sync.md](./issue-169-mcp-server-schema-sync.md)
- [docs/issue-171-record-session-branch.md](./issue-171-record-session-branch.md)
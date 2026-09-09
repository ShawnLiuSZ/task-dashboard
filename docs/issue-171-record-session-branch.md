# Issue 171 — MCP record_session 记录工作分支 + PR 分支与工作分支分离

## 背景 / 动机

开始处理一个 issue 时，agent 需要把「当前工作分支」记到本地看板，便于中断、切换、交接后恢复上下文。

现状问题：

1. **branch 无写入通道**：`branch` 列由同步自动拉取 GitHub PR 的 `head.ref`，agent 的本地工作分支（尚未有 PR / 未推送）没有写入入口。
2. **同步会清空 branch**：`sync.rs` 中，PR 列表拉取成功但该 issue **无关联 PR** 时会把 `branch` 置空——这正是 PR 专用字段的正确语义，agent 若想写分支会与它冲突。

关键设计权衡：`branch` 承载两种互斥的来源（同步的 PR head.ref vs agent 的工作分支），**复用同一列会导致无法区分**。因此拆成两列，职责彻底分离。

对应 GitHub issue：[#171](https://github.com/ShawnLiuSZ/task-dashboard/issues/171)。

## 设计 / 方案

### 新增 `work_branch` 列（agent 工作分支，同步不碰）

- `branch` = **PR 专用**（`head.ref`），由同步自动拉取；无关联 PR 时清空（原逻辑，不回归）。
- `work_branch` = **agent 工作分支**，只由 MCP `record_session` 写入；同步 upsert 的 INSERT 列与 `ON CONFLICT SET` 都不含它，**同步天然不会覆盖**。
- 已有 PR（`branch` 拉到了 head.ref）与本地工作分支（`work_branch`）并存，互不干扰。

### 触发时机提前到「开始处理」

原规则在「中断 / 切换」时才 `record_session`；现改为**开始处理时就记录**（状态置「处理中」的同时带上当前会话 + 工作分支），越早记录越不易遗漏，中断 / 切换时若换到新会话再更新。

### `branch` 来源由调用方提供

agent 用 `git -C <项目目录> branch --show-current` 取当前工作分支，**取不到传空**（不在 git 仓库 / 无分支时不要硬塞脏数据）。MCP 层非空才写 `work_branch`、空则跳过。

## 接口 / 行为变更

### MCP 工具 `record_session` 新增可选 `branch` 参数

```
record_session(issue=<repo#num>, session_id=<...>, agent=<...>, branch=<当前工作分支>)
```

- `branch` 非空 → 更新 `tasks.work_branch`。
- `branch` 空 / 缺省 → 行为与原来一致，仅写 `session_id / session_agent / session_at`。

> Rust 侧实现复用公共 `common::touch_session`，新增 `branch: Option<&str>` 参数（内部按非空分支走条件 SQL）；Python `mcp_server/server.py` 独立实现同样的条件更新，两侧行为一致。

### 同步行为（`sync.rs`）——恢复为 PR 专用清空

- `branch` 字段当该 issue 无关联 PR 时仍清空（原逻辑，不回归）。
- 有 PR 时仍由 `Some((n, u, b))` 覆盖 → 仓库 `head.ref` 权威。
- `work_branch` 不在同步的 INSERT / ON CONFLICT 列中 → 同步完全不碰它。

### Python MCP 读路径修复（#155 遗留）

`mcp_server/server.py` 的部分列引用仍用 #155 重建前的 `key` 列（读路径 `get_task_status`、写 `record_handoff`、`SELECT_COLS`），在重建后的库（真实列为 `issue_key`）上会静默失败。本次将这三处 `key` 修正为 `issue_key`，并使两侧 `SELECT_COLS` 都补上 `work_branch`，保持 Rust/Python 一致。

### `AGENT_INSTRUCTIONS.md`（中 / 英）

- 工具表：`record_session` 入参补充 `branch?`（写明写 `work_branch`，与同步的 PR `branch` 分离）。
- 触发时机：**开始处理**行补充「`record_session(... + branch=<当前工作分支>)`」。
- 新增「会话 id / 分支来源」说明段：branch 用 `git branch --show-current` 取，取不到传空，写入独立 `work_branch`。

## 数据 / Schema 变更

- `tasks` 表新增列 `work_branch TEXT NOT NULL DEFAULT ''`。
- 迁移方式：
  - 新库：由 SCHEMA 顶层 `CREATE TABLE` 直接包含（`IF NOT EXISTS` 幂等）。
  - 老库（version < 1）：`migrate_legacy_alters` 追加 `ALTER TABLE tasks ADD COLUMN work_branch ...`。
  - v2 物理重建（`migrate_tasks_v2_rebuild`）：`tasks_new` 定义 + `INSERT..SELECT` 均补上 `work_branch`（从老库对应列复制，无则默认空）。
- 无索引变更。建议跑 `scripts/check-mcp-columns.py` 校验两侧 `SELECT_COLS` 与 schema 列名一致（本仓库当前无此脚本）。

## 测试 / 验收

- `cargo check` 通过。
- `cargo test` 通过：lib 34 例 + db_test 18 例（含 v2 rebuild 迁移列数对齐）。
- `python3 -m py_compile mcp_server/server.py` 通过。
- 验收场景：
  1. `record_session(..., branch="feature/x")` 后，`tasks.work_branch` = `feature/x`，`branch` 不受影响。
  2. 该 issue 无关联 PR 同步后，`work_branch` 保持 `feature/x`（同步不覆盖）；`branch` 被清空。
  3. 该 issue 有 PR 同步后，`branch` 由仓库 `head.ref` 覆盖，`work_branch` 仍保留。

## 相关链接

- Issue：[#171](https://github.com/ShawnLiuSZ/task-dashboard/issues/171)
- CHANGELOG：[`docs/CHANGELOG.md`](./CHANGELOG.md)
- 指令规范：[`mcp_server/AGENT_INSTRUCTIONS.md`](../mcp_server/AGENT_INSTRUCTIONS.md)
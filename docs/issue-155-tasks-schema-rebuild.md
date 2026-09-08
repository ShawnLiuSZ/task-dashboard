# tasks 表物理重建：字段命名理清 + 自增主键 + 复合唯一键

> 对应 issue：[#155](https://github.com/ShawnLiuSZ/task-dashboard/issues/155)
> 版本：v0.3.50

## 背景 / 动机

`tasks` 表存在三类问题。由于项目仍处于预览阶段，用户决定**物理重建一次**，彻底理清表结构：

1. **三态命名混淆**：`status`（本地看板四态 todo/doing/processed/done）、`gh_state`（issue open/closed）、`gh_status`（Project status）三列名字相近、语义不清，是看板逻辑最容易写错读错的地方。
2. **主键缺陷**：`key TEXT PRIMARY KEY`（值 = repo#number）。多账号 watch 同一 `repo#number` 时**互相覆盖**（`sync.rs` 历史限制）。切自增 `id` + `UNIQUE(repo, number, account_id)` 可根治，并为未来外键关联打底。
3. **时间类型不一致**：`updated_at` 是 TEXT（RFC3339 字符串），其余 `synced_at / done_at / session_at` 均为 INTEGER **秒**。

**已确认决策**（AskUserQuestion）：
- 主键改自增 `id INTEGER PRIMARY KEY` + 复合唯一键，保留稳定业务引用 `issue_key`（= repo#number）。
- 字段重命名 DB 列 + Rust struct + SQL + 前端 TS 接口/组件**全局同步**。
- `updated_at` 统一为 **INTEGER 秒**（`sync::now_secs()` 返秒、前端 `fmtTime` 按 `number*1000` 解析，故用「秒」与其他时间戳一致，非毫秒）。

## 设计 / 方案

### 新表布局（核心列）

| 旧列 | 新列 | 类型 | 说明 |
|---|---|---|---|
| `key` | `id` | `INTEGER PRIMARY KEY`（rowid） | DB 内部主键，不暴露给 JSON/前端 |
| —（新增） | `issue_key` | `TEXT NOT NULL` | 取值仍为 `repo#number`，业务引用 / React key / MCP 引用 |
| —（新增） | `UNIQUE(repo, number, account_id)` | — | 解决多账号覆盖 |
| `gh_state` | `issue_state` | `TEXT` | GitHub issue open/closed |
| `gh_status` | `project_status` | `TEXT DEFAULT ''` | GitHub Project 状态原文 |
| `status` | `status`（保留） | `TEXT DEFAULT 'todo'` | 本地看板四态，改动面最大、保留 |
| `updated_at` | `updated_at` | `TEXT` → `INTEGER`（秒） | 类型变更，名称不变 |
| 其余 23 列 | 不变 | — | owner/repo/number/title/url/ownership/session_* / candidate_done/stale/assignees/labels/done_at/mentioned/comments_count/latest_comment_url/pr_* / branch/handoff/synced_at/account_id |

+ 索引：`idx_tasks_issue_key/status/ownership/account/board/status_done_at`（列名未变的直接重建/幂等补齐；`issue_key` 索引在 SCHEMA 顶层移除，统一在 `open_db` 末尾幂等创建，保证老库迁移读取安全）。

### 迁移策略

`open_db`（db.rs）三级版本门控：

```
read user_version
execute_batch(SCHEMA)          // 新库直接建新 schema；老库 IF NOT EXISTS no-op 保留旧布局
if schema_ver < 1:
    migrate_legacy_alters()     // 老库补齐缺失列，保证重建 SELECT 可读
if tasks_uses_legacy_key():     // 幂等判定：tasks 仍含旧 key 列才重建
    migrate_tasks_v2_rebuild()  // 物理重建（单事务）
set user_version = 2
```

- **幂等**：`tasks_uses_legacy_key()` 用 `PRAGMA table_info(tasks)` 检测是否仍有 `key` 列。新库无 `key` 列 → 跳过；老库有 → 重建。重建后 `key` 列消失，即使 `user_version` 丢值也不会二次重建。
- **`migrate_tasks_v2_rebuild`**（单事务）：`CREATE tasks_new` → `INSERT..SELECT`（`issue_key=key`、`gh_state→issue_state`、`gh_status→project_status`、`updated_at` 用 `COALESCE(CAST(strftime('%s', NULLIF(TRIM(updated_at),'')) AS INTEGER),0)` 转秒）→ `DROP old / RENAME` → 重建索引。
- 顺序依赖：`migrate_legacy_alters` 必须先于重建，保证老库已补齐 `gh_status/assignees/.../account_id` 等列。

## 接口 / 行为变更

**后端 Rust / Tauri command**
- `Task` struct：`key→issue_key`、`gh_state→issue_state`、`gh_status→project_status`、`updated_at: Option<String>→Option<i64>`。`serde camelCase` 输出：`issueKey / issueState / projectStatus / updatedAt`。
- `rows_to_tasks`：SELECT 列名 + Mapper 字段名同步（列序 index 0-22 不动）。
- `common.rs`：5 处 `WHERE key = ?N` → `WHERE issue_key = ?N`（Tauri 命令/validate 走这里）；新增 `iso8601_to_secs()` 供同步换算时间。

**同步 sync.rs**
- `PendingUpsert.updated_at`：`String` → `i64`。
- `INSERT`：列名 `issue_key / issue_state / project_status`；`ON CONFLICT(key)` → `ON CONFLICT(repo, number, account_id)`；`excluded.issue_state / excluded.project_status`。

**MCP（Rust `mcp.rs` + Python `server.py` 双实现同步，AGENTS.md §8.6）**
- `SELECT_COLS`：`key → issue_key`；查询/更新 `WHERE key` → `WHERE issue_key`。
- `row_to_value` 输出字段：`issue_key`；`updated_at` 改 INTEGER 秒。
- issue 引用写法（`repo#number` / `owner/repo#number` / URL）行为不变。

**前端**
- `types.ts` `Task`：`key→issueKey`、`ghState→issueState`、`ghStatus→projectStatus`、`updatedAt: string|null → number|null`。
- `Board.tsx`：分组/卡片 `issueState / projectStatus`、React `key={task.issueKey}`。
- `TaskCard.tsx`：字段同步；`updatedAt` 由字符串 `slice` 改为 `new Date(task.updatedAt*1000)`。
- `DetailPanel.tsx` / `App.tsx` / `api.ts`：命令实参取值改用 `task.issueKey`（Tauri 命令参数名仍为 `key`，承载 repo#number）。

## 数据 / Schema 变更

- `tasks` 表物理重建（见上文新表布局）。
- 迁移方式：`PRAGMA user_version` 版本化迁移 + `tasks_uses_legacy_key()` 幂等判定；老库自动重建，无手工步骤。
- 兼容性：重建一次后 `key` 列消失；即便 `user_version` 丢值也因 `key` 列缺失而跳过重建（幂等）。

## 测试 / 验收

**自动化（全部通过）**
- `cargo test --test db_test`：18 项全绿。新增 3 项 v2 断言：
  - `migrate_v2_rebuilds_legacy_tasks_preserving_data`：老库造数 → open_db 后旧列消失、新列就位、`UNIQUE(repo,number,account_id)` 存在、数据完整迁移、`updated_at` 由 RFC3339 转正确秒数。
  - `migrate_v2_rebuild_is_idempotent`：二次 open_db 不重复重建、数据不丢。
  - `tasks_allow_same_repo_number_across_accounts`：不同账号同 (repo,number) 共存；同账号重复被唯一键拦截。
  - 同步修正两条过时断言：`insert_account` 空 org 合法（db.rs 允许个人账号省略 org）；`delete_account` 会级联删除其名下 tasks。
- `cargo check`：通过。
- `npx tsc --noEmit`：通过。
- `npm run i18n:check`：zh-CN / en-US 241 key 对齐通过。

**端到端建议**
- 新库：删 DB 重开，`PRAGMA table_info(tasks)` 无 `key`、有 `id/issue_key`，`user_version=2`，6 索引就位。
- 老库迁移：用生产库副本（勿动真库）验证任务数一致、`issue_key==原 key`、session/handoff/status/done_at 完整保留、`updated_at` 转秒正确、重复 open_db 不重复重建。
- MCP 链路：`list_my_tasks` / `get_task_status("owner/repo#1")` / `update_task_status` / `record_session` 均经 `issue_key` 命中。

## 相关链接

- Issue：#155
- 分支：`feature/issue-155-tasks-schema-rebuild`
- CHANGELOG：`docs/CHANGELOG.md` v0.3.50 条目
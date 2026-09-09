# issue-175 — `work_branch` 迁移补漏：user_version=2 的库永不补列

> 关联：issue [#175](https://github.com/ShawnLiuSZ/task-dashboard/issues/175) · #171（引入该列）· #173（验证其读路径时暴露）· #155（v2 重建）· [CHANGELOG v0.3.54](./CHANGELOG.md)

## 背景 / 动机

从 v0.3.50 升级的真实库（`PRAGMA user_version = 2`，已做过 #155 的 v2 物理重建）**没有 `work_branch` 列**。
内置 MCP / app 一执行包含 `work_branch` 的 `SELECT_COLS` 就报：
`no such column: work_branch in SELECT ... FROM tasks`。

由 #171 在验证内置 MCP 读路径（#173）时用真实库副本复现：

```
cp 真实主库 → TASKBOARD_DB=副本 ./taskboard mcp  # 发 list_my_tasks
→ 错误：no such column: work_branch
```

## 设计 / 方案（根因）

`app/src-tauri/src/db.rs::open_db` 的迁移存在一个版本区间盲区：

| user_version | 是否跑 `migrate_legacy_alters`（含 work_branch 的 ALTER） | 是否触发 v2 rebuild（建表含 work_branch） | work_branch 是否补上 |
|---|---|---|---|
| 0（古老 / 未版本化） | ✅ | ✅（若有 `key` 列） | ✅ |
| 2（#155 已重建） | ❌（`schema_ver≥1` 跳过） | ❌（无旧 `key` 列，幂等不二次重建） | ❌ **永不补** |
| 3+（#171 起新库） | ❌ | — | SCHEMA 建表自带 ✅ |

关键：v0.3.50 发布的 v2 rebuild 建表 SQL 当时**还没有 `work_branch`**（#171 才加）；
而 #171 声称的「老库 ALTER + v2 重建同步迁移」里，`work_branch` 的 ALTER 只挂在
`migrate_legacy_alters`（user_version<1 分支），对 **user_version=2 已重建**的库既不跑
legacy ALTER、又不二次重建 → 该列永远缺失。

**为什么不能简单把该 ALTER 移出 `migrate_legacy_alters`**：`migrate_tasks_v2_rebuild` 的
`INSERT..SELECT` 会从旧表直接 `SELECT work_branch`（[db.rs](file:///../app/src-tauri/src/db.rs#L408-420)），
若在 v2 重建前旧表没有该列会报错。因此正确做法是**在重建之后的高频热路径幂等补列**。

**修复**：在 `open_db` 每次建连都跑的幂等区（与 `notes.label` 迁移同款，`if let Err` 忽略「已存在」）
无条件 `ALTER TABLE tasks ADD COLUMN work_branch TEXT NOT NULL DEFAULT ''`。对所有 user_version 一致生效：
- ver=2 缺列库 → 补上；
- ver<1 老库：`migrate_legacy_alters` 已补，热路径 ALTER 报「已存在」被静默忽略，且 v2 rebuild 在两者间执行、其 `SELECT work_branch` 满足；
- 新库 SCHEMA 自带 → 忽略。

## 接口 / 行为变更

零接口变更。修复后内置 MCP 的 `list_my_tasks` / `get_task_status` 在旧库上不再报
`no such column: work_branch`，可正常返回全部 24 列（含 `work_branch`）。

## 数据 / Schema 变更

数据迁移（非新列定义）：老库由热路径幂等 ALTER 补齐 `work_branch TEXT NOT NULL DEFAULT ''`。
幂等、可重入、无事务风险。

## 测试 / 验收

- 新增 db_test 用例 `open_db_backfills_work_branch_on_v2_db_without_it`（db_test 18 → 19）：
  正常建库后 `ALTER TABLE tasks DROP COLUMN work_branch` 模拟 #155 时代重建的缺列库，
  再 `open_db` 断言列被热路径补回、`SELECT_COLS` 不再报错。
- `cargo test` 全绿：lib 36 + db_test 19。
- 端到端复现验证（#173 同一副本）：`open_db` 补列后，`list_my_tasks` 返回 24 个字段，
  与数据库逐列对照**完全一致**（含 `work_branch`）。

## 相关链接

- issue：[#175](https://github.com/ShawnLiuSZ/task-dashboard/issues/175)
- 关联：#171（引入列，迁移覆盖不全）· #173（读路径字段错位 + 本缺陷暴露点）
- [docs/issue-155-tasks-schema-rebuild.md](./issue-155-tasks-schema-rebuild.md)
- [docs/issue-171-record-session-branch.md](./issue-171-record-session-branch.md)
- [docs/issue-173-mcp-read-row-to-value.md](./issue-173-mcp-read-row-to-value.md)
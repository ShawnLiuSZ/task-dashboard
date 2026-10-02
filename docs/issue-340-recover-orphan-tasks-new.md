# #340 崩溃残留的 `tasks_new` 永久孤立，用户整个看板静默丢失

> 对应 issue：[#340](https://github.com/ShawnLiuSZ/task-dashboard/issues/340)
>
> 分支：`fix/issue-340-recover-orphan-tasks-new`
>
> 类别：Rust 后端 / SQLite 迁移 / 数据安全（静默、永久数据丢失）

## 背景 / 动机

一次跨模块深度 code review 发现：App 启动后看板**整个为空**，无任何报错横幅。用户的 `status` / `session_*` / `handoff` / `work_branch` / `work_dir` 全部消失且**无法恢复**。

这是本批 8 个缺陷中**唯一会导致数据永久丢失**的一项，其余为「功能不可用」或「配置被写坏」。

> ⚠️ **非 #328 引入的回归**：基线 `f66f83f` 行为相同。#328 把重建事务化后**缩小了窗口**（从两次独立提交变成一个事务），但没堵上这个洞 —— 而其 doc comment 恰好把这个场景写成头号动机，读者会以为已修。

## 设计 / 方案

### 根因：自愈分支恰好在最需要时不可达

`migrate_tasks_v2_rebuild` 的 doc comment 自己点名了失败①：

> ① 两步之间进程被杀 / 断电 → `tasks` 丢失、数据滞留 `tasks_new`；下次启动 `CREATE TABLE IF NOT EXISTS tasks` 重建**空表**，本地态永久丢失

#328 为此加了 `DROP TABLE IF EXISTS tasks_new` 自愈，**但该 DROP 只在 `migrate_tasks_v2_rebuild` 内部可达**，进入该函数的前置条件是 `tasks_uses_legacy_key(conn)` 为真（`tasks` 仍含旧 `key` 列）。失败①的场景恰恰是 `tasks` **已不存在**：

```rust
// db.rs：tasks 缺失 ⇒ fresh = true
let fresh = !table_exists(&conn, "tasks");

// db.rs：fresh 时直接跳过重建
if !fresh && from_ver < 1 { migrate_legacy_alters(conn); }
if tasks_uses_legacy_key(conn) {   // ← tasks 不存在 / 无 key 列 ⇒ false，永不执行
    ...migrate_tasks_v2_rebuild(conn)...   // ← DROP TABLE IF EXISTS tasks_new 到不了
}
```

随后 `SCHEMA` 补出**全新空表** `tasks`（结构完美）⇒ 结构检查通过 ⇒ `user_version` 盖到 4 ⇒ 此后 `schema_is_current()` 恒真，迁移永不再跑，`tasks_new` 被永久无视。

### 实测（探针构造该精确状态）

```
after-open:     tasks_visible=0  orphan_tasks_new=1  orphan_handoff="IMPORTANT HANDOFF"  user_version=4
after-2nd-open: tasks_visible=0  orphan_tasks_new=1  user_version=4
```

二次打开不自愈 —— 与「下次启动重试」的设计预期直接矛盾。

### 修法：`fresh` 短路之前先探测回收

```rust
// db.rs::open_db —— 迁移门控之前
if !table_exists(&conn, "tasks")
    && table_exists(&conn, "tasks_new")
    && table_has_column(&conn, "tasks_new", "issue_key")
{
    match conn.execute("ALTER TABLE tasks_new RENAME TO tasks", []) {
        Ok(_)  => crate::tlog!("[db] 已从崩溃残留的 tasks_new 恢复 tasks 表"),
        Err(e) => crate::tlog!("[db] 恢复残留 tasks_new 失败，保留原状待下次重试: {e}"),
    }
}
```

把 `tasks_new` 原位改名为 `tasks`，让既有迁移逻辑（`missing_columns` / `MIGRATION_DDL`）按正常路径收敛到当前 schema。

**这是恢复，不是迁移**，故**不触碰 `user_version`**（只由低往高推进，`open_db` 原有约定）。

### 两个关键设计决策

**① 为什么用 `RENAME` 而不是「复制进新建的空 `tasks`」**
`RENAME` 是 O(1) 的元数据操作、无重复存储、且天然原子（单语句隐式事务）。复制方案要多写一遍全部行，在「灾难恢复」场景里增加失败面。

**② 为什么必须加 `issue_key` 列指纹判定（实现中新发现的坑）**

第一版修复只判 `!table_exists(tasks) && table_exists(tasks_new)`，**新写的测试当场打红**：

```
open_db 必须成功: "初始化表结构失败: no such column: ownership in
CREATE INDEX IF NOT EXISTS idx_tasks_ownership ON tasks(ownership);"
```

原因是执行顺序：探测块在 `SCHEMA` **之前**，若 `tasks_new` 是个**列不全**的同名表（例如手工造的、或更早期布局的残留），`RENAME` 之后 `SCHEMA` 的 `CREATE INDEX ... ON tasks(ownership)` 会因缺列失败 → **整个 batch 回滚 → 库直接打不开**。

这比修复前更糟：原来是「看板为空但能打开」，现在变成「应用起不来」。故加 `table_has_column(conn, "tasks_new", "issue_key")` 指纹判定 —— `issue_key` 是 #155 重建后 tasks 的**标志性列**，非 tasks 表不会命中。命中失败则维持原状（空看板但可打开），下次启动仍会重试。

> 该实现细节也反证了「恢复必须发生在 `SCHEMA` 之前」这一顺序约束 —— 放晚了就会变成「先建空表、再 RENAME 失败」，恢复不了也丢不掉残留。

## 接口 / 行为变更

- **启动行为修复**：检测到崩溃残留时自动恢复 `tasks` 表，用户看板、本地手动态、session、handoff、work_branch 全部回到崩溃前状态。
- **无 schema 变更**（不新增/修改列，迁移路径完全复用既有 `missing_columns` / `MIGRATION_DDL`）。
- **无 MCP 工具签名 / i18n key 变更**。

## 数据 / Schema 变更

- **无 DDL / 列变更**。
- 运行时行为新增一条只读探测 + 一次 `ALTER TABLE … RENAME TO`（仅在检测到崩溃残留时执行；稳态下不产生任何写语句，不影响 #329 的「稳态零写锁」优化）。

## 测试 / 验收

`app/src-tauri/tests/db_test.rs` 新增 `open_db_recovers_orphaned_tasks_new_after_crash`：

- **夹具用真实 `tasks` 布局**：先 `open_db` 建正常库 → 塞数据 → `ALTER TABLE tasks RENAME TO tasks_new`，精确模拟「DROP 已提交、RENAME 未执行」，并把 `user_version` 置为最新（逼真复现「结构检查通过 ⇒ 迁移此后再不重跑」）。
  > 曾一度手写精简列名的夹具，结果测到的不是「数据丢失」而是 `SCHEMA` 索引先失败 —— 换成真实布局才测到目标行为。
- **6 组断言**：数据行恢复（1 行）/ `handoff` 完整 / **手动态 `doing` 未被默认 `todo` 覆盖** / `tasks_new` 不再残留 / 5 个关键列被补齐（`session_id` / `work_branch` / `work_dir` / `issue_state` / `account_id`）/ **二次打开幂等**（不重复恢复、不报错、数据不变）。

**反向验证**：删掉探测块后本例失败：

```
assertion `left == right` failed: 残留 tasks_new 的数据必须被恢复，不得静默丢失
test result: FAILED. 0 passed; 1 failed
```

恢复后 26 passed（25 → +1）。

已跑：`cargo test --lib` 146 passed、`cargo test --test db_test` 26 passed、`cargo fmt --check`、`cargo clippy --lib -- -D warnings`（CI 实际门禁范围）。

> 附带发现：`cargo clippy --tests` 在 `main` 上已有 **5 处**存量 error（`db_test.rs:43` 的 `== ""`、`commands.rs:2158` 的多余 `let`、`lib.rs:262` 的 items-after-test-module 等）。本 PR 未新增（修掉了自己引入的 1 处 `as i64` 冗余转换），但 CI 的 `rust-clippy` job 只跑 `--lib`，覆盖不到 —— 可作为独立议题跟进。

## 相关链接

- Issue：[#340](https://github.com/ShawnLiuSZ/task-dashboard/issues/340)
- 引入事务化与自愈的前序改动：#328（见 [`docs/issue-328-p1-data-safety.md`](./issue-328-p1-data-safety.md)）
- 源文件：[`app/src-tauri/src/db.rs`](../app/src-tauri/src/db.rs)、[`app/src-tauri/tests/db_test.rs`](../app/src-tauri/tests/db_test.rs)
- 深度 review 中发现的其余 7 个缺陷：#339 / #341 / #342 / #343 / #344 / #345 / #346
- CHANGELOG：[`docs/CHANGELOG.md`](./CHANGELOG.md)
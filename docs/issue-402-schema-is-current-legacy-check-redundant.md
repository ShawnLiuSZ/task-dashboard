# #402：`schema_is_current` 的 legacy 判据是**冗余守卫**（#396 悬空项的落实）

> 断言强度审计续篇 —— 结论性说明，**无代码变更**。
> 所属版本：v0.3.22（待发版）· 落实 [#401](https://github.com/ShawnLiuSZ/task-dashboard/issues/401) 中标注为「推测未实测」的悬空项
> 方法论见 [`methodology-assertion-strength-audit.md`](./methodology-assertion-strength-audit.md)

## 背景

[#400](./issue-400-agent-groups-helper-coupling.md) 审计 `db.rs` 时，变异 ⑤「`schema_is_current` 去掉 `!tasks_uses_legacy_key(conn)`」**存活**，我在 KB 文档里如实标注为：

> ⑤ 未深追：`REQUIRED_COLUMNS` 含 `issue_key`，legacy 布局缺列时 `missing_columns` 大概率已覆盖该判据（属**推测，未实测**，如实标注）。

**推测必须落实** —— 留着不验证，等于给审计留下一个未验证的断言，正是本系列一直在批的毛病。

## 我原先的推测是错的

先核对 `REQUIRED_COLUMNS`（`db.rs:271-282`）实际内容：

```rust
("tasks", "work_branch"), ("tasks", "author"), ("tasks", "parent_issue"),
("tasks", "sub_issues"), ("tasks", "work_dir"), ("tasks", "created_at"),
("notes", "label"), ("label_mappings", "order_index"),
("projects", "status_field_id"), ("project_statuses", "option_id"),
```

**里面没有 `issue_key`，也没有 `key`。** 我写的「`REQUIRED_COLUMNS` 含 `issue_key`」是**错的**。

## 但最终结论是：删掉它**确实不改变行为** —— 因为守卫是冗余的

### 探针一：真实 legacy 布局 + `user_version` 已被改高

用 `db_test.rs` 里 `legacy_tasks_db` 的**真实** DDL（`key TEXT PRIMARY KEY` + `gh_state` + `updated_at TEXT`）造库，插入一行，再把 `user_version` 置为 `SCHEMA_VERSION`（模拟「被人为改高 / 迁移后被回退」）。

| | `issue_key` 列 | 遗留 `key` 列 | 按 `issue_key` 查询 |
|---|---|---|---|
| 当前实现 | 0 | 1 | **失败**：`no such column` |
| 去掉判据 | 0 | 1 | **失败**：`no such column` |

**两侧完全相同。**

原因链条（逐段核对代码得出）：

```
needs_migration = !fresh && !schema_is_current(conn)
```

对 legacy 表，`missing_columns` 必然非空（缺 `work_branch` / `author` / `parent_issue` / `sub_issues` / `work_dir` / `created_at` 六列）
⇒ `schema_is_current` 为 `false`
⇒ **`needs_migration` 为 `true`，无论 `!tasks_uses_legacy_key` 在不在。**

### 真正的守卫在 `run_migrations` 里

`db.rs:498`：

```rust
fn run_migrations(conn: &Connection, fresh: bool) -> Result<bool, String> {
    ...
    if tasks_uses_legacy_key(conn) {          // ← 独立于 schema_is_current 的第二次检查
        if let Err(e) = migrate_tasks_v2_rebuild(conn) { ... }
    }
```

**同一个条件有两处独立检查**：

| 位置 | 作用 |
|---|---|
| `schema_is_current` 的 `!tasks_uses_legacy_key` | **门控短路** —— 决定是否**进入** `run_migrations` |
| `run_migrations` 的 `if tasks_uses_legacy_key` | **真正触发重建** |

删掉前者，后者仍在；且前者的门控效果由 `missing_columns` **独立补足**（对真正的 pre-#155 表）。

## 结论

> **变异 ⑤ 是一个等价变异 —— 因为守卫是刻意冗余的。**

不是「测试弱」，也不是「代码有问题」，而是**同一条件被检查两次，删掉一次不改变行为**。这类冗余本身是**好事**（纵深防御），mutation 存活正是它的表现。

方法论文档 §4 的等价变异判别清单第 ③ 条（「变异方向错」）不适用，本例属第 ② 条「等价变异」—— **且是可证明的等价**（有代码路径分析 + 探针双侧输出佐证）。

## 探针过程中的一次探针设计错误（如实记录）

第一次探针我**手工造** legacy 表，结果 `open_db` 直接失败：

```
初始化表结构失败: no such column: account_id in ...
```

第二次改从真实库把 `issue_key` 改名成 `key`，结果**两侧仍然相同** —— 我差点据此判「守卫无用」。

但那个构造**不是真正的 legacy 布局**：缺 `gh_state` / `updated_at TEXT`，`migrate_tasks_v2_rebuild` 的 `INSERT..SELECT` 读不到列 ⇒ 重建失败 ⇒ 两种情况都停留在坏状态 ⇒ **看起来等价，实际是探针错了**。

改用 `legacy_tasks_db` 的真实 DDL 后才得到上面的有效数据。

> **教训（纪律 2 的延伸）**：探针本身也要先验证。
> 「两种情况结果相同」有两种可能 —— **真的等价**，或**探针没测到差异**。
> 判别办法：**换一个更接近真实的构造再看**。若换之后差异出现，说明前一个探针无效。

## 遗留：一个我未能构造出的窄场景（如实记录）

守卫真正**不可替代**的场景是：「`key` 列仍在，但 `REQUIRED_COLUMNS` 六列**已补齐**且索引齐全」—— 即 legacy 表已被 `migrate_legacy_alters` 部分 ALTER 过、但重建未完成。

我**未能构造**这个状态：需要在 legacy 表上建立满足 `REQUIRED_INDEXES` 的索引，而这些索引引用 `issue_key`，legacy 表里没有该列（`CREATE INDEX ... ON tasks(issue_key)` 直接报 `no such column`）。

**因此我既不能断言该守卫必要，也不能断言它多余。** 已确认的只是：**对真实的 pre-#155 全量 legacy 表，它是冗余的**。

若要彻底定论，需要构造「部分 ALTER 后的 legacy 表」—— 建议作为后续独立任务，不在本轮范围内。

## 代码变更

**无。** 本 issue 是对 [#401](./issue-400-agent-groups-helper-coupling.md) 悬空项的结论性落实 —— 结论是「无需变更」。

## 相关链接

- issue [#402](https://github.com/ShawnLiuSZ/task-dashboard/issues/402)
- 落实：#401 的变异 ⑤
- 方法论：[`methodology-assertion-strength-audit.md`](./methodology-assertion-strength-audit.md)（§4 等价变异判别清单）
- 缺陷本体：#155（`tasks` 物理重建，legacy `key` → `issue_key`）
- 源文件：`app/src-tauri/src/db.rs::schema_is_current`、`run_migrations`、`REQUIRED_COLUMNS`
# #396：#340 恢复探测的 `issue_key` 指纹保护无任何测试

> 断言强度审计（mutation testing）第七轮 —— `db.rs` 迁移与恢复逻辑（本仓首次审计）。
> 所属版本：v0.3.22（待发版）· 关联 issue [#396](https://github.com/ShawnLiuSZ/task-dashboard/issues/396)

## 背景 / 动机

审 `app/src-tauri/src/db.rs` 的迁移与恢复逻辑。此前**从未审计**。

选它的理由：`db.rs` 是本仓**唯一「最坏事故类别 + 零审计」的组合** —— #340 是**永久数据丢失**：

> `tasks` 表被 DROP、`tasks_new` 保有全量数据却打不开库、版本号盖到最新、迁移此后再不重跑。

这是仓库历史最严重的缺陷类别。

### 审计前已有的覆盖

`db_test.rs` 29 例、`db.rs` 内嵌 23 例，含 `open_db_recovers_orphaned_tasks_new_after_crash`（#340 专项恢复测试）。**不是零测试**，所以要找的是**具体判据的缺口**。

## 审计范围与结果

对 8 个目标做 mutation，判定用 `cargo test` 退出码：

| # | 变异 | 结果 |
|---|---|---|
| ① | #340 恢复探测去掉 `issue_key` 指纹校验 | **存活** ← 本 issue |
| ② | 去掉 `tasks_new` 存在性判断 | 存活（**等价变异**，见下） |
| ③ | `fresh` 取反（还原 #340 本体） | 捕获 ✅ |
| ④ | `schema_is_current` 去掉缺列检查 | 捕获 ✅ |
| ⑤ | `schema_is_current` 去掉旧布局检查 | 存活 |
| ⑥ | 版本号比较 `>=` 改 `>` | 捕获 ✅ |
| ⑦ | `is_valid_board_mode` 放行任意值 | 捕获 ✅ |
| ⑧ | `is_valid_board_mode` 漏掉 `custom` | 捕获 ✅ |

⑤ 未深追：`REQUIRED_COLUMNS` 含 `issue_key`，legacy 布局缺列时 `missing_columns` 大概率已覆盖该判据（属推测，**未实测**，如实标注）。

## 发现：代码里有明确警告的保护，却完全没有测试

`open_db` 的 #340 恢复探测代码里写着：

> ⚠️ 必须确认 tasks_new **确实是 tasks 布局**才 RENAME，否则 SCHEMA 的
> `CREATE INDEX ... ON tasks(ownership)` 会因缺列而整个 batch 失败 ——
> 那比「看板为空但能打开』更糟（**库直接打不开**）。

**但这条保护没有任何测试。**

已有的 `open_db_recovers_orphaned_tasks_new_after_crash` 只覆盖**正向**情形：用**真实** tasks 布局造 `tasks_new`（含 `issue_key`），断言「应被恢复」。

> **反向情形 —— `tasks_new` 存在但并非 tasks 布局 —— 完全没有测试。**

这是与 #376 `taskSig` **完全同型**的缺口：**契约被逐字写在注释里，却只守住了契约的一半（正向），没守住另一半（反向）**。

## 后果实测（探针，两侧真实输出）

构造方式：`tasks` 改名 `tasks_new` 后 `DROP COLUMN issue_key`（先删依赖该列的索引，否则 SQLite 报 `error in index ... after drop column`）。

| | 当前实现（指纹在） | 变异（指纹去掉） |
|---|---|---|
| `open_db` | 成功 | 成功 |
| `tasks` 存在 | 1 | 1 |
| **`tasks_new` 残留** | **1（保留原状）** | **0（被 RENAME 消费掉）** |

即：

- 指纹生效 ⇒ 非布局的 `tasks_new` 被**保留原状**待下次重试（**安全侧**）
- 指纹失效 ⇒ 它被**当成 tasks 升为看板主表** —— 正是注释警告的路径

（本例中 `SCHEMA` 仍成功，因为只 `DROP` 了 `issue_key`、`ownership` 还在。若 `tasks_new` 连 `ownership` 都没有，才会走到注释警告的「库打不开」。构造完整的畸形布局成本更高，**未实测**该更坏情形，如实标注。）

## 设计 / 方案

补 1 例 `open_db_does_not_rename_nonlayout_tasks_new`，三层断言：

| 层 | 断言 | 作用 |
|---|---|---|
| 前置确认 | 此刻确实处于「tasks 缺失 + tasks_new 非 tasks 布局」 | 保证测试真的在测目标状态 |
| **核心** | `tasks_new` 必须**仍存在**（未被 RENAME 消费） | 断言消息**直接引用源码警告** |
| **反向契约** | 恢复出的 `tasks` 必须带 `issue_key` 列 | 证明它不是那张被 `DROP COLUMN` 的残表 |

第 3 层是 #376 引入的反向契约手法 —— **不只断言「该发生的发生」，也断言「不该发生的没发生」**。

## 一个存活但**不是缺陷**的变异

去掉 `&& table_exists(&conn, "tasks_new")` 仍存活 —— 这是**等价变异**：

全新库上 `tasks` 与 `tasks_new` 都不存在，而 `table_has_column(tasks_new, "issue_key")` 对不存在的表返回 `false` ⇒ 条件仍为假 ⇒ 行为一致。

记录在案，避免后人重复排查。

## 过程中我又犯了 #380 的同一个错误

用脚本做插入点替换时 anchor 只取 `fn xxx() {` 一行，上方 doc + `#[test]` 留在原地 ⇒ `duplicated attribute` + **原函数失去 `#[test]` 变成 dead code**。

**`cargo test` 当时仍通过（27 passed）**，只有 clippy 暴露。

这与 #380 **完全相同**，而我当时已把这条写进 KB 文档，本次仍重犯。

> **教训固化**：插入点替换必须**连 `#[test]` 一起锚定**（或插入后**立即**跑 `clippy --all-targets`）。
> 这也是 clippy 门禁（#366）的第二重价值 —— 不只是 lint 洁癖，而是能抓住 `cargo test` 放过的结构性错误。

## 接口 / 行为变更

无。纯测试补充。

## 数据 / Schema 变更

无。

## 测试 / 验收

- [x] `db_test` 26 → **27**
- [x] 指纹校验变异由**存活**转为**捕获**
- [x] `!table_exists(tasks)` 判据移除仍被捕获
- [x] lib 174 全绿
- [x] `cargo clippy --all-targets -D warnings` 0 error
- [x] `cargo fmt --check` 干净

## 方法论：为什么 `db.rs` 适合 mutation

尽管它依赖真实 SQLite，但**可测的是纯逻辑**：

| 目标 | 需要真实 DB？ |
|---|---|
| 迁移**门控条件**（版本号比较、`fresh`/`needs_migration`） | 否 |
| **恢复探测的可达性** | 只需构造 schema 变体（rusqlite `:memory:` 或临时文件即可） |
| `SCHEMA` 与迁移列表的一致性 | 只需读文本（`check-mcp-columns.py` 已覆盖列名部分） |

**不需要对 SQL 执行做 mutation** —— 要测的是「这段代码在什么状态下才会跑」，而 #340 的缺陷形态（自愈分支不可达）恰是可达性缺陷，**用注入「把前置条件改成永不成立」一测就暴露**。

这类问题读代码极易漏判（#384 的 `Iterator::all` 空序列为真是同族）。

## 相关链接

- issue [#396](https://github.com/ShawnLiuSZ/task-dashboard/issues/396)
- PR #397
- 缺陷本体：#340（永久数据丢失）
- 同型缺口：#376（`taskSig` 字段组断言）、#386（形态未覆盖）
- clippy 门禁：#366（本项第二次因它才抓到结构错误）
- 源文件：`app/src-tauri/src/db.rs::open_db`、`app/src-tauri/tests/db_test.rs`
# #404：`schema_is_current` 的 legacy 判据可证明**永不决定**（#402 悬空的收尾）

> 断言强度审计续篇 —— 结论性说明，**无代码变更**。
> 所属版本：v0.3.22（待发版）· 收尾 [`issue-402`](./issue-402-schema-is-current-legacy-check-redundant.md) 标注为「未能构造」的窄场景
> 方法论见 [`methodology-assertion-strength-audit.md`](./methodology-assertion-strength-audit.md)

## 背景

[#402](./issue-402-schema-is-current-legacy-check-redundant.md) 已确认「对真实 pre-#155 全量 legacy 表，legacy 判据是冗余的」，但**如实标注了一个未能构造的窄场景**：

> 守卫真正不可替代的情形是「`key` 列仍在，但 6 个 `REQUIRED_COLUMNS` **已补齐**且索引齐全」—— 我未能构造这个状态…因此我**既不能断言该守卫必要，也不能断言它多余**。

本 issue 收尾该悬空项。

## 收尾过程：三次探针才构造出「足够窄」的状态

| # | 构造 | 结果 | 是否窄 |
|---|---|---|---|
| ① | 手工造 legacy 表 | `open_db` 直接失败（缺 `account_id` 等） | 太破 |
| ② | 从真实库 `issue_key` 改名 `key` | 两侧相同（**探针无效**，非真正 legacy） | 不窄 |
| ③ | legacy DDL + 补 6 列（漏建 `idx_project_items_issue`） | 两侧相同 | 不够窄 |
| ④ | legacy DDL + 补 6 列 + **8 个索引名全建** | **两侧仍相同** | — |

第 ④ 次已经是**能构造出的最窄状态**，legacy 判据仍非决定性。于是转向**可构造性分析**。

## 决定性的结构事实：探测发生在建表之前

`open_db` 的行序（`db.rs`）：

```
426:  let fresh          = !table_exists(&conn, "tasks");
427:  let needs_migration = !fresh && !schema_is_current(&conn);   ← 探测在这里求值
438:  conn.execute_batch(SCHEMA)                                    ← 建表 / 补结构在这里
440:  if fresh || needs_migration { ... }
```

**`schema_is_current`（427 行）在 `execute_batch(SCHEMA)`（438 行）之前求值。**

而 `SCHEMA` 里的 `tasks` 是现代布局 —— **没有 `key` 列**（`db.rs:13` 起）。

## 可构造性证明

要使 `!tasks_uses_legacy_key(conn)` 成为 `schema_is_current` 返回 `false` 的**决定性因素**，需同时满足：

| 条件 | 可否满足 |
|---|---|
| `schema_version >= SCHEMA_VERSION` | ✅ 可（人为改高） |
| `missing_columns(conn).is_empty()` | 需 10 个 `(表, 列)` 全在 |
| `missing_indexes(conn).is_empty()` | 需 8 个索引名全在 |

后两者同时成立 ⇒ 该库已有**完整的现代结构**。

而 `tasks` 表拿到现代结构只有两条途径：`execute_batch(SCHEMA)` 与 `migrate_tasks_v2_rebuild` —— **两者都不创建 `key` 列**。

`key` 列只能来自 #155 之前的库；而那类库**必然**至少缺一个现代必填列或索引（这正是 `migrate_legacy_alters` 与 `MIGRATION_DDL` 存在的理由）。

> **故：对任何通过迁移流程可达的状态，`!tasks_uses_legacy_key(conn)` 都不是决定性因素。**

## 精确结论（含边界）

| 陈述 | 状态 |
|---|---|
| 该判据对**所有迁移流程可达的状态**都不是决定性因素 | ✅ **已证明** |
| 变异 ⑤「删掉它」是**等价变异** | ✅ **已证明** |
| 若有人手工 `ALTER TABLE tasks ADD COLUMN key TEXT` 造出全现代结构 + 遗留 `key` 的库，该判据会变成决定性 | ⚠️ 理论上可能，但**不是本应用会产生的状态** |

**这不是缺陷，也不建议删掉它** —— 它是**廉价的纵深防御**：

- `schema_is_current` 的注释本就写明「探测为兜底：即使版本号被人为改高或丢失，缺列/缺索引仍会触发迁移」
- 保留它让这个不变量**在两处独立成立**，符合 #402 记录的「冗余本身是好事」
- 删除它**没有任何收益**（省不到可观测成本），却会让上述理论场景失去保护

**故本次无代码变更。**

## 方法论价值（本项真正的产出）

### 1. 「存活变异」的排查有一条完整路径

```
mutation 存活
  ├─ 变异方向对吗？（纪律 2）        ← #402 排除
  ├─ 能构造出差异状态吗？（探针自验）  ← #402、#404 三次迭代
  ├─ 有第二个等价守卫吗？（代码分析）   ← #402 找到 run_migrations
  └─ 该状态可达吗？（可构造性证明）    ← 本 issue
```

**四步全过 ⇒ 判定为等价变异，并记录「为何等价」** —— 这比只写「存活」有价值得多。

### 2. 探针自验的三次迭代本身就是纪律的证据

④ 号探针已经是**能构造的最窄状态**，仍无差异。此时正确结论不是「守卫无用」，而是**转向可构造性分析**。

> **教训**：连续 N 次换构造仍无差异时，别再换构造 —— **该问「这个状态可达吗？」**

### 3. 「等价变异」也要分强弱

| 强度 | 判据 | 本例 |
|---|---|---|
| 弱等价 | 「我试了几个状态都没差异」 | ❌ 不足以下结论 |
| **强等价** | 「给出代码路径分析 + 可达性论证，任何可达状态都等价」 | ✅ 本例 |

方法论文档 §4 的等价变异清单**建议补入这一维度**，避免后人把「试不出来」当成「等价」。

## 代码变更

**无。**

## 相关链接

- issue [#404](https://github.com/ShawnLiuSZ/task-dashboard/issues/404)
- 前序：#402（等价变异结论）、#396（该变异的首次记录）
- 方法论：[`methodology-assertion-strength-audit.md`](./methodology-assertion-strength-audit.md)
- 缺陷本体：#155（`tasks` 物理重建）
- 源文件：`app/src-tauri/src/db.rs::open_db`（426–440 行序）、`schema_is_current`、`SCHEMA`
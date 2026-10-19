# #450 全量代码审查后端修复：账号契约 / 状态映射 / 迁移保列 / 拉取标志

> 关联 issue：[#450](https://github.com/ShawnLiuSZ/task-dashboard/issues/450)
> 来源：`CODE-REVIEW-2026-10-19.md`（2026-10-19 全量代码 Bug 审查）中危-1、中危-2、低危-1、低危-2
> 基线：`main` @ `v0.7.3`（842a129）
> 分支：`fix/issue-450-backend-logic`

## 一、背景 / 动机

2026-10-19 对全部源码（Rust 11 文件 / React 58 文件 / Python MCP + scripts）做了一轮系统性审查，
产出 0 高危、4 中危、7 低危。其中 4 项落在 Rust 后端，均为**真实逻辑缺陷**，不是风格问题：

| 编号 | 严重度 | 一句话 |
|---|---|---|
| 中危-1 | 中 | 会话面板把「单账号视图」当成「聚合全部」，多账号下显示全账号会话 |
| 中危-2 | 中 | Project Status 中文映射用子串匹配，把待办状态误判成「已完成」 |
| 低危-1 | 低 | 旧库迁移时 `work_dir` 被静默清空且不可恢复 |
| 低危-2 | 低 | 按需拉取在「同步抢先写入」时谎报 `pulled: true` |

## 二、设计 / 方案

### 2.1 中危-1：`list_active_sessions` 违反 #422 账号编码契约

**#422 硬规则**（AGENTS.md 账号维度约定）：

```
前端 accountId 编码：0 = 聚合全部 / null = 读 meta.active_account_id / >0 = 该账号
后端解析：          Some(0)⇒None(不过滤) / Some(n)⇒n / None⇒读 meta
```

`rows_to_tasks`（`commands.rs:199-209`）一直正确实现了该契约。但 `list_active_sessions`
（原 `:429-433`）把 `None` 与 `Some(0)` 一同归一成 `None`（不过滤）：

```rust
// 缺陷写法
let account_filter = match account_id {
    Some(0) => None,
    other => other,          // None 原样透传 ⇒ 不过滤
};
```

而它的注释却写着「与 `rows_to_tasks` 同口径」——**注释描述的是契约，实现兑现的是另一种行为**。
后果：多账号 + 前端以 `null` 调用（单账号视图）时，返回**全部账号**的活跃会话。

**方案**：抽出 `resolve_session_account_filter(conn, account_filter) -> Option<i64>`，
由 `list_active_sessions` 调用。两条读路径的语义定义收敛到**同一个函数体**，
从结构上消除再次口径漂移的可能。

> **为什么不是就地改两行**：这个缺陷此前已在 `rows_to_tasks` / `my_logins` /
> 前端 `accountFilter` 上重演过多次（见 CODE-REVIEW-2026-10-12.md 低危-3、
> 2026-09-30 版低危项）。共同特征是「注释写了契约、实现各写一份」。
> 抽函数是唯一能让两份实现无法分叉的做法。

### 2.2 中危-2：中文 Project Status 改整值全等

`map_project_status` 的中文分支全部用 `contains`：

```rust
if raw.contains("测试") { Some("processed") }
else if raw.contains("开发中") { Some("doing") }
else if raw.contains("待开发") || raw.contains("需求") || raw.contains("规划") { Some("todo") }
else if raw.contains("取消") || raw.contains("完成") || raw.contains("上线") { Some("done") }
```

子串匹配是**词级**而非**语义级**，concrete 危害：

- `等待完成` 含「完成」⇒ 判 `done`（一个待办事项被当成已完成）
- `未完成评审` 同上
- `测试中` 含「测试」⇒ 恒判 `processed`

英文分支 `map_project_status_en`（`:66-93`）早已是「归一化后整值全等」，并在注释里
专门解释了原因（`Ready for release` 不能误判 done）。两个分支口径不一致。

**方案**：中文分支同样改为归一化整值全等，拆为 `map_project_status_zh`，
与 `map_project_status_en` 并列；`map_project_status` 变为二者择一：

```rust
fn map_project_status(raw: &str) -> Option<&'static str> {
    map_project_status_zh(raw).or_else(|| map_project_status_en(raw))
}
```

归一化：折标点/emoji 为空格 → 合并空白 → 转小写。中文无空格分词问题，
折标点后直接拼接即可（`🔎开发完成/测试中` → `开发完成测试中`，已收录）。

**行为变更**：未收录的自定义中文状态现在返回 `None` ⇒ 走同步优先级第 4 条
「保持既有本地状态」，**绝不臆造映射**。这是符合契约的行为（原本返回 `Some`
才是臆造）。

> ⚠️ **连带修正了一条既有测试**：`map_project_status_returns_none_for_unlisted_values`
> 曾把 `取消键位置调整 ⇒ done` 用 `expect = Some("done")` 显式记录为
> 「contains 是词级模糊匹配的固有代价，以免被误当缺陷」。修复后该值正确变为 `None`，
> 这条例外随之移除。**该测试失败正是修复生效的证据，不是回归。**

### 2.3 低危-1：`work_dir` 随物理重建搬迁

`migrate_tasks_v2_rebuild` 的 `INSERT INTO tasks_new (...) SELECT ...` 是**写死的列清单**。
`migrate_legacy_alters`（`:784`）会给旧表补 `work_dir`，而它执行在重建**之前**
（`run_migrations:641` → `:648`）—— 补上了，但重建时不在白名单里，于是被丢弃，
退回 `tasks_new` 的 `DEFAULT ''`。

**方案**：把 `work_dir` 加进重建列清单。

`author` / `parent_issue` / `sub_issues` **有意不带**：它们是 v0.6.x 才加入的，
`user_version < 1` 的旧库从来不存在这些列，无源可取，由 `MIGRATION_DDL` 的幂等 ALTER
补默认值即可。

> 这正是本文件 `:426-431` 记录的硬约束（「新增列的 ALTER 必须写在 `MIGRATION_DDL`
> 而非 `migrate_legacy_alters`，否则会被重建丢掉」）的同型问题 —— 只是方向相反：
> 那条讲「别写错地方」，这条是「白名单漏了已在正确位置的列」。

### 2.4 低危-2：按需拉取如实报告 `Pulled`

`ensure_task_available` 末尾原为：

```rust
crate::db::write_task(conn, &row, now, TaskWriteMode::InsertIfAbsent)?;   // 返回值被丢弃
Ok(EnsureOutcome::Pulled)
```

`InsertIfAbsent` 在行已存在时返回 0 且零覆盖。若 `task_exists` 检查与本次写入之间
App 同步抢先落库，则返回 0 —— 但仍报 `Pulled`，MCP 返回 `pulled: true`，
agent 会以为「刚创建」。

**方案**：抽出 `outcome_from_affected(affected: usize) -> EnsureOutcome`，
`0 ⇒ AlreadyLocal` / `≥1 ⇒ Pulled`。抽成独立函数是因为 `ensure_task_available`
需要网络，单测跑不通，而这个决策点本身值得被锁住。

**数据正确性未受影响**：`DO NOTHING` 仍然零覆盖，`project_status` / `mentioned` /
`pr_*` 不会被清空。本次只修标志位说谎。

## 三、接口 / 行为变更

| 对象 | 变更 |
|---|---|
| `list_active_sessions` | 行为修复：`account_id = None` 现在回落到 `meta.active_account_id`（多账号下不再显示全账号会话） |
| `map_project_status` | 行为变更：中文分支从子串匹配改为整值全等。未收录的中文状态从「猜一个」变为 `None`（保持本地手动态） |
| `migrate_tasks_v2_rebuild` | 修复 `user_version < 1` 旧库迁移时 `work_dir` 被清空 |
| `ensure_task_available` | `pulled` 标志如实反映是否真写入 |

**Tauri command 签名、SQL、MCP 工具集、DB schema、i18n 全部零改动。**

## 四、数据 / Schema 变更

无 schema 变更。仅修正 `migrate_tasks_v2_rebuild` 内既有 SQL 的列清单
（`REBUILD_SQL` 常量），不改 `SCHEMA`、不改 `SCHEMA_VERSION`。

## 五、测试 / 验收

新增/修改 5 组测试：

| 测试 | 作用 |
|---|---|
| `sync::tests::chinese_status_substring_traps_are_not_falsely_done` | 新增。`等待完成`/`未完成评审`/`开发完成了吗` 不得判 done |
| `sync::tests::chinese_and_english_branches_share_exact_match_semantics` | 新增。两分支口径统一 |
| `sync::tests::map_project_status_returns_none_for_unlisted_values` | **修改**。移除「记录 contains 缺陷现状」的例外分支 |
| `commands::tests::session_account_filter_follows_422_encoding` | 新增。三态编码逐条钉死 |
| `commands::tests::session_account_filter_actually_filters_rows` | 新增。锁「解析 → 行过滤」完整链路 |
| `on_demand::tests::insert_if_absent_zero_must_not_report_pulled` | 新增。0 行不得报 `Pulled` |
| `db::tests::tasks_v2_rebuild_heals_leftover_tasks_new` | **修改**。建表与断言补 `work_dir` |
| `account-filter.test.ts`（前端静态守卫） | **修改**。#422 口径断言从 `list_active_sessions` 函数体搬到 `resolve_session_account_filter`，并新增「`None` 分支必须读 meta、不得直接透传」的防线 |

### 反向验证（非恒真断言）

| 断言 | 旧实现下的结果 |
|---|---|
| `map_project_status("等待完成") == None` | 旧实现返回 `Some("done")` ⇒ **失败** |
| `map_project_status("未完成评审") == None` | 旧实现返回 `Some("done")` ⇒ **失败** |
| `map_project_status("取消键位置调整") == None` | 旧实现返回 `Some("done")` ⇒ **失败** |
| `resolve_session_account_filter(conn, None) == Some(active)` | 旧实现返回 `None` ⇒ **失败** |
| 重建后 `work_dir == "/Users/dev/work/repo"` | 旧实现得空串 ⇒ **失败** |
| `outcome_from_affected(0) != Pulled` | 旧实现恒 `Pulled` ⇒ **失败** |

### 已跑校验

```
cargo fmt --check                                ✅
cargo clippy --lib -p taskboard -- -D warnings   ✅（零警告）
cargo test -p taskboard                          ✅（202 + 27 passed）
npx vitest run                                   ✅（318 passed）
npx tsc --noEmit                                 ✅
npm run lint                ✅（--max-warnings 0，脚本内建）
npx prettier --check                              ✅
npm run i18n:check                                ✅
python3 scripts/check-mcp-columns.py             ✅
python3 scripts/check-doc-links.py               ✅
```

## 六、相关链接

- Issue：[#450](https://github.com/ShawnLiuSZ/task-dashboard/issues/450)
- 审查报告：`CODE-REVIEW-2026-10-19.md`
- CHANGELOG：[`docs/CHANGELOG.md`](./CHANGELOG.md) → `v0.7.4（未发布）`
- 相关约定：AGENTS.md §2.2（同步优先级）、§账号维度约定（#422）
- 相关历史：[#438](https://github.com/ShawnLiuSZ/task-dashboard/issues/438)（sync stale 回源确认，本次修的是它遗留的 `map_project_status` 子串问题）
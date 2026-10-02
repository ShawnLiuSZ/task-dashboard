# #356 仅经 Project 发现的 issue，`updated_at` 恒为 0 导致卡片日期永久空白

> 对应 issue：[#356](https://github.com/ShawnLiuSZ/task-dashboard/issues/356)
>
> 分支：`fix/issue-356-project-issue-updated-at`
>
> 类别：Rust 后端 / GitHub 只读同步 / 数据完整性

## 背景 / 动机

深度 review（#339–#346 批次）的遗留项之一。现象：**仅通过 Project 被发现的 issue，卡片上的日期永久空白**，详情面板显示 epoch 0；而经 Search 同步过的 issue 正常。

## 设计 / 方案

### 根因：查询未选字段 + 落库写死空串（双重）

`github.rs::fetch_project_issues` 构造 `RawTask` 时写死：

```rust
updated_at: String::new(),   // 恒空
```

而 GraphQL 项目条目查询**根本没有选取 `updatedAt`**（`github.rs:1165` 的 issue 分支字段列表里只有 `number title url state` 等）。

链路：`iso8601_to_secs("")` 返回 `0`（`common.rs`：`len < 19` 直接返回 0）⇒ `TASK_CONFLICT_UPDATE` 写 `updated_at = excluded.updated_at` ⇒ **每次同步都把 0 又写回去**。

为何只影响 Project 来源：若该 issue 同时也被 Search 命中，Search 结果会用真实时间戳覆盖；但**只经 Project 发现的 issue 永远为 0**（`sync.rs` 会把 Project 来源合并进同一批 `pending`）。前端 `TaskCard` 用 `task.updatedAt ? ... : ''` 渲染，空值即整块不显示。

### 修法

1. 项目条目查询的 issue 分支补选 `updatedAt`。
2. `RawTask.updated_at` 取该字段值。

顺带把内联的查询串与字段读取**抽成两个纯函数**（`project_items_query` / `project_item_updated_at`），沿用 #327 `org_projects_query` 的既有做法，让「查询形状」和「字段容错」可被单测锁定 —— 这正是本缺陷能长期潜伏的原因：查询串内联在网络函数里，没有任何测试能看到它选了什么字段。

## 接口 / 行为变更

- **UI 行为修复**：仅经 Project 发现的 issue 现在会显示正确的更新日期。
- **数据变更**：存量库中 `updated_at = 0` 且来源为 Project 的行，会在下次同步时被真实 `updatedAt` 修正（无需专门迁移 —— 同步的 Upsert 每次都会刷新该列）。
- **仍为只读**：不新增任何对 GitHub 的写操作（`AGENTS.md §2.1` 单向流动约束不变）。
- **无 schema / MCP 工具签名 / i18n key 变更**。

## 数据 / Schema 变更

- 无 DDL / 列变更。
- 运行时数据：`tasks.updated_at` 对 Project 来源的行从「恒 0」变为「真实值」（由既有同步路径写入，非迁移）。

## 测试 / 验收

`app/src-tauri/src/github.rs` 新增 2 例：

1. `project_items_query_selects_updated_at` — 断言查询串包含 `updatedAt`，且它**落在 Issue 分支内**（`PullRequest` 分支不需要）；并断言分页游标仍被注入（抽成纯函数后不能漏 `after`）。
2. `project_item_updated_at_tolerates_missing_and_null` — 断言真实 RFC3339 值原样返回；缺失 / `null` / 非字符串三种情况均回落空串（不 panic，与该文件既有容错一致）；并断言真实值能被 `iso8601_to_secs` 转成**非 0 秒**（否则卡片日期仍为空）。

**反向验证**：从查询串删掉 `updatedAt`（模拟「忘记在查询里选字段」这一回归）后，用例 1 失败；恢复后 152 passed。

已跑：`cargo test --lib` 152 passed、`cargo fmt --check`、`cargo clippy --lib -- -D warnings`、`scripts/check-mcp-columns.py`。

## 相关链接

- Issue：[#356](https://github.com/ShawnLiuSZ/task-dashboard/issues/356)
- 抽纯函数的先例：[`app/src-tauri/src/github.rs`](../app/src-tauri/src/github.rs) 的 `org_projects_query`（#327）

- 本批其余项：[#355](./issue-355-require-affected-remaining-writes.md) / [#357](./issue-357-mcp-framing-and-args.md) / [#358](./issue-358-issue-url-anchor.md) / [#359](./issue-359-tooling-hygiene.md)
- CHANGELOG：[`docs/CHANGELOG.md`](./CHANGELOG.md)
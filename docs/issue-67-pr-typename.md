# Project V2 中的 PR 被当作 issue 上板（#67）

> 关联：[Issue #67](https://github.com/ShawnLiuSZ/task-dashboard/issues/67)、[docs/CHANGELOG.md](./CHANGELOG.md)

## 背景 / 动机

二次 bug 审计发现 `fetch_project_issues`（同步 Project V2 中的 issue 到看板）用以下字段判断一条条目是否为 PR：

```rust
if content.get("pull_request").is_some()
    || content.get("mergedAt").is_some()
    || content.get("headRefOid").is_some()
```

但对应的 GraphQL 查询中，`... on PullRequest` 内联片段只选取了 `number title url state repository`，**并未选取 `pull_request` / `mergedAt` / `headRefOid` 中任何一个字段**。因此这三个字段在响应里恒不存在，判断恒为假 → PR 永远不会被跳过 → Project V2 中的 PR 被当作 issue 抓上看板，产生不属于 issue 的噪声任务。

## 设计 / 方案

改用 GraphQL 标准内省字段 `__typename` 判型，可靠且与查询选取强一致：

1. GraphQL 查询在 `content` 公共区新增一行 `__typename`。
2. 循环内判型改为：

```rust
if content["__typename"].as_str() == Some("PullRequest") {
    continue;
}
```

`__typename` 对每个具体类型都有确定值（`Issue` / `PullRequest` / …），只要查询选取必返回，判断不会因缺字段而失效。

## 接口 / 行为变更

- 无 Tauri command / MCP 工具 / Schema 变更。
- 行为变化：Project V2 中的 PR 不再被当作 issue 上板；issue 判定逻辑不变。

## 数据 / Schema 变更

无。

## 测试 / 验收

- `cargo check` 通过。
- `cargo test`：13 passed；2 failed（`insert_account_validates_required_fields`、`delete_account_blocks_default_and_orphan_task_id_kept` 为基线已有失败，与本次改动无关）。
- 手工验收点（需真实 Project V2 数据）：
  - Project 中同时含有 issue 与 PR 时，同步后 PR 不出现在看板，issue 正常上板
  - 含 PR 的条目不进入 status_map（不占用自定义列/Project 列）

## 相关链接

- [Issue #67](https://github.com/ShawnLiuSZ/task-dashboard/issues/67)
- [docs/CHANGELOG.md](./CHANGELOG.md) v0.3.32
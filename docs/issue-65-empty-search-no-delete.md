# 空搜索结果误删看板任务修复（#65）

> 关联：[Issue #65](https://github.com/ShawnLiuSZ/task-dashboard/issues/65)、[docs/CHANGELOG.md](./CHANGELOG.md)

## 背景 / 动机

2026-09-06 二次全量 bug 审计发现：当 GitHub Search API 返回 422 Validation Failed（限定的 repo 限定符引用不可访问资源）时，`search()` 以 `break` 结束并把「空结果」当作 `Ok(vec![])` 返回，调用方的 best-effort 合并逻辑无法区分「真的没有任务」和「这次没查到」。

当**部分** search 源（assignee / author / mentions / commenter / involves 之一）因 422 漏掉了真实关联任务时：
- 该任务未被拉进本次同步 → 被标记 `stale = 1`
- stale 清理阶段 `fetch_state` 查到该 issue 仍 open → 走「移出看板」**DELETE 分支**
- 但 `fetch_state` 只能确认 issue 是否关闭，**无法确认任务是否还「属于我」** → 真实关联任务被误删

> 注：`lists.is_empty()` 早退保护只挡「5 个源全失败」；部分源失败时上述误删真实存在。

## 设计 / 方案

双保险修复：

### #65a · `search()` 422 不再伪装成空结果

`github.rs::search()`：
- 首包 422 → 由 `break`（返回 `Ok(vec![])`）改为 `return Err(...)`
- 限流重试后仍 422 / 非 2xx → 同样 `return Err(...)`

这样「搜索源失败」进入 `sync.rs` 的 `failed` 记录，调用方 best-effort 降级逻辑不变（该源跳过、其余源照常），但下游能感知搜索链路不完整。

### #65b · 搜索源不完整时 stale 清理不前移删除

`sync.rs::sync_account()` stale 清理循环：
- 新增 `let sources_incomplete = !failed.is_empty()`
- 命中 `fetch_state == "closed"` → 依旧标 candidate_done（issue 确实关闭，无风险，照常处理）
- 命中仍 open 且 `sources_incomplete` → **不 DELETE**，仅 `UPDATE tasks SET stale = 0` 解除 stale、保留本地记录并打印日志
- 命中仍 open 且搜索完整（无失败源）→ 维持原 DELETE 「移出看板」行为

## 接口 / 行为变更

- 无 Tauri command / MCP 工具 / Schema 变更。
- 行为变化仅在「搜索源失败」的降级路径下：仍 open 的任务不再被移出看板，而是保留并解除 stale；确认关闭的仍正常标记已完成。

## 数据 / Schema 变更

无。

## 测试 / 验收

- `cargo check` 通过。
- `cargo test`：13 passed；2 failed（`insert_account_validates_required_fields`、`delete_account_blocks_default_and_orphan_task_id_kept` 为基线已有失败，与本次改动无关）。
- 手工验收点：
  - 配置造成 Search API 422 的查询（如失效 repo 限定符）后同步：
    - 同步不中断，不再有 open 任务被移出看板
    - 看板仍保留原有任务与其手动态
  - 全源正常时，stale 清理的「移出看板」行为与之前一致（仍 open 且不再相关的任务能正常清除）

## 相关链接

- [Issue #65](https://github.com/ShawnLiuSZ/task-dashboard/issues/65)
- [docs/CHANGELOG.md](./CHANGELOG.md) v0.3.30
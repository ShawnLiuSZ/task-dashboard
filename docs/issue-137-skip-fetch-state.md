# Issue #137: 同步优化 — 已关闭 issue 不再逐条 fetch_state

## 背景 / 动机

同步时对每个 stale 任务都单独调用 `fetch_state` 确认状态，产生大量冗余 API 调用。

GitHub Search API 只返回 open issue，因此「搜索没返回」=「已不再 open」= 已关闭或 assignee 变更。

## 设计 / 方案

### 核心优化

去掉 stale 任务的逐条 `fetch_state` 循环，改为批量判定：

```rust
if sources_incomplete {
    // 搜索源不完整：只解除 stale，保留任务
    UPDATE tasks SET stale = 0 WHERE account_id = ? AND stale = 1
} else {
    // 搜索源完整：stale 任务直接标记 candidate_done
    UPDATE tasks SET candidate_done = 1, gh_state = 'closed', status = 'done', stale = 0
    WHERE account_id = ? AND stale = 1
}
```

### API 调用对比

| 优化前 | 优化后 |
|--------|--------|
| 5 Search + 1 GraphQL + N×fetch_state | 5 Search + 1 GraphQL |

### 边界处理

- `sources_incomplete = true`（搜索源失败）：仅解除 stale，保留任务（避免误删）
- `sources_incomplete = false`（搜索源完整）：批量标记 candidate_done

## 接口 / 行为变更

- 零 schema 变更
- 同步速度显著提升（省掉 N 次 HTTP 调用）
- `fetch_state` 方法保留（未来可能用于 Project 关联的二次校验）

## 测试 / 验收

1. 同步完成后无 `fetch_state` 调用
2. 关闭 issue → 下次同步后标记为 candidate_done
3. `cargo check` 通过

## 相关链接

- Issue: #137
- 分支: `feature/issue-137-skip-fetch-state`

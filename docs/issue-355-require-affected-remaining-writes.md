# #355 `clear_session` / `record_handoff` 未守 0 行守卫，GUI 返回成功却什么都没改

> 对应 issue：[#355](https://github.com/ShawnLiuSZ/task-dashboard/issues/355)
>
> 分支：`fix/issue-355-require-affected-remaining-writes`
>
> 类别：Rust 后端 / Tauri command（写路径一致性）

## 背景 / 动机

深度 review（#339–#346 批次）的遗留项之一。GUI 侧调用 `clear_session` / `record_handoff` 时，若传入的 `issue_key` 在本地不存在，**返回 `Ok`**（前端显示成功）**但什么都没改**；而 MCP 侧同名工具会正确报「任务不存在」—— 两侧行为不一致。

## 设计 / 方案

### 根因：#328 的 0 行守卫只覆盖了 5 条写路径里的 3 条

`#328` 引入 `common::require_affected(n, key)`，把「0 行受影响」翻译成「任务不存在」错误。但：

| 写路径 | #328 后是否守 `require_affected` |
|---|---|
| `update_task_status` | ✅ `commands.rs:315` |
| `record_session` | ✅ `commands.rs:346` |
| `set_work_branch` | ✅ `commands.rs:375` |
| **`clear_session`** | ❌ 直接 `?` 丢弃 `clear_task_session` 的返回值 |
| **`record_handoff`** | ❌ 直接 `?` 丢弃 `record_task_handoff` 的返回值 |

MCP 侧全部经 `mcp.rs:252` 的 `write_with_on_demand`，因此**都会报错**。

可达性并非理论：GUI 传的 `task.issueKey` 来自列表快照，而 `sync.rs` 会硬 `DELETE` 30 天前的 `done` 行、仓库改名也会改 `issue_key` —— 长窗口下陈旧 key 是常态。

### 修法

两处均改为先接返回值、再过守卫：

```rust
let n = crate::common::clear_task_session(&conn, &key)?;
crate::common::require_affected(n, &key)?;
```

## ⚠️ 顺带修掉一个**本来就失效**的防回归测试

`write_commands_check_affected_rows` 是 #328 留下的静态守卫，本次发现它**根本测不出东西**：

```rust
let needle = ["crate::common::", "require_affected("].concat();
let guarded = src.matches(&needle).count();
assert!(guarded >= 3, ...);
```

两个缺陷：

1. **计数包含测试代码自身**。`mod tests` 里也有同样的 `require_affected(` 调用，把计数抬高到阈值之上。
2. **阈值恰好等于当时的实数**，且用 `>=` 而非 `==` —— 「又漏掉一条」时计数不降，断言反而测不出。

**实测证据**：本次先按原样把阈值提到 5，做反向验证（删掉 `clear_session` 的守卫）时 **用例仍然通过** —— 删掉后实测 9 处（含测试自身），仍 ≥ 5。这才发现原测试是坏的。

修法：过滤掉注释行、**在 `mod tests {` 处截断**，并改用 `assert_eq!(…, 5)` 精确断言。修正后反向验证如实失败：

```
assertion `left == right` failed: …都应恰好有一处 require_affected，实测 4 处
test result: FAILED. 0 passed; 1 failed
```

> 这条教训适用于所有「用源码静态断言做防回归」的写法：**断言体自身若包含被计数的模式，计数即被污染**。仓库内还有若干同类静态断言（`panel-wiring.test.ts` 用 `?raw`），本次未逐一审计。

## 接口 / 行为变更

- `clear_session` / `record_handoff` 两个 Tauri command：key 不存在时由 `Ok` 改为 `Err("任务不存在: {key}")`，且**不再发出 `TASKS_CHANGED_EVENT`**（此前即使没改动也会广播，误导其他窗口刷新）。
- 与 MCP 侧行为对齐。
- **无 schema / MCP 工具签名 / i18n key 变更**。

## 数据 / Schema 变更

无。

## 测试 / 验收

`app/src-tauri/src/commands.rs` 新增 1 例 + 修正 1 例：

- **新增 `clear_session_and_record_handoff_reject_missing_key`（行为回归）**：在内存库建最小 `tasks` 表，断言
  - 存在的 key：`require_affected` **不误伤**（守卫只拦 0 行，不拦正常写入）
  - 不存在的 key（含空串、`garbage`）：`clear_task_session` 与 `record_task_handoff` 均被翻译成含「任务不存在」的 `Err`
- **修正 `write_commands_check_affected_rows`（静态守卫）**：见上。

**反向验证**：删掉 `clear_session` 的守卫后用例失败（`实测 4 处`）；恢复后 151 passed。

已跑：`cargo test --lib` 151 passed（150 → +1）、`cargo fmt --check`、`cargo clippy --lib -- -D warnings`。

## 相关链接

- Issue：[#355](https://github.com/ShawnLiuSZ/task-dashboard/issues/355)
- 引入该守卫的前序改动：#328（见 [`docs/issue-328-p1-data-safety.md`](./issue-328-p1-data-safety.md)）
- 源文件：[`app/src-tauri/src/commands.rs`](../app/src-tauri/src/commands.rs)、[`app/src-tauri/src/common.rs`](../app/src-tauri/src/common.rs)

- 本批其余项：[#356](./issue-356-project-issue-updated-at.md) / [#357](./issue-357-mcp-framing-and-args.md) / [#358](./issue-358-issue-url-anchor.md) / [#359](./issue-359-tooling-hygiene.md)
- CHANGELOG：[`docs/CHANGELOG.md`](./CHANGELOG.md)
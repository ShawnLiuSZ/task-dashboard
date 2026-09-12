# Issue #212：清死代码 warning

## 背景 / 动机

`tauri dev` 常驻 `fetch_state is never used`（另 `cargo test` 下测试代码 `unused conn`）。对应 issue：[#212](https://github.com/ShawnLiuSZ/task-dashboard/issues/212)。

## 设计 / 方案

- `github.rs`：删除 `fetch_state`（被"批量标记 candidate_done"优化替代，零调用方）
- `sync.rs` 测试：删除被 shadow 的重复 `Connection::open` 行

## 接口 / 行为变更

无（删未使用代码）。

## 数据 / Schema 变更

无。

## 测试 / 验收

- `cargo check` 零 warning；`cargo test` 67 + 19 passed

## 相关链接

- Issue：[#212](https://github.com/ShawnLiuSZ/task-dashboard/issues/212)
- 分支：`fix/issue-212-dead-code-warnings`

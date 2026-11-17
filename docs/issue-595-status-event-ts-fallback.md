# issue-595：set_task_status unwrap_or(0) 时间戳兜底 0 —— 记录为可接受

> 关联：[#595](https://github.com/ShawnLiuSZ/task-dashboard/issues/595) ｜ 2026-11-17 全量核查报告 低危-11

## 背景 / 动机

`app/src-tauri/src/common.rs::set_task_status`（:347-350）的 `now` 计算：

```rust
let now = std::time::SystemTime::now()
    .duration_since(std::time::UNIX_EPOCH)
    .map(|d| d.as_secs() as i64)
    .unwrap_or(0);
```

`.unwrap_or(0)`：`SystemTime::now().duration_since(UNIX_EPOCH)` 失败（仅发生在系统时钟
早于 1970 的极端场景，如时钟回拨到 epoch 前）会把 `status_events.created_at` 记成 0。

## 设计 / 方案

**记录为可接受**（文档/注释，非行为变更）：

- 0 时间戳只影响 P1 最小度量的时间维度**排序**，不反噬状态写入主流程（度量失败本就
  只 `eprintln!`，见 `:352`）。
- 不改 `now` 计算（避免为极端场景引入复杂错误处理），后续若度量对时间戳敏感再统一处理。
- 补注释说明该兜底的触发条件（时钟早于 1970）与影响范围（仅度量排序）。

## 接口 / 行为变更

- 无（纯注释，不改 `now` 计算）。

## 测试 / 验收

- `cargo check --manifest-path app/src-tauri/Cargo.toml` 通过（注释变更编译正常）。
- `cargo test --manifest-path app/src-tauri/Cargo.toml` 既有用例不回归（行为不变）。

## 相关链接

- Issue：[#595](https://github.com/ShawnLiuSZ/task-dashboard/issues/595)
- 核查报告：`CODE-REVIEW-2026-11-17.md`（低危-11）
- 既有：P1 最小度量（`status_events` 记录流转）

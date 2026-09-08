# Issue #135: 同步日志触发类型区分

## 背景 / 动机

同步日志「触发」列当前全部显示「自动」，无法区分手动触发和自动触发的同步，排查时造成困惑。

## 设计 / 方案

### 触发类型定义

| 类型 | 说明 | 来源 |
|------|------|------|
| `auto` | 定时同步 | lib.rs 定时循环 |
| `startup` | 启动时自动同步 | lib.rs 启动 2s 延迟 |
| `manual` | 用户手动触发 | 菜单/托盘「立即同步」、前端按钮 |

### 改动

1. **Rust 侧**：`sync::run()` 和 `lib::run_sync()` 添加 `trigger_type: &str` 参数
2. **调用方传参**：
   - `lib.rs` 菜单 "sync" → `"manual"`
   - `lib.rs` 启动延迟 → `"startup"`
   - `lib.rs` 定时循环 → `"auto"`
   - `commands::sync_now()` → `"manual"`
3. **前端**：`SyncLogsPanel` 添加触发类型映射显示

### 数据库

零改动。`sync_logs.trigger_type` 字段已存在，历史数据不受影响。

## 接口 / 行为变更

- `sync::run(conn)` → `sync::run(conn, trigger_type)`
- `lib::run_sync(app)` → `lib::run_sync(app, trigger_type)`
- 同步日志「触发」列现在正确显示：自动 / 手动 / 启动

## 测试 / 验收

1. 启动 App → 日志显示「启动」
2. 等待定时同步 → 日志显示「自动」
3. 点击「立即同步」→ 日志显示「手动」
4. `cargo check` / `npx tsc --noEmit` 通过

## 相关链接

- Issue: #135
- 分支: `feature/issue-135-sync-trigger-type`

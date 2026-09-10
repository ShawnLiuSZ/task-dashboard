# run_sync 并发同步去重（#69）

> 关联：[Issue #69](https://github.com/ShawnLiuSZ/task-dashboard/issues/69)、[docs/CHANGELOG.md](./CHANGELOG.md)

## 背景 / 动机

`run_sync` 有多个并发触发入口：

- 托盘 Tray「立即同步」→ `thread::spawn(run_sync)`
- 应用启动后 2s → `run_sync`
- 定时自动同步（按 `schedule_minutes`）→ `run_sync`
- 前端按钮 → `commands::sync_now`（`spawn_blocking` + `sync::run`）

这些入口互不感知，可并发触发。`run_sync` / `sync::run` 会在**持有 `db: Mutex<Connection>` 期间执行全量同步（5 次 Search API + 1 次 GraphQL，5~15s）**，并发触发时：

- 多个同步在 `db` 锁上排队，背靠背跑多次全量同步；若网络/限流超时，会粘滞多轮。
- 持锁期间任何前端 DB 访问（读任务、刷新）都被阻塞，UI 卡顿。

## 设计 / 方案

在 `AppState` 增加去重标志 `syncing: AtomicBool`，统一收口所有入口：

- 新增 `pub(crate) SyncGuard<'a>`：`acquire()` 用 `swap(true, SeqCst)` 抢占；已在跑返回 `None`（去重跳过）；`Drop` 时复位 `false`，保证函数**任何提前 return / 异常路径**都释放。
- `run_sync` 开头 `let _in_progress = SyncGuard::acquire(&state.syncing)?;`（`None` 即跳过）。
- `commands::sync_now` 同样 `crate::SyncGuard::acquire(&st.syncing)`，已在跑返回 `Err("已有同步进行中，请稍后再试")`。

同一把标志覆盖全部入口：任一同步在跑，其余触发要么跳过（自动路径）要么报「进行中」（手动按钮）。

## 接口 / 行为变更

- 自动同步（Tray / 启动 / 定时）：已有同步在跑时**静默跳过**本次，不排空、不报错。
- 手动 `sync_now`：已有同步在跑时返回错误「已有同步进行中，请稍后再试」。
- 无 Schema / Command 参数变更。

## 数据 / Schema 变更

无。`AppState` 新增一个运行时 `AtomicBool` 字段（非持久化）。

## 测试 / 验收

- 新增单测 `sync_guard_dedupes_concurrent_acquisition`（[lib.rs](../app/src-tauri/src/lib.rs)）：
  - 首次 `acquire` 成功
  - guard 持有期间再次 `acquire` 返回 `None`（去重）
  - 释放后可再次 `acquire`，且标志复位
- `cargo check` 通过；`cargo test` lib 23 passed（含新用例）、0 failed；仅 `db_test` 两个基线失败无关。

手工验收点：

- 同步进行中连续点多次「立即同步」/前端按钮：其余触发被跳过或返回「进行中」，不叠加全量同步。
- 单次同步结束后，后续触发恢复正常。

## 相关链接

- [Issue #69](https://github.com/ShawnLiuSZ/task-dashboard/issues/69)
- [docs/CHANGELOG.md](./CHANGELOG.md) v0.3.35
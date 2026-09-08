# Issue #134: 同步日志自动清理改为 30 天 + 新增清理全部按钮

## 背景 / 动机

同步日志自动清理窗口 7 天太短，且缺少一键清空所有日志的入口。

## 设计 / 方案

### 1) 自动清理窗口：7 天 → 30 天

- `db.rs::prune_sync_logs` 中 `seven_days_secs` 改为 `thirty_days_secs = 30 * 24 * 60 * 60`
- 触发时机不变：每次同步成功后自动执行

### 2) 新增「清理全部日志」后端 command

```rust
pub fn clear_sync_logs(conn: &Connection) -> Result<usize, String> {
    let n = conn.execute("DELETE FROM sync_logs", [])
        .map_err(|e| format!("清空同步日志失败: {e}"))?;
    Ok(n)
}
```

- 注册到 `lib.rs`
- 前端 `api.ts` 新增 `clearSyncLogs()` 封装

### 3) SyncLogsPanel 双按钮布局

- 「清理过期日志」：保留原有功能
- 「清理全部日志」：新增，点击后二次确认（`window.confirm`）
- 使用 `btn ghost` 样式区分危险操作

### 4) i18n 新增 key

- `syncLogs.pruneExpired` = "清理过期日志" / "Prune expired logs"
- `syncLogs.clearAll` = "清理全部日志" / "Clear all logs"
- `syncLogs.clearAllConfirm` = 确认文案

## 接口 / 行为变更

- 新增 Tauri command `clear_sync_logs`
- `prune_sync_logs` 签名不变，仅内部常量改值
- 数据库零改动

## 测试 / 验收

1. 同步一次 → 31 天前的旧日志被自动淘汰，30 天内保留
2. SyncLogsPanel 显示两个按钮：清理过期 + 清理全部
3. 点「清理全部日志」→ 二次确认 → 删光全部
4. `cargo check` / `npx tsc --noEmit` / `npm run i18n:check` 通过

## 相关链接

- Issue: #134
- 分支: `feature/issue-134-sync-logs-cleanup`

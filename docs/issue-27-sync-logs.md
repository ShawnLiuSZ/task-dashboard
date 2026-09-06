# Issue #27 同步日志功能

## 背景 / 动机

**对应 Issue**：[GitHub #27](https://github.com/ShawnLiuSZ/task-dashboard/issues/27)

**问题**：同步操作（定时/手动）执行后，用户无法查看同步历史和错误详情，难以排查「部分账号失败 / 422」等问题。

**目标**：记录同步日志，支持 App 内查看，并保留 7 天后自动清理。

## 设计 / 方案

### 数据存储

- 新增 `sync_logs` 表，与现有 SQLite 数据库一致
- 本地存储，绝不写回 GitHub
- 表结构包含：account_id, trigger_type, started_at, finished_at, status, added/updated/removed/candidate_done/pruned 计数, failed_sources, error_message

### 日志记录时机

- 同步开始时：为每个目标账号插入一条日志（trigger_type="auto"）
- 同步完成时：更新日志状态（success/failed）和统计数据
- 每次同步后：自动清理超过 7 天的旧日志

### UI 设计

- 顶栏新增「同步日志」按钮
- 弹窗展示最近 100 条同步记录
- 表格列：时间、触发方式、耗时、状态、新增/更新/移除数量、错误信息
- 支持手动清理过期日志

## 接口 / 行为变更

### Tauri 命令

| 命令 | 说明 |
|------|------|
| `list_sync_logs` | 列出同步日志（最近 N 条），按 created_at 降序 |
| `prune_sync_logs` | 清理超过 7 天的同步日志 |

### 前端 API

```typescript
api.listSyncLogs(limit?: number)  // 返回 SyncLog[]
api.pruneSyncLogs()               // 返回清理数量
```

### 类型定义

```typescript
interface SyncLog {
  id: number;
  accountId: number;
  triggerType: string;
  startedAt: number;
  finishedAt: number;
  status: string;
  added: number;
  updated: number;
  removed: number;
  candidateDone: number;
  pruned: number;
  failedSources: string;
  errorMessage: string;
  createdAt: number;
}
```

## 数据 / Schema 变更

### 新增表：sync_logs

```sql
CREATE TABLE IF NOT EXISTS sync_logs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id     INTEGER NOT NULL,
  trigger_type   TEXT NOT NULL DEFAULT 'auto',
  started_at     INTEGER NOT NULL,
  finished_at    INTEGER NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'running',
  added          INTEGER NOT NULL DEFAULT 0,
  updated        INTEGER NOT NULL DEFAULT 0,
  removed        INTEGER NOT NULL DEFAULT 0,
  candidate_done INTEGER NOT NULL DEFAULT 0,
  pruned         INTEGER NOT NULL DEFAULT 0,
  failed_sources TEXT NOT NULL DEFAULT '',
  error_message  TEXT NOT NULL DEFAULT '',
  created_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sync_logs_account ON sync_logs(account_id);
CREATE INDEX IF NOT EXISTS idx_sync_logs_created ON sync_logs(created_at);
```

### 自动迁移

- 通过 `db.rs::open_db` 的 `SCHEMA` 常量自动创建表
- 无需手动迁移脚本

## 测试 / 验收

### 验收标准

- [x] 每次同步后有日志记录
- [x] App 内可查看同步历史
- [x] 日志含成功/失败统计与错误信息
- [x] 任一日志在写入满 7 天后不再出现在列表（被清除）
- [x] 支持手动清理过期日志

### 测试方法

1. 启动应用，执行一次同步
2. 点击顶栏「同步日志」按钮
3. 验证日志记录显示正确的时间、状态、统计数据
4. 验证错误日志显示错误信息
5. 手动点击「清理过期日志」按钮
6. 验证超过 7 天的日志被清理

## 相关链接

- **Issue**：[GitHub #27](https://github.com/ShawnLiuSZ/task-dashboard/issues/27)
- **分支**：`feature/issue-27-sync-logs`
- **PR**：待创建
- **CHANGELOG**：见 `docs/CHANGELOG.md` v0.3.23 条目

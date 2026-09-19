# Issue #280：任务卡片显示创建时间

## 背景 / 动机

任务卡片在展示「创建人」和「分配人」之间缺少时间维度信息。用户需要知道 issue 是什么时候创建的，
便于判断任务的新鲜度。[Issue #280](https://github.com/ShawnLiuSZ/task-dashboard/issues/280)。

## 设计 / 方案

在卡片元信息行中，创建人下方、分配人上方插入一行「创建于」，显示 issue 的创建时间。

时间格式为 `YYYY/MM/DD HH:mm`（本地时区），使用 `toLocaleString` 实现。
值为 0 时整行不渲染（兼容未同步的旧数据）。

## 接口 / 行为变更

- **前端 `Task` 类型**新增 `createdAt: number`（秒级时间戳，0 表示未知）。
- **后端 Rust `Task` struct**（`commands.rs`）新增 `created_at: i64`。
- **GitHub API**：`RawTask` 新增 `created_at` 字段，从 Search API 和单 issue REST 响应中解析。
- **卡片布局**：`创建人 → 创建于 → 分配人`，顺序与 Issue 期望一致。

## 数据 / Schema 变更

`tasks` 表新增 `created_at INTEGER NOT NULL DEFAULT 0` 列：

```sql
ALTER TABLE tasks ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0;
```

- 新库：直接写入 SCHEMA。
- 老库：通过 `open_db` 中的幂等 `ALTER TABLE` 补齐（与 `author` / `parent_issue` 同款模式）。
- 同步路径：`TaskUpsert` 新增 `created_at: i64`，INSERT 语句使用 `?26` 占位符，
  冲突时 `DO UPDATE SET created_at = excluded.created_at` 覆盖。
- 按需拉取路径：同样从 REST 响应解析并写入。

## MCP 同步

- Rust `mcp.rs::SELECT_COLS` 和 Python `mcp_server/server.py::SELECT_COLS` 均新增 `created_at`（末列）。
- `scripts/check-mcp-columns.py` 校验通过（27 列，两侧一致）。

## i18n

| Key | zh-CN | en-US |
|---|---|---|
| `card.createdAt` | 创建于 | Created |

## 测试 / 验收

- `python3 scripts/check-mcp-columns.py` ✓（27 列一致）
- `npm run i18n:check` ✓（zh-CN / en-US 各 357 个 key）
- `npx tsc --noEmit` ✓（类型检查通过）
- `npm test` ✓（136 个测试全部通过）

## 相关链接

- [Issue #280](https://github.com/ShawnLiuSZ/task-dashboard/issues/280)
- [Issue #276](https://github.com/ShawnLiuSZ/task-dashboard/issues/276)（每日自动检查更新 + 筛选/卡片展示增强，关联）

# 自定义列映射（issue #52）

> 涉及版本：v0.3.28
>
> 关联：[GitHub Issue #52](https://github.com/ShawnLiuSZ/task-dashborad/issues/52)、[docs/CHANGELOG.md](./CHANGELOG.md)、PR → develop

## 背景 / 动机

GitHub 上的企业组织可能使用自定义的 Project Status 字段值（如"待开发"、"需求"、"规划"、"开发中"、"测试中"等），每个账号可能使用不同的 Status 值体系。此前看板仅支持「四态列」和「Project Status 列」两种模式，无法灵活适配不同账号的自定义状态分类。

本功能支持**每个账号独立配置自定义列映射规则**，用户可以在设置中为每个账号定义自己的列（列名 + 匹配规则），gh_status 命中匹配规则的任务自动归入对应列，关闭的任务自动归入「已完成」。

## 设计 / 方案

### 核心设计

每个账号可独立配置一套列映射规则，存储在新建的 `account_columns` 表中。同步时，自定义列映射优先于 label 映射和 Project Status 映射。

### 数据模型

```sql
CREATE TABLE IF NOT EXISTS account_columns (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id  INTEGER NOT NULL,
  col_key     TEXT NOT NULL,
  col_name    TEXT NOT NULL,
  match_rules TEXT NOT NULL DEFAULT '[]',
  order_index INTEGER NOT NULL DEFAULT 0,
  UNIQUE(account_id, col_key)
);
```

- `col_key`：列标识（如 `col_0`、`col_1`），用于看板状态值
- `col_name`：前端显示的列名
- `match_rules`：JSON 数组，如 `["待开发","需求","规划"]`，任务 gh_status 命中任一值则归入该列
- `order_index`：列排序序号

### 状态判定优先级

同步时决定任务状态的优先级（`sync.rs`）：

```
1. gh_state == "closed"     → "done"（已完成）
2. 自定义列映射命中         → 对应的 col_key（按 account_columns 表匹配）
3. Label 映射命中           → 映射状态（todo/doing/processed/done）
4. Project Status 映射      → 映射到四态或保持原样
5. 维持本地手动态            → 不变
```

### 关键取舍

- **全量替换**：`save_account_columns` 使用「先删后插」原子事务，简单可靠
- **不破坏现有表结构**：新增 `account_columns` 表，不影响 accounts/tasks 等既有表
- **前端未保存时走本地 state**：列配置编辑后需点击「保存」才持久化，防止误操作
- **聚合视图（viewMode=all）**：合并所有账号的列配置，按 col_key 去重，按 order_index 排序

## 接口 / 行为变更

### 后端新增

- `account_columns` 表 + `AccountColumn` 结构体
- `list_account_columns(account_id) -> Vec<AccountColumn>`：列出某账号下所有自定义列
- `save_account_columns(account_id, columns)`：全量替换某账号的列配置
- `resolve_column_from_gh_status(conn, account_id, gh_status) -> Option<String>`：根据 gh_status 解析列 key
- `set_board_mode` 命令新增支持 `"custom"` 模式

### 前端新增

- `types.ts`：`AccountColumn`、`AccountColumnInput` 接口，`BoardMode` 新增 `"custom"`
- `api.ts`：`listAccountColumns`、`saveAccountColumns` 方法
- `Board.tsx`：新增 `custom` 模式渲染，按 `accountColumns` 动态生成列，无匹配任务归入「未分类」列
- `App.tsx`：加载列配置、看板模式下拉新增 `custom` 选项
- `SettingsPanel.tsx`：新增列映射编辑 UI（账号选择 → 列列表 → 增删改 → 保存）
- i18n 新增 12 个 key（zh-CN + en-US）

## 数据 / Schema 变更

新增 `account_columns` 表（见上述 DDL）。删除账号时级联删除该账号的列配置（`delete_account` 函数已处理）。

## 测试 / 验收

- 构建检查：`cargo check`、`tsc --noEmit`、`npm run i18n:check` 均通过
- Rust 单元测试 21 个全通过（2 个忽略的 headless 测试需网络环境）
- 验收场景：
  1. 设置中为账号 A 添加列：col_0="待开发"、col_1="开发中"，分别配置匹配规则
  2. 同步后，匹配的任务自动归入对应列
  3. 切换看板模式为「自定义列」，看板按自定义列渲染
  4. 切换到账号 B，列的配置与账号 A 独立
  5. 编辑/删除列后保存，看板实时反映变化
  6. 关闭的任务始终归入「已完成」

## 相关链接

- [Issue #52](https://github.com/ShawnLiuSZ/task-dashborad/issues/52)
- 代码：`app/src-tauri/src/db.rs`（account_columns 表 + CRUD）、`app/src-tauri/src/commands.rs`（list/save_account_columns）、`app/src-tauri/src/sync.rs`（状态判定）、`app/src/components/SettingsPanel.tsx`（编辑 UI）、`app/src/components/Board.tsx`（custom 渲染）、`app/src/App.tsx`（接入）、`app/src/types.ts` / `app/src/api.ts`
- [docs/CHANGELOG.md](./CHANGELOG.md)
# Issue #285：点击「立即同步」后看板空白、重启才恢复

## 背景 / 动机

点「立即同步」后，当前账号（ShawnLiuSZ）的看板整体变空，必须重启 App 才恢复。根因在产品层——同步完成后前端必跑一次 `listTasks`，而该查询在某些筛选下会**直接报错或恒返回空集**，于是 `applyTasks` 拿到的是「无数据」被写进 state，看板清空；`ownership` 是前端本地状态、重启即复位为「全部归属」，所以重启后自然恢复。对应 issue：[#285](https://github.com/ShawnLiuSZ/task-dashboard/issues/285)。

两处缺陷都在 `app/src-tauri/src/commands.rs::rows_to_tasks`（`list_tasks` 后端）：

- **缺陷 A（列数错位）**：`ownership == Some("my-created")` 之外的归属筛选分支，SELECT 列清单漏了 #278 新增的 `parent_issue` / `sub_issues`（27 → 25 列），但 `task_mapper`（及共享 mapper）固定按位置索引读 25/26 列 → `Row::get(25)` 越界 → `list_tasks` 整体报错。这会拖垮「分配给我 / 未分配 / 分配给他人」三种筛选；只要带着任一归属筛选，同步后必空板。
- **缺陷 B（`meta.login` 恒空）**：`my-created` 过滤原先用 `meta.login` 当「我」，而该字段只有 v0.3.15 单账号时代的 `save_pat` 会写，`add_account` / `device_login_poll` **从不**写它。生产库实测 `meta.login=''`（多账号场景下该遗留字段永远空），于是该筛选**无条件返回空集**。

两缺陷叠加后表现完全一致：**同步（触发一次带筛选的 `listTasks`）后看板为空，重启（筛选复位为全部归属 → 走 `WHERE 1=1` 全量分支）恢复**。

## 设计 / 方案

统一所有筛选分支走**同一条** SELECT 列清单与同一个 mapper，消除「归属分支漏列」的可能；「我创建的」改从 `accounts` 表取 login，而非读恒空的 `meta.login`。

- 新增模块级常量 `TASK_SELECT_COLUMNS`（27 列，`concat!` 拼成），`task_mapper(r)` 固定按位置索引 0..=26 读（25/26 = `parent_issue` / `sub_issues`）；`rows_to_tasks` 只保留一个 SELECT，WHERE 子句按 `ownership` 拼装、绑定参数统一追加 `account_id`。
- 新增 `my_logins(conn, account_filter, active_account_id)`：按视图范围解析 login 集——`Some(0)`（聚合视图）取全部已配置账号的 login，`Some(n)` / `None`（单账号，回退激活账号）只取该账号；login 为空串的行被过滤掉（不误匹配 `author=''`）。**不读 `meta.login`**。
- `read_active_account_id(conn)` 抽出来从 `meta.active_account_id` 读兜底账号。
- `account_filter` 解析保持一致：`Some(0)` → 全部账号（不加 `account_id`）；`Some(n>0)` → 指定账号；`None` → 读激活账号，无激活账号则不过滤。

前端侧（`app/src/App.tsx`）同步做了一处加固（#19）：

- `doSync` 改为**快照**点击时的 `ownership` / `accountFilter`（同步会刷新 `settings`，闭包值过期），并**走合并器 `loadWith`** 刷新任务，而非直连 `api.listTasks` + `applyTasks`——`onSynced` 事件会并发触发 `load()`，直连写 state 可能被并发的 coalesced load 覆盖回旧数据。
- 同步会先清空、再按 GraphQL 重写该账号的 `project_statuses`（`sync.rs::clear_project_statuses` → `upsert_project_statuses`），项目状态列可能整体换掉；沿用旧列渲染会让新状态的任务落到任何列之外（同样是「看板为空、重启恢复」的另一条路径）。因此 `doSync` 在同步后显式重拉 `loadProjectStatuses` / `loadAccountColumns`，两者新增可选 `SettingsT` 入参以拿到同步后的最新 settings 快照。

## 接口 / 行为变更

- `list_tasks`（Rust 命令）的 `ownership == "my-created"` 语义不变（按 `author` 过滤），但 login 来源从 `meta.login` 改为 `accounts` 表；其余行为、参数、返回结构均不变。
- 前端交互无变化。

## 数据 / Schema 变更

无。不碰 SQLite Schema、不新增列、不改迁移。

## 测试 / 验收

- 新增 3 个 Rust 回归测试（`commands.rs` 测试模块）：
  - `ownership_filter_returns_matching_rows_without_column_error`：归属筛选分支 SELECT 与 mapper 列数一致，不再 `Row::get(25)` 越界；并覆盖单账号 / 聚合（Some(0)）账号隔离。
  - `my_created_uses_account_login_not_legacy_meta_login`：夹具复现多账号生产库（`meta.login=''`），断言旧实现恒空、修复后按 `accounts.login` 正确命中；含聚合视图与「账号 login 为空返回空集」边界。
  - `active_account_id_drives_default_filter`：`active_account_id` 兜底命中与指向无任务账号返回空集。
- 新增夹具 `seed_account_tasks(conn, account_id, login, &[(n, ownership, author)])`。
- 全量校验：`cargo test --lib` 命令模块 9 用例全绿（含 3 新增）、`cargo clippy -- -D warnings` 0 warning、`tsc --noEmit` 0 error、`npm run build` ✅、`npm test` 13 文件 136 例、`i18n:check` 中英各 356 key、`npm run lint` 18 warning（未超 `--max-warnings 20`）、`prettier --check` ✅、`scripts/check-mcp-columns.py` ✅、`scripts/check-doc-links.py` ✅。

## 相关链接

- Issue：[#285](https://github.com/ShawnLiuSZ/task-dashboard/issues/285)
- 分支：`fix/issue-285-sync-empty-board`
- 前序：#278（父子关系两列补列教训）、#221（列表查询合并器）、#181（防重入 / 指纹）

# #262 多账号同步失效：view_mode 恒为 single，第二/第三个账号永不同步

> 关联 issue：[#262](https://github.com/ShawnLiuSZ/task-dashboard/issues/262)
> 修复分支：`fix/issue-262-multi-account-sync` → `develop`

## 背景 / 动机

多账号用户配置 ≥2 个 GitHub 账号后，「立即同步 / 定时同步 / 启动同步 / 托盘同步」四条触发路径
每轮都只同步**一个**账号（激活账号），其余账号永远不会被同步，也没有任何失败提示。本机实证：
`sync_logs` 共 674 条，但 `GROUP BY started_at HAVING COUNT(*)>1` 为空——历史上从未有一轮同步
覆盖 2 个账号。

根因：同步目标集由 `meta.view_mode` 决定，而 `view_mode` 永远是默认值 `single`。它的唯一写入入口
（前端 topbar 的 `<select>`）已被 commit `597840b`（"暂隐藏全部账号视图，仅保留单账号模式"）删除，
导致后端 `set_view_mode` 命令、`api.setViewMode`、i18n key 全部残留但**无调用方**——形成
「有实现、无入口」的半下线状态。旧逻辑在 `view_mode != "all"` 时只 `filter` 出激活账号，于是
其余账号被永久排除。

## 设计 / 方案

采用 issue 中倾向的 **方案 A：同步范围与视图模式解耦**。

- **同步恒覆盖全部账号**：不再用 `view_mode` 决定同步目标。`sync::run` 直接对所有已配置账号
  执行同步（多账号用户的核心诉求是「数据都要进本地库」）。抽出纯函数 `sync_target_accounts(conn)`
  返回全部账号，便于回归测试守住契约。
- **`view_mode` 仅影响前端展示**：`App.tsx` 的 `accountFilter`（单账号 / 聚合全部）与看板列聚合
  逻辑保持不变——`view_mode` 仍是合法的 UI 偏好，只是不再牵扯同步范围。
- **恢复显示模式开关**：撤回 `597840b` 的 UI 部分，在 topbar 重新接回「单账号 / 全部账号」切换，
  调用已有的 `api.setViewMode` → `set_view_mode` 命令。这同时消除了死代码（`#[allow(dead_code)]`
  误标注）与死 i18n key（`topbar.viewModeTitle` / `topbar.singleAccount` / `topbar.allAccounts`）。
- **可观测性**：`SyncResult` 新增 `accounts_synced` 字段（本次覆盖账号数），UI banner 在 ≥2 账号时
  展示「覆盖 N 个账号」；per-account 失败仍汇总进 `warning` 字段。
- **附带 bug 修复**：原 `sync.rs` 在 `get_account_pat(conn, account.id)?` 用 `?` 直接冒泡，任一账号
  读 PAT 失败会**中止整轮**，与紧随其后的 `pat.is_empty() → continue` 策略矛盾。改为 `match` +
  记失败 + `continue`，单账号失败不再连累其他账号。

## 接口 / 行为变更

### Rust（`sync.rs` / `commands.rs`）
- 新增私有函数 `sync_target_accounts(conn) -> Result<Vec<Account>, String>`，`run()` 调用它获取
  同步目标（= 全部账号）。
- `run()` 不再读取 `meta.view_mode` / `active_account_id` 来决定目标；移除 `target.is_empty()` 的
  「激活账号不存在」误报分支（空账号集已在 `sync_target_accounts` 内统一报错）。
- `SyncResult` 新增字段 `accounts_synced: usize`（`#[serde(rename_all="camelCase")]` → 前端
  `accountsSynced`）。
- 账号遍历处 `get_account_pat(...)?` 改为 `match`：`Err` 时 `total_failed.push(...)` + `continue`。
- `set_view_mode` 命令移除 `#[allow(dead_code)]`（它由 `lib.rs::invoke_handler` 反射注册，本非死代码）。

### 前端（`App.tsx` / `types.ts` / `i18n`）
- `types.ts` 的 `SyncResult` 接口新增 `accountsSynced: number`。
- topbar 恢复「显示模式」`<select>`（`single` / `all`），`onChange` 调 `handleSwitchView(mode)`，
  经 `api.setViewMode` 写入 `meta.view_mode`，随后 `loadSettings()` + `load()` 刷新展示。
- 同步结果 banner 在 `r.accountsSynced > 1` 时追加「覆盖 N 个账号」（zh：`覆盖 {n} 个账号`；
  en：`Synced {n} accounts`），`onSynced` 监听与 `doSync` 两处同步展示。
- i18n 新增 `sync.accountsSynced`（中英），`topbar.*` 三个 key 重新接回 UI 变为活 key。

## 数据 / Schema 变更

无。`meta.view_mode` / `active_account_id` 两个键继续存在并被消费，仅不再参与同步目标选择；
`SyncResult` 为进程内返回结构，不影响持久化 schema。

## 测试 / 验收

- 新增 Rust 回归测试 `sync_target_accounts_covers_all_accounts_regardless_of_view_mode`：
  用 `db::open_db` 建临时库、插入 2 个账号、写入 `view_mode=single` + `active_account_id=1`，
  断言 `sync_target_accounts` 仍返回 2 个账号（守住「view_mode 不再限制同步范围」契约）。
- 全套检查（均绿）：`cargo test --lib`（102 passed）、`npx tsc --noEmit`（0 error）、
  `npm test`（136 passed）、`npm run i18n:check`（349 key）、`npx prettier --check`（clean）、
  `npm run lint`（18 warning，未超 `--max-warnings 20`）。
- 仓库根 `python3 scripts/check-doc-links.py` 与 `check-mcp-columns.py` 通过（本次未改 tasks 列 /
  MCP 工具集）。
- 验收要点（人工）：配置 ≥2 账号后点「立即同步」，四个触发路径每轮 `sync_logs` 应出现 ≥2 条
  `account_id` 不同的记录；banner 提示「覆盖 N 个账号」；单个账号 PAT 失效不再中止整轮。

## 相关链接

- 根因分析 issue：[#262](https://github.com/ShawnLiuSZ/task-dashboard/issues/262)
- 删除 UI 入口的提交：`597840b feat(ui): 暂隐藏全部账号视图，仅保留单账号模式`
- 同步目标选择：`app/src-tauri/src/sync.rs` `sync_target_accounts` / `run`
- 死命令 / 死 API：`app/src-tauri/src/commands.rs` `set_view_mode`、`app/src/api.ts` `setViewMode`
- CHANGELOG：`docs/CHANGELOG.md`（Unreleased）、`docs/CHANGELOG.en.md`

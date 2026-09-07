# issue-97：首次启动点「设置 / 关于 / 账号 / 同步日志」UI 卡死转圈

> v0.3.41 修复 · 关联 [Issue #97](https://github.com/ShawnLiuSZ/task-dashboard/issues/97)

## 背景 / 动机

首次启动后，点击 **设置 / 关于 / 账号 / 同步日志** 任一按钮，鼠标变转圈（macOS beachball），界面看似卡死，必须等首次同步（拉取 GitHub issue / 写本地 SQLite）完成才能继续操作。

这些面板的 React 组件本身早就是**异步加载 + loading 态**（[SettingsPanel.tsx](file:///Users/liushizhao/dev/dashboard/app/src/components/SettingsPanel.tsx)、[SyncLogsPanel.tsx](file:///Users/liushizhao/dev/dashboard/app/src/components/SyncLogsPanel.tsx) 等），弹窗由纯状态切换触发，阻塞不在前端，而在后端。

## 设计 / 方案

### 根因：同步长持有共享 DB `Mutex`，阻塞主线程上的命令

- 后端把**整个同步**（`sync::run` → `sync_account`）包在 `AppState.db` 这个 `std::sync::Mutex<Connection>` 里执行，而同步本质是大量 **GitHub 网络 I/O**（`fetch_assigned/authored/mentioned/commented/related`、`fetch_prs`、`fetch_project_status_options`、`fetch_project_issues`、`fetch_comments`、`fetch_state`）+ 账号间隔 `thread::sleep` + 每评论 `thread::sleep(80ms)`，首次同步常常 30s+。
- 窗口期间，所有读取型 Tauri 命令（`get_settings` / `list_accounts` / `list_sync_logs` / `list_account_columns` 等）都调用 `state.db.lock()`，**排队等这把锁**。
- 这些读取命令是**同步命令**，跑在 Tauri 主线程（事件循环）上；主线程被阻塞排队等锁 → macOS 视为主线程无响应 → **beachball / 鼠标卡死转圈**。要等同步释放锁，命令才能返回。

> 排查定位到两处入口同样持有共享锁跑全量同步：
> - [lib.rs::run_sync](file:///Users/liushizhao/dev/dashboard/app/src-tauri/src/lib.rs)（启动 2s 后、Tray「立即同步」、定时同步）
> - [commands.rs::sync_now](file:///Users/liushizhao/dev/dashboard/app/src-tauri/src/commands.rs)（前端「立即同步」按钮）

### 修法：同步改用独立 DB 连接

不共享那把锁，让 UI 命令随到随取：

- 新增 `open_sync_conn(app)`：通过 `db::open_db(&db::db_path(app))` 为每次同步打开**独立连接**。
- `run_sync` / `sync_now` 用独立连接执行全部同步及 `last_sync_error` 读写，**不再持有 `AppState.db` 的 Mutex 跨网络 I/O**。
- 流传性好：`db::open_db` 已配置 `journal_mode=WAL` + `busy_timeout=5000`，多连接并发安全——WAL 下读连接从不阻塞写连接，写连接之间按 busy_timeout 排队，时间极短，不会感知到卡顿。
- 同步写均为逐条 autocommit（无长事务），UI 读到的是已提交的一致快照，无半截数据。

> 零依赖、零 schema 改动；`syncing` 去重的 `AtomicBool` 语义不变（并发触发仍被拒绝）。

## 接口 / 行为变更

- **无对外 API / Tauri command / MCP 工具变更**。`sync_now` 返回值、`run_sync` 的 `Option<SyncResult>` 语义与前端 `onSynced` 事件均不变。
- 行为变化：同步期间 UI 各面板可正常打开、数据即时加载，不再出现 beachball 冻结。

## 数据 / Schema 变更

- 无 SQLite schema / 数据结构改动。仅连接管理策略（共享 `Mutex` → 同步用独立连接）。

## 测试 / 验收

- `cargo check` 通过。
- `cargo test --lib`（非 ignored）23 例通过，含 `sync_guard_dedupes_concurrent_acquisition` 去重用例无回归。
- 手动验收路径：
  1. 首次启动、同步仍在进行时，依次点击 设置 / 关于 / 账号 / 同步日志 → 面板即时打开、数据加载中可见、不再卡死转圈。
  2. 同步进行中点击「立即同步」→ 仍报「已有同步进行中」（去重保护不回归）。
  3. 同步完成后切回看板，列表、项目状态、自定义列正常。

## 相关链接

- Issue：[#97](https://github.com/ShawnLiuSZ/task-dashboard/issues/97)
- 代码：`app/src-tauri/src/lib.rs`（`open_sync_conn` / `run_sync`）、`app/src-tauri/src/commands.rs`（`sync_now`）
- CHANGELOG：`docs/CHANGELOG.md` v0.3.41
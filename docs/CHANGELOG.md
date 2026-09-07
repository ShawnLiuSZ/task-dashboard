# 版本更新记录（Changelog）

> **中文**
>
> English version see [CHANGELOG.en.md](./CHANGELOG.en.md)

> TaskBoard 各版本的更新说明与修复记录。当前版本与项目概览见 [README](../README.md)。

- **v0.3.29（2026-09-06）— 看板列模式持久化与一致性修复（#64 #72 #74）**

  - **背景**：二次审计发现看板列模式（boardMode）体系存在三处缺陷，导致自定义列功能不可用、四态视图任务消失、模式切换不持久。

  - **改动**：

    - **#64 boardMode 持久化**：后端 `Settings` 结构体补齐 `board_mode` 字段，`get_settings` 从 `meta.board_mode` 读回；前端切换模式后 `setBoardMode` → `loadSettings` 串行执行，不再被旧值覆盖。

    - **#72 四态选项恢复**：看板模式下拉补回 `status`（四态）选项；`Board.tsx` 默认值由 `status` 改为 `project`，与 `db.rs` 默认值对齐。

    - **#74 自定义列门控**：`sync.rs` 中自定义列映射仅在 `board_mode == "custom"` 时生效，避免四态 / Project 视图下任务 status 被写成 col_key 后从看板消失。

  - **验收**：看板模式可在 status / project / custom 间自由切换并持久化；非 custom 视图下同步不会把任务分到自定义列导致消失；cargo check / tsc / i18n:check 通过。详见知识库文档 [docs/issue-64-board-mode-fixes.md](./issue-64-board-mode-fixes.md)。

- **v0.3.28（2026-09-06）— 自定义列映射（#52）**

  - **背景**：每个账号可能使用不同的 GitHub Project Status 值体系，看板需要支持按账号自定义列映射规则，而非只有固定的四态列或 Project Status 列。

  - **改动**：

    - 后端新增 `account_columns` 表，支持按账号独立配置列（col_key、col_name、match_rules、order_index）；新增 `list_account_columns`、`save_account_columns` 两个 Tauri command；`sync.rs` 状态判定中自定义列映射优先于 label 映射和 Project Status 映射。

    - 前端 `Board.tsx` 新增 `custom` 模式渲染，按账号配置动态生成列，无匹配任务归入「未分类」列；`App.tsx` 看板模式下拉新增「自定义列」选项；`SettingsPanel.tsx` 新增列映射编辑界面（账号选择 → 列列表 → 增删改 → 保存）。

    - i18n 新增 12 个 key（zh-CN / en-US）。

  - **验收**：各账号可独立配置列映射规则；同步后匹配的任务自动归入对应列；切换看板模式为「自定义列」按自定义列渲染；关闭的任务始终归入「已完成」。详见知识库文档 [docs/issue-52-custom-column-mapping.md](./issue-52-custom-column-mapping.md)。

- **v0.3.27（2026-09-06）— 记事本导出 / 导入功能（#53）**

  - **背景**：破坏性更新（重新安装 / 清空数据 / 升级误删 SQLite）可能导致本地记事本数据丢失，此前无任何备份恢复入口。

  - **改动**：

    - 后端新增 `export_notes`、`import_notes` 两个 Tauri command：导出全部记事为 JSON 到应用数据目录 `notes-backup/`；导入按内容去重、保留原时间、不覆盖已有数据。

    - 前端 `NotesPanel` header 增加导出 / 导入两个图标按钮；导出后提示保存路径，导入后反馈「新增 / 跳过」条数。

  - **验收**：导出文件内容完整可读；从导出文件导入后记事（内容、label、时间）完整恢复；重复导入不产生重复条目；破坏性更新后可通过导入恢复。详见知识库文档 [docs/issue-53-notes-backup.md](./issue-53-notes-backup.md)。

- **v0.3.26（2026-09-06）— 授权登录后账号 modal 自动刷新（#54）**

  - **问题**：在「账号」modal 中完成 GitHub 设备授权登录后，账号列表不会自动刷新，新授权的账号不显示，必须手动关闭再重开 modal 才会出现。

  - **根因**：`AccountsPanel` 把父级 props 快照进本地 state（`useState<Account[]>(settings.accounts)`），此后**没有任何机制把 props 变化同步回本地**。授权成功只调用 `onAccountsChanged()`（父级 `loadSettings()` 刷新 settings），本地 `accounts` 始终不变，只能靠组件重新挂载才刷新。

  - **改动**：`AccountsPanel.tsx` 增加 `useEffect`，把 `settings.accounts` 同步回本地 state；全量替换而非追加，天然避免重复项。顺带修复同源问题——「设为默认」后默认标签不立即更新。

  - **验收**：授权成功回调后账号列表自动刷新、新账号即时显示；无需关闭重开 modal；不出现重复账号或数据错乱。

- **v0.3.25（2026-09-06）— 修复「检查更新」按钮不可点击（#55）**

  - **问题**：关于页打开后「检查更新」按钮始终处于 disabled 状态，用户无法主动触发版本检查。根因是 `AboutPanel` 的 `state` 初始值被设为 `{ phase: "loading" }`，把「尚未检查」与「正在检查」复用了同一状态，而按钮的 `disabled` 判断是 `state.phase === "loading"`，导致一打开就被禁用。

  - **改动**：

    - `AboutPanel.tsx`：`State` 新增 `idle` 初始态（未检查、按钮可点击），`loading` 仅表示检查进行中；移除冗余的 `checkedOnce` 标志；检查中显示「检查中…」并短暂禁用以防重复点击，检查完成（成功 / 报错）后一律恢复可点击；已是最新时展示具体版本号。

    - `zh-CN.json` / `en-US.json`：`about.upToDate` 增加 `{version}` 占位符，文案改为「当前已是最新版本 v{version}」。

  - **验收**：按钮打开即可点击；点击后正确展示「当前已是最新版本 vX.Y.Z」或「发现新版本 X，当前为 Y + 下载跳转」；检查完成后按钮恢复可点击。

- **v0.3.24（2026-09-05）— 记事本 + 账号体系 + 同步日志 + 顶栏布局（含 #6/#7/#27/#26/#31/#24/#25/#37/#38/#41/#33/#9/#48）**
  - **多账号与账号体系（#25/#31/#33/#38）**：修复第二个账号增收 422；新增账号管理面板（增删、切换）；删除账号时级联清理该账号下所有本地数据；移除 org 默认切换。
  - **记事本面板（#9）**：看板最左侧新增独立笔记列。
  - **同步日志（#27）**：应用内记录最近一周同步日志，超期自动删除；新增「同步日志」弹窗。
  - **顶栏布局优化（#48）**：右侧按钮组不换行；移除左侧 "TaskBoard" 文字；5 个按钮内联 SVG 图标，窗口过窄（≤1100px）仅显图标；四个弹窗收敛到互斥 `activeModal`（修复叠加，根因同 #26）；弹窗高度随视口收敛 + 内部滚动；遮罩 z-index 提升修复被搜索栏压住。
  - **同步体验（#24）**：同步完成后自动刷新。
  - **i18n 双语（#7）**：界面中英文切换；GitHub 授权倒计时格式修复（#6）。
  - **MCP 静默化（#41）**：MCP 调用隐藏 db 列迁移日志。
  - **知识库文档**：[`docs/issue-48-topbar-layout.md`](./issue-48-topbar-layout.md)、[`docs/issue-27-sync-logs.md`](./issue-27-sync-logs.md)、[`docs/issue-33-cascade-delete-account.md`](./issue-33-cascade-delete-account.md)、[`docs/issue-41-mcp-silent-migration.md`](./issue-41-mcp-silent-migration.md)、[`docs/issue-9-notepad-panel.md`](./issue-9-notepad-panel.md)

- **v0.3.23（2026-09-05）— 同步日志功能（#27）**

  - 需求：同步操作（定时/手动）执行后，用户无法查看同步历史和错误详情，难以排查「部分账号失败 / 422」等问题。

  - 改动：

    - `db.rs`：新增 `sync_logs` 表（account_id, trigger_type, started_at, finished_at, status, added/updated/removed/candidate_done/pruned 计数, failed_sources, error_message），自动创建表和索引。

    - `sync.rs`：同步开始时为每个目标账号插入日志，同步完成时更新日志状态和统计数据；每次同步后自动清理超过 7 天的旧日志。

    - `commands.rs`：新增 `list_sync_logs`（列出同步日志）和 `prune_sync_logs`（清理过期日志）两个 Tauri 命令。

    - `lib.rs`：注册新命令。

    - `types.ts`：新增 `SyncLog` 类型。

    - `api.ts`：新增 `listSyncLogs` 和 `pruneSyncLogs` API 调用。

    - `SyncLogsPanel.tsx`：新建同步日志面板组件，展示最近 100 条同步记录（时间、触发方式、耗时、状态、新增/更新/移除数量、错误信息），支持手动清理过期日志。

    - `App.tsx`：顶栏新增「同步日志」按钮。

    - `styles.css`：新增同步日志面板样式。

  - 验证：`cargo check` 通过；`npx tsc --noEmit` 通过；`npm run tauri build` 编译成功。

  - 知识库文档：[`docs/issue-27-sync-logs.md`](./issue-27-sync-logs.md)

- **v0.3.19（2026-09-05）— 关于页面 + 检查更新（#21）**

  - 背景：应用内缺少版本显示与更新入口，用户无法了解当前版本或触发升级。

  - 新增「关于」页面（顶栏「关于」按钮进入）：

    - 展示当前版本号（后端读取 Rust 包版本，非前端硬编码）

    - 「检查更新」按钮：调用 GitHub Releases API `releases/latest`，对比当前/最新版本，显示「已是最新」或「发现新版本」并提供跳转下载

    - 应用仓库名改为可点击链接，经系统浏览器打开 `https://github.com/ShawnLiuSZ/task-dashborad`

    - 内置中英文（i18n 新增 `about.*` / `btn.about` 键）

  - 技术说明：`check_latest_release` 为只读公开仓库请求，无需 PAT；用 `spawn_blocking` 避免 reqwest(blocking) 阻塞主线程。

  - 版本号统一升至 0.3.19（Cargo / package / tauri.conf / 内置 MCP / 便携 server.py）。

  - **Bundle Identifier 改为** **`com.shawnliu.taskboard`**（原 `com.liushizhao.taskboard`）：默认数据目录随之变为 `~/Library/Application Support/com.shawnliu.taskboard/`。⚠️ 已有本地数据如需沿用，请手动迁移旧目录中的 `taskboard.db` 到新目录，或试用 `TASKBOARD_DB` 指向旧库。

- **v0.3.18（2026-09-05）— 建立并执行版本发布流程（首个统一版本号）**

  - 背景（#5）：从 v0.3.17 起建立明确的 SemVer 版本发布流程，保证 Rust/Cargo、前端 package.json、Tauri 配置、内置 MCP、便携 `mcp_server/server.py` 与文档多处版本号一致，并为后续 release 提供可复现基础。

  - 版本号统一升至 0.3.18：

    - `app/src-tauri/Cargo.toml` `version=0.3.18`

    - `app/package.json` + `package-lock.json` `version=0.3.18`

    - `app/src-tauri/tauri.conf.json` `version=0.3.18`（产物 `TaskBoard_0.3.18_*.app/dmg`）

    - `app/src-tauri/src/mcp.rs` `SERVER_VERSION=0.3.18`（内置 MCP `serverInfo.version`，经 `taskboard mcp` 的 `initialize` 返回）

    - `mcp_server/server.py` `serverInfo.version` 由陈旧的 0.3.10 校正为 0.3.18（便携兜底与内置二进制保持一致）

  - 文档同步：README / PRD / 中英 CHANGELOG 均以 0.3.18 为准；新增英文版文档（README.en / AGENT\_INSTRUCTIONS.en / CHANGELOG.en）。

  - 跨平台文档（#8）随本版一并发布：README / CLAUDE / PRD 移除「仅 macOS」表述，改为 Windows / macOS / Linux 跨平台。

  - 验证：`cargo check` 零警告；`cargo build --release` 产出内置 MCP 二进制（冒烟 `initialize`→`serverInfo 0.3.18`、`tools/list` 6 工具齐全）；便携 `mcp_server/server.py` 冒烟一致。

- **v0.3.17（2026-09-04）— GitHub OAuth Device Flow 登录（替换 PAT 粘贴）**

  - 需求：登录 GitHub 不再手动创建/粘贴 PAT，改为「点按钮 → 浏览器授权」的链接登录体验。

  - 实现（RFC 8628 Device Flow）：新增 `src-tauri/src/oauth.rs`——① `start` 申请设备码（`POST /login/device/code`，scope=`repo read:org read:project`）；② `poll_once` 轮询 access\_token（`authorization_pending`/`slow_down`/`expired_token`/`access_denied` 全覆盖；**后端不 sleep**，由前端按 interval 控制节奏）。**token 全程不回流前端**——轮询成功后由后端探测 login 并直接建/更账号。

  - 首次使用前置（一次性）：GitHub → Settings → Developer settings → OAuth Apps → New OAuth App（Callback 随意），勾选 **Enable Device Flow**，复制 Client ID 填入设置面板（存 `meta.oauth_client_id`）。此后登录零配置。

  - UI（SettingsPanel）：添加账号表单改为「账号名称 + 组织 + Client ID + 通过 GitHub 授权登录」；授权面板大字显示 user\_code + 「重新打开授权页」（用 `verification_uri_complete` 预填免输码）+ 轮询状态；移除旧的「GitHub Personal Access Token（兼容字段）」整块 UI（后端 `save_pat`/`test_pat`/`clear_pat` 命令保留兼容）。

  - 命令注册：`save_oauth_client_id` / `device_login_start` / `device_login_poll`；`Settings` 增 `oauthClientId` 字段；MCP SERVER\_VERSION 同步 0.3.17。

  - 同登录同 login 的账号自动复用（更新 PAT 而非重复建号）；首个账号自动设为默认并激活。

  - 验证：`cargo check` 零警告；`cargo test` 16 lib + 15 integration 全过（新增 oauth 单测 2 条）；`npm run build` 通过。

- **v0.3.16.1（2026-09-04）— 修复首次启动 SIGABRT + SQLite WAL 加固**

  - 现象：v0.3.16 二进制首次启动 1.6s 内 SIGABRT，连续复现；crash log 栈顶 `tao::app_delegate::did_finish_launching + 272`（C 边界 `panic_cannot_unwind`），threadState.x22 = `sqlite3azCompileOpt`（SQLite 编译 SQL 时 panic）。

  - 根因链：v0.3.16 启动事务（建 accounts 表 + 写默认设置 + ALTER ADD account\_id）中途 abort → DELETE 模式残留 `.db-journal` 半提交 → bundled SQLite 0.31 在 macOS 26.6 上 forward-rollback 失败报 "disk I/O error" → 列迁移失败被 `let _ = ...` 静默吞掉 → DB 半新半旧 → 后续同步 panic。系统 sqlite3 3.51 能正常读写，证明文件本身健康，是 bundled SQLite 对残留 journal 的处理差异。

  - DB 恢复（手工）：备份后移走 `-journal`，用系统 sqlite3 补上 `account_id` 列；78 条任务完好。

  - 代码加固（`db.rs::open_db`）：① 强制 `PRAGMA journal_mode=WAL + synchronous=NORMAL + busy_timeout=5000`——WAL 模式下主 DB 文件始终一致可读，崩溃天然安全；② ALTER 失败不再吞，`eprintln!` 显式记录。

  - 新增测试：`open_db_uses_wal_journal_mode` / `open_db_recovers_from_dirty_journal_file`（伪造残留 journal 验证 open\_db 仍成功）。

- **v0.3.1（2026-09-04）— 看板漏拉「分配给我」的任务**

  - 现象：看板随机缺失已分配给我的 issue（如 `fad-backend#1200` 及 #1066/#1071/#1072/#1100/#1138/#1139、`pq-backend#259`）。

  - 根因：原同步仅用 `involves:<login>` 单一查询，而 GitHub 的 `involves:` 搜索对 assignee 覆盖不稳定，会偶发漏拉已分配 issue。

  - 修复：改为 `assignee:<login>`（权威）+ `involves:<login>`（其他相关）两次查询按 key 合并去重；编译通过并端到端验证 7 个漏洞 issue 已全部进入看板。

  - 残留限制：「与我相关但非我负责」（`assigned-others` / `notassignee`）仍依赖 `involves:`，理论上仍可能受同一偶发漏拉影响；「分配给我」已彻底稳定。

- **v0.3.2（2026-09-04）— 彻底消除** **`involves:`** **抖动导致的随机漏拉**

  - 进一步定位：GitHub `involves:` 搜索结果**非确定性抖动**——总数恒为 76，但成员会随机漏拉（同一批已分配 issue 在不同次查询中时有时无）。单一 `assignee:` 仅能兜住「分配给我」，兜不住「相关但非我负责」。

  - 修复：改为 **5 个稳定查询源取并集**——`assignee:` + `author:` + `mentions:` + `commenter:` + `involves:`（兜底），按 `repo#number` 去重。`github.rs` 抽 `fetch_search` 通用函数 + 4 个专属 `fetch_*` + `merge_tasks_all`；`sync.rs` 改为合并五源。

  - 验证：5 源合并唯一总数 = 76（即完整相关集），对 `involves:` 抖动免疫；任何单源漏拉都会被其他源补回。每次同步发起 5 次 Search API 调用（认证限额 30 次/分钟，充足）。

- **v0.3.3（2026-09-04）— 多源同步容错 + 失败提示**

  - 问题：多源改造后每次同步发起 5 次 Search API 调用，若某次偶发失败（限流/网络抖动）原 `?` 会让**整次同步失败**，反而可能让用户误以为"任务没了"。

  - 修复：`sync.rs` 改为 **best-effort 合并**——单源失败仅跳过该源、其余源照常并入；仅当全部源失败才报错。给 `SyncResult` 增加 `warning` 字段，`App.tsx` 横幅对"部分数据源失败"给出 ⚠️ 提示（不静默丢任务）。

  - 验证：`cargo check` + `npm run tauri build` 通过（`.dmg` 仍沙箱限制）；端到端同步 76 条入库、分布不变。

- **v0.3.4（2026-09-04）— 看板顶部搜索 + 仓库/归属筛选（可见性增强）**

  - 背景：同步已无漏拉，但长列（如「待处理」含 61 条 `fad-backend`）下具体任务难以定位，用户易误判"没拉下来"（如 `fad-backend#1200`）。

  - 改动：新增顶部 `.toolbar`——搜索框（命中 `repo#number 标题`，实时）+ 仓库下拉（按仓库隔离）+ 归属下拉（自 topbar 移入）+ 重置按钮；`visible` 经 `useMemo` 前端过滤，"共 N 条"改显可见数。

  - 验证：`npm run build` 通过；`npm run tauri build` 本次 `.app` 与 `.dmg` 双双产出；重拉起新构建自动同步 76 条、`fad-backend#1200` 在库，启动正常。

  - 用法：直接搜 `1200` 或 `fad-backend` 即可一秒定位该任务。

- **v0.3.5（2026-09-04）— 看板状态随 GitHub issue 状态联动 + 同步健壮性修复**

  - 用户反馈：看板里几乎所有任务都停在「待处理」，只有经 MCP/skill 手动改过的才会变；希望**看板状态能反映 issue 真实状态**。

  - 改动（`sync.rs`）：GitHub 已关闭的 issue 在同步时**自动归入「已完成」**（`status='done'`，覆盖本地手动态）+ 标 `candidate_done`；仍打开但不再与用户相关者移出看板。open 状态的 issue 仍保留本地手动四态（todo/doing/processed/done），不强行覆盖。

  - **顺带修复两个真实健壮性缺陷**（调试中暴露）：

    1. `github.rs` 的 `run_gh` 原用 `Command::output()` 无限等待，一次 `gh` 卡住（限流退避/网络 TLS 超时）会让整个同步**永久阻塞**。现加 30s 调用超时（轮询 `try_wait`，超时即 kill 报错，由 best-effort 跳过该源）。
    2. `sync.rs` stale 回路原在 `fetch_state` 失败时 `DELETE` 任务——限流/抖动时会被误删清空整个看板。现改为：**仅当** **`fetch_state`** **明确返回** **`open`（确认仍开但与我无关）才删除；查询失败一律保留**，避免一次限流误清空看板。

  - 验证：`open -g` 拉起新构建 → 自动同步 → 插入一个真实的已关闭 issue（`fad-backend#1195`）模拟"曾 open 现已关闭"，同步后该任务 `status=done / gh_state=closed / candidate_done=1`，其余 77 个 open issue 保持 `todo`。调试中曾因旧代码 + 限流把 76 条误删，已随修复恢复（正常同步会自动重新拉取，无需从 GitHub 之外恢复）。

- **v0.3.6（2026-09-04）— 看板状态联动 GitHub Project（OMS Kanban）的 Status 字段**

  - 用户反馈：`#1247/#1237/#1223` 等 issue 在 GitHub 上已是「开发完成测试中」之类的进度，看板却仍停在「待处理」。

  - 根因：看板此前**只读 GitHub Search API 的** **`state`（open/closed）**。而团队用 **GitHub Project「OMS Kanban」的 Status 字段**（如 `🔎开发完成/测试中`）表达进度，Search API 完全不返回该字段，所以看板对这些 issue 毫无感知，永远停在初始 `todo`。

  - 改动：

    - `github.rs` 新增 `fetch_project_status()`：通过 GraphQL 一次性分页拉取 OMS Kanban 全部条目的 `Status`（按 `repo#number` 建映射）；新增 `run_gh_graphql()` 复用 `run_gh` 的 30s 超时机制。

    - `sync.rs` 新增 `map_project_status()`，将 Project Status 映射到看板四态（`🧠需求池/🤔产品规划/🚧待开发处理→待处理`、`✨开发中→处理中`、`🔎开发完成/测试中/✅测试通过/待上线→已处理`、`🎉完成/上线/↩️取消→已完成`）；同步时对「在 Project 中」的 issue **以 Project Status 为权威覆盖本地手动态**，不在 Project 的 issue 维持原样。

    - `db.rs` 新增 `gh_status` 列（并含旧库迁移）；`commands.rs` / 前端 `types.ts` / `TaskCard.tsx` 透传并在卡片上展示该原始状态徽章。

  - 验证：`npm run tauri build` 通过（`.app` 产出，`.dmg` 仍受沙箱 `/Volumes` 限制）；拉起新构建自动同步后核对——`#1223`→已处理（`🔎开发完成/测试中`）、`#1247`→处理中（`✨开发中`）、`#1237`→待处理（`🧠需求池`，其真实状态确为需求池，并非测试中）；全量 77 条 issue 的 `gh_status` 均已填充且映射正确。

  - 注意：用户原以为三条都是「开发完成测试中」，实际仅 `#1223` 是；`#1247` 为开发中、`#1237` 为需求池——修复后看板反映的是 GitHub 上的**真实**状态。若后续想调整映射（如「测试通过/待上线」也归为已完成），改 `sync.rs` 的 `map_project_status` 即可。

- **v0.3.7（2026-09-04）— 修复「立即同步」点击后整个 App 转圈（beachball）卡死现象**

  - 现象：点界面上的「立即同步」，鼠标在 App 上转圈（macOS 彩虹球），像是卡死。

  - 根因：前端 `doSync` 早已设了 `syncing=true` 并显示「同步中…」、禁用按钮，但 Rust 端 `sync_now` 是**同步命令**，会**在主线程（事件循环线程）上跑完整个同步**（5 次 Search API + 1 次 GraphQL，5\~15s）。主线程被占满 → macOS 转圈、UI 无法渲染「同步中…」、看似卡死。菜单栏的「立即同步」因为走了 `thread::spawn` 子线程所以没这问题，只有界面按钮触发的前端 `invoke('sync_now')` 会。

  - 修复：`sync_now` 改为 `async` 命令，把真正耗时的 `sync::run` 用 `tauri::async_runtime::spawn_blocking` 丢到工作线程执行；主线程仅派发后立即返回。UI 全程不冻结，「同步中…」正常显示。前端无需改动（`invoke` 对同步/异步命令透明）。

  - 验证：`cargo check` + `npm run tauri build` 通过；拉起新构建自动同步正常（77 条、映射不变、`last_sync_error` 为空），进程稳定存活。macOS 转圈现象已结构性消除（异步命令不再阻塞主线程）。

- **v0.3.8（2026-09-04）— 已完成任务 30 天自动清理 + 他人分配显示真实昵称**

  - 用户反馈（两条）：

    1. 「已完成的 issue，只保留 1 个月」——已完成任务积压，看板越来越长。
    2. 「如果已经分配给他人了，就将他人 name 显示出来，而不是显示『分配给他人』」——`assigned-others` 一律显示成「分配给他人」，看不出具体是谁。

  - 改动：

    - `db.rs` 新增两列：`assignees TEXT`（该 issue 的全部 assignee 登录名，逗号分隔）与 `done_at INTEGER`（首次进入「已完成」的时间戳，默认 0）；两者均带旧库 `ALTER TABLE` 迁移。

    - `sync.rs` 写入：INSERT 落 `assignees = t.assignees.join(",")`；`done_at` 用 `CASE`——**首次**变为 `done` 时打上当前时间戳，之后保持不变（不每次重置），移出 `done` 时归零（重做会重新计时）。stale 回路中 GitHub 已关闭→`done` 的路径同样打 `done_at`。

    - `sync.rs` 末尾新增 **30 天清理**：`DELETE FROM tasks WHERE status='done' AND done_at>0 AND now-done_at > 2592000`。`done_at=0`（v0.3.8 前历史数据的完成时间未知）**不清理**，仅淘汰带真实时间戳、且距完成超 30 天的新任务——避免一次性误删历史。清理条数经 `SyncResult.pruned` 回传。

    - 前端透传：`commands.rs` 的 `Task` 加 `assignees` 字段（SELECT/mapper 索引同步）；`types.ts` 的 `Task` 加 `assignees`、`SyncResult` 加 `pruned`；`App.tsx` 同步结果文案新增「· 清理已完成 N」。

    - `TaskCard.tsx`：`assigned-others` 不再显示「分配给他人」，改为展示 `@login1 @login2`（从 `assignees` 拆分）。`notassignee` 仍显示「无人认领」，`assigned` 仍不显示归属标签。

  - 验证：`cargo check` + `npx tsc --noEmit` 均通过；`npm run tauri build` 产出 `.app`（`.dmg` 受沙箱 `/Volumes` 限制时另处处理）。逻辑自检：新完成任务的 `done_at` 在 30 天内不被清；历史 `done_at=0` 任务保留；`assigned-others` 卡片显示真实 `@昵称`。

- **v0.3.9（2026-09-04）— 卡片增强：我的红色标识 / 分配人 / @我 / 新评论链接 / 关联 PR**

  - 用户反馈（五条，合并为一版）：

    1. 分配给我（own）的 issue，以**红色醒目**标识。
    2. 卡片上「时间」上方加一行**分配人**，可显示多个（有的 issue 分配了两人），格式 `@a @b`。
    3. 评论区有人 **@我**，卡片上标识。
    4. 有**新评论**时，记录最新评论的链接，卡片一键跳转。
    5. issue 若对应 **PR**，记录 PR 编号与链接，便于查找。

  - 改动：

    - `db.rs`：新增 `mentioned` / `comments_count` / `latest_comment_url` / `pr_number` / `pr_url` 五列（含旧库 `ALTER` 迁移）。

    - `github.rs`：`RawTask` 增 `comments`（搜索返回评论数）；新增 `fetch_prs()`（一次分页拉全组织内 PR，取 `repo#number/url/body`）+ `fetch_comments()`（取该 issue 最新评论 `html_url`）；`JQ_PRS` 投影。

    - `sync.rs`：

      - **@我**：复用 `mentions:` 搜索源（`mention_keys` 集合），`mentioned = 在集合中 且 非分配给我`；mentions 源失败则保留既有标记。

      - **PR 关联**：`fetch_prs` 后用 `parse_issue_refs()` 解析每个 PR 正文的 `#N` / `owner/repo#N` 引用，反向建 `repo#issue -> (pr_number, pr_url)` 映射；PR 列表拉取成功才更新（失败保留既有）。

      - **新评论**：仅当评论数较上次增加 **且** 单次同步预算（≤30 条）充足时回源 `fetch_comments`，取最新评论永久链接；其余沿用缓存，控制 API 调用量。

      - 以上字段写入 `INSERT/ON CONFLICT`。

    - 前端：`commands.rs` `Task` 加 `mentioned/latestCommentUrl/prNumber/prUrl`（SELECT/mapper 索引同步）；`types.ts` 同步；`TaskCard.tsx` 渲染——`mine` 红色左边框 + 「★ 我的」红标、`分配人` 行（多 `@名`）、「📣 @我」橙标、「💬 新评论」「🔗 PR #N」跳转链接（点击经 `open_in_browser` 打开本机浏览器，且不触发卡片选中）；`styles.css` 补对应样式；`DetailPanel.tsx` 同步展示分配人/@我/PR/评论链接。

  - 验证：`cargo check` + `npx tsc --noEmit` 通过；`parse_issue_refs` 以多组样本（含 `owner/repo#N`、`/path/repo#N`、无引用）验证映射正确；`npm run tauri build` 产出 `.app` 与 `.dmg`。

  - 注意（取舍）：

    - **@我**基于 GitHub `mentions:` 搜索（覆盖正文+评论中的 @），非逐条拉评论判定，因而零额外 API 成本、与现有 5 源合并一致；若某 issue 仅在评论里 @我而 `mentions:` 未返回（极少数抖动），可能漏标。

    - **新评论链接**首次同步会对所有「评论数>0」的 issue 回源拉评论（受 30 条/次预算限流，少量 issue 顺延至后续同步补齐）；`fetch_comments` 仅取前 100 条评论里的最后一条（一般足够）。

    - **PR 关联**靠 PR 正文里的 `#N` 反推，纯文本启发式：形如「step #1」这类非引用也可能误关联（低风险）；跨仓库 `owner/repo#N` 已支持。

- **v0.3.9.1（2026-09-04）— 修复 PR 关联恒为 0（管道缓冲死锁，非限流）**

  - 现象：v0.3.9 五张卡增强里，前四项（红标/@我/分配人/新评论）正常，**唯独「关联 PR」`pr_number`** **全部为 0**。隔离验证（`parse_issue_refs` + 真实 PR 正文 + 真实 DB key）证明逻辑层应命中 44/77，但线上始终 0。

  - 根因（推翻此前「GitHub 二次限流」的误判）：`github.rs` 的 `run_gh_once` 在 `gh` 进程**退出后**才 `read_to_end` 读 stdout/stderr。当 `gh` 输出超过 OS 管道缓冲（macOS \~64KB，如 `fad-backend` 单页 PR JSON 达 442KB）时，`gh` 写满管道后**阻塞在 write、进程无法退出**，于是等到 60s 超时再 `kill` —— 该页 PR 被 best-effort 跳过 → `prs` 为空 → `pr_number` 全 0。证据：隔离跑 `fetch_prs`（不跑任何搜索）依旧 3/4 仓库 60s 超时、**唯独小响应仓库** **`flutter-driver`** **成功**；同一条 `gh api .../pulls?per_page=100` 在 bash 直跑 2.3s，在 Rust 子进程里却 60s 超时。

  - 修复：

    1. `run_gh_once` 改为**用独立线程并发排空** stdout/stderr（`thread::spawn` + `read_to_end`），主循环只 `try_wait` 轮询超时；`gh` 不再因管道满而阻塞（核心修复）。
    2. `RawPr.repo` 补 `#[serde(default)]`：REST pulls 的 JQ 投影不输出 `repo`，原反序列化会因「缺 repo 字段」失败（`flutter-driver` 已暴露 `missing field repo`）。
    3. PR 拉取超时放宽到 60s 单发（`gh` 自带按 `Retry-After` 退避，不再外层 3× 重试放大到 180s/页）。
    4. `sync.rs`：搜索→PR、PR→项目状态两处 4s 阶段冷却 + 评论预算 30→12（锦上添花，非主因）。

  - 验证：`cargo test --lib -- --ignored test_fetch_prs_isolated` 隔离 `fetch_prs` 793 个 PR / 31.6s（修复前 3/4 仓库 60s 超时）；`test_headless_sync_pr_linkage`（已改为复制生产库到临时副本、不误改用户数据）全量 `sync::run` 实测 `pr_number>0 = 44/77`，69.7s 完成（修复前 222.9s 且全 0）。前端 `TaskCard.tsx`(🔗 PR #N) / `DetailPanel.tsx`(PR #N 按钮) 经 `rename_all=camelCase` 链路闭合。

  - 经验（通用）：Rust 里用 `Command` 拉取「可能超过管道缓冲」的子进程输出时，**务必并发排空 stdout/stderr**，或改用 `output()`；「先等退出再读输出」在大数据量下必然死锁——这是比「限流重试/超时调参」更常见的坑。

- **v0.3.10（2026-09-04）— 卡片信息重整 + 分支/交接记录 + 体验修复（共 8 项）**

  - 背景：用户就「任务卡片信息」提出 8 条反馈/需求（含 4 张截图）。逐项落地如下：

    1. **（设计澄清）session id 的存入方式**：当前为**手动录入**——在详情页「中断会话」输入 session id + 选 agent → `record_session` 命令写入本地 SQLite（`session_id` / `session_agent` / `session_at`）。**并非 MCP 自动写入**；PRD.md 规划的「MCP Server + Skill 自动记录」尚未实现（架构预留，未动工）。本期保持手动录入不变，MCP 自动记录留待单独排期。
    2. **agent 下拉补全主流项**：`DetailPanel.tsx` 的 agent `<select>` 由原本 3 项（claude-code / workbuddy / doubao）扩为 10 项，新增 `opencode` / `codex` / `zcode` / `gemini-cli` / `cursor` / `aider` / `qwen-code`（以常量数组集中维护，便于增删）。
    3. **点击空白关闭详情**：`App.tsx` 在 `DetailPanel` 外包裹一层 `.detail-backdrop` 遮罩（覆盖看板区、`z-index:10`），点击遮罩即 `setSelected(null)`；详情面板 `z-index:11`，点击面板本身不穿透。关闭按钮仍保留。
    4. **「无人认领」上移到时间行上方 + issue 旁只留「我的」**：`TaskCard.tsx` 从 `card-top` 移除「分配人 @名」/归属徽章；`card-top` 仅留 `repo` / `#编号` / 「★ 我的」(若分配给我) / Project 状态。`无人认领` 与 `分配人 @名` 统一收进「时间上方一行」(`meta-row`)，不再挤在标题行。
    5. **「@我」移到时间行上方一行**：`mention-badge`（📣 @我）从 `card-top`（标题行）移至 `meta-row`（时间行上方），与「无人认领/分配人」同处一行，标题行不再拥挤。
    6. **记录关联分支**：GitHub issue 本身无分支字段，只能从**关联 PR 的** **`head.ref`** 反取。`github.rs` 的 `RawPr` 增 `head_ref` 并纳入 `JQ_PRS_REST` 投影；`sync.rs` 的 `pr_map` 由 `(num,url)` 扩为 `(num,url,branch)`，关联命中时一并写入新增的 `branch` 列；`db.rs` 加 `branch` 迁移；卡片 `meta-row` 在 `branch` 非空时显示「🌿 <分支名>」。
    7. **记录交接任务**：新增 `handoff TEXT` 列 + `record_handoff(key, text)` 命令 + 前端 `api.recordHandoff`。`DetailPanel.tsx` 新增「交接任务」区块（textarea + 保存，可还原）。接入 claude / codex 等 agent 后，由其识别「生成交接任务」类意图时**调用该命令写入**；本期先落地存储层与手动录入，agent 自动触发需配合 MCP/命令集成（与 #1 同源）。
    8. **卡片固定宽度 + 受控截断**：`styles.css` 看板网格由 `repeat(4, minmax(0,1fr))` 改为 `repeat(auto-fill, minmax(248px,1fr))`，卡片 `width:100%` 且不再被压到过窄；`card-top` 设 `flex-wrap:nowrap` 且 `repo/num/★我的` 不收缩不换行（根除「不该换行的换行」）；仅 `gh-status`（Project 状态，可较长）保留省略号。

  - 改动文件：`db.rs`（两列迁移）、`github.rs`（`head_ref` + JQ）、`sync.rs`（`pr_map` 三元组 + 读写 `branch` + 测试库补 ALTER）、`commands.rs`（`Task` 加 `branch`/`handoff`、SELECT/mapper 索引同步、`record_handoff` 注册）、`lib.rs`（注册 `record_handoff`）、`types.ts` / `api.ts`（加 `branch`/`handoff` + `recordHandoff`）、`TaskCard.tsx`（meta-row 重构）、`DetailPanel.tsx`（agent 列表 + 交接区块）、`App.tsx`（backdrop）、`styles.css`（网格/卡片/meta-row/backdrop 样式）。

  - 验证：`cargo check` 通过；`npm run build`（`tsc --noEmit && vite build`）通过；`npm run tauri build` 产出 `TaskBoard.app`（`.dmg` 仍受沙箱 `/Volumes` 限制，未产出）。`record_handoff` 命令已注册进 `invoke_handler`，与 `list_tasks` 等并列。

  - 迁移注意：新增 `branch` / `handoff` 两列由 `db.rs::init` 的 `ALTER TABLE` 在应用启动时自动补齐（旧库无此两列也不会报错）；**重启用新构建后**首屏 `SELECT` 即可读到新列。

- **v0.3.11（2026-09-04）— agent 下拉扩至 38 个主流 coding agent**

  - 背景：v0.3.10 仅把 agent 下拉扩到 10 项，而用户截图显示市面主流 agent 有 20+ 个，需补全以覆盖常用工具。

  - 改动：`DetailPanel.tsx` 的 `AGENTS` 常量数组由 10 项扩为 **38 项**（覆盖 Claude Code / Codex / Codex CLI 之外的 OpenCode、ZCode、Gemini CLI、Cursor、Aider、Qwen Code，以及 Copilot、Windsurf、Augment、Amazon Q、Devin、Replit、Bolt、v0、Cline、Roo Code、Continue、Cody、Codeium、OpenHands、Factory、Goose、Phind、Tabnine、ChatGPT、Grok、Codestral、Llama、Helix CLI，与中文系的 豆包 / 通义灵码 / 智谱 GLM / Trae / Kimi / DeepSeek / CodeBuddy 等）。`value` 用规范化 slug（与 MCP/agent 自报名一致，保证已存档的 `session_agent` 仍能匹配），`label` 为下拉展示名；其余存储/展示链路不变。

  - 同步说明：MCP Server、AGENT\_INSTRUCTIONS.md、CLAUDE.md 中的 agent 名为**自由字符串**（无白名单），无需随下拉改动而同步；下拉仅为人工录入时提供快捷选择。

  - 验证：`npm run build`（`tsc --noEmit && vite build`）通过；`npm run tauri build` 编译 + 打包 `TaskBoard.app` 成功产出（`.dmg` 仍受沙箱 `/Volumes` 限制未产出，与历史一致，非代码问题）。

- **v0.3.12（2026-09-04）— 把 MCP Server 集成进 app 二进制（消除散落文件夹 + Python 依赖）**

  - 背景（用户反馈）：装了 `.app` 之后，MCP Server 仍是独立进程，由 `~/.workbuddy/mcp.json` 用**写死在本机环境**的绝对路径引用 `mcp_server/server.py` + 受管 python 解释器。它和 app 是两套东西——装了 app ≠ 装了 MCP，必须单独保留 `mcp_server/` 文件夹，且那条配置换机器就失效。

  - 根因：MCP 此前是外部 Python 脚本，未被打包进 Tauri 产物，数据库路径虽与 app 一致（`~/Library/Application Support/com.liushizhao.taskboard/taskboard.db`）但运行形态完全独立。

  - 方案（用户选定 B：Rust 原生子命令）：把 MCP 做成 `taskboard` 二进制的 `mcp` 子命令，**完全内置**，而非打包 Python 资源（方案 A 仍依赖系统 python3 且仍是散落文件）。

  - 改动：

    1. `db.rs`：抽出无 GUI 的 `db_path_default()`（用 `dirs::data_dir()` + `APP_IDENTIFIER` 推导，与 Tauri `app_data_dir` 解析一致）、`data_dir()`、`APP_IDENTIFIER` 常量；新增共享的 `open_db(path)`（建表 + 全部历史 `ALTER` 迁移 + 默认设置），GUI 的 `init(app)` 改为调用它，确保 **schema 单一来源、MCP 与 GUI 零漂移**。
    2. 新增 `mcp.rs`：`src-tauri/src/mcp.rs` 实现 stdio JSON-RPC 2.0（LSP `Content-Length` 分帧，逐字节读取避免 BufRead 与 `read_exact` 错位）；`initialize` / `ping` / `tools/list` / `tools/call` 全覆盖、通知（无 id）不回；`busy_timeout=5000`（`execute_batch` 设置，兼容与 GUI 并发占用）；6 个工具（`list_my_tasks` / `get_task_status` / `update_task_status` / `record_session` / `record_handoff` / `clear_session`）与 `mcp_server/server.py` 完全对齐；`issue` 引用解析（`repo#number` / `owner/repo#number` / GitHub URL）、状态枚举（四态 + 中文）一致；`parse_issue_ref` 纯标准库手写（无 `regex` 依赖）。
    3. `main.rs`：argv 含 `mcp` 时调用 `taskboard_lib::run_mcp()`（走 stdio 循环，**不启动 GUI**），否则走原 `run()`。`lib.rs` 注册 `mod mcp` + `pub fn run_mcp()`。
    4. `mcp_server/server.py` 保留为**便携 / 开发兜底**（非 macOS 或未装 app 时仍可让 Agent 读写同一数据库），工具契约与内置二进制保持一致；README 配置片段改为指向 app 内二进制，并说明兜底路径。
    5. `~/.workbuddy/mcp.json` 的 `taskboard` 项改为 `"command": "/Applications/TaskBoard.app/Contents/MacOS/taskboard", "args": ["mcp"]`（装到 `/Applications` 后的规范路径；装到别处改绝对路径即可）。

  - 验证：`cargo check` 通过；`cargo build --release` 产出 `target/release/taskboard`（12 MB）；**冒烟测试**（Python 驱动二进制 `mcp` 子命令）实测：`initialize`→`serverInfo v0.3.12`、`tools/list`→6 个工具齐全；对**生产库** `list_my_tasks` 返回 78 条真实任务；对 **DB 副本** 验证 4 个写工具（`update_task_status` / `record_session` / `record_handoff` / `clear_session`）全部 `isError:false` 且 `get_task_status` 回读 `handoff` 正确（未改生产库）。已把新二进制 `cp` 进 `TaskBoard.app/Contents/MacOS/taskboard`，对该 `.app` 内二进制复测 `initialize` / `tools/list` 正常、无 `busy_timeout` 报错（已用 `execute_batch` 修正 PRAGMA 返回行报错）。

  - 效果：装了 app 即自带 MCP，mcp.json 指向 app 内二进制即可，**不再需要单独的** **`mcp_server/`** **文件夹、不再依赖受管 python**。

- **v0.3.13（2026-09-04）— 卡片微调：移除分配人展示 + 固定列宽加横向滚动**

  - 背景（用户 3 条反馈，附截图）：

    1. 把"无人认领"挪到日期上一行。
    2. 把 issue id 后的分配人信息去掉。
    3. 固定卡片宽度，给看板加横向滚动条。

  - 改动：

    - `TaskCard.tsx`：

      - 移除原先 `meta-row` 中"分配人 @xxx"整段渲染（`assigneeNames` 计算一并删除）。

      - "无人认领"保留在 `meta-row`（日期上一行），改为基于 `task.ownership === "notassignee"` 判定（与卡片左边框 `.unassigned` 一致），不再依赖 `assignees` 拆分。

      - `meta-row` 注释同步更新（"@我 / 无人认领 / 关联分支；分配人不再展示"）。

    - `styles.css`：

      - `.board` 从 `display: grid`（`repeat(auto-fill, minmax(248px, 1fr))`）改为 `display: flex; flex-direction: row; overflow-x: auto; overflow-y: hidden; min-height: 0;`——超出窗口宽度的列走横向滚动。

      - `.column` 固定 `flex: 0 0 320px; width: 320px;`——列宽与卡片宽度随之恒定（≈300px 可读），不再被压窄或拉宽。

      - `.card` 注释更新（宽度跟随列宽）。

  - 关于 #1 的备注：源码里"无人认领"在 v0.3.10 起就已位于日期上一行（`meta-row`），但用户截图显示它贴在 issue id 后——说明运行的 `.app` 前端是陈旧构建，未含 v0.3.10 的 card 重构。本版重新 `npm run tauri build` 出新 `.app`，源码本就正确，运行时也校正到位。

  - 验证：`npm run build`（`tsc --noEmit && vite build`）通过；`npm run tauri build` 一次性产出 `TaskBoard.app` 与 `TaskBoard_0.1.0_aarch64.dmg`（本次 dmg 也成功，沙箱未拦截）。

- **v0.3.14（2026-09-04）— 卡片逆调整：恢复分配人 + 分支移入详情 + 横向滚动上移 app + 修复同步按钮 hover**

  - 背景（用户 4 条反馈，附截图）：v0.3.13 的卡片改动部分需回退，并修正"立即同步"按钮 hover 看不见文字的问题。

    1. 恢复日期上一行（卡片 `meta-row`）的"分配人 @xxx"展示。
    2. 卡片上不再显示分支；分支**只在卡片详情（DetailPanel）中显示**。
    3. 撤销 `.board` 的横向滚动；改为**整个** **`.app`** **加横向滚动条**（看板列超出窗口宽度时整窗横向滚动，顶栏/工具栏 `position: sticky; left:0` 保持可见）。
    4. 鼠标悬停"立即同步"按钮时，按钮变白底、文字仍是白色 → 看不见文字，需修复。

  - 改动：

    - `TaskCard.tsx`：

      - 恢复 `const assigneeNames = task.assignees ? task.assignees.split(",").filter(Boolean) : [];` 计算。

      - `meta-row` 重新渲染"分配人"整段（`assignee-info` 含 label + 多个 `assignee-name` `@xxx`）；无人认领仍基于 `ownership === "notassignee"` 判定。

      - 移除 `meta-row` 中的 `🌿 分支`（`branch-tag`）渲染——分支不再出现在卡片上。

    - `DetailPanel.tsx`：在「GitHub」区块「分配人 / 无人认领」下方新增一行 `🌿 分支：{task.branch}`（仅当 `task.branch` 存在），确保卡片移除分支后信息不丢。

    - `styles.css`：

      - `.app` 加 `overflow-x: auto`（横向滚动上移到整窗）。

      - `.board` 去掉 `overflow-x: auto; overflow-y: hidden;`，保留 `display:flex; flex-direction:row` + `min-height:0`（列容器，列宽仍固定 320px）。

      - `.topbar` / `.toolbar` 加 `position: sticky; left: 0; z-index: 5;`，整窗横向滚动时搜索/同步/设置始终可见。

      - 新增 `.btn.primary:hover:not(:disabled)`（`background:#0858d6; border-color:#0858d6; color:#fff`）——其特异性（0,4,1）高于 `.btn:hover:not(:disabled)`（0,3,1），覆盖后保持 accent 底色 + 白字，消除白底白字。

  - 验证：`npm run build`（`tsc --noEmit && vite build`）通过；`npm run tauri build` 编译 + `.app` 产出成功；`.dmg` 因沙箱拦截 `/Volumes` 挂载失败，改用 `hdiutil create -srcfolder` 直读文件夹打包产出 `TaskBoard_0.1.0_aarch64.dmg`(4.2MB)。

- **v0.3.15（2026-09-04）— 完全替换 gh CLI 改用 GitHub PAT + visual polish（卡片配色 / 我的去背景）**

  - 背景：用户反馈"使用 gh 命令获取有些不妥——切 gh 账户后直接获取不到任何 task，建议用 GitHub 登录获取任务信息"。沿袭当前会话里揭示的两个 gh 历史包袱，正式移除 gh 子进程路径；同期打磨卡片视觉。

  - **架构变更（PAT 替换 gh）**：

    1. 移除 `github.rs` 全部 gh 子进程代码（`resolve_gh` + `run_gh` / `run_gh_once_timed` / `current_login` / `run_gh_graphql` 共约 250 行），新增 `GitHubClient { pat, login, http }` 用 `reqwest` blocking + `rustls-tls`（无 native-tls 依赖，跨平台编译干净）直接调 GitHub REST/GraphQL。删掉 800ms 调用间隔与阶段 4s 冷却，改由客户端主动解析 `X-RateLimit-Remaining` / `X-RateLimit-Reset` / `Retry-After`（Search 调用间仍固定 1s 间隔，对应 30 req/min 上限）。
    2. `db.rs` 默认设置加 `pat_token` + `last_sync_error` 两项；`meta` 是 kv 表，新字段首次启动时由 `DEFAULT_SETTINGS` 写入。
    3. `sync.rs` 改造：用 `pat_token` 构造 `GitHubClient`（构造时自动 `GET /user` 探测 login 并缓存）；空 PAT 直接报错 "未配置"由 `lib.rs` 跳过本次同步并写入错误提示。`sync.rs` 不再触碰 `gh_path` / 探测 gh 路径 / 当前 gh 登录用户。
    4. `commands.rs` 新增 `save_pat` / `test_pat` / `clear_pat` 三个 Tauri 命令（构造客户端时自动探测账号，写回 `meta.login` 便于前端展示）；`Settings` 加 `hasPat` / `lastSyncError` 两个字段。
    5. `lib.rs`：`run_sync` 启动前检查 PAT，缺失则设置 `last_sync_error` 并跳过；同步成功清空该字段；前端 `App.tsx` 渲染 `lastSyncError` 为红色 banner。
    6. `SettingsPanel.tsx`：PAT 输入框（password type）+ 当前账号展示 + 「保存 PAT / 测试连接 / 清除」三按钮。保存后清空 input 显示（防肩膀偷看 / 截屏）。`gh_path` 字段保留为只读兼容字段。

  - **visual polish（同期合并发布）**：

    1. **卡片右上 Project Status 配色**：新增 `gh-status-todo`（中性灰）/ `doing`（淡蓝）/ `processed`（淡紫）/ `done`（淡绿）/ `canceled`（淡红），替换原本统一的灰底配色。匹配逻辑按关键词（`TaskCard.tsx` 内维护，emoji 与文案变体兼容）。
    2. **「我的」去掉粉色背景**：`.card.mine` 去 `background:#fff6f6`，仅保留左侧 4px 红色边框；避免与「@我」(橙)、「新评论」(绿)、「💬 新评论」等暖色标签混淆。

  - **根因复盘（消解）**：

    - 触发事件：CI 产物首次同步 5 个 Search 源全 422 → `meta` 的 `last_sync_error` 写明 "Validation Failed"。

    - 直接原因：`gh auth switch` 切到 `ShawnLiuSZ`（GitHub 早期 **listed user** 类型），Search API 对 listed user 一律拒绝搜索（HTTP 422）。

    - 深层原因：探测路径用了子进程 `gh` + 环境探测，无法与 `gh` 内部账号切换解耦；其它历史包袱还含管道缓冲 60s 死锁、`gh api graphql -F` 临时文件等。

    - 直接修复：把 DB `meta.login` 改回 `liushizhao2025` 让看板瞬间恢复；本版从架构层根治。

  - **改动文件**：`Cargo.toml`（+ `reqwest`）、`github.rs`（整体重写）、`db.rs`（+2 设置项）、`sync.rs`（+49 行、`fetch_*` 去 gh 参数）、`commands.rs`（+3 命令 + PAT 类型）、`lib.rs`（PAT 检查 + 新命令注册）、`mcp.rs`（版本号 0.3.11 → 0.3.15）、`SettingsPanel.tsx`（PAT 块 +3 按钮）、`TaskCard.tsx`（状态类名映射）、`App.tsx`（banner 改用 `lastSyncError`）、`styles.css`（5 色 + 去掉粉底）、`types.ts` / `api.ts`（PAT 类型与方法）。

  - **不在本期范围**（已记 backlog）：fine-grained PAT 强化引导、系统 keyring 存储、OAuth、设备码流、多账号切换（→ v0.3.16 单独排期）。

  - 验证：`cargo check` 0 errors / 2 warning（dead\_code 已被 `#[allow(dead_code)]` 抑制为已知 pattern，注释说明）；`npm run build` 通过；`npm run tauri build` 产出新 `.app`。


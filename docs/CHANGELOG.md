# 版本更新记录（Changelog）

> **中文**
>
> English version see [CHANGELOG.en.md](./CHANGELOG.en.md)

> TaskBoard 各版本的更新说明与修复记录。当前版本与项目概览见 [README](../README.md)。

- **v0.6.0（2026-09-17）— 修复 Rust 测试随机 disk I/O error（#266）**

  - **#266 测试临时库命名未隔离导致 CI 偶发失败**：`commands.rs` 的测试辅助 `mem_conn()` 把临时库只按 `process::id()` 命名并每次 `remove_file` 两次，Rust 测试同进程内并行执行时所有调用共用同一文件、互相 unlink 对方正在使用的库，初始化 schema 时随机撞 `disk I/O error`（重跑即绿）。`sync.rs:843` 的 `taskboard_headless_test.db` 也是完全固定名，属同一类隐患。详见 [docs/issue-266-test-flake.md](./issue-266-test-flake.md)。
  - **做法**：`mem_conn()` 临时库路径加**每调用递增的 `AtomicUsize` 序号**（`{pid}_{SEQ}`），保证每个连接独享一个文件；连接存活期不再 `remove_file`。`sync.rs` 固定名一并改为带 pid。新增防回归断言 `mem_conn_returns_unique_paths_per_call`（两次调用路径必须不同）。纯测试辅助改动，不涉及任何产品代码 / 公共 API / schema。
  - **验证**：`cargo test --lib -- --test-threads=16` → 102 passed / 0 failed / 3 ignored；连续 4 次 `cargo test --lib` 全绿（含新增断言）。CI `Rust Tests` 连续多次全绿。
  - **追加清理**：`sync.rs` 的 `sync_target_accounts` 测试与 `db.rs` 6 个测试在连接存活期仍调用 `remove_file` / `remove_dir_all`（#266 修 `mem_conn()` 时漏改的同类反模式），本次发版一并清理——统一 `drop(conn)` 后再清理，Windows 下不再 sharing violation 静默失败、Unix 下不再留孤儿 `-wal`/`-shm`。

- **v0.6.0（2026-09-17）— 多账号同步修复（#262）**

  - **#262 多账号同步失效：同步恒覆盖全部账号**：配置 ≥2 个 GitHub 账号后，立即 / 定时 / 启动 / 托盘四条同步路径每轮都只同步激活账号、其余账号永不同步（本机 `sync_logs` 历史从未有一轮覆盖 2 个账号）。根因是同步目标集由 `meta.view_mode` 决定，而 `view_mode` 恒为默认值 `single`——其唯一写入入口（topbar 的 `<select>`）已被 `597840b` 删除，后端 `set_view_mode` / `api.setViewMode` / i18n key 全部残留但无调用方（「有实现、无入口」）。详见 [docs/issue-262-multi-account-sync.md](./issue-262-multi-account-sync.md)。
  - **做法**：采用方案 A——**同步范围与视图模式解耦**，同步不再受 `view_mode` 限制，恒覆盖全部已配置账号（多账号用户核心诉求是「数据都要进本地库」）；抽出 `sync_target_accounts(conn)` 返回全部账号便于回归测试。`view_mode` 仅影响前端展示（单账号 / 聚合全部），并**撤回 `597840b` 的 UI 部分**在 topbar 重新接回「单账号 / 全部账号」切换，消除死代码（`set_view_mode` 的 `#[allow(dead_code)]` 误标注）与死 i18n key。附带修复：账号遍历处 `get_account_pat(...)?` 改为 `match` + 记失败 + `continue`，单账号读 PAT 失败不再中止整轮；`SyncResult` 新增 `accountsSynced` 字段，UI banner 在 ≥2 账号时展示「覆盖 N 个账号」。
  - **无 schema 变更**：`meta.view_mode` / `active_account_id` 继续存在并被消费，仅不再参与同步目标选择；`SyncResult` 为进程内返回结构。
  - **验证**：新增 Rust 回归测试 `sync_target_accounts_covers_all_accounts_regardless_of_view_mode`（写入 `view_mode=single` + 2 账号仍断言返回 2 个目标）；全套 `cargo test --lib` 102 passed、`tsc --noEmit` 0 error、`npm test` 13 文件 136 例、`i18n:check` 中英各 349 key、`prettier --check` ✅、`npm run lint` 18 warning（未超 `--max-warnings 20`）、`check-doc-links.py` ✅。

- **v0.6.0（2026-09-17）— Agent 接入面板：设备扫描（#263）**

  - **#263 刷新升级为设备扫描**：刷新按钮（文案改为「扫描设备」）现在一次点击就探出本机**已安装**与**已卸载**的 agent，直接回答「这台机器上到底装了哪些 agent」。原先 `host_present` 只看配置根目录是否存在（`hooks.rs` 的 `root.is_dir()`），于是 ① 装了 CLI 但从未运行（没有配置目录）的 agent 被误判「未安装」——本机实测 `codex` 在 PATH 上却没有 `~/.codex`；② 后端只有 5 个 `AgentSpec`，其余 34 个 agent 永远落在「手动配置」组，看不出本机装没装；③ 卸载 CLI / 删掉 `.app` 之后只要配置目录残留、或接入文件还在，就完全没有提示。详见 [docs/issue-263-agent-device-scan.md](./issue-263-agent-device-scan.md)。
  - **做法**：三类信号合并探测——PATH 与常见安装目录下的可执行文件、`$HOME` 配置目录、macOS `/Applications` 与 `~/Applications` 的 `.app` 包；按最强信号派生 `cli` / `app` / `config-only` / `none`。新增 `scan_agent_hosts` command 返回全量 39 项探测结果，并与上次快照（`meta.agent_scan_snapshot`，本次唯一写入目标）对比得出「新发现安装 / 疑似已卸载」，首次扫描不报变更（否则首刷会把全部已装 agent 报成新增）。前端把分组规则抽成纯模块 `src/agent-groups.ts`，新增「疑似已卸载」分组（红点，行内给出残留路径 + 复用一键卸载清理）与每行设备徽标（本机已安装 / 已安装应用 / 仅残留配置 / 未检测到；未扫描时不渲染，避免整屏噪音）。`status_one` 新增可选探测参数：正式路径下「装了没跑过的 CLI」归入**可接入**而不再误判「未安装」，单测传 `None` 保持纯配置目录语义（否则断言会依赖开发机 PATH）。
  - **无 schema 变更**：未新增/修改 SQLite 表，只多一个 `meta` 键（键值表天然向后兼容）；老库无该键即按首次扫描处理。扫描本身只读文件系统，不联网、不写任何 agent 配置文件。
  - **验证**：Rust 新增 6 例——含 `HOST_SPECS` 与 `app/src/agents.ts` 的 agent id 集合**双向一致**的防漂移断言（`include_str!` 直接解析前端源文件）、快照 diff 的新装/卸载/重装/首次四种迁移、应用包名大小写不敏感匹配；既有 11 处 `status_one` 调用同步补参，语义不变。前端新增 `src/agent-groups.test.ts` 15 例 + SSR 冒烟 1 例（按钮文案为「扫描设备」且未扫描时不出现设备徽标）。`cargo test` 101 + 21 passed / 0 failed、`tsc --noEmit` 0 error、`npm test` 13 文件 132 例、`npm run build` ✅、`i18n:check` 中英各 347 key、`check-doc-links.py` ✅。真机渲染复核待起 dev server 确认（本机沙箱内无头 Chrome 已不可用）。
  - **#263 追加修正：分组收敛为 4 组**——「未安装」与「手动配置」两个维度（设备 vs 能力）合并为 **未接入**。理由：① 设备装没装这一原本支撑拆分的依据，已由新增的**每行设备徽标**承载；② 两组在本面板内的可操作性完全相同（都没有安装按钮，一个因本机未装、一个因未验证一键接入）；③ 「未安装」组最多 5 个候选、实测常只剩 1 行，组头比内容还吵。信息不丢：行内 detail 让两类**自述**（手动 agent 显示「手动配置：~/.codex/hooks.json」，支持但本机没装的显示「本机未检测到」），组级提示改写为覆盖两种情形的一句话；手动 agent 即使被判「已卸载」也不进「疑似已卸载」组（本面板从未给它装过东西，无残留可清）。顺带修正底部提示原先只看 `newlyRemoved` 导致「有提示却无可清理行」的问题（改为与分组结果同源）。i18n 删 `group.missing` / `group.manual`、加 `group.notIntegrated` / `manualPath` / `notDetected`（中英各 348 key）；`npm test` 13 文件 134 例（含「共 4 组、不得回归出 missing/manual」守卫）。

  - **#265 窗口过窄侧边栏自动收起为纯图标模式**：窗口宽度 `< 900px` 时，左侧 Sidebar 由 200px 的固定文字导航自动收起为 ~56px 的纯图标模式——只保留图标、隐藏文字标签 / 账号名 / 分组标题 / 空态提示，账号项靠 `title` 悬浮提示辨识。详见 [docs/issue-265-sidebar-collapse.md](./issue-265-sidebar-collapse.md)。
  - **做法**：纯响应式、不持久化——`App.tsx` 用 `window.innerWidth < 900` 作初始态并监听 `resize` 驱动 `sidebarCollapsed` 状态；状态值与上次相同（同为 false / true）时 `setState` 为 no-op，不触发多余重渲染；`Sidebar` 据此在 `nav` 上加 `.collapsed` 类。main-content 仍 `flex: 1` 自动占满释放出的空间，主区无需改动。纯前端，SQLite / Rust 零改动。
  - **验证**：`tsc --noEmit` 0 error、`npm run build` ✅、`npm test` 13 文件 136 例（新增 `styles.test.ts` 侧边栏收起静态回归 2 例）、`i18n:check` 中英各 348 key（无新增 key）、`prettier --check` ✅、`check-doc-links.py` ✅。真机渲染复核待起 dev server 确认（沙箱无头 Chrome 不可用）。

- **v0.6.0（2026-09-17）— 左右分栏布局 + Agent 接入面板（#259）**

  - **#259 左右分栏重构**：新增左侧固定 Sidebar（200px）承载全部功能入口——记事本 / 账号列表（点选切换 + 添加账号）/ 设置 / Agent 接入 / 同步日志 / 账号登录 / 底部关于。顶栏从「账号下拉 + 4 按钮 + 同步」精简为「品牌 + 总条数 + 上次同步 + 立即同步」。设置 / 账号 / 同步日志由 Modal 改为**主区内嵌全高页面**（面板组件零侵入，靠 `.panel-page` 容器 + CSS 覆盖）；NotesPanel 改为主区「页面」，选中才渲染。详见 [docs/issue-259-sidebar-nav.md](./issue-259-sidebar-nav.md)。
  - **做法**：`activeModal` 状态废弃，改 `nav`（`notes | board | settings | agents | synclogs | accounts`）+ 独立 `showAbout`（关于保留 Modal）；账号切换复用 `handleSwitchAccount` 并切回看板；新增 `Sidebar.tsx`、`AgentPanel.tsx` 两个组件；`main-layout` CSS 废弃由 `app-shell` + `main-content` 替代。纯前端改动，SQLite / Rust 零改动。
  - **验证**：`tsc --noEmit` 0 error、`npm run build` ✅、`npm test` 12 文件 99 例、`i18n:check` 中英各 334 key、`check-doc-links.py` ✅。真机手动 QA 待补充。

  - **#259 记事本四列布局修正**：真机上四列被压成 ~18px 竖条（文字逐字换行）、面板只占主区左侧 1/4、四列区内部还带横向滚动条；且四列在任何窗口尺寸下都不并排（1180×760 默认 2+2、1440 3+1、900 叠成 4 行）。**根因是两个缺陷叠加**：① `NotesPanel` 给面板挂了行内 `style={{flex:'0 0 25%', width:'25%'}}`（`#202` 拖宽机制遗留），行内样式优先级高于样式表，导致 `.notes-page .notes-panel { flex:1 1 auto; width:100% }` 的「撑满」覆盖**从未生效**（实测面板 245px，比创建列自己的 280px 还窄，四列区只剩 20px ⇒ 横向滚动条）；② 四列是固定 `flex: 0 0 260px` + 容器 `flex-wrap: wrap`，四列需 1076px ⇒ 必然换行。详见 [docs/issue-259-sidebar-nav.md](./issue-259-sidebar-nav.md)（「追加修正：记事本四列并排 + 面板撑满主区」一节）。
  - **做法**：先移除 `#202` 宽度机制（`widthPct` / `clampNotesWidthPct` / `readNotesWidthPct` / `.notes-resizer` / `notes.resizeTitle` / 拖拽与键盘处理），把 `.notes-panel` 直接定义成整页形态（`flex: 1 1 auto` + `min-width/min-height: 0`，删掉 320px 硬锁 / sticky / 50% 上限），从结构上保证行内宽度不会被挂回来；再按看板 `.column` 既有模式改造四列——容器去 `flex-wrap` + `overflow: hidden`，`.note-col` 改 `flex: 1 1 0` + `min-width: 0`，纵向滚动下沉到 `.note-col-body`，窄列用 `.note-card { min-width: 0 }` + `.note-foot { flex-wrap: wrap }` 换行收缩而非裁剪；**收起粒度从整面板改为只收起创建列**（30px `.notes-add-rail` 作四列容器的兄弟节点），空数据时始终渲染四列，创建列 textarea 撑满列高；顺带清理 `.notes-panel.collapsed` / `.notes-rail*` / `.notes-add-col-open` / `.notes-empty*` / `.notes-resizer*` / `.notes-date-list` / `.notes-group*` 死代码与 5 个无用 i18n key（中英各 337），删除随功能失效的 `notes-width.test.tsx`。纯前端，SQLite / Rust 零改动。
  - **验证**：修正后的隔离复现页（补上遗漏的行内样式）复现出面板 `245x617` / 四列区 `20x575`（`scrollLeft=260` 可横滚）/ 四列 `w260@top52 \| w260@top329`；新增回归测试 `app/src/components/notes-layout.test.ts` 12 例（含「面板不得挂行内宽度」「`.notes-panel` 不得回到固定 320px / sticky / 50% 锁」），并**反向验证** 5 类缺陷写法改回后对应 6 条断言全部失败。⚠️ 修复后的**渲染复核未完成**：本机沙箱内 Chrome 无头已无法启动（`sandbox initialization failed`，提权未生效），需在 `npm run tauri dev` 窗口确认。`tsc --noEmit` 0 error、`npm test` 12 文件 105 例、`npm run build` ✅、`i18n:check` 中英各 337 key、`prettier --check` 新增/改动文件 ✅、`check-doc-links.py` ✅。

  - **#259 记事本交互定稿（第三轮）：四列改看板列模式**——四列**固定宽度**且与最左侧创建列同宽（`.notes-panel` 上 `--notes-col-w: 280px`，创建列与 `.note-col` 共用同一变量，改一处即可整体调宽），列放不下时出**有意**的横向滚动条（`.notes-card-cols` 显式 `overflow-x: auto`、不换行），对齐看板任务列的交互；记事卡片**不再用左侧色条**区分优先级（删 `.note-card::before`，`--note-accent` 仅剩底部标签圆点在用）。固定列宽从结构上消除了「容器被压窄 ⇒ 列被压成竖条」这类退化，**取代上一轮**的「等分 + 不滚动」方案。回归测试 13 例并反向验证（一轮注入 5 处缺陷 ⇒ 3 条新断言失败；第一轮注入脚本因 `overflow-x: auto` 片段先命中了文件里另一条规则而「假全绿」，已改为带选择器锚点并断言每处替换命中）。
  - **#259 记事本第四轮：列包围框可见 + 宽窗口不留死空间**——真机发现四列的「包围框」**根本看不见**：`.notes-panel` 与 `.note-col` 同为 `--surface-2`，列和页面底色相同 ⇒ 列融进页面，看起来像卡片悬在空白里（用户标注的「上边距不一致」实为手画框围着不同内容）；且固定 280px 四列在宽窗口下右侧留一大块空白。做法：面板背景改 `var(--bg)`（与看板页面一致 ⇒ surface-2 列的框可见，即看板原样式）；`.note-col` 改 `flex: 1 1 0` + `min-width: var(--notes-col-w)`（宽窗口四列等分**撑满**，窄窗口**不低于 280px**、超出横向滚动——同时满足「列宽比较固定 + 横向滚动」与「宽度与面板一致」）；创建列改与四列**同款包围框**（surface-2 圆角块，去 `border-right`），`.notes-body` 统一 `gap/padding`；`.notes-card-cols` 显式 `align-items: stretch`（列全高，与创建列等高）；空列提示改看板 `.empty` 同款灰字。回归测试 16 例并反向验证（4 处缺陷 ⇒ 4 条新断言失败）。
  - **#259 记事本第五轮：移除整行页头，导入/导出挪进创建列；列头间距统一**——页头（记事本标题 + 计数 + 导入/导出 + 收起）与侧边栏标题重复且白占一行纵向空间，整行删除（`.notes-head*` / `.notes-tools` CSS 一并清理；`.notes-head-icon` 仍被 AgentPanel 复用故保留）；导入/导出与「收起创建列」挪到**创建列顶部工具行**（列收起时随列隐藏）；列头→内容间距统一（列头 `margin-bottom: 2px→0`、列体 `padding-top: 0→8px`，空列提示去独立内边距）——旧值下有记录的列上边距只有 2px，与空列观感不一致；`.notes-body` 内边距对齐看板（`12px 16px 16px`）。回归测试 19 例并反向验证（页头回归 / 工具行挪出创建列 / 间距回退 ⇒ 3 条断言失败；注入锚点须选目标节点自身特征串——`fileInputRef` 首次出现是其声明处，曾导致切错块假通过）。
  - **#259 记事本第六轮：列头高低不一致**——有记录的列（列体内部滚动）的列头比空列高 ~5-7px。像素测量确认五个列框顶边完全对齐、高度一致，唯独可滚动列的列头被滚偏：`overflow: hidden` 的盒子仍是滚动容器，列体滚到头后继续滚动的手势会**链式传导**到列框本身。做法：`.note-col` 追加 `overflow: clip`（只裁剪、不是滚动容器，不支持时回退 hidden），`.note-col-body` 加 `overscroll-behavior: contain`（列体滚到头不向父级链式传导）。回归测试 20 例并反向验证。
  - **#259 记事本第七轮（用户 DevTools 定位）：空列复用看板裸 `.empty` 类，多出 8px 顶部内边距**——记事本空列的列框挂了 `empty` 类，而看板的 `.empty { padding: 8px 4px }` 是全局选择器，直接命中记事本列框 ⇒ 空列列头被顶下 8px，与有记录的列「上边距不一致」。做法：记事本列改用专属类 `note-col--empty`（相关 CSS 同步改名），看板 `.empty` 规则限定作用域为 `.board .empty` 防止再漏。回归测试 21 例并反向验证。
  - **#259 记事本第八轮：四列与看板列视觉统一**——用户要求记事本列改用账号面板（看板）列的样式与宽度，避免两个面板「列演示不统一」。逐条对齐 `.column` / `.column-head` / `.column-body`：列宽改**固定 320px**（与看板一致，窄窗口由列区横向滚动）、列头几何 `margin: 8px 8px 2px / padding: 5px 10px / radius 7px`、列头底色按优先级取**看板同一套浅色**（紧急 `#fde7ec`、高 `amber-bg`、中 `#dbe9fc`、低 `#e6e7ea`）、列头内容改为「圆点 + 标题 + 右侧灰色计数」（原为彩色计数徽章 + 标题内嵌圆点）、列体 `padding: 0 8px 10px / gap 8px`；类名改为 `note-col--<优先级>`；为与看板统一，**取消空列灰化**（看板空列同样显示彩色列头与计数 0）。回归测试 24 例并反向验证（注入 7 处缺陷 ⇒ 5 条断言失败）。
  - **#259 记事本第九轮：列头改为看板状态列写法**——第八轮抄的是看板 **4 状态视图**的浅色胶囊列头（`.column-todo .column-head { background }`），而账号面板列实际用的是**状态列写法**：`.column-status-N { border-top: 3px solid var(--status-N) }`。改为：列顶 3px 状态色横条（`.note-col { border-top: 3px solid var(--col-accent) }`）+ 列头**无底色**（状态色只落在横条与圆点上，标题用默认文字色），列头几何与「圆点 + 标题 + 右侧灰色计数」保持与看板同参。回归测试 24 例并反向验证。
  - **#259 界面文案改名：记事本 → 备忘录**——用户可见的中文文案共 10 条由「记事本 / 记事」改为「备忘录」（侧边栏项、面板标题/导轨、导入导出按钮与提示、优先级分组名、删除确认、加载失败提示等）；英文 locale 保留 `Notes` 命名，代码标识与类名仍为 `notes` / `NotesPanel`（不影响行为）。`i18n:check` 中英 key 数与占位符一致。
  - **#256 检查更新慢且失败原因不可见**：v0.5.0 的「检查更新」是串行的——先等 tauri updater 通道（该通道无内置超时，弱网下 hang 很久），失败后才走 GitHub API fallback，总耗时是加和；且 updater 的失败原因被静默吞掉，用户只看到「很慢才出现的『前往下载』按钮」。实测用户环境：v0.5.0 + macOS Apple Silicon。详见 [docs/issue-256-update-check.md](./issue-256-update-check.md)。
  - **做法**：双通道同时发起、分阶段展示——fallback 先到先显示手动下载（不等慢的 updater），updater 到达后升级为一键更新或附带失败原因；单路超时封顶（fallback 30s / updater 90s）。只改前端（新纯模块 `src/utils/updateCheck.ts` + `AboutPanel`），零新依赖、Rust 零改动。
  - **验证**：新增单测 11 例（`viewFallback` 4 + `viewUpdater` 4 + 超时收敛 3）、`npm test` 12 文件 99 例、`tsc --noEmit` 0 error、`i18n:check` 中英各 305 key。真机复测待含本修复的版本发布后（v0.5.0 旧面板行为改不了，需手动安装一次新版）。

- **v0.5.1（2026-09-15）— 修好既有 CI（#252）+ 未同步 issue 按需拉取（#250）+ 同步日志表格横向滚动（#248）**

  - **#252 `quality-check.yml` 恢复全绿**：#246 引入该 workflow 时留下两类既有失败 —— `Frontend Lint` 的 `format:check` 报 **29 个文件**未格式化（`.prettierrc` 加了但 `npm run format` 从未跑）；`Rust Clippy` / `Rust Tests` 缺 Tauri 的 Linux 系统库（`glib-sys` / `gio-sys` / `gobject-sys` 在 build script 阶段 pkg-config 失败）。两者都已在 `develop` 上红了很久，让每个新 PR 的 CI 都必然红（#249、#251 均被挡）。详见 [docs/issue-252-ci-green.md](./issue-252-ci-green.md)。
  - **做法**：格式化单独一个 commit，并用「构建产物 sha256 逐字节一致」证明零语义影响（比测试通过更强的证据）；系统库**不复制第三遍**，抽成 composite action `.github/actions/install-linux-deps`，`release.yml` 与 `quality-check.yml` 的两个 Rust job 共用同一份清单（`runner.os` 判断放在 action 内部）。
  - **注**：`npm run lint`（ESLint）一直是通过的（`--max-warnings 20` 未触发，实际 17 条 warning），本次未动 ESLint 配置；亦未把 Rust job 挪到 macOS runner（计费约 10 倍，且 release 矩阵已覆盖 Linux）。
  - **验证**：`format:check` 29 → 0、格式化前后产物哈希一致、`tsc --noEmit` 0 error、`npm test` 11 文件 88 例、`npm run lint` exit 0、`i18n:check` 各 302 key、5 个 workflow + action.yml YAML 合法且断言两个 Rust job 均引用该 action。CI 结果以本 PR 运行为准。

  - **#250 消除写状态时的「任务不存在」**：`tasks` 表只由同步单向填充，而 MCP 工具是纯本地 SQL，于是**刚创建、还没同步到的 issue** 会让所有写路径报「任务不存在」（实测：issue 建于 10:26，10:52 调用 `update_task_status` 仍失败）。现在未命中时会**按需拉取该单个 issue** 并落库，再执行原操作；只读 GitHub（单次 `GET`）、不触发全量同步、已存在的任务零额外请求。返回体新增 `pulled` 标记（`get_task_status` 另有 `reason`）。详见 [docs/issue-250-ondemand-issue-pull.md](./issue-250-ondemand-issue-pull.md)。
  - **实现要点**：把同步内联的 upsert 抽成 `db::TaskUpsert` + `db::write_task`（两种模式共用同一份列清单与参数绑定）；按需拉取用 `InsertIfAbsent`（`ON CONFLICT DO NOTHING`）——单 issue REST 拿不到 `project_status` / `mentioned` / `pr_*`，用覆盖模式会把同步刚写好的值清空。拉取必须在写入**之前**（自定义列的校验要读该行 `account_id`）。`parse_issue_ref` 原先会丢掉 owner（拉取需要 owner+repo），已下沉到共用解析器；Rust 侧新增 `on_demand.rs`、`github.rs::fetch_issue`（404 → `Ok(None)`）。
  - **真机发现的两个坑（单测测不到，已补测试固化）**：① 账号匹配必须同时看 `org` 与 `login`——实测 task-dashboard 所属账号 `org` 是**空串**（个人命名空间），只按 org 匹配会让本功能对该仓库完全不可用；② 「API 请求用的 owner」与「落库的 `owner` 列」是两回事（后者与同步一致写 `account.org`），不区分会拼出 `/repos//repo/...`。另外 `repo#N` 不带 owner 时 404 不代表 issue 不存在，错误文案会带上实际查询目标与改写提示。
  - **无 schema 变更**：未改 `tasks` 表结构，无需迁移。
  - **验证**：`cargo test --lib` 93 passed（+11）、`cargo test --test db_test` 21 passed、Clippy 零警告、`python3 -m unittest discover -s mcp_server` 26 passed（新增 `mcp_server/test_server.py`，并接入 `mcp-schema-check.yml`）、`tsc --noEmit` 0 error、`npm test` 10 文件 84 例、`check-mcp-columns.py` 24 列、`check-doc-links.py` ✅。另有**真机端到端验证**（数据库副本 + 真实 PAT）：未同步 issue 写状态返回 `pulled:true`、再次调用 `pulled:false`、落库字段与真实 GitHub 响应一致、失败路径文案带原因（结果见知识库文档）。

  - **#248 两个页签的右侧列被静默裁切**：`.sync-logs-table-wrap` 用 `overflow: hidden`，溢出列被直接裁掉且**不产生任何滚动条**——「同步记录」的错误列、「API 明细」的明细列，恰好是 `#161` / `#235` 新增的交互入口，默认窗口（1180×760）下等于功能不可用。改为 `overflow: auto`；同时把 `.sync-logs-body` 改为纵向 flex 列、容器补 `min-height: 0`，使**横纵滚动条同处一个视口**——只改 `overflow-x` 是不够的，横向滚动条会落在整张表格底部（40 行日志时位于可视区下方 **1029px**），必须先滚到底才够得着。详见 [docs/issue-248-synclogs-hscroll.md](./issue-248-synclogs-hscroll.md)。
  - **验证**：`tsc --noEmit` 0 error、`npm run build` ✅、`npm test` 11 文件 88 例（新增 `src/styles.test.ts` 4 例，且已反向验证——把 `overflow` 改回 `hidden` 即失败）、`i18n:check` 中英各 302 key、`check-doc-links.py` ✅。为让测试读到真实 CSS 文本，`vitest.config.ts` 开启 `css: true`（默认 `css: false` 会把 CSS 打桩成空串）并新增 `src/vite-env.d.ts` 提供 `?raw` 类型——**零新增依赖**，改用 Vite `?raw` 而非 `node:fs`（后者需要 `@types/node`，本仓库未安装，CI 会报 TS2307）。

- **v0.5.0（2026-09-13）— macOS 免重复放行 + 应用内自动更新（#231/#232）+ 应用内 API 调用明细（#235）+ 看板卡片调整（#237）+ 文档完整性（#239）**

  - **#231/#232 macOS 更新免除重复 Gatekeeper 放行 + 应用内自动更新**：根因是 ad-hoc 签名（`signingIdentity="-"`）的 designated requirement 直接绑定 `cdhash`，**每次构建都会变**，系统因此把每个新版本视为从未批准过的全新应用，放行记录永远命中不了。改为用**固定自签名证书**签名让 DR 恒定（首次放行后长期复用），并接入 `tauri-plugin-updater` 走应用内更新——更新包由**应用自身进程**下载，产物天然不带 `com.apple.quarantine`，Gatekeeper 完全不参与。同时修掉 #101 隔离标记自清长期空转：标记落在 **bundle 根目录**，原实现只清 `current_exe()`，`xattr -dr` 不向上越级，故 `has_quarantine(exe)` 恒为 false 提前返回；现同时清理 bundle 根与可执行文件。新增 `check_app_update` / `install_app_update` / `restart_app` 命令与 `taskboard://update-progress` 事件；About 页「检查更新」优先走应用内更新，失败**静默回退**为原版本号对比 + 跳转下载。详见 [docs/issue-231-macos-gatekeeper-update.md](./issue-231-macos-gatekeeper-update.md)。
  - **#235 请求/返回参数落盘 + 应用内可查**：新增 `api_logs` 表（`kind` / `method` / `target` / `status` / `ok` / `elapsed_ms` / `request` / `response`），把同步、领取任务（`claim_issue`）、更新状态（`set_project_status`）三路 GitHub API 调用的**请求参数与返回参数**落盘。同步日志面板改为**双页签**（「同步记录」/「API 明细」），明细页签支持按类型筛选、逐行展开查看请求与返回。承接 [#228](./issue-228-api-logging.md) 的 stderr 埋点（默认静默、终端可见），补齐「落盘 + UI 可视化」。详见 [docs/issue-235-in-app-api-log.md](./issue-235-in-app-api-log.md)。
  - **#235 实现要点**：`GitHubClient` 采用可选 sink（`new_with_sink`，`new` 保持原签名走 `None`），既有调用点零改动；drain 放在 `sync_account` 包装层，保证 `sync_account_inner` 内 `?` 提前返回的**失败路径也落盘**；`ApiLogEntry.ok` 独立于状态码（GraphQL 可 HTTP 200 带 `errors`）；请求/返回按字符截断（400/600）存摘要，保留 7 天 / 上限 2000 行；绝不写入 PAT。
  - **#237 移除账号行 / 新增创建人行 / 加大 repo#编号 字号**：卡片第一行的「归属账号」徽章（`@liushizhao2025`）整行移除——单账号视图下每张卡片都一样，无信息量；改为展示 issue **创建人**，位置在「分配人」**上一行**；`repo #编号`（如 `fad-backend #1198`）行字号 11px → **13px**，成为扫视整列时的视觉锚点。详见 [docs/issue-237-card-creator-row.md](./issue-237-card-creator-row.md)。
  - **#237 实现要点**：`tasks` 表新增 `author` 列（Search API `user.login` + GraphQL `author { login }` 两路取值，缺失即空串不阻断同步）；前端创建人空/纯空白时**不渲染该行**，不留空标签行；`accountLabel` / `accounts` 死 prop 链（TaskCard → Board → App）一并清理，`card.accountTitle` i18n key 删除、新增 `card.creatorLabel`。**迁移要点**：`author` 的 `ALTER TABLE` 必须放在 `migrate_tasks_v2_rebuild` **之后**的热路径——v2 物理重建的列白名单是写死的，不含后增列，放前面会被重建丢掉（#175 同款陷阱）。
  - **#239 文档完整性修复**：一次性修掉 7 类共 24+ 处缺陷——3 篇**被引用却从未创建**的文档（`issue-118-*` / `issue-119-*` / `perf-audit-optimization.md`，其中前两篇违反 §2.4「每功能必建 KB 文档」）已据实补写；15 处 `file:///Users/<家目录>/...` 绝对路径与 4 处相对路径深度错误改为 `../app/...`；5 处已漂移到无关代码的 `#Lxxx` 行号锚点删除。同时对 CHANGELOG 本身勘误与补录：v0.3.48 的 #119 条目原写「新增 zip 格式」失实（`zip` 并非 Tauri 2 有效 bundle 类型，当日已回滚），v0.3.50 条目补录原先缺记的 13 个 issue，并说明 **`v0.3.49` 是幽灵版本号**（从未打 tag、从未发布）。新增 `scripts/check-doc-links.py` + CI 防回归。详见 [docs/issue-239-doc-integrity.md](./issue-239-doc-integrity.md)。
  - **部署前置（一次性）**：#231 需在本机用「钥匙串访问 → 证书助理」创建名为 **`TaskBoard Local Signing`** 的自签名代码签名证书（身份类型「代码签名」，建议 3650 天），CI 通过 `APPLE_SIGNING_IDENTITY` 覆盖；`tauri.conf.json` 保留 `signingIdentity="-"` 使**没有证书的本地开发机不会构建失败**。首次发版还需生成 updater 的 minisign 密钥对并配置 `latest.json`。
  - **schema 变更**：新增 `api_logs` 表 + 两个索引（#235，新表走 `CREATE TABLE IF NOT EXISTS` 幂等，老库启动自动建表）；`tasks` 新增 `author TEXT NOT NULL DEFAULT ''`（#237，热路径幂等 ALTER，覆盖全部 `user_version`）。**无破坏性变更**，老库自动迁移。
  - **验证**：`cargo test --lib` 80 passed、`cargo test --test db_test` 21 passed（+2）、`tsc --noEmit` 0 error、`npm run build` ✅、`npm test` 10 文件 84 例（+5）、`i18n:check` 中英各 302 key、`check-mcp-columns.py` 24 列一致、`check-doc-links.py` 116 文件无缺陷。

- **v0.4.0（2026-09-12）— GitHub 写回反转（#214 认领 + #215 状态）+ 记事本宽度 + 详情重做**

  - **写回反转（产品约束变更）**：`AGENTS.md §2.1` / `PRD.md` 从"只读 GitHub"放宽为"默认读 + 用户确认的显式写回"；同步路径本身仍只读，MCP 工具保持只写本地。PAT 需配套升级写权限（classic `repo` + `project`；Device Flow scope 已补 `project`，老 token 需重授权）。
  - **#214 卡片认领**：点"无人认领"→ 确认框 → `POST assignees` 设自己为 assignee，本地乐观更新；owner 为空时从 URL 反推；全链路日志。详见 [docs/issue-214-claim-assignee.md](./issue-214-claim-assignee.md)。
  - **#215 详情 Project 状态写回**：同步补存 item/field/option 三件套（`projects.status_field_id`、`project_statuses.option_id`、`project_items` 新表，老库迁移）；`set_project_status`（缺 ID 即时补拉、closed 拒绝、乐观更新走同步同一决策）；详情 GitHub 状态行可点 + 确认框。详见 [docs/issue-215-proj-status-write.md](./issue-215-proj-status-write.md)。
  - **#196/#200 详情重做**：状态区永远按 `project.status` 展示与默认选中（#196）；宽度 460px→50%，去掉四态按钮，行间距 +1px（#200）。详见 [docs/issue-196-detail-project-status.md](./issue-196-detail-project-status.md) 与 [docs/issue-200-detail-width.md](./issue-200-detail-width.md)。
  - **#202/#209 记事本宽度可调**：右缘拖拽 + 键盘 ±1%，按主区百分比（25%–50%，默认 25%），localStorage 持久化；拖动中 DOM 直写 + rAF 合并；`main-layout` grid 改 flex row。详见 [docs/issue-202-notes-width.md](./issue-202-notes-width.md) 与 [docs/issue-209-notes-min-width.md](./issue-209-notes-min-width.md)。
  - **#190 hooks 备份**：安装覆盖/卸载摘除改动前必备份（此前项目级 opencode 备份的是改后文件）。详见 [docs/issue-190-hooks-backup.md](./issue-190-hooks-backup.md)。
  - **#191/#204 opencode 自动执行**：失败看两路结果、成功后才去重、`processed` 不回退（#191）；改按当前消息判定，单窗口多任务可依次执行（#204）。
  - **#206 取消启动自动接入**：全部走手动一键安装；开发版安装给时效提醒。详见 [docs/issue-206-no-auto-enroll.md](./issue-206-no-auto-enroll.md)。
  - **#192 Label 优先**：显式 label→todo 优先于 gh_status（owner 已确认）。详见 [docs/issue-192-label-todo-priority.md](./issue-192-label-todo-priority.md)。
  - **#193/#207/#224/#228 小项**：开发版跳过自动注册 + `workBranch` 贯通详情（#193）；agent 四分组下拉（#207）；同步日志账号列（#224）；同步与写回请求/返回日志（#228）。
  - **修复**：#197 卡片 session 独立行；#212 死代码 warning 清零；#216 仅剩单账号可删；#220 指纹纳入 projectStatus（写回即时刷新）；#221 切换账号请求合并（不再滞留旧账号）。
  - **schema 变更**：`projects.status_field_id`、`project_statuses.option_id`、`project_items` 新表（新库 SCHEMA + 老库迁移双写）。
  - **验证**：`cargo test`（lib 72 例 + db_test 19 例）零 warning、`tsc --noEmit`、`vitest` 10 文件 54 例、`i18n:check` 279 key 一致、`check-mcp-columns.py` 24 列一致。

- **v0.3.55（2026-09-11）— 跨 agent 看板 hooks（#177）+ 同步筛选提示（#178）+ 外部写入自动刷新（#181）+ 看板列模式精简（#108）**

  - **#177 跨 agent 看板 hooks 与一键安装/卸载**：新增项目级 `.claude/`（commands `/task-start` `/task-done` /hooks）与 `.opencode/` 插件，开始处理 issue 时一次完成「处理中 + session_id/session_agent + work_branch」三写入，结束时清 session；`AGENT_INSTRUCTIONS.md` 明确触发时机，根治"只靠 prompt 约定易遗忘"。详见 [docs/issue-177-claude-session-hooks.md](./issue-177-claude-session-hooks.md)。
  - **#177 后续 opencode 自动执行与全局 MCP 自动合并**：`.opencode/plugins/taskboard.js` 事件 hook 从用户消息自动提取唯一 issue 引用并直调本地 `taskboard mcp`（`get_task_status` + 置处理中 + `record_session`，多引用回退手动）；`hooks.rs::merge_global_opencode_mcp` 按 `opencode.jsonc > opencode.json > config.json` 首个生效文件自动合并全局 MCP 配置（JSONC 注释保留，他人条目保留）。详见 [docs/issue-177-claude-session-hooks.md](./issue-177-claude-session-hooks.md)。
  - **#178 同步后被筛选隐藏任务的提示与一键清除**：同步前后按 `issueKey → updatedAt` 快照 diff，精确算出"本次新变且被当前筛选藏住"的任务数，藏住才出琥珀色横幅 + 数量 + 一键清除筛选；无筛选时恒不打扰。新增可单测纯函数模块 `syncHint.ts`（8 例）。详见 [docs/issue-178-sync-filter-hint.md](./issue-178-sync-filter-hint.md)。
  - **#181 外部写入后自动刷新任务列表**：前端窗口聚焦/`visibilitychange` 即时重查 + 20s 轮询兜底（后台隐藏跳过，`loadingRef` 防重入）；`taskSig.ts` 指纹覆盖本地写入字段（不能只看 `updated_at`，本地写库不更新它），无变化不重渲染；后端 `update_task_status` / `record_session` / `clear_session` / `record_handoff` 成功后 emit 新事件 `taskboard://tasks-changed`（多窗口正确性）。MCP 协议与 DB schema 无变化。详见 [docs/issue-181-auto-refresh.md](./issue-181-auto-refresh.md)。
  - **#108 看板列模式精简**：设置页「看板列模式」去掉「四态列」选项，仅保留「Project 状态列」和「自定义列」；`boardModeProject` 文案缩短；历史 `status` 值在 Board 渲染层降级为 `project`，零 schema 变更；设置 modal 宽度 460px→520px。详见 [docs/issue-108-simplify-board-mode.md](./issue-108-simplify-board-mode.md)。
  - **仓库改名与全量 bug 排查**：远程仓库改名 `task-dashboard`，同步全部引用（含 About 页链接 typo）；新增 [docs/bug-audit-2026-09.md](./bug-audit-2026-09.md)（13 条问题 + 3 条存疑 + 2 条误报排除，只出清单未改源码）。
  - **CI**：Intel 构建改用 `macos-latest` 交叉编译，解决 `macos-13` runner 排队问题。
  - **无 schema 变更**。验证：`npm test` 7 文件 36 例通过、`tsc --noEmit` 通过、`i18n:check` 273 key 一致、`check-mcp-columns.py` 24 列一致。

- **v0.3.54（2026-09-09）— Rust 内置 MCP 读路径字段错位修复（#173）**

  - **#173 `row_to_value` 位置索引未同步 24 列 `SELECT_COLS`**：#155 重建 `tasks` 表并插入 `url` / `issue_state` / `project_status` / `pr_number` 等列、#169/#171 把 `SELECT_COLS` 扩成 24 列后，`mcp.rs::row_to_value` 仍按老的精简列序用位置 `get(0..10)` 取值，导致内置 MCP 的 `list_my_tasks` / `get_task_status` 返回字段**几乎全部错位**（`repo` 填 owner、`number` 填 repo 字符串、`status` 填 title……）。`check-mcp-columns.py` 只比两侧 `SELECT_COLS` 字符串、管不了「位置 → 列名」映射，故 CI 一直绿而功能坏。现已重写 `row_to_value` 严格按 24 列顺序逐一映射（含 `work_branch` / `updated_at` 等），语义与 Python 侧 `dict(row)` 对齐。
  - **#173 回归测试**：新增 2 个 Rust 单测（`list_my_tasks_returns_correct_column_values` / `get_task_status_returns_correct_column_values`），在内存库建含全部被选列的 `tasks` 表、每列填可辨识值，逐字段断言返回正确。lib 测试 34→36 例。
  - **#175 `work_branch` 迁移补漏**：`work_branch` 的 ALTER 只挂在 `migrate_legacy_alters`（user_version<1），使 `user_version=2`（#155 已 v2 重建）的旧库永不补列、`SELECT_COLS` 一查就 `no such column`。现将该 ALTER 提升到 `open_db` 每次建连都跑的幂等热路径（已存在则忽略），对所有 user_version 一致生效。新增 db_test（18→19）验证。
  - **无 schema 变更（仅数据迁移补齐）、零接口变更**。详见 [docs/issue-173-mcp-read-row-to-value.md](./issue-173-mcp-read-row-to-value.md) 与 [docs/issue-175-work-branch-migration-gap.md](./issue-175-work-branch-migration-gap.md)。

- **v0.3.53（2026-09-09）— Python MCP 与列名重构脱节修复（#169）+ record_session 记录工作分支（#171）**

  - **#169 Python MCP 读路径修复**：#155 把 `tasks.key` 改名 `issue_key` 后 `mcp_server/server.py` 没跟上，`SELECT_COLS` 与 `tool_get_task_status` 仍写 `key`，`list_my_tasks` / `get_task_status` 必然报 `no such column: key`。现已统一两侧 `SELECT_COLS`（补齐 `url` / `issue_state` / `project_status` / `pr_number` 等 #155 后的新列，共 23 列），返回字段 `key` → `issue_key`。详见 [docs/issue-169-mcp-server-schema-sync.md](./issue-169-mcp-server-schema-sync.md)。
  - **#169 写入丢失修复**：四个写任务工具没有 `commit()`，sqlite3 默认事务下进程退出即回滚，写入全丢。连接改为 `isolation_level=None` 自动提交——比在 11 个工具出口各写一次 commit 更难漏。详见 [docs/issue-169-mcp-server-schema-sync.md](./issue-169-mcp-server-schema-sync.md)。
  - **#169 列名一致性防回归**：新增零依赖 `scripts/check-mcp-columns.py` + CI `mcp-schema-check`，以 `db.rs::SCHEMA` 为唯一事实来源，校验 `server.py` 与 `mcp.rs` 的列名真实存在且逐列一致。详见 [docs/issue-169-mcp-server-schema-sync.md](./issue-169-mcp-server-schema-sync.md)。
  - **#171 `record_session` 新增 `branch` 参数**：开始处理 issue 时即可一并记录当前工作分支，写入独立 **`work_branch`** 列（非空才写）。复用公共 `common::touch_session`（Rust）与 `server.py`（Python）条件更新，两侧行为一致；`SELECT_COLS` 同步补入 `work_branch`（共 24 列）。
  - **#171 `branch` 回归 PR 专用**：`sync.rs` 中该 issue 无关联 PR 时仍清空 `branch`（PR head.ref 原逻辑不回归）；`work_branch` 不在同步 upsert 列中，**同步不覆盖 Agent 工作分支**，两者职责分离。
  - **#171 触发时机提前**：`AGENT_INSTRUCTIONS.md` 明确「开始处理」即 `record_session`（含 `git branch --show-current` 取的分支）。
  - **#171 schema 变更**：`tasks` 新增 `work_branch TEXT NOT NULL DEFAULT ''`（新库 SCHEMA + 老库 ALTER + v2 重建同步迁移）。
  - **验证**：`cargo test`（lib 34 例 + db_test 18 例）、`cargo check` 通过。详见 [docs/issue-171-record-session-branch.md](./issue-171-record-session-branch.md)。

- **v0.3.52（2026-09-08）— 设置面板假死修复（#167）**

  - **#167 同步/诊断期间点击设置假死**：`diagnose_project_status` / `test_pat` / `test_account_pat` / `save_pat` / `add_account` / `update_account` 六个命令原为同步命令，内含 GitHub 网络 I/O，在 Tauri 主线程执行期间阻塞事件循环 → macOS beachball 假死。统一改为 `async + spawn_blocking`（与 v0.3.7 `sync_now` 同款模式），网络重活放工作线程池，主线程仅快速取 DB 数据后立即返回。纯 SQL 配置命令不受影响，同步用独立连接 + WAL 不阻塞读者。零接口变更、零前端改动。详见 [docs/issue-167-async-net-commands.md](./issue-167-async-net-commands.md)。

- **v0.3.51（2026-09-08）— 前端修复三连（#159 #160 #161）**

  - **#159 自定义列空配置回退 project 列**：账号未配置自定义列时选择「自定义列」展示，不再误导性回退到四态列，改为回退到 project.status 状态列。详见 [docs/issue-159-160-161-frontend-bugs.md](./issue-159-160-161-frontend-bugs.md)。
  - **#160 应用内确认弹窗替代 window.confirm**：Tauri WebView 原生不支持 `window.confirm`（静默返回 false），「清理全部日志」「删除账号」的二次确认改为应用内 ConfirmDialog 弹窗，根治点了没反应。详见 [docs/issue-159-160-161-frontend-bugs.md](./issue-159-160-161-frontend-bugs.md)。
  - **#161 同步日志错误信息可展开**：错误单元格默认单行截断，hover 有全文 tooltip，点击展开/收起完整错误信息。详见 [docs/issue-159-160-161-frontend-bugs.md](./issue-159-160-161-frontend-bugs.md)。
  - **#163 前端测试补充**：新增 3 个测试文件 18 个用例（合计 21 例），零依赖覆盖 #159/#160/#161 修复逻辑，为可测性抽出 `resolveBoardView` 等 4 个纯函数。详见 [docs/issue-163-frontend-tests.md](./issue-163-frontend-tests.md)。
  - **#165 custom 视图未匹配值提示**：未标注列展示未映射的 `project_status` 值（去重 + 计数，hover 看全），帮助用户快速定位漏配/错配的自定义列。详见 [docs/issue-165-unmapped-hint.md](./issue-165-unmapped-hint.md)。

- **v0.3.50（2026-09-08）— 性能 / 安全优化批次 + 同步日志与自定义列改进 + tasks 表物理重建（#133 #134 #135 #137 #138 #143–#150 #155）**
  - ℹ️ **版本号说明**：本版本实际承载了「原计划的 v0.3.49」内容——**`v0.3.49` 版本号被跳过，从未打 tag、从未发布**（tag 序列 `v0.3.48` → `v0.3.50`）。因此源码中约 50 处标注为 `v0.3.49 (#143)` 之类的注释，所指即本版本 v0.3.50；代码注释不作订正以免污染 `git blame`。本条目的 #133–#150 部分为**事后补录**（原先只记了 #155），依据 `git log v0.3.48..v0.3.50` 与各 issue 补写。详见 [#239](https://github.com/ShawnLiuSZ/task-dashboard/issues/239)。
  - **性能 / 安全优化批次（8 个 issue）**，批次索引见 [docs/perf-audit-optimization.md](./perf-audit-optimization.md)：
    - **P0-1 #143 同步链路并发化**：5 个 Search 源 + Project 拉取并行，去掉固定 `sleep`；新增共享 Search 限流门。详见 [docs/issue-143-147-sync-concurrency.md](./issue-143-147-sync-concurrency.md)。
    - **P0-2 #144 同步链路 N+1 消除 + 整段事务化写入**：预加载替代任务循环内的逐条查询，N 次 autocommit 合并为 1 次 commit。详见 [docs/issue-144-146-sync-db.md](./issue-144-146-sync-db.md)。
    - **P0-3 #145 前端并行加载**：`Promise.all` 并行 + `Board`/`TaskCard` `memo` + 搜索防抖。详见 [docs/issue-145-148-150-frontend.md](./issue-145-148-150-frontend.md)。
    - **P1-1 #146 热查询索引补齐**：`label_mappings` 复合索引 / `tasks` 看板复合索引 / `notes` 内容唯一索引 / prune 索引。详见 [docs/issue-144-146-sync-db.md](./issue-144-146-sync-db.md)。
    - **P1-2 #147 建连版本化迁移**：引入 `PRAGMA user_version` 版本化迁移 + 抽取 `common.rs` + `import_notes` 事务化。**这是后续所有列迁移机制的前置**（见 [docs/issue-237-card-creator-row.md](./issue-237-card-creator-row.md)「决策 5」）。详见 [docs/issue-143-147-sync-concurrency.md](./issue-143-147-sync-concurrency.md)。
    - **P1-3 #148 类型 / 拼写修复**：清零 i18n `any`、`SyncLogsPanel`/`NotesPanel` 补 i18n、`check_update` URL 修正。详见 [docs/issue-145-148-150-frontend.md](./issue-145-148-150-frontend.md)。
    - **P2-1 #149 安全加固**：PAT 入 Keychain、CSP 最小策略 + 外链白名单、跨平台 `open_in_browser`、DB 文件权限 0600、日志门控。详见 [docs/issue-149-security-hardening.md](./issue-149-security-hardening.md)。
    - **P2-2 #150 可访问性 a11y + CSS 收敛**：`TaskCard` 键盘可达、modal `role` / 焦点陷阱、对比度提升。详见 [docs/issue-145-148-150-frontend.md](./issue-145-148-150-frontend.md)。
  - **#133 自定义列视图补 `gh_status` 徽章**：切到自定义列显示后卡片不再展示 `project.status`，补正确类名、无列配置时也显示，并在保存列配置时自动置 `boardMode=custom`。详见 [docs/issue-133-custom-col-status-badge.md](./issue-133-custom-col-status-badge.md)。
  - **#134 同步日志保留期 7 天 → 30 天 + 「清理全部日志」**：新增全量清理按钮（二次确认）。详见 [docs/issue-134-sync-logs-cleanup.md](./issue-134-sync-logs-cleanup.md)。
  - **#135 同步日志区分触发类型**：新增 `auto` / `manual` / `startup` 三态，「触发」列不再一律显示「自动」。详见 [docs/issue-135-sync-trigger-type.md](./issue-135-sync-trigger-type.md)。
  - **#137 跳过已关闭 issue 的逐条 `fetch_state`**：改为批量标记 `candidate_done`，省 GitHub API 调用。详见 [docs/issue-137-skip-fetch-state.md](./issue-137-skip-fetch-state.md)。
  - **#138 自定义列映射改为平铺账号布局**：账号维度不再用下拉切换，平铺列出所有账号各自独立配置。详见 [docs/issue-138-flat-account-config.md](./issue-138-flat-account-config.md)。
  - **#155 tasks 表物理重建**：字段命名彻底理清——`key→issue_key`（业务引用，新增）、自增 `id` 主键 + `UNIQUE(repo, number, account_id)` 解决多账号互相覆盖、`gh_state→issue_state`、`gh_status→project_status`（与本地四态 `status` 语义分离）、`updated_at` 由 TEXT 统一为 INTEGER 秒。基于 `PRAGMA user_version` 版本化迁移 + `key` 列幂等判定，老库自动重建、数据完整迁移。详见 [docs/issue-155-tasks-schema-rebuild.md](./issue-155-tasks-schema-rebuild.md)。

- **v0.3.48（2026-09-07）— 扩展平台支持与 CI 优化（#118 #119 #120 #121 #122）**

  - **#118 扩展平台支持**：GitHub Actions release 工作流新增 macOS ARM/x64、Windows ARM64 双架构构建支持。详见 [docs/issue-118-expand-platform-support.md](./issue-118-expand-platform-support.md)。
  - **#119 扩展 Release 打包矩阵**：补齐 arm64 全平台、rpm 与 msi 格式。macOS/Windows/Linux 均支持双架构。详见 [docs/issue-119-expand-release-matrix.md](./issue-119-expand-release-matrix.md)。<br>⚠️ **勘误（2026-09-13 补注，[#239](https://github.com/ShawnLiuSZ/task-dashboard/issues/239)）**：本条原写「新增 zip/msi/rpm 格式」，其中 **`zip` 当日即被回滚**——Tauri 2 的 `--bundles` 只接受 app/dmg/nsis/msi/deb/rpm/appimage，`zip` 不是有效类型（提交 `18049ec`）。便携 zip 未曾交付，勿再尝试该写法。
  - **#120 CI 弃用警告修复**：升级 GitHub Actions（checkout@v5、setup-node@v5、tauri-action@v2），Node.js 版本升级到 22 LTS，消除弃用警告。详见 [docs/issue-120-upgrade-ci-actions.md](./issue-120-upgrade-ci-actions.md)。
  - **#121 关于页删除专属话术**：移除 AboutPanel 中 WorkBuddy/claude-code 专属性 agent 接入话术，收敛为通用说明。详见 [docs/issue-121-remove-workbuddy-text.md](./issue-121-remove-workbuddy-text.md)。
  - **#122 数据库路径全平台标注**：README 与 Rust 注释覆盖 Windows/Linux/macOS 三平台数据库路径。详见 [docs/issue-122-db-path-docs.md](./issue-122-db-path-docs.md)。

- **v0.3.47（2026-09-07）— MCP stdio 分帧格式修复（#115）**

  - **#115 MCP stdio 分帧格式修复**：`read_message` 改为双格式自动识别——首字节 `{` 走 NDJSON（MCP 规范），否则走 Content-Length 头（LSP 历史兼容）；`write_message` 回以与请求相同的分帧格式。根治 Claude Code / Cursor 等标准 MCP 客户端连接时 `connection timed out after 30000ms`。失败路径新增 stderr 诊断输出。Rust + Python 两份实现同步修改。详见 [docs/mcp-stdio-framing-ndjson.md](./mcp-stdio-framing-ndjson.md)。

- **v0.3.46（2026-09-07）— 设置页看板列模式精简（#108）+ MCP 接入文档完善（#109）**

  - **#108 看板列模式精简**：移除下拉菜单中的「四态列」选项，仅保留「Project 状态列」和「自定义列」两项；`boardModeProject` 文案精简为「Project 状态列」；历史 `boardMode="status"` 账号在 Board.tsx 渲染层优雅降级为 `project`，零 schema 变更。设置页 modal 宽度从 460px 调整为 520px。详见 [docs/issue-108-simplify-board-mode.md](./issue-108-simplify-board-mode.md)。
  - **#109 MCP 全平台文档**：AboutPanel 通过 `navigator.userAgent` 检测当前平台，动态生成 macOS / Windows / Linux 对应 command 路径的 MCP snippet；README 新增三平台路径表格，收敛为单个 agent 完整配置示例。详见 [docs/issue-109-mcp-platform-docs.md](./issue-109-mcp-platform-docs.md)。

- **v0.3.45（2026-09-07）— 记事导出默认写入设备下载目录（#103）**

  - **#103 导出默认下载目录**：`export_notes` 新增可选 `target_dir`；未传时经 `dirs::download_dir()` 落到系统真实下载目录（macOS `~/Downloads` / Windows `%USERPROFILE%\Downloads` / Linux `$XDG_DOWNLOAD_DIR`），取不到/不可写时回退应用数据目录 `notes-backup/`。新增 `resolve_export_dir` 做优先级 + 可写校验。**零新依赖**（`dirs` 已在用）。前端导出成功提示本就展示完整 `path`。详见 [docs/issue-103-notes-export-download.md](./issue-103-notes-export-download.md)。
  - **验证**：`cargo check`；新增单测 `resolve_export_dir_prefers_target_then_download`（合 26 例）。

- **v0.3.44（2026-09-07）— 首启自动清除 Gatekeeper 隔离标记，MCP 免 sudo 开箱即用（#101）**

  - **#101 自动清除自身 quarantine**：macOS 首次启动在 `setup()` 用 `xattr` 检测主二进制（`taskboard mcp`）是否带 `com.apple.quarantine`，存在即 `xattr -dr` 递归清除（当前用户拥有自身 bundle，**无需 sudo**）。GUI 放行一次后自动清理，此后 MCP 客户端 spawn 不再触发 Gatekeeper 慢评估，根治「MCP 连接 30s 超时」。详见 [docs/issue-101-quarantine-autoclear.md](./issue-101-quarantine-autoclear.md)。
  - **验证**：`cargo check`（macOS）通过；验收为多机手动（清除后 `xattr -l` 无 quarantine 标记、MCP 工具可发现可调用）。

- **v0.3.43（2026-09-07）— 看板列展示方式改为每账号配置（#99）**

  - **#99 每账号列展示方式**：移除顶栏展示方式切换下拉；在设置面板「自定义列」tab 按账号独立选择 status/project/custom（存 `meta` 的 `board_mode:<id>`，未配置默认 project）。切换账号后看板按该账号模式展示。自定义列视图下任务卡片右上角显示 `project.status` 彩色徽章（复用 20 色系，同状态同色）。
  - **接口**：移除全局 `set_board_mode` 命令与 `Settings.board_mode` 字段；新增 `set_account_board_mode(account_id, mode)`；`accounts[]` 新增 `boardMode`。同步 `sync::run` 逐账号读取模式（仅该账号自己为 custom 才写 `col_key`）。零表结构变更、复用 `meta` 键值表。
  - **验证**：`cargo test --lib`（新增 `account_board_mode_defaults_and_validates`，合计 24 例）、`npm run i18n:check`（zh/en 各 179 key）、`npx tsc --noEmit`、`npm test` 通过。详见 [docs/issue-99-board-mode-per-account.md](./issue-99-board-mode-per-account.md)。

- **v0.3.42（2026-09-07）— 自定义列映射去重（#98）**

  - **#98 新建列时已使用 status 置灰去重**：设置面板「自定义列」新建/编辑列时，已被**其它列**选用的 Project status 置灰且不可再次选中（`usedElsewhere` 由 `columns` + `editingCol` 实时派生；`toggleRule` 兜底拦截，覆盖自由输入路径）；正在编辑的列自身占用项保留可选，删除列后其占用项自动恢复可选。纯前端改动、零后端/schema 变更。新增 i18n key `settings.customColumns.usedElsewhere`。
  - **验证**：`npm run i18n:check`（zh/en 各 178 key）、`npx tsc --noEmit`、`npm test`（3 例）通过。详见 [docs/issue-98-dedup-col-status.md](./issue-98-dedup-col-status.md)。

- **v0.3.41（2026-09-07）— 首次启动 UI 卡死转圈修复（#97）**

  - **#97 设置 / 关于 / 账号 / 同步日志 面板卡死**：根因是启动同步把整段 **GitHub 网络 I/O** 包在共享 `AppState.db` 的 `Mutex<Connection>` 里长持有，导致这些面板触发的读命令（同步非 async，跑在主线程）排队等锁 → macOS beachball、鼠标卡死转圈。修复：`run_sync` / `sync_now` 改用**独立 DB 连接**（`open_sync_conn`，复用 WAL + `busy_timeout`），同步不再占用共享锁，UI 随到随取。零新依赖、零 schema 变更、对外接口不变。
  - **验证**：`cargo check`、`cargo test --lib`（23 例）通过。详见 [docs/issue-97-ui-freeze.md](./issue-97-ui-freeze.md)。

- **v0.3.40（2026-09-07）— 设置面板 tab 化 + 自定义列映射下拉配置（#95）**

  - **#95 自定义列 Project status 映射配置**：设置面板改为 **tab 切换（基础设置 / 自定义列映射 / 诊断）**，自定义列配置独立成页、标题栏加关闭按钮。自定义列编辑移除「列标识(colKey)」概念 —— col_key 由系统自动生成，**用户只需填列显示名称 + 下选匹配的 Project status（下拉多选 chips + 自由输入）**，保存写 `matchRules` JSON 数组，后端逻辑与存储零改动、向后兼容。详见 [docs/issue-95-status-mapping-dropdown.md](./issue-95-status-mapping-dropdown.md)。

- **v0.3.39（2026-09-07）— 审计清理收尾（#72 #73 #80）**

  - **#72 看板模式下拉补 status 选项**：核验确认 `status / project / custom` 三个选项均已存在（v0.3.29 #64 一并补齐），无需代码改动，关闭 issue。

  - **#73 MCP serverInfo 版本注入**：`mcp.rs` 删除硬编码 `SERVER_VERSION = "0.3.24"`，改用 `env!("CARGO_PKG_VERSION")`，与发版三处版本保持单点一致，避免 serverInfo 版本落后。文档合规收尾——为孤岛 KB 恢复 CHANGELOG 引用：补建 [docs/issue-55-update-check.md](./issue-55-update-check.md)，并在本条目引用 [docs/issue-54-auth-account-refresh.md](./issue-54-auth-account-refresh.md)、[docs/issue-55-update-check.md](./issue-55-update-check.md)、[docs/issue-56-project-status-order.md](./issue-56-project-status-order.md)。

  - **#80 清理 i18n 死 key**（共 21 个）：移除已不存在的「Label 状态映射」「Label 列顺序」两套 UI 的残留 key（`settings.labelMapping.*`、`settings.labelColumns.*`、`settings.labelMappingsTitle/Desc`、`settings.labelColumnsTitle/Desc`）及废弃的看板模式 `settings.boardModeLabel`、`settings.boardModeLabelOnly`。zh-CN / en-US 各由 193 → 172 个 key，双语一致。

  - **验证**：`npm run i18n:check`（zh/en 各 172 key）、`npx tsc --noEmit`、`cargo check` 均通过。

- **v0.3.38（2026-09-07）— TaskCard 仓库颜色与全部账号下拉修复（#77 #78）**

  - **背景**：四态列视图的 TaskCard 漏传 `repoIndex`，仓库标签恒同色；`viewMode=all` 时账号下拉仍可切换但对列表无影响，语义含混。

  - **改动**：

    - **#77**：四态视图构建 `repoIndexMap` 并为 TaskCard 传 `repoIndex`，各视图独立构建，仓库标签按字母序取不同颜色。

    - **#78**：`viewMode=all` 时账号下拉 `disabled`，`title` 提示聚合语义（新增 i18n key `topbar.switchAccountAll`）。

  - **验证**：`npx tsc --noEmit`、`npm run i18n:check`（zh/en 各 193 key）通过。详见知识库文档 [docs/issue-77-78-card-board-fixes.md](./issue-77-78-card-board-fixes.md)。

- **v0.3.37（2026-09-07）— NotesPanel 快捷键与 DetailPanel 定时器修复（#75 #76）**

  - **背景**：NotesPanel Ctrl/⌘+Enter 快捷键绕过 `adding` 守卫，连按产生重复记事；DetailPanel `copyToClipboard` 的裸 `setTimeout` 未清理，组件卸载后仍触发 `setCopiedKey`（在已卸载组件上 setState）。

  - **改动**：

    - **#75**：快捷键触发收紧为 `!adding && draft.trim()`，与添加按钮禁用条件一致，连按/空草稿不再触发。

    - **#76**：`copyToClipboard` 改用 `useRef` 管理复位定时器（先清旧再存新，避免叠加）；新增卸载 `useEffect` 清理定时器。

  - **验证**：`npx tsc --noEmit` 通过。详见知识库文档 [docs/issue-75-76-ui-fixes.md](./issue-75-76-ui-fixes.md)。

- **v0.3.36（2026-09-07）— i18n 文本泄漏修复（#71）**

  - **背景**：SettingsPanel「诊断 & 项目列表」诊断文本与 DetailPanel agent 下拉（豆包/智谱 GLM/通义灵码）为硬编码中文，英文界面下不随语言切换（issue #62 已识别范围之外的新遗漏）。

  - **改动**：纯展示层接入 i18n。

    - DetailPanel：`AGENTS` 三项中文 label 增加 `i18nKey`；新增 `agentLabel(value, t)` helper，下拉与「记录于 {agent}」回显统一翻译。

    - SettingsPanel：`diagnoseProject` 组装文本改为 `t()` 插值。

    - 双语 locale 新增 `agents.doubao/glm/tongyi` 与 `settings.diag*` 共 8 个 key。

  - **验证**：`npm run i18n:check` 通过（zh/en 各 192 key）、`npx tsc --noEmit` 通过。详见知识库文档 [docs/issue-71-i18n-leaks.md](./issue-71-i18n-leaks.md)。

- **v0.3.35（2026-09-07）— run_sync 并发同步去重（#69）**

  - **背景**：Tray「立即同步」、启动同步、定时同步、前端 `sync_now` 多入口互不感知，可并发触发全量同步；`sync::run` 持 `db` 锁跑 5 次 Search + 1 次 GraphQL（5~15s），并发时背靠背排队、阻塞 UI 并放大 GitHub 限流。

  - **改动**：`AppState` 新增 `syncing: AtomicBool` 去重标志；新增 `SyncGuard`（`acquire` 抢占 / `Drop` 复位）。

    - `lib.rs::run_sync` 与 `commands.rs::sync_now` 统一走同一把标志：已有同步在跑时自动入口静默跳过、手动入口返回「同步进行中」。

  - **验证**：新增单测 `sync_guard_dedupes_concurrent_acquisition` 覆盖抢占去重与释放复位；`cargo test` lib 23 passed。详见知识库文档 [docs/issue-69-sync-dedup.md](./issue-69-sync-dedup.md)。

- **v0.3.34（2026-09-07）— update_task_status 校验 status 合法性（#70）**

  - **背景**：前端 `update_task_status` 把传入 status 直接写入 `tasks.status`，不校验合法性；拼错的非四态值或已删除的自定义列名落库后任务不属于任何列，从看板静默「消失」。

  - **改动**：校验口径统一为「四态 ∪ 中文四态 ∪ 该任务账号的 `account_columns::col_key`」。

    - `commands.rs::update_task_status`：中文四态归一化到英文四态；新增 `validate_task_status`，非四态非该账号自定义列时拒绝且 DB 不改动。

    - `mcp.rs::tool_update`：非四态时同样校验该账号自定义列 `col_key`，命中放行，否则拒绝（此前一律拒绝自定义列，口径不一致）。

  - **验证**：新增单测覆盖四态放行、该账号自定义列放行、拼错/未知列/任务不存在拒绝；`cargo test` lib 22 passed。详见知识库文档 [docs/issue-70-status-validation.md](./issue-70-status-validation.md)。

- **v0.3.33（2026-09-07）— MCP 双实现一致性修复（#68 #79）**

  - **背景**：内置 MCP（Rust `mcp.rs`）与便携兜底（Python `server.py`）在 `delete_note` 返回键、`update_note_label` 空标签处理上行为不一致，同一调用在不同环境下得到不同结果。

  - **改动**：

    - **#68**：`server.py::tool_delete_note` 返回键由 `id` 改为 `note_id`，与 Rust 端对齐。

    - **#79**：`server.py::tool_update_note_label` 空标签由报错改为回落 `low`，与 `tool_add_note` 及 Rust `normalize_note_label` 统一。

  - **验收**：内置 app 与便携 server 对 `delete_note`、`update_note_label("")`、`add_note("")` 返回/落库一致。详见知识库文档 [docs/issue-68-79-mcp-consistency.md](./issue-68-79-mcp-consistency.md)。

- **v0.3.32（2026-09-07）— Project V2 中的 PR 不再被当作 issue 上板（#67）**

  - **背景**：`fetch_project_issues` 用 `pull_request`/`mergedAt`/`headRefOid` 判型，但 GraphQL 查询并未选取这些字段，判断恒为假，导致 Project V2 里的 PR 被当作 issue 抓上看板。

  - **改动**：GraphQL 查询 `content` 区新增 `__typename`；判型改用 `content["__typename"] == "PullRequest"` 跳过 PR，可靠且与查询强一致。

  - **验收**：Project 中同时含 issue 与 PR 时，同步后 PR 不再上板，issue 正常上板、不占状态列。详见知识库文档 [docs/issue-67-pr-typename.md](./issue-67-pr-typename.md)。

- **v0.3.31（2026-09-07）— DetailPanel 切换任务时会话状态重置（#66）**

  - **背景**：DetailPanel 的 `sessionInput`/`agent`/`handoff` 用 `useState(task.sessionId)` 初始化但只在首次挂载取值，切换选中任务时组件未卸载、state 不重置，可能把上一个任务的会话/交接误写到当前任务。

  - **改动**：`App.tsx` 给 `<DetailPanel>` 加 `key={selectedTask.key}`，任务切换时强制重挂载、状态随新任务初始化。

  - **验收**：不关闭面板直接切到另一任务时，会话/交接输入不再残留上一任务的旧值；切回同一任务不丢未保存编辑。详见知识库文档 [docs/issue-66-detailpanel-session-reset.md](./issue-66-detailpanel-session-reset.md)。

- **v0.3.30（2026-09-07）— 空搜索结果误删看板任务修复（#65）**

  - **背景**：Search API 返回 422 时 `search()` 误当「空结果」，部分搜索源失败会让真实关联任务被标记陈旧后移出看板（数据丢失风险）。

  - **改动**：

    - `github.rs::search()`：422（含限流重试后仍 422/非 2xx）由返回空结果改为返回 `Err`，计入 `failed`，让下游感知搜索链路不完整。

    - `sync.rs::sync_account()` stale 清理：任一搜索源失败时，对仍 open 的任务仅解除 stale、保留本地记录，不再 DELETE；确认已关闭的仍正常标记已完成。

  - **验收**：搜索源 422/失败时同步不再中断，不再误删 open 任务；搜索完整时「移出看板」行为不变。详见知识库文档 [docs/issue-65-empty-search-no-delete.md](./issue-65-empty-search-no-delete.md)。

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

    - 应用仓库名改为可点击链接，经系统浏览器打开 `https://github.com/ShawnLiuSZ/task-dashboard`

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


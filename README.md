# GitHub 任务看板 · TaskBoard

> **中文**
>
> English version see [README.en.md](./README.en.md)

<p align="center">
  <img src="social-preview.png" alt="TaskBoard — GitHub 任务看板" width="720" />
</p>

每天自动汇聚 GitHub 上「分配给我 / 与我相关」的任务到**本地跨平台桌面应用**（Windows / macOS / Linux）看板，状态随 AI 执行自动流转，并支持记录可恢复的中断会话（session id）。

目前处于 ***开发者预览*** 阶段，正在快速迭代。未来将出现破坏兼容性的变更。

> **最终形态（v0.3）**：已落地为**本地 Tauri 桌面应用**（`app/` 目录），数据存本地 SQLite，**不创建 GitHub Issue / Project，不写回 GitHub**。此前 PRD 讨论的「GitHub Projects v2 看板」方案因组织限制与个人偏好已放弃，演进记录见 [`PRD.md`](./PRD.md)。

## 应用：TaskBoard（Windows / macOS / Linux）

跨平台 Tauri 桌面应用，前端 React、后端 Rust（rusqlite 本地数据库）。macOS 上为菜单栏常驻应用（系统托盘），Windows / Linux 亦以托盘图标常驻。

### 构建与运行

```bash
cd app
npm install            # 首次安装前端依赖
npm run tauri dev      # 开发模式（前端热更新）
npm run tauri build    # 产出当前平台的 release 安装包
```

产物位置（按当前平台）：`app/src-tauri/target/release/bundle/{macos,debian,rpm,nsis}/TaskBoard*`

> macOS 打包未配置 Apple 开发者签名。首次打开若被 Gatekeeper 拦截：右键「打开」，或在终端执行
> `xattr -cr "/path/to/TaskBoard.app"` 后双击。

### 在线自动打包

发布 Release 时由 GitHub Actions 自动构建多平台安装包。发布流程、签名前提与 runner 配置详见 [`docs/design-and-release.md`](./docs/design-and-release.md)。

#### 支持的平台与架构

| 平台 | 架构 | 格式 | 状态 |
|------|------|------|------|
| macOS | ARM (Apple Silicon) | .dmg / .app | ✅ 支持 |
| macOS | x64 (Intel) | .dmg / .app | ✅ 支持 |
| Windows | x64 | .exe (NSIS) | ✅ 支持 |
| Windows | ARM64 | .exe (NSIS) | ✅ 支持 |
| Linux (Debian/Ubuntu) | amd64 | .deb | ✅ 支持 |
| Linux (通用) | x86_64 | .AppImage | ✅ 支持 |

> **⚠️ 更新提醒**：**v0.3.24 及以下版本**因仓库迁移问题，应用内「检查更新」无法获取 Release 信息，**不能自动更新**。请到 [GitHub Releases](https://github.com/ShawnLiuSZ/task-dashboard/releases) 下载最新版安装包（或查看应用内「关于」页提示的下载链接）。

### 使用

| 能力        | 操作                                                                                                                                                  |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 菜单栏       | 单击切换看板窗口；右键菜单含「显示看板 / 立即同步 / 退出」                                                                                                                    |
| **定时更新**  | 设置里调「定时同步间隔」（5–240 分钟），应用常驻时自动按间隔拉取                                                                                                                 |
| **手动更新**  | 主界面右上「立即同步」按钮                                                                                                                                       |
| 四态看板      | 待处理 / 处理中 / 已处理 / 已完成；点卡片在右栏切换状态                                                                                                                    |
| 远程状态联动    | GitHub 已关闭的 issue **自动归入「已完成」**（以远程真实状态为准，覆盖本地手动态）；仍打开但不再与你相关的任务自动移出看板                                                                              |
| 归属筛选      | 顶部下拉按 `分配给我` / `无人认领` / `分配给他人` 过滤                                                                                                                  |
| 搜索 / 仓库筛选 | 顶部搜索框按 **仓库名 / 编号 / 标题** 实时过滤；仓库下拉按仓库隔离；右侧「重置」一键清除所有筛选                                                                                              |
| 中断会话      | 选中卡片 → 输入 session id + 选 agent（claude-code / workbuddy / doubao / opencode / codex / zcode / gemini-cli / cursor / aider / qwen-code 等）→ 记录；可复制、可清空 |
| 交接任务      | 选中卡片 → 「交接任务」区块录入详情并保存（后续可由接入的 agent 在识别「生成交接任务」类意图时自动写入）                                                                                           |
| **同步日志**  | 顶栏「同步日志」按钮 → 查看最近同步历史（时间、触发方式、耗时、状态、新增/更新/移除数量、错误信息）；支持手动清理过期日志，超过 7 天的日志自动清理                                                                        |
| 本地数据      | 见下方「本地数据路径」                                                                                                                               |

### 关键约束

> **session id 与任务状态只存本地 SQLite，绝不写回 GitHub。** 不创建 Issue、不 创建 Project、不改 Issue 标题 / label / 评论。

### 本地数据路径

数据库文件默认位置（由 `dirs::data_dir()` + `com.shawnliu.taskboard` 组合）：

| 平台 | 默认路径 |
|---|---|
| macOS | `~/Library/Application Support/com.shawnliu.taskboard/taskboard.db` |
| Windows | `%APPDATA%\com.shawnliu.taskboard\taskboard.db`（即 `C:\Users\<user>\AppData\Roaming\com.shawnliu.taskboard\taskboard.db`） |
| Linux | `$XDG_CONFIG_HOME/com.shawnliu.taskboard/taskboard.db`（缺省 `~/.config/com.shawnliu.taskboard/taskboard.db`） |

可通过环境变量 **`TASKBOARD_DB`** 覆盖为任意路径。

### 界面语言（i18n）

应用支持**简体中文 / English** 双语界面：设置页可切换「跟随系统 / 简体中文 / English」，选择持久化在本地；翻译文件位于 [`app/src/i18n/locales/`](./app/src/i18n/locales/)（`zh-CN.json` / `en-US.json`）。

**贡献翻译**：复制 `en-US.json` 为新语言文件（如 `ja-JP.json`），翻译 value（保留 `{placeholder}` 占位符原样），然后在 `app/src/i18n/index.tsx` 的 `DICTS` 中注册即可。提交前运行 `cd app && npm run i18n:check` 校验两份语言文件的 key 集合与占位符一致；CI（`.github/workflows/i18n-check.yml`）会在 PR 时自动执行同样校验。

## 设计要点

纯本地、与 GitHub 解耦的核心设计（多源拉取去重、归属三分、四态维护、closed 权威覆盖、PR 反向关联、应用内定时）详见 [`docs/design-and-release.md`](./docs/design-and-release.md)。

## MCP Server（v0.3.10 新增 · v0.3.12 集成进 app 二进制）

PRD §6 规划了「MCP Server + Skill」让 AI Agent 在执行任务时自动维护看板。本版落地 **MCP Server** 部分（D5：先 MCP，后包 Skill）。

> **与 PRD 的关键偏离**：PRD 原设想把 session / 状态写到 **GitHub Project v2 自定义字段**；但本 App 的最终形态是**纯本地 SQLite、绝不写回 GitHub**。因此 MCP Server 直接读写本地 `taskboard.db`，零 GitHub 调用——这是 PRD 设计在当前架构下的正确适配。

**两种运行形态（同一份工具契约）**：

1. **内置二进制（推荐，v0.3.12 起）**：`taskboard` 二进制新增 `mcp` 子命令——`main.rs` 在 argv 含 `mcp` 时直接进入 stdio JSON-RPC 循环，**不启动 GUI**。它复用与 App **完全相同的** `db.rs` schema 与同一份 `taskboard.db`，**零 Python 依赖、无散落文件夹、无 schema 漂移**。装了 app 即自带 MCP，mcp.json 直接指向 app 内二进制即可（见下方配置）。
2. **独立** **`server.py`（便携 / 开发兜底）**：`mcp_server/server.py` 仍保留——**仅用 Python 标准库**（手写 JSON-RPC 2.0 + LSP 风格 `Content-Length` 分帧），无第三方依赖。适用于非 macOS / 未装 app 时让 Agent 读写同一数据库；其工具与内置二进制保持兼容。数据库路径默认同上（三平台标准位置），可用环境变量 `TASKBOARD_DB` 覆盖；启动时会幂等补齐 `branch` / `handoff` 两列（与 App 的 `db.rs::init` 迁移一致），故**即使 App 还没启动过也能直接用**。

**提供的工具**（与 PRD §6.2 对齐）：

| 工具                   | 入参                              | 说明                                       |
| -------------------- | ------------------------------- | ---------------------------------------- |
| `list_my_tasks`      | `status?` / `ownership?`        | 列出看板任务，可按四态 / 归属过滤                       |
| `get_task_status`    | `issue`                         | 查询某任务当前状态 + 已记录的 session / handoff       |
| `update_task_status` | `issue`, `status`               | 改本地看板状态（todo/doing/processed/done 或中文四态） |
| `record_session`     | `issue`, `session_id`, `agent?`, `branch?` | 记录中断会话 id + 工作分支（`branch` 非空写 `work_branch`，不碰 GitHub） |
| `record_handoff`     | `issue`, `text`                 | 记录「交接任务」详情（不碰 GitHub）                    |
| `clear_session`      | `issue`                         | 任务完成后清空 session 字段（保留 session\_at 审计）    |
| `set_work_branch`    | `issue`, `branch`               | #279：创建 / 切换 issue 分支后纠正 `work_branch`（只写该列、不碰 PR `branch`） |

`issue` 接受 `repo#number` / `owner/repo#number` / GitHub URL 三种形式。`status` 接受 `todo`/`doing`/`processed`/`done` 或中文「待处理/处理中/已处理/已完成」。

**Agent 使用范式**（对应 PRD §6.4 时序）：任务开始 → 先切到该 issue 的工作分支（`feature/issue-N-xxx`），再 `update_task_status(issue,"处理中")` + `record_session(issue, <会话id>, <agent>, <当前分支>)`；若先跑了开始命令、之后才切分支，切完补一次 `set_work_branch(issue, <当前分支>)`；中途停止 → `record_session`；识别到「生成交接任务」→ `record_handoff(issue, <详情>)`；完成 → `update_task_status(issue,"已完成")` → `clear_session(issue)`。

**接入各 Agent（配置 snippet）**：内置二进制已注册进 WorkBuddy 的 `~/.workbuddy/mcp.json`（`taskboard` 项）。其他本地 Agent 在其 MCP 配置里加同一条即可，例如 claude-code 的 `~/.claude.json`：

```json
{
  "mcpServers": {
    "taskboard": {
      "type": "stdio",
      "command": "/Applications/TaskBoard.app/Contents/MacOS/taskboard",
      "args": ["mcp"]
    }
  }
}
```

> **各平台 `command` 路径**：
>
> | 平台 | 默认路径 |
> |---|---|
> | macOS | `/Applications/TaskBoard.app/Contents/MacOS/taskboard` |
> | Windows | `C:\Program Files\TaskBoard\taskboard.exe` |
> | Linux (deb) | `/usr/bin/taskboard` |
>
> 若安装到了非默认位置，把 `command` 改成实际 `taskboard` 二进制的绝对路径即可。**未安装 app、改用 `server.py` 兜底**时，配置改为 `"command": "python3", "args": ["/path/to/mcp_server/server.py"]`。
>
> WorkBuddy 已内置注册；opencode 在本仓库开箱即用（项目级 `opencode.json` 已注册）；其余 agent（codex / cursor 等）按各自 MCP 配置位置填入上述 `command` + `args` 即可。

### 让 Agent 真正自动接上（触发逻辑）

MCP Server 只提供工具（**能力层**）；要让 Agent 在「开始 / 中断 / 说『生成交接任务』/ 完成」时**自动**调用，还需要一份**触发规则**被 Agent 加载（**触发层**）。两者缺一不可：没有 MCP，hooks 无处可调；没有触发逻辑，工具只能被动等人调。已在仓库内置：

- **`mcp_server/AGENT_INSTRUCTIONS.md`** —— 跨 Agent 通用的指令规范：触发时机 → 精确 MCP 工具调用、issue 引用格式、状态枚举、会话 id 来源约定。可直接整体喂给 claude-code / codex / opencode / zcode / helix / cursor / doubao。

- **`CLAUDE.md`**（仓库根） —— 给 claude-code 的自动加载入口，指向上述指令文件并给出速记规则；在本仓库跑 claude-code 时会自动生效。

- **`.claude/`**（#177，claude-code 确定性触发） —— `settings.json` 注册 `SessionStart`（注入 `$TASKBOARD_SESSION_ID` / `${CLAUDE_SESSION_ID}` + 看板规则）与 `UserPromptSubmit`（仅提到 issue 时轻提醒）两个 hooks（`bash + python3` 零依赖，不写 DB）；`commands/task-start|task-done|task-handoff.md` 提供显式一键命令。**#279：`/task-start` 已改为「先切 issue 工作分支、再记录会话」，避免 `work_branch` 被记成基线分支**。开始处理先 `/task-start <repo#num>`，做完 `/task-done`。

- **`.opencode/`**（#177，opencode 确定性触发） —— `opencode.json` 已注册 `taskboard` MCP（`python3 mcp_server/server.py`，跨平台、免装 app）；`plugins/taskboard.js`（零依赖）在 `tool.execute.before` 自动补 `record_session` 的 `session_id` / `agent` / `branch`；`commands/task-start|task-done|task-handoff.md` 同 claude 侧语义（分支用 `!`git branch --show-current`` 自动填入）。**#279：先切 issue 工作分支再调 `/task-start`，否则展开时填入的仍是基线分支；已切再补 `taskboard_set_work_branch`**。同样先 `/task-start`，做完 `/task-done`。

- **App 设置 → Agent 接入**（#177，一键安装/卸载，实现参考 clawd-on-desk 的 Settings → Agents） —— 任务详情 session 下拉的 39 个 agent **全量可选**：
  - **一键安装**（hook 机制已逐项验证）：`claude-code` / `opencode` / `workbuddy` / `codebuddy` / `trae`；
  - **其余 34 个**：选中后返回手动配置指引（含 codex / cursor / copilot / gemini / qwen / kimi / zcode 的已知配置路径），不伪造成功；
  - **作用域两档**：全局（`~/.claude`、`~/.config/opencode` 等用户目录，所有仓库生效，启动时自动补齐缺失项）与指定仓库；
  - 合并安装、卸载只摘 TaskBoard 部分（改动前留 `.taskboard-bak`）；未安装过的 agent 自动跳过。

- 其他（无 hook 机制的）Agent：把 `AGENT_INSTRUCTIONS.md` 的内容并入其 system prompt / 项目指令即可（codex 的 `AGENTS.md`、helix 的技能/系统提示、cursor 的 `.cursorrules` 等同理）。

> 这样即完成 PRD D5 的「先 MCP，后包 Skill」：MCP 是能力层（已就位），指令文件是「Skill」等价物（跨 Agent 复用），Agent 侧按意图编排调用。

## 文档

- [`PRD.md`](./PRD.md) — 需求文档与决策演进（含已放弃的 Projects v2 方案、归属维度设计、API 避坑点）

- [`docs/API-Architecture.md`](./docs/API-Architecture.md) — **GitHub API 与本地看板状态的架构说明**：数据流向、同步机制、三种获取方式、与 Projects v2 的关系、常见误区

- [`docs/design-and-release.md`](./docs/design-and-release.md) — 设计要点（多源拉取、归属三分、四态维护、PR 关联）与 GitHub Actions 在线打包说明

- [`docs/CHANGELOG.md`](./docs/CHANGELOG.md) — 各版本的更新说明与修复记录（v0.3.1 → 最新 v0.6.5）

- [`docs/issue-327-p0-functional-defects.md`](./docs/issue-327-p0-functional-defects.md) — **code review P0 批次**：About 小窗「确定」按钮因 capability 未覆盖 `about` 窗口 + `core:window:default` 不含 `allow-close` 而静默失效；设置面板「界面语言」切换器被误复制成重复的主题选择器；记事重复内容暴露原始 `UNIQUE constraint` 报错；`projects.number_of_items` 误取项目编号（而非 `items.totalCount`），使多 Project 时写错写回目标

- [`docs/issue-328-p1-data-safety.md`](./docs/issue-328-p1-data-safety.md) — **code review P1 批次（数据安全与健壮性，9 项）**：tasks 物理重建自称「单事务」实则无事务（中断即丢本地态、失败后无自愈路径）；MCP 一行坏 JSON / 超大 `Content-Length` 直接结束或 abort 进程；同步全败仍返回 `Ok` 谎报成功且跳过的账号日志永久停在 running；`graphql()` 无限流处理致项目状态与父子关系静默降级；GUI 写命令吞掉「0 行受影响」；查询错误被折叠成「不在任何 Project 中」；403 一律当限流使权限问题白等 30s；`search()` 单条坏数据拖垮整个数据源

- [`docs/issue-339-taskcard-select-identity.md`](./docs/issue-339-taskcard-select-identity.md) — **深度 review 批次（#339–#346，8 项）· P0 卡片点击完全失灵**：#329 把前端任务身份升级为 `issueKey@accountId`（聚合视图下同一 issue 来自两个账号时 `issueKey` 会重复），消费端全改用 `taskIdentity`，但生产端 `TaskCard.tsx` 根本没进那次 diff、仍在发裸 `issueKey` ⇒ 两者永不相等 ⇒ `selectedTask` 恒 `null` ⇒ 详情面板不可达。既有 `panel-wiring.test.ts` 用正则只断言消费端、从不检查生产者，给出虚假安全感。修复后**写操作仍用 `issueKey`**（后端按 `issue_key` 定位，边界不变）。本批共同根因模式是「只改了一半」：另 7 项含 db.rs 崩溃残留不可恢复（#340）、全局 `opencode.jsonc` 被写成非法 JSON（#341）、仓库级 GraphQL 失败致父子关联清空（#342）、`matchMedia` 解绑 no-op（#343）、Esc 层注册放在不稳定 deps（#344）、MCP 分帧只修 Rust 侧（#345）、`synced_at` 漏出 `ENSURE_COLUMNS`（#346）

- [`docs/issue-329-p2-quality.md`](./docs/issue-329-p2-quality.md) — **code review P2 批次（一致性 / 工程质量，18 项）**：`merge-cleanup.py` 多编号提取丢中间编号、`SKIP_DELETE_MARKERS` 子串误伤（`latest` 命中 `test`）；`check-workflow-yaml.py` 误报 `read-all` / `on: [a,b]` 并补 4 类漏报（浮动分支 `@main`、有 `runs-on` 无 `steps`、顶层 key 重复、`needs` 指向不存在 job）；`server.py::ensure_schema` 列清单仅有 `SELECT_COLS` 的三分之一导致旧库 `no such column`；MCP `handoff_len` 字节数 vs 字符数；`open_db` 每次建连写库致 UI 最长 5s 卡顿（改 `user_version` 门控 + 只读自愈探测、稳态零写锁）；5 个 GUI 命令移出 Tauri 主线程；前端任务唯一键跨账号不唯一、Esc 冒泡双触发、复制定时器泄漏、每键 2 次 IPC、加载中整块替换、编辑草稿被重置、清筛选绕过合并器、CSS 未定义变量、主题监听泄漏

- [`docs/issue-336-docs-ci-reality-alignment.md`](./docs/issue-336-docs-ci-reality-alignment.md) — **CI 门禁盲区 + 文档与仓库现状对齐**：`quality-check.yml` 的 `push` 只挂已废弃的 `develop` ⇒ 直接 push 到 `main` 跳过全部重型门禁（#330 加固后的遗留缺口）；`AGENTS.md` / `CONTRIBUTING.md` / `AGENT_INSTRUCTIONS{,.en}.md` / `.claude`+`.opencode` 的 `task-start` 命令 / `set_work_branch` 的 MCP tool description 共 30+ 处仍指示「从 `develop` 新开分支」，照错做会产生错误分支；`docs/release-backmerge-policy.md` 前提失效加横幅；旧仓库名 `task-dashborad` 4 处陈旧链接 + `blob/develop` 2 处真断链。含「只改指导动作的文本、保留历史记录」的边界口径

- [`docs/issue-345-python-mcp-framing.md`](./docs/issue-345-python-mcp-framing.md) — **深度 review 批次 · Python MCP 一行坏数据即终止进程**：Rust `mcp.rs` 早在 #328 就改为四态 `ReadOutcome`（`mcp.rs:750-753` 也点名了这个症状），但**只修了 Rust 侧**；Python `server.py` 仍把畸形与 EOF 折叠成 `(None, None)`、主循环见 `None` 即 `break`，且 `json.loads(body)` 未包 try。移植四态（关键区分 `MALFORMED` 已完整消费可 continue vs `FATAL` 帧边界丢失只能终止），并补上 Python 侧**原本完全没有**的两个 DoS 上限（NDJSON 分支连长度上限都没有，长行可无界撑爆堆）。测试含 3 例端到端驱动 `main()` —— 首次反向验证暴露「症状由循环决定而非分类决定，只测分类会漏掉半修状态」这一缺口
- [`docs/issue-344-esc-layer-stable-deps.md`](./docs/issue-344-esc-layer-stable-deps.md) — **深度 review 批次 · 确认框按 Esc 直接关掉父面板（本批唯一「正确机制因实现细节失效」项）**：#329 的 Esc 分层栈要求子层晚于父层注册，但 `SyncLogsPanel`（`[onClose]`）与 `ConfirmDialog`（`[onCancel]`）把**层注册**放进带**不稳定回调依赖**的 effect，确认框打开期间一次父重渲染（自动同步 / 4 秒横幅计时器 / 20 秒轮询）就让两层按「destroy 子→父、create 子→父」整体重排 ⇒ **面板压过自己的子层** ⇒ 一次 Esc 跳过「取消」直接关面板。修复新增 `useWindowEscLayer`，把层注册（`[]` 依赖）与业务回调（ref）解耦；测试把不变式直接钉在栈原语上（含把缺陷形态写成期望值的反面对照）
- [`docs/issue-343-theme-mql-identity.md`](./docs/issue-343-theme-mql-identity.md) — **深度 review 批次 · 显式主题选择仍被系统覆盖（#329 的修复实际没生效）**：按 CSSOM View 规范 `Window.matchMedia(q)` 每次返回 **new** MediaQueryList（各自独立监听列表），而 #329 只记函数引用、解绑时重新 `matchMedia()` 取**新对象**去 remove ⇒ 恒为 no-op ⇒ 既覆盖用户显式选择、又把监听器泄漏进每个新对象。旧打桩 `matchMedia: () => media` 永远返回同一对象，与平台行为正好相反，故藏身；「解绑用同一函数引用」那条用例只比函数身份、从不比 MediaQueryList 身份。修复持有实例本身；测试先按平台语义重写打桩 + 新增 `liveListeners()` 真实度量
- [`docs/issue-340-recover-orphan-tasks-new.md`](./docs/issue-340-recover-orphan-tasks-new.md) — **深度 review 批次 · 整个看板静默丢失（本批唯一数据永久丢失项）**：重建事务停在 `DROP TABLE tasks`（已提交）与 `RENAME`（未执行）之间 ⇒ 留下 `tasks` 缺失、`tasks_new` 保有全量数据。#328 加的 `DROP TABLE IF EXISTS tasks_new` 自愈**只在重建函数内部可达**，而前置条件在该状态下为 false ⇒ 自愈分支恰好在最需要时不可达 ⇒ `SCHEMA` 建出空表、版本号盖到最新、迁移此后再不重跑。实测二次打开也不自愈。修复在迁移门控前探测并 `RENAME` 回收；实现中新发现「探测块须早于 `SCHEMA` 且须加 `issue_key` 列指纹，否则列不全的残留表会让整个库打不开」这一坑
- [`docs/issue-355-require-affected-remaining-writes.md`](./docs/issue-355-require-affected-remaining-writes.md) — **深度 review 第二批 · #355**：`clear_session` / `record_handoff` 未守 `require_affected` ⇒ key 不存在时返回成功却什么都没改，且与 MCP 侧行为不一致（#328 只覆盖5 条写路径里的 3 条）。**并修掉一个本来就失效的防回归测试** —— `write_commands_check_affected_rows` 用 `src.matches()` 对整份源码计数，而 `mod tests` 里自身的用例也含同样调用把计数抬高，`>= 3` 阈值形同虚设（反向验证时真的被骗过一次）；改为过滤注释 + 在 `mod tests` 处截断 + `assert_eq!(…, 5)`
- [`docs/issue-356-project-issue-updated-at.md`](./docs/issue-356-project-issue-updated-at.md) — **深度 review 第二批 · #356**：仅经 Project 发现的 issue `updated_at` 恒为 0、卡片日期永久空白。根因双重：项目条目查询**没选** `updatedAt` + `RawTask.updated_at` **写死空串**。修复同时把内联查询串抽成纯函数（沿用 #327 先例）——这正是该缺陷长期潜伏的原因：查询串内联在网络函数里，没有任何测试能看到它选了什么字段
- [`docs/issue-357-mcp-framing-and-args.md`](./docs/issue-357-mcp-framing-and-args.md) — **深度 review 第二批 · #357**：#345 只修了 Python 侧，Rust 侧（正式路径）仍有三处 —— 缺 `Content-Length` 误判 `Malformed`（正文长度未知、流位置未确定，应 `Fatal`，与紧邻的 `len == 0` 口径本就不一致）、NDJSON 分支无单帧上限（同 #328 的 DoS 类别）、**非字符串参数静默丢弃**（`list_my_tasks({status:123})` 返回整块看板且 `isError:false`，而 Python 侧报错 ⇒ 正式路径给错数据、兜底路径给错误）
- [`docs/issue-358-issue-url-anchor.md`](./docs/issue-358-issue-url-anchor.md) — **深度 review 第二批 · #358**：issue 永久链接的尾部锚点（`.../issues/7#issuecomment-1`，GitHub UI 复制链接的标准形式）在正式 MCP 路径被拒。两处与 Python 侧不一致：编号整体 `parse`（只剥前导 `#`）、完全忽略第 3 段（`discussions/7` 被误接受）。**并纠正一条名不副实的既有测试注释**（"尾部锚点"其实只测了空白）
- [`docs/issue-359-tooling-hygiene.md`](./docs/issue-359-tooling-hygiene.md) — **深度 review 第二批 · #359（工具链）**：`serverInfo.version` 硬编码 `0.6.1`（实际 0.6.5）且无门禁 → 改为读 `Cargo.toml` 单一来源；CI clippy 只跑 `--lib` ⇒ 测试代码完全没被检查（`main` 上积压 5 处 error）→ 修掉并扩到 `--all-targets`；`check-mcp-columns.py` 未覆盖写列清单 `TASK_INSERT_COLS` → 新增断言（**性质为防御性冗余**，非修 bug，见 #346）
- [`docs/issue-342-issue-links-repo-level-err.md`](./docs/issue-342-issue-links-repo-level-err.md) — **深度 review 批次 · 父子 issue 关联被静默清空**：#328 把 `fetch_issue_links` 改为宽松模式，放行判据是 `v["data"].is_null()`，但 `data` 是**仓库包装层** —— 仓库改名/转移/删除/token 失权时 GitHub 返回 `{"data":{"r":null},"errors":[…]}`，`data` 非 null ⇒ 守卫不触发 ⇒ 解析器返回空 map 而非 `Err` ⇒ `links_failed_repos` 收不到该仓库 ⇒ `TASK_CONFLICT_UPDATE` 无条件覆盖关联 ⇒ **父子关系清空且无报错**。修复把判据落到 `data.r` 这一层（新增 `repo_level_failure`），**并保留 #328 的宽松容错**（仓库有效 + 个别名失败仍采信其余编号，有反向对照用例防修复过度）
- [`docs/issue-341-opencode-jsonc-empty-mcp.md`](./docs/issue-341-opencode-jsonc-empty-mcp.md) — **深度 review 批次 · 全局 `opencode.jsonc` 被写成非法 JSON**：`find_top_object_span` 返回键起始引号位置而非 `{` 位置，而唯一调用方按 `{` 位置使用 ⇒ 空对象守卫恒 false（死代码）⇒ 把 `,` 插进 `{` 后面得 `"mcp": {,`，**用户全局配置被写坏、opencode 无法启动**，且安装流程仍返回 `Ok`（UI 报成功）。「注释型 JSONC + 空 `mcp`」是 opencode 标准配置形态；非空 `mcp` 不暴露缺陷，故既有测试抓不到。修复需**两处同改**（返回值改 `{` 位置 + 空对象分支格式串，否则只是把 `{,` 换成 `{{`）

- [`docs/issue-335-closed-state-case.md`](./docs/issue-335-closed-state-case.md) — **已关闭 issue 滞留看板**：`tasks.issue_state` 同一列存在 4 种大小写（GraphQL 的 `IssueState` 是大写 `OPEN`/`CLOSED`，REST 是小写），而三处 closed 判据写死小写 ⇒ `AGENTS.md §2.2` 优先级第 1 条「closed → done 远程权威覆盖」对 Project 来源的 issue 完全失效；Project Status 的英文选项又因 `map_project_status()` 只认中文而兜底失败，实测 29 行滞留（`closed` 小写侧 0 行异常，反证缺陷只在大写）。修复为四层：判据归一（`common::is_closed_state`）、落库归一（`normalize_issue_state`）、英文映射补全（整值全等防 `Ready for release` 误判）、存量数据修复（随 `SCHEMA_VERSION` 3→4 门控，刻意不臆造 `done_at`）

- [`docs/issue-330-p3-quality-gates.md`](./docs/issue-330-p3-quality-gates.md) — **code review P3 批次（规范 / 文档 / CI 门禁，7 项）**：版本号分散在 5 个文件却零自动化校验（实测 `package-lock.json` 落后两个大版本）；15 篇知识库文档既不在 README 也不在 CHANGELOG（孤岛）；ESLint `--max-warnings 20` 只剩 2 条余量、门禁形同「不许再写第 3 条 warning」；CI 不跑 `vite build` 与 `cargo fmt --check`、action 版本 v4/v5 混杂；release 无超时（挂死按 6 小时计费）与并发控制；4 个只读 workflow 未声明 `permissions`；`check-i18n.mjs` 硬编码两个语种致新增语言漏检。含新增 `scripts/check-versions.py`、`check-doc-links.py` 孤岛检测、全仓库 `cargo fmt` 归一化（263 hunk / 11 文件）

- [`docs/issue-285-sync-empty-board.md`](./docs/issue-285-sync-empty-board.md) — **立即同步后看板空白、重启才恢复**：`rows_to_tasks` 两处缺陷——归属筛选分支漏 2 列（`Row::get(25)` 越界报错）+ `my-created` 误读恒空的 `meta.login` 恒返回空集；统一 SELECT 列清单 + 从 `accounts` 表取 login；`doSync` 走合并器并同步后重拉项目状态列

- [`docs/v0.3.15-pat-auth.md`](./docs/v0.3.15-pat-auth.md) — v0.3.15 PAT 认证与 visual polish 设计文档（gh 替换、卡片配色、多账号规划）

- [`docs/troubleshoot-mcp-timeout.md`](./docs/troubleshoot-mcp-timeout.md) — 排障：MCP 连接超时（30000ms）——macOS Gatekeeper / quarantine 隔离属性排查与修复

- [`docs/issue-181-auto-refresh.md`](./docs/issue-181-auto-refresh.md) — 外部写入（MCP）后 App 任务界面自动刷新：聚焦/轮询/指纹跳过 + `tasks-changed` 事件

- [`docs/release-backmerge-policy.md`](./docs/release-backmerge-policy.md) — ⚠️ **已失效（保留作历史记录）**：原「发布回合策略」要求 release 合入 `main` 后把 `main` 回合 `develop`；`develop` 分支已废弃并从远端删除（2026-09-30 核实），该策略随之作废 —— 现为「所有 PR 直接进 `main`」的单主干流程

- [`docs/issue-256-update-check.md`](./docs/issue-256-update-check.md) — **检查更新双通道并发**：updater 通道无超时导致的串行慢 + 静默 fallback；并发 + 单路 30s 封顶，手动下载时展示失败原因

- [`docs/issue-259-sidebar-nav.md`](./docs/issue-259-sidebar-nav.md) — **左右分栏布局**：左侧固定 Sidebar（记事本 / 账号点选 / 设置 / Agent 接入 / 同步日志 / 账号登录 / 关于）承载全部入口，顶栏精简；设置 / 账号 / 同步日志由 Modal 改为主区内嵌全高页面，Agent 接入面板展示 MCP 配置与看板工具说明

- [`docs/issue-263-agent-device-scan.md`](./docs/issue-263-agent-device-scan.md) — **Agent 设备扫描**：刷新升级为「扫本机已安装 / 已卸载的 agent」——PATH + 配置目录 + macOS 应用包三类信号 + 快照对比判卸载，含「疑似已卸载」分组与防漂移测试
- [`docs/issue-265-sidebar-collapse.md`](./docs/issue-265-sidebar-collapse.md) — **侧边栏窄窗收起**：窗口宽度 < 900px 时 Sidebar 自动收起为纯图标模式（~56px），隐藏文字标签 / 分组标题，账号靠 `title` 提示辨识；纯响应式、不持久化

- [`docs/issue-266-test-flake.md`](./docs/issue-266-test-flake.md) — **修复 Rust 测试随机 disk I/O error**：`mem_conn()` 临时库路径加每调用递增序号、连接存活期不再删文件，消除并行测试互相 unlink 的 CI flake；新增防回归断言

- [`docs/issue-281-license.md`](./docs/issue-281-license.md) — **配置开源协议（MIT）**：根目录新建 `LICENSE` + `package.json` / `Cargo.toml` 补 `license` 字段 + README 徽章与协议章节 + CONTRIBUTING 贡献者协议说明；含 MIT / Apache-2.0 / GPL / AGPL 决策对比与「为何不用 `MIT-0`、不动两个 lockfile」的取舍

- [`docs/issue-284-merge-cleanup.md`](./docs/issue-284-merge-cleanup.md) — **PR 合并后自动收尾**：删源分支 + 关闭关联 issue（`develop` 合入不触发 GitHub 自动关闭），提取规则刻意保守防误关；顺带新增 workflow 语法检查器与 `scripts` CI job，补齐此前对 `.github/workflows/` 的零覆盖
- [`docs/issue-279-work-branch-not-updated.md`](./docs/issue-279-work-branch-not-updated.md) — **开始任务后 work_branch 仍关联基线分支**：`/task-start` 在 agent 尚处 develop/master 时就录分支，导致看板详情误导；改写为「先切 issue 分支再记录」+ 新增 `set_work_branch` 工具补偿纠正
- [`docs/issue-278-issue-links.md`](./docs/issue-278-issue-links.md) — **详情关联 parent / sub issue**：批量 alias GraphQL 同步父子关系（25 个/请求 + 按仓库 best-effort 保留既有值），详情面板新增「关联 Issue」块支持打开与复制；含 26 列 MCP 双实现与迁移补列教训
- [`docs/issue-262-multi-account-sync.md`](./docs/issue-262-multi-account-sync.md) — **多账号同步修复**：同步范围与视图模式解耦，恒覆盖全部账号（不再受 `view_mode` 限制）；恢复 topbar 显示模式切换，消除死代码 / 死 key；`SyncResult` 新增 `accountsSynced` 可观测性字段

- [`docs/issue-235-in-app-api-log.md`](./docs/issue-235-in-app-api-log.md) — **应用内 API 调用明细**：`api_logs` 新表 + 可选 sink 收集器，同步/认领/状态写回的请求与返回参数可在日志面板展开查看（承接 #228 的 stderr 埋点）

- [`docs/issue-237-card-creator-row.md`](./docs/issue-237-card-creator-row.md) — **看板卡片结构调整**：移除顶部账号徽章行、新增「创建人」行（`tasks.author`）、加大 `repo #编号` 字号；含 v2 重建后必须补列的迁移教训

- [`docs/issue-239-doc-integrity.md`](./docs/issue-239-doc-integrity.md) — **文档完整性修复**：断链 / 不可移植 `file://` 路径 / 失效行号锚点 + v0.3.50 CHANGELOG 补录；含 `scripts/check-doc-links.py` 防回归

- [`docs/issue-252-ci-green.md`](./docs/issue-252-ci-green.md) — **修好既有 CI**：prettier 全量格式化（以产物 sha256 不变证明零影响）+ 把 Tauri 的 Linux 系统依赖抽成 composite action，`quality-check.yml` 四个 job 恢复全绿

- [`docs/issue-250-ondemand-issue-pull.md`](./docs/issue-250-ondemand-issue-pull.md) — **未同步 issue 按需拉取**：MCP 写路径命中「任务不存在」时下拉单个 issue 落库（只读 GitHub、不触发全量同步）；含 owner 匹配与 `DO NOTHING` 落库的取舍、真机验证记录

- [`docs/issue-248-synclogs-hscroll.md`](./docs/issue-248-synclogs-hscroll.md) — **同步日志表格横向滚动**：容器 `overflow: hidden` 静默裁掉右侧列（错误 / 明细）；滚动职责收敛到紧贴表格的容器，含 `src/styles.test.ts` 静态回归测试

- [`docs/perf-audit-optimization.md`](./docs/perf-audit-optimization.md) — **性能 / 安全优化批次索引**：`P0-1`…`P2-2` 编号到 issue 与落地文档的映射（`#143`–`#150`，随 v0.3.50 发布）

- [`docs/issue-118-expand-platform-support.md`](./docs/issue-118-expand-platform-support.md) — **扩展平台支持**：release 矩阵显式声明 `target`，新增 macOS 双架构与 Windows ARM64 构建

- [`docs/issue-119-expand-release-matrix.md`](./docs/issue-119-expand-release-matrix.md) — **扩展 Release 打包矩阵**：Linux arm64、rpm、Windows msi；并记录 `zip` 作为 Tauri 2 bundle 类型**被当日回滚**的教训

- [`docs/issue-317-session-clear-confirm-modal.md`](./docs/issue-317-session-clear-confirm-modal.md) — **删除会话二次确认弹框被铺满成全屏页面**：`.panel-page .modal` 覆盖规则误伤 `ConfirmDialog`，收窄为 `:not(.confirm-modal)` + 加 `confirm-mask` 类恢复居中弹框
- [`docs/issue-319-kb-doc-links.md`](./docs/issue-319-kb-doc-links.md) — **补全 #313/#314/#315 缺失的 KB 文档**：CHANGELOG 引用的三篇文档此前从未创建导致 6 处断链，依据已合并改动补齐，恢复 `check-doc-links.py` 通过
- [`docs/issue-322-note-edit-autosize.md`](./docs/issue-322-note-edit-autosize.md) — **编辑记事文本框不随内容长度自适应高度**：`useAutoSize` 由被动 `useEffect` 改为 `useLayoutEffect` + 进入编辑态主动测量，修复进入编辑态长内容停在 1 行的缺陷

- [`docs/issue-325-about-window.md`](./docs/issue-325-about-window.md) — **菜单栏 About TaskBoard 改为自定义独立小窗（对齐 WorkBuddy）**：macOS 自定义应用菜单接管默认 About + 新增 `about` 固定小窗（图标 / 粗体名 / 版本·Tauri·WebView 三行 / 全宽确定）；WebView 版本前端从 `navigator.userAgent` 推导（Tauri 2 核心不暴露、不引新依赖）

### 历史知识库文档

> #330 起 `docs/*.md` 必须被 README / CHANGELOG 索引（否则 `check-doc-links.py` 报「孤岛文档」）。
> 以下 15 篇此前既不在 README 也不在 CHANGELOG，只能靠「知道文件名」才找得到，现补齐反链。

- [`docs/issue-62-bug-audit-fixes.md`](./docs/issue-62-bug-audit-fixes.md) — **Bug 审计遗留 9 项修复**：2026-09-06 对 develop 做三路并行全量排查（前端静态审查 + 后端静态审查 + 工具链冒烟）发现的 13 条中的 9 条
- [`docs/issue-191-auto-start.md`](./docs/issue-191-auto-start.md) — **opencode 插件自动执行可靠性**：`autoStart` 失败时报喜不报忧且永久抑制重试，还会把 `processed` 任务打回 `doing`
- [`docs/issue-193-polish.md`](./docs/issue-193-polish.md) — **启动自动注册 dev 路径 + `workBranch` 可见性**：开发态首次启动免手填仓库路径，看板详情展示工作分支
- [`docs/issue-197-card-session-row.md`](./docs/issue-197-card-session-row.md) — **卡片 session id 独立行展示**：原先有 session 就挤掉更新时间（三元二选一），改为分配人下一行独立展示、时间恒显示
- [`docs/issue-204-multi-task.md`](./docs/issue-204-multi-task.md) — **单窗口多任务自动执行失活**：插件用整会话累计 buffer 判定「唯一引用」，累计 >1 后永久不再自动执行、`session_id` 存不进去
- [`docs/issue-207-group-toggle.md`](./docs/issue-207-group-toggle.md) — **设置页 agent 分组下拉展开**：四组平铺在 agent 多时页面过长，改为每组可展开 / 收起
- [`docs/issue-212-dead-code-warnings.md`](./docs/issue-212-dead-code-warnings.md) — **清死代码 warning**：`tauri dev` 常驻的 `fetch_state is never used` 与测试态的 `unused conn`
- [`docs/issue-216-del-last-account.md`](./docs/issue-216-del-last-account.md) — **仅剩一个账号时允许删除**：`delete_account` 禁止删默认账号，而只剩一个时它必是默认 ⇒ 想清掉重配 token 都做不到
- [`docs/issue-220-sig-project-status.md`](./docs/issue-220-sig-project-status.md) — **指纹缺 `projectStatus` 致写回后不刷新**：#215 写回成功但页面不动 —— `taskListSignature` 未覆盖 `projectStatus` 且 `status` 恰好无变化 ⇒ 指纹相同跳过渲染
- [`docs/issue-221-account-switch-stale.md`](./docs/issue-221-account-switch-stale.md) — **切换账号请求被吞、看板滞留旧账号**：`App.load()` 防重入在忙时直接丢弃请求且无重试，最长延迟到下轮 20s 轮询
- [`docs/issue-224-log-account.md`](./docs/issue-224-log-account.md) — **同步日志展示所属账号**：同步范围跟视图走（single / all），但日志面板不显示账号，多账号下分不清
- [`docs/issue-226-close-custom-columns.md`](./docs/issue-226-close-custom-columns.md) — **自定义列映射页签暂关闭**：owner 要求先下掉该入口
- [`docs/issue-258-sync-warn-banner.md`](./docs/issue-258-sync-warn-banner.md) — **部分失败仍显示绿色成功 banner**：`warning` 非空时改为琥珀色警告 banner，与成功 banner 互斥展示
- [`docs/issue-276-auto-update-check.md`](./docs/issue-276-auto-update-check.md) — **每日自动检查更新 + 「仅显示我创建」筛选**：免手动点「检查更新」；并区分「自己创建的」与「分配给自己的」issue
- [`docs/v0.3.16-multi-account.md`](./docs/v0.3.16-multi-account.md) — **v0.3.16 多 GitHub 账号支持设计文档**：在 v0.3.15 PAT 认证基础上扩展为「账号池」，任务按 `account_id` 归属，支持单账号 / 全部账号两种视图

## 协议（License）

本项目采用 **MIT License**，完整文本见 [LICENSE](./LICENSE)。可自由使用、复制、修改、合并、发布、分发、再授权乃至出售本软件的副本，前提是**在本软件或其大部分副本中保留上述版权声明与许可声明**（即根目录 `LICENSE` 文件的内容）。

软件按「原样」提供，不作任何明示或默示的保证；作者与版权持有者不对使用本软件所引发的任何主张、损害或责任负责。详见 `LICENSE` 中的免责条款。

> 版本 v0.6.5 · 本地跨平台桌面 App（Windows / macOS / Linux），2026-09-29


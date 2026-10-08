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
- [`docs/issue-396-tasks-new-fingerprint-untested.md`](./docs/issue-396-tasks-new-fingerprint-untested.md) — **断言强度审计 · `db.rs`（本仓首次审计）：#340 恢复探测的 `issue_key` 指纹保护无任何测试**：`db.rs` 是本仓**唯一「最坏事故类别 + 零审计」的组合** —— #340 是**永久数据丢失**（`tasks` 被 DROP、`tasks_new` 保有全量数据却打不开库、版本号盖到最新、迁移此后再不重跑）。审计 8 个目标，**最关键的判据只被守住一半**：`open_db` 里逐字写着「⚠️ 必须确认 tasks_new **确实是 tasks 布局**才 RENAME，否则 SCHEMA 的 `CREATE INDEX ... ON tasks(ownership)` 会因缺列而整个 batch 失败 —— 那比『看板为空但能打开』更糟（**库直接打不开**）」，**但这条保护没有任何测试**。已有用例只覆盖**正向**（真实 tasks 布局 ⇒ 应恢复），**反向情形（`tasks_new` 存在但并非 tasks 布局）完全没测**。后果实测：指纹在 ⇒ `tasks_new` **保留原状**（安全侧）；指纹去掉 ⇒ 被**当成 tasks 升为看板主表**。**与 #376 `taskSig` 完全同型：契约被逐字写在注释里，却只守住契约的一半**
  - **与 #390/#392/#394 同系列的第 4 例**：#390 枚举只手写 6 个组件、#392 正则只匹配一种写法、#394 解析只认一种语法形态、**本项只守正向不守反向** ⇒ 归纳为 **断言覆盖面必须覆盖契约的全部实例，而不只是那个最常写的实例**
  - **方法论：为什么 `db.rs` 适合 mutation**。它虽依赖真实 SQLite，但可测的是纯逻辑 —— 迁移**门控条件**（版本号比较、`fresh`/`needs_migration`）、**恢复探测的可达性**（只需构造 schema 变体）、`SCHEMA` 与迁移列表的一致性（读文本）。**不需要对 SQL 执行做 mutation**，要测的是「这段代码在什么状态下才会跑」—— 而 #340 的形态（自愈分支不可达）恰是可达性缺陷，**注入「把前置条件改成永不成立」一测就暴露**，读代码极易漏判
  - ⚠️ **我又犯了 #380 的同一个错误**（当时已写进 KB，本次仍重犯）：插入点替换的 anchor 只取 `fn xxx() {` 一行，上方 doc + `#[test]` 留在原地 ⇒ `duplicated attribute` + **原函数失去 `#[test]` 变 dead code**，而 **`cargo test` 仍通过（27 passed）**，只有 clippy 暴露。**教训固化**：插入点替换必须**连 `#[test]` 一起锚定**，或插入后**立即**跑 `clippy --all-targets` —— 这是 clippy 门禁（#366）的第二重价值
  - 另记 1 个存活但**不是缺陷**的等价变异：去掉 `table_exists(tasks_new)` 判据 —— 全新库上两表都不存在，而 `table_has_column` 对不存在的表返回 `false`，条件仍为假
- [`docs/issue-394-css-decls-selector-shape.md`](./docs/issue-394-css-decls-selector-shape.md) — **断言强度审计 · 前端 CSS 静态断言：helper 只认精确选择器，@media 内规则完全不可见**：审 `notes-layout.test.ts` 与 `styles.test.ts`（两者都用 `?raw` 读 `styles.css` 做静态断言，因 vitest 跑在 node 环境无 DOM/布局引擎、§2.5 不引入 jsdom）。**同一个 `decls()` helper 在两个文件里各写了一份**（30 + 25 = **55 个守卫**受影响），且只匹配精确选择器字面量 `/(?:^|[},])\s*${esc}\s*\{([^}]*)\}/`。**盲区 1（最讽刺）**：锚点 `(?:^|[},])` **不含 `{`** ⇒ `@media` 内规则的 selector 前驱是 `{` ⇒ **完全不可见**；而 **#259 的缺陷本体正是「窄屏四列被压成 ~18px 竖条」** —— 要防的问题所在的空间恰好是守卫的盲区。**盲区 2**：只认字面量相等 ⇒ 后代选择器 `.notes-page .notes-card-cols`（作用于同一元素、特异性更高、**实际生效**）与合并选择器 `.notes-card-cols, .sidebar` 全被漏。**注入验证 5 种形态漏网 4 种**，修复后 **8/8 全捕获**
  - **方案**：匹配语义改为「规则选择器按逗号拆开、去掉祖先前缀后**以调用方选择器结尾**」，一次覆盖四种写法（完全相同 / 后代 / 合并其中一项 / **调用方自带后代**）。用 `endsWith` 而非 `startsWith`/包含，避免 `.note-col` 误命中 `.note-col--p1`。规则提取用 `/([^{}]+)\{([^{}]*)\}/g` —— **外壳因声明体含 `{` 被自然跳过，内层规则直接取到**，无需专门写嵌套解析
  - **归纳出更一般的规律**（本系列第 3 例，成因各不相同）：#390 枚举只手写 6 个组件、#392 正则只匹配一种写法、**#394 解析只认一种语法形态** ⇒ **断言的实现形式（枚举 / 字面量 / 语法子集）必须覆盖问题出现的全部语法形式**，否则同一问题的「换个写法」就会静默逃逸
- [`docs/issue-392-esc-deps-regex-too-narrow.md`](./docs/issue-392-esc-deps-regex-too-narrow.md) — **断言强度审计 · 同一文件第二类盲区：#344 Esc 依赖守卫正则只匹配一种写法**：守卫原文 `not.toMatch(/\}, \[on(Close|Cancel)\]\)/)` **只匹配依赖数组恰好等于 `[onClose]`**。而 #344 要防的是「**不稳定的回调依赖导致 Esc 层整体重排**」这**一类**问题（面板压过子层 ⇒ 一次 Esc 跳过取消直接关面板），不是「恰好等于 `[onClose]`」这一个写法。注入验证：`[onClose, t]` 是**完全自然**的写法 —— 任何人多留一个变量就绕过守卫，而失效机制照样发生。修复后 `[onClose]`/`[onClose, t]`/`[t, onClose]`/`[onClose, onClose]`/`[onCancel]` **5 种形态全捕获**，而 `[deps]`/`[]` **不误报**。关键取舍：间接依赖（`useCallback` 吃进回调）当前无法被字面量正则发现，**如实标注为遗留局限**而非强上
  - **排查过程含两个假阳性，如实记录**：①逐一核对 14 个 `?raw` 变量使用次数 ⇒ **无死 import**；②用组件名 grep 找未覆盖组件 ⇒ **误报**（`notesRaw`/`boardRaw`/`agentRaw` 走变量而非字符串），改按「raw 变量使用次数」才得到正确结论。**找覆盖缺口时「按名字 grep」与「按实际引用」结论可能相反**
  - ⚠️ **本轮第八、九次「测量手段本身出错」，也是最该记住的一条：判结果只用退出码，不要解析输出文本**。⑧用 `grep -oE "Tests .*"|head -1` 抓到的是失败输出行 `Tests 1 ⎯⎯⎯`（非汇总行）⇒ 把 5 个形态全判反；⑨自写脚本用 `grep -q "No tests failed"` 判全绿，而该字符串并非 vitest 输出、**恢复态就误报** ⇒ 整张表结论作废。最终改用 `(npx vitest run >/dev/null 2>&1); echo $?`（0=全绿）一次跑完全部形态
  - **与 #390 根因同源**：守卫覆盖范围窄于它要防的问题域 —— #390 是「枚举只有 6 个组件」，本项是「正则只匹配一种写法」。两者印证：**测试断言的措辞形式（枚举/相等/正则）必须匹配它要防的问题的粒度**，否则会在同一问题的其他写法前静默失效
- [`docs/issue-390-openbrowser-guard-enumeration.md`](./docs/issue-390-openbrowser-guard-enumeration.md) — **断言强度审计 · 前端组件测试：openExternal 守卫只覆盖手写 6 项枚举，新增组件裸调完全漏网**：先确立**结构性事实** —— 3 个组件测试文件全部用 `renderToStaticMarkup`（19 处），而服务端渲染**完全丢弃事件处理器**，且全仓**零交互模拟**（无 `fireEvent`/`userEvent`/`dispatchEvent`）⇒ **任何组件测试都不可能抓到事件绑定缺陷**。在 §2.5 不引入 jsdom 的约束下，`panel-wiring.test.ts` 的静态正则守卫是唯一防线，但它**只遍历手写的 6 项枚举**（该文件已 import 12 个组件，清单只有 6 个；`components/` 下共 16 个 `.tsx`）。实测注入验证：`AgentPanel` / `SettingsPanel` 各注入一处 `api.openInBrowser(` ⇒ panel-wiring **全绿**，而清单内的 `SessionsPanel` 注入才失败
  - ⚠️ **「只改了一半」模式的第 5 次实例，且递归了一层**：#370 修的正是 `SessionsPanel` 裸调并**加了这条守卫**，但守卫只覆盖当时已知的 6 个组件 ⇒ 前四次是「只改了一半的**代码**」，这次是「只覆盖了一半的**守卫**」。修法与 #376/#380 同源：**手写枚举 → `import.meta.glob` 自动枚举**（覆盖 `components/*.tsx` + `App.tsx`），新增组件天然在范围内、无需记得同步维护清单
  - **两条防恒真守卫**（#367 教训）：实测 `import.meta.glob` 路径写错时**静默匹配 0 个文件不报错**，守卫会变恒真断言。故加 `names.length > 10` 下限 + **反向契约**（自动枚举范围须是手写清单的严格超集）。**反向验证**：6 个原漏网组件 + `App.tsx` 全部捕获，破坏路径也捕获
  - **我犯了两次同类错误，都被当场抓出**：①第一版只写 `'./components/*.tsx'` 漏了根目录的 `App.tsx` ⇒ **由我自己写的反向契约当场报出**（若无它，这个盲区会随修复合入 main，与本 issue 修的正是同一类问题）；②验证时误判「守卫存活」，实际是 **vitest 变换缓存**返回旧结果 —— 本轮**第六次**「测量手段本身出错」
  - **如实记录遗留局限**：`renderToStaticMarkup` 使组件测试**无法验证事件绑定**（`onClick` 绑错函数、回调内部逻辑错误当前无任何测试能发现），修它需引入 jsdom 违反 §2.5，须作独立提案评估。本 issue 只把「静态可查」那部分的覆盖从 6 个扩到 16 个 + `App.tsx`
- [`docs/issue-388-iso-parity-two-implementations.md`](./docs/issue-388-iso-parity-two-implementations.md) — **断言强度审计 · 双实现一致性：`server.py::_iso_to_secs` 与 Rust `iso8601_to_secs` 自称对齐、实际 5 处分歧，且其中一处是真实缺陷**：两份**完全独立**的实现（一个手写闭式公式、一个调 `strptime`），Python docstring 明确声称「对齐 Rust」。**真实缺陷**：Python 直接返回 `calendar.timegm(...)`，`1969-01-01` 得到**负数** `-31536000`，而 Rust 有显式 `y<1970` 守卫返回 `0` ⇒ 同一 issue 被两条路径先后写入时时间戳**取决于谁最后动手**，下游「相对时间」遇到负值显示荒谬文案。另 4 处分歧：`2024-02-30`（strptime 校验逐月天数 vs Rust 只查 `1..=31`）、`2024-1-01` 与 `2024-01-01T0:00:00Z`（strptime 要求零填充 vs `parse::<u32>()` 宽松）—— 这四处 Python 都更严格且严格方向都是「返回 0」= **失败关闭**，故保持现状并显式记录，不为对齐而改行为
  - ⚠️ **最值得记录的一点：`2024-01-01T00:00:60Z` 带跨平台性质**。实测（macOS arm64 / glibc / Python 3.14.8）**`%S` 接受 60 和 61（闰秒）**，`timegm` 再进位到下一分钟；而 **musl（Alpine）与 Windows 的 C 库未必接受** ⇒ 同一份 `server.py` 在 Linux/macOS 与 Windows 上结果**可能不同**。而 `server.py` 正是 Windows/Linux 的**兜底实现**，故该值不能当稳定契约；GitHub 从不发闰秒故当前不可达，但若将来要支持闰秒语义**必须两侧同时改且不能依赖 `strptime` 的平台行为**
  - **方案：共享 fixture `mcp_server/fixtures/iso_parity.json`**（`must_agree` 27 条 + `known_divergence` 4 条），**两侧测试各读同一个文件**。**不各写一份表的理由**：#155（`tasks.key`→`issue_key` 改名只改一侧、Python 读路径静默失效几版）已证明双副本必然漂移，且 **`server.py` 不参与 Tauri 构建**，Rust CI 跑不到 Python 测试。`known_divergence` 两侧各自锁定并带 `note`，行为变更时提示「须确认有意为之」
  - **反向验证双向生效**：Python 退回负时间戳 → failures=2；改坏 fixture 里 `2100-03-01` 期望值 → **Python failures=1 且 Rust 1 failed 同时报警**。附插曲：第一版 fixture 我照 Rust 抄了 `sec=60` 的期望值，测试当场报 `1704067260 != 0` —— **共享表第一道价值生效**，这是「期望值必须实测」的第三次生效（#378 我手算 `2024-02-30` 出错是第一次）
- [`docs/issue-386-python-mcp-parse-ref-coverage.md`](./docs/issue-386-python-mcp-parse-ref-coverage.md) — **断言强度审计 · Python 侧（第一批）：MCP 引用解析形态覆盖缺口，且两侧实现测试覆盖不对称**：`mcp_server/server.py::parse_issue_ref_parts` 是 **agent 每次调用 MCP 工具的入口**（`update_task_status(issue,...)` 等全部走它），而 AGENTS.md §8.6 要求它与 Rust `on_demand.rs` 行为等价。实测 4 个变异存活，最关键的是 **`(?:issues|pull)` 退化为 `(?:issues)` ⇒ `/pull/{n}` 链接全部解析失败**，且失败方式是抛「无法解析 issue 引用」——看起来像「用户填错了引用」，**不会有任何告警**。另 3 个：漏 `rstrip("/")` 使 `owner/repo/#N` 解析出错误 repo、`rpartition`→`split` 改多 `#` 行为、删空引用守卫改错误消息。**跨侧覆盖不对称（本项额外发现）**：`on_demand.rs:459,485` **已有** `/pull/` 断言而 Python 侧完全没有 —— Rust 改正则时 Python 侧无人发现，与 #155（改名漏改 Python 侧、读路径静默失效几个版本）同类风险面。**关键技术点：断言必须断言错误消息而非只断言异常类型** —— 我第一版只写 `assertRaises(ValueError)`，结果 `rpartition`→`split` 依旧存活，因为后者也抛 `ValueError`（unpack 长度不匹配），**两种写法在测试眼里完全一样** —— 这正是 #376「断言看起来合理 ≠ 有判别力」的教训落在自己身上。另诚实标注 **1 个存活不是缺陷**：`[^/#?]+` 放宽为 `[^/]+` 对合法 URL 是等价变异（路径段本就不含 `?`/`#`）
  - ⚠️ **本轮第五次「测量手段本身出错」**：验证脚本的 grep 只匹配 `FAILED (failures=`，而 `url-pull` 产生的是 `FAILED (errors=1)`（异常 vs 断言失败）⇒ 被报成 `??`。至此五条纪律共同点：**先验证测量手段本身，再采信结论**
- [`docs/issue-384-parse-links-alias-guard.md`](./docs/issue-384-parse-links-alias-guard.md) — **断言强度审计 · Rust 侧（第四批）：GraphQL 父子链接解析的别名守卫「空洞为真」**：审计前 `parse_links_from_graphql` 只有 2 条平凡断言（`{}` 与 `{"data":{}}` → 空），整条解析路径几无直接覆盖。**发现真实漏洞**：`!key.starts_with('a') || !key.chars().skip(1).all(is_ascii_digit)` —— Rust 的 `Iterator::all` 对**空迭代器返回 `true`**，故光秃秃的 `"a"` 被当成合法别名放行，与紧邻注释声明的契约（"别名固定为 `a<序号>`"）相悖；实测 `{"a":{...},"a1":{...}}` 解析出 `[994,101]`。**如实标注严重性：当前不可达**（`build_links_query` 生成的别名永远是 `a1..aN`），是**潜在缺陷**而非线上 bug —— 但它出现在一段**专门用于防御意外字段**的守卫里，恰好在最该生效的场景失效，且 `name` 是字符串、`as_object()` 恰好返 `None` 挡住 ⇒ **连报错都没有**。修复加 `key.len() < 2`。另发现缺失 `title`/`url` 的默认值（`unwrap_or("")` 改成 `"X"`）无测试守护，而该默认值直接进 UI。补 4 例：真实响应形状（含 `name`/`owner` 仓库字段须被跳过）/ 逐个点名守卫判据 / 9 种脏形状不 panic / 默认值回落空串。**反向验证 3/3 全捕获**
  - ⚠️ **本轮第四次「测量手段本身出错」**：`cargo test --lib parse_links` 的过滤条件**不含新用例名** `link_from_node_defaults_...`，**根本没跑**就报「存活」；改跑全量后 3/3 全捕获。至此形成四条纪律：①注入须确认生效 ②变异方向须表达真实缺陷 ③期望值须外部来源 ④**过滤条件须覆盖被测用例** —— 共同点是**先验证测量手段本身，再采信结论**
- [`docs/issue-382-browser-url-whitelist-boundary.md`](./docs/issue-382-browser-url-whitelist-boundary.md) — **断言强度审计 · Rust 侧（第三批，唯一一项**安全**边界）：`validate_browser_url` 子域边界无守护，两处「无害简化」即造成白名单逃逸**：该函数是 `open_in_browser` 命令的**唯一闸门**，而 URL 并非纯内部输入 —— 来自 issue 正文 / PR 链接 / agent session 工作目录（#370 已确认 `SessionsPanel` 走这条路）。实测 4 个变异存活，**其中 2 个是真实逃逸**：把 `ends_with(".ghe.com")` 改成 `ends_with("ghe.com")` 会放行 `evilghe.com` / `notghe.com`（任何人可注册的域），改成 `contains("ghe.com")` 还会放行 `ghe.com.attacker.net` / `a.ghe.com.evil.net`。**这是最危险的变异形态**：去掉那个点看起来只是无害简化，Linter 不报、code review 极易放过（读者会脑补「当然是指子域」），却把边界从「ghe.com 的子域」放宽成「任何含/结尾 ghe.com 的域」。另 2 个存活是大小写方向（属**失败关闭**，不放进危险域），但仍要锁定 —— **若有人为「修大写被拒」而把判据改成 `contains`，会一并放宽域匹配，从功能修复变成安全逃逸**。另验证 userinfo 逃逸向量：host 提取改取 `@` **前段**会放行 `github.com@attacker.net`，新用例成功捕获。**反向验证 4/4 + userinfo 全捕获**。KB 里另记一个变异方向教训：取 `@` **后段**也存活，但**它不该被捕获** —— 那本就是正确行为（真实 host 是后段），差点误判成「测试仍弱」
- [`docs/issue-380-status-map-table-contract.md`](./docs/issue-380-status-map-table-contract.md) — **断言强度审计 · Rust 侧（第二批）：Project Status 映射表 33/45 条目无测试守护（静默降级）**：`map_project_status` / `map_project_status_en` 是 **#335 修复的核心产出**，函数注释逐字点名了「按整值精确匹配、不做子串匹配」「不认识的返回 `None`，绝不臆造」这份契约，但**逐条 mutation 后只有 7 个条目被用例点名**（`done`/`completed`/`closed`/`released`/`ready for release`/`in review`/`in testing`），**实测 33 个条目删掉后无任何测试失败**。缺陷形态是**静默降级而非报错** —— 删掉一个条目后落 `_ => None` ⇒「保持本地手动态」，而这**本就是许多 Status 的正确表现**，故无任何异常信号。中文表尤其脆弱：现有用例 `map_project_status("🎉完成/上线")` **一个字符串同时含两个判据词**，删掉任一个另一个仍命中 —— 与 #376 `taskSig` 的「字段组断言」完全同型。修复为**表驱动**（把表搬进测试）：39 个英文条目 + 9 个中文判据词逐条锁定，**中文用例每个只命中一个判据词**；另加反向契约断言表外值须 `None`，含注释承诺的陷阱样本（`release notes` 含 `release` 但≠`ready for release`）。**表驱动的额外价值**：增删条目时**漏更新测试即编译失败**，从根上消除「改了表没改测试」这个盲区本身。**反向验证 0/33 → 33/33 全捕获**
- [`docs/issue-378-iso8601-test-coverage.md`](./docs/issue-378-iso8601-test-coverage.md) — **断言强度审计 · Rust 侧（第一批）：`iso8601_to_secs` 零测试覆盖**：该函数被 `sync.rs` / `on_demand.rs` / `github.rs` **三个生产模块调用**，含 **Gregorian 闰年算术**（`month_adjust` + 世纪年规则）与 6 项输入范围校验，却**没有任何测试** —— 唯一间接覆盖是 `sync.rs` 里一处 `> 0` 断言，无法区分「解析正确」与「解析出荒谬但为正的值」。实测 **6 个变异全部存活**（闰年规则退化为朴素 `%4`、`month_adjust` 漏 `m>2`、天数差一天、去掉 `y<1970` 守卫、月份上界放到 13、时区偏移写错），CI 全绿。风险不是「当前实现有 bug」（已用 Python `datetime` 核对，**实现是正确的**），而是**无守护**：重构即静默偏移所有 issue 时间戳一天。补 3 例，期望值**一律由 Python `datetime` 算出**（不用闭式公式自证 —— 否则测试与实现同源、同样错则同样过）。**第三例跨闰日逐日核对相邻间隔恒为 86400**，把「闰年规则」与「month_adjust」两个易错点组合验证（单点用例可能碰巧对上，连续性不会）。**反向验证 0/6 → 6/6 全捕获**。附记：实现只校验 `1..=31`、**不做逐月天数校验**，`2024-02-30` 会算出无意义但确定的值 —— 测试注释显式锁定该真实行为并声明它**不是**完整日历校验
- [`docs/issue-411-write-path-mutation-shape.md`](./docs/issue-411-write-path-mutation-shape.md) — **断言强度审计 · #215 写回路径（TaskBoard 唯一向GitHub 写入的地方）：mutation 形状断言过弱，子串匹配挡不住名字拼写错误**：审 `project_status_mutation`。现有断言是 `contains("updateProjectV2ItemFieldValue")` —— 改成 `...FieldValues`（拼写错误）**断言仍通过**。实测 8 个变异**5 个存活**：`mutation`→`query`、响应选集丢弃、`input:` 包装丢弃、mutation 名字拼错（另 3 个捕获）。**严重性如实界定为低于 #409** —— 这 5 处失效在运行期**都是响亮失败**（GitHub 直接拒绝；且 `set_project_item_status` 明确校验 `projectV2Item.id`，为空即报「GitHub 未返回确认」），**不存在静默数据损坏**
  - **仍需锁定的两条理由**：①**响应选集是查询与调用方之间的契约** —— 漏掉它则每次写回都报「GitHub 未返回确认」，**#215 整体不可用**，而该症状极具误导性（代码里的错误提示会把排查者引向 PAT 权限，不会想到是查询少选一个字段）；②本函数存在的**全部意义**就是「纯函数、可单测」，让形状错误在 CI 就暴露（#278 的立论）。修复为 1 例六层，含**反向契约「不得出现名字+多余字符的变体」**。**反向验证 7/7**
  - 💡 **方法论新增纪律 3b：名称类断言必须配反向契约** —— `contains("someName")` 只要求包含，故拼写错误（`...Value`→`...Values`）、版本后缀（`v1`→`v1Beta`）、前缀重复（`item`→`itemItem`）**全部逃逸**。与 #407 同族：**断言了「包含某物」，没断言「恰好是某物」**
  - ⚠️ **过程中一次事故**：为验证「还原是否干净」我跑了 `git checkout <file>`，**把自己的 68 行测试删掉了**（靠事先留的备份恢复）。**`git status`/`git diff --stat` 是安全的，`git checkout <file>` 是破坏性的** —— 它不区分「变异残留」与「我自己的改动」；正确顺序是**先 `git diff --stat` 看清内容再决定**
 — **断言强度审计 · Project 条目查询的字段选集几乎全无守护：漏 `pageInfo` 会让分页静默停在第 50 条**：审 `project_items_query`（#356 抽成纯函数）。**关键背景是这个函数已被同类缺陷咬过一次** —— 注释写着「⚠️ issue 分支的 `updatedAt` **不可删**…**该缺陷已真实发生过一次**」，但 #356 当时**只补了 `updatedAt` 一条断言**，其余字段选集全部无人守护。实测 **9 个变异全部存活**：漏 `pageInfo`/`hasNextPage`/`endCursor` ⇒ **分页在第 50 条停住、之后的 issue 永不出现**；`items/fieldValues/assignees/labels(first:N)` 改成 `first:0` ⇒ 各自功能静默失效；`comments{totalCount:0}`、`author{login:""}` ⇒ 评论数恒 0、作者列空白。**全部不报语法错** —— `first:0` 与 `totalCount: 0` 都是**合法 GraphQL**，请求成功、字段为空、客户端回落默认值，**无任何错误信号**
  - **修复**：1 例四层断言 —— 分页驱动 / 7 条 `(字段, 支撑什么功能)` 表驱动 / **反向契约「任何 `first:0` 都不得出现」**（语法层面唯一能拦它的手段）/ 分支结构（`updatedAt` 不得进 PullRequest 分支，**多选字段的代价是查询直接报错**而非静默降级）。**反向验证 9/9**
  - ⚠️ **纪律 2 补上「位置也要断言」**：`s.replace(old, new, 1)` 命中的是**第一处**同名片段 —— `pageInfo {{...}}` 在 1083 行与 1154 行各出现一次、**前者属于另一个函数** ⇒ 目标函数毫发无损 ⇒ 5 个变异「存活」。改为 `s.index(old, FUNC)` 后 9/9 全捕获。这比纪律 1「注入须确认生效」**更隐蔽**：注入确实生效了，只是生效在错误位置。**本系列已三次犯「变异落到错误位置」**（#380/#396 插入点 anchor、#405 空操作、#409 同名片段）
 — **断言强度审计 · GraphQL 链接查询的顶层字段选集无人断言，去掉 `number` 会让父子关系整体静默丢失**：选 `build_links_query` / `repo_level_failure` 是因为 #278 抽它们时注释就写明「GraphQL 语法错只在真实请求时才暴露，**代价高**」—— 价值全在预防性断言上。14 个变异：**10 捕获**（含 #342 缺陷本体与它注释里警告的「错用顶层 data 判据」）、**1 等价变异**（`is_null() || !is_object()` ≡ `!is_object()`，因 `Null.is_object()` 恒 false）、**2 真实存活**
  - **根因：只断言了参数、没断言字段选集** —— 原有断言只有 `q.contains("a0: issue(number: 278)")`，那是 issue 的**参数**，从未断言节点**选了什么字段**。**耐人寻味的是** `parent` 与 `subIssues` **内部**的 `number title url` 都有断言，唯独**顶层**漏了 —— 而顶层恰是 `parse_links_from_graphql` **建键的依据**
  - **后果是静默降级而非语法错**：去掉 `number` ⇒ `n.get("number")` 拿不到值 ⇒ `continue` ⇒ **父子关系整体丢失且无任何报错**；去掉 `title`/`url` ⇒ 回落空串 ⇒ 子 issue 卡片与父链接渲染成**空白文案**。与 #376 的「字段组断言」同族：**断言了容器，没断言被取用的字段**
  - 修复用**前缀断言**（`starts_with("number title url parent")`）而非解析嵌套花括号 —— 第一版用 `split_once("}")` 把 `parent { ... }` 的嵌套内容一起吃进来了（`left` 多出 7 个 token）。本仓无 GraphQL 解析器且 §2.5 不引入新依赖，故只校验前缀顺序。**反向验证 6/6**
 — **断言强度审计 · `Board.tsx` 列顺序零覆盖：回落分支的 `orderMap` 是**死代码**：选它是因为 `projectKeys` 决定**看板列顺序**、且其回落路径正是 #372 的「看板列静默错序」点。实测 5 个变异**全部存活**，两个原因都需记录：①测试只传 **1 个** status 且 `tasks={[]}`，没有任何「两列以上 + 需重排」的输入；②**更根本** —— 全仓唯一调用点 `Board.tsx:145` **不传第二个参数** `projectStatuses`，而 `orderMap` 分支（54–66 行）**只在传了该参数时可达**，主路径压根不经过这个函数（直接 `projectStatuses.map(ps => ps.name)` 取表顺序）⇒ **对 `orderIndex` 的 4 个变异天然无效**
  - ⚠️ **「签名承诺了、调用点用不上」**：`sortProjectStatusKeys(keys, projectStatuses?)` 承诺可按 `orderIndex` 排序，但该能力**实际不可用**。可能是有意备用、也可能是重构残留 —— **属产品判断，本次不改代码**，KB 里给出两个选项（保留则注释写明是备用路径 / 清理则删第二参数与死分支，回落行为不变）
  - **与盲区 E 类（#400）的区别**：E 类是不可达因**测试数据**构造不出，本项是**被测代码本身**有一段不执行。判别方法相同（删掉看是否全绿）但结论不同 —— 本项需要「记录 + 产品判断」而非补断言
  - 💡 **补测试 → 再 mutation → 发现新缺口，两次迭代才收敛**：补完 3 例后重验，发现**两个我自己也没覆盖的存活变异**（主路径漏 `done` 列、回落不过滤空列）⇒ 又补 2 例。**断言写完不等于有效，仍要用 mutation 验收新测试本身**（呼应 #376）。另踩一坑：合成列列头走 **i18n**（`已完成` / `未标注`）而非内部 key，第一版按 `/done/i` 匹配失败，被断言消息里的实际列序点出来才发现 —— **断言渲染结果须按渲染文案写**
 — **断言强度审计 · 悬空项收尾：legacy 判据可证明**永不决定**（强等价变异，无代码变更）**：#402 标注了「未能构造的窄场景」，本 issue 收尾。**探针迭代 4 次**：①手工造表→`open_db` 失败 ②从真实库改名 `issue_key`→**探针无效** ③补 6 列但漏建 1 个索引名 ④补齐 6 列 + **8 个索引名全建**（已是能构造的最窄状态）⇒ **两侧仍相同**。此时正确结论不是「守卫无用」，而是**转向可构造性分析**。**决定性结构事实**：`open_db` 里 `schema_is_current` 在 **427 行**求值、`execute_batch(SCHEMA)` 在 **438 行** —— **探测发生在建表之前**；而 `SCHEMA` 的 `tasks` 是现代布局、**没有 `key` 列**。故要让它成为决定性因素需「全现代结构 + 遗留 `key`」，而 `tasks` 拿到现代结构只有 `SCHEMA` 与 `migrate_tasks_v2_rebuild` 两条途径，**两者都不创建 `key`** ⇒ **对任何迁移流程可达的状态，它都不是决定性因素**。**结论：不建议删掉它** —— 廉价纵深防御、符合代码注释声明的「兜底」定位、删除无收益
  - 💡 **方法论真正的产出：等价变异也有强弱之分**。**弱等价**（「我试了几个状态都没差异」）**不足以下结论**；**强等价**（代码路径分析 + **可达性论证**，任何**可达**状态都等价）才可下结论。并沉淀**存活变异的完整排查路径**：①变异方向对吗 ②能构造出差异状态吗 ③有第二个等价守卫吗 ④该状态可达吗 —— 四步全过才判定为等价。**连续 N 次换构造仍无差异时，别再换构造 —— 该问「这个状态可达吗？」**
 — **断言强度审计 · 悬空项落实：`schema_is_current` 的 legacy 判据是**冗余守卫**，删掉不改变行为（无代码变更）**：#400 审计时我把变异 ⑤「`schema_is_current` 去掉 `!tasks_uses_legacy_key`」标注为「推测未实测」，**推测必须落实** —— 留着不验证就是给审计留一个未验证的断言。核对后发现**我原先的推测是错的**：`REQUIRED_COLUMNS` 实际**不含** `issue_key`。但用 `legacy_tasks_db` 的真实 DDL 造库探针实测后，结论是**变异为等价变异** —— `missing_columns` 对真实 pre-#155 表必然非空 ⇒ **同样**强制 `needs_migration = true`；且 `run_migrations` 里**独立地**再检查一次 `tasks_uses_legacy_key`。**同一条件被检查两次，删掉一次不改变行为** —— 这类冗余本身是好事（纵深防御），mutation 存活正是它的表现
  - ⚠️ **探针本身也要先验证**：第二次探针我从真实库把 `issue_key` 改名成 `key`，结果两侧仍相同，**我差点据此判「守卫无用」** —— 但那个构造**不是真正的 legacy 布局**（缺 `gh_state`/`updated_at TEXT`）⇒ 重建 `INSERT..SELECT` 读不到列 ⇒ 两种情况都停在坏状态 ⇒ **看起来等价，实为探针无效**。改用真实 DDL 才得到有效数据。**「两种情况结果相同」有两种可能：真的等价，或探针没测到差异；判别办法是换一个更接近真实的构造再看**
  - **如实记录一个未能构造的窄场景**：守卫真正不可替代的情形是「`key` 仍在但 6 个 `REQUIRED_COLUMNS` 已补齐且索引齐全」，我未能构造（需在 legacy 表上建引用 `issue_key` 的索引，会报 `no such column`）。故**既不能断言必要、也不能断言多余**，建议作后续独立任务
- [`docs/issue-400-agent-groups-helper-coupling.md`](./docs/issue-400-agent-groups-helper-coupling.md) — **断言强度审计 · `agent-groups`：测试辅助函数把 `present` 耦合到 `kind`，使 `!info.present` 守卫永远走不到（新盲区类型 E）**：审计 14 个变异，**13 个捕获良好**（`groupOf` 全部 6 分支、`newlyRemoved` 优先级、`summarize` 三项、`GROUP_ORDER` 顺序、`deviceDetail` 拼接顺序 —— 这套测试质量很高），**唯一存活的那个暴露了一个测试设计缺陷**：辅助函数 `host(agent, kind)` 写成 `present: kind !== 'none'`，于是 `present === false` **必然蕴含** `kind === 'none'` ⇒ 删掉 `deviceStateOf` 里的 `!info.present` 守卫后行为完全一致 ⇒ **mutation 存活**。但 `types.ts` 里 `present` 与 `kind` 是**两个独立字段、类型系统不强制一致**，「`present === false` 但 `kind` 非 none」是**类型允许的输入**，而守卫存在的意义正是处理它（扫描端一旦报出这种组合，界面会把**并未安装**的 agent 显示成「已安装」）。**契约在代码里不在类型里，而测试辅助函数替生产代码把这个不变量补上了**
  - **新增盲区类型 E 类**（原有 A 枚举不全 / B 匹配形式单一 / C 解析子集太窄 / D 只守正向都不覆盖）：**测试辅助函数补上了生产代码没有的不变量，使某个分支在测试数据里不可构造**。与 #399（模块根本没在测试环境跑）同属「代码路径没走到」但**根因不同**：#399 是**环境**缺打桩，本项是**测试数据的构造方式**排除掉了分支。**教训：辅助函数越「方便」，它替生产代码做的假设就越多** —— 写 `host(agent, kind)` 这类糖时要问「它有没有把两个本应独立的字段绑在一起」
  - ⚠️ **测量错误的新变体**：`npx tsc --noEmit 2>&1 | tail -1 && echo "tsc 干净"` —— **`tail` 的退出码覆盖了 `tsc` 的**，我在实际报 TS2739 时输出了「tsc 干净」。改为 `(npx tsc --noEmit >/dev/null 2>&1); echo $?` 后暴露并修掉两处类型错误。**「判结果只用退出码」不仅适用于测试失败，「检查是否通过」本身也必须看退出码** —— 中间插一个管道信号就丢了
- [`docs/issue-399-theme-moduleload-untestable.md`](./docs/issue-399-theme-moduleload-untestable.md) — **断言强度审计 · `theme.ts`：模块加载期的逻辑**结构上不可测**，删掉整段仍全绿**：按方法论文档流程续审，选它的理由是**缺陷史** —— #343 在这里找到过真实 bug（`matchMedia` 每次返回新对象 ⇒ 解绑恒 no-op），有缺陷史的模块值得复查。审计 8 个目标，**#343 / #329 本体均被捕获**（回归良好），但发现 `theme.test.ts` 顶层 `import './theme'` 让**模块体在 `beforeEach` 的 `stubEnv()` 之前就执行一次** ⇒ `window` / `localStorage` 不存在 ⇒ 模块尾部的 `applyTheme(storedTheme)`（防 FOUC）与 `if (storedTheme === 'auto') bindSystemThemeListener()`（首屏跟随系统）被 `try/catch` **静默吞掉**。**后果实测：把后一行整段删掉，`theme.test.ts` 全绿** —— 即「首屏 auto 模式下系统主题变化不再跟随应用」这个用户可见缺陷**当前无任何测试能发现**，而它正落在 #329 / #343 这条反复出问题的时间线上
  - ⚠️ **「有测试」不等于「测到了」** —— 该文件有 7 例 29 行断言、覆盖 `setMode`/`bind`/`unbind`/`resolveTheme` 都很好，但那段代码**在测试环境里从未执行过**。测试量与覆盖范围是两回事
  - **解法**：`vi.resetModules()` + **动态 `import()`**，让打桩**先于**模块体建立（vitest 内置，§2.5 不引入新依赖）。补 4 例：`stored=auto` 须恰好注册 1 个监听（**不多不少**）/ `stored=light/dark` **不绑定**（#329 核心不变量）/ 缺失与抛错**回落 auto**（回落值本身即契约）/ 模块加载期写 `data-theme`（防 FOUC）。配套加 `stubEnvWithStored(stored)` —— 原 `stubEnv` 恒返回 `'auto'`，只适合测 `setMode` 路径
  - **反向对照**：与「不绑定」**方向相反**的「恒绑定」（显式 light/dark 也绑 ⇒ #329 被改坏）**也被捕获** —— 双向都验才知道断言方向没反（纪律 2 的实践）
  - **方法论定位**：纪律 4「信号覆盖被测对象」的**新形态** —— 之前 #384 是「`vitest run <file>` 过滤条件不含用例名」，本项是「**模块根本没在测试环境里跑**」。共同点：**信号（测试通过）覆盖了对象，但没覆盖对象在该环境下的实际行为**；检测手段同为纪律 1 的「删掉整段看是否全绿」
- [`docs/methodology-assertion-strength-audit.md`](./docs/methodology-assertion-strength-audit.md) — **断言强度审计方法论（11 项审计的沉淀，任何人接手审计前先读）**：核心结论是**断言强度靠读代码判断极易出错** —— #376 的表驱动用例读起来完全合理，只有 mutation 才暴露它漏守 8 个字段。沉淀五条纪律（注入确认生效 / 变异方向与位置 / 期望值外部来源 / 信号覆盖被测对象 / **判结果只用退出码**）、**四类盲区**归纳（枚举覆盖不全 / 匹配形式单一 / 解析语法子集太窄 / **只守正向不守反向**）、**等价变异判别清单**（7 条已确认的「存活但不该捕获」，勿重复排查）与可复用流程。⚠️ 文档里也记了**我自己犯过的十余次「测量手段本身出错」**，因为**方法的失效方式比方法本身更值得沉淀**
  - 💡 **11 项里只有 3 项是真实的代码缺陷**（#376 漏字段 · #384 空洞为真 · #388 负时间戳），另有 **3 项是守卫自身有盲区**（#390/#392/#394）、**5 项仅缺守护**（#378/#380/#382/#386/#396）。这个分布本身说明：**测试的主要作用不是抓 bug，是把隐含契约显式化**
- [`docs/issue-376-tasksig-field-contract-test.md`](./docs/issue-376-tasksig-field-contract-test.md) — **断言强度审计 · 契约字段清单无人守护**：对 `taskSig.ts` 逐字段 mutation（每次删一个字段跑测试），**15 个字段中 8 个删掉后无任何测试失败** —— 含两处**真实 bug**：漏 `updatedAt` ⇒ issue 被评论后卡片日期不刷新；漏 `workDir` ⇒ agent 设的工作目录不刷新（后者正是 #287 引入该字段要解决的问题）。根因是测试按**字段组**断言（session 三件套一次改三个 ⇒ 删掉任意一个仍会变指纹），而 `taskSig.ts` 注释逐个点名了「必须纳入哪些字段」这份**显式契约**却无人守。修复为表驱动测试 + 一条反向契约（不在签名里的字段须不改变指纹，防契约漂移）。**方法论**：断言强度靠读代码判断极易出错 —— 这条用例读起来完全合理，只有 mutation 才暴露问题
- [`docs/issue-374-boardmode-change-no-error-handling.md`](./docs/issue-374-boardmode-change-no-error-handling.md) — **深度 review 第三批 · 乐观更新无回滚，UI 与后端状态分叉**：切换看板列模式时 `setBoardMode(mode)` 先乐观更新、`await setAccountBoardMode` 无 `try/catch` ⇒ 保存失败时 `<select>` 仍显示新值（看起来成功）、刷新后跳回旧值，且**无任何提示**。原因是 `AccountCard` 自身没有错误状态（外层 `SettingsPanel` 的 `err` 它取不到），而同文件 `saveSettings` / `saveColumns` 等路径都有出口 —— **只有这一条漏了**。修复补 `catch` + **回滚 `prev`** + `reportError`。测试特意覆盖「加了 `try/catch` 但没回滚」的**半修状态**
- [`docs/issue-372-aggregate-load-silent-failure.md`](./docs/issue-372-aggregate-load-silent-failure.md) — **深度 review 第三批 · 看板列静默错序 / 静默退回 project 模式**：聚合视图（全部账号）下 `listProjectStatuses` / `listAccountColumns` 的单账号失败只落 `console.warn` ⇒ `projectStatuses` 为空使 `sortProjectStatusKeys` 退化为**字母序**；`accountColumns` 为空使 `resolveBoardView` 从 `'custom'` **整体退回 `'project'`** —— 后者比 `bug-audit-2026-09` P2-#7 记录的更严重（审计漏了第二处）。改为 `reportError` 上抛（与 #370 `openExternal` 同源同解），保留 #145「单账号失败不断整板」的隔离语义。附**历史审计逐条复核结论**（P0-#5/P0-#6 已修或已不成立，审计文档部分过期）
- [`docs/issue-370-sessions-panel-open-browser.md`](./docs/issue-370-sessions-panel-open-browser.md) — **深度 review 第三批 · 打开失败时界面静默无提示**：`void api.openInBrowser(...)` **只丢弃 Promise、不吞 rejection**，而 `api.ts` 早有收口好的 `openExternal`（内部 `.catch(reportError)`）—— `SessionsPanel` 是全仓 6 个组件里**唯一**绕过它的漏网之处。可达性非理论：`validate_browser_url` 仅放行 `github.com`/`*.ghe.com`、`spawn()` 亦可能失败。`docs/bug-audit-2026-09.md` 的 **P0-#11 早已记录该模式**，#329 完成封装并替换 5 处却漏了这一处 —— **「只改了一半」模式的第四次实例**（#339 `TaskCard`、#345 MCP 分帧、#357 `get_opt`、#370）。测试把「封装 + 全部替换」变成可机械校验的不变量，并**额外锁定 `openExternal` 自身必须带 `.catch`**（否则收口形同虚设而第 1 条断言仍全绿）
- [`docs/issue-367-static-guard-self-diagnosis.md`](./docs/issue-367-static-guard-self-diagnosis.md) — **静态守卫自诊断加固 + 全仓静态断言审计**：#355 修掉失效守卫后留下的新脆弱点 —— `take_while("mod tests {")` 依赖「该文件只有唯一测试模块」这一未被守护的前提，模块改名/拆分后截断点消失 ⇒ 静默退化成修复前的失效状态。改用 `#[cfg(test)]` 作截断点并补「失去意义」守卫（范式取自 `lint-config.test.ts`）。**按实测更正了问题判断**：新守卫的价值不在「能否失败」（两种实现都能失败），而在「计数失去意义时报错是否自诊断」。附**全仓 6 处静态断言的反向验证审计**（`panel-wiring` / `styles` / `lint-config` / `about-window` / `notes-layout`），逐个注入缺陷形态确认如期失败 —— 均真正承重，无同类失效
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


# Issue 177 — Claude Code 开始任务时自动记录 session/分支并更新单任务看板

## 背景 / 动机

Claude Code 在本仓库开始处理某 issue 时，经常出现：

1. 没有把 `session_id` 和当前工作分支写到该 task（`session_id / session_agent / work_branch` 为空）；
2. 没有把单一 task 看板置为「处理中」（需手动调 MCP 才生效）。

对应 GitHub issue：[#177](https://github.com/ShawnLiuSZ/task-dashboard/issues/177)。

根因（4 条）：

1. 只有 prompt 层约定（`CLAUDE.md` + `mcp_server/AGENT_INSTRUCTIONS.md`），无项目级确定性触发，LLM 易遗忘；
2. `session_id` 来源未定义（"会话标识 / tmux / 分支名等"），Claude Code 侧无确定取值；
3. 分支示例用了 `branch="$(git ...)"` 的 shell 替换写法，MCP 参数不执行 shell，实际写入字面量或被跳过；
4. 仓库无 `.claude/` 目录，项目级 hooks/commands 无处加载。

## 设计 / 方案

分工原则：**hooks 只注入上下文、不写 DB；写库仍由 agent 经 MCP 工具完成**。
- `SessionStart` hook（`.claude/hooks/taskboard-session-start.sh`）：读 stdin JSON 的 `session_id`，经 `$CLAUDE_ENV_FILE` 持久化为 `$TASKBOARD_SESSION_ID`，并经 `hookSpecificOutput.additionalContext` 注入"本次会话 id + 开工三步 + 分支两步取法 + `/task-start` 快捷方式"。SessionStart 在 MCP 连上之前触发，故不调 MCP。
- `UserPromptSubmit` hook（`.claude/hooks/taskboard-prompt-reminder.sh`）：仅当 prompt 匹配 `repo#num` / `owner/repo#num` / GitHub issue|pull URL 时注入一句提醒，其余静默退出，避免噪音。
- Slash commands（`.claude/commands/task-start|task-done|task-handoff.md`）：显式一键命令。`task-start` 强制顺序：Bash 取分支 → `get_task_status` → `update_task_status(处理中)` → `record_session(session_id=${CLAUDE_SESSION_ID}, agent=claude-code, branch=<Bash 输出>)`。
- 文档修正：`AGENT_INSTRUCTIONS.md`（中/英）session 来源改为 hook 注入优先级，分支改为"先 Bash 后传值、禁 `$(...)`"；`CLAUDE.md` 增加 hooks + slash 小节；`README.md` 的 `record_session` 行补 `branch?` 并提 `.claude/`。
- 零新依赖：hooks 只用 `bash + python3（stdlib）`，不用 `jq`；`settings.json` 用 `${CLAUDE_PROJECT_DIR}` 相对路径，跨机器可提交。

### opencode 原生适配（与 `.claude/` 同构，opencode 1.18 实测）

opencode 的两套项目级机制正好对应 Claude 侧设计：

- `opencode.json` 注册 `taskboard` MCP（`python3 mcp_server/server.py`，跨平台、免装 app，相对路径经 `opencode mcp list` 实测可解析）。
- `.opencode/plugins/taskboard.js`（零依赖）：`session.created` 记住会话 id（多路径兼容提取）；`tool.execute.before` 在 `record_session`（按 `(^|_)record_session$` 后缀匹配，兼容用户改 server 名）缺参时自动填 `session_id`（真实 id，覆盖编造值）/ `agent=opencode` / `branch`（`git -C <directory> branch --show-current`，取不到不写）；`shell.env` 注入 `TASKBOARD_SESSION_ID`。只补参、不写库（与 Claude 侧一致的不变量）。
- `.opencode/commands/task-start|task-done|task-handoff.md`：opencode frontmatter（仅 `description`，不支持 `allowed-tools`——已省略）；分支用 `!`git branch --show-current`` 原生注入；命令正文明确"session 相关参数由插件填充，不要编造"。

自测（opencode 1.18.23 本机，不动真库，均通过）：

- `node --check` 插件语法；node 仿真 hook 5 断言（会话捕获 / 三参补齐 / 不误伤 bash / shell.env / 异形 payload）。
- `opencode mcp list` → `taskboard connected`；`opencode debug config` → 本地插件 + `mcp.taskboard` 均被发现。
- 临时库全链路：`get → update(处理中) → record_session → DB=(doing, ses-opencode-1, opencode, feature/…)`，与预期逐字一致。
- 未覆盖（需 TUI + 模型调用）：`/task-start` 端到端、`tool.execute.before` 真实触发。列为手动验收。

> 坑：全局 `~/.gitignore_global` §37/§40 忽略了 `.opencode/*` 与 `opencode.json`（防个人配置入库），导致本分支新文件 `git status` 不可见。已按仓库既有 `!AGENTS.md` 先例在根 `.gitignore` 加 `!opencode.json` / `!.opencode/` / `!.opencode/**` 显式收回（`.claude/` 不受全局规则影响，无需处理）。

### App 内一键安装/卸载（本仓库自用 `.claude/` 之外的第二层，后扩展为全局）

仓库根的 `.claude/` 只解决"在本仓库干活"的 agent；用户在其他仓库（如 fad-backend）干活时，agent 读的是**那个仓库**的配置。因此 App 内置安装器（`app/src-tauri/src/hooks.rs`，模板 `include_str!` 内嵌、单一来源）：

- 项目级：写 `<repo>/.claude/**`（hooks/commands + `settings.json` 合并）与 `<repo>/.opencode/**`（插件/commands + `opencode.json` 的 `mcp.taskboard` 合并，command 指向本 app 二进制 `mcp` 子命令——任意仓库可用，不依赖相对路径的 `server.py`）。
- 全局：写 `~/.claude/**` 与 `~/.config/opencode/{plugins,commands}/`；opencode 全局 MCP 因 jsonc 含注释**只检测不自动合并**，缺失时给出手动步骤。
- 合并语义：保留用户既有配置，去重后追加（去重键：hook 命令后缀 / MCP 命令 basename——dev 与正式版二进制路径不同，原位更新）；卸载只删内容与模板一致的文件，改动配置文件前留 `.taskboard-bak`（仅首份）。

### 全局安装与参考实现（clawd-on-desk）

参考 [clawd-on-desk](https://github.com/rullerzhou-afk/clawd-on-desk) 的做法（`Settings → Agents` + per-agent 安装脚本），本 App 同样：

- agent 注册表（`AGENTS`）：claude（`~/.claude` + `settings.json`）/ opencode（`~/.config/opencode`，插件目录自动扫描、无需改配置）——新增 agent 只需加一行注册 + 模板。
- host 未安装则跳过（全局配置目录不存在 → `<agent>-not-found`，不污染用户机器）。
- 启动时自动注册全局默认集（claude + opencode，缺失才装、best-effort；对应 clawd 的 fresh-install auto-sync）。
- 原子写（tmp + rename）+ 卸载备份（对应其 `writeJsonAtomic(WithBackup)`）。
- 与其不同的两点：opencode 插件走目录自动扫描（1.18 实测全局/项目均可，无需写 `plugin` 数组——其旧版本备注已过时）；卸载是正式功能（其 roadmap 才计划）。

与已有模块的关系：不改 DB schema、不改 Rust/Python MCP 实现（`SELECT_COLS`、SQL 均不动），只补"触发层"。

## 接口 / 行为变更

- 新增 `.claude/settings.json`（`SessionStart` + `UserPromptSubmit`，`timeout: 10`）。
- 新增 `.claude/hooks/taskboard-session-start.sh`、`taskboard-prompt-reminder.sh`（可执行）。
- 新增 `.claude/commands/task-start.md`、`task-done.md`、`task-handoff.md`（`$ARGUMENTS` / `${CLAUDE_SESSION_ID}` 占位）。
- 新增 Tauri commands `install_agent_hooks` / `uninstall_agent_hooks` / `get_agent_hooks_status`（`scope=project|global` × `agents⊆{claude,opencode}`）+ 前端透传 + 设置面板 "agents" tab（作用域切换 + agent 多选 + per-agent 打勾 + notices）。
- 卸载语义：只删内容与模板一致的文件（用户改过的保留并上报 `files_kept`）；配置文件改动前留 `.taskboard-bak`（仅首份）；`settings.json` / `opencode.json` 只摘除 ours、自有配置保留，摘空则删文件；删空的子目录顺手移除。
- MCP 工具无变更；`AGENT_INSTRUCTIONS.md`（中/英）示例的 `branch="$(...)"` 改为 `<Bash 输出>` 两步写法，`session_id` 改为 `${CLAUDE_SESSION_ID}`。
- 其余 UI / 同步逻辑无变更。

## 数据 / Schema 变更

无。本次不碰 `tasks` 表；`work_branch` 复用 #171 列。

## 测试 / 验收

已跑：

- `echo '{"session_id":"abc123"}' | .claude/hooks/taskboard-session-start.sh` → 输出含 `abc123` 的 `additionalContext` JSON；`CLAUDE_ENV_FILE` 指向临时文件时追加 `TASKBOARD_SESSION_ID=abc123`。
- `echo '{"prompt":"看看 dashboard#177"}' | .claude/hooks/taskboard-prompt-reminder.sh` → 输出提醒 JSON；`echo '{"prompt":"hello"}' | ...` → 无输出、exit 0。
- `python3 -m py_compile mcp_server/server.py` 通过（文档-only，未改 py）。
- 后端：`cargo test --lib` 49 通过（含 `hooks::tests` 13 例：双 agent 幂等 / 跳过未安装 host / 全局绝对路径命令 / 全局合并保留+注释保留 / workbuddy 新旧路径 / trae-codebuddy hooks.json / 手动指引 / 脚本变体回退 / MCP 原位更新与保留 / 卸载全清 / 请求校验）；`cargo check` 零新增 warning。
- 前端：`npx tsc --noEmit` 通过；`npm test` 25 通过；`npm run i18n:check` 通过（266 key/边）。
- `scripts/check-mcp-columns.py` 通过（24 列一致；本次未改 schema）。
- 真机全局自测（本机，`tauri dev` 启动自动注册触发）：`~/.claude/settings.json` 原有 clawd hooks 全保留、ours 追加（SessionStart/UserPromptSubmit 各 +1）；`~/.config/opencode/{plugins,commands}/` 落盘；`opencode.jsonc` 注释原样保留且仅收到手动注册 MCP 的 notice。

### session 下拉全量接入（5 家一键 + 其余手动指引）

任务详情 session 下拉的 39 个 agent（`app/src/agents.ts`，DetailPanel 与 SettingsPanel 共用、单一来源）全部可在 Agent 接入页选中：

- 一键安装（hook 机制已验证，与 clawd-on-desk 逐项对过配置格式）：`claude-code` / `opencode` / `workbuddy`（`~/.workbuddy-ai` 优先、legacy 仅 settings.json 佐证时用）/ `codebuddy` / `trae`（`~/.trae-cn/hooks.json`）。workbuddy/codebuddy/trae 与 Claude 同构的 settings 合并逻辑，脚本用通用变体（去 `${CLAUDE_SESSION_ID}` 与 `/task-start` 引用，模板精确替换、漂移回退，单测覆盖）。
- 其余 34 个：选中后安装/卸载/状态返回手动指引 notice（codex/cursor/copilot/gemini/qwen/kimi/zcode 含配置路径，其余指向 `AGENT_INSTRUCTIONS.md`），不伪造成功。
- 另修全局安装 bug：此前全局 `settings.json` 的 hook 命令误用 `${CLAUDE_PROJECT_DIR}` 前缀（全局无意义），现项目级用变量、全局用配置根绝对路径（整体加引号），旧条目按后缀去重自动迁移。

## MCP 存废决策（#177 讨论结论：保留）

MCP 是**能力层**（读写看板的工具），hooks 是**触发层**（何时调用）。#177 的故障全在触发层，MCP 本体经 #169/#173/#175 修复后健康（本分支校验 24 列一致通过）。因此：

- 保留 MCP：无 hook 能力的 agent（cursor/helix 等）仍靠 `AGENT_INSTRUCTIONS.md` + MCP 手工调用；记事本工具、任务查询也依赖它。
- hooks 不自写 SQLite（保持"写库只走 MCP/SQL 公共模块"的不变量），避免第三条写路径。
- 若将来 MCP 长期修不好，备选才是 hooks 直写 SQLite（python3 内嵌 SQL），届时 MCP 可降级为可选；不在本 issue 执行。

验收标准：

1. 新会话启动后 agent 能说出自己的 session id（来自 hook 上下文 / `${CLAUDE_SESSION_ID}`）；
2. `/task-start <repo#num>` 一次完成"处理中 + session + 分支"三写入；
3. prompt 提到 issue 时有轻提醒，普通闲聊无打扰；
4. `branch` 列不再出现 `$(git` 字面量。

## 相关链接

- Issue：[#177](https://github.com/ShawnLiuSZ/task-dashboard/issues/177)
- 分支：`feature/issue-177-claude-session-hooks`
- 前置设计：[`docs/issue-171-record-session-branch.md`](./issue-171-record-session-branch.md)（`work_branch` 分离）、[`mcp_server/AGENT_INSTRUCTIONS.md`](../mcp_server/AGENT_INSTRUCTIONS.md) §2
- CHANGELOG：待发版时在 `docs/CHANGELOG.md` 对应版本下追加指向本文档的链接

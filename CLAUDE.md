# CLAUDE.md — TaskBoard 项目（Claude Code 入口）

> Claude Code 在本仓库工作时加载本文件。**项目身份 / 硬约束 / 仓库结构 / KB 文档 / 分支 PR / 构建命令**等统一规则见 [`AGENTS.md`](./AGENTS.md)；本文件**仅承载 Claude Code 特有的看板自动维护约定**。

---

## 加载顺序（必读）

1. **共享规则** → [`AGENTS.md`](./AGENTS.md)
2. **MCP 工具契约与触发规则** → [`mcp_server/AGENT_INSTRUCTIONS.md`](./mcp_server/AGENT_INSTRUCTIONS.md)
3. **代码生成与文件风格**（与 GitHub Copilot 共用，可选）→ [`.github/copilot.instruction.md`](./.github/copilot.instruction.md)
4. **本文件特有部分**：下方「自动维护看板」

> 遇到冲突：**AGENTS.md > 本文件 > 用户口头指示**。

---

## 自动维护看板（Claude Code 特有约定）

本项目提供 TaskBoard MCP Server。v0.3.12 起 **MCP 已内置进 TaskBoard.app 二进制**（`taskboard mcp` 子命令，无 Python 依赖），已在 WorkBuddy 接入，命令见 `~/.workbuddy/mcp.json` 的 `taskboard` 项（`/Applications/TaskBoard.app/Contents/MacOS/taskboard` + `args:["mcp"]`）。未装 app 的便携场景才用兜底的 `mcp_server/server.py`。

当你处理本仓库相关的 GitHub issue 时，请按
[`mcp_server/AGENT_INSTRUCTIONS.md`](./mcp_server/AGENT_INSTRUCTIONS.md) 的触发规则，
通过 MCP 工具 **自动**把状态 / 会话 / 交接记录写回本地看板。

**MCP 工具速记表**见 [`AGENTS.md §7`](./AGENTS.md)（6 个工具：`update_task_status` / `get_task_status` / `record_session` / `record_handoff` / `clear_session` / `list_my_tasks`）。Claude Code 调用时 `<agent-name>` 固定传 `"claude-code"`，便于多 agent 写入时区分。

### 项目级自动维护（#177：hooks + slash commands）

本仓库已内置 `.claude/settings.json`（随仓库提交，克隆即生效）：

- `SessionStart` hook（`.claude/hooks/taskboard-session-start.sh`）：把本次 `session_id` 注入上下文并写入 `$TASKBOARD_SESSION_ID`；slash command 里也可用 `${CLAUDE_SESSION_ID}`。**session_id 优先用它，不要编造、不要用分支名冒充**。
- `UserPromptSubmit` hook（`.claude/hooks/taskboard-prompt-reminder.sh`）：仅当 prompt 疑似提到某 issue（`repo#num` / GitHub URL）时提醒查板开工，其余时间静默。
- Hooks 只注入上下文、**不写 DB**；真正的写库仍由你调 MCP 工具完成。

快捷命令（显式触发，推荐）：

- `/task-start <repo#num>` —— 查现状 → 置「处理中」→ `record_session`（含分支）。分支必须先用 Bash 跑 `git branch --show-current` 取到再传值，**禁止把 `$(...)` 塞进 MCP 参数**。
- `/task-done <repo#num>` —— 置「已完成」+ `clear_session`。
- `/task-handoff <repo#num> <交接详情>` —— 写 `handoff` 并保留可恢复会话。

也就是说：开始处理某 issue 时不要只改代码，先 `/task-start`（或等价的两步 MCP 调用）；做完 `/task-done`。详见 slash command 文件与 [`mcp_server/AGENT_INSTRUCTIONS.md`](./mcp_server/AGENT_INSTRUCTIONS.md) §2。

`issue` 支持 `repo#number` / `owner/repo#number` / GitHub URL 三种写法。
**只写本地看板，绝不调用 GitHub API、绝不改 Issue / Project / label / 评论。**

---

## 工作流程规范

### PR 创建前必须完成的事项

在创建 PR 之前，必须确保以下内容已全部完成并提交：

1. **代码实现**（功能代码、测试等）
2. **知识库文档**（`docs/issue-<num>-<topic>.md`）
3. **CHANGELOG 更新**（如适用）

**正确流程：**
```
写代码 → 写知识库文档 → 一起提交推送 → 再创建 PR
```

**错误流程：**
```
写代码 → 提交推送 → 创建 PR → 再补文档 → 再提交推送
```

违反此规范会导致：
- PR 描述不完整
- 需要多次提交推送
- 审查者看不到完整上下文

---

> 本文件由项目维护者维护。如发现本指令与 `AGENTS.md` / `AGENT_INSTRUCTIONS.md` 不一致，**以 `AGENTS.md` 为准**，并提交 PR 修复。
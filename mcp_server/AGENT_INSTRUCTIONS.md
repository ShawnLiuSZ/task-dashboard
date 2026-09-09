# TaskBoard MCP — Agent 自动维护看板指令

> **中文**
>
> English version see [AGENT_INSTRUCTIONS.en.md](./AGENT_INSTRUCTIONS.en.md)

本文件是一份**可直接喂给任意 coding agent**（claude-code / codex / opencode / zcode / helix / cursor / doubao …）的指令规范。
只要该 agent 已接入 `taskboard` MCP Server（见仓库 `README.md` 的「MCP Server」一节），它就能在**不写回 GitHub** 的前提下，
自动把任务状态、中断会话、交接详情记录到本地 TaskBoard 看板。

> 硬约束：**只写本地 SQLite，绝不调用 GitHub API、绝不改 Issue / Project / label / 评论**。本看板对 GitHub 零副作用。

---

## 0. 接入（一次性，已接入可跳过）

MCP Server 已在 WorkBuddy 的 `~/.workbuddy/mcp.json` 注册为 `taskboard`。
**首选形态（v0.3.12 起）**：装了 TaskBoard.app 后，MCP 已内置在 app 二进制里，直接用 `taskboard mcp` 子命令即可，无需独立文件夹 / Python：

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

> 路径说明：上为默认安装位置；装到别处把 `command` 改成实际 `TaskBoard.app/Contents/MacOS/taskboard` 绝对路径。**未装 app 的便携 / 开发场景**用兜底：`"command": "python3", "args": ["/path/to/mcp_server/server.py"]`。

---

## 1. 可用工具

| 工具 | 入参 | 作用 |
|---|---|---|
| `list_my_tasks` | `status?` / `ownership?` | 列出看板任务（可按四态 / 归属过滤） |
| `get_task_status` | `issue` | 查某任务当前状态 + 已记录的 session / handoff |
| `update_task_status` | `issue`, `status` | 改本地看板状态 |
| `record_session` | `issue`, `session_id`, `agent?`, `branch?` | 记录中断会话 id；`branch` 非空则一并记录当前工作分支（写 `work_branch`，与同步的 PR `branch` 分离） |
| `record_handoff` | `issue`, `text` | 记录「交接任务」详情 |
| `clear_session` | `issue` | 任务完成后清空 session 字段（保留审计） |

### issue 引用格式（任选其一，自动归一化）
- `repo#number` — 例：`fad-backend#1247`
- `owner/repo#number` — 例：`FoodsUp-Inc/fad-backend#1247`
- GitHub URL — 例：`https://github.com/FoodsUp-Inc/fad-backend/issues/1247`

### 状态枚举（`update_task_status` 的 `status`）
- 英文键：`todo` / `doing` / `processed` / `done`
- 中文等价：`待处理` / `处理中` / `已处理` / `已完成`

---

## 2. 触发时机 → 动作（核心规则）

| 时机 | 动作 |
|---|---|
| **开始处理**某个 issue（用户派活 / 你认领 / 你开始改它） | `update_task_status(issue, "处理中")` + `record_session(issue, <当前会话 id>, "<agent 名>", branch=<当前工作分支>)` |
| **中途停止 / 会话中断 / 你要切到别的任务** | `record_session(issue, <当前会话 id>, "<你的 agent 名>")` |
| 用户说「**生成交接任务**」「交接一下」「handoff」之类 | `record_handoff(issue, "<已做/未做/卡点/如何恢复>")`；如需保留可恢复会话，同时 `record_session` |
| **任务完成**（你确认做完、要收尾） | `update_task_status(issue, "已完成")` + `clear_session(issue)` |
| 想了解某任务现状 / 恢复上下文 | `get_task_status(issue)` |
| 想看任务清单（如只看「无人认领」） | `list_my_tasks(ownership="notassignee")` |

### 会话 id / 分支来源（重要）
`session_id` **由调用方自行提供**，无统一来源（多 agent 并行时单一来源会失效）：
- claude-code：可用当前会话标识 / tmux 会话 / 工作分支名等可恢复标识
- codex / opencode / zcode / helix：各自取本会话的可恢复 id
- **务必带 `agent` 参数**（`claude-code` / `codex` / `opencode` / `zcode` / `helix` …），便于多进程区分谁记的

`branch` **也由调用方提供**：用 `git -C <该 issue 对应项目目录> branch --show-current` 取当前工作分支，
**取不到就传空**（没在 git 仓库 / 无分支时不要硬塞脏数据）。写入独立 `work_branch` 列，与同步自动拉的 PR `branch` 分离——同步不会覆盖它。

### 中断时状态如何保持
中断后**保持「处理中」**（不要回退到「待处理」）——回退会丢失「该任务已有半成品」的信号，而这正是 session id 存在的意义；下次恢复时显式再转「处理中」即可。

---

## 3. 示例（claude-code 处理 `fad-backend#1247`）

```
# 1) 接到任务，开始处理
update_task_status(issue="fad-backend#1247", status="处理中")
record_session(issue="fad-backend#1247", session_id="tmux:work-1247", agent="claude-code", branch="$(git -C /path/to/fad-backend branch --show-current)")

# 2) 中途要切去别的事，先记录会话
record_session(issue="fad-backend#1247", session_id="tmux:work-1247", agent="claude-code")

# 3) 用户说「生成交接任务」
record_handoff(issue="fad-backend#1247",
  text="已重做支付地基的 onlinepay 分支；待补网关回调单元测试；恢复：tmux attach -t work-1247")

# 4) 做完收尾
update_task_status(issue="fad-backend#1247", status="已完成")
clear_session(issue="fad-backend#1247")
```

---

## 4. 注意事项
- 所有工具**只对本地数据库生效**，不会向 GitHub 推送任何变更、不触发任何通知。
- `issue` 必须是看板里已存在的任务（同步自 `org:FoodsUp-Inc` 的 open issue）；若返回「任务不存在」，先 `list_my_tasks` 确认 key 是否正确（注意是 `repo#number`，不含 owner）。
- 数据库文件默认 `~/Library/Application Support/com.shawnliu.taskboard/taskboard.db`，可由环境变量 `TASKBOARD_DB` 覆盖。

# TaskBoard MCP — Let an Agent maintain the board automatically

> **English**
>
> 中文版见 [AGENT_INSTRUCTIONS.md](./AGENT_INSTRUCTIONS.md)

This file is a set of instructions you can **feed directly to any coding agent** (claude-code / codex / opencode / zcode / helix / cursor / doubao …).
As long as the agent is wired to the `taskboard` MCP Server (see the "MCP Server" section of the repo's `README.md`), it can — **without writing back to GitHub** —
automatically record task status, interrupted sessions, and handoff details into the local TaskBoard.

> Hard constraint: **write only to local SQLite; never call the GitHub API, never modify Issue / Project / label / comments.** This board has zero side effects on GitHub.

---

## 0. Setup (one-time — skip if already wired)

The MCP Server is registered as `taskboard` in WorkBuddy's `~/.workbuddy/mcp.json`.
**Preferred form (from v0.3.12)**: once TaskBoard.app is installed, the MCP is built into the app binary — just use the `taskboard mcp` subcommand, no separate folder / Python needed:

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

> Path note: the above is the default install location; if you installed elsewhere, point `command` at your actual `TaskBoard.app/Contents/MacOS/taskboard` absolute path. For **portable / dev scenarios without the app installed**, use the fallback: `"command": "python3", "args": ["/path/to/mcp_server/server.py"]`.

---

## 1. Available tools

| Tool | Inputs | Purpose |
|---|---|---|
| `list_my_tasks` | `status?` / `ownership?` | List board tasks (filterable by four-state / ownership) |
| `get_task_status` | `issue` | Query a task's current state + recorded session / handoff |
| `update_task_status` | `issue`, `status` | Update the local board state |
| `record_session` | `issue`, `session_id`, `agent?`, `branch?` | Record an interrupted session id; if `branch` is non-empty, also record the current working branch (into `work_branch`, kept separate from the synced PR `branch`) |
| `record_handoff` | `issue`, `text` | Record "handoff task" details |
| `clear_session` | `issue` | Clear the session field after completion (kept for audit) |

### issue reference format (any of these — auto-normalized)
- `repo#number` — e.g. `fad-backend#1247`
- `owner/repo#number` — e.g. `FoodsUp-Inc/fad-backend#1247`
- GitHub URL — e.g. `https://github.com/FoodsUp-Inc/fad-backend/issues/1247`

### State enum (`status` of `update_task_status`)
- English keys: `todo` / `doing` / `processed` / `done`
- Chinese equivalents: `待处理` / `处理中` / `已处理` / `已完成`

---

## 2. Trigger timing → action (core rules)

| Timing | Action |
|---|---|
| **Start working** on an issue (assigned by the user / you claim it / you begin changing it) | `update_task_status(issue, "处理中")` + `record_session(issue, <current session id>, "<agent name>", branch=<current working branch>)` |
| **Pause / session interrupted / switching to another task** | `record_session(issue, <current session id>, "<your agent name>")` |
| The user says "**generate a handoff task**", "hand off", "handoff", etc. | `record_handoff(issue, "<done / not done / blockers / how to resume>")`; to preserve a resumable session, also call `record_session` |
| **Task complete** (you verify it's done, wrapping up) | `update_task_status(issue, "已完成")` + `clear_session(issue)` |
| Want to know a task's current state / restore context | `get_task_status(issue)` |
| Want to see the task list (e.g. only "unassigned") | `list_my_tasks(ownership="notassignee")` |

### Where the session id / branch comes from (important, #177)
The `session_id` is **supplied by the caller**, with this priority (don't mix ids across parallel agents):
- claude-code (this repo, project hooks installed): the `SessionStart` hook injects the current session id into context and persists it to `$TASKBOARD_SESSION_ID` (via `CLAUDE_ENV_FILE`); `${CLAUDE_SESSION_ID}` is also available in slash commands. All three hold the same value — prefer `${CLAUDE_SESSION_ID}`, fall back to `$TASKBOARD_SESSION_ID`. Only use a tmux session or similar recoverable id as a last resort.
- opencode (this repo, project plugin `.opencode/plugins/taskboard.js` installed): when calling `record_session`, **leave** `session_id` / `agent` / `branch` empty — the plugin auto-fills them in `tool.execute.before` with the real session id + `opencode` + git branch. Never invent one. Shortcut: `/task-start <repo#num>`.
- codex / zcode / helix: pick a recoverable id from each one's current session
- **always pass the `agent` argument** (`claude-code` / `codex` / `opencode` / `zcode` / `helix` …) so multiple processes can tell who recorded what

`branch` is **also supplied by the caller, in two steps**: first run `git branch --show-current` (or `git -C <the project dir for that issue> branch --show-current`) with the Bash tool to get the plain branch name, then pass the result as the string `branch` argument to `record_session`. **Never paste `$(...)` / backticks literally into MCP arguments** (MCP never runs a shell — that would store a literal dirty string).
**pass an empty string if it can't be resolved** (no git repo / no branch — don't stuff in dirty data). It's written to a separate `work_branch` column, kept apart
from the synced PR `branch`, so sync never overwrites it.

### How state is kept when interrupting
After an interrupt, **keep the state as "处理中"** (do not fall back to "待处理") — falling back would lose the signal that "this task already has partial work", which is exactly what a session id is for. On resume, explicitly move back to "处理中".

---

## 3. Example (claude-code working on `fad-backend#1247`)

```
# 1) Got the task; start working (shortcut: /task-start fad-backend#1247)
# First run `git branch --show-current` with the Bash tool, then call the two steps below
update_task_status(issue="fad-backend#1247", status="处理中")
record_session(issue="fad-backend#1247", session_id="${CLAUDE_SESSION_ID}", agent="claude-code", branch="<Bash output from previous step, may be empty>")

# 2) Switching to something else mid-way; record the session first
record_session(issue="fad-backend#1247", session_id="tmux:work-1247", agent="claude-code")

# 3) The user says "generate a handoff task"
record_handoff(issue="fad-backend#1247",
  text="Reworked the payment-foundation onlinepay branch; pending gateway callback unit tests; resume: tmux attach -t work-1247")

# 4) Wrap up when done
update_task_status(issue="fad-backend#1247", status="已完成")
clear_session(issue="fad-backend#1247")
```

---

## 4. Notes
- All tools **only affect the local database**; they push nothing to GitHub and trigger no notifications.
- `issue` must be a task already on the board (synced from `org:FoodsUp-Inc` open issues); if it returns "task not found", first `list_my_tasks` to confirm the key (note it's `repo#number`, without the owner).
- The database file defaults to `~/Library/Application Support/com.shawnliu.taskboard/taskboard.db`, overridable via the `TASKBOARD_DB` environment variable.
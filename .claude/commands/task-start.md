---
description: 开始处理某 issue，自动更新看板并记录会话
argument-hint: <repo#num | owner/repo#num | GitHub URL>
allowed-tools: Bash, mcp__taskboard__update_task_status, mcp__taskboard__record_session, mcp__taskboard__get_task_status
---

开始处理 TaskBoard 看板任务 `$ARGUMENTS`（只写本地 SQLite，绝不碰 GitHub）。

严格按以下顺序执行（分支必须先用 Bash 取到、再传值，禁止把 `$(...)` 原样塞进 MCP 参数）：

1. 用 Bash 执行 `git branch --show-current` 拿到当前工作分支（不在仓库 / 无分支则记为空字符串）。
2. 调 MCP `get_task_status` 查该任务现状（确认 issue_key 正确）。
3. 调 MCP `update_task_status`，`issue=$ARGUMENTS`，`status=处理中`。
4. 调 MCP `record_session`，`issue=$ARGUMENTS`，`session_id=${CLAUDE_SESSION_ID}`（若为空则用 `$TASKBOARD_SESSION_ID`），`agent=claude-code`，`branch=<第 1 步的分支，可空>`。

任务：$ARGUMENTS

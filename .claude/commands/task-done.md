---
description: 完工收尾，置已完成并清空会话
argument-hint: <repo#num | owner/repo#num | GitHub URL>
allowed-tools: mcp__taskboard__update_task_status, mcp__taskboard__clear_session
---

收尾 TaskBoard 看板任务 `$ARGUMENTS`（只写本地 SQLite，绝不碰 GitHub）：

1. 调 MCP `update_task_status`，`issue=$ARGUMENTS`，`status=已完成`。
2. 调 MCP `clear_session`，`issue=$ARGUMENTS`。

任务：$ARGUMENTS

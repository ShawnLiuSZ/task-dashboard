---
description: 记录交接详情，保留可恢复会话
argument-hint: <repo#num> <已做/未做/卡点/如何恢复>
allowed-tools: Bash, mcp__taskboard__record_handoff, mcp__taskboard__record_session
---

为 TaskBoard 看板任务记录交接（只写本地 SQLite，绝不碰 GitHub）：

1. 调 MCP `record_handoff`，`issue=$ARGUMENTS[0]`，`text` 为「已做 / 未做 / 卡点 / 如何恢复」（取 `$ARGUMENTS` 去掉首个 issue 引用后的剩余部分；若为空则先问用户要交接内容，不要编造）。
2. 同时调 MCP `record_session` 保留可恢复会话：`issue=$ARGUMENTS[0]`，`session_id=${CLAUDE_SESSION_ID}`（为空则用 `$TASKBOARD_SESSION_ID`），`agent=claude-code`；如刚切过分支，先用 Bash 取 `git branch --show-current` 并透传 `branch`。
3. 中断后保持「处理中」，不要回退到「待处理」。

任务：$ARGUMENTS

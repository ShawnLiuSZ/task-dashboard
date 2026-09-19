---
description: 开始处理某 issue，自动更新看板并记录会话（#279：先切 issue 分支再记录）
argument-hint: <repo#num | owner/repo#num | GitHub URL>
allowed-tools: Bash, mcp__taskboard__update_task_status, mcp__taskboard__record_session, mcp__taskboard__set_work_branch, mcp__taskboard__get_task_status
---

开始处理 TaskBoard 看板任务 `$ARGUMENTS`（只写本地 SQLite，绝不碰 GitHub）。

#279 关键：本命令会读取当前 git 分支并写入 `work_branch`。**你必须先切到该 issue 的工作分支**，否则 `work_branch` 会被记成 develop/master 基线分支。

1. 若当前不在该 issue 的工作分支上，先用 Bash 创建 / 切换到它（分支名遵循本仓库约定 `feature/issue-<N>-<scope>`，从 develop 新开；已存在则直接切）：
   `git switch -c feature/issue-<N>-<scope> develop`   （已在该分支则跳过本步）
2. 用 Bash 执行 `git branch --show-current` 拿到当前工作分支（此时应已是 issue 分支，非 develop/master；不在仓库则记为空字符串）。
3. 调 MCP `get_task_status` 查该任务现状（确认 issue_key 正确）。
4. 调 MCP `update_task_status`，`issue=$ARGUMENTS`，`status=处理中`。
5. 调 MCP `record_session`，`issue=$ARGUMENTS`，`session_id=${CLAUDE_SESSION_ID}`（若为空则用 `$TASKBOARD_SESSION_ID`），`agent=claude-code`，`branch=<第 2 步的分支，可空>`。
6. #279 兜底：若你之前在 develop/master 上已经跑过本命令、之后才切到 issue 分支，切完后**再调一次** MCP `set_work_branch`，`issue=$ARGUMENTS`，`branch=<当前 issue 分支>`，纠正 `work_branch`。

任务：$ARGUMENTS

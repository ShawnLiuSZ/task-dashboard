---
description: 开始处理某 issue，自动更新看板并记录会话（#279：先切 issue 分支再记录）
---
开始处理 TaskBoard 看板任务 `$ARGUMENTS`（只写本地 SQLite，绝不碰 GitHub）。

> 若上条 prompt 只含这一个 issue 引用，插件已自动开始（可先查现状确认）；多任务、消歧、补记时用本命令。

#279 关键：本命令会让插件读取当前 git 分支写入 `work_branch`。**你必须先切到该 issue 的工作分支，再调本命令**（插件在命令展开时填入当前分支，若在 develop/master 上展开就会记成基线分支）。分支名遵循本仓库约定 `feature/issue-<N>-<scope>`，从 develop 新开；已存在则直接切。

当前工作分支（已自动填入，无需再查）：
!`git branch --show-current`

严格按顺序执行（MCP 工具名为 `taskboard_` 前缀）：
1. 调 `taskboard_get_task_status` 查该任务现状（确认 issue_key 正确）。
2. 调 `taskboard_update_task_status`，`issue=$ARGUMENTS`，`status=处理中`。
3. 调 `taskboard_record_session`，`issue=$ARGUMENTS`（`session_id` / `agent` / `branch` 由 TaskBoard 插件自动填充，不要编造 session id，直接调即可）。
4. #279 兜底：若你**先**跑了本命令（当时在 develop/master）**后**才切到 issue 分支，切完后**再调一次** `taskboard_set_work_branch`，`issue=$ARGUMENTS`，`branch=<当前 issue 分支>`，纠正 `work_branch`。

任务：$ARGUMENTS

---
description: 记录交接详情，保留可恢复会话
---
为 TaskBoard 看板任务记录交接（只写本地 SQLite，绝不碰 GitHub）：

1. 调 `taskboard_record_handoff`，`issue=$1`，`text` 为「已做 / 未做 / 卡点 / 如何恢复」（取全部参数去掉首个 issue 引用后的剩余部分；若为空先问用户要交接内容，不要编造）。
2. 同时调 `taskboard_record_session` 保留可恢复会话：`issue=$1`（`session_id` / `agent` / `branch` 由 TaskBoard 插件自动填充）。
3. 中断后保持「处理中」，不要回退到「待处理」。

任务：$ARGUMENTS

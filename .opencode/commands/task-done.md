---
description: 完工收尾，置已完成并清空会话
---
收尾 TaskBoard 看板任务 `$ARGUMENTS`（只写本地 SQLite，绝不碰 GitHub）：

1. 调 `taskboard_update_task_status`，`issue=$ARGUMENTS`，`status=已完成`。
2. 调 `taskboard_clear_session`，`issue=$ARGUMENTS`。

任务：$ARGUMENTS

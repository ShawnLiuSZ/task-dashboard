# Issue #41: MCP 调用静默化——隐藏 db 列迁移日志

## 背景 / 动机

通过 MCP 调用 `taskboard` 二进制（如 `taskboard update-status "ShawnLiuSZ/task-dashboard#38" "处理中"`）时，终端/agent 会话里会刷出大量与调用无关的数据库迁移日志：

```
[db] 列迁移跳过（已存在或 schema 不兼容）: duplicate column name: gh_status | sql=ALTER TABLE tasks ADD COLUMN gh_status TEXT NOT NULL DEFAULT ''
[db] 列迁移跳过（已存在或 schema 不兼容）: duplicate column name: assignees | sql=...
```

原因：`db.rs` 的幂等列迁移在「列已存在」时仍 `eprintln!` 输出整条 SQL，而 MCP 走的是 stdio JSON-RPC——这些输出会污染 agent 会话。

## 设计 / 方案

- **迁移日志降级为 debug 级**：新增 `verbose_enabled()` 函数检查 `TASKBOARD_LOG` 环境变量
- 默认静默：MCP 调用时不输出迁移日志
- 可观测性开关：设置 `TASKBOARD_LOG=1|debug|verbose|true` 可开启详细日志

## 接口 / 行为变更

- MCP 调用时默认不输出 `[db] 列迁移跳过...` 日志
- stdout 仅输出 JSON-RPC 消息，日志走 stderr（默认关闭）
- 排障时可通过环境变量开启：`TASKBOARD_LOG=1 /path/to/taskboard ...`

## 测试 / 验收

- [x] `cargo check` 通过
- [x] MCP 调用时终端不再出现迁移日志
- [x] 设置 `TASKBOARD_LOG=1` 后可看到详细日志

## 相关链接

- Issue: https://github.com/ShawnLiuSZ/task-dashboard/issues/41
- PR: https://github.com/ShawnLiuSZ/task-dashboard/pull/45

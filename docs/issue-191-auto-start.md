# Issue #191：opencode 插件自动执行可靠性

## 背景 / 动机

2026-09-11 review 发现 `.opencode/plugins/taskboard.js` 的 `autoStart` 在失败时报喜不报忧且永久抑制重试，还会把 `processed` 任务打回 `doing`。对应 issue：[#191](https://github.com/ShawnLiuSZ/task-dashboard/issues/191)。

## 设计 / 方案

只改 `autoStart`，保持"零 npm 依赖、失败不影响 agent 主流程"约束：

1. `autoFired.add(dedup)` 挪到两路 MCP 调用全部成功之后；失败路径直接返回（不标记，本会话可重试）。
2. 同时检查 `upd.error || rec.error`（此前只看第二个），失败记 `warn` 且不记成功日志。
3. `done`/`processed` 直接返回（此前只 guard `done`）；`doing` 且已有 `session_id` 视为已接管，标记后返回，避免重复写。

`get_task_status` 返回整行任务 + `found`，`status`/`session_id` 字段可直接用（见 `mcp.rs::tool_get` + `row_to_value`）。

## 接口 / 行为变更

- 插件内部函数行为变更；MCP 工具契约不变。
- 用户可见变化：失败时看到 `warn`（可重试）而非误导性的"已自动开始"；`processed` 任务被 mention 不再回退。

## 数据 / Schema 变更

无。

## 测试 / 验收

- `node --check` 通过；插件无单测基建（Bun/Node 双运行时），靠 review + 手工验证
- 验收标准见 issue #191（任一调用失败 → warn + 可重试；processed/done 不回退）

## 相关链接

- Issue：[#191](https://github.com/ShawnLiuSZ/task-dashboard/issues/191)
- 分支：`fix/issue-190-191-hooks-backup-auto-start`（与 #190 同分支，文件无重叠）
- `CHANGELOG.md`：待发版时追加

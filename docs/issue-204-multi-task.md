# Issue #204：单窗口多任务自动执行失活

## 背景 / 动机

opencode 插件用整会话累计 buffer 判定"唯一引用"：单窗口做多个任务时累计引用数 >1 即永久不再自动执行，后续任务的 `session_id` 存不进去（用户实测报障）。对应 issue：[#204](https://github.com/ShawnLiuSZ/task-dashboard/issues/204)。

## 设计 / 方案

`TaskboardPlugin` 的 message 事件处理改按当前消息判定：

- 当前文本恰好 1 个未触发引用 → 自动执行；0 条无事，多条无法消歧（回退手动 `/task-start`）
- 当前 0 引用时，用上条尾部 40 字 + 当前文本再扫一次（分片切断 token 兜底）
- `autoFired` 去重语义不变（同 session 同 issue 成功后才记）；不存在看板 / done / processed 跳过语义不变（#191）

## 接口 / 行为变更

- 插件内部判定逻辑；MCP 契约不变

## 数据 / Schema 变更

无。

## 测试 / 验收

- `node --check` 通过；插件无单测基建，靠 dev 实测：单窗口依次提 A、B 各执行一次；单条提 A、B 不动作；重复引用只执行一次
- 验收标准见 issue #204

## 相关链接

- Issue：[#204](https://github.com/ShawnLiuSZ/task-dashboard/issues/204)
- 分支：`fix/issue-204-multi-task`
- 前序：`docs/issue-191-auto-start.md`
- `CHANGELOG.md`：待发版时追加

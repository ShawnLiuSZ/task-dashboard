# Issue #197：卡片 session id 独立行展示

## 背景 / 动机

卡片底部（`card-bottom`）用三元二选一：有 session id 显示会话、挤掉更新时间。owner 要求有 session 时在分配人下一行独立展示，时间恒显示。对应 issue：[#197](https://github.com/ShawnLiuSZ/task-dashboard/issues/197)。

## 设计 / 方案

- `TaskCard.tsx`：`meta-row` 后新增 `session-row`（`sessionId` 非空才渲染，全值放 `title`）；`card-bottom` 去掉三元，恒显示更新时间。
- `styles.css`：`.session-row` 列窄省略（`ellipsis` + `nowrap`）。
- 文案复用既有 `card.sessionLabel`，无新增 i18n key。

## 接口 / 行为变更

- 纯展示变更；无后端/MCP/类型变更。

## 数据 / Schema 变更

无。

## 测试 / 验收

- `board.test.tsx` 新增 `TaskCard session 行` 2 用例（有/无 session 的 SSR 断言）
- `vitest` 38 passed、`tsc` 通过

## 相关链接

- Issue：[#197](https://github.com/ShawnLiuSZ/task-dashboard/issues/197)
- 分支：`fix/issue-197-card-session-row`
- `CHANGELOG.md`：待发版时追加

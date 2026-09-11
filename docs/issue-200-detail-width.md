# Issue #200：详情宽度 50% + 去掉四态按钮

## 背景 / 动机

#196 落地后详情状态区有两排（GitHub 状态行 + 四态按钮）。owner 要求详情加宽到 50%，并去掉 project.status 下面的四态按钮，状态以 project.status 为准。对应 issue：[#200](https://github.com/ShawnLiuSZ/task-dashboard/issues/200)。

## 设计 / 方案

- `styles.css`：`.detail` `width: 460px` → `50%`
- `DetailPanel.tsx`：删除四态 seg 及其 `COLUMNS`/`StatusKey` 引用；`run`/`busy` 保留给会话与交接区
- 后果：详情页不再提供手动改状态入口，状态变更走 agent/MCP

## 接口 / 行为变更

- 纯前端展示/交互删减；无后端/MCP/类型变更

## 数据 / Schema 变更

无。

## 测试 / 验收

- `tsc` 通过（无未使用 import）、`vitest` 38 passed

## 相关链接

- Issue：[#200](https://github.com/ShawnLiuSZ/task-dashboard/issues/200)
- 分支：`fix/issue-200-detail-width`
- 前序：`docs/issue-196-detail-project-status.md`
- `CHANGELOG.md`：待发版时追加

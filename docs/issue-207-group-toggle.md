# Issue #207：agent 分组下拉展开

## 背景 / 动机

设置页 agent 接入四组平铺，agent 多时页面很长。owner 要求每组加下拉展开/收起。对应 issue：[#207](https://github.com/ShawnLiuSZ/task-dashboard/issues/207)。

## 设计 / 方案

- 组标题改为整行可点 toggle（`▸`/`▾` + `aria-expanded`，键盘可达，原有点位/圆点/计数保留）
- 收起态 `Record<group, boolean>`（默认全展开）持久化到 `localStorage["settings.hooks.groupsCollapsed"]`，损坏回默认
- 分组逻辑、空组不渲染、安装/卸载按钮行为不变；`.hook-group-toggle` 样式复位 button 默认外观

## 接口 / 行为变更

- 纯前端；无后端/MCP/类型/i18n key 变更

## 数据 / Schema 变更

无（localStorage 本地偏好）。

## 测试 / 验收

- `settings-groups.test.tsx` 2 用例：默认展开结构、存档收起态生效
- `tsc`、`vitest` 46 passed

## 相关链接

- Issue：[#207](https://github.com/ShawnLiuSZ/task-dashboard/issues/207)
- 分支：`feature/issue-207-group-toggle`
- `CHANGELOG.md`：待发版时追加

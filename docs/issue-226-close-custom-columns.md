# Issue #226：自定义列映射页签暂关闭

## 背景 / 动机

设置页自定义列映射暂关闭（owner 要求先下掉）。对应 issue：[#226](https://github.com/ShawnLiuSZ/task-dashboard/issues/226)。

## 设计 / 方案

- `SettingsPanel` 加 `CUSTOM_COLUMN_MAPPING_ENABLED = false` 开关：页签按钮过滤隐藏 + 面板 `display` 再守一道
- 已有 custom 配置照常渲染（`resolveBoardView` 不动，无数据丢失、无迁移）；后端命令/API 不动，重开即恢复

## 接口 / 行为变更

- 设置页无入口；其余不变

## 数据 / Schema 变更

无。

## 测试 / 验收

- 新用例：SSR 无"自定义列映射"字样
- `tsc`、`vitest` 54 passed

## 相关链接

- Issue：[#226](https://github.com/ShawnLiuSZ/task-dashboard/issues/226)
- 分支：`feature/issue-226-close-custom-columns`

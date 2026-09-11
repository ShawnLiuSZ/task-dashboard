# Issue #209：记事本最小拖拽宽度 25%

## 背景 / 动机

#202 拖拽范围 15%–50%。owner 要求下限提到 25%（默认 25% 不变，恰等于下限）。对应 issue：[#209](https://github.com/ShawnLiuSZ/task-dashboard/issues/209)。

## 设计 / 方案

- `MIN_WIDTH_PCT` 15 → 25；`aria-valuemin` 自动跟随；单测边界同步；`docs/issue-202-notes-width.md` 范围描述同步

## 接口 / 行为变更

- 拖拽/键盘下限 25%；其余不变

## 数据 / Schema 变更

无（旧存档 <25% 下次读取即钳制）。

## 测试 / 验收

- `vitest` notes-width 6 passed、`tsc` 通过

## 相关链接

- Issue：[#209](https://github.com/ShawnLiuSZ/task-dashboard/issues/209)
- 分支：`fix/issue-209-notes-min-width`
- 前序：`docs/issue-202-notes-width.md`

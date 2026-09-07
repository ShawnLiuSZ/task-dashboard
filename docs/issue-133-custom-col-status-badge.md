# Issue #133: 自定义列视图 project.status 徽章修复

## 背景 / 动机

自定义列视图（`boardMode === "custom"`）下，卡片右上角的 `project.status` 徽章未正确显示。

## 设计 / 方案

**根因**：`TaskCard.tsx` 中 gh-status 徽章使用了 `repo` 类名，但 CSS 中 `.card-top .gh-status` 用于右对齐布局。缺少 `gh-status` 类导致徽章位置异常。

**修复**：在 `TaskCard.tsx:76` 为 gh-status 徽章添加 `gh-status` 类名：
```tsx
// 修复前
className={`repo repo-${ghStatusColor(task.ghStatus)}`}

// 修复后
className={`gh-status repo repo-${ghStatusColor(task.ghStatus)}`}
```

## 接口 / 行为变更

- 卡片右上角的 project.status 徽章现在正确右对齐显示

## 测试 / 验收

- TypeScript 编译通过
- 卡片在自定义列视图下正确显示彩色徽章

## 相关链接

- Issue: #133
- 分支: `feature/issue-133-custom-col-status-badge`

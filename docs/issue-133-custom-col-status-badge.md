# Issue #133: 自定义列视图 project.status 徽章修复

## 背景 / 动机

自定义列视图（`boardMode === "custom"`）下存在两个问题：
1. 卡片右上角的 `project.status` 徽章未正确显示
2. 配置自定义列后，任务全部显示在「未标注」列

## 设计 / 方案

### Bug 1: 徽章位置异常

**根因**：`TaskCard.tsx` 中 gh-status 徽章使用了 `repo` 类名，但 CSS 中 `.card-top .gh-status` 用于右对齐布局。缺少 `gh-status` 类导致徽章位置异常。

**修复**：在 `TaskCard.tsx:76` 为 gh-status 徽章添加 `gh-status` 类名：
```tsx
// 修复前
className={`repo repo-${ghStatusColor(task.ghStatus)}`}

// 修复后
className={`gh-status repo repo-${ghStatusColor(task.ghStatus)}`}
```

### Bug 2: 任务全部在「未标注」列

**根因**：`save_account_columns` 只保存列配置，不设置 `boardMode` 为 "custom"。同步时 `board_mode != "custom"` 导致列映射被跳过，所有任务保持原始 `status`（非 col_key），无法匹配自定义列。

**修复**：在 `db.rs:save_account_columns` 中，保存列配置后自动设置 `boardMode` 为 "custom"：
```rust
if !columns.is_empty() {
    let current = get_account_board_mode(&tx, account_id);
    if current != "custom" {
        set_account_board_mode(&tx, account_id, "custom")?;
    }
}
```

### Bug 3: 自定义列模式下无列配置时徽章不显示

**根因**：`Board.tsx` 默认四态列视图未传递 `showGhStatus`。当 `boardMode === "custom"` 但 `accountColumns` 为空时，回退到默认视图，徽章不显示。

**修复**：在 `Board.tsx` 默认视图中传递 `showGhStatus={boardMode === "custom"}`：
```tsx
showGhStatus={boardMode === "custom"}
```

## 接口 / 行为变更

- 卡片右上角的 project.status 徽章现在正确右对齐显示
- 保存自定义列配置时，自动将账号的 `boardMode` 设为 "custom"

## 测试 / 验收

- TypeScript 编译通过
- Rust 编译通过
- 卡片在自定义列视图下正确显示彩色徽章
- 保存列配置后，下次同步任务会正确匹配到对应列

## 相关链接

- Issue: #133
- 分支: `feature/issue-133-custom-col-status-badge`

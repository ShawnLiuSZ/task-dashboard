# Issue #317: 删除任务会话二次确认弹框被铺满成全屏页面

## 背景

在「任务会话」面板（SessionsPanel）点击卡片的删除（清除会话）按钮，二次确认框不是居中弹框，而是被拉伸成铺满整个面板区域的「全屏页面」，视觉上等同于跳转到另一个页面，与预期的弹框提醒不符。

根因是 CSS 选择器误伤：`app/src/styles.css` 中 `.panel-page .modal` / `.panel-page .modal-mask` 两条覆盖规则，本意是让内嵌面板（Settings / Accounts / SyncLogs / About）铺满主区；但 `ConfirmDialog` 组件也使用 `.modal` + `.modal-mask` 类名，且其确认框渲染在 `.panel-page` 内部（SessionsPanel、AccountsPanel 删除账号、SyncLogsPanel 清空日志均如此），于是同样被这两条规则命中——遮罩变透明、弹框被拉伸为 `width:100%; height:100%`。

## 实现

### 收窄覆盖规则

`styles.css` 中将两条规则收窄，排除确认框：

```css
.panel-page .modal-mask:not(.confirm-mask) {
  /* 原 .panel-page .modal-mask */
  position: absolute;
  inset: 0;
  background: transparent;
  z-index: auto;
  align-items: stretch;
  padding: 0;
}

.panel-page .modal:not(.confirm-modal) {
  /* 原 .panel-page .modal */
  width: 100%;
  max-height: none;
  height: 100%;
}
```

面板自身的 `.modal` 根结构（Accounts / Settings / SyncLogs / About）没有 `.confirm-modal` / `.confirm-mask` 类，仍走铺满逻辑，行为不变。

### ConfirmDialog 加标记类

`app/src/components/ConfirmDialog.tsx` 给遮罩加上 `confirm-mask` 类，使上面的 `:not()` 能精确命中、排除铺满规则：

```tsx
<div className="modal-mask confirm-mask" onClick={onCancel}>
```

## 接口 / 行为变更

- **UI 行为**：所有在 `.panel-page` 内渲染的二次确认框（删除任务会话、删除账号、清空同步日志等）恢复为居中弹框（`.confirm-modal` 宽度 400px、半透明遮罩、Esc/点遮罩取消），不再全屏铺满。
- **无新增 / 修改 API、Tauri command、MCP 工具或 DB schema**。纯前端 CSS + 1 行 TSX 类名改动。

## 验收

- [x] 任务会话面板删除会话：确认框居中弹出（非全屏页面）
- [x] 账号面板删除账号：确认框居中弹出
- [x] 同步日志面板清空日志：确认框居中弹出
- [x] Settings / Accounts / SyncLogs / About 面板自身铺满主区的行为不变
- [x] `npx tsc --noEmit` 0 error
- [x] `npm run i18n:check` 385 keys 一致
- [x] `npm run lint` 18 warnings（无新增）
- [x] `npx prettier --check` 通过
- [x] `confirm-dialog.test.tsx` + `board.test.tsx` 22/22 passed
- [x] `python3 scripts/check-doc-links.py` 通过

## 关联

- Issue: #317
- PR: #318
- 相关代码：`app/src/styles.css`、`.panel-page .modal` 覆盖规则；`app/src/components/ConfirmDialog.tsx`

# Issue #447 — 将添加备忘录入口改为 Modal 并置于顶部标题栏

## 背景 / 动机

备忘录（Notes）原有创建入口位于面板左侧的「创建列」中，占据了主区约 320px 的固定宽度。随着备忘录列本身已改为看板列模式（#259），创建列与四列并列导致横向空间被持续占用，且入口位置不够直观。需求要求：

1. 在顶部标题栏「TaskBoard 共 N 条」右侧增加创建备忘录按钮。
2. 点击后弹出 Modal，在 Modal 内完成内容输入、优先级选择与保存。
3. 保存成功后刷新备忘录列表。

## 设计 / 方案

### 交互变更

- **入口迁移**：在 `App.tsx` 的顶栏 `topbar-left` 区域新增「新建备忘录」按钮，位于任务计数右侧、同步控件左侧。
- **创建方式**：按钮触发全局 Modal `NoteComposerModal`，而不是在备忘录面板内展开创建列。
- **保存反馈**：保存成功后关闭 Modal、刷新 `NotesPanel` 列表、自动切到 `notes` 视图，并在顶部 banner 显示「备忘录已创建」提示，4 秒后自动消失。
- **错误处理**：保存失败时 Modal 保持打开，在 Modal 底部显示错误文本，用户可继续编辑或取消。

### 组件调整

- 新增 `app/src/components/NoteComposerModal.tsx`
  - 复用既有的自适应高度 textarea（`useAutoSize`）和优先级选择器（`LabelPicker`）。
  - 支持 `⌘/Ctrl + Enter` 快捷保存、`Esc` 关闭（通过 `useEscLayer` 保证层级正确）。
- 重构 `app/src/components/NotesPanel.tsx`
  - 移除左侧创建列及其收起状态（`addColCollapsed`、`draft`、`draftLabel`、`adding`、`handleAdd` 等）。
  - 保留导入/导出功能，将其安置在四列区上方的 `.notes-toolbar` 中。
  - 通过 `forwardRef` + `useImperativeHandle` 暴露 `reload()` 方法，供 `App.tsx` 在 Modal 保存后调用。

### 样式调整

- 移除已废弃的 `.notes-add-col`、`.notes-add-rail`、`.notes-body`、`.note-composer-full`、`.note-textarea-full` 等规则。
- 新增 `.notes-toolbar`、`.notes-toolbar-title`、`.notes-toolbar-spacer` 规则。
- 新增 `.note-composer-modal` 及内部布局规则，窄窗口下顶栏按钮文字隐藏、仅保留图标（与「立即同步」按钮一致）。

## 接口 / 行为变更

| 位置 | 变更 |
|---|---|
| `App.tsx` | 新增 `noteComposerOpen`、`noteNotice` 状态；顶栏新增「新建备忘录」按钮；渲染 `NoteComposerModal`。 |
| `NotesPanel.tsx` | 默认导出改为 `forwardRef<NotesPanelRef>`；移除创建列；导出 `NotesPanelRef` 类型。 |
| `NoteComposerModal.tsx` | 新增组件，props 为 `onSave(content, label): Promise<void>` 与 `onClose(): void`。 |
| `api.addNote` | 无变化，仍由 Modal 调用。 |
| i18n | 新增 `topbar.addNote`、`notes.composer.title`、`notes.added`（中英双语）。 |

## 数据 / Schema 变更

无。备忘录表 `notes` 及后端 API 均未改动。

## 测试 / 验收

- [x] `vitest` 全量通过（`notes-layout.test.ts` 已更新断言，移除创建列相关用例，新增工具行位置断言）。
- [x] `tsc --noEmit` 通过。
- [x] `eslint` 0 警告。
- [x] `prettier --check` 通过。
- [x] `npm run i18n:check` 通过（新增 3 key × 2 语种）。
- [x] 样式静态断言覆盖：`.notes-toolbar` 位于 `.notes-card-cols` 之前，导入/导出在该工具行内。

## 相关链接

- Issue: [#447](https://github.com/ShawnLiuSZ/task-dashboard/issues/447)
- PR: （创建后补充）
- 前置相关: [#259 左侧 Sidebar 与备忘录页面布局](./issue-259-sidebar-nav.md)

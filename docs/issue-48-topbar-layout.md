# Issue #48 — 顶部栏右侧按钮换行 & 移除左侧 TaskBoard 文字

## 背景 / 动机

对应 Issue：[#48](https://github.com/ShawnLiuSZ/task-dashboard/issues/48)

顶部栏右侧的「关于 / 设置 / 账号 / 同步日志 / 立即同步」按钮组在窗口宽度不足时会发生换行，导致顶栏高度从单行增加到两行，布局不紧凑。同时顶栏最左侧固定的 "TaskBoard" 文字占用空间且视觉冗余。

## 设计 / 方案

改动集中在两处：

1. **右侧按钮组禁止换行**：`.topbar-right` 元素显式声明 `flex-wrap: nowrap` 与 `white-space: nowrap`，确保按钮始终在同一行内。当窗口过窄导致一行放不下时，由整窗横向滚动承载超出的内容，而不是按钮折行撑高顶栏。顶栏已为 `position: sticky; left: 0`，横向滚动时操作区仍保持可见，符合既有交互。

2. **移除左侧 "TaskBoard" 文字**：删除 `App.tsx` 中的 `<span className="brand">TaskBoard</span>` 及其对应样式 `.brand`，释放顶栏左侧空间。账号/视图切换 select 与账号状态信息保持不变。

## 接口 / 行为变更

- UI 行为：顶栏左侧连同右侧按钮组均不再换行，窗口过窄时触发整窗横向滚动。
- UI 行为：顶栏左侧不再展示 "TaskBoard" 品牌文字，账号信息收敛到「切换账号」下拉（显示 `@login (org)`），右侧仅保留「共 n 条」计数。
- UI 行为：顶部栏「关于 / 设置 / 账号 / 同步日志 / 立即同步」各按钮内联 SVG 图标；窗口宽度 ≤1100px 时隐藏文字、仅显示图标（`title` 提供悬停提示）。「同步日志」由硬编码中文改为 i18n key `syncLogs.title`。
- UI 行为：暂移除「单账号 / 全部账号」视图模式下拉，仅使用单账号模式（恒渲染账号下拉）。后端 `setViewMode` 命令与 `accountFilter` 的 viewMode 逻辑保留，待 project status map 功能落地后再恢复「全部账号」入口。
- UI 行为：顶部栏「设置 / 关于 / 账号 / 同步日志」四个弹窗统一收敛到互斥的 `activeModal` 状态，同一时刻仅显示一个弹窗，修复新增按钮后弹窗互相叠加的问题（根因同 [#26](https://github.com/ShawnLiuSZ/task-dashboard/issues/26)：账号/同步日志原先用独立 state，未与设置/关于互斥）。
- UI 行为：弹窗容器 `.modal` 增加 `max-height: calc(100% - 48px)` 与 `overflow-y: auto`，窗口高度拉小时弹窗高度随视口收敛、内部出现滚动条，修复标题栏 / 底部被截断的问题。
- UI 行为：`.modal-mask` 提升 `z-index: 20`（高于 `topbar`/`toolbar` 的 `z-index: 5`），矮窗口下弹窗顶部伸入搜索栏区域时不再被其遮挡压住。
- 无 Tauri 命令、MCP 工具或数据结构变更。

## 数据 / Schema 变更

无。纯前端 UI 改动，不涉及 SQLite schema。

## 测试 / 验收

- [x] 窗口宽度缩窄时，「关于 / 设置 / 账号 / 同步日志 / 立即同步」始终在同一行，不折行。
- [x] 顶栏左侧不再显示 "TaskBoard" 文字。
- [x] 顶栏高度保持不变（约 42px），不出现两行高度。
- [x] `npx tsc --noEmit` 通过。

> 备注：顶部栏「同步日志」按钮当前仍为硬编码中文，未纳入本次改动。如需改为 i18n key 可作为独立小项处理。

## 相关链接

- Issue：[#48](https://github.com/ShawnLiuSZ/task-dashboard/issues/48)
- 分支：`feature/issue-48-topbar-layout`
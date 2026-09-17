# #265 窗口过窄时侧边栏收起为纯图标模式

## 背景 / 动机

#259 引入左侧固定 Sidebar（200px），承载记事本 / 账号列表 / 设置 / Agent 接入 / 同步日志 / 账号登录 / 关于全部入口。在窗口宽度充足时这没问题，但 TaskBoard 作为桌面应用，窗口可能被用户拉窄或平铺在副屏上。

当窗口宽度收窄到一定程度（约 < 900px）时，200px 的固定文字侧边栏会显著挤占主区可用空间：看板列变窄、工具栏搜索框被压短、同步日志表格横向滚动更早出现。原 #259 设计里预留了一句「窗口过窄时靠 flex 收缩 + 主区内部横向滚动兜底（未做图标化收起——留待后续）」——本 issue 就是把这条「留待后续」落地。

期望行为：窗口宽度 `< 900px` 时，Sidebar 自动由「文字 + 图标」的 200px 模式收起为「仅图标」的 ~56px 模式，释放空间给主区，图标本身已能表达各入口含义，文字标签改用悬浮 `title` 提示。

## 设计 / 方案

### 触发与判定

- **纯响应式、不持久化**：收起状态完全由当前窗口宽度决定，不写入 `localStorage` / SQLite，也不随窗口尺寸做动画过渡（避免引入新状态维度与首屏闪烁）。
- 判据：`window.innerWidth < 900`。`900px` 取自「侧边栏 200px + 主区仍有舒适最小宽度」的实测阈值；低于该值主区开始明显局促。
- 初始态即在 `useState` 初始化时读取一次 `window.innerWidth`，避免首帧闪一下再收起。

### 状态流

```
window resize ──> innerWidth < 900 ? ──> sidebarCollapsed ──> <Sidebar collapsed={...}>
                                        (值为 false/true 不变时 setState 是 no-op，不重渲染)
```

- `App.tsx` 新增 `sidebarCollapsed` 状态 + `resize` 监听器（`useEffect` 内 `window.addEventListener('resize', ...)`，cleanup 移除）。
- 监听回调只做 `setSidebarCollapsed(window.innerWidth < 900)`；由于 React 对相同的 state 值做 bail-out（不会触发重渲染），拖拽窗口过程中尺寸在阈值同侧来回小幅抖动不会产生多余渲染，无需手动 debounce。
- `Sidebar` 新增可选 prop `collapsed?: boolean`（默认 `false`），据此在根 `nav` 元素上加 / 去掉 `.collapsed` 类。**其余 props、DOM 结构、分组逻辑完全不变**。

### 样式策略（纯 CSS，无布局引擎依赖）

`.sidebar.collapsed` 这一条规则覆盖：

- 宽度：`flex-basis: 56px` + `width: 56px`（覆盖 `.sidebar` 的 `flex: 0 0 200px` 的 basis 与 `width`；`flex-shrink: 0` 不变，故宽度恒定 56px，不随 flex 收缩）；
- 隐藏文字层：`.sidebar-item-label`、`sidebar-group-title`、`.sidebar-empty` 均 `display: none`；
- 图标居中：`.sidebar-item { justify-content: center; padding-left/right: 0 }`，仅留图标；
- 分组与 footer 在收起态下 `width: 100%` + `align-items: center`，保证图标在窄列内水平居中；
- 账号项仍是「图标 + 隐藏的 `@login` 文字」，悬浮 `title`（`switchAccount` / `@login`）仍生效，用户在窄窗下靠图标 + 悬浮提示辨识账号；
- main-content 仍是 `flex: 1 1 auto`，自动占满 `200px → 56px` 释放出的 144px，主区无需任何改动。

### 与已有模块的关系

- 沿用 #259 的 `app-shell`（flex row）+ `sidebar` / `main-content` 结构，只在侧边栏自身加一条 `.collapsed` 变体；
- 不新增 i18n key（无新用户可见文案），中英仍各 348 key；
- 纯前端，SQLite / Rust 零改动，`hooks.rs` / `commands.rs` / DB schema 完全不动。

## 接口 / 行为变更

- **Sidebar 组件**：新增可选 prop `collapsed?: boolean`（默认 `false`）。为 `true` 时根节点加 `.collapsed` 类，触发纯图标收起样式。
- **App 组件**：`sidebarCollapsed` 状态初值 = `window.innerWidth < 900`；`resize` 监听在宽度跨过 900px 阈值时翻转该状态并下传 `Sidebar`。
- **CSS**：新增 `.sidebar.collapsed` 及其子规则（见上方「样式策略」）。
- **行为**：窗口 `< 900px` → 侧边栏 200px 文字导航收起为 56px 纯图标；`≥ 900px` → 恢复原样。无手动开关（纯响应式，符合 issue 原文「窗口过窄时收起」）。
- 无 schema 变更、无新增 Tauri command、无后端改动。

## 数据 / Schema 变更

无（纯前端布局行为，SQLite / Rust 零改动）。

## 测试 / 验收

- [x] `npx tsc --noEmit` 0 error
- [x] `npm run build` ✅ 生产构建成功
- [x] `npm test`：13 文件 136 例全部通过（含新增 `styles.test.ts` 侧边栏收起静态回归 2 例）
- [x] `npm run i18n:check`：zh-CN / en-US 各 **348** key（无新增 / 删除），占位符一致
- [x] `npx prettier --check "src/**/*.{ts,tsx,css}"` ✅
- [x] `scripts/check-doc-links.py` ✅（新增本文档的链接已补）
- [x] 静态回归覆盖点：`styles.test.ts` 断言 `.sidebar.collapsed` 必须收窄到 56px 且隐藏 `.sidebar-item-label` / `.sidebar-group-title` / `.sidebar-empty`；该测试刻意把「分组标题 / 空态」拆成独立规则（而非逗号分组选择器），以匹配本仓库 `?raw` 静态断言只认「选择器紧接 `{`」的写法。
- [ ] **真机渲染复核**：收起态观感需在 `npm run tauri dev` 窗口拖动到 < 900px 确认（沙箱无头 Chrome 不可用，同 #259 / #263 限制）。

## 相关链接

- Issue：[#265](https://github.com/ShawnLiuSZ/task-dashboard/issues/265)
- 分支：`feature/issue-265-sidebar-collapse`
- 相关代码：`app/src/components/Sidebar.tsx` / `app/src/App.tsx` / `app/src/styles.css`
- 回归测试：`app/src/styles.test.ts`（侧边栏收起静态断言，2 例）
- 关联设计：`docs/issue-259-sidebar-nav.md`（左右分栏布局，本特性在其之上加响应式收起）
- 关联文档：[`CHANGELOG.md`](./CHANGELOG.md)（Unreleased 条目）

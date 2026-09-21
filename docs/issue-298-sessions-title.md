# Issue #298：去掉「任务会话」面板顶部的页面标题

## 背景 / 动机

「任务会话」面板顶部显示一个大标题「任务会话」（`panel-page-title`），而左侧侧边栏当前导航项已经高亮显示「任务会话」，信息完全重复，且占据了面板顶部一整行空间。

## 设计 / 方案

移除 `SessionsPanel.tsx` 顶部的 `<header className="panel-page-head">` 及其内部的 `<h2 className="panel-page-title">`，让面板内容区直接占据顶部空间。

参考 Agent 面板的处理方式：Agent 面板保留标题是因为顶部有操作按钮（如「接入」），需要标题行承载工具栏；Sessions 面板顶部没有任何操作按钮，标题行纯属冗余。

## 接口 / 行为变更

### UI 变更

- `SessionsPanel.tsx`：移除 `<header>` 和 `<h2>` 元素，面板内容区直接作为第一个子元素
- 布局：内容区向上移动一行，无多余空白

### i18n 变更

- 移除 `sessions.title` key（`zh-CN.json` / `en-US.json` 各 1 处）
- 保留 `sessions.title_format`（卡片内标题格式，与本次无关）

## 数据 / Schema 变更

无 schema 变更。

## 测试 / 验收

### 验收标准

1. ✅「任务会话」面板顶部不再显示「任务会话」标题行
2. ✅ 面板内容区布局正常，无多余空白或错位
3. ✅ `sessions.title` key 从中英 locale 中移除
4. ✅ `npm run i18n:check` 通过（369 keys / locale）
5. ✅ `npx tsc --noEmit` 0 error
6. ✅ `npm test` 136 例 passed
7. ✅ `npm run build` ✅
8. ✅ `npx prettier --check` ✅
9. ✅ `scripts/check-doc-links.py` ✅

## 相关链接

- Issue: https://github.com/ShawnLiuSZ/task-dashboard/issues/298
- CHANGELOG: `docs/CHANGELOG.md` 未发布条目
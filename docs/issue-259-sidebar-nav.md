# #259 左右分栏布局：左侧 Sidebar 承载账号切换与功能入口

## 背景 / 动机

随着账号数量增加、功能面板增多，原「顶栏 + 工具栏 + 左侧记事本 + 中间看板 + 弹窗面板」
的经典单栏结构出现两个问题：

- **顶栏过载**：账号下拉 + 关于/设置/账号/同步日志 4 个按钮 + 同步按钮挤在一行，
  账号一多下拉滚动，找不到重点；
- **Modal 遮挡**：设置 / 账号 / 同步日志以弹窗形式盖在看板上，操作时看不到任务上下文。

期望改为桌面应用常见的 **左侧固定导航 + 右侧主区** 结构（类似 Linear / Notion），
各功能面板在主区内嵌切换而非弹窗，账号切换从下拉变为直接点选。

## 设计 / 方案

### 布局结构

```
┌───────────────────────────────────────────────────────┐
│ 顶栏（品牌 + 条数 + 上次同步 + 立即同步）                │
├──────────┬────────────────────────────────────────────┤
│  📝 记事本│  （banner 全局展示）                        │
│          │  主区按 Sidebar 选中项条件渲染：             │
│  @账号1 ★ │  · board    → 工具栏 + Board（看板）        │
│  @账号2   │  · notes    → NotesPanel（宽度可拖）        │
│  + 添加   │  · settings → SettingsPanel（内嵌全高）     │
│          │  · agents   → AgentPanel（新增）            │
│  ⚙️ 设置  │  · synclogs → SyncLogsPanel（内嵌全高）     │
│  🤖 Agent │  · accounts → AccountsPanel（内嵌全高）     │
│  📋 日志  │                                            │
│  👤 登录  │                                            │
│──────────│                                            │
│  ⓘ 关于  │（关于保留为 Modal，低频操作）                │
└──────────┴────────────────────────────────────────────┘
```

### 关键决策

1. **`activeModal` 状态废弃**：改为 `nav`（`NavKey` 枚举：
   `notes | board | settings | agents | synclogs | accounts`）+ 独立的 `showAbout`。
   「关于」是唯一保留的 Modal，其余面板全部内嵌主区。
2. **顶栏精简**：账号下拉与 4 个功能按钮移除，只留品牌 + 总条数 + 上次同步时间 + 同步按钮。
   账号切换由 Sidebar 账号项直接点选（复用既有 `handleSwitchAccount`，切回 board 视图）。
3. **面板内嵌零改造**：Settings / Accounts / SyncLogs 组件结构不动，靠 `.panel-page`
   容器 + CSS 覆盖（`.panel-page .modal-mask` 去掉遮罩居中、`.modal` 铺满高度），
   避免给三个面板各加 `embedded` prop 的侵入式改动。
4. **NotesPanel 作为主区页面**：选中记事本时渲染在 `.notes-page`（flex 行容器），
   NotesPanel 的百分比宽基于该容器解析，拖拽/折叠逻辑零改动；未选中时不渲染。
5. **Agent 接入面板（新）**：展示 MCP 配置代码块（复用 AboutPanel 导出的
   `getMcpCommand` / `buildMcpSnippet`）、6 个看板工具表、触发时机 → 动作指引，
   内容与 `mcp_server/AGENT_INSTRUCTIONS.md` 保持一致，纯展示无后端改动。
6. **响应式**：Sidebar 固定 200px；窗口过窄时靠 flex 收缩 + 主区内部横向滚动兜底
   （未做图标化收起——当前窗口最小宽度下 200px 仍可接受，留待后续）。

### 与已有模块的关系

- `main-layout` CSS 类废弃，由 `app-shell`（flex row）+ `main-content`（flex column）替代；
- 工具栏（搜索 / 仓库 / 归属筛选）只在 board 视图渲染，随 nav 条件切换；
- banner（错误 / 同步结果 / 隐藏新任务提示）保持在 `app-shell` 之上全局展示；
- i18n 新增 `app.title` / `sidebar.*`（12 个）/ `agent.*`（30 个），删除被顶栏
  removal 遗留的 6 个无用 key（`topbar.switchAccount*` / `topbar.noAccounts` /
  `topbar.noPat` / `topbar.notLoggedIn` / `btn.settings` / `btn.accounts` / `btn.about`）。

## 接口 / 行为变更

- **账号切换**：顶栏下拉 → Sidebar 账号项点选；激活账号带 ★ 高亮，看板视图高亮当前账号；
- **设置 / 同步日志 / 账号登录**：Modal → 主区内嵌全高页面，点 Sidebar 项进入，
  页内「关闭」/ ✕ 或按 Esc 返回看板；
- **关于**：仍为 Modal，入口移到 Sidebar 底部；
- **Agent 接入**：新增面板，展示 MCP 配置与看板工具说明（只读展示，不连 MCP）；
- **顶栏**：品牌「TaskBoard」+ 总条数 + 上次同步 + 立即同步按钮；
- i18n：中英各 **334** key（原 305 + 新增 42 - 删除 13）。

## 数据 / Schema 变更

无（纯前端布局重构，SQLite / Rust 零改动）。

## 测试 / 验收

- [x] `npx tsc --noEmit` 0 error
- [x] `npm run i18n:check`：zh-CN / en-US 各 334 key，占位符一致
- [x] `npm test`：12 文件 99 例全部通过
- [x] `npm run build`：生产构建成功
- [x] `scripts/check-doc-links.py`：文档链接检查通过
- [x] Sidebar 渲染：分组、账号动态列表、激活高亮、底部关于
- [x] 点击各导航项 → 主区即时切换，无 Modal 弹层
- [x] 面板内嵌后设置/日志/账号内容完整可滚动、可关闭返回
- [x] NotesPanel 在 notes 视图可拖拽调整宽度、可折叠
- [x] 顶栏仅剩品牌/条数/同步时间/同步按钮
- [ ] 真机手动 QA：多账号切换、筛选回归、详情面板、关于弹窗

## 相关链接

- Issue：[#259](https://github.com/ShawnLiuSZ/task-dashboard/issues/259)
- 分支：`feature/issue-259-sidebar-nav`
- 相关代码：`app/src/components/Sidebar.tsx` / `app/src/components/AgentPanel.tsx` /
  `app/src/App.tsx` / `app/src/styles.css`
- 关联文档：[`CHANGELOG.md`](./CHANGELOG.md)（Unreleased 条目）

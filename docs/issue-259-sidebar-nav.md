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
- **记事本收起粒度**（2026-09-16 修正）：收起按钮从「整个面板（36px 导轨）」改为
  **只收起创建列**；`localStorage['notes.collapsed']` 不再被读取（遗留键无害）。
- **记事本宽度拖拽撤销**（2026-09-16）：面板在 notes 视图改为**撑满主内容区**，
  `#202` 的 `.notes-resizer` / `notes.widthPct` 机制整体移除 —— 它是把面板锁在
  25% 宽（进而压扁四列、产生横向滚动条）的直接原因。

## 追加修正：记事本四列并排 + 面板撑满主区（2026-09-16）

### 现象（真机截图）

- 右侧四列被压成 ~18px 的竖条，卡片文字逐字换行；
- 面板只占主区左侧约 1/4，右面大片空白；
- 四列区内部出现**横向滚动条**（可左右拖）；
- 四列在三个窗口尺寸下都不并排：900（`minWidth`）→ 叠成 4 行；1180（`tauri.conf.json` 默认）→ 2+2；1440 → 3+1。

### 根因（两个独立缺陷叠加）

**A. 面板宽度被行内样式锁死 —— 真正的主因**

`NotesPanel` 在 `<aside className="notes-panel">` 上挂了行内
`style={{ flex: '0 0 25%', width: '25%' }}`（`#202` 侧栏拖宽机制的遗留）。行内样式优先级
**高于**样式表规则，所以 `.notes-page .notes-panel { flex: 1 1 auto; width: 100% }` 这层
「整页撑满」覆盖**从未生效过**。实测量（视口 1180×617）：

| 读数 | 值 |
|---|---|
| `.notes-panel` | `245x617`（inline.flex=`0 0 25%`，inline.width=`25%`；应为 980） |
| `.notes-add-col` | `280x575` —— **比面板自己还宽** |
| `.notes-card-cols` | `20x575` / scroll `280x665`，`overflowX=auto`，`scrollLeft=260`（可横滚 ⇒ 横向滚动条） |
| 四列 | `w260@left230/top52 \| w260@left230/top329 \| ...`（固定 260px，叠成 4 行） |

**B. 四列是固定宽度且允许换行**

`.notes-card-cols` 是 `flex-wrap: wrap`，`.note-col` 是**固定** `flex: 0 0 260px`
（`min-width: 220px` / `max-width: 320px`）：四列需 `4×260 + 3×12 = 1076px`，面板撑满后
右侧可用宽也只有 ~960px ⇒ 必然换行。加上容器只写 `overflow-y: auto`，按 CSS 规则
`overflow-x: visible` 会被**计算成 auto**，容器天生带着横向滚动条能力。

### 做法

**先解决 A（去掉行内宽度，面板才能真正撑满），再按看板 `.column` 的既有模式解决 B：**

1. **移除 `#202` 宽度机制**：删掉 `widthPct` / `WIDTH_KEY` / `clampNotesWidthPct` /
   `readNotesWidthPct` / `panelRef` / `pctRef` / 拖拽与键盘处理 / `.notes-resizer` JSX
   与 CSS / `notes.resizeTitle` key。该机制在整页化后早已失效（`.notes-page .notes-resizer`
   是 `display: none`），删掉才能**结构上保证**行内宽度不会被重新挂回来；
2. `.notes-panel` 直接定义成「整页形态」（`flex: 1 1 auto` + `min-width/min-height: 0` +
   flex 列 + `overflow: hidden`），删掉侧栏形态的 `320px 硬锁` / `position: sticky` /
   `max-width: 50%` / `margin` / 圆角阴影，以及 `.notes-page .notes-panel` 里重复的两段覆盖
   （只留 `width/height: 100%`）；
3. `.notes-card-cols`：去掉 `flex-wrap`（默认 nowrap）+ `overflow: hidden` —— 容器自身不滚动；
4. `.note-col`：`flex: 1 1 0` + `min-width: 0`，去掉固定 `flex-basis` / `max-width`
   —— 四列等分可用宽度，永不换行；外观改为看板列样式（灰底圆角列 + 白色胶囊列头）；
5. `.note-col-body`：`flex: 1 1 auto` + `min-height: 0` + `overflow-y: auto`
   —— 纵向滚动下沉到每列内部（与 `.column-body` 一致）；
6. 窄列收缩：`.note-card { min-width: 0 }` + `.note-foot { flex-wrap: wrap }`
   —— 列被压窄时内容换行收缩，而不是把溢出裁掉（裁掉比滚动条更糟，同 `#248` 判据）；
7. 创建列收起时渲染 `.notes-add-rail`（30px 窄导轨）作为 **兄弟节点**，
   不再是藏在四列容器里的按钮 ⇒ 收起创建列与四列完全解耦；空数据时**始终渲染四列**
   （原先整块空状态替换，看起来像「四列消失了」）；
8. 创建列 textarea 用 `.note-textarea-full` 撑满列高，不再走 `useAutoSize`
   （行内 `height` 与 `flex-grow` 语义重叠，且受 260px 上限约束）；
9. 删除死代码与失效 key：CSS 的 `.notes-panel.collapsed` / `.notes-rail*` /
   `.notes-add-col-open` / `.notes-empty*` / `.notes-resizer*` / `.notes-date-list` /
   `.notes-group*`；i18n 的中英各 5 个（`notes.expandTitle` / `notes.collapseTitle` /
   `notes.emptyTitle` / `notes.emptySub` / `notes.resizeTitle` ⇒ 各 **337** key）；
   测试侧删除随功能失效的 `notes-width.test.tsx`（`#202` 拖宽 8 例）。

### 教训：隔离复现页的保真度

首版复现页**只复刻了类名与 DOM 结构，漏掉了组件写在元素上的行内样式**，因此 A 完全没被复现，
只看到 B，得出了「把列改成可收缩就够了」的错误结论 —— 交付后真机四列被压成竖条。

> 复现页必须逐条对齐组件产出的**属性**（`style` / 条件 className / 隐藏元素 / 默认 state），
> 而不只是标签与类名。「行内样式 vs 样式表覆盖」这类缺陷，恰恰只在行内样式存在时才出现。

### 验证

- **修正后的**复现页（补上 `style="flex:0 0 25%;width:25%"`）成功复现 A+B，读数见上表；
- 静态回归 `app/src/components/notes-layout.test.ts`（12 例）新增一组断言锁定 A：
  「`.notes-panel` 元素不得挂行内 `style`」「`widthPct` / `notes-resizer` 机制必须已移除」
  「`.notes-panel` 必须是 `flex: 1 1 auto` + `min-width/min-height: 0`，且不得回到
  固定 `320px` / `position: sticky` / `max-width: 50%`」「`.notes-page .notes-panel` 拉满 100%」；
- **已反向验证**（一轮注入 5 类缺陷，7 条断言失败，还原后 `diff -q` 字节一致、12 例全绿）：
  改回 `flex-wrap: wrap` + 容器 `overflow-y: auto`、`flex: 0 0 260px`、
  四列内引用 `addColCollapsed`、去掉 `.note-card { min-width: 0 }` / `.note-foot { flex-wrap: wrap }`、
  面板改回 `flex: 0 0 320px` + `position: sticky` + `max-width: 50%` 并重新挂上行内宽度。
- ⚠️ **修复后的渲染复核未能完成**：本机沙箱内 Chrome 无头模式已无法启动
  （`sandbox initialization failed` + GPU / network service 反复崩溃，提权未生效），
  Quick Look 渲染同样被拦。A 的结论来自**修正后复现页的读数**与真机截图，修复后的观感
  需在 `npm run tauri dev` 窗口复核（HMR 即时生效）。

### 第三轮修正（同日，用户定稿交互）：看板列模式 —— 固定列宽 + 横向滚动

用户真机复核后把交互定为：四列**固定宽度**（与最左侧创建列同宽），列放不下时出**有意**的
横向滚动条（对齐看板任务列的交互）；记事卡片不再用左侧色条区分优先级。

- **取代前两轮的**「四列 `flex: 1 1 0` 等分 + 容器 `overflow: hidden` 不滚动」：等分布局在
  容器被压窄时仍会把列压扁（竖条现象的形态）；**固定列宽 + 横向滚动**从结构上消除了这种退化
  —— 列宽不再依赖容器，压不出竖条；
- `.notes-panel` 定义 `--notes-col-w: 280px`，`.notes-add-col` 与 `.note-col` **共用同一变量**
  ⇒ 天然同宽（改一处即可整体调宽）；
- `.notes-card-cols`：`overflow-x: auto`（显式声明，有意滚动）+ `overflow-y: hidden`，不换行；
- `.note-card` 删除 `::before` 左侧色条（`--note-accent` 此后仅剩卡片底部标签圆点在使用），
  内边距对称化 `8px 12px 6px`；
- 面板撑满主区、收起只作用于创建列、创建列 textarea 撑满列高等前两轮结论**不变**。

验证：`notes-layout.test.ts` 13 例。新增三条断言并**反向验证**（一轮注入 5 处缺陷：
列回 `flex: 1 1 0`、创建列换宽度、容器失去显式 `overflow-x`、色条回归、删掉宽度变量
⇒ 3 条新断言全部失败；还原后 `diff -q` 字节一致、13 例全绿）。
⚠️ 教训：注入脚本里的 `overflow-x: auto; overflow-y: hidden;` 片段**先命中了文件里另一条规则**
（`.panel-page` 一族），导致第一轮反向验证「全绿」是假的——注入必须带选择器锚点，
并断言每一处替换都真的命中。

### 第四轮修正（同日）：列包围框不可见 + 宽窗口死空间

真机复核发现两个新问题：

1. **四列的包围框根本看不见** —— `.notes-panel` 与 `.note-col` 同为 `--surface-2`，
   列和页面底色相同 ⇒ 列「融进」页面，看起来就是卡片悬在空白里，
   用户只能在脑内补出列的范围（黄框/蓝框上边距「不一致」其实是手画框围着不同内容）。
   看板的做法是**页面底 `--bg` 上放 `--surface-2` 列**，对比清晰。
2. **宽窗口右侧死空间** —— 固定 280px 的四列在 ~2100px 窗口下只占一半宽，
   右侧空白一大片（绿框宽度 ≠ 内容宽度）。

做法：

- `.notes-panel` 背景改 `var(--bg)`（与看板页面一致）⇒ `--surface-2` 列的包围框可见；
- `.note-col` 改 `flex: 1 1 0` + `min-width: var(--notes-col-w)`：
  宽窗口四列**等分撑满**（不留死空间），窄窗口**不低于 280px**（压不扁，超出横向滚动）
  —— 同时满足上一轮「列宽比较固定 + 横向滚动」与本轮「宽度与面板一致」；
- 创建列改成与四列**同款包围框**（`--surface-2` 圆角块），去掉 `border-right` 分隔线；
  `.notes-body` 统一 `gap: 12px; padding: 10px`，五列间距与内边距完全一致；
- `.notes-card-cols` 显式 `align-items: stretch`（列全高，与创建列等高）；
- 空列提示改看板 `.empty` 同款灰色文字（去虚线框——列本身就是包围框）。

验证：`notes-layout.test.ts` 16 例；新增 4 条断言并**反向验证**（面板底色回 surface-2、
列失去最小宽度、创建列回 border-right、空列回虚线框 ⇒ 4 条全部失败，
还原后 `diff -q` 字节一致、16 例全绿）。

## 数据 / Schema 变更

无（纯前端布局重构，SQLite / Rust 零改动）。

## 测试 / 验收

- [x] `npx tsc --noEmit` 0 error
- [x] `npm run i18n:check`：zh-CN / en-US 各 **337** key（含追加修正删掉的 5 个），占位符一致
- [x] `npm test`：12 文件 105 例全部通过（含新增 `notes-layout.test.ts` 12 例；删除失效的 `notes-width.test.tsx` 8 例）
- [x] `npm run build`：生产构建成功
- [x] `scripts/check-doc-links.py`：文档链接检查通过
- [x] `npx prettier --check`：本次新增 / 改动的文件全部合规（`NotesPanel.tsx` 的不合规为既有债，见「已知技术债」）
- [x] Sidebar 渲染：分组、账号动态列表、激活高亮、底部关于
- [x] 点击各导航项 → 主区即时切换，无 Modal 弹层
- [x] 面板内嵌后设置/日志/账号内容完整可滚动、可关闭返回
- [x] NotesPanel 收起按钮只收起**创建列**（见追加修正）；宽度拖拽机制已移除
- [x] 四列（紧急/高/中/低）固定为等宽四列，容器不换行、不滚动（见追加修正）
- [x] 顶栏仅剩品牌/条数/同步时间/同步按钮
- [ ] **真机渲染复核**：四列并排 + 面板撑满（沙箱内 Chrome 无头不可用，需在 `npm run tauri dev` 窗口确认）
- [ ] 真机手动 QA：多账号切换、筛选回归、详情面板、关于弹窗

## 相关链接

- Issue：[#259](https://github.com/ShawnLiuSZ/task-dashboard/issues/259)
- 分支：`feature/issue-259-sidebar-nav`
- 相关代码：`app/src/components/Sidebar.tsx` / `app/src/components/AgentPanel.tsx` /
  `app/src/components/NotesPanel.tsx` / `app/src/App.tsx` / `app/src/styles.css`
- 回归测试：`app/src/components/notes-layout.test.ts`（四列布局 + 面板撑满，12 例）
- 关联文档：[`CHANGELOG.md`](./CHANGELOG.md)（Unreleased 条目）

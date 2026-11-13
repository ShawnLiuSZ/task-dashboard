# 开发交接单 · 界面设计方案落地（B1 + B2 + B5）

> **状态**：🟡 待认领 · **交付对象**：前端开发 · **范围**：纯前端（React + TS + CSS）· **后端 / DB / MCP / Tauri command 零改动**
>
> **一句话**：**不动任何视觉令牌**，只做三件事 —— 导航归位、卡片信息层级重构、栅格对齐。设计理由见 [`ui-design-proposal.md`](./ui-design-proposal.md)，目标长相见可交互原型 `.workbuddy/ui-review/taskboard-ui-proposal.html`（本地审查产物，未入库）。
>
> ⚠️ **本期不含** B3 拖拽 / B4 详情统一 / B6 快捷键 —— 它们需单独评审（尤其 B4 会推翻 #526 / #527 的双形态裁定）。

---

## 0. 可直接复制的一段式任务描述

> 【前端改造】TaskBoard 界面易用性优化，纯前端、零后端改动。① 侧栏补「看板」入口并分「工作区 / 账号 / 系统」三组，任意视图都要有且仅有一个选中项；② 任务卡片从 6 行收敛为 3 行，标题 12px/400 → 14px/600，仓库编号降为 11px 中性文字 + 相对时间，创建人与分配人相同只显示一次，单卡彩色元素 ≤ 2；③ 去掉 `.board-wrap` 与 `.board` 叠加的左右 padding，统一 16px 内容栅格，列宽改弹性让 1440 宽下四列一屏看全，工具条底色改 `--surface-2`。**红线**：不改 `:root` / 深色块 / 令牌名 / 三段式焦点环，不新增 `--*-bg` 令牌，不用 `color-mix()`，不动 `theme.ts` / `fontPrefs.ts` / DB / MCP / GitHub 同步方向。验收：8 条清单见交接单第 5 节，需 Chrome 无头用真实 `styles.css` 实测布局；纯 CSS 断言必须做反向验证。

---

## 1. 先读什么（按顺序）

| # | 文档 / 产物 | 看什么 |
|---|---|---|
| 1 | [`ui-design-proposal.md`](./ui-design-proposal.md) | **为什么改**、量化基线、审查结论、组件规格、交互矩阵 |
| 2 | `.workbuddy/ui-review/taskboard-ui-proposal.html` | **改成什么样**：现状 ↔ 提案、浅色 ↔ 深色切换，卡片可拖 / 可搜索 / 可改状态 |
| 3 | [`v0.8.9-ui-visual-refresh.md`](./v0.8.9-ui-visual-refresh.md) | **不能破坏的基线**：令牌体系、对比度、三段式焦点环、遗留风险 L1 / L3 |
| 4 | [`../AGENTS.md`](../AGENTS.md) §2 / §5 / §6 | 仓库硬约束、知识库文档规范、分支与 PR 流程 |

---

## 2. 任务卡

| 项 | 内容 |
|---|---|
| 优先级 | 🟢 高（视觉收益最大、风险最低的一批） |
| 建议批次 | B1 → B2 → B5，**一个 PR 或三个可独立回滚的 commit** |
| 涉及文件 | `app/src/components/Sidebar.tsx`、`TaskCard.tsx`、`Board.tsx`、`app/src/styles.css`、相关 `*.test.ts(x)` |
| 不涉及 | `app/src-tauri/**`、`mcp_server/**`、`scripts/check-mcp-columns.py`、数据库、i18n 词条（**不新增文案 key**） |
| 前置依赖 | 无；与设计提案文档同步交付，不需要后端配合 |
| 验收方式 | 第 5 节 8 条可勾选清单 + 第 6 节全量检查命令 |
| 回滚 | 纯前端、无 DB 迁移 ⇒ 单个 commit `git revert` 即可 |

### 2.1 批次依赖

```mermaid
flowchart LR
  A[B1 导航归位] --> D[布局实测]
  B[B2 卡片重构] --> D
  C[B5 栅格对齐] --> D
  D --> E[styles.test.ts 断言]
  E --> F[全量检查门禁]
  F --> G[PR]
  B -. 影响 .card 高度 .-> C
```

> B1 与 B2 相互独立；B5 的栅格值会受 B2 卡片高度影响 ⇒ **B5 放在 B2 之后实测**。三者共同汇到「真实 CSS 布局实测」这一个验收门。

---

## 3. 改动清单

| # | 状态 | 文件 | 改什么 |
|---|---|---|---|
| 1 | ⬜ | `components/Sidebar.tsx` | 新增「看板」`NavItem` + 三段分组标题 + `aria-current="page"` |
| 2 | ⬜ | `components/TaskCard.tsx` | 卡片 markup 6 行 → 3 行；标题 14px/600；字段合并；彩色预算 ≤ 2 |
| 3 | ⬜ | `components/Board.tsx` | 列宽弹性化；空列补引导；`role="list"` 子元素语义修正（L1） |
| 4 | ⬜ | `styles.css` | 去掉叠加 padding；`.toolbar` → `--surface-2`；新增卡片 / 栅格规则（**只引用既有令牌**） |
| 5 | ⬜ | `styles.test.ts` / `sidebar.test.tsx` / `board.test.tsx` | 补断言，守「标题层级 / 栅格 / 侧栏 active 唯一」 |
| 6 | ⬜ | `docs/issue-557-*.md` | 知识库文档（对应 [issue #557](https://github.com/ShawnLiuSZ/task-dashboard/issues/557)，见第 8 节） |
| 7 | ⬜ | `docs/CHANGELOG.md` / `CHANGELOG.en.md` | 版本条目 + 指向 KB 文档链接 |

---

## 4. 逐批次实现说明

### 4.1 B1 · 导航归位（`Sidebar.tsx`）

1. `NavKey` 已含 `'board'`，**不要改类型定义**，只补一个渲染分支。
2. 在第一个 `sidebar-group` 最前面加「看板」`NavItem`，`active={nav === 'board'}`；图标用现有 `Icon` 组件，形状建议「四列看板」（两个矩形 + 一个短矩形）。
3. 三段分组各加标题：工作区（看板 / 备忘录 / 任务会话）、账号（现有账号列表 + 添加账号）、系统（设置 / Agent 接入 / 同步日志）。标题可直接复用 `.sidebar-group-title`；注意「账号」组已有 `.sidebar-group-head`，标题要放进 head 行左侧，别叠出双份 padding。
4. 各设置类面板内部的 `onClose={() => setNav('board')}` **保留**，不要删（它们是兜底，侧栏入口是新增的主路径）。
5. active 项加 `aria-current="page"`；聚合视图下账号项不高亮的既有逻辑（`viewMode === 'all'` 判断）不要动。

**验收点**：任意视图下侧栏有且仅有一个 active 项；从设置页点「看板」一步返回。

### 4.2 B2 · 卡片重构（`TaskCard.tsx` + `styles.css`）

目标结构（3 行，示意，不要照抄为最终 JSX）：

```
.card
├─ 身份行：repo #num（11px / --text-3 纯文字）          右：相对时间
├─ 标题  ：14px / 600 / --text / 行高 1.45 / 2 行截断
└─ 信息行：@assignee  [≤1 个彩色信号]  PR #N（纯文字）  ⋯（hover 显现）
```

具体规则：

1. **标题** `.card-title` 由 12px/400 改 **14px/600**；`-webkit-line-clamp: 2` 两行截断，须带 `display: -webkit-box` + `-webkit-box-orient: vertical`。
2. **身份行**：`.repo` 淡彩 chip 与 `.num` 合并为一行纯文字（11px `--text-2` / `--text-3`），右侧显示相对时间（复用 `utils/format.ts` 已有能力，**不新增依赖**）。
3. **字段合并**：创建人与分配人相同 ⇒ 只显示一次；`createdAt` / `updatedAt` 只保留一个可读时间；`sessionId` / `candidateTag` / `mentionBadge` 等次要信息**收进详情面板**，卡片上最多留 1 个彩色信号徽章。
4. **彩色预算 ≤ 2**：颜色只给「@我 / 无人认领 / 待确认关闭」这类需立刻决策的信号；PR / 评论链接去掉底色，用 `--info` 文字 + hover 下划线（形状通道，v0.8.9 已验证不破 AA）。「我的」红左边框保留但算进预算。
5. **⋯ 操作按钮**：默认 `opacity: 0`，`:hover` / `:focus-within` / 选中态显现，`prefers-reduced-motion` 下去掉 transition；键盘必须可达。
6. ⚠️ **不可回归的既有逻辑**（改 markup 时最容易丢）：
   - 写操作仍用 `task.issueKey`，**不是** `taskIdentity(task)`；后者只用于渲染 / 选中。
   - `onOpenInNewWindow` 按钮必须 `e.stopPropagation()`，否则同时开 modal 与独立窗。
   - 卡片 `role="button"` + `tabIndex={0}` + Enter/Space 绑定保留。
   - 认领 `ConfirmDialog` 的外层 `stopPropagation` 保留。
   - `isClosedIssueState` 判 closed（**禁止**写死 `=== 'closed'`）。
   - `prs` 数组判「非空」而非「字段存在」。

**验收点**：卡片高度 ≤ 120px（原型实测 113px）；标题不小于卡内任何其他文本；单卡彩色元素 ≤ 2。

### 4.3 B5 · 栅格对齐（`styles.css` + `Board.tsx`）

1. `.board-wrap` 去掉左右 padding（只保留底部），`.board` 保持左右 16px ⇒ 消除 32px 叠加。
2. 统一 **16px 内容栅格**：工具条内容左缘 = 首列卡片左缘（原型实测误差 0px）。列容器与列内 padding 的组合值要等于工具条 padding，别只改一处。
3. `.column` 由 `flex: 0 0 320px` 改 `flex: 1 1 0` + `min-width: 240px` / `max-width: 360px` ⇒ 1440 宽下 4 列各约 280–295px，一屏看全；列数 > 4 时仍可横向滚动。
4. `.toolbar` 背景由 `--surface` 改 `--surface-2`，与顶栏拉开层级；搜索框补图标与 kbd 提示位（**B6 才接快捷键，本期只留视觉位**）。
5. 空列 `.board .empty` 补图标 + 「从其他列拖一张过来」文案（B3 落地前文案不要暗示拖拽已可用 —— 本期改为「暂无任务」即可）。
6. ⚠️ `.column-body` 是 `overflow-y: auto` 容器 ⇒ 卡片**不要加 `box-shadow` 浮起**（会被裁成糊边，v0.8.9 L10 已驳回）；焦点环继续用 `outline-offset: -2px`。

**验收点**：1440×900 下四列完整可见、无横向滚动条；工具条与卡片左缘误差 ≤ 1px。

---

## 5. 验收清单（逐项勾选）

- [ ] 1. 1440×900 窗口下四态看板 4 列全部完整可见，无横向滚动条；工具条输入区与首列卡片左缘对齐（误差 ≤ 1px）。
- [ ] 2. `.card-title` 计算样式为 14px / 600，且不小于卡片内任何其他文本；卡片高度 ≤ 120px（2 行标题）。
- [ ] 3. 单卡同时出现的彩色元素 ≤ 2；所有文字 / 底色组合沿用既有令牌，浅深两套主题实测对比度均 ≥ 4.5:1。
- [ ] 4. 侧栏在任意视图下有且仅有一个 active 项；从设置页点「看板」一步返回。
- [ ] 5. 卡片内 `issueKey` / `stopPropagation` / 键盘可达 / `isClosedIssueState` / `prs` 非空判定全部未回归（逐项对照 §4.2 第 6 条）。
- [ ] 6. 焦点环沿用三段式且在 `overflow-y: auto` 的列容器内不被裁；点击目标 ≥ 24×24。
- [ ] 7. 浅色 / 深色两套主题都用 Chrome 无头 + **真实 `styles.css`** 实测，无亮斑、无文字失配、无横向溢出。
- [ ] 8. 第 6 节全量检查命令全绿；新增的纯 CSS 断言完成「备份 → 注入缺陷变红 → 还原全绿」三步反向验证。

---

## 6. 提交前必跑的检查

```bash
cd app
npx tsc --noEmit
npm test
npm run build
npm run i18n:check
npm run lint
npx prettier --check "src/**/*.{ts,tsx,css}"
cd ..
python3 scripts/check-versions.py
python3 scripts/check-doc-links.py
python3 scripts/check-mcp-columns.py
python3 scripts/check-capabilities.py
python3 -m unittest discover -s scripts -p 'test_*.py'
```

Rust 侧本期无改动，但项目提交前校验清单要求全跑（尤其 `cargo fmt --check` 必须本地跑，CI 的 Clippy job 内含 fmt）：

```bash
cargo fmt --check --manifest-path app/src-tauri/Cargo.toml
cargo clippy --manifest-path app/src-tauri/Cargo.toml --all-targets -p taskboard -- -D warnings
cargo test --manifest-path app/src-tauri/Cargo.toml
```

⚠️ 判结果**只看退出码**，不要 `grep` 输出文本；`Rust 必须全 targets`。

---

## 7. 断言与验证纪律（仓库踩坑签名）

1. **纯 CSS 缺陷不能只靠源码正则**：布局 / 截断 / 溢出必须 Chrome 无头 + 真实 `styles.css` + 复刻真实 DOM 实测 `getBoundingClientRect` / `scrollHeight`。
2. **静态扫描先剥 `/* */` 注释**（注释污染会双向误判）；扫 `color:` 要加左边界 `(?:^|[;{\s])color\s*:`，否则命中 `border-color` / `background-color`；颜色类令牌**显式白名单**，不靠命名启发式。
3. **反向验证三步缺一不可**：备份 → 注入缺陷确认变红 → 还原确认全绿；脚本异常可能导致「第一处改动根本没写进去」却误判已修复。
4. **断言落在真实数据流 / 真实渲染产物上**：手工字面量枚举对「转换丢字段」无感；组件结构用 `renderToStaticMarkup` + 精确 JSX 片段锚点（裸词会命中注释）。
5. **改 `#[cfg(test)]` / `mod tests` 后立即跑 clippy --all-targets**，否则 `cargo test` 全绿也可能漏掉丢失的 `#[test]`。
6. 详见 [`methodology-assertion-strength-audit.md`](./methodology-assertion-strength-audit.md)。

---

## 8. 流程与交付物（`AGENTS.md` 硬约束）

1. ✅ **issue 已创建：[#557](https://github.com/ShawnLiuSZ/task-dashboard/issues/557)**；文档名带 `issue-557`、commit / 注释引 `#557`，形成 issue ↔ 分支 ↔ 文档 ↔ CHANGELOG 四向追溯。
2. 分支：`feature/issue-557-ui-usability`（从 `main` 新开，不在 `main` 上直接开发）。
3. 知识库文档 `docs/issue-557-*.md`，必填背景 / 方案 / 接口行为变更 / 测试验收 / 相关链接；**新增后必须在 [`CONTRIBUTING.md`](../CONTRIBUTING.md) 文档索引补反链**，否则 `check-doc-links.py` 报孤岛。
4. 中英 CHANGELOG 同步追加版本条目 + 指向 KB 文档的链接（CHANGELOG 版本块是列表项 `- **vX.Y.Z（date）— 标题（#issue）**`，**不是** `##` 标题）。
5. 文档**不写行号**，一律用「选择器名 + 令牌名」定位。

---

## 9. 红线（明确不许碰）

| # | 不许做 | 原因 |
|---|---|---|
| R1 | 改 `:root` / `[data-theme='dark']` 的既有值与变量名 | 运行时动态引用 + `styles.test.ts` 断言；深色块漏补全会出现亮斑、对比度崩 |
| R2 | 新增 `--*-bg` 背景令牌 | 项目要求同时给 `--text` / `--text-2` / `--text-3` / `--accent` 四列字色矩阵；本方案复用既有配对即可 |
| R3 | 用 `color-mix()` / `oklab()` / `oklch()` | `build.target` = chrome105 / safari13，Vite 不降级 ⇒ 声明**整条被丢弃** |
| R4 | 动三段式 `:focus` / `:focus-visible` 焦点环、把环改成半透明 | 真实下限 Safari 15（旧引擎未知伪类会让整条选择器失效）；半透明环数学上到不了 3:1 |
| R5 | 给滚动容器内卡片加 `box-shadow` 浮起 | `overflow-y: auto` 会裁掉阴影成糊边（v0.8.9 L10 已实测驳回） |
| R6 | 动 `theme.ts` / `fontPrefs.ts` / 根字号 `calc` 接线 | 字号偏好会失效、18px 档视觉缩放退化 |
| R7 | 改 DB schema / MCP 列名 / Tauri command | 本期零后端改动；改 `tasks` 列会触发 `check-mcp-columns.py` 与迁移链路 |
| R8 | 改 GitHub 同步方向或写回逻辑 | 同步仍只读；写回仅限 UI 确认框触发的显式通道 |
| R9 | 本期顺手做 B3 拖拽 / B4 详情统一 / B6 快捷键 | B4 涉及 #526 / #527 双形态裁定，需主理人拍板；混做会让 review 面失控 |
| R10 | 新增 npm / crate 依赖 | `AGENTS.md` §2.5；前端零运行时依赖 |

---

## 10. 风险与回滚

| 风险 | 缓解 | 回滚点 |
|---|---|---|
| 卡片减行后用户找不到创建人 / 会话 / 创建时间 | 全部保留在详情面板，卡片只折叠；上线前用真实库截图逐字段核对 | 回退 `TaskCard.tsx` 单个 commit |
| 14px 标题在 320→280px 列宽下换行增多 | 2 行截断；用真实长标题实测高度 ≤ 120px | 调 `--radius-*` 无关，改 `min-width` 或标题字号 |
| 弹性列宽在超多列视图下挤压 | `min-width: 240px` + 超 4 列仍横向滚动 | 回退 `.column` 的 `flex` 声明 |
| 侧栏新项让 active 态出现两个 | 单测锁「任意 nav 下 active 计数 == 1」 | 回退 `Sidebar.tsx` |
| 深色主题沿用浅色值 | 新增规则**只引用既有令牌**，不写死 hex；深色截图逐像素复核 | 逐条回退 |

**整体回滚**：三个批次纯前端、无 DB 迁移 / 无 API / 无数据格式变化 ⇒ 单个 `git revert` 即可。

---

## 11. 相关链接

- [GitHub issue #557](https://github.com/ShawnLiuSZ/task-dashboard/issues/557) —— 本交接单对应的任务追踪（状态 / 评论 / 验收勾选）
- [`ui-design-proposal.md`](./ui-design-proposal.md) —— 设计事实源：审查结论、组件规格、交互矩阵、验收标准
- [`v0.8.9-ui-visual-refresh.md`](./v0.8.9-ui-visual-refresh.md) —— 必须保留的视觉基线（令牌 / 对比度 / 焦点环 / 遗留风险）
- [`issue-527-task-detail-window.md`](./issue-527-task-detail-window.md) —— B4 待评审时涉及的既有双形态决策
- [`issue-516-sidebar-open-count-and-account-name.md`](./issue-516-sidebar-open-count-and-account-name.md) —— 侧栏账号分组口径（改动时别破坏）
- [`methodology-assertion-strength-audit.md`](./methodology-assertion-strength-audit.md) —— 断言强度审计与反向验证纪律
- [`CHANGELOG.md`](./CHANGELOG.md) —— 落地时追加版本条目
- 仓库规范：[`AGENTS.md`](../AGENTS.md) · [`CONTRIBUTING.md`](../CONTRIBUTING.md) 文档索引
- 本地审查产物（**未入库**）：`.workbuddy/ui-review/taskboard-ui-proposal.html` 及 `current-*.png` / `proposal-*.png`

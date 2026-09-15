# #248 同步日志表格缺横向滚动条 —— 右侧列被静默裁切

## 背景 / 动机

同步日志弹窗（`SyncLogsPanel`）的两个页签——「同步记录」与「API 明细」——在默认窗口
（1180×760，`minWidth: 900`）下都会把**最右侧一列**裁掉：

| 页签 | 被裁掉的列 | 后果 |
|---|---|---|
| 同步记录 | 错误 | 错误摘要与其展开入口不可用 |
| API 明细 | 明细 | 「查看」按钮只剩一条边，请求/返回参数打不开 |

弹窗宽度固定 720px（`.sync-logs-modal`），内容区 680px；表格的最小内容宽度会超过这个值，
而容器用的是 `overflow: hidden`，溢出部分被**静默裁掉**：用户既看不到那一列，
也拿不到任何「还有内容」的提示——没有滚动条、没有截断标记。
错误列与明细列恰好都是 `#161` / `#235` 新增的**交互入口**，因此在默认窗口下这两个功能直接不可用。

对应 issue：[#248](https://github.com/ShawnLiuSZ/task-dashboard/issues/248)。

## 设计 / 方案

### 根因：两个缺陷叠加

`app/src/styles.css` 原实现：

```css
.sync-logs-body { max-height: 50vh; overflow-y: auto; }
.sync-logs-table-wrap { border: ...; border-radius: 8px; overflow: hidden; }
```

**缺陷 1 —— `overflow: hidden` 裁切且不产生滚动条。**
表格的 used width 是 `max(100%, min-content)`。`.sync-logs-table th` 自带 `white-space: nowrap`，
多数 `td` 带 `.nowrap`，目标列 `.mono` 还有 `max-width: 320px` —— `min-content` 必然超过 680px，
于是表格溢出容器，被 `hidden` 一刀切掉。

**缺陷 2 —— 容器没有高度约束，横向滚动条会被推到不可达位置。**
纵向滚动实际发生在 `.sync-logs-body`（`max-height: 50vh`），
`.sync-logs-table-wrap` 作为普通块级元素会随表格长到**完整高度**。
因此只把 `overflow-x` 改成 `auto` 并不够：横向滚动条会渲染在整张表格的底部。
隔离复现实测（40 行日志）：wrap 高 1335px，而 `.sync-logs-body` 可视区仅 337px，
横向滚动条落在可视区下方 **1029px**，必须先纵向滚到底才能触达 —— 等于没修。

### 决策 1：滚动职责收敛到 `.sync-logs-table-wrap`

```css
.sync-logs-body {
  max-height: 50vh;
  overflow-y: auto;
  display: flex;            /* 新增 */
  flex-direction: column;   /* 新增 */
  min-height: 0;            /* 新增 */
}

.sync-logs-table-wrap {
  overflow: auto;   /* overflow: hidden → auto */
  min-height: 0;    /* 新增：允许在 flex 列中收缩 */
}

.sync-logs-filter { flex-shrink: 0; }  /* 新增：筛选行不被挤扁 */
```

`.sync-logs-body` 保留 `overflow-y: auto`，作为**非表格状态**（错误条 / 加载中 / 空列表）的兜底；
表格存在时，flex 收缩使表格容器恰好占满可视高度，于是**横纵两个滚动条同处一个视口**，
横向滚动条无需先纵向滚到底即可触达。

`min-height: 0` 是必需项：flex 子项的 `min-height` 默认 `auto`，会把内容高度当作最小值、
**拒绝收缩**；漏掉它则容器仍被撑到完整高度，横向滚动条回到不可达位置。

### 决策 2：为什么不把 `overflow-x: auto` 加在 `.sync-logs-body` 上

外层宽度本身等于弹窗内容区宽度，溢出的是**表格自己**而非外层，所以外层永远没有横向溢出可滚，
加在 `body` 上是空转。滚动必须发生在**紧贴表格的那一层**。

### 决策 3：保留「表格比容器宽」，不压缩列宽

可选方案是收窄列宽（放宽 `target` 截断、允许换行）让表格塞进 680px。放弃原因：
错误全文与 API 请求/返回参数本身就需要横向空间，强行收窄只会让摘要更不可读；
且 issue 诉求明确是「给出横向滚动条」。横向滚动是宽表面板的正确交互；
若要进一步优化列宽，应另开 issue。

### 决策 4：两个页签共用一个容器类

「同步记录」与「API 明细」都渲染 `.sync-logs-table-wrap`，因此一处 CSS 修复同时覆盖两个页签。
这层「共用」关系是修复面成立的前提，已在回归测试中显式断言。

## 接口 / 行为变更

纯 CSS 改动，无 TS / Rust / i18n / MCP / Tauri command 变更：

| 项 | 变更前 | 变更后 |
|---|---|---|
| 表格容器 `overflow-x` | `hidden` | `auto` |
| 溢出列 | 被裁切，无滚动条 | 可横向滚动 |
| 纵向滚动承担者 | `.sync-logs-body` | `.sync-logs-table-wrap`（表格存在时） |
| 筛选行（API 明细） | 随表格一起滚出可视区 | 固定在表格上方 |
| 表格未溢出时 | 无滚动条 | 无滚动条（行为不变） |

## 数据 / Schema 变更

无。未触碰 SQLite schema，无需迁移。

## 测试 / 验收

### 已跑的检查

| 检查 | 结果 |
|---|---|
| `npx tsc --noEmit` | 0 error |
| `npm test` | 11 文件 88 例通过（新增 `src/styles.test.ts` 4 例） |
| `npx eslint src/styles.test.ts src/vite-env.d.ts vitest.config.ts` | 0 problem |
| `npm run build` | ✅ `dist/assets/index-BKrHbFZ_.css` 27.93 kB |
| `npm run i18n:check` | 中英各 302 key 一致 |
| `python3 scripts/check-doc-links.py` | ✅（本文件新增后仍须通过） |

> `npm run lint` / `npm run format:check` 在**改动前**即失败（`src/i18n/index.tsx` 17 条
> `react-refresh` warning；30 个文件不符合 prettier，含 `src/main.tsx`、`src/styles.css` 等
> 本次未触碰的文件），属 #246 新增 CI 的既有问题，与本 issue 无关；本次只保证**新增文件**
> 自身干净（`styles.css` 在 HEAD 上就不符合 prettier，重排它会产生上千行无关改动，故不动）。

### 回归测试（`app/src/styles.test.ts`）

该缺陷是纯 CSS 表现问题，而 vitest 配置为 `environment: "node"`（无 DOM、无布局引擎），
无法做渲染断言；因此沿用仓库既有 `scripts/check-mcp-columns.py` /
`scripts/check-doc-links.py` 的思路，对 `styles.css` 的**源码声明**做静态断言：

1. `.sync-logs-table-wrap` 不得出现 `overflow: hidden`，且须为 `overflow: auto`
2. 容器须有 `min-height: 0`；`.sync-logs-body` 须为 flex 纵向列
3. `.sync-logs-filter` 须 `flex-shrink: 0`
4. `SyncLogsPanel.tsx` 中 `sync-logs-table-wrap` 恰好出现 2 次（保证修复覆盖两个页签）

**反向验证**：把 `overflow` 改回 `hidden`，测试立刻失败（2 failed）；还原后全绿。
断言前会剥离 CSS 注释，避免注释里提到写法就误命中。

#### 测试基建变更（随本次一并引入）

| 文件 | 变更 | 原因 |
|---|---|---|
| `app/src/styles.test.ts` | 新增 | 静态断言 `styles.css` 声明 |
| `app/src/vite-env.d.ts` | 新增（`/// <reference types="vite/client" />`） | 给 `?raw` 导入提供类型，且**不引入 `@types/node`** |
| `app/vitest.config.ts` | 新增 `css: true` | 默认 `css: false` 会把 CSS 模块打桩成**空串**，`styles.css?raw` 取不到内容（此坑已实测） |

**为什么不用 `node:fs` 读文件**：那需要 `@types/node`，而它不是本仓库的依赖（`npm ci` 后
`node_modules/@types/` 下没有 `node`），`tsc --noEmit` 会报 3 条 TS2307 —— CI 上已实际失败过一次。
改用 Vite 原生 `?raw` 导入后**零新增依赖**，且不存在本地/CI 环境差异
（此前本地能过只是因为 node_modules 里残留了 extraneous 的 `@types/node`，`npm ci` 一跑就暴露）。

### 视觉验证（隔离复现页）

弹窗取数依赖 Tauri 命令，无法直接在浏览器里跑真实组件；因此搭了隔离复现页
（同一份 `styles.css` + 复刻的 DOM 结构），按默认窗口 1180×760 截图比对。
读数（Chrome 无头，经典滚动条占 14px）：

| 场景 | 变更前 | 变更后 |
|---|---|---|
| API 明细（9 行） | overflowX=`hidden`；wrap client=665 / scroll=692（溢出 27px），「明细」列被裁 | overflowX=`auto`；可滚 27px，滚到最右「查看」按钮完整可见 |
| 同步记录（7 行） | 溢出 22px，「错误」列被裁 | 可滚 22px，「错误」列可达 |
| API 明细（40 行，纵向溢出） | wrap 高 **1335px** 且不可纵向滚动；横向滚动条位于可视区下方 **1029px** | wrap client=292 / scroll=1335（纵向可滚）；wrap 底边 = 337px = 可视高度，横向滚动条**始终可达** |

> macOS 上 WebView 使用 overlay 滚动条（不占宽度），因此真机溢出量略小于上表的复现值；
> 「溢出 > 0」与「原先完全没有滚动条」这两个结论不受影响。

### 验收清单

1. 「API 明细」出现横向滚动条，滚到最右可完整看到「明细」列的「查看」按钮
2. 「同步记录」出现横向滚动条，滚到最右可完整看到「错误」列
3. 日志量大（纵向溢出）时，横向滚动条固定在该滚动区底边，无需先纵向滚到底
4. 表格未溢出时不出现多余的横向滚动条
5. 纵向滚动行为不变，弹窗标题与底部按钮不被挤出
6. 表格自身纵向滚动不再依赖外层 `.sync-logs-body`，筛选行固定可见

## 相关链接

- issue：[#248](https://github.com/ShawnLiuSZ/task-dashboard/issues/248)
- 分支：`fix/issue-248-synclogs-hscroll`
- CHANGELOG：[`CHANGELOG.md`](./CHANGELOG.md) Unreleased 段
- 相邻功能：[`issue-235-in-app-api-log.md`](./issue-235-in-app-api-log.md)（明细列 / 双页签的来源）

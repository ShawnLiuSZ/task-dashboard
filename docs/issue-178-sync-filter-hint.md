# Issue 178 — 同步后新任务被工具栏筛选隐藏（看似看板未刷新）

## 背景 / 动机

点顶栏同步按钮，横幅数字符合预期（`sync_logs` 证实数据已落库），但看板看不出变化；重启 App 后新任务出现。

根因：重启是唯一会清空顶部筛选（搜索关键词 / 仓库 / 归属）的地方。`doSync` 同步后正确重查，但新增/变更的任务若命中当时的筛选条件会被过滤不可见——看起来像没刷新，重启清掉筛选后"自愈"。

对应 GitHub issue：[#178](https://github.com/ShawnLiuSZ/task-dashboard/issues/178)。

## 设计 / 方案

同步前后 diff，精确算出"本次新变且被当前筛选藏住"的任务数，藏住才提示：

- 新增纯函数模块 `app/src/utils/syncHint.ts`（可单测）：
  - `snapshotTasks`：同步前按 `issueKey → updatedAt` 快照；
  - `diffChangedTasks`：新 key 算新增，`updatedAt` 变大算变更（null 按 0）；
  - `isHiddenByFilters`：与 `visible` memo 同构（仓库 / `repo#number`/标题关键词 / 归属任一命中即藏住）；
  - `countHiddenChanged`：无任何筛选时恒 0（fast path）。
- `App.tsx doSync`：同步前快照 → 同步 → 重查 → `loadSettings` → diff → `hiddenAfterSync` 状态。
  - 归属筛选是后端维度：生效时同步前后各拉一次无归属全量做 diff 基准（仅手动同步时，本地 SQLite ms 级），否则后端筛掉的旧任务会被误判新增。
- UI：琥珀色 `banner.warn` + 数量 + 复用 `btn.reset` 一键清除；手动改筛选后提示过期清零。
- 顺带修：旧工具栏重置只清前端 state，不断后端归属筛选——统一走 `clearAllFilters`（清 state + 重查无归属全量）。

与已有模块的关系：只动前端展示层；Rust/MCP/DB/sync 均不动（写库链路经排查无问题）。

## 接口 / 行为变更

- `App.tsx`：`doSync` 改同步前后快照-diff；新增 `clearAllFilters`（工具栏重置复用）；新增 `hiddenAfterSync` 状态与 warn 横幅。
- `styles.css`：新增 `.banner.warn`。
- i18n：新增 `sync.filterHidesNew`（`{n}` 占位，中英一致）。
- Tauri command / MCP / API 均无变更。

## 数据 / Schema 变更

无。

## 测试 / 验收

- `npm test`：33 通过（含新增 `syncHint.test.ts` 8 例：三维度藏住判定 / 新增与变更 diff / null-updatedAt / 无筛选 fast path）。
- `npx tsc --noEmit` 通过；`npm run i18n:check` 通过（245 key/边，占位符一致）。
- 验收标准：
  1. 无筛选同步 → 无多余提示、无多余请求（归属未生效时不拉全量）；
  2. 有筛选且藏住新任务 → 琥珀提示 + 数量正确，一键清除后提示消失、任务出现；
  3. 手动改筛选 → 旧提示清零。

## 相关链接

- Issue：[#178](https://github.com/ShawnLiuSZ/task-dashboard/issues/178)
- 分支：`fix/issue-178-sync-filter-hint`
- 前置排查：`sync_logs`（manual 成功）+ `tasks` 按账号/状态分布 + `Board.tsx` 分组/列渲染
- CHANGELOG：待发版时在 `docs/CHANGELOG.md` 对应版本下追加指向本文档的链接

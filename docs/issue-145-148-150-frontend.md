# Issue #145 + #148 + #150：前端性能 + 类型/i18n/URL + 可访问性

## 背景 / 动机

- #145：多账号数据串行加载（N×RTT）、Board/TaskCard 无 memo 全量重渲染、搜索每键全板重排。
- #148：`diagnose_project_status` 全链路 `any`；SyncLogs/Notes 面板硬编码中文；检查更新 URL 拼错（`task-dashborad`）导致永远 404。
- #150：TaskCard 键盘不可达、各 modal 无 dialog 语义/Esc、弱文本对比度不足、CSS 重复与死码。

## 设计 / 方案

### 性能（#145）

- `App.tsx` 聚合视图的 `listProjectStatuses` / `listAccountColumns` 改 `Promise.all` + 单账号失败隔离（catch 返回空数组）；`doSync` / `handleSwitchAccount` 的两路加载改 `Promise.all`。
- `SettingsPanel` 初始化改按账号 `Promise.all`（每账号内两路再并行）+ 卸载取消守卫。
- `Board` / `TaskCard` 包 `memo`；分组/排序/颜色映射全部 `useMemo`；自定义列与四态视图改单遍分组（原每列 `filter` 全量扫）；`TaskCard` 回调 prop 由每卡闭包 `onClick` 改为稳定的 `onSelectKey`（App 直传 `setSelected`）。
- 搜索输入经 `useDeferredValue` 防抖；`selectedTask` 改 `useMemo`；`state.columns` 的 `key={idx}` 改 `key={col.colKey}`（删列错位）。
- 有意行为变化一处：四态视图下未知 status 的任务此前被丢弃（看板消失），现归入「待处理」（与自定义列“未匹配” philosophy 一致，不再静默丢任务）。

### 类型 / i18n / URL（#148）

- 新增 `DiagnoseResult` / `DiagnosedProject`（后端 snake_case 原样），`api.ts`、`SettingsPanel` 清零 `any`（全仓无 `any`）。
- 顺带修：后端 `sample_statuses` 实际是 `[k,v][]` 数组（前端曾按 object 取 key，显示的是下标），类型与展示一并修正。
- SyncLogs / Notes 整面板 + Settings 残留三处（看板模式 label、列名 placeholder、默认账号 title）补双语 key（zh/en 各 183→241）。
- `check_latest_release` 的仓库地址抽为 `update_check_api_url` / `update_check_fallback_url` 单点常量并修正拼写 + 单测断言防漂移。

### 可访问性 / CSS（#150）

- TaskCard：`role=button` + `tabIndex=0` + Enter/Space + `aria-pressed` + `aria-label(repo#num title)`。
- 五处弹窗（设置/同步日志/账号/关于/详情）：`role=dialog` + `aria-modal` + `aria-label` + Esc 关闭（焦点内按键）。
- `--text-3` 加深至 `#6b6b70`（AA 级）；新增 `prefers-reduced-motion` 关闭过渡。
- CSS：合并重复 `.column-head` 定义；删除无引用的 `.gh-status-row` 死码（注释自述回退保留，已确认无引用）。

## 接口 / 行为变更

- 后端：`add_note` / `update_note_label` 已在 PR-2 统一标签校验；本批后端仅 URL 常量修正，无签名变更。
- 前端：`TaskCard` 的 `onClick` prop 改为 `onSelectKey`（仅 Board 三处调用方同步改）；其余对外行为不变。

## 数据 / Schema 变更

- 无。

## 测试 / 验收

- `npm run i18n:check`：zh/en 各 241 key，占位符一致。
- `npx tsc --noEmit` 通过；`npm test` 3/3 通过。
- `cargo check` 通过；`cargo test --lib` 32 passed（含 URL 单测）。
- e2e：`npm run build` 生产构建通过（44 modules，JS 232KB / gzip 72KB）。
- 待人工：键盘走一遍卡片（Tab + Enter）、切英文看 Notes/SyncLogs、关于页点一次检查更新。

## 相关链接

- Issue: #145（前端性能）、#148（类型/i18n/URL）、#150（a11y/CSS）
- 分支：`feature/issue-145-148-150-frontend-batch` → PR 到 `develop`
- 前置 KB：[docs/perf-audit-optimization.md](./perf-audit-optimization.md) P0-3 / P1-3 / P2 章节

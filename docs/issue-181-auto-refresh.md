# Issue #181：外部写入后 App 任务界面自动刷新

## 背景 / 动机

通过 MCP（`taskboard mcp` 子命令）写入任务状态 / session 后，
App 任务界面不刷新，需手动点「立即同步」/ 切换账号 / 重启才可见。
对应 issue：#181（`App 在 MCP/外部写入后不自动刷新任务列表`）。

## 设计 / 方案

根因：MCP 是独立进程直写 SQLite（`app/src-tauri/src/mcp.rs::run`），
无 `AppHandle`，发不出 `taskboard://synced` 事件；而前端 `load()`
只在挂载 / `onSynced` / 手动同步 / 详情页 `onChanged` 等时机触发。
给 hook 加 `AppHandle` 也跨不过进程边界（`AppHandle` 是进程内运行时句柄），
所以推送只能解决 App 内多窗口，MCP 仍需前端侧兜底。不引入新依赖。

三件套（`fix/issue-181-auto-refresh`）：

1. **前端聚焦 + 轮询**（`app/src/App.tsx`）：`focus` /
   `visibilitychange` 即时重查 + 20s 轮询兜底，后台隐藏时跳过；
   `load()` 加 `loadingRef` 防重入。
2. **无变化跳过**（`app/src/utils/taskSig.ts`）：`taskListSignature`
   覆盖本地写入会碰的字段（status / session 三件套 / handoff）与同步维度
   （ownership / title / candidateDone / updatedAt）。注意不能只看
   `updated_at`——本地写入（`common.rs::set_task_status` 等）不更新它。
3. **后端 emit**（`commands.rs` + `lib.rs`）：`update_task_status` /
   `record_session` / `clear_session` / `record_handoff` 成功后
   `app.emit("taskboard://tasks-changed")`，前端订阅后重查（多窗口正确性）。

## 接口 / 行为变更

- 新增 Tauri 事件 `taskboard://tasks-changed`（payload 为 issue_key，
  前端目前忽略 payload 直接重查）；`api.ts` 新增 `onTasksChanged`。
- 上述 4 个 Tauri command 新增首参 `app: AppHandle`（Tauri 自动注入，
  前端 `invoke` 参数不变）。
- UI 行为：切回 App 窗口 / 每 20s 自动刷新任务列表；无变化时不重渲染。
- MCP 协议、DB schema 均无变化。

## 数据 / Schema 变更

无。

## 测试 / 验收

- [x] 新增 `app/src/utils/taskSig.test.ts`（指纹稳定 / 本地写入字段变化 /
      增删任务），`npm test` 7 文件 36 用例全过
- [x] `cargo check` 通过（仅 1 条与本次无关的既有 `dead_code` warning）
- [ ] MCP 写入后切回 App 即见更新（需真机联调）
- [ ] 后台 / 隐藏时不轮询（代码走读：`document.hidden` 守卫 + cleanup）
- ⚠️ `npx tsc --noEmit` 在 `develop` 基线已坏（`DetailPanel/SettingsPanel`
      引用缺失的 `../agents`，见 #177 后续分支），本次 4 条报错皆为既有，
      无新增。

## 相关链接

- Issue：https://github.com/ShawnLiuSZ/task-dashboard/issues/181
- 分支：`fix/issue-181-auto-refresh`（→ `develop`）
- 主要改动：`app/src/App.tsx`、`app/src/api.ts`、
  `app/src/utils/taskSig.ts`（+ `.test.ts`）、
  `app/src-tauri/src/commands.rs`、`app/src-tauri/src/lib.rs`

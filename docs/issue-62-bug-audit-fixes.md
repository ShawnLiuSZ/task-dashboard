# Bug 审计遗留问题修复（issue #62）

> 关联：[GitHub Issue #62](https://github.com/ShawnLiuSZ/task-dashborad/issues/62)、[docs/CHANGELOG.md](./CHANGELOG.md)、PR → develop

## 背景 / 动机

2026-09-06 对 develop（`23d63b8`）做三路并行全量排查（前端静态审查 + 后端静态审查 + 工具链冒烟），共发现 13 条问题。其中 4 条（label→todo 优先级语义、NotesPanel/SyncLogsPanel i18n、测试覆盖）另立任务处理，本 issue 承接剩余 **9 项**修复。

## 设计 / 方案

### P1 明确错误行为

- **#1 MCP 双实现漂移**：`mcp.rs` 缺记事本 5 工具。在 `mcp.rs` 新增 `list_notes / add_note / update_note / update_note_label / delete_note`，与 `server.py` 同名同参、返回结构一致（snake_case 序列化、label 枚举 `low/medium/high/urgent` 校验、`note_id` 容忍字符串数字），消除同仓库 agent 用内置 MCP 管不了记事本的问题。
- **#2 任务从看板消失**：`sync.rs` 原 `map_project_status().unwrap_or(&gh_status_raw)` 遇到自定义 Project Status 会把原始文案写入 status，该任务不属于四态任何一列。改为 `unwrap_or(&existing_status)`——映射不到则**保持本地状态**，绝不回落原始文案。
- **#3 同步日志静默失败**：`SyncLogsPanel` catch 只 `console.error`，失败仍显示「暂无同步日志」。改为失败时 `setError` 显示红色错误 banner。

### P2 健壮性 / 一致性

- **#5 SCHEMA 缺列**：`tasks.branch / handoff` 此前只靠 ALTER 循环补齐，建库路径漏掉迁移会缺列。在 `CREATE TABLE` 定义中补上两列，任何走 SCHEMA 的路径都自带完整结构。
- **#6 setBoardMode 并发覆盖**：`App.tsx` 的 `setBoardMode` 改为先 `await` 再 `loadSettings` 串行执行，并加 try/catch，避免 `get_settings` 返回旧值把用户选择覆盖回去。
- **#7 项目状态 / 自定义列加载失败静默**：两处 catch 增加 `setError`，看板列缺失时用户可见原因。
- **#10 copyToClipboard 无 try/catch**：`DetailPanel` 的 `copyToClipboard` 包 try/catch，失败时 `setErr` 提示并复位 copied 态，不再卡住。
- **#11 openInBrowser 无 `.catch`（7 处）**：新增全局错误上报通道 `reportError`（派发 `taskboard://error` 事件，App 监听后显示在错误 banner），新增 `openExternal()` 封装（`openInBrowser().catch(reportError)`），7 处调用全部改走该封装——无 UI 上下文的异步失败不再只落 console。
- **#12 onSynced cleanup 返回 Promise**：`App.tsx` 改为 `cancelled` 标记 + 变量持有 unlisten 函数，快速重订阅不再短暂双订阅。

### 附带修复

- `TaskCard` 本地函数 `openExternal` 遮蔽 `api.openExternal` import 导致 TS2440/TS2554，改名 `openLink` 并调用带错误上报的版本。

## 接口 / 行为变更

- MCP 工具新增 5 个：`list_notes / add_note / update_note / update_note_label / delete_note`（内置二进制 `mcp.rs` 与 `server.py` 对齐）。
- 前端新增 `reportError` / `openExternal` / `TASKBOARD_ERROR_EVENT`（`app/src/api.ts`）；无 UI 上下文的异步失败（打开浏览器失败等）现在显示在应用顶部错误 banner。

## 数据 / Schema 变更

无新表 / 新列。`CREATE TABLE tasks` 补上 `branch / handoff` 两列定义，与既有 ALTER 迁移结果一致，纯建库路径补齐。

## 测试 / 验收

- `npx tsc --noEmit` 通过（含 TaskCard 命名冲突修复）。
- 工具链冒烟：`npm test` / `npm run i18n:check` / `cargo check` 保持绿色。
- 手工验证点：自定义 Project Status（如 Backlog）不再让任务消失；同步日志加载失败显示错误 banner；打开外链失败（断网 / 无默认浏览器）显示 banner；MCP 记事本工具可读写。

## 相关链接

- [GitHub Issue #62](https://github.com/ShawnLiuSZ/task-dashborad/issues/62)（完整 13 条报告见其 body）
- 提交：`a30f576`（P1 + 大部分 P2）、`a259048`（#11 补全 + TaskCard 命名冲突 + README 更新提醒）
- [docs/CHANGELOG.md](./CHANGELOG.md)

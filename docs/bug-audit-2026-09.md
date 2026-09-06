# Bug 排查报告 · 2026-09-06

## 1. 元信息

| 项 | 值 |
|---|---|
| 排查分支 | `feature/lsz/bug-audit`（未 push，无 upstream） |
| 基线 | `origin/develop` @ `23d63b8`（PR #60，issue-53 记事本导入导出） |
| 源码版本 | 0.3.27（package.json / Cargo.toml / tauri.conf.json / Cargo.lock 四处一致） |
| 执行方式 | 三路并行：前端静态审查 + 后端静态审查 + 工具链冒烟 |
| 是否含运行时验证 | **否**（按约定默认不含，见第 5 节存疑项） |
| 代码改动 | **无**。本次只出清单，未修改任何源码 |

## 2. 工具链结果

| 检查 | 命令 | 结果 |
|---|---|---|
| TypeScript | `npx tsc --noEmit` | ✅ 通过（exit 0） |
| 单元测试 | `npx vitest run` | ✅ 通过（1 个测试文件 / 3 个用例） |
| i18n 一致性 | `npm run i18n:check` | ✅ 通过（zh-CN / en-US 各 171 key，占位符一致） |
| Rust 编译 | `cargo check` | ✅ 通过（exit 0） |

**工具链全绿，但不足以说明健康**：全部测试仅 3 个用例、且只覆盖 `src/utils/format.test.ts`。核心逻辑（状态机映射、DB 迁移、i18n 运行时）零覆盖，工具链对本次发现的问题**一条都没能拦截**。

## 3. 问题清单

### P1 — 明确错误行为

| # | 位置 | 问题 | 根因 | 建议修法 |
|---|---|---|---|---|
| 1 | `app/src-tauri/src/mcp.rs:283-356` vs `mcp_server/server.py:386-450` | Rust 内置 MCP 只暴露 6 个工具（`list_my_tasks / get_task_status / update_task_status / record_session / record_handoff / clear_session`），缺少 `list_notes / add_note / update_note / update_note_label / delete_note` 五个记事本工具；Python 版有 11 个。同一仓库内 agent 用 Rust 服务管不了记事本，且 `mcp.rs:11` 注释自称「与 server.py 保持兼容」已失效 | v0.3.24 记事本工具只加进了 `server.py`，`mcp.rs` 未同步（违反 AGENTS.md §8.6 跨文件一致性） | 在 `mcp.rs` 补 5 个实现（复用 `db.rs` 已有 `list_notes/add_note/...`）+ `call_tool` match 分支 + `tools_list` 条目，参数与返回结构对齐 `server.py` |
| 2 | `app/src-tauri/src/sync.rs:355` | Project Status 名称不含已知关键词（如自定义状态 "Backlog"）时，`status` 被写成原始文案，该任务在四态看板中无列可归 → **任务从看板消失** | `map_project_status(...).unwrap_or(&gh_status_raw)` 映射失败时回落原始字符串，而非「保持本地」（优先级 #4）或默认 `todo` | 映射失败改为回落 `existing_status`；需兜底时显式置 `"todo"`，禁止产生非四态的游离 `status` |
| 3 | `app/src/components/SyncLogsPanel.tsx:50` | 同步日志加载失败时只 `console.error`，面板照样显示「暂无同步日志」，用户误判为真的没日志 | catch 内无错误态，`loading` 在 finally 复位但 UI 无反馈——正是项目明令禁止的「静默吞异常」模式（AGENTS.md 记忆条目） | catch 内 `setError(String(e))`，渲染时 `error` 优先于空态展示错误 banner |

### P2 — 健壮性 / 一致性 / 潜在触发

| # | 位置 | 问题 | 根因 | 建议修法 |
|---|---|---|---|---|
| 4 | `app/src-tauri/src/sync.rs:351` | label 显式映射到 `todo` 时被跳过，落到 `gh_status` 映射，偏离 AGENTS.md §2.2 的优先级 #2（Label 应优先于 gh_status） | 条件 `!mapped_status.is_empty() && mapped_status != "todo"` 把「映射结果= todo」当无效处理 | 需先区分「显式 label 映射」与「state 兜底产生的 todo」：仅后者应让位给 gh_status。建议 `resolve_status_from_labels` 返回是否命中显式映射，再决定优先级 |
| 5 | `app/src-tauri/src/db.rs:28-56` / `205-206` | `tasks` 表的 `branch` / `handoff` 两列未写入 `SCHEMA`，仅靠 `open_db()` 的 ALTER 循环补齐；任何只执行 SCHEMA 的建库路径都会缺列 | 与 `db.rs:175-176` 注释声明的「SCHEMA 是单一来源」矛盾，属历史遗留脆弱点（**当前无实际故障**，ALTER 循环覆盖了新老库路径） | 将两列直接写入 `SCHEMA` 的 `CREATE TABLE tasks`；ALTER 循环保留作旧库兼容 |
| 6 | `app/src/App.tsx:296` | `void api.setBoardMode(mode)` 与 `void loadSettings()` 并发未 await，`get_settings` 可能返回旧 `boardMode` 覆盖用户选择 | 两个 fire-and-forget Promise 竞争 | 改为 `await api.setBoardMode(mode); await loadSettings();`，或后端合并为单命令。**当前 `<select>` 只有 project 一项，暂不会触发**；补第二项即暴露 |
| 7 | `app/src/App.tsx:105` | 项目状态选项加载失败只 `console.warn`，看板列静默缺失/错乱且无提示 | catch 未向 UI 暴露错误 | catch 内设置错误态并展示可见提示 |
| 8 | `app/src/components/NotesPanel.tsx`（全文件，68 处中文） | 记事本面板完全未接入 i18n，切到 en-US 仍全中文 | 文件未引入 `useI18n`，全部字符串字面量 | 接入 `useI18n`，新增 `notes.*` 系列 key |
| 9 | `app/src/components/SyncLogsPanel.tsx:74-93` | 除 `t("btn.close")` 外全部硬编码中文（标题/加载中/空态/表头/状态徽章） | 组件只有 1 处走 `t()` | 新增 `syncLogs.*` key 并替换 |
| 10 | `app/src/components/DetailPanel.tsx:79` | `copyToClipboard` 无 try/catch，`navigator.clipboard.writeText` 在权限不足或非安全上下文会 reject，导致未处理 Promise 拒绝且 `copiedKey` 卡住 | 异步调用未包裹异常处理 | try/catch 包裹，失败给可见提示，finally 中 `setCopiedKey(null)` |
| 11 | `TaskCard.tsx:20`、`DetailPanel.tsx:208/219/231`、`AboutPanel.tsx:123`、`AccountsPanel.tsx:105/268` | 多处 `void api.openInBrowser(...)` 无 `.catch`，命令失败被静默吞掉 | invoke 返回的 Promise rejection 未处理 | 封装统一 `openExternal` 内部 catch + 错误提示，替换各处裸调用 |
| 12 | `app/src/App.tsx:124` | `onSynced` 的 cleanup 返回 Promise，React 无法等待，快速重订阅时可能短暂双订阅 | `return () => void un.then(f => f())` 使清理函数异步 | 改为在 effect 内 `const un = await onSynced(...)` 后 `return () => un()`，或用 ref 持有 unlisten |
| 13 | `app/src/**/*.test.ts` | 全项目仅 1 个测试文件 3 个用例，核心逻辑（sync 状态机、DB 迁移、i18n 运行时）零覆盖 | 历史未建立测试习惯 | 优先给 `sync.rs` 状态机与 `resolve_status_from_labels` 补单测；前端补 status mapping 纯函数测试 |

## 4. 已复核并否决的误报

审查阶段产出过两条结论，经人工复核**不成立**，记录在此避免重复排查：

1. **「AboutPanel 仓库链接拼写错误 task-dashborad」→ 误报。** `git remote get-url origin` 确认为 `git@github-shawn:ShawnLiuSZ/task-dashborad.git`，仓库名本身就是 `task-dashborad`。现有链接是正确的，改成 `task-dashboard` 才会 404。
2. **「版本号 Cargo.toml 0.3.27 vs package.json 0.3.28 不一致」→ 不成立。** 在 develop 基线源码中四处均为 `0.3.27`（含 `Cargo.lock:3438`）。0.3.28 出现在 `feature/issue-52-custom-column-mapping` 分支上，属该分支未发布的版本 bump；`app/src-tauri/target/` 下的 0.3.28 是历史构建缓存，非源码。

## 5. 存疑（需运行时验证，本次未做）

1. **旧库迁移完整性**：静态确认 `open_db` 的 ALTER 循环覆盖 `branch/handoff/account_id` 等列，但无法保证已发布旧版 DB 历次升级都完整执行过。建议在真实库跑 `sqlite3 ~/Library/Application\ Support/com.shawnliu.taskboard/taskboard.db "PRAGMA table_info(tasks)"` 核对，尤其是 v0.3.10 之前升级上来的库。
2. **gh_status 原始文案回落**（第 2 条）：需连接含自定义 Project Status 的真实仓库复现「任务在看板消失」。
3. **快速连续切换语言时 `onSynced` 是否漏事件**（第 12 条相关）：`t` 作为 effect 依赖会触发反订阅/重订阅。

## 6. 建议修复顺序

1. **#1 MCP 工具缺口** —— 跨文件契约不一致，且直接影响 agent 可用性，改动集中在 `mcp.rs`。
2. **#2 任务从看板消失** —— 数据正确性缺陷，改动 1 行。
3. **#3 同步日志静默失败** —— 属于项目已明令禁止的模式，改动小。
4. **#4 状态机优先级** —— 需先与 owner 确认「显式 label→todo 是否应优先于 gh_status」，不要盲改。
5. **#5 / #13** —— 属债务偿还，可并入下个版本。

## 7. 相关链接

- 分支：`feature/lsz/bug-audit`，基线 `origin/develop` @ `23d63b8`
- 关联历史修复：`9a0936e`（#55 按钮 loading 初始态）、`15bead3`（#56 Project Status 列顺序竞态）
- 文档规范：`AGENTS.md` §2.2（状态机优先级）、§5（知识库文档）、§8.6（跨文件一致性）

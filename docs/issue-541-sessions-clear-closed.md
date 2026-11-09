# 一键删除已关闭 issue 的任务会话（#541）

## 背景 / 动机

任务会话面板（`SessionsPanel`，#287）列出所有活跃 session，但**删除某个会话前无法知道它对应的 issue 是否已关闭** —— 只能逐个点开链接去 GitHub 确认，清理收尾会话全靠人工核对。

用户痛点：收尾阶段（issue 已关闭、agent 已收工）的会话堆积在面板里，每删一个都要先确认对应 issue 状态。

## 设计 / 方案

**判定依据：本地 `tasks.issue_state == 'closed'`**。同步路径（`sync.rs`）已权威维护该字段（经 `common::normalize_issue_state` 归一化小写），**零联网、点按钮即清**，正是「一键」的初衷。若用远程实时查询，每次都要逐项打 GitHub API，与「一键」矛盾且慢。

**复用现有 `api.clearSessions(keys)`**（后端 `clear_sessions` 已支持批量清空 session 字段），**零后端改动** —— 只清空 `session_id` / `session_agent` / `session_at`，保留任务行（与多选删除 #391 语义一致）。

前端改动（`SessionsPanel.tsx`）：
- `closedSessions = sessions.filter(s => s.issueState === 'closed')`（`useMemo` 防每次渲染重建）
- 工具栏非选择模式新增「清除已关闭会话」按钮（与「选择」并列），**无已关闭会话时置灰禁用**（tooltip 说明原因）
- 点击 → 确认弹窗（带计数 `clearClosedConfirm {n}`）→ `handleClearClosed`：去重后 `api.clearSessions(keys)` → 刷新
- 聚合视图下同一 `issueKey` 可来自两个账号 ⇒ **删除前映射回 `issueKey` 并去重**（同 #438/#391 口径）

**按钮可见性**：置灰禁用（用户始终知道该功能存在），而非隐藏。

## 接口 / 行为变更

- 新增 i18n 词条（zh-CN / en-US 各 3 个）：`sessions.clearClosed`（按钮）、`sessions.clearClosedConfirm`（确认弹窗）、`sessions.clearClosedDisabled`（禁用 tooltip）。
- 无后端 / Rust / SQLite schema 变更。
- `SessionsPanel` 工具栏新增一个按钮（非选择模式），选择模式交互不变。

## 数据 / Schema 变更

无（未触及 SQLite schema；复用 `clear_sessions` 清空 session 三列）。

## 测试 / 验收

- `npx vitest run`：**585 项全部通过**（含新增 `sessions-panel.test.ts` 的 `#541` describe 4 项：closedSessions 过滤判据、禁用态 + 按钮接线、handleClearClosed 去重调用、确认弹窗接线）。
- `npx tsc --noEmit`：通过（exit 0）。
- `npm run i18n:check`：zh-CN 459 key 与 en-US 一致（占位符一致，无空翻译）。
- 手动验收：会话面板存在已关闭 issue 的会话时按钮可点，确认后仅清空这些会话、保留任务行与未关闭会话。

## 相关链接

- Issue：`#541`
- 分支：`feature/issue-541-sessions-clear-closed`
- 涉及文件：`app/src/components/SessionsPanel.tsx`、`app/src/i18n/locales/{zh-CN,en-US}.json`、`app/src/sessions-panel.test.ts`

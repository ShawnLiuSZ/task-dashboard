# Issue #301：会话卡片补「清除会话」功能 + 复制按钮改 icon

## 背景 / 动机

「任务会话」面板（#287，v0.6.2）每张会话卡片只有一个操作——右上角「在浏览器打开」。**没有任何删除 / 清除会话的入口**：用户想手动把某个已结束、误记或不再关注的会话从看板清掉，没有 UI 路径，只能去 SQLite 手动 UPDATE 或等下次 sync。

后端已有 `clear_session` 命令（`commands.rs::clear_session`），前端 `api.clearSession(key)` 也已封装（`api.ts:49`）。`list_active_sessions` 的 SQL 是 `WHERE session_id IS NOT NULL`，把 session_id 置空后该卡片会自动从面板消失。**后端零改动**，只缺前端按钮。

此外，issue 评论补充：卡片里的「复制」按钮目前是竖排文字（分支 / 目录 / Session 行各一个），占位突兀、视觉噪音大，建议改为 icon 按钮。

## 设计 / 方案

### 清除会话按钮

- 卡片操作区（右上角）新增「清除会话」按钮，使用 `.note-tool` 图标按钮样式（trash icon）。
- 点击后弹出 `ConfirmDialog` 二次确认，避免误清。
- 确认后调 `api.clearSession(task.issueKey)`，再 `loadSessions()` 刷新列表。
- 失败时走面板已有的 error 通道提示，不残留幽灵卡片。

### 复制按钮改 icon

- 三个可复制行（分支 / 目录 / Session）统一改为 icon 按钮，复用 `.note-tool` 样式。
- 默认显示复制图标（copy icon），点击成功后短暂切换为对勾图标（check icon），1.5s 后还原。
- tooltip 保留原有的「复制分支名」「复制目录」「复制 Session ID」。

## 接口 / 行为变更

### UI 变更

- `SessionsPanel.tsx`：
  - 卡片操作区新增「清除会话」按钮（trash icon）
  - 三个复制按钮从文字改为 icon（copy → check 切换）
  - 新增 `ConfirmDialog` 二次确认弹窗
- 新增 ICON 定义：`copy`、`check`、`trash`

### i18n 变更

新增 2 个 key（中英文各 1 处）：
- `sessions.clear`：清除会话 / Clear session
- `sessions.clearConfirm`：确认清除该会话记录？清除后卡片将立即移除，可重新 record_session 恢复。 / Clear this session record? The card will be removed immediately. You can re-record via record_session.

## 数据 / Schema 变更

无 schema 变更。后端零改动，复用已有的 `clear_session` 命令。

## 测试 / 验收

### 验收标准

1. ✅ 每个会话卡片出现「清除会话」入口（右上角 trash icon）
2. ✅ 点击 → 确认 → 调 `api.clearSession(issueKey)` → 该卡片从面板移除，无需刷新整页
3. ✅ 失败有可见提示，不残留幽灵卡片
4. ✅ 三个复制按钮统一改为 icon 按钮（copy → check 切换）
5. ✅ `npm run i18n:check` 通过（373 keys / locale）
6. ✅ `npx tsc --noEmit` 0 error
7. ✅ `npm test` 136 例 passed
8. ✅ `npm run build` ✅
9. ✅ `npx prettier --check` ✅
10. ✅ `cargo test` 24 例 passed
11. ✅ `scripts/check-mcp-columns.py` ✅
12. ✅ `scripts/check-doc-links.py` ✅

## 相关链接

- Issue: https://github.com/ShawnLiuSZ/task-dashboard/issues/301
- CHANGELOG: `docs/CHANGELOG.md` 未发布条目
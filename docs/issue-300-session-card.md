# Issue #300：会话卡片补 Session ID 展示 + 补齐 work_dir 写入链路

## 背景 / 动机

「任务会话」面板（#287，v0.6.2）的会话卡片存在两处缺口：

1. **Session ID 不展示**：`list_tasks` 后端已返回 `sessionId`，但卡片没有任何行显示它——中断后想用 `claude --resume <session_id>` 恢复会话，只能去查 SQLite。
2. **工作目录恒不显示**：UI 已有 `workDir` 行（非空才显示），但生产库 17 条活跃会话的 `tasks.work_dir` 全部为空串 → 「目录」行永远不出现。

## 设计 / 方案

### Session ID 展示

- 卡片新增「Session」行，显示 `task.sessionId`，等宽字体（`<code>` 标签），旁边一键复制按钮。
- 完整显示，不截断（session id 本身就是给 agent 恢复用的，截断反而无意义）。
- 放在「目录」行之后、Agent 行之前。

### work_dir 写入链路补齐

`record_session` 的 `work_dir` 参数是 #287 才加的，Rust / Python MCP 两侧均已支持，但写入入口覆盖不全：

1. **hooks.rs** 提示词（`script_variant` 函数）：补 `work_dir` 提示，让通用 agent 知道要传 `work_dir=<项目目录>`。
2. **taskboard-session-start.sh**：`record_session` 示例补 `work_dir` 参数。
3. **AGENT_INSTRUCTIONS.md**：示例和触发规则表补 `work_dir` 参数。
4. **task-handoff.md**（claude 版）：补 `work_dir=$(pwd)` 提示。
5. **task-handoff.md**（opencode 版）：补 `work_dir` 自动填充说明。
6. **opencode 插件**（`taskboard.js`）：已有 `work_dir` 自动填充逻辑（330-332 行），不需要改。

## 接口 / 行为变更

### UI 变更

- `SessionsPanel.tsx`：新增 Session ID 行（`task.sessionId` 非空才渲染）
- 完整显示 session id，不截断
- 复制按钮复制完整 session id

### i18n 变更

新增 2 个 key（中英文各 1 处）：
- `sessions.sessionId`：Session
- `sessions.copySession`：Copy session ID

### hooks.rs 变更

`script_variant` 函数中两条 MCP 直调指引补 `（含 branch、work_dir）`。

### taskboard-session-start.sh 变更

`record_session` 示例补 `work_dir="<项目目录，如 /path/to/project>"`。

### task-handoff.md 变更

- claude 版：补 `work_dir=$(pwd)` 提示
- opencode 版：补 `work_dir` 自动填充说明

### AGENT_INSTRUCTIONS.md 变更

- 触发规则表：补 `work_dir=<项目目录>`
- 示例 1：补 `work_dir="/path/to/project"`
- 示例 2：补 `work_dir="/path/to/project"`

## 数据 / Schema 变更

无 schema 变更。

## 测试 / 验收

### 验收标准

1. ✅ 有 session_id 的会话卡片能看到完整 Session ID 并一键复制
2. ✅ hooks.rs / session-start.sh / AGENT_INSTRUCTIONS.md / task-handoff.md 均补了 `work_dir` 提示
3. ✅ `npm run i18n:check` 通过（371 keys / locale）
4. ✅ `npx tsc --noEmit` 0 error
5. ✅ `npm test` 136 例 passed
6. ✅ `npm run build` ✅
7. ✅ `npx prettier --check` ✅
8. ✅ `cargo test` 24 例 passed
9. ✅ `scripts/check-mcp-columns.py` ✅
10. ✅ `scripts/check-doc-links.py` ✅

## 相关链接

- Issue: https://github.com/ShawnLiuSZ/task-dashboard/issues/300
- CHANGELOG: `docs/CHANGELOG.md` 未发布条目
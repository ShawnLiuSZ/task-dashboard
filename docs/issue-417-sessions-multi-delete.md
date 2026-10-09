# Issue #417：任务会话多选批量删除与卡片标题完整显示

> **状态**：开发中
> **关联分支**：`feature/issue-417-sessions-multi-delete`
> **关联 PR**：（待创建）

---

## 1. 背景 / 动机

任务会话面板（#287）列出所有活跃 session，但**仅支持单卡片逐条「清除会话」**：用户需要清理多个已完成会话时，必须逐个点击删除按钮并逐一确认，效率低、操作繁琐。

同时存在体验缺陷：会话卡片标题（`.session-card-title`）使用 `text-overflow: ellipsis` 单行截断，长标题被省略为 `…`，用户在不打开详情的情况下无法完整阅读会话对应的任务标题。

两个问题都作用于 `SessionsPanel`，合并在本 issue 解决。

---

## 2. 设计 / 方案

### 2.1 后端批量命令 `clear_sessions`

新增 Tauri command `clear_sessions(keys: Vec<String>)`，复用 `common::clear_task_sessions`：

- 逐个调用 `clear_task_session` 并**累加受影响行数** `total`；
- **至少一个命中**（`total > 0`）才返回 `Ok`，全部不存在（`total == 0`）按 `require_affected` 翻译为「任务不存在」错误；
- 与单条 `clear_session` 语义区分：批量场景下**部分陈旧的 key 不应让整批失败**，故不在单条级别调用 `require_affected`；
- 对每个 key 各发一次 `TASKS_CHANGED_EVENT`，保持多窗口同步。

`common::clear_task_sessions` 不做「不存在即报错」的守卫，只负责累加——守卫上移到 `clear_sessions` 命令层（对总计判断）。

### 2.2 前端选择模式 UI

`SessionsPanel.tsx` 增加**选择模式**：

- 状态：`selectMode`（布尔）、`selectedKeys`（`Set<string>`，存 `issueKey`）；
- 非选择模式：工具栏仅一个「选择」入口；
- 进入选择模式：
  - 每张卡片左侧出现**受控复选框**，卡片整体可点击切换选中（`onClick` → `toggleSelect(issueKey)`）；
  - 卡片内功能按钮（打开任务 / 复制）`stopPropagation`，避免误触卡片选中切换；
  - 单卡删除按钮**隐藏**，避免与批量删除重复入口；
  - 选中卡片加 `.selected` 高亮（边框强调 + 主色浅底）；
- 工具栏：`全选 / 取消全选`、`已选 {n} 项` 计数、`删除选中`（选中数为 0 时禁用）、`取消`（退出选择模式并清空已选）；
- 批量删除走确认框（`clearMultiConfirm`），确认后调用 `api.clearSessions(keys)`，成功后清空选择并重新加载列表。

### 2.3 会话卡片标题完整显示（附带修复）

`.session-card-title` 移除 `overflow: hidden; text-overflow: ellipsis; white-space: nowrap`，改为 `white-space: normal; word-break: break-word`，实现自动换行完整显示。

---

## 3. 接口 / 行为变更

### 3.1 新增 Tauri Command

| 命令 | 参数 | 返回 | 说明 |
|------|------|------|------|
| `clear_sessions` | `keys: Vec<String>` | `()` | 批量清空多个 session（任务会话多选删除） |

既有 `clear_session(key)` 单条删除**保留不变**，供详情面板等单条场景继续使用。

### 3.2 前端 API

`api.clearSessions(keys: string[])` → `invoke<void>('clear_sessions', { keys })`，与既有 `api.clearSession(key)` 并存。

### 3.3 i18n 新增键

`zh-CN.json` / `en-US.json` 各新增 9 个键（双语一致，占位符一致）：

| 键 | 中文 | 英文 |
|----|------|------|
| `sessions.select` | 选择 | Select |
| `sessions.cancelSelect` | 取消 | Cancel |
| `sessions.selectAll` | 全选 | Select all |
| `sessions.cancelSelectAll` | 取消全选 | Clear selection |
| `sessions.deleteSelected` | 删除选中 | Delete selected |
| `sessions.selectedCount` | 已选 {n} 项 | Selected {n} |
| `sessions.clearMultiConfirm` | 确认删除选中的 {n} 个会话？… | Delete {n} selected session(s)? … |
| `sessions.toggleSelect` | 选择 #{num} | Select #{num} |
| `sessions.select` 同表首行 | — | — |

### 3.4 样式变更

`styles.css` 新增：

- `.sessions-toolbar`（选择工具栏 flex 布局）；
- `.sessions-sel-count`（已选计数）；
- `.session-card.selectable`（选择模式下 `cursor: pointer`）；
- `.session-card.selected`（边框 `border-color: var(--accent)` + 主色浅底）；
- `.session-card-check`（复选框对齐）。

---

## 4. 数据 / Schema 变更

**无。** 本功能不改动 SQLite 表结构：`clear_sessions` 复用既有 `tasks.session_id` / `session_agent` 列的 UPDATE；不新增列、不修改 `SELECT_COLS`、`SCHEMA_VERSION` 不变。

---

## 5. 测试 / 验收

### 5.1 已通过的检查

- [x] `cargo test --lib`：178 passed（含新增 `clear_task_sessions_batch_accumulates_and_ignores_missing`；既有静态断言 `require_affected` 计数由 5 → 6，新增 `clear_sessions` 一条）
- [x] `vitest run`：257 passed（含新增 `sessions-panel.test.ts` 11 例、`styles.test.ts` 选中态 3 例）
- [x] `npm run lint`：`--max-warnings 0` 0 警告
- [x] `npm run i18n:check`：397 key 一致（占位符一致，无空翻译）
- [x] `npx tsc --noEmit`：无类型错误
- [x] `npx prettier --check`：格式通过

### 5.2 验收标准

1. 任务会话面板出现「选择」入口，点击进入选择模式；
2. 选择模式下卡片显示复选框，点击卡片任意处或复选框可切换选中；
3. 工具栏「全选」一次选中所有会话，「取消全选」清空；「已选 {n} 项」计数实时更新；
4. 「删除选中」在选中数为 0 时禁用；点击后弹确认框显示数量，确认后批量消失；
5. 选择模式下单卡删除按钮隐藏，退出选择模式后恢复；
6. 会话卡片标题长文本自动换行完整显示，不再省略；
7. 部分选中的 key 在并发删除场景下，命中者被清除，其余会话不受影响。

---

## 6. 相关链接

- Issue：https://github.com/ShawnLiuSZ/task-dashboard/issues/417
- 关联：任务会话面板 #287（`docs/issue-287-task-sessions.md`）
- CHANGELOG：`docs/CHANGELOG.md` / `docs/CHANGELOG.en.md`

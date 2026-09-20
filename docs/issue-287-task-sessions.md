# Issue #287：任务会话总览（Task Sessions）

> **状态**：开发中
> **关联分支**：`feature/issue-287-task-sessions`
> **关联 PR**：（待创建）

---

## 1. 背景 / 动机

用户需要快速一览「同时在做哪几个任务、各自在哪个分支」——即所有活跃 session 的集中视图。

核心需求（用户确认）：

1. **记录内容**：项目目录 + 任务分支 + 会话 ID + agent + 开始时间
2. **展示位置**：备忘录（Notes）面板下方新增「任务会话」Tab
3. **触发方式**：自动（task-start 时写入）+ 手动可查看
4. **生命周期**：任务完成自动清理归档
5. **核心场景**：快速一览「同时在做哪几个任务、各自在哪个分支」

---

## 2. 设计 / 方案

### 2.1 数据模型

复用 `tasks` 表现有列，新增一列：

| 列名 | 类型 | 说明 |
|------|------|------|
| `work_dir` | TEXT NOT NULL DEFAULT '' | agent 通过 `record_session` 写入的工作目录（项目路径） |

已有列直接复用：

- `work_branch`：任务分支
- `session_id`：会话 ID
- `session_agent`：agent 名称
- `session_at`：开始时间（秒级时间戳）

### 2.2 写入路径

`record_session` → `touch_session`（common.rs）：

- 新增 `work_dir: Option<&str>` 参数
- 非空时写入 `work_dir` 列
- 与 `work_branch` 同理：空则不写，不清空已有值

### 2.3 读取路径

新增 Tauri command `list_active_sessions`：

```sql
SELECT * FROM tasks WHERE session_id IS NOT NULL ORDER BY session_at DESC
```

返回所有 `session_id` 非空的任务（即活跃会话），按开始时间倒序。

### 2.4 自动清理

`update_task_status` 在状态变为 `done` 时自动调用 `clear_task_session`：

- 清空 `session_id`、`session_agent`（保留 `session_at` 审计）
- `work_dir` 和 `work_branch` 不清空（下次同步可复用）

### 2.5 前端展示

NotesPanel 新增 Tab 切换栏：

- **备忘录** Tab：原有四列布局（不变）
- **任务会话** Tab：会话列表，每条显示：
  - 任务标题 + 编号
  - 工作分支（可复制）
  - 工作目录（可复制）
  - Agent 名称
  - 开始时间（相对时间）
  - 点击可打开 GitHub issue

---

## 3. 接口 / 行为变更

### 3.1 Tauri Command

| 命令 | 参数 | 返回 | 说明 |
|------|------|------|------|
| `list_active_sessions` | 无 | `Vec<Task>` | 列出所有活跃会话 |
| `record_session` | `key`, `session_id`, `agent?`, `work_dir?` | `()` | 新增 `work_dir` 参数 |

### 3.2 MCP 工具

| 工具 | 参数 | 说明 |
|------|------|------|
| `record_session` | `issue`, `session_id`, `agent?`, `branch?`, `work_dir?` | 新增 `work_dir` 参数 |

### 3.3 数据库 Schema

新增列：

```sql
ALTER TABLE tasks ADD COLUMN work_dir TEXT NOT NULL DEFAULT ''
```

迁移策略：幂等 ALTER（已存在则忽略），与 `work_branch` 同款。

---

## 4. 数据 / Schema 变更

### 4.1 tasks 表

| 变更 | 列 | 位置 |
|------|-----|------|
| 新增 | `work_dir` | `work_branch` 之后，`handoff` 之前 |

### 4.2 SELECT 列清单

- **Rust MCP** (`mcp.rs::SELECT_COLS`)：28 列，`work_dir` 在 `work_branch` 之后
- **Python MCP** (`server.py::SELECT_COLS`)：28 列，同上
- **Tauri commands** (`commands.rs::TASK_SELECT_COLUMNS`)：29 列（含 `created_at`），`work_dir` 在 `work_branch` 之后

### 4.3 位置索引变更

`task_mapper` 位置索引（新增 `work_dir` 在 24，后续索引 +1）：

| 索引 | 列 |
|------|-----|
| 23 | `work_branch` |
| 24 | `work_dir`（新增） |
| 25 | `author` |
| 26 | `parent_issue` |
| 27 | `sub_issues` |
| 28 | `created_at` |

---

## 5. 测试 / 验收

### 5.1 已通过的检查

- [x] `python3 scripts/check-mcp-columns.py`：28 列一致
- [x] `python3 scripts/check-doc-links.py`：无断链
- [x] `npm run i18n:check`：369 key 一致
- [x] `npx tsc --noEmit`：无类型错误
- [x] `npm test`：136 tests passed
- [x] `cargo check`：编译通过

### 5.2 验收标准

1. 执行 `record_session` 带 `work_dir` 参数 → 任务卡片显示工作目录
2. 打开备忘录 → 点击「任务会话」Tab → 显示活跃会话列表
3. 会话列表显示：任务标题、分支、目录、agent、时间
4. 点击复制按钮 → 分支/目录复制到剪贴板
5. 任务状态改为「已完成」→ 会话自动从列表中消失
6. 无活跃会话时显示空状态提示

---

## 6. 相关链接

- Issue: https://github.com/shawnliu/taskboard/issues/287
- CHANGELOG: `docs/CHANGELOG.md`（待更新）

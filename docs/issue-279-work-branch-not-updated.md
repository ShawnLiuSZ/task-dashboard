# issue #279 — 开始任务后 work_branch 仍关联基线分支（develop/master）

> 关联 issue：<https://github.com/ShawnLiuSZ/task-dashboard/issues/279>
> 关联 issue：<https://github.com/ShawnLiuSZ/task-dashboard/issues/278>（父/子 issue 关联，独立 issue）

## 背景 / 动机

用户在 TUI 里把某个 issue 派给 agent 处理：agent 在 `develop` / `master` 上启动，先「开始任务」，
随后才创建 / 切换到该 issue 的工作分支（`feature/issue-N-xxx`）。现象是：GitHub 上分支已经建好了，
但 TaskBoard 看板任务详情里的 `work_branch` 仍然关联 `develop` / `master` 基线分支，而不是新建的分支。

根因定位：`.claude/commands/task-start.md` 与 `.opencode/commands/task-start.md` 这两个 slash command
**在第一步就用 `git branch --show-current` 取分支**——而此刻 agent 还在基线分支上（尚未创建 / 切换
issue 分支），随后 `record_session(branch=...)` 就把基线分支写进了 `work_branch`。opencode 版更是用
`!`git branch --show-current`` 在命令**展开时**就填入分支，时机更早、同样录成基线分支。

`work_branch` 是 agent 工作分支列（与同步自动拉的 PR `branch` 列分离，同步不碰它），本意是记录
「人正在哪个分支上干这个 issue」。录成基线分支会让看板详情误导人、且对账时无法反映真实工作分支。

## 设计 / 方案

两路修复，互为兜底：

1. **钩子指令纠正（根因修复）**：改写两个 `task-start` slash command 与 prompt-reminder 钩子，强制要求
   agent **先创建 / 切到 issue 工作分支，再记录会话**；分支捕获步骤移到切换之后，因此 `record_session`
   自然录到正确的 issue 分支。

2. **新增显式纠正工具 `set_work_branch`（补偿修复）**：即便 agent 已经在基线分支上跑过
   `record_session`，之后切到 issue 分支时，也能调 `set_work_branch(issue, branch)` 把 `work_branch`
   改对。这是一个**只写 `work_branch`、不碰 PR `branch`** 的窄工具，与「同步自动拉 PR 分支」职责清晰分离。

   - `branch` 为空串 → 报错（清空该列的职责不在本工具；错误信息提示 `clear_work_branch` 但当前未单独实现，仅作占位说明，避免误用）。
   - 走按需拉取（`#250`）：若该 issue 尚未同步到本地，先拉取这一个再写入。

`record_session` 的 `branch` 参数**保持不变**（非空才写 `work_branch`），新增工具只是提供「事后纠正」通道，
不改变既有行为，杜绝回归。

## 接口 / 行为变更

### 新增 Rust 后端（`app/src-tauri/src`）

- `common.rs::set_work_branch(conn, key, branch)`：更新 `tasks.work_branch`，空串清空，返回更新行数（0 = 任务不存在）。
- `commands.rs::set_work_branch`（Tauri command）：参数 `key` / `branch`；任务不存在返回错误；成功后 `emit(TASKS_CHANGED_EVENT, key)`。
- `mcp.rs::tool_set_work_branch(conn, issue, branch)`：解析引用 → 按需拉取 → 调用 `set_work_branch`；返回 `{ ok, issue_key, work_branch, pulled }`。已挂到 `invoke_handler!` 与 MCP dispatch / schema。
- 新增 3 个 Rust 测试（mcp 模块）：
  - `set_work_branch_updates_only_work_branch`：只改 `work_branch`，不影响 PR `branch`（=main）。
  - `set_work_branch_errors_on_missing_issue`。
  - `set_work_branch_rejects_empty_branch`。

### 新增 Python MCP（`mcp_server/server.py`）

- `tool_set_work_branch(issue, branch)`：与 Rust 同语义（空分支报错、写前按需拉取、只改 `work_branch`）。
- 在 `TOOLS` 注册 `set_work_branch`（含 `issue` / `branch` 两个必填入参）。
- 模块 docstring 工具列表追加一行。
- 新增 3 个 Python 单测（`test_server.py`）：与 Rust 三个一一对应。

### 钩子指令（仓库根模板，`include_str!` 内嵌进 app 二进制）

- `.claude/commands/task-start.md`：重排步骤——先切 issue 分支（第 1 步），再取分支（第 2 步），record_session（第 5 步）自然录到正确分支；第 6 步为 `set_work_branch` 兜底。
- `.opencode/commands/task-start.md`：顶部强调「先切 issue 分支再调本命令」，并新增第 4 步 `taskboard_set_work_branch` 兜底。
- `.claude/hooks/taskboard-prompt-reminder.sh`：提醒文案追加「开始记录前请先切到该 issue 的工作分支」。

### 文档

- `mcp_server/AGENT_INSTRUCTIONS.md`（§1 工具表 + §2 触发时机）追加 `set_work_branch` 说明。

## 数据 / Schema 变更

△ 无 schema / 迁移变更。`work_branch` 列已于 #171 引入（`db.rs::SCHEMA` 及 Python `ensure_schema` 均已有该列），
`set_work_branch` 仅 `UPDATE` 既有列，不新增列、不改列序、不触发重建。

## 测试 / 验收

- Rust：`cargo test --lib` 全绿；新增 3 例 mcp 测试验证「只改 work_branch / 缺 issue 报错 / 空分支报错」。
- Python：`python3 -m unittest discover -s mcp_server -p 'test_*.py' -v` 全绿（29 例，含新增 3 例）。
- 一致性：`scripts/check-mcp-columns.py` 通过（Rust `SELECT_COLS` 与 Python `SELECT_COLS` 一致，均含 `work_branch`）。
- 文档：`scripts/check-doc-links.py` 通过（新增 KB 链接有效）。
- 人工复核（待起 dev server）：在 develop 上开始某 issue，再切到 issue 分支，确认详情 `work_branch` 显示新分支。

## 相关链接

- issue：<https://github.com/ShawnLiuSZ/task-dashboard/issues/279>
- 配套 issue（父/子 issue 关联）：<https://github.com/ShawnLiuSZ/task-dashboard/issues/278>
- 工具契约：<https://github.com/ShawnLiuSZ/task-dashboard/blob/develop/mcp_server/AGENT_INSTRUCTIONS.md>
- CHANGELOG：<https://github.com/ShawnLiuSZ/task-dashboard/blob/develop/docs/CHANGELOG.md>

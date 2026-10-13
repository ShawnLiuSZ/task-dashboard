# TaskBoard 隐藏 Bug 整体审查报告

> 审查日期：2026-10-12
> 审查方式：后端 `common.rs` / `db.rs` / `commands.rs`（账号过滤核心）逐行亲自审查；
> `mcp.rs` / `sync.rs` / `on_demand.rs` / `github.rs` / `server.py` 由专项 agent 通读交叉核对；
> 前端 `app/src` 全量 `.ts/.tsx` 由专项 agent 审查，`App.tsx` / `Board.tsx` 关键段亲自核对。
> 重点覆盖历史易错面：账号维度编码、DB 列顺序/迁移、大小写判据、MCP 双实现一致性、并发竞态。

## 一、结论概览

| 严重程度 | 数量 | 说明 |
|---|---|---|
| 中危 | 4 | 首屏聚合视图范围错误、自定义列分组永不命中、sync stale 竞态、Python 写路径 `created_at` 漂移 |
| 低危 | 6 | 跨账号键不一致 ×2、非原子切账号、注释误导、陈旧注释、stale 启发式 |
| 已正确（无回归） | 多项 | 见第五节 |

> 未发现导致数据损坏/安全问题的硬伤（高危 0）。4 个中危均为「可逆 / 受功能旗屏蔽 / 需时间窗重叠」类，但属真实逻辑缺陷，建议按优先级处理。

## 二、中危发现（按优先级）

### 中危-1：启动首屏聚合视图任务范围错误
- **位置**：`app/src/App.tsx:140-144`（accountFilter 计算）、`151-154`（filterRef）、`302-343`（mount）、`363-367`（settings effect）。
- **根因**：组件挂载时 `settings` 为 `null` ⇒ `accountFilter = null` ⇒ 首屏 `load()`（第 303 行）传 `null`。后端 `rows_to_tasks` 对 `None` 读 `meta.active_account_id`（默认 1，`>0`）⇒ 按**单账号**返回。若 UI 的 `viewMode` 最终是 `'all'`，首屏会把单账号数据**伪装成聚合视图**。而 `settings` 到达后的 effect（第 363-367 行）只拉项目状态/自定义列、**不再 `load()`**，直到 focus / 20s 轮询 / 下次同步才纠正。
- **触发**：所有聚合视图用户首屏必现，最长持续约 20s。
- **修复**：在 settings effect（`363-367`）补一次 `void load()`（settings 变化才触发，不会死循环，`coalescedLoad` 会去重）；或 mount 改为 `void loadSettings().then(() => load())`。

### 中危-2：自定义列分组逻辑永远无法命中（潜伏硬 bug）
- **位置**：`app/src/components/Board.tsx:98-112`（`groupTasksByCustomColumns`）；对照 `SettingsPanel.tsx` 的 `genColKey()` / `startAddCol`。
- **根因**：分组用 `valid.has(task.status)` 把任务 `status`（四态 `todo/doing/processed/done`）与 `colKey`（`genColKey` 生成的不透明串 `col_xxx`）匹配，两者取值域完全不同 ⇒ 恒 `false` ⇒ 所有任务进 `unmatched`，命名列恒为空。
- **触发**：`boardMode === 'custom'` 且账户有自定义列时整板错乱。当前被 `CUSTOM_COLUMN_MAPPING_ENABLED = false` 屏蔽入口，但 `boardMode` 可由后端 `set_account_board_mode` 直接置 `custom`（历史数据/外部调用/未来开旗），渲染路径即触发。`board.test.tsx:90-100` 还把错误的 `colKey:'Todo'/status:'Todo'` 假设锁进了测试。
- **修复**：分组改为遍历每列解析 `matchRules`，用 `task.projectStatus` 命中；同步修正 `board.test.tsx`。

### 中危-3：同步 stale 标记与并发按需拉取竞态，误标 closed/done
- **位置**：`app/src-tauri/src/sync.rs:844-899`（写入阶段）。
- **根因**：写入阶段先 `UPDATE tasks SET stale = 1 WHERE account_id = ?1` 把**该账号全量行**标脏，再 upsert `pending` 里的行；最后对 `stale = 1` 且不在 pending 的行执行 `SET candidate_done=1, issue_state='closed', status='done'`。若同步事务进行期间，独立进程里的 MCP 按需拉取（`on_demand::InsertIfAbsent`）恰好插入本账号的新 issue X（此时 X 未进 `pending`），X 被标脏且不被复位 ⇒ 被强制写成 closed/done。
- **触发**：MCP 按需拉取与 App 后台同步在时间窗内重叠（SQLite 只解决锁、不解决逻辑竞态）。后果可逆，下一轮同步会纠正。
- **修复**：stale 标记收窄为「同步开始时已存在的行」——`UPDATE ... WHERE account_id = ?1 AND issue_key IN (<existing_map 的 key 集合>)`（`existing_map` 已在约第 678 行预加载），并发插入的 X 不在集合内即不被标脏。

### 中危-4：Python 按需拉取漏写 `created_at`，双实现字段漂移
- **位置**：`mcp_server/server.py:386-391`（`TASK_INSERT_COLS`）、`575-617`（`_row_from_issue`）。
- **根因**：`TASK_INSERT_COLS` 列清单缺 `created_at`（另有 `parent_issue`/`sub_issues`/`pr_state` 也缺，但 Rust `build_task_row` 把它们显式写成 `""`，值一致，无分歧）。于是经 Python 路径落库的 issue `created_at` 落 schema 默认值 `0`，而 Rust 路径写真实时间戳。此漂移 `check-mcp-columns.py` 兜不住——脚本只校验 `ENSURE_COLUMNS ⊇ SELECT_COLS`，**不交叉比对 `TASK_INSERT_COLS` 与 Rust `db.rs::TASK_INSERT_HEAD`**（正是 MEMORY 记的「加列改 4 处、脚本只查 2 处」盲区的现形）。
- **影响**：经 Python MCP 拉的 issue，下次全量同步前 `created_at` 恒为 0（epoch），「创建于 X 前」展示错乱；两个 MCP 实现对同一 issue 读出 `created_at` 不一致。
- **修复**：`server.py::TASK_INSERT_COLS` 补 `created_at`，且 `_row_from_issue` 返回 `"created_at": _iso_to_secs(payload.get("created_at"))`；建议 `check-mcp-columns.py` 增加断言 `TASK_INSERT_COLS ⊆ Rust TASK_INSERT_HEAD 的列`，堵住 CI 盲区。

## 三、低危发现

### 低危-1：`syncHint` 的 diff 以 `issueKey` 作键，聚合视图跨账号同 `issueKey` 误算
- `app/src/syncHint.ts:30-43`（`snapshotTasks`/`diffChangedTasks`）。聚合视图下同一 `issueKey` 可来自两个账号，`issueKey` 作 map 键会被后者覆盖 ⇒ 「被筛选藏住的新任务数」横幅计数偏差（不改数据正确性）。同文件 `taskSig.ts` 已正确纳入 `accountId`，此处不一致。建议改用 `taskIdentity(t)` 作键。

### 低危-2：`SessionsPanel` 多选以 `issueKey` 作选中键，与渲染 key 不一致
- `app/src/components/SessionsPanel.tsx:172`（`toggleSelectAll`）、`240/256`（`selectedKeys.has`）、`360`（`clearSessions`）。卡片 `key` 用 `taskIdentity(task)`，但选中集合/批量删除用 `issueKey`。聚合视图跨账号同 `issueKey` 时「点一个选中两个」「全选计数失准」。后端 `clear_sessions` 按 `issue_key` 定位（与 `taskIdentity.ts` 写操作约束一致），批量删除语义正确，主要是前端选中态边缘不一致。建议选中集合改用 `taskIdentity`。

### 低危-3：`handleSwitchAccount` 两次写操作非原子
- `app/src/App.tsx:475-485`。`await setActiveAccount(id)` 成功后若 `await setViewMode('single')` 抛错，进入 `catch` 跳过 `loadSettings()`/`loadWith()` ⇒ 后端 `active_account_id` 已变但前端 `settings`/`filterRef` 未刷新，直到下次刷新才自愈；若失败前 `viewMode` 恰为 `'all'`，还会出现「激活账号变了但视图仍是聚合」的瞬时不一致。建议把 `setViewMode` 的失败与 `setActiveAccount` 解耦，无论成败都刷新。

### 低危-4：`App.tsx:137-139` 注释与后端语义矛盾（文档）
- 注释称「`activeAccountId <= 0` 时回传 `null`，仍无账号时返回**空列表**而非全量」，但后端 `rows_to_tasks` 对 `None + 无激活账号` 是**不加 WHERE ⇒ 返回全部账号任务**（非空集）。功能当前未暴露（有激活账号时两者结果一致），但误导维护者。建议改为「无激活账号时后端返回全部账号任务」。

### 低危-5：后端陈旧注释
- `mcp.rs:998` 把 29 列说成 26 列；`db.rs:2034-2035` 占位符注释漏记 `?26=created_at`、`?27=pr_state`。测试逻辑本身正确，建议补全避免下次加列数错占位符。

### 低危-6：`sync.rs` stale → 强制 `closed/done` 启发式（提示）
- `sync.rs:864-899`：注释自承「搜索未返回 = 已关闭**或** assignee 变更」。当 issue 仅因被移出 assignee 而离开搜索结果时仍被无条件写成 closed/done。这是既有设计取舍（candidate_done 软隐藏），非本次回归；如需更精确可在 stale 更新时保留原 `issue_state`、仅靠 `candidate_done` 折叠。仅供后续优化参考。

## 四、已知易错点核对结论（均已正确处理，确认无回归）

| 易错点 | 结论 | 证据 |
|---|---|---|
| 账号维度编码（禁 `?? 0`/`|| 0`） | ✅ 正确 | 前端 `account-filter.test.ts` 全局禁止；`api.ts` 的 `accountId ?? null` 仅把 `undefined` 变 `null` 且保留 `0`；后端 `rows_to_tasks`/`list_active_sessions` 遵守 #422 口径（亲自核对） |
| `active_account_id` 与 `view_mode` 两字段 | ✅ 正确 | `handleSwitchAccount` 先 `setActiveAccount` 再 `setViewMode('single')`;切视图不误改激活账号 |
| 三条 load 路径不刷成 0 | ✅ 正确 | setInterval/focus/onSynced 均走 `load()` → 读 `filterRef.current`,无路径重置为 0 |
| 闭包显式传参 | ✅ 正确 | `handleSwitchView`/`handleSwitchAccount` 捕获最新值且显式传新 id/mode |
| 聚合视图不高亮单账号 | ✅ 正确 | `Sidebar.tsx:127` 的 `showAccountActive` 受 `viewMode!=='all'` 门控 |
| DB 列顺序/迁移 | ✅ 正确 | `write_task` 的 29 列与 `?1–?27` 严格对齐（亲自核对）；`MIGRATION_DDL` 靠错误忽略实现幂等；`MIGRATE_DATA_FIXES` 仅在 `user_version` 提升时跑一次，不每次 `open_db` 写库、不覆盖版本到 6 后的用户手动状态 |
| issue_state 大小写 | ✅ 正确 | 落库全走 `normalize_issue_state`;读判定全走 `is_closed_state`;无硬编码 `== "closed"` |
| MCP 双实现工具集/SELECT_COLS/handoff_len | ✅ 正确 | 两侧均 12 工具、SELECT_COLS 均 29 列顺序一致、`handoff_len` 均字符数口径 |
| 并发合并 / ON CONFLICT | ✅ 正确 | 计算写入分离、单账号写入一次提交、Upsert 覆盖 / InsertIfAbsent 不动策略正确 |

## 五、优先处理建议

1. **中危-1（首屏范围错误）**：影响所有聚合视图用户，复现稳定，改动小（settings effect 补一次 `load()`）。
2. **中危-4（Python `created_at` 漂移）**：双实现一致性硬伤，CI 盲区，修起来简单，建议尽快。
3. **中危-2（自定义列分组）**：开功能旗前必修，且测试已固化错误假设。
4. **中危-3（sync 竞态）**：需 MCP+同步时间窗重叠，可逆，建议作为健壮性加固。
5. 低危项随相关改动一并清理；低危-6 仅作优化提示，非必须。

---

*本报告仅做静态审查，未修改任何源代码。如需针对某项生成修复方案或 PR，请指定。*

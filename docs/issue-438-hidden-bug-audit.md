# #438 整体隐藏 Bug 审查与修复（按功能模块）

> 一次覆盖全仓库（Rust 后端 / React 前端 / Python MCP）的**静态审查**，按功能模块排查隐藏逻辑缺陷。
> 编号 `#438` 为本次审查批次的内部标记（审查发现，非 GitHub issue）。

## 背景 / 动机

用户要求「按照功能，整体检查是否存在隐藏 bug」。此前修复的缺陷多来自用户报障后的被动响应（如 #430/#432/#435），
存在**「已知易错面已修、但同类隐患仍潜伏在别处」**的风险。本次做一次**结构化全量审查**，把散落在各模块的
逻辑不一致一次性收敛，避免逐个被用户撞见。

审查方式：后端 `common.rs`/`db.rs`/`commands.rs`（账号过滤核心）逐行亲自审查 + `mcp.rs`/`sync.rs`/`on_demand.rs`/
`github.rs`/`server.py` 专项通读交叉核对；前端 `app/src` 全量 `.ts/.tsx` 专项审查 + `App.tsx`/`Board.tsx` 关键段亲自核对。
重点核对历史易错面：账号维度编码、DB 列顺序/迁移幂等、`issue_state` 大小写判据、MCP 双实现一致性、并发竞态。

## 审查结论

| 严重程度 | 数量 | 说明 |
|---|---|---|
| 中危 | 4 | 首屏聚合视图范围错误、自定义列分组永不命中、sync stale 竞态、Python 写路径 `created_at` 漂移 |
| 低危 | 6 | 跨账号键不一致 ×2、非原子切账号、注释误导 ×2、stale 启发式（提示） |
| 高危 | 0 | 未发现数据损坏/安全类硬伤 |
| 已正确（无回归） | 多项 | 见文末「已核对无回归项」 |

## 修复项

### 中危-1 启动首屏聚合视图任务范围错误
- **位置**：`app/src/App.tsx`（`accountFilter` 计算 / `filterRef` / mount effect / settings effect）
- **根因**：组件挂载时 `settings` 为 `null` ⇒ `accountFilter = null` ⇒ 首屏 `load()` 传 `null`。
  后端 `rows_to_tasks` 对 `None` 读 `meta.active_account_id`（默认 1，`>0`）⇒ 按**单账号**返回。
  若 UI 最终 `viewMode === 'all'`，首屏会把单账号数据**伪装成聚合视图**。而 `settings` 到达后的 effect
  只拉项目状态/自定义列、**不再 `load()`**，直到 focus / 20s 轮询 / 下次同步才纠正。
- **触发**：所有聚合视图用户首屏必现，最长约 20s。
- **修复**：`settings` effect 内补一次 `void load()`。`load` 读 `filterRef.current`（该 ref 的 effect 先于本 effect 执行），
  故能拿到新 `accountFilter`；`settings` 变化才触发，不会死循环，`coalescedLoad` 去重。
- **测试**：依赖既有 `account-filter.test.ts`（编码口径不变）与前端全量回归。

### 中危-2 自定义列分组逻辑永远无法命中（潜伏硬 bug）
- **位置**：`app/src/components/Board.tsx`（`groupTasksByCustomColumns`）
- **根因**：原用 `valid.has(task.status)` 把任务 `status`（四态 `todo/doing/processed/done`）与 `colKey`
  （`genColKey` 生成的不透明串 `col_xxx`）匹配 —— **取值域完全不同，恒 `false`** ⇒ 所有任务进 `unmatched`，
  命名列恒为空。
- **正确语义**：分组依据是 `task.projectStatus` 命中某列的 `matchRules`（JSON 数组，存 project status 原文），
  `colKey` 只是列的稳定标识，从不参与匹配。
- **触发**：当前被 `CUSTOM_COLUMN_MAPPING_ENABLED = false` 屏蔽入口，但 `boardMode` 可由后端
  `set_account_board_mode` 直接置 `custom`（历史数据/外部调用/未来开旗），渲染路径即触发。
- **修复**：`groupTasksByCustomColumns` 改按 `projectStatus` 命中 `matchRules`；`parseMatchRules`
  抽到共享模块 `app/src/utils/matchRules.ts`（`SettingsPanel` 与 `Board` 共用，避免双实现漂移）。
  `board.test.tsx` 同步更新（原用 `colKey:'Todo'/status:'Todo'` 把错误假设锁进了测试）。
- **测试**：`board.test.tsx` 的 `groupTasksByCustomColumns` 用例改为 projectStatus 命中 matchRules。

### 中危-3 同步 stale 标记与并发按需拉取竞态，误标 closed/done
- **位置**：`app/src-tauri/src/sync.rs`（写入阶段）
- **根因**：写入阶段先 `UPDATE tasks SET stale = 1 WHERE account_id = ?1` 把**该账号全量行**标脏，
  再 upsert `pending` 里的行；最后对 `stale = 1` 且不在 pending 的行执行
  `SET candidate_done=1, issue_state='closed', status='done'`。若同步事务进行期间，独立进程里的 MCP
  按需拉取（`on_demand::InsertIfAbsent`）恰好插入本账号的新 issue X（此时 X 未进 `pending`），
  X 被标脏且不被复位 ⇒ 被强制写成 closed/done。
- **修复**：stale 标记从「account_id 全量」收窄为「**同步前已存在**」（`existing_map` 快照的 key 集合，
  key 即 `issue_key`）。并发插入的 X 不在预存在集合内，不被标脏。
- **可逆性**：原缺陷后果可逆（下一轮同步会纠正）；本次修复消除误判。

### 中危-4 Python 按需拉取漏写 `created_at`，双实现字段漂移
- **位置**：`mcp_server/server.py`（`TASK_INSERT_COLS` / `_row_from_issue`）
- **根因**：`TASK_INSERT_COLS` 列清单缺 `created_at`（`parent_issue`/`sub_issues`/`pr_state` 也缺，
  但 Rust `build_task_row` 把它们显式写成 `""`，值一致无分歧）。于是经 Python 路径落库的 issue
  `created_at` 落 schema 默认值 `0`，而 Rust 路径写真实时间戳 ⇒ 两 MCP 实现对同一 issue 读出不一致。
- **CI 盲区**：`check-mcp-columns.py` 只校验 `ENSURE_COLUMNS ⊇ SELECT_COLS`，
  **不交叉比对 `TASK_INSERT_COLS` 与 Rust `db.rs::TASK_INSERT_HEAD`** —— 正是「加 tasks 列改 4 处、
  脚本只查 2 处」盲区（#262/#278 坑型式）的现形。
- **修复**：`TASK_INSERT_COLS` 补 `created_at`；`_row_from_issue` 写
  `"created_at": _iso_to_secs(payload.get("created_at"))`（`_iso_to_secs` 对 None/空安全返回 0）。
- **测试**：`test_server.py` 新增 `test_row_from_issue_writes_created_at`（期望值由 Python 标准库独立算得，
  非用被测函数自证；并断言 `created_at ∈ TASK_INSERT_COLS`）。

### 低危项
| 编号 | 位置 | 修复 |
|---|---|---|
| 低危-1 | `app/src/utils/syncHint.ts` | `snapshotTasks`/`diffChangedTasks` 键从 `issueKey` 改 `taskIdentity`（聚合视图跨账号同 issueKey 不被覆盖，避免变更计数偏差）；测试同步更新 + 新增跨账号回归用例 |
| 低危-2 | `app/src/components/SessionsPanel.tsx` | 多选选中集合从 `issueKey` 改 `taskIdentity`（点A不误选B）；批量删除前把 `taskIdentity` 映射回 `issue_key` 去重后再传给后端（后端 `clear_sessions` 仍按 `issue_key` 定位） |
| 低危-3 | `app/src/App.tsx` `handleSwitchAccount` | `setActiveAccount` 成功但 `setViewMode('single')` 抛错时，不再跳过 `loadSettings`/`loadWith`（解耦，失败只上错误横幅） |
| 低危-4 | `app/src/App.tsx` 注释 | 更正「无账号返回空列表」的错误描述（后端 `rows_to_tasks` 对 None+active<=0 实际不加 WHERE，返回全部账号任务） |
| 低危-5 | `mcp.rs` / `db.rs` 注释 | 更正「26 列」→「29 列」；补全 `TASK_INSERT_HEAD` 占位符注释（?26=created_at、?27=pr_state） |
| 低危-6 | `sync.rs` stale→closed/done | **仅记录为优化提示，本次不改**：issue 仅因被移出 assignee 也会被写 closed/done（既有设计取舍，candidate_done 软隐藏）；如需更精确可保留原 issue_state 仅靠 candidate_done 折叠 |

## 已核对无回归项（本次审查确认正确，未改动）

- **账号维度编码**（#422）：前端禁 `?? 0`/`|| 0`；`api.listTasks` 的 `accountId ?? null` 仅把 undefined 变 null 且保留 0。
- **`active_account_id` 与 `view_mode` 正交**：`handleSwitchAccount` 先 setActiveAccount 再 setViewMode('single')。
- **三条 load 路径**（setInterval/focus/onSynced）：均走 `load()` 读 `filterRef.current`，不刷成 0。
- **闭包显式传参**：`handleSwitchView`/`handleSwitchAccount` 显式传新 id/mode，不依赖闭包旧 settings。
- **聚合视图不高亮单账号**：`Sidebar.tsx` 的 `showAccountActive` 受 `viewMode!=='all'` 门控。
- **DB 列顺序/迁移**：`write_task` 的 29 列与 `?1–?27` 严格对齐；`MIGRATION_DDL` 靠「执行报错即忽略」幂等；
  `MIGRATE_DATA_FIXES` 仅在 `user_version` 从 <6 升到 6 时跑一次（之后 `schema_is_current` 短路），
  不每次 `open_db` 写库、不覆盖版本到 6 后的用户手动状态。
- **`issue_state` 大小写**（#335）：落库全过 `normalize_issue_state`；读判定全过 `is_closed_state`；无硬编码 `== "closed"`。
- **MCP 双实现工具集/SELECT_COLS/handoff_len**：两侧均 12 工具、SELECT_COLS 均 29 列顺序一致、`handoff_len` 均字符数。
- **ON CONFLICT**：同步 Upsert 覆盖 / 按需拉取 InsertIfAbsent 不动，策略正确。

## 验证（全绿）

- `cargo build` / `cargo fmt --check` / `cargo clippy --lib -- -D warnings` / `cargo clippy --all-targets -D warnings`：✅
- `cargo test`：**194 + 27 passed**，0 failed ✅
- `npx tsc --noEmit` / `npm run lint --max-warnings 0` / `npx prettier --check` / `npm run i18n:check`（401 key）：✅
- `npx vitest run`：**282 passed**（22 files，含新增跨账号 / 自定义列分组回归）：✅
- `npm run build`：✅
- `python3 -m unittest test_server`：**59 passed**（含新增 created_at 回归）：✅
- `scripts/check-mcp-columns.py`：**29 列**一致、ensure_schema 覆盖 35 列 ✅
- `scripts/check-doc-links.py` / `python3 -m unittest discover -s scripts`：✅

## 相关链接

- 审查报告全文：[`CODE-REVIEW-2026-10-12.md`](../CODE-REVIEW-2026-10-12.md)
- 审查方法论（断言强度）：[`methodology-assertion-strength-audit.md`](./methodology-assertion-strength-audit.md)
- 相关历史缺陷：[`issue-435-pr-state.md`](./issue-435-pr-state.md)（位置索引末尾追加）、
  [`issue-169-mcp-server-schema-sync.md`](./issue-169-mcp-server-schema-sync.md)（双实现列漂移）、
  [`issue-422-account-filter-view-mode.md`](./issue-422-account-filter-view-mode.md)（账号维度）
- CHANGELOG：[`CHANGELOG.md`](./CHANGELOG.md) / [`CHANGELOG.en.md`](./CHANGELOG.en.md)
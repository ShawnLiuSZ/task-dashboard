# issue #335 — 已关闭 issue 滞留看板：`closed` 判据大小写敏感 + 英文 Project Status 未映射

> 关联：[GitHub Issue #335](https://github.com/ShawnLiuSZ/task-dashboard/issues/335)、[CHANGELOG.md](./CHANGELOG.md)
> 分支：`fix/issue-335-closed-state-case` → PR 到 `main`

## 背景 / 动机

排查「看板还有哪些未完成任务」时发现：`tasks.issue_state` 已经写着 `CLOSED` 的行，`status` 却仍是 `todo` / `processed` —— 一批**在 GitHub 上早已关闭的 issue 长期滞留在未完成列**，只有点进详情才能看出它其实已关闭。

影响面实测（本地库快照）：

| `issue_state` | 行数 | 说明 |
|---|---|---|
| `closed` | 422 | REST 口径，小写 |
| `OPEN` | 96 | GraphQL 口径，**大写** |
| `CLOSED` | 63 | GraphQL 口径，**大写** |
| `open` | 40 | REST 口径，小写 |

- `issue_state = 'CLOSED'` 且 `status <> 'done'`：**29 行**
- `issue_state = 'closed'` 且 `status <> 'done'`：**0 行**

「小写 0 行异常、大写 29 行异常」这一对照，直接证明缺陷只发生在大写一侧。

29 行的分布：

| 仓库 | 数量 | 落点状态 |
|---|---|---|
| fad-backend | 13 | `todo` 5 / `processed` 8 |
| foodsup-client | 9 | 全 `processed` |
| task-dashboard | 4 | 全 `todo`（#327–#330） |
| foodsup-app-h5-2.0 | 3 | 全 `processed` |

## 设计 / 方案

### 根因链

1. **数据源头大小写不统一**。`github.rs::fetch_project_issues`（ProjectV2 条目查询）从 `content["state"]` 取值，**GraphQL 的 `IssueState` 是大写枚举 `OPEN` / `CLOSED`**；REST（Search API 与 `GET /repos/{o}/{r}/issues/{n}`）返回小写 `open` / `closed`。该值被**原样**写入 `tasks.issue_state`，全链路无归一化。

2. **三处判据写死小写 ⇒ 大写行永不命中**：

   | 位置 | 原代码 | 后果 |
   |---|---|---|
   | `sync.rs::sync_account` | `t.state == "closed"` | 「closed → done 远程权威覆盖」这条 `AGENTS.md §2.2` 的**最高优先级分支**，对 Project 来源的 issue 完全失效 |
   | `db.rs::fallback_state_from_gh_state` | `gh_state == "closed"` | 兜底映射同样不生效 |
   | `commands.rs::set_project_status` | `issue_state == "closed"` 才拒绝写回 | 「已关闭就不再改 Project」的守卫形同虚设 |

3. **兜底也接不住**。closed 判定失效后落到 Project Status 映射，而 `map_project_status()` **只认中文 OMS 文案**（`🧠需求池` / `✨开发中` / `🎉完成/上线` …）；本项目两个 Project 的 Status 选项都是**英文**（`Released` / `Done`）⇒ 返回 `None` ⇒ 按 §2.2 第 4 条「保持既有本地状态」⇒ 卡在 `todo` / `processed` 不动。

4. **同一列的大小写还在继续分化**。`sync.rs` 的 stale 清扫把 `issue_state` 写成**小写** `closed`，与 GraphQL 的大写并存 —— 同一列的两种写法让「按字面值判定」的任何代码都不可靠。

### 修复设计（四层，缺一不可）

| 层 | 做法 | 为什么不能省 |
|---|---|---|
| **判据归一** | 新增 `common::is_closed_state()`（`eq_ignore_ascii_case`），替换全部三处调用点 | 只修一处仍会遗漏其余判定；判据散落是本次缺陷的形式 |
| **落库归一** | 新增 `common::normalize_issue_state()`，同步路径 / 按需拉取路径 / Python MCP 三处落库前统一转小写 | 不归一化则新数据继续产出两种写法，下一个人写 `== "closed"` 又会踩 |
| **映射补全** | `map_project_status()` 追加英文分支（**整值全等匹配**，非子串） | 即便 closed 判定正常，兜底路径本身也是坏的，属独立缺陷 |
| **存量修复** | 新增一次性数据修复，随 `SCHEMA_VERSION = 4` 门控执行 | 代码修好只对**后续**同步生效；已关闭的 issue 不会被 Search API 返回，永远等不到「下次同步」 |

英文映射刻意用**整值全等**而非子串：`Ready for release` 含 `release` 但并非已完成，子串匹配会把它误判成 `done`。归一化步骤会去掉 emoji 与标点、把连字符折成空格，因此 `✅ Done` / `in-progress` 仍能正确识别；不认识的选项一律返回 `None`（保持本地手动态，绝不臆造）。

### 存量数据修复的取值取舍

**不写 `done_at`**。一次修复拿不到真实关闭时间，而 `done_at` 在本仓库唯一用途是 `sync.rs` 的「已完成任务保留 1 个月」淘汰窗口（`WHERE done_at > 0`）——臆造一个时间戳会凭空启动淘汰倒计时，把本可保留的记录删掉；留 `0` 反而保证这些行不被误删。前端不读 `done_at`，故看板展示不受影响。

修复语句刻意做成 **best-effort**：失败只记日志，不影响 `user_version` 推进。若因失败而卡住版本号，`needs_migration` 会恒为真，稳态将每次建连都跑一遍迁移，直接回归 #329 修掉的「每次 `open_db` 写库」缺陷。即便这里整段失败，代码层修复也会让下一次全量同步逐行修正。

## 接口 / 行为变更

| 项 | 变更 |
|---|---|
| Tauri 命令 | 无签名变化。`set_project_status` 对已关闭 issue 的拒绝**行为生效范围扩大**（此前只拦小写 `closed`，现也拦 `CLOSED` / `Closed`） |
| MCP 工具 | 无签名变化。`issue_state` 返回值由「原样透传」变为**恒小写**；`status` 对已关闭 issue 更可靠地落到 `done` |
| 看板状态映射 | **行为变更**：Project Status 为英文选项（`Done` / `Released` / `In progress` / `In Review` / `Backlog` / `To Do` 等）时，此前一律「保持本地手动态」，现在会映射到四态。这是本次修复的必要组成——否则 closed 判据修好后，兜底路径仍是坏的 |
| i18n | 无 key 变更 |
| MCP `SELECT_COLS` | 无列变更 |
| 前端 | 无改动 |

⚠️ 上表第 3 行是**唯一的对外行为变更**，需在 CHANGELOG 中显式声明。既有的 `resolve_final_status_follows_priority` 用例原先拿 `"Backlog"` 当「映射不到」的样例，该样例已随本次变更失效，改为真正未识别的值。

## 数据 / Schema 变更

无结构变更（无新增 / 改名 / 删除列），但 `SCHEMA_VERSION` 由 `3` 提升到 `4`，以门控一次性**数据修复**：

```
-- 顺序敏感：先归一化，再判定
UPDATE tasks SET issue_state = lower(trim(issue_state))
  WHERE issue_state <> lower(trim(issue_state));

UPDATE tasks SET status = 'done'
  WHERE issue_state = 'closed' AND status <> 'done';
```

两条均幂等，可安全重跑。第二条必须排在第一条之后（依赖归一化后的 `closed`）。

## 测试 / 验收

### 新增用例

| 层 | 用例 | 覆盖 |
|---|---|---|
| `common.rs` | `normalize_issue_state_folds_graphql_uppercase` | 大写折小写、空白容忍、未知值不臆造 |
| `common.rs` | `is_closed_state_is_case_insensitive` | `CLOSED` / `Closed` / `closed` 全部为真；`unclosed`、`closed_by_bot` 不得误判 |
| `sync.rs` | `uppercase_graphql_closed_resolves_to_done_like_rest` | 大写 `CLOSED` 与 REST 小写走完全相同路径，且优先级最高 |
| `sync.rs` | `map_project_status_recognizes_english_options` | 英文选项识别 + emoji/连字符容忍 + 未识别项返回 `None` + `Ready for release` 不得判成 `done` |
| `sync.rs` | `chinese_oms_status_mapping_is_unchanged_after_english_fallback` | 中文口径逐条不回归 |
| `tests/db_test.rs` | `migration_v4_normalizes_issue_state_and_repairs_closed_status` | 迁移端到端：归一化 + 状态修正 + `OPEN` 不误改 + `done_at` 不臆造 + 版本号推进 |
| `mcp_server/test_server.py` | `IssueStateCaseTest`（3 例） | Python 侧同语义（AGENTS.md §8.6 两侧一致），含 `_row_from_issue` 落库结果 |

### 反向验证（改回缺陷写法必须失败）

| # | 改动 | 期望 | 实测 |
|---|---|---|---|
| 1 | `is_closed_state` 改回 `raw.trim() == "closed"` | `common` / `sync` 两处用例失败 | ✅ `is_closed_state_is_case_insensitive`、`uppercase_graphql_closed_resolves_to_done_like_rest` 均 FAILED（`144 passed; 2 failed`） |
| 2 | 清空 `MIGRATE_DATA_FIXES` 两条语句 | `db_test` 迁移用例失败 | ✅ `migration_v4_normalizes_issue_state_and_repairs_closed_status` FAILED（`24 passed; 1 failed`） |
| 3 | Python `is_closed_state` 改回大小写敏感 | Python 两例失败 | ✅ `FAILED (failures=2)`，含 `'todo' != 'done'` |

### 全量校验

`cargo test --lib` 146 passed（+5）、`cargo test --test db_test` 25 passed（+1）、`cargo fmt --check` 通过、`cargo clippy --lib -- -D warnings` 通过、Python MCP `unittest` 36 passed（+3）。

## 相关链接

- 上游批次：[`docs/issue-327-p0-functional-defects.md`](./issue-327-p0-functional-defects.md)、[`docs/issue-328-p1-data-safety.md`](./issue-328-p1-data-safety.md)、[`docs/issue-329-p2-quality.md`](./issue-329-p2-quality.md)、[`docs/issue-330-p3-quality-gates.md`](./issue-330-p3-quality-gates.md)
- 相关设计：[`AGENTS.md`](../AGENTS.md) §2.2 同步优先级；[`docs/issue-262-multi-account-sync.md`](./issue-262-multi-account-sync.md)（多账号同步）、[`docs/issue-250-ondemand-issue-pull.md`](./issue-250-ondemand-issue-pull.md)（按需拉取落库）
- 症状同源：[`docs/issue-279-work-branch-not-updated.md`](./issue-279-work-branch-not-updated.md)（基线分支名口径不一致导致的状态记录偏差）

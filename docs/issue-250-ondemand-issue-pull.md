# #250 未同步的 issue 按需拉取 —— 消除写状态时的「任务不存在」

## 背景 / 动机

`tasks` 表**只由 `sync.rs` 从 GitHub 单向拉取填充**（`AGENTS.md §2.1` 的数据流向），而 MCP 工具是纯本地 SQL。
两者之间原先没有任何「查不到就去要」的通道，于是**刚创建、还没同步到的 issue**会把 agent 工作流卡在第一步。

真实触发：

```
10:26  创建 issue #248
10:52  update_task_status("task-dashboard#248", "处理中")
       → 错误：任务不存在: task-dashboard#248
```

这个窗口期不短——本项目里 issue 与 PR 常由 agent 连续创建（#248 的 issue 与 PR #249 相隔 3 分钟），
而同步是定时 / 手动触发的。

| 工具 | 未同步时的行为（修复前） |
|---|---|
| `update_task_status` | ❌ `任务不存在: {key}` |
| `record_session` | ❌ `任务不存在: {key}` |
| `record_handoff` | ❌ `任务不存在: {key}` |
| `clear_session` | ❌ `任务不存在: {key}` |
| `get_task_status` | ⚠️ `found: false`（不报错，但与写路径不一致） |

对应 issue：[#250](https://github.com/ShawnLiuSZ/task-dashboard/issues/250)。

## 设计 / 方案

### 根因（三个，第 2、3 条是实现时才暴露的）

1. **本地库是唯一权威，但只有同步能填充它** —— 这是设计意图，缺的是「按需补一条」。
2. **`mcp.rs::parse_issue_ref` 会丢掉 owner** —— `owner/repo#N` 与 GitHub URL 都归一化成 `repo#N`，
   而拉取单个 issue 需要 `owner` + `repo` 才能定位资源。
3. **`github.rs::RawTask::from_item` 不能直接复用** —— 它是为 Search API 写的，强依赖
   `repository_url`（用尾段取 repo）；单 issue 的 REST 响应**没有** `repository_url`，只有 `repository` 对象，
   照搬会直接 `Err("search item 缺字段 repository_url")`。

### 决策 1：只拉这一个 issue，不触发全量同步

全量同步要遍历账号下所有 5 条数据源 + PR 关联 + Project GraphQL，重且吃配额，
还会把「补一行」变成「几分钟的批量任务」。按需拉取只发**一次** `GET /repos/{owner}/{repo}/issues/{n}`
（走核心配额，不是 Search API 的 30/min）。

### 决策 2：拉取必须发生在写入**之前**，而不是「写入失败后重试」

`common::set_task_status` 会先做状态校验，而**自定义列（非四态）的校验要读该行的 `account_id`**——
行还不存在时会误报「非法状态」。所以流程定为：

```
检查本地是否存在 → 不存在则按需拉取 → 再执行写入（校验此时能看到 account_id）
```

Python 侧同一顺序（`_ensure_before_write`）。

### 决策 3：落库用 `DO NOTHING`，不用 `DO UPDATE`

按需拉取只有单个 issue 的 REST 数据，`project_status`（需 GraphQL）、`mentioned`、`pr_number`、
`branch` 等字段**拿不到**。若以同步那套覆盖模式写入，会把同步刚写好的这些值**清空**。
因此 `db::write_task` 带一个模式参数：

| 模式 | 冲突行为 | 使用方 |
|---|---|---|
| `TaskWriteMode::Upsert` | `DO UPDATE`（覆盖） | 同步路径（刚拉取的数据是权威值） |
| `TaskWriteMode::InsertIfAbsent` | `DO NOTHING`（不动） | 按需拉取（绝不覆盖既有行） |

两种模式**共用同一份列清单与参数绑定**（`TASK_INSERT_HEAD` 常量）——新增/改列时不可能只改一边。
这也是把 `sync.rs` 内联的 upsert 抽出来的原因：`#147` 的教训正是「两边各写一遍，逻辑分叉」。

顺带修掉一个竞态：拉取期间 App 的同步可能刚好写入了这一行，`DO NOTHING` 让这种情况零副作用。

### 决策 4：读路径保持「永远能回答」，失败降级为 `reason`

`get_task_status` 原先对任何引用都能作答（`found: false`）。接入按需拉取后，如果让账号缺失 /
网络失败 / DB 异常直接抛错，读操作就会**从「可回答」变成「抛异常」**——这是回退。
（这个回归是接入后跑既有单测时被抓到的：`get_task_status_returns_correct_column_values` 用了
一个没有 `accounts` 表的 fixture，于是直接 panic。）

现在读路径把一切失败降级为 `found: false` + `reason` 文本，信息不丢，但读不变成异常；
写路径则相反——写不成就是错，错误文案必须带原因。

### 决策 5：账号选择偏向「宁可报错，不猜」

`tasks` 的唯一键是 `(repo, number, account_id)`，选错账号会插出一行**重复任务**：

| 情形 | 行为 |
|---|---|
| ref 带 owner（`owner/repo#N` / URL） | 与账号的 **`org` 或 `login`**（大小写不敏感）匹配；多个候选取 `is_default` |
| owner 无匹配账号 | 报错并**列出已知 owner/org**（不静默落到默认账号） |
| ref 只有 `repo#N` | 用 `db::default_account_id`（`is_default=1`，无则 id 最小） |
| 无账号 / PAT 为空 | 报错，**不发无意义的网络请求** |

> ⚠️ **`login` 必须参与匹配**（真机发现）：实测本地库里 task-dashboard 所属账号的 `org` 是**空串**
> （个人命名空间仓库，`tasks.owner` 也因此全是空）。若只按 `org` 匹配，
> `ShawnLiuSZ/task-dashboard#N` 会找不到账号 —— 恰好是本功能最需要可用的场景。
> 这条是跑真机验证时才暴露的，单测里我最初构造的账号 `org` 都有值，测不出来；
> 现已补 `pick_account_matches_login_when_org_is_empty` 固化。

### 决策 6：区分「API 请求用的 owner」与「落库的 `owner` 列」

两者语义不同，实测会踩：

| | 取值 | 用途 |
|---|---|---|
| `api_owner` | ref 显式给的，否则 `account.org`（为空则退回 `account.login`） | 拼 `GET /repos/{owner}/{repo}/issues/{n}` |
| `tasks.owner` | **`account.org`**（即便为空串） | 归属账号的 org，**与同步保持一致** |

若不区分：`org` 为空时 URL 会拼成 `/repos//repo/issues/n`（必 404）；
或把 `login` 写进 `owner` 列，导致同一仓库的行在库里一半是空、一半是登录名。

### 决策 7：`repo#N`（不带 owner）的 404 必须说清「是推断的」

`AGENTS.md §7` 明确允许 `repo#N` 写法。此时 owner 由默认账号推断，**404 不代表 issue 不存在**——
可能只是命名空间不对（例如默认账号是 `FoodsUp-Inc`，而仓库属于 `ShawnLiuSZ`）。
笼统报「远端没有该 issue」会让 agent 误判，所以错误里带上实际查询目标与改写提示：

```
错误：任务不存在且无法从 GitHub 拉取: task-dashboard#999
（已按 `FoodsUp-Inc/task-dashboard#999` 查询，远端没有该 issue（或该编号是 PR）；
  该 owner 是由账号推断的，若仓库属于其他命名空间，请用 `owner/repo#N` 形式指定）
```

带 owner 的引用则不加推断提示（避免噪音）。

### 决策 8：两侧同步（`AGENTS.md §8.6`），Python 侧用标准库

| 侧 | 文件 | 网络实现 |
|---|---|---|
| Rust（主） | `src/on_demand.rs` + `github.rs::fetch_issue` | 复用既有 `reqwest` 客户端（`get_opt` 让 404 → `Ok(None)`） |
| Python（兜底） | `mcp_server/server.py` | `urllib.request`，**零新依赖** |

Python 侧完整移植了同一套规则（账号选择、`closed→done` / label 映射 / 兜底 `todo`、
`classification`、`ON CONFLICT DO NOTHING`），并新增 `mcp_server/test_server.py` 守住不回归。

### 决策 9：状态判定复用同步的同一套实现

不另写口径，直接调 `sync::resolve_final_status` 与 `sync::classify`：

```
closed → done ；显式 label 映射（含映射到 todo，#192）；Project Status（REST 拿不到，跳过）；兜底 todo
```

`任务` 的 Project Status 只能走 GraphQL，因此新建行的 `project_status` 为空——
这一点符合 `AGENTS.md §2.2` 的优先级：**本地权威 + 下次同步补齐**，而不是猜一个值。

### 已知限制

| 限制 | 原因 | 何时被修正 |
|---|---|---|
| `project_status` 为空 | Project field 值需 GraphQL，单 issue REST 没有 | 下次全量同步 |
| `mentioned` 记 0 | 依赖 Search API 的 mentions 源（覆盖正文与评论里的 @） | 下次全量同步 |
| `pr_number` / `pr_url` / `branch` / `latest_comment_url` 为空 | 来自多源聚合（PR 关联、分支反查、评论回源） | 下次全量同步 |
| `repo#N` 不带 owner 时可能推断错命名空间 | 只能拿默认账号的 owner 试；已用错误文案给出改写提示（决策 7） | 引用规范：建议始终带 owner |
| MCP 侧发起的这次 GET **不进 `api_logs`** | sink 由 App 同步路径注入，MCP 进程独立 | 可选后续 |
| 「远端没有」每次都真的请求一次 | 未做否定结果缓存（命中后不再请求） | 可选后续 |

## 接口 / 行为变更

### MCP 工具（两侧一致）

| 工具 | 行为变更 | 返回体新增 |
|---|---|---|
| `update_task_status` | 未命中 → 按需拉取后写入 | `pulled` |
| `record_session` | 同上 | `pulled` |
| `record_handoff` | 同上 | `pulled` |
| `clear_session` | 同上 | `pulled` |
| `get_task_status` | 未命中 → 按需拉取后再查；仍拿不到时返回 `found:false` + **`reason`** | `pulled` / `reason` |

错误文案（写路径，不可用时）：

```
任务不存在且无法从 GitHub 拉取: {key}（远端没有该 issue，或该编号是 PR）
任务不存在且无法从 GitHub 拉取: {key}（{具体原因：无账号 / owner 无匹配 org / 未配 PAT / 网络…}）
```

工具描述（`tools/list`）同步更新，让 agent 知道「不需要再手动触发同步」。
**不再返回**含糊的 `任务不存在: {key}`（除非拉取成功却仍写不进，属不该发生的情况）。

### 新增 / 改动的内部实现

| 位置 | 变更 |
|---|---|
| `src/on_demand.rs` | **新增**：`parse_issue_ref_parts`（保留 owner）、`ensure_task_available`、`EnsureOutcome`、`pick_account`、`task_exists`、`build_task_row` |
| `src/github.rs` | `RawTask::from_issue_rest`（REST 形状）；`fetch_issue`；`get_opt`（404 → `None`）；`get_with_timeout` 抽出 `get_impl`（签名与行为不变）；`from_item` 里可复用的解析抽成 `logins_from_array` / `label_names_from_array` / `author_from_user` |
| `src/db.rs` | `TaskUpsert` + `write_task(..., TaskWriteMode)`；`TASK_INSERT_HEAD` / 两种冲突子句 |
| `src/sync.rs` | 删掉内联 `PendingUpsert` 与 upsert SQL，改用 `db::TaskUpsert` + `db::write_task` |
| `src/mcp.rs` | `parse_issue_ref` 委托新解析器（消掉重复实现）；`ensure_local_task` / `write_with_on_demand` / `fetch_task_row`；5 个工具接入 |
| `mcp_server/server.py` | `parse_issue_ref_parts` + 按需拉取全套（`urllib`）；5 个工具接入 |
| `mcp_server/test_server.py` | **新增**：21 个 stdlib unittest |
| `.github/workflows/mcp-schema-check.yml` | 同 job 追加 Python MCP 单测步骤 |

## 数据 / Schema 变更

无。未改 `tasks` 表结构，无需迁移。
（`check-mcp-columns.py` 仍为 24 列一致。）

## 测试 / 验收

### 已跑的检查

| 检查 | 结果 |
|---|---|
| `cargo test --lib` | **93 passed**（+11：on_demand 解析/账号选择；+2：mcp 按需拉取契约） |
| `cargo test --test db_test` | 21 passed |
| `cargo clippy --lib -p taskboard -- -D warnings` | ✅ 零警告 |
| `python3 -m unittest discover -s mcp_server` | **26 passed**（新增） |
| `npx tsc --noEmit` | 0 error（前端未改动，复核） |
| `npm test` | 10 文件 84 例（前端未改动，复核） |
| `python3 scripts/check-mcp-columns.py` | ✅ 24 列 |
| `python3 scripts/check-doc-links.py` | ✅ 119 个 md |

### 真机端到端验证（真实 GitHub + 真实 PAT，非打桩）

用**数据库副本**（`.backup` 出来，避免验证过程污染真实数据）跑二进制内置 MCP：

```bash
printf '%s\n' \
 '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
 '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"update_task_status","arguments":{"issue":"ShawnLiuSZ/task-dashboard#250","status":"处理中"}}}' \
 | TASKBOARD_DB=/tmp/tb-e2e/taskboard.db ./app/src-tauri/target/debug/taskboard mcp
```

| 用例 | 实际结果 |
|---|---|
| 未同步 issue 写状态 | `{"issue_key":"task-dashboard#250","ok":true,"pulled":true,"status":"doing"}` |
| 落库内容 | `owner=''`（与既有 120 条 task-dashboard 记录一致）、`author=ShawnLiuSZ`、`labels=enhancement`、`project_status=''`、`account_id=4`、`stale=0` —— 字段全部来自真实 GitHub 响应 |
| 再次调用 | `pulled:false`（零网络请求），`status=done` 写入生效 |
| 不存在的 issue（读） | `{"found":false,"reason":"本地无此任务，且已按 \`ShawnLiuSZ/task-dashboard#999999\` 查询，远端没有该 issue（或该编号是 PR）"}`（**不报错**） |
| 不存在的 issue（写） | `isError=true`，文案带实际查询目标；`repo#N` 形式还会附「owner 是推断的」改写提示 |
| 未知 owner | `isError=true`：`ref 里的 owner \`NoSuchOrg\` 没有对应账号（已知 owner/org: ShawnLiuSZ, FoodsUp-Inc, liushizhao2025）` |
| 真实库 | 同样执行成功（`task-dashboard#250` 已入库、`status=doing`，即本次开发按 `AGENTS.md §7` 记为「处理中」） |

这也是**发现决策 5「`org` 为空」与决策 6「owner 语义混淆」的地方**——两条都是单测测不到、
只有拿真实库跑才会暴露的问题。

### 关键契约测试（两端各一份）

| 契约 | Rust | Python |
|---|---|---|
| 行已存在 → **零网络请求** | `on_demand_skips_network_when_row_exists` | `test_existing_row_skips_network` |
| 无账号 → 报错且**不发请求** | `on_demand_without_account_fails_fast_with_reason` | `test_write_without_account_fails_with_reason_not_network` |
| 读路径失败降级不报错 | （由既有 `get_task_status_returns_correct_column_values` 覆盖） | `test_get_status_degrades_without_account` |
| `DO NOTHING` 不覆盖既有行 | — | `test_insert_if_absent_does_not_overwrite` |
| 编号是 PR → 远端视为不存在 | — | `test_pull_request_number_is_remote_missing` |

**为什么单测不做真实的 HTTP 请求**：真实网络 + 真实 GitHub 不适合放进 CI（不稳定、吃配额、要 PAT）。
所以单测只钉住「不发请求」「不覆盖」「错误带原因」这些最容易回归的契约，
真实路径由上面那组**真机端到端验证**覆盖（数据库副本 + 真实 PAT，结果已附）。

### 验收清单

1. 对本地不存在但 GitHub 存在的 issue 调 `update_task_status`：成功，`ok: true` + `pulled: true`，本地多出该行且 `status` 为请求值
2. `record_session` / `record_handoff` / `clear_session` 同样生效
3. `get_task_status` 对未同步 issue 返回 `found: true` + `pulled: true`
4. ref 带 owner 时按 owner 匹配账号；只给 `repo#N` 用默认账号；**不产生重复行**
5. 远端 404 → 明确报「远端没有该 issue（或该编号是 PR）」
6. 无账号 / PAT 为空 → 明确报错且**不发网络请求**
7. 网络失败 / 401 / 限流 → 错误文本带原因
8. 已存在的任务仍走纯本地路径（不额外发 API 调用）
9. 只读 GitHub：不写回、不改 project、不触发全量同步
10. 两侧 MCP 行为一致；`check-mcp-columns.py` 通过

## 相关链接

- issue：[#250](https://github.com/ShawnLiuSZ/task-dashboard/issues/250)
- 分支：`feature/issue-250-ondemand-issue-pull`
- CHANGELOG：[`CHANGELOG.md`](./CHANGELOG.md) Unreleased 段
- 相关：[`issue-169-mcp-server-schema-sync.md`](./issue-169-mcp-server-schema-sync.md)（两侧 MCP 必须同步的历史教训）
- 触发本次修复的现场：**#248**（创建 issue 后立刻要写状态，撞上这个缺口）。
  其知识库文档 `docs/issue-248-synclogs-hscroll.md` 在本 PR 的目标分支 `develop` 上尚不存在
  （#248 仍在独立 PR 里），故此处不建相对链接，避免断链——`scripts/check-doc-links.py` 会拦。

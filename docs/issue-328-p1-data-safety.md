# #328 P1 批次：数据安全与健壮性 9 项

> code review 的 **P1 批次**，来源 [`CODE-REVIEW-2026-09-30.md`](../CODE-REVIEW-2026-09-30.md)
> （基线 `main @ f66f83f` / v0.6.5）。
> 本批全部集中在**本地数据安全**与**静默失败**：多数缺陷会导致丢数据、进程退出，
> 或让用户看到「成功」但实际什么都没发生。

## 背景 / 动机

P0 批次（[#327](./issue-327-p0-functional-defects.md)）处理的是用户可直接感知的功能缺陷；
本批处理的是**不会立刻报错、但会悄悄吃掉数据或掩盖故障**的问题。9 项按危害归类：

| # | 问题 | 危害等级 | 触发条件 |
|---|---|---|---|
| 1 | `migrate_tasks_v2_rebuild` 声称「单事务」实则无事务 | **丢数据** | 老库升级瞬间断电 / 被杀 |
| 2 | MCP 一行坏 JSON 就退出整个进程 | 可用性 | 客户端发 BOM / 写入被截断 |
| 3 | MCP `Content-Length` 无上界 → 分配失败 abort | 可用性 | 畸形客户端声明超大长度 |
| 4 | 同步全败仍返回 `Ok` | **静默失败** | PAT 失效 / 断网 |
| 5 | `graphql()` 无限流重试 | **静默降级** | GraphQL 独立配额耗尽 |
| 6 | GUI 写命令吞掉「0 行受影响」 | 静默失败 | 前端传已不存在的 task |
| 7 | 查询错误被折叠成「不在任何 Project 中」 | 排障误导 | 任何 DB/schema 故障 |
| 8 | 全部 403 当限流 → 权限问题白等 30s | 体验 / 误判 | token 无权限、SSO 未授权 |
| 9 | `search()` 单条坏 item 拖垮整个数据源 | 数据缺失 | 单条 API 返回缺字段 |

## 设计 / 方案

### 1. 迁移必须原子（`db.rs::migrate_tasks_v2_rebuild`）

`rusqlite::Connection::execute_batch` **不会隐式开启事务**——它只是逐条
`prepare` + `step`。原实现把 `CREATE TABLE tasks_new` … `DROP TABLE tasks` …
`ALTER TABLE tasks_new RENAME TO tasks` 写在一个 `execute_batch` 里并注释「单事务」，
因此 `DROP` 与 `RENAME` 是两次独立提交，产生两类后果：

1. **丢数据**：两步之间进程被杀 → `tasks` 已消失、数据滞留 `tasks_new`；下次启动
   `CREATE TABLE IF NOT EXISTS tasks` 重建**空表**，本地权威态（`status` /
   `session_*` / `handoff` / `work_branch` / `work_dir`）永久丢失。
2. **永久卡死**：`CREATE TABLE tasks_new` 没有 `IF NOT EXISTS`，若上一次在
   `INSERT..SELECT` 阶段失败（如撞 `UNIQUE(repo, number, account_id)`）就会残留
   `tasks_new`，此后每次 `open_db` 都在这里报「table tasks_new already exists」⇒
   `migrate_tasks_v2_rebuild` 返回 `Err` ⇒ `needs_v2` 恒 `false` ⇒ `user_version`
   永不推进，而 `tasks` 仍带旧 `key` 列 ⇒ 后续查询报 `no such column: issue_key`。
   日志只有默认静默的 `tlog!`，**没有自愈路径**。

修复：

```sql
DROP TABLE IF EXISTS tasks_new;   -- 自愈上次残留
BEGIN IMMEDIATE;
CREATE TABLE IF NOT EXISTS tasks_new ( … );
INSERT INTO tasks_new (…) SELECT … FROM tasks;
DROP TABLE tasks;
ALTER TABLE tasks_new RENAME TO tasks;
CREATE INDEX IF NOT EXISTS … ;
PRAGMA user_version = 2;          -- 版本推进也在事务内
COMMIT;
```

失败时显式 `ROLLBACK`——`execute_batch` 不替调用方收尾，否则连接会一直挂在
未提交事务里，后续 `open_db` 的写入被卷进同一事务或拖到进程退出才被动回滚。

`user_version` 挪进事务后，`open_db` 里原有的 `if needs_v2 { pragma_update(2) }`
退化为**非 legacy-key 老库**（仅 `user_version < 1`）的幂等兜底，legacy 路径重复写一次无害。

### 2 / 3. MCP stdio 分帧健壮性（`mcp.rs`）

`read_message` 原来返回 `Option<(Value, Framing)>`，用 `None` **同时表示 EOF 与
「这一行畸形」**。主循环 `while let Some(..)` 因此把畸形行也当成流结束 → `run()` 返回
→ stdio 断开；而日志文案写着「跳过该行」，**注释与行为不符**。agent 侧表现为随机
`connection closed`。

改为四态枚举，把「能否继续读下一条」这一语义显式建模：

| 变体 | 含义 | 主循环行为 |
|---|---|---|
| `Msg(Value, Framing)` | 有效消息 | 处理并写回 |
| `Eof` | 流正常结束 / 底层读错误 | `break` 退出 |
| `Malformed(String)` | 本帧畸形但**已完整消费** | 记日志后继续读下一条 |
| `Fatal(String)` | **帧边界已丢失** | 记日志后终止 |

区分的依据是「帧边界是否还能定位」：

- NDJSON 解析失败 → 该行已读到 `\n` 或 EOF，边界清晰 ⇒ `Malformed`；
- Content-Length 头部正常收尾但缺该头 ⇒ 边界在头部结束处 ⇒ `Malformed`；
- body 缺 `Content-Length` 无法跳过 / 头部迟迟不终止 / **`len` 越界** ⇒ `Fatal`
  （body 尚未消费，继续读只会把 body 字节当头部解析出更多垃圾）。

同时加上限：body 8 MiB、头部 8 KiB。原实现 `let mut body = vec![0u8; len]` 直接吃
客户端声明，`Content-Length: 99999999999` 会分配失败后 **abort（不可捕获）**。

### 4. 同步全败不再谎报成功（`sync.rs::run`）

循环内任一账号「读 PAT 失败」或「PAT 为空」都走 `continue`，`sync_account` 失败走
`Err` 分支——两条路径都只往 `total_failed` 里塞字符串。于是**全部账号都失败**时
`run` 仍返回 `Ok`，`lib.rs::run_sync` 据此清空 `last_sync_error`、推进 `last_sync_at`、
广播 `SYNCED_EVENT`——UI 显示「同步成功」，实际一条都没拉到。

修复后：

- 新增 `ok_accounts` 计数（仅 `sync_account` 返回 `Ok` 时自增），`== 0` 时返回 `Err`；
- 把「清理过期已完成任务 / 写 `last_sync_at` / 清理 sync_logs / api_logs」**移到早返回
  之前**，保证失败路径同样留下可观测痕迹（用户能判断「上次尝试是何时、为什么失败」）；
- `continue` 分支（读 PAT 失败 / PAT 为空）补 `update_sync_log(..., "failed", ...)`：
  原实现仅对进入 `sync_account` 的账号收尾日志，被跳过的账号那一行**永久停在
  `status='running'`**，前端「同步日志」永远显示「进行中」。

`accounts_synced` 字段语义**保持不变**（#262 的「本次覆盖的账号数」）——成败明细由
`warning` 承载，避免连带改 `types.ts` 注释 / i18n 文案 / #262 KB 文档。

### 5. GraphQL 限流与部分成功（`github.rs`）

`graphql()` 原实现只判 `!status.is_success()` 即 `Err`，而它的四个调用方
（`fetch_all_projects` / `status_field` / `fetch_project_issues` / `fetch_issue_links`）
**全是 best-effort**：失败只记日志、保留既有值。GraphQL 有**独立于 REST 的配额**，
超限返回 403 + `Retry-After`，于是限流窗口内会**静默降级**——Project Status 全空、
父子关系不更新，用户只看到「数据莫名少了」。

两项修改：

- `graphql_impl(query, strict_errors)` 抽出共用实现，403/429 时走与 `get_impl` 同一套
  `rate_limit_wait` 判定 + 退避重试（最多 3 次，上限 `MAX_BACKOFF_MS`）。
- 新增 `graphql_partial`（宽松模式）：GraphQL 允许「部分成功」（`data` 有值同时
  `errors` 非空，典型是批量查询里某个别名指向的资源 `NOT_FOUND` / `FORBIDDEN`）。
  `fetch_issue_links` 一次把 25 个编号拼成一个查询，走严格模式时**一个编号失效就让
  整块 25 个 issue 的父子关系全丢**。改为宽松模式后，`data` 有值即采信，取不到的编号
  自然不落进 map，其余编号照常更新；只有 `data` 整体为 `null` 时才返回 `Err`（维持
  原有「整块失败则保留既有值」的契约）。写路径一律仍走严格模式。

### 6. GUI 写命令校验受影响行数（`commands.rs` + `common.rs`）

`common::set_task_status` / `touch_session` / `set_work_branch` 都返回受影响行数
（`0` = `issue_key` 不存在），但调用方策略不一致：

| 调用点 | 原行为 |
|---|---|
| `mcp.rs::write_with_on_demand` | 报「任务不存在」✅ |
| `commands.rs::set_work_branch` | 报「任务不存在」✅ |
| `commands.rs::update_task_status` | **丢弃返回值** ❌ |
| `commands.rs::record_session` | **丢弃返回值** ❌ |

前端传一个已不存在的 `issueKey` 会收到 `Ok`，UI 显示成功但什么都没改。抽出
`common::require_affected(n, key)` 收敛为单一实现，四处共用（MCP 侧文案不变，
`mcp_server/server.py` 镜像了该契约）。

### 7. 写回查询不再吞 DB 错误（`db.rs`）

`resolve_project_write_target` / `project_option_id` 用
`.map(Some).unwrap_or(None)` 把**所有** DB 错误（含 `no such table`、类型不符、IO）
折叠成「没找到」，于是 `set_project_status` 的排障路径会把真实 schema/IO 故障报告成
「任务 xxx 不在任何 Project 中（或同步尚未拉取条目 id）」，把用户引向「再同步一次」的
无效操作。改为只把 `QueryReturnedNoRows` 映射为 `None`，其余错误带原文上抛。

### 8. 403：限流还是权限？（`github.rs`）

GitHub 的 403 有两种含义：限流（主配额耗尽 / 二级限流）与「token 无权限 / SSO 未授权 /
组织策略」。原实现一律当限流，缺权限时每次请求白睡默认 10s、重试 3 次共 ~30s，最后
仍然失败。抽出 `rate_limit_wait_from_headers`（纯函数，便于单测）统一判定：

- `429` → 限流；
- `403` → **仅当** `X-RateLimit-Remaining == 0`（主配额耗尽）**或**存在 `Retry-After`
  （二级限流）才按限流；否则返回 `None`，调用方立即报错并附权限指引
  （`non_rate_limit_hint`：提示检查 PAT 的 `repo` 权限与组织 SSO 授权）。

`get_impl` / `search` / `graphql_impl` 三处共用，避免各写一套而漂移。顺带补上
`search()` 重试路径**漏掉**的 `if items.len() < 100 { break; }`——原实现满页后还会再打
一次必然为空的请求。

### 9. `search()` 单条坏数据隔离（`github.rs`）

原实现 `for item in &items { all.push(RawTask::from_item(item)?) }`：一条缺字段的坏
item 让整个 `search()` 返回 `Err`，该数据源进 `failed`，**同源其它几百条正常数据一起
丢**。而 `fetch_prs_for_repo` 早已是逐条 `filter_map` 跳过坏数据，两处行为不一致。
抽出 `push_parsed_items` 统一为「跳过坏项」，两处调用点共用。

## 接口 / 行为变更

| 项 | 变更 | 影响面 |
|---|---|---|
| 1 | 重建变为原子；残留 `tasks_new` 自愈 | 仅老库首次升级路径 |
| 2 | 畸形 MCP 帧不再终止进程 | MCP stdio 行为；对标准客户端无差异 |
| 3 | `Content-Length > 8 MiB` / 头部 `> 8 KiB` 判 Fatal | 仅在畸形输入下生效 |
| 4 | **`sync::run` 在全败时返回 `Err`** | 前端同步失败横幅恢复显示（原本被清空） |
| 4 | 被跳过的账号 `sync_logs` 行收尾为 `failed` | 同步日志面板不再出现永久「进行中」 |
| 5 | `fetch_issue_links` 改走宽松模式 | 父子关系在限流 / 部分失败下更完整 |
| 5 | GraphQL 增加限流退避重试 | 同步耗时在限流时增加（有上限保护） |
| 6 | `update_task_status` / `record_session` 失败即报错 | 前端对不存在任务不再静默成功 |
| 7 | 写回查询错误文案变化 | 排障信息更准确 |
| 8 | 非限流 403 立即返回 + 权限指引 | 缺权限时不再白等 ~30s |
| 9 | `search()` 跳过坏 item 而非整体失败 | 单条坏数据不再造成整源缺失 |

- **无 Tauri command 签名变更**，无前端 API 变更。
- **无 MCP 工具增删**；`任务不存在: <key>` 文案保持原样（与 `server.py` 一致）。
- **无 i18n key 变更**。

## 数据 / Schema 变更

**无列 / 表结构变更。** 与 schema 相关的改动只有「迁移执行方式」：

- `migrate_tasks_v2_rebuild` 的 DDL 包进事务（表结构本身不变，仍是 29 列 + 复合唯一键）；
- `PRAGMA user_version` 的写入时机从事务外移到事务内。

因此 `scripts/check-mcp-columns.py` 的 28 列校验不受影响。

## 测试 / 验收

新增 12 个断言（全部 Rust），逐项通过**反向验证**（把修复改回缺陷写法，测试必然失败）：

| 反向操作 | 结果 |
|---|---|
| 去掉 `DROP TABLE IF EXISTS tasks_new` | ✅ `tasks_v2_rebuild_heals_leftover_tasks_new` 失败 |
| 去掉 `PRAGMA user_version = 2` | ✅ 同上（`user_version` 断言失败） |
| `require_affected` 恒 `Ok` | ✅ `require_affected_rejects_zero_rows` 失败 |
| 去掉 `if ok_accounts == 0` 早返回 | ✅ `run_reports_error_when_every_account_fails` 失败 |
| 去掉跳过分支的日志收尾 | ✅ 同上（`status='failed'` 断言失败） |
| 一处 `require_affected` 调用改回丢弃 | ✅ `write_commands_check_affected_rows` 失败 |
| 403 一律当限流 | ✅ `rate_limit_wait_discriminates_permission_from_throttle` 失败 |
| `push_parsed_items` 改回 `?` 语义 | ✅ `push_parsed_items_skips_bad_item_instead_of_failing_all` 失败 |
| `resolve_project_write_target` 改回 `.map(Some).unwrap_or(None)` | ✅ `resolve_write_target_surfaces_db_errors_instead_of_hiding_them` 失败 |
| NDJSON 解析失败改回 `Eof` | ✅ `read_message_skips_malformed_ndjson_and_continues` 失败 |
| 长度越界改回 `Malformed` | ✅ `read_message_rejects_out_of_range_content_length` 失败 |
| 去掉头部上限 | ✅ `read_message_caps_header_size` 失败 |

新增测试清单：

- `db::tests::tasks_v2_rebuild_heals_leftover_tasks_new`（含数据 / 本地态 / `updated_at`
  单位转换 / 无 `key` 列 / `user_version` 五组断言）
- `db::tests::resolve_write_target_surfaces_db_errors_instead_of_hiding_them`
- `db::tests::resolve_write_target_keeps_missing_row_semantics`（对照组，确认只改了错误路径）
- `common::tests::require_affected_rejects_zero_rows`
- `sync::tests::run_reports_error_when_every_account_fails`（**不触网**：PAT 为空即
  `continue`，端到端跑完整 `run()`）
- `commands::tests::write_commands_check_affected_rows`（源码静态断言，守卫三处调用点；
  这些命令带 Tauri `AppHandle`，单测无法直接调用）
- `github::tests::rate_limit_wait_discriminates_permission_from_throttle`
- `github::tests::permission_hint_only_for_403`
- `github::tests::push_parsed_items_skips_bad_item_instead_of_failing_all`
- `mcp::tests::read_message_skips_malformed_ndjson_and_continues`
- `mcp::tests::read_message_rejects_out_of_range_content_length`
- `mcp::tests::read_message_caps_header_size`
- `mcp::tests::read_message_parses_valid_content_length_frame`（兼容性对照组）

全量校验：

```
npx tsc --noEmit                                 0 error ✅
npm test                                         155 passed ✅
npm run i18n:check                               389 keys ✅
npm run lint                                     18 warnings（无新增）✅
npx prettier --check "src/**/*.{ts,tsx,css}"     ✅
cargo clippy --lib -p taskboard -- -D warnings   ✅
cargo test --lib -p taskboard                    129 passed（+12）✅
python3 scripts/check-doc-links.py               159 文件 ✅
python3 scripts/check-mcp-columns.py             28 列 ✅
python3 scripts/check-workflow-yaml.py           6 文件 ✅
python3 -m unittest discover -s scripts -p 'test_*.py'   OK ✅
```

> 注：仓库整体**尚未** `cargo fmt` 化（`cargo fmt --check` 在 `main` 上本就有大量差异），
> 故本批不做全量格式化——那是 P3 批次（#330）的独立事项，混入会淹没本次 diff。

## 相关链接

- 来源审计：[`CODE-REVIEW-2026-09-30.md`](../CODE-REVIEW-2026-09-30.md)
- 上游批次：[`docs/issue-327-p0-functional-defects.md`](./issue-327-p0-functional-defects.md)（#327 / PR #331）
- GitHub issue：[#328](https://github.com/ShawnLiuSZ/task-dashboard/issues/328)
- 关联历史教训：
  [#155 表重建](https://github.com/ShawnLiuSZ/task-dashboard/issues/155)、
  [#175 重建丢列](./issue-175-work-branch-migration-gap.md)、
  [#262 多账号同步](./issue-262-multi-account-sync.md)、
  [#278 父子关系同步](./issue-278-issue-links.md)、
  [#266 测试 flake](./issue-266-test-flake.md)
- CHANGELOG：[`docs/CHANGELOG.md`](./CHANGELOG.md) / [`docs/CHANGELOG.en.md`](./CHANGELOG.en.md)

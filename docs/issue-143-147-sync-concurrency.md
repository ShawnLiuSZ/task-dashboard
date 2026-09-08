# Issue #143 + #147：同步并发化 + user_version 迁移 + common.rs 抽取

## 背景 / 动机

- #143：同步链路全串行（5 Search 源、`fetch_prs` 逐仓、`fetch_project_*` 逐项目），且 Search 无跨线程节流，并发后必撞 429。
- #147：每次 `open_db` 跑全量 SCHEMA + 12 条 ALTER；状态校验/session/handoff SQL 在 `commands.rs` 与 `mcp.rs` 各写一遍已分叉；`import_notes` 逐条无事务；`delete_account` 手写 BEGIN/COMMIT。

## 设计 / 方案

### 并发（#143，零新依赖）

- 5 Search 源 `thread::scope` 并行；线程 panic 按该源失败处理（best-effort 不变）。
- `GitHubClient` 新增共享限流门 `search_gate`（`Mutex<Option<Instant>>`）：任意两次 search 调用间隔 ≥ 2s（30 req/min），替代原来 `get_with_timeout` 里 Search 每页固定 1s sleep（该 sleep 实际只走 `get()` 路径，`search()` 用 `http_get` 根本没节流，并发后必超限）。
- 各 project 的 `fetch_project_status_options` + `fetch_project_issues` 并行拉取，DB 写入（upsert/prune/clear）仍串行；`fetch_prs` 按仓库并行（抽 `fetch_prs_for_repo`）。
- 有意没做的：`reqwest` 切 async + `tokio`（issue 原文提议，但违反“不引入新依赖”，`thread::scope` + 复用 `blocking` 连接池已够）；多账号间仍串行 + 800ms 间隔；评论 80ms sleep 与启动 2s sleep 保留。

### user_version（#147）

- `open_db` 读 `PRAGMA user_version`：0 = 未版本化老库，跑 `migrate_legacy_alters`（12 条列补齐）后记为 1；≥ 1 跳过。SCHEMA（全 `IF NOT EXISTS`）与默认设置、各表级小迁移仍每次跑（幂等、便宜）。
- 后续 schema 变更：版本号 +1 并在此分步迁移。

### common.rs（#147）

- 新建 `app/src-tauri/src/common.rs`：`normalize_status`、`validate_task_status`（自 commands 迁移）、`set_task_status` / `touch_session` / `clear_task_session` / `record_task_handoff`（返回更新行数，调用方自定“任务不存在”策略）、`NOTE_LABELS` + `normalize_note_label`（自 mcp 迁移）。
- `commands.rs` / `mcp.rs` 改薄包装，各自原有行为保留（commands 写 miss 静默 Ok、mcp 报“任务不存在”；`parse_issue_ref` 留 mcp 独有）。
- 行为收敛一处：`add_note` / `update_note_label` 此前任意字符串可入库，现走统一校验（非法 label 报错，与 MCP 约束对齐）。

### 事务（#147）

- `delete_account`：手写 BEGIN/COMMIT 改 `unchecked_transaction` RAII（panic 自动回滚）。
- `import_notes`：整个导入包一事务，失败整体回滚（此前逐条提交可部分成功）。

## 接口 / 行为变更

- 对外零变更（命令签名、MCP 工具、前端均不动）。
- 可感知变化：同步耗时下降（project/PR 并行）；非法记事标签现在报错（此前静默入库）。

## 数据 / Schema 变更

- 无表结构变更；仅 `PRAGMA user_version` 0→1（老库首次打开时一次）。

## 测试 / 验收

- `cargo check` 通过（仅 2 个改前已存在 warning）。
- `cargo test --lib`：31 passed / 0 failed（含 `common` 新增 2 例）；测试 target 内改前已坏的引用已随 PR-1 修好。
- e2e（快照库真实同步）：total=487 added=8 updated=88 candidate_done=33 pruned=5，PR 关联 266/487，与 PR-1 基线一致，16.6s，老库迁移路径同步验证通过。

## 相关链接

- Issue: #143（并发）、#147（迁移 + 公共模块 + 事务）
- 分支：`feature/issue-143-147-sync-concurrency` → PR 到 `develop`
- 前置 KB：[docs/perf-audit-optimization.md](./perf-audit-optimization.md) P0-1 / P1-2 章节；[docs/issue-144-146-sync-db.md](./issue-144-146-sync-db.md)（PR-1）
- 改动文件：`app/src-tauri/src/github.rs`、`sync.rs`、`db.rs`、`commands.rs`、`mcp.rs`、新建 `common.rs`（`lib.rs` 注册）

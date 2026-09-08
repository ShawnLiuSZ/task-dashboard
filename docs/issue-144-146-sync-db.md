# Issue #144 + #146：同步 N+1 消除 + 单事务写入 + DB 索引补齐

## 背景 / 动机

- #144：`sync_account` 任务循环内每任务 2 次 SELECT + 逐 label 点查 `label_mappings` + 每任务全表读 `account_columns` 并重复解析 JSON，且每任务 1 次 autocommit 写。百级任务即数百次查询 + 数百次 WAL fsync。
- #146：热查询无复合索引（`org+repo+label` 点查、`ORDER BY candidate_done,status,updated_at` 看板排序、`status+done_at` 清理、`notes.content` 去重）全部走全表扫描/排序。

## 设计 / 方案

### 预加载（db.rs 新增，sync.rs 消费）

- `load_label_rules`：`label_mappings` 全量一次加载；`resolve_status_from_rules` 纯内存解析，优先级与旧语义一致（repo 级按 labels 顺序 → org 级按 labels 顺序 → state 兜底）。
- `load_column_rules`：`account_columns` 一次加载 + `match_rules` JSON 只解析一次（非法 JSON 跳过并在 `TASKBOARD_LOG` 下输出）；`resolve_column_from_rules` 首个命中胜出。
- `load_existing_tasks`：`tasks WHERE account_id=?` 一次加载为 `HashMap<repo#number, ExistingTask>`，替代循环内 2 次 SELECT。
- 旧 `resolve_status_from_labels` / `resolve_column_from_gh_status` 改为薄包装委托，逻辑单点（仅 `sync.rs` 在用，无他处依赖）。

### 计算与写入分离（sync.rs）

- 循环只做计算（含评论回源网络 I/O）产出 `PendingUpsert` 行，不写库。
- 写阶段：`stale=1` 标记 + 全部 upsert 包在单个 `unchecked_transaction` 里一次提交。SQL 与参数顺序与原来逐条版完全一致（含 `done_at` CASE 用 `?20` 的原有语义）。
- 预加载失败则整账号同步直接失败，绝不用空快照继续（否则既有 status 会被默认 `todo` 覆盖，丢本地手动态）。
- 与原版有意不同的一点：写事务不横跨网络 I/O，避免长持写锁阻塞 UI 独立连接。

### 索引（#146，SCHEMA 内 `IF NOT EXISTS`，新老库同路径生效）

- `idx_label_mappings_org_repo_label (org, repo, label)`
- `idx_tasks_board (account_id, candidate_done, status, updated_at DESC)`
- `idx_tasks_status_done_at (status, done_at)`
- `idx_notes_content UNIQUE (content)`
- `open_db` 跑 SCHEMA 前先 best-effort 去重 notes（保留最早 id），否则老库脏数据会让唯一索引创建失败、整个库打不开。

## 接口 / 行为变更

- 对外零变更：Tauri 命令、MCP 工具、前端、看板排序语义均不变。
- 内部：`sync_account` 的 DB 读从 O(N) 查询降为 3 次预加载 + O(1) 内存查；写从 N 次 autocommit 降为 1 次 commit。
- 顺带修：`test_headless_sync_pr_linkage`（ignored）调用 `run(&conn)` 缺 `trigger_type` 参数导致整个 lib 测试 target 编译失败，补为 `run(&conn, "manual")`（改前已坏，非本次引入）。

## 数据 / Schema 变更

- 新增上述 4 个索引，全部 `IF NOT EXISTS`，`open_db` 每次建连幂等执行，无单独迁移脚本。
- notes 去重：`DELETE FROM notes WHERE id NOT IN (SELECT MIN(id) ... GROUP BY content)`，best-effort（首建库表不存在时忽略）。

## 测试 / 验收

- `cargo check` 通过（2 个 warning 均为改前已存在：`removed` 的 mut、保留的 `fetch_state`）。
- `cargo test --lib`：29 passed、0 failed、2 ignored（含新增 4 例：索引存在性、去重、label 解析优先级、列首命中）。
- 未跑真实同步（需网络 + 改生产库）；建议 PR 前手动跑一次 `npm run tauri dev` 触发同步，核对 added/updated/candidate_done 计数正常。

## 相关链接

- Issue: #144（N+1 + 事务）、#146（索引）
- 分支：`feature/issue-144-146-sync-db-batch` → PR 到 `develop`
- 前置 KB：[docs/perf-audit-optimization.md](./perf-audit-optimization.md) P0-2 / P1-1 章节
- 改动文件：`app/src-tauri/src/db.rs`、`app/src-tauri/src/sync.rs`

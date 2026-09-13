# Issue #235：应用内 API 调用明细（同步 / 认领 / 状态写回的请求与返回参数）

## 背景 / 动机

用户在排查同步异常时发现：**应用内看不到任何请求参数与返回参数**。

### 现状缺口（实测确认）

| 通道 | 落库 | 应用内可见 | 内容 |
|---|---|---|---|
| `sync_logs` 表 | ✅ | ✅（同步日志面板） | 只有聚合计数：新增/更新/移除、耗时、错误摘要。**没有 request / response 列** |
| `tlog!` / `eprintln!`（#228 埋点） | ❌ | ❌ | 方法 + URL + 状态码 + 耗时。默认静默（需 `TASKBOARD_LOG=1`），只在 stderr |
| 同步 GET 成功路径 | ❌ | ❌ | **只记了状态码**，note 为空 |

结论：#228 把「发了什么、回了什么」写进了 stderr，但**没有落盘、也没有在 UI 暴露**；而 `sync_logs` 受限于表结构（无参数列），扩充它会污染「一次同步一行」的聚合语义。用户在 UI 上因此表现为「日志里没有请求参数和返回参数」。

### 目标

1. 同步期间的每次 GitHub API 调用，落盘并展示**请求参数**与**返回参数**。
2. 用户显式写操作（**领取任务** `claim_issue`、**更新状态** `set_project_status`）同样记录请求与返回。
3. 全部可在**应用内日志面板**查看，不需要开终端、不需要环境变量。

对应 issue：[#235](https://github.com/ShawnLiuSZ/task-dashboard/issues/235)
前置：[#228](https://github.com/ShawnLiuSZ/task-dashboard/issues/228)（stderr 埋点，本 issue 是其「落盘 + 应用内查询」的后续，见 [docs/issue-228-api-logging.md](./issue-228-api-logging.md)）

## 设计 / 方案

### 决策 1：新建 `api_logs` 表，不扩 `sync_logs`

`sync_logs` 的语义是「一次同步 = 一行聚合结果」，把几十条 API 调用塞进去会破坏该语义。更关键的是**认领 / 状态写回不是同步事件**——它们没有 `sync_log_id`、没有 added/updated/removed 计数，强行复用 `sync_logs` 需要把一半列置空。因此独立建表，用 `kind` 区分来源，`sync_log_id` 允许为 0（非同步来源）。

### 决策 2：可选依赖注入的收集器（collector sink），不改既有调用方

`GitHubClient` 是纯函数式客户端，直接持有 `conn` 会在多处产生借用冲突（`sync_account` 里 `conn` 已被占用，`claim_issue` 里 client 被 move 进 `spawn_blocking`）。因此采用**可选 sink**：

```rust
pub type ApiLogSink = Arc<Mutex<Vec<db::ApiLogEntry>>>;

GitHubClient::new(...)            // 既有签名不变 → 内部 Self::build(..., None)
GitHubClient::new_with_sink(...)  // 新增 → 返回 (Client, ApiLogSink)
```

- 内部每个调用点先构造 `ApiLogEntry`，再 `emit_api(entry)`：**无 sink 时静默返回**，有 sink 时推入 `Vec`。
- 所有既有 `GitHubClient::new` 调用点**零改动**，行为完全不变（不开 sink 就只是多一次 `Option` 判空）。
- `Arc<Mutex<..>>` 而非 `RefCell`：因为 `claim_issue` / `set_project_status` 把 client move 进 `spawn_blocking`，需要 `Send`。

### 决策 3：在包装层 drain，不在业务体 drain

`sync_account` 被拆成两层：

```rust
fn sync_account(conn, account, pat, now, board_mode, sync_log_id) -> Result<..> {
    let (client, sink) = GitHubClient::new_with_sink(..)?;
    let result = sync_account_inner(conn, account, &client, now, board_mode); // 原函数体
    let calls = drain_api_log(&sink);          // ← 无论成功失败都执行
    if !calls.is_empty() { db::insert_api_logs(conn, "sync", .., &calls); }
    result
}
```

原因：`sync_account_inner` 内有多个 `?` 提前返回。若 drain 写在函数体末尾，**失败路径（最需要看日志的路径）反而不会落盘**。包装层保证 drain 一定执行。

### 决策 4：存「摘要 + 计数」，不存原始响应

一次同步数十次调用、每次响应可达数十 KB。若逐条存原始 JSON，单次同步就能写入数 MB。因此：

- 单条明细：`request` 截断至 400 字符、`response` 截断至 600 字符、`target` 160 字符（均复用 #228 的多字节安全 `summarize_text`）。
- 聚合：同步批量写入时，同 `kind` 的调用汇总为计数行而非全量转储。

### 决策 5：`ok` 是独立布尔，不靠状态码推断

GraphQL 常返回 **HTTP 200 但 body 内含 `errors`**。只看 `status` 会把业务失败记成成功。因此 `ApiLogEntry` 显式带 `ok: bool`，由调用点按「HTTP 成功 **且** 无业务错误」判定。

### 决策 6：绝不写入 PAT

`target` 只存 REST 路径（`url_display_path` 剥掉 host 与 query）或 GraphQL 操作名（`graphql_op_label` 剥掉 `query`/`mutation` 关键字与变量声明块）。请求体只含业务字段。Authorization 头从不进入日志。

### 决策 7：保留策略与新表零迁移

- 时间保留 7 天（`API_LOG_RETENTION_SECS`），行数上限 2000（`API_LOG_MAX_ROWS`），在每次同步后随 `prune_sync_logs` 一并 `prune_api_logs`。
- 新表通过 `SCHEMA` 里的 `CREATE TABLE IF NOT EXISTS` 建立。因 `execute_batch(SCHEMA)` 在每次 `open_db()` 都执行，**老库首次启动即自动建表，无需 `ALTER TABLE` 迁移**（见 `AGENTS.md §4.2` 对「新表 vs 新列」的区分）。

## 接口 / 行为变更

### 数据库

新表 `api_logs`（见下节）+ 两个索引。

### Tauri command（新增 3 个）

| 命令 | 参数 | 返回 | 说明 |
|---|---|---|---|
| `list_api_logs` | `limit`（默认 300，钳制 1..=1000） | `ApiLog[]` | 按 `created_at DESC, id DESC` |
| `prune_api_logs` | — | 删除行数 | 手动触发保留策略 |
| `clear_api_logs` | — | 删除行数 | 全清 |

### 前端

- `SyncLogsPanel` 改为**双页签**：「同步记录」（原聚合表）/「API 明细」（新表）。
  - API 明细页签含**类型筛选 chip**（全部 / 同步 / 认领 / 状态写回）+ 计数。
  - 每行「查看」按钮可展开，下方并列展示**请求参数**与**返回参数**两个 `<pre>` 块（等宽字体、保留换行、超长可滚动）。
  - 「清理过期日志」「清理全部日志」同时作用于两张表（`Promise.all`），避免只清一半。
- `types.ts` 新增 `ApiLog`；`api.ts` 新增 `listApiLogs` / `pruneApiLogs` / `clearApiLogs`。
- 复用既有 `.chip` + `.on` 的页签/筛选样式约定（与 SettingsPanel 一致），未引入新的交互范式。

### 行为变化

- 每次同步（含失败）现在都会写 `api_logs`；此前完全无落盘。
- `claim_issue` / `set_project_status` 在**成功与失败两条路径**都落盘明细（失败路径通过把 API 调用区包进闭包、在闭包外 drain 实现）。

### 明确不做（非目标）

- **不新增 MCP 工具**。用户选择的目标是「App 内日志面板」。若后续需要让 agent 自诊断，再按 `AGENTS.md §8.6` 同步改 `mcp.rs` 与 `server.py` 两侧。
- 不改变任何既有同步决策逻辑；埋点是纯旁路。

## 数据 / Schema 变更

### 新表

```sql
CREATE TABLE IF NOT EXISTS api_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL DEFAULT 'sync',   -- sync | claim | status
  account_id  INTEGER NOT NULL DEFAULT 0,
  sync_log_id INTEGER NOT NULL DEFAULT 0,     -- 非同步来源为 0
  method      TEXT NOT NULL DEFAULT '',       -- GET / POST / GraphQL
  target      TEXT NOT NULL DEFAULT '',       -- REST 路径 或 GraphQL 操作名
  status      INTEGER NOT NULL DEFAULT 0,     -- HTTP 状态码；GraphQL 业务错误沿用 200
  ok          INTEGER NOT NULL DEFAULT 1,     -- 1 成功 / 0 失败（含 200 带 errors）
  elapsed_ms  INTEGER NOT NULL DEFAULT 0,
  request     TEXT NOT NULL DEFAULT '',       -- 摘要，≤400 字符
  response    TEXT NOT NULL DEFAULT '',       -- 摘要，≤600 字符
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_api_logs_created ON api_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_api_logs_kind    ON api_logs(kind);
```

### 迁移方式

无（新表，`CREATE TABLE IF NOT EXISTS` 幂等）。老库首次 `open_db()` 自动建表。

## 测试 / 验收

### 验收标准

- [x] 同步日志面板可查看每次 API 调用的请求参数与返回参数（可展开）
- [x] 领取任务、更新状态写回的请求与返回同样可查
- [x] 失败路径（HTTP 失败 / GraphQL business error）也被记录，且 `ok=0`
- [x] 不写入 PAT
- [x] i18n 中英双语必须一致（`npm run i18n:check`）
- [x] 保留策略生效：超期或超行数被裁剪

### 已跑验证

| 检查 | 结果 |
|---|---|
| `cargo check --lib` | ✅ 零 warning |
| `cargo test --lib` | ✅ **80 passed** / 0 failed / 2 ignored（新增 3 例：`api_logs_insert_and_list_roundtrip`、`api_logs_empty_on_fresh_db`、`api_logs_prune_trims_to_max_rows`） |
| `cargo test --lib`（github 侧） | ✅ 新增 `url_display_path_strips_host_and_query`、`graphql_op_label_skips_variable_block` |
| `npx tsc --noEmit` | ✅ 0 error |
| `npm run build` | ✅ 49 modules，258.15 kB JS / 28.03 kB CSS |
| `npm test` | ✅ **10 files / 79 tests**（`sync-logs.test.ts` 7 → 32 例） |
| `npm run i18n:check` | ✅ 中英各 **302** key（+18） |
| `python3 scripts/check-mcp-columns.py` | ✅ 24 列一致（未动 `tasks` 表） |

### 边界场景

- **空 sink**：`GitHubClient::new` 路径不产生任何日志开销（`Option` 判空即返回）。
- **空明细数组**：`insert_api_logs` 见空切片直接 `Ok(0)`，不开事务。
- **锁中毒**：`emit_api` 遇 `Mutex` 中毒静默丢弃，不 panic、不影响主流程。
- **GraphQL 200 + errors**：`ok=false`，避免「状态码 200 就绿」的误判。
- **GraphQL 操作名提取**：`graphql_op_label` 会跳过 `query search($q: String!) {` 的变量声明块，取到 `search` 而非变量名 `searchQuery`（有单测锁定）。
- **前端 i18n 漏翻**：已知 `check-i18n` 只比 key 数量、拦不住漏翻，故新增单测 `syncLogs API 明细 i18n key 齐备` 逐一断言 18 个 key 在中英两份 locale 中都存在。

## 相关链接

- Issue：[#235](https://github.com/ShawnLiuSZ/task-dashboard/issues/235)
- 前置 issue：[#228](https://github.com/ShawnLiuSZ/task-dashboard/issues/228)（stderr 埋点）
- 分支：`feature/issue-235-in-app-api-log`
- 相关文档：[docs/issue-228-api-logging.md](./issue-228-api-logging.md)
- CHANGELOG：[docs/CHANGELOG.md](./CHANGELOG.md)

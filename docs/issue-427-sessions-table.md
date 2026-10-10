# 会话数据从 tasks 拆出到独立 sessions 表（#427）

> 关联 issue：<https://github.com/ShawnLiuSZ/task-dashboard/issues/427>
> 分支：`feature/issue-427-sessions-table`
> 影响面：新增 `sessions` 表 + 索引；`SCHEMA_VERSION` 4→5；**无破坏性变更**（tasks 三列保留）

---

## 背景 / 动机

会话（Session）数据此前直接挤在 `tasks` 表的三个列里（`session_id` / `session_agent` / `session_at`），
由 agent 通过 MCP 工具写入，以 `session_id IS NOT NULL` 判定「是会话」。四个问题：

| # | 问题 | 实测证据 |
|---|---|---|
| 1 | **历史被覆盖式写入丢弃** | 生产库「同 `issue_key` 多个不同 `session_id`」= **0 条** —— 多次开工的历史在设计层面就不存在 |
| 2 | `session_id` 无索引 | 会话面板主查询走全表扫描 |
| 3 | 两个写入方混同一张表 | `touch_session`（agent 写会话）与 `sync.rs`（GitHub 同步）都 UPDATE `tasks` 行 |
| 4 | 语义层次不同 | `tasks` 是「GitHub 任务的当前快照」，会话是「一次执行的过程记录」，生命周期不同 |

## 设计 / 方案

### 决策 A：唯一键用 `(account_id, issue_key, session_id)` + 自增 id

**依据生产库两条实测约束**（不是推测，是查出来的）：

- **一个 `session_id` 会同时挂在多个 issue 上**：
  ```
  ea1a0b6a-2b53-40ce-8e26-4b587b79f738 → fad-backend#1447 | fad-backend#1454
  ```
  ⇒ 不能对 `session_id` 单独建 UNIQUE。模型是**会话与 issue 多对多**，不是「一行一会话」。
- **`issue_key` 在 tasks 里不唯一**：733 行 / 729 distinct（4 组跨账号重复）⇒ 唯一键必须带 `account_id`。

按 `(issue_key)` 或 `(session_id)` 单列唯一，迁移即丢数据或建表失败。

### 决策 B：`work_branch` / `work_dir` 留在 `tasks`

两者本质是**任务属性**（agent 在哪个分支干活）而非会话属性。且它们原本与 session 三列
**混在同一条 UPDATE 的 4 个分支**里（`common.rs:272/280/286/292`，Python 侧 `server.py` 同样 4 分支）：

- 一并搬走 ⇒ SessionsPanel 4 处 UI（`SessionsPanel.tsx:308-349`）都要改数据源；
- **丢失是静默的** —— 生产库 16 条会话的 branch/dir 全部非空，丢了用户立刻发现。

留在 tasks ⇒ 前端**零改动**。

### 决策 C：`tasks` 的 session 三列保留，双写

`mcp_server/server.py` 是**独立进程**（`opencode.json` 注册 `python3 mcp_server/server.py`），
其 `ensure_schema` **只有 `ALTER TABLE ADD COLUMN`，没有 DROP 能力**。删列会让未升级的插件环境直接崩。

且 MCP 契约依赖这三列：`get_task_status` 的工具描述明确返回 `session_id`，
`.opencode/plugins/taskboard.js:254` 有 `if (got.data.status === "doing" && got.data.session_id)` 消费点。

⇒ 保留作「当前活跃会话」缓存（`WHERE session_id IS NOT NULL` 语义与 MCP 契约不变），sessions 表存全部历史。

### 决策 D：删除会话 = 结束活跃会话，保留历史

`clear_task_session` 改为 `is_active=0` + `ended_at`，**不删 sessions 行**。

### 决策 E：`SCHEMA_VERSION` 4 → 5

新增表 + 索引属结构性变更（`db.rs` 硬约束：+1）。

**放置位置**（遵循 `db.rs` 三条规则 + #329 回归教训）：

| 内容 | 位置 | 理由 |
|---|---|---|
| `CREATE TABLE/INDEX IF NOT EXISTS` | `SCHEMA` | 稳态零写入，不回归 #329「每次 `open_db` 写库」 |
| 一次性搬迁 | `MIGRATE_DATA_FIXES` | best-effort、幂等、失败不阻塞版本号推进 |
| **不**纳入 `REQUIRED_COLUMNS` / `REQUIRED_INDEXES` | — | 否则 `schema_is_current` 因缺 sessions 表恒为假，同样回归 #329 |

### 写入端：顺序不可颠倒

```rust
let n = /* UPDATE tasks ...（原有 4 分支 SQL 逐字未变） */;
if n == 0 { return Ok(0); }   // ← 任务不存在，**直接返回，不写 sessions**
/* INSERT INTO sessions ... ON CONFLICT DO UPDATE */
```

⚠️ **反序会产生孤儿会话**：任务不存在时仍写 sessions ⇒ 插入指向不存在 issue 的行，
破坏 `require_affected` 契约（`common.rs` / `mcp.rs` / `server.py` 三处都依赖
「`affected==0` ⇒ 任务不存在」判定任务存在性）。

用 `ON CONFLICT ... DO UPDATE` 而非纯 `INSERT`：一个会话内 agent 多次上报（改分支/换目录）
是常态，须**复用行只刷新 `session_at`**，否则历史被噪音淹没。

## 接口 / 行为变更

| 项 | 变化 |
|---|---|
| `SCHEMA_VERSION` | 4 → 5 |
| 新表 | `sessions`（8 列 + 2 索引） |
| `clear_task_session` 语义 | 「清空字段」→「结束会话（保留历史行）」；**返回值语义不变**（affected tasks 行数） |
| `list_active_sessions` 数据源 | `tasks.session_id IS NOT NULL` → `sessions.is_active=1 JOIN tasks` |
| Tauri command / MCP 工具签名 | **无变化** |
| 前端 `types.ts` / 组件 | **无变化**（保持 `Vec<Task>` 返回形状 ⇒ SessionsPanel / TaskCard / DetailPanel 零改动） |
| MCP 工具集 | 无变化（12 个不变） |

## 数据 / Schema 变更

### `sessions` 表

```sql
CREATE TABLE IF NOT EXISTS sessions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id    INTEGER NOT NULL,
  issue_key     TEXT NOT NULL,
  session_id    TEXT NOT NULL,
  session_agent TEXT NOT NULL DEFAULT '',
  session_at    INTEGER NOT NULL,   -- 会话开始时间（沿用原语义）
  is_active     INTEGER NOT NULL DEFAULT 1,
  ended_at      INTEGER,
  UNIQUE(account_id, issue_key, session_id)
);
CREATE INDEX idx_sessions_active ON sessions(is_active, session_at DESC);
CREATE INDEX idx_sessions_issue ON sessions(account_id, issue_key);
```

### 一次性搬迁（`MIGRATE_DATA_FIXES` 第 3 条）

```sql
INSERT OR IGNORE INTO sessions (account_id, issue_key, session_id, session_agent, session_at, is_active)
SELECT account_id, issue_key, session_id,
       COALESCE(NULLIF(trim(session_agent), ''), 'unknown'),
       CASE WHEN COALESCE(session_at, 0) > 0 THEN session_at ELSE 0 END, 1
FROM tasks WHERE session_id IS NOT NULL AND trim(session_id) <> ''
```

`INSERT OR IGNORE` 保证**幂等**。脏值兜底（`COALESCE`/`NULLIF`）很关键：
`session_agent` 是 `NOT NULL`，若不兜底空串，整条迁移会失败并被 best-effort
语义**静默吞掉** ⇒ 数据悄悄丢失。

### `SCHEMA` 内联副本与 `SESSIONS_DDL` 常量的漂移风险

Rust 的 `concat!` **只接受字面量、不接受 `const` 标识符**，故 `SCHEMA` 字面量内
只能放**内联副本**。两份若漂移，后果是「新库建不出 sessions 表」而测试 fixture 仍通过
—— 最隐蔽的失败模式。

**这个坑真的踩了一次**：合并常量时 sessions 表从 `SCHEMA` 里丢失过，靠断言及时发现。

因此加了两个断言：
- `sessions_ddl_inline_matches_constant` —— 逐字比对两份定义；
- `fresh_db_has_sessions_table_and_indexes` —— 断言 `open_db` 在新库真能建出表与两个索引。

测试 fixture 一律用 `db::sessions_ddl()`（薄包装 `SESSIONS_DDL`）而非手写副本。

## 测试 / 验收

### 新增测试（lib 178 → 187，共 9 例）

`common.rs` 6 例（写入端行为）：

| 测试 | 守什么 |
|---|---|
| `touch_session_writes_both_tasks_and_sessions` | 双写：tasks 三列 + branch/dir 与 sessions 行都写 |
| `touch_session_reuses_row_for_same_session` | 同会话重复上报**复用行**、只刷新 `session_at` |
| `one_session_can_span_multiple_issues` | **多对多**：一 session 跨两 issue 存 2 行，不被唯一键丢弃 |
| `clear_task_session_ends_but_keeps_history` | 删除后**历史行仍在**（`is_active=0` + `ended_at` 非空）+ tasks 三列置 NULL |
| `touch_session_does_not_write_sessions_for_missing_key` | 任务不存在时**不写** sessions（无孤儿） |
| `clear_task_session_ignores_sessions_for_missing_key` | 不误结束他人活跃会话 |

`db.rs` 3 例：迁移端到端（版本号 / 搬迁 3 行 / 多对多 2 行 / 二次打开幂等 / 脏值兜底）+ 两个防漂移断言。

### 反向验证

注入 2 处变异：

| 变异 | 期望 | 实测 |
|---|---|---|
| `clear_task_session` 改成真 `DELETE FROM sessions`（丢历史） | 捕获 | ✅ `clear_task_session_ends_but_keeps_history` FAILED |
| `touch_session` 跳过 `if n == 0` 检查（产生孤儿） | 捕获 | ✅ `touch_session_does_not_write_sessions_for_missing_key` FAILED |

`MUTATION_EXIT=101`（2 failed | 8 passed），恢复后 10 passed。

### 全量验证

| 项 | 结果 |
|---|---|
| `cargo test --lib` | **187 passed**（原 178） |
| `cargo test --test db_test` | 27 passed |
| `cargo fmt --check` | 干净 |
| `cargo clippy --all-targets -p taskboard -- -D warnings` | **0 警告** |
| `python3 scripts/check-mcp-columns.py` | 28 列通过（决策 C 生效：tasks 三列保留） |
| `npm test -- --run` | 276 passed（前端零改动） |
| `npx tsc --noEmit` / `npm run lint` | 通过 / 0 警告 |

### 生产库副本迁移演练

用 `shutil.copy2` 复制生产库（非真库），跑真实 `open_db`：

```
迁移前：user_version = 4，16 条会话
迁移后：user_version = 5，sessions 16 行 = 原 16 条（零丢失）
        跨多 issue 的 session_id = 1 个（未被唯一约束丢弃）
二次开库：仍 16 行（幂等）
```

## 附带修复：#424 的同类缺口

#424 只给 `tests/db_test.rs::tempdir()` 加了 RAII 清理，**`db.rs` 单元测试的 `tmp_db()`**
同样在临时目录建库却从不删除 ⇒ 实测单次 lib 测试留下 ~190 个。

新增 `tmp_db_guarded()` 返回 `TempDbPath` guard（需同时实现 `Deref` 与 `AsRef` ——
`rusqlite::Connection::open` 收 `impl AsRef<Path>`），15 处调用点切换；
`steady_db` 因需「路径活过函数后继续复用同一库」保留裸 `tmp_db`。

**实测残留 1881 → 9**（剩余 9 个是 `commands.rs` / `sync.rs` 的 `mem_conn()` **独立文件**，
属既有已知 flake，非本次范围）。

## 遗留 / 后续

1. **历史查询 UI 未做**：`sessions` 表已存全部历史，但当前 UI 仍只显示活跃会话
   （`list_active_sessions` 只取 `is_active=1`）。详情页「历次会话」需另做（`idx_sessions_issue` 已就位）。
2. **`tasks` 三列何时可删**：等Python MCP 双实现 + 插件环境都不再依赖后再评估下一个大版本。
3. **`taskSig` 指纹**：`utils/taskSig.ts` 把 session 三件套纳入列表指纹。因 tasks 三列仍双写、
   值仍在变，指纹机制暂不受影响；但若将来删列，需重新验证「record_session 后看板仍刷新」
   （`docs/issue-376` 已记录该测试对此不敏感）。
4. **`commands.rs` / `sync.rs` 的 `mem_conn()`** 临时库仍不清理（独立文件形态），
   且 `mem_conn()` 并行互删是已知 flake（偶发 `disk I/O error`）。

## 相关链接

- Issue：<https://github.com/ShawnLiuSZ/task-dashboard/issues/427>
- 前置：#422（账号视图筛选，同期修复）、#424（测试目录清理，本次补其同类缺口）
- 方法论：[`methodology-assertion-strength-audit.md`](./methodology-assertion-strength-audit.md)
- CHANGELOG：[`CHANGELOG.md`](./CHANGELOG.md) / [`CHANGELOG.en.md`](./CHANGELOG.en.md)
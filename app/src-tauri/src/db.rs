use rusqlite::{Connection, Result};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

/// 应用标识符，与 tauri.conf.json 的 `identifier` 一致。
/// 同时用于推导无 GUI 运行时的本地数据目录（MCP 子命令等）。
pub const APP_IDENTIFIER: &str = "com.shawnliu.taskboard";

// v0.3.49 (#149)：详细日志门控已迁移至 `crate::common::verbose_enabled`，
// 诊断输出一律走 `crate::tlog!`；此处不再保留私有版本。

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS accounts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  label       TEXT NOT NULL,
  login       TEXT NOT NULL,
  org         TEXT NOT NULL,
  pat_token   TEXT NOT NULL,
  is_default  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

-- v0.3.50 (#155)：tasks 表物理重建。
-- - 自增 id 主键 + 复合唯一键 UNIQUE(repo, number, account_id)：多账号不再互相覆盖。
-- - issue_key 为稳定业务引用（值 = repo#number），供 MCP / 前端 React key 使用。
-- - gh_state → issue_state、gh_status → project_status：三态语义分清（status 为本地看板四态）。
-- - updated_at 统一为 INTEGER 秒（与 synced_at / done_at / session_at 一致）。
CREATE TABLE IF NOT EXISTS tasks (
  id             INTEGER PRIMARY KEY,
  issue_key      TEXT NOT NULL,
  owner          TEXT NOT NULL,
  repo           TEXT NOT NULL,
  number         INTEGER NOT NULL,
  title          TEXT NOT NULL,
  url            TEXT NOT NULL,
  issue_state    TEXT NOT NULL,
  ownership      TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'todo',
  session_id     TEXT,
  session_agent  TEXT,
  session_at     INTEGER,
  candidate_done INTEGER NOT NULL DEFAULT 0,
  stale          INTEGER NOT NULL DEFAULT 0,
  project_status TEXT NOT NULL DEFAULT '',
  assignees      TEXT NOT NULL DEFAULT '',
  -- #237：issue 创建人（GitHub author login，不含 @）。卡片「创建人」行用。
  author         TEXT NOT NULL DEFAULT '',
  -- #278：关联 issue 的父子关系（GraphQL `parent` / `subIssues`，只读同步）。
  -- 两列都是 JSON 串：`parent_issue` 为对象或空串，`sub_issues` 为数组或空串。
  parent_issue   TEXT NOT NULL DEFAULT '',
  sub_issues     TEXT NOT NULL DEFAULT '',
  labels         TEXT NOT NULL DEFAULT '',
  done_at        INTEGER NOT NULL DEFAULT 0,
  mentioned      INTEGER NOT NULL DEFAULT 0,
  comments_count INTEGER NOT NULL DEFAULT 0,
  latest_comment_url TEXT NOT NULL DEFAULT '',
  pr_number      INTEGER NOT NULL DEFAULT 0,
  pr_url         TEXT NOT NULL DEFAULT '',
  -- 关联 PR 的分支（head.ref），由同步自动拉取；无关联 PR 时会被清空（PR 专用）。
  branch         TEXT NOT NULL DEFAULT '',
  -- agent 通过 record_session 写入的工作分支；同步不碰（#171）。
  work_branch    TEXT NOT NULL DEFAULT '',
  -- #287：agent 通过 record_session 写入的工作目录（项目路径）。
  work_dir       TEXT NOT NULL DEFAULT '',
  -- agent 写入的交接任务详情。
  handoff        TEXT NOT NULL DEFAULT '',
  updated_at     INTEGER,
  synced_at      INTEGER NOT NULL,
  -- #280：issue 创建时间（GitHub `created_at` 秒级时间戳）。
  created_at     INTEGER NOT NULL DEFAULT 0,
  -- 任务归属账号（来自 accounts.id）。
  account_id     INTEGER NOT NULL DEFAULT 1,
  UNIQUE(repo, number, account_id)
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_ownership ON tasks(ownership);
CREATE INDEX IF NOT EXISTS idx_tasks_account ON tasks(account_id);

-- v0.3.50 (#155)：idx_tasks_issue_key 不在 SCHEMA 顶层定义——老库（含 key 列旧布局）
-- 执行本 SCHEMA 时 issue_key 列尚不存在，顶层 CREATE INDEX 会导致 batch 失败。
-- 该索引由 open_db 末尾的幂等创建 + v2 重建函数负责（见下）。

CREATE TABLE IF NOT EXISTS label_mappings (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  org         TEXT NOT NULL,
  repo        TEXT NOT NULL DEFAULT '',
  label       TEXT NOT NULL,
  status      TEXT NOT NULL,
  order_index INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  UNIQUE(org, repo, label)
);
CREATE INDEX IF NOT EXISTS idx_label_mappings_org ON label_mappings(org);
CREATE INDEX IF NOT EXISTS idx_label_mappings_repo ON label_mappings(repo);

CREATE TABLE IF NOT EXISTS projects (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id   INTEGER NOT NULL,
  github_id    TEXT NOT NULL,
  name         TEXT NOT NULL,
  number_of_items INTEGER NOT NULL DEFAULT 0,
  owner_type   TEXT NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL,
  -- #215：Status 字段 id（写回 mutation 用；老库由迁移补）。
  status_field_id TEXT NOT NULL DEFAULT '',
  UNIQUE(account_id, github_id)
);
CREATE INDEX IF NOT EXISTS idx_projects_account ON projects(account_id);

CREATE TABLE IF NOT EXISTS project_statuses (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id   INTEGER NOT NULL,
  project_github_id TEXT NOT NULL,
  name         TEXT NOT NULL,
  order_index  INTEGER NOT NULL DEFAULT 0,
  -- #215：选项 id（写回 mutation 用；老库由迁移补）。
  option_id    TEXT NOT NULL DEFAULT '',
  UNIQUE(account_id, project_github_id, name)
);
CREATE INDEX IF NOT EXISTS idx_project_statuses_project ON project_statuses(account_id, project_github_id);

-- #215：issue 在各 project 中的条目 id（写回 mutation 的 itemId；每轮同步全量替换）。
CREATE TABLE IF NOT EXISTS project_items (
  account_id        INTEGER NOT NULL,
  project_github_id TEXT NOT NULL,
  issue_key         TEXT NOT NULL,
  item_id           TEXT NOT NULL,
  UNIQUE(account_id, project_github_id, issue_key)
);
CREATE INDEX IF NOT EXISTS idx_project_items_issue ON project_items(account_id, issue_key);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_logs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id     INTEGER NOT NULL,
  trigger_type   TEXT NOT NULL DEFAULT 'auto',
  started_at     INTEGER NOT NULL,
  finished_at    INTEGER NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'running',
  added          INTEGER NOT NULL DEFAULT 0,
  updated        INTEGER NOT NULL DEFAULT 0,
  removed        INTEGER NOT NULL DEFAULT 0,
  candidate_done INTEGER NOT NULL DEFAULT 0,
  pruned         INTEGER NOT NULL DEFAULT 0,
  failed_sources TEXT NOT NULL DEFAULT '',
  error_message  TEXT NOT NULL DEFAULT '',
  created_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sync_logs_account ON sync_logs(account_id);
CREATE INDEX IF NOT EXISTS idx_sync_logs_created ON sync_logs(created_at);

-- #235：API 调用明细（同步 / 认领 / 状态写回的请求与返回参数）。
-- request/response 均经 summarize_text 截断后写入；绝不写入 PAT。
CREATE TABLE IF NOT EXISTS api_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL DEFAULT 'sync',
  account_id  INTEGER NOT NULL DEFAULT 0,
  sync_log_id INTEGER NOT NULL DEFAULT 0,
  method      TEXT NOT NULL DEFAULT '',
  target      TEXT NOT NULL DEFAULT '',
  status      INTEGER NOT NULL DEFAULT 0,
  ok          INTEGER NOT NULL DEFAULT 1,
  elapsed_ms  INTEGER NOT NULL DEFAULT 0,
  request     TEXT NOT NULL DEFAULT '',
  response    TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_api_logs_created ON api_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_api_logs_kind ON api_logs(kind);

CREATE TABLE IF NOT EXISTS notes (
	  id         INTEGER PRIMARY KEY AUTOINCREMENT,
	  content    TEXT NOT NULL,
	  label      TEXT NOT NULL DEFAULT 'low',
	  created_at INTEGER NOT NULL,
	  updated_at INTEGER NOT NULL
	);

	CREATE TABLE IF NOT EXISTS account_columns (
	  id          INTEGER PRIMARY KEY AUTOINCREMENT,
	  account_id  INTEGER NOT NULL,
	  col_key     TEXT NOT NULL,
	  col_name    TEXT NOT NULL,
	  match_rules TEXT NOT NULL DEFAULT '[]',
	  order_index INTEGER NOT NULL DEFAULT 0,
	  UNIQUE(account_id, col_key)
	);
 	CREATE INDEX IF NOT EXISTS idx_account_columns_account ON account_columns(account_id);

-- v0.3.49：热查询复合/覆盖索引（#146）。execute_batch 每次 open_db 都跑，
-- IF NOT EXISTS 保证老库幂等补齐、新库直接建好。
CREATE INDEX IF NOT EXISTS idx_label_mappings_org_repo_label ON label_mappings(org, repo, label);
CREATE INDEX IF NOT EXISTS idx_tasks_board ON tasks(account_id, candidate_done, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_status_done_at ON tasks(status, done_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_notes_content ON notes(content);
	"#;

pub const DEFAULT_SETTINGS: &[(&str, &str)] = &[
    ("schedule_minutes", "60"),
    ("gh_path", ""),
    ("login", ""),
    ("org", ""),
    // v0.3.15：GitHub Personal Access Token。完全替换 gh CLI 路径，
    // 由设置面板（SettingsPanel）粘入后写入；为空时同步跳过并提示。
    // v0.3.16 起 PAT 迁到独立账号表，本字段仅作兼容兜底（详见 migrate_v0315_to_accounts）。
    ("pat_token", ""),
    // v0.3.15：最近一次同步的错误信息（PAT 为空 / API 错误等），前端可读此字段显示横幅。
    ("last_sync_error", ""),
    // v0.3.16：当前激活账号 id（指向 accounts.id），与 view_mode 共同决定 sync 范围。
    ("active_account_id", "1"),
    // v0.3.16：视图模式。'single'=仅同步 active 账号；'all'=同步所有账号。
    ("view_mode", "single"),
    // v0.3.21：看板列模式。'status'=四态列，'project'=Project 状态列（默认）。
    ("board_mode", "project"),
    // v0.3.17：GitHub OAuth Device Flow 的 client_id（用户注册 OAuth App 后填入一次）。
    ("oauth_client_id", ""),
    // v0.6.1 (#276)：每日自动检查更新 + 可选静默更新。
    ("auto_check_updates", "false"),
    ("auto_update", "false"),
    ("last_update_check_at", "0"),
    ("last_update_snoozed_at", "0"),
];

pub fn db_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法定位应用数据目录: {}", e))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建数据目录失败: {}", e))?;
    Ok(dir.join("taskboard.db"))
}

/// 无 AppHandle 时的数据目录（与 Tauri `app_data_dir` 解析一致）：
/// - macOS: `~/Library/Application Support/com.shawnliu.taskboard`
/// - Windows: `%APPDATA%\com.shawnliu.taskboard`
/// - Linux: `$XDG_CONFIG_HOME/com.shawnliu.taskboard`（缺省 `~/.config`）
pub fn data_dir() -> Result<PathBuf, String> {
    let base = dirs::data_dir().ok_or_else(|| "无法定位用户数据目录".to_string())?;
    Ok(base.join(APP_IDENTIFIER))
}

/// MCP 子命令等无 GUI 运行时使用的默认库路径；可用 `TASKBOARD_DB` 环境变量覆盖。
pub fn db_path_default() -> Result<PathBuf, String> {
    let dir = data_dir()?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建数据目录失败: {}", e))?;
    Ok(dir.join("taskboard.db"))
}

/// 当前 schema 版本（`PRAGMA user_version`）。
///
/// **硬约束**：`SCHEMA` 或 `MIGRATION_DDL` 每次做结构性变更（新增列 / 表 / 索引）都必须 +1，
/// 否则已升到旧版本号的库会走热路径、永久跳过新迁移。
///
/// 版本 4（#335）：无结构变更，但带一次性**数据修复**（`MIGRATE_DATA_FIXES`）——
/// 归一化 `tasks.issue_state` 大小写并修正其连带的滞留状态。数据修复同样必须靠版本号
/// 门控（只跑一次），所以照例 +1。
///
/// `open_db` 以「版本号落后 **或** 只读自愈探测发现缺口」为迁移门控：版本号是快路径，
/// 探测是兜底——历史教训（#175 / #237 / #278：版本号丢值、被物理重建覆盖、新列没进
/// 重建的写死白名单）表明仅靠版本号会漏列，故两者缺一不可。
pub const SCHEMA_VERSION: i64 = 4;

/// 必须存在的列（表 → 列）。热路径**只读**探测，缺任何一列都触发迁移。
/// 新增必填列时必须同步追加 `MIGRATION_DDL` 里的补齐语句（有单测守卫）。
const REQUIRED_COLUMNS: &[(&str, &str)] = &[
    ("tasks", "work_branch"),
    ("tasks", "author"),
    ("tasks", "parent_issue"),
    ("tasks", "sub_issues"),
    ("tasks", "work_dir"),
    ("tasks", "created_at"),
    ("notes", "label"),
    ("label_mappings", "order_index"),
    ("projects", "status_field_id"),
    ("project_statuses", "option_id"),
];

/// 必须存在的索引。语义同 `REQUIRED_COLUMNS`：缺失即触发迁移重建。
const REQUIRED_INDEXES: &[&str] = &[
    "idx_label_mappings_org",
    "idx_label_mappings_repo",
    "idx_label_mappings_org_repo_label",
    "idx_tasks_board",
    "idx_tasks_status_done_at",
    "idx_tasks_issue_key",
    "idx_notes_content",
    "idx_project_items_issue",
];

/// 一次性结构迁移语句（顺序敏感，勿随意调整）。
///
/// ⚠️ 新增 `tasks` 列的 ALTER **必须**追加到这里——执行时机在 `migrate_tasks_v2_rebuild`
/// **之后**；**不能**只写进 `migrate_legacy_alters`（后者仅 `user_version < 1` 触发，
/// 且执行在重建之前，重建的写死列白名单会把新列丢掉）。详见 docs/issue-175-*.md。
const MIGRATION_DDL: &[&str] = &[
    // v0.3.20：label_mappings 表迁移（表由 SCHEMA 建，这里只补旧库缺的索引）。
    "CREATE INDEX IF NOT EXISTS idx_label_mappings_org ON label_mappings(org)",
    "CREATE INDEX IF NOT EXISTS idx_label_mappings_repo ON label_mappings(repo)",
    // v0.3.21：Label 列视图排序用。
    "ALTER TABLE label_mappings ADD COLUMN order_index INTEGER NOT NULL DEFAULT 0",
    // v0.3.24：notes.label。早期无标签版本的库缺此列，list_notes / add_note 会全部失败。
    "ALTER TABLE notes ADD COLUMN label TEXT NOT NULL DEFAULT 'low'",
    // #215：Project 写回三件套的列补齐（表见 `PROJECT_ITEMS_DDL`）。
    "ALTER TABLE projects ADD COLUMN status_field_id TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE project_statuses ADD COLUMN option_id TEXT NOT NULL DEFAULT ''",
    // v0.3.53 (#171)：agent 通过 record_session 写入的工作分支（同步不碰）。
    "ALTER TABLE tasks ADD COLUMN work_branch TEXT NOT NULL DEFAULT ''",
    // #237：issue 创建人。
    "ALTER TABLE tasks ADD COLUMN author TEXT NOT NULL DEFAULT ''",
    // #278：父子关系。
    "ALTER TABLE tasks ADD COLUMN parent_issue TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE tasks ADD COLUMN sub_issues TEXT NOT NULL DEFAULT ''",
    // #287：工作目录（agent 通过 record_session 写入的项目路径）。
    "ALTER TABLE tasks ADD COLUMN work_dir TEXT NOT NULL DEFAULT ''",
    // #280：issue 创建时间。
    "ALTER TABLE tasks ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0",
    // v0.3.50 (#155)：新库由 SCHEMA 建、重建后由重建函数建；此处兜底。
    "CREATE INDEX IF NOT EXISTS idx_tasks_issue_key ON tasks(issue_key)",
    "CREATE INDEX IF NOT EXISTS idx_project_items_issue ON project_items(account_id, issue_key)",
];

/// 一次性**数据修复**语句（#335，`SCHEMA_VERSION = 4` 起门控）。顺序敏感：先归一化再判定。
///
/// 背景：`tasks.issue_state` 被两个来源写入了两套大小写 —— REST 给小写 `open`/`closed`，
/// GraphQL（ProjectV2 条目查询）给大写 `OPEN`/`CLOSED`；而当时三处 closed 判据都写死小写，
/// 于是 Project 来源的已关闭 issue 既不命中「closed → done」，也过不了 Project Status 兜底
/// （那两个 Project 的 Status 选项是英文，`map_project_status` 只认中文）⇒ 长期滞留在
/// `todo`/`processed` 列。代码层面已在 `common::is_closed_state` 修掉，这里补存量数据。
///
/// 全部幂等，可安全重跑。**不写 `done_at`**：一次修复拿不到真实关闭时间，而 `done_at`
/// 唯一用途是 `sync.rs` 里「已完成任务保留 1 个月」的淘汰窗口（`WHERE done_at > 0`）——
/// 臆造一个时间戳会凭空启动淘汰倒计时，留 0 反而保证这些行不被误删。
const MIGRATE_DATA_FIXES: &[&str] = &[
    // 1) 归一化大小写，使该列口径单一（`CLOSED`→`closed`、`OPEN`→`open`）。
    "UPDATE tasks SET issue_state = lower(trim(issue_state))
       WHERE issue_state <> lower(trim(issue_state))",
    // 2) 已关闭却未落到 done 的行，按 AGENTS.md §2.2 第 1 条「closed 远程权威覆盖」修正。
    //    必须在上一条之后执行（此处依赖归一化后的 `closed`）。
    "UPDATE tasks SET status = 'done'
       WHERE issue_state = 'closed' AND status <> 'done'",
];

/// #215：Project 写回所需的条目表（新库由 `SCHEMA` 建，旧库在此补建）。
/// 独立于 `MIGRATION_DDL`：建表失败是**硬错误**（后续写回查询会 `no such table`）。
const PROJECT_ITEMS_DDL: &str = "CREATE TABLE IF NOT EXISTS project_items (
           account_id        INTEGER NOT NULL,
           project_github_id TEXT NOT NULL,
           issue_key         TEXT NOT NULL,
           item_id           TEXT NOT NULL,
           UNIQUE(account_id, project_github_id, issue_key)
         )";

/// 打开（必要时创建）数据库连接，应用 schema 与历史迁移，并写入默认设置。
/// GUI 与 MCP 子命令共用此函数，确保表结构单一来源、无漂移。
///
/// **崩溃恢复说明（v0.3.16+）**：早期默认 `journal_mode=DELETE`，进程崩溃时未提交
/// 事务会留下 `.db-journal` 文件，下次启动必须先 replay/rollback 才能继续——一旦
/// journal 不完整（如早期 v0.3.16 二进制在 macOS 26.6 的 SIGABRT），整个 DB 会
/// 进入"disk I/O error"无限循环。本函数强制 `journal_mode=WAL`，配合 `synchronous=NORMAL`：
/// WAL 文件 (`-wal`/`-shm`) 与主 DB 文件始终一致可读，崩溃不会让整个 DB 锁死。
/// WAL 与 DELETE 共存时不冲突——已有的 `-journal` 文件如果存在，SQLite 会自动 forward-rollback。
///
/// **稳态零写入（#329）**：UI 每个 Tauri command 都会 `open_db` 一次，若每次建连都执行
/// `DELETE FROM notes` + N 条 `INSERT meta` + ~12 条 ALTER，就会与同步的长写事务争抢写锁
/// （`busy_timeout=5000`），表现为「点一下卡满 5 秒」。现改为：仅当 `user_version` 落后、
/// 只读探测发现缺列/缺索引、或 `tasks` 仍是 legacy 布局时才执行迁移；默认设置也改为
/// 先只读比对、只补缺失项。稳态下本函数不产生任何写语句（`SCHEMA` 全为 `IF NOT EXISTS`，
/// 对象已存在时不写盘）。回归测试见 `open_db_steady_state_does_not_take_write_lock`。
pub fn open_db(path: &Path) -> Result<Connection, String> {
    let conn = Connection::open(path).map_err(|e| format!("打开数据库失败: {}", e))?;
    // v0.3.49 (#149)：库文件含 PAT 明文，Unix 下收紧为仅所有者可读写。
    // best-effort：权限设置失败不阻断打开（多用户共享机器上的纵深防御）。
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(md) = std::fs::metadata(path) {
            let mut perm = md.permissions();
            if perm.mode() & 0o777 != 0o600 {
                perm.set_mode(0o600);
                let _ = std::fs::set_permissions(path, perm);
            }
        }
    }
    // v0.3.16+: WAL 模式 + NORMAL 同步。WAL 文件保留部分未 checkpoint 数据，崩溃后仍可读。
    // 必须先设（再做任何事务），否则后续 BEGIN/COMMIT 仍走 DELETE 路径。
    let _ = conn.pragma_update(None, "journal_mode", "WAL");
    let _ = conn.pragma_update(None, "synchronous", "NORMAL");
    let _ = conn.pragma_update(None, "busy_timeout", 5000);
    // ── 迁移门控（#329）────────────────────────────────────────────────
    // `tasks` 不存在 ⇒ 全新库：`SCHEMA` 足以建出最新布局，迁移语句基本是幂等空转
    // （少数 ALTER 会因列已存在而报错并被忽略），跑一轮把 `user_version` 落地更省心。
    let fresh = !table_exists(&conn, "tasks");
    let needs_migration = !fresh && !schema_is_current(&conn);
    if needs_migration {
        // v0.3.49 (#146)：notes.content 唯一索引在 `SCHEMA` 里；老库若有重复 content，
        // `execute_batch(SCHEMA)` 会直接失败、整个库打不开。去重必须先于 SCHEMA 执行。
        let _ = conn.execute(
            "DELETE FROM notes WHERE id NOT IN (SELECT MIN(id) FROM notes GROUP BY content)",
            [],
        );
    }
    // schema 初始化（WAL 模式下多个连接可并发读，但写仍互斥）。语句全部 `IF NOT EXISTS`：
    // 对象已存在时不写盘、不取写锁，故稳态下可无条件执行。
    conn.execute_batch(SCHEMA)
        .map_err(|e| format!("初始化表结构失败: {}", e))?;
    if fresh || needs_migration {
        // 迁移后结构达标才推进版本号；仍有缺口则保持原值，下次启动重试。
        // 仅在「落后」时提升，绝不回退（防止被更新版本的二进制写高的值被本版本覆盖）。
        if run_migrations(&conn, fresh)? && schema_version(&conn) < SCHEMA_VERSION {
            let _ = conn.pragma_update(None, "user_version", SCHEMA_VERSION);
        }
    }
    // 默认设置：先只读比对既有 key，只补缺失项（稳态零写入，见函数头 #329 说明）。
    ensure_default_settings(&conn)?;
    Ok(conn)
}

/// 补齐缺失的默认设置：一次性只读读出既有 key，只对缺失项写 `INSERT`。
/// 稳态（无缺失）不产生任何写语句，避免与同步的长写事务争抢写锁（#329）。
fn ensure_default_settings(conn: &Connection) -> Result<(), String> {
    let mut existing: HashSet<String> = HashSet::new();
    {
        let mut stmt = conn
            .prepare("SELECT key FROM meta")
            .map_err(|e| format!("读取默认设置失败: {}", e))?;
        let rows = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| format!("读取默认设置失败: {}", e))?;
        for row in rows.flatten() {
            existing.insert(row);
        }
    }
    for (k, v) in DEFAULT_SETTINGS {
        if existing.contains(*k) {
            continue;
        }
        conn.execute(
            "INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO NOTHING",
            rusqlite::params![k, v],
        )
        .map_err(|e| format!("写入默认设置失败: {}", e))?;
    }
    Ok(())
}

/// 一次性结构迁移。仅由 `open_db` 在「全新库 / 版本号落后 / 探测到缺口」时调用。
///
/// 全部语句幂等，可安全重跑。返回值：`Ok(true)` = 迁移后结构已达标（调用方可推进
/// `user_version`）；`Ok(false)` = 仍有缺口（保持原版本号，下次启动重试）；
/// `Err` 仅用于「建表失败」这类硬错误。
///
/// `fresh` 为真表示全新库：`tasks` 表刚由 `SCHEMA` 建出、布局即最新，
/// 故跳过 `migrate_legacy_alters`（那 14 条 ALTER 必然全部因列已存在而失败）。
fn run_migrations(conn: &Connection, fresh: bool) -> Result<bool, String> {
    let from_ver = schema_version(conn);
    // v0.3.49 (#147)：未版本化老库（user_version < 1）的列补齐。
    if !fresh && from_ver < 1 {
        migrate_legacy_alters(conn);
    }
    // v0.3.50 (#155)：tasks 物理重建。以「tasks 是否仍含旧 key 列」为判定，兼容
    // user_version 丢值 / 旧库直接建的场景——重建后 key 列消失，幂等不重复执行。
    // 顺序依赖：`migrate_legacy_alters` 必须先跑，保证老表已补齐 gh_status/assignees
    // 等列，重建的 INSERT..SELECT 才能读到。
    if tasks_uses_legacy_key(conn) {
        if let Err(e) = migrate_tasks_v2_rebuild(conn) {
            // 保持原版本号，下次启动重试（残留的 tasks_new 由重建函数开头 DROP IF EXISTS 自愈）。
            crate::tlog!("[db] tasks v2 物理重建失败，将在下次启动重试: {}", e);
        }
    }
    // #215：Project 写回条目表。建表失败是硬错误（后续写回查询会 no such table）。
    if let Err(e) = conn.execute(PROJECT_ITEMS_DDL, []) {
        return Err(format!("创建 project_items 表失败: {e}"));
    }
    // ⚠️ 新增 tasks 列的 ALTER 必须写进 `MIGRATION_DDL`（执行时机在本函数内、重建之后）。
    // 写到别处或漏写会永久丢列，详见常量定义处的说明。
    for ddl in MIGRATION_DDL {
        if let Err(e) = conn.execute(ddl, []) {
            if crate::common::verbose_enabled() {
                crate::tlog!("[db] 迁移语句跳过（已存在或不适用）: {} | sql={}", e, ddl);
            }
        }
    }
    // v0.3.15 → v0.3.16 自动迁移：把 v0.3.15 写在 meta.pat_token 的单账号 PAT
    // 迁到 accounts 表（首条默认账号）。原 meta 字段保留作兼容兜底，单账号视图仍可读。
    if let Err(e) = migrate_v0315_to_accounts(conn) {
        if crate::common::verbose_enabled() {
            crate::tlog!("[db] v0.3.15 → v0.3.16 迁移失败（已保留兜底字段）: {}", e);
        }
    }
    // #335：存量数据修复。best-effort——失败只记日志，**不影响**版本号推进。
    // 理由：① 结构达标才是 `user_version` 的门槛；② 若因失败而卡住版本号，`needs_migration`
    // 会恒为真，稳态将每次建连都跑一遍迁移，回归 #329 修掉的「每次 open_db 写库」缺陷。
    // 即便这里整段失败，代码层面的修复也会让下一次全量同步逐行修正。
    for sql in MIGRATE_DATA_FIXES {
        if let Err(e) = conn.execute(sql, []) {
            crate::tlog!("[db] #335 数据修复语句失败（忽略）: {} | sql={}", e, sql);
        }
    }
    // 迁移后复检：仍有缺列 / 缺索引 / 仍是 legacy 布局 ⇒ 不推进版本号，下次启动重试。
    let miss_cols = missing_columns(conn);
    let miss_idx = missing_indexes(conn);
    let ok = miss_cols.is_empty() && miss_idx.is_empty() && !tasks_uses_legacy_key(conn);
    if !ok && crate::common::verbose_enabled() {
        crate::tlog!(
            "[db] 迁移未达标，保持 user_version={}: 缺列 {:?}，缺索引 {:?}",
            from_ver,
            miss_cols,
            miss_idx
        );
    }
    Ok(ok)
}

/// 读取 `PRAGMA user_version`（读失败按 0 处理，等价未版本化老库）。
fn schema_version(conn: &Connection) -> i64 {
    conn.pragma_query_value(None, "user_version", |r| r.get(0))
        .unwrap_or(0)
}

/// 表是否存在（只读）。
fn table_exists(conn: &Connection, name: &str) -> bool {
    conn.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1")
        .and_then(|mut s| s.exists([name]))
        .unwrap_or(false)
}

/// 只读探测缺失的必填列（表不存在时其所有列都算缺失，交由迁移建表/补列）。
fn missing_columns(conn: &Connection) -> Vec<(&'static str, &'static str)> {
    let mut cache: HashMap<&str, HashSet<String>> = HashMap::new();
    let mut missing = Vec::new();
    for (table, col) in REQUIRED_COLUMNS {
        let cols = cache.entry(*table).or_insert_with(|| {
            let mut set = HashSet::new();
            if let Ok(mut stmt) = conn.prepare("SELECT name FROM pragma_table_info(?1)") {
                if let Ok(rows) = stmt.query_map([*table], |r| r.get::<_, String>(0)) {
                    for name in rows.flatten() {
                        set.insert(name);
                    }
                }
            }
            set
        });
        if !cols.contains(*col) {
            missing.push((*table, *col));
        }
    }
    missing
}

/// 只读探测缺失的必填索引。
fn missing_indexes(conn: &Connection) -> Vec<&'static str> {
    let mut missing = Vec::new();
    for idx in REQUIRED_INDEXES {
        let found = conn
            .prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?1")
            .and_then(|mut s| s.exists([idx]))
            .unwrap_or(false);
        if !found {
            missing.push(*idx);
        }
    }
    missing
}

/// 热路径自愈探测：schema 是否已达标（版本号 + 缺列 + 缺索引 + 旧布局）。
///
/// 全程**只读**，不取写锁——稳态下 `open_db` 因此完全无写入（#329）。
/// 探测为兜底：即使版本号被人为改高或丢失，缺列/缺索引仍会触发迁移。
fn schema_is_current(conn: &Connection) -> bool {
    schema_version(conn) >= SCHEMA_VERSION
        && !tasks_uses_legacy_key(conn)
        && missing_columns(conn).is_empty()
        && missing_indexes(conn).is_empty()
}

/// v0.3.49 (#147)：未版本化老库（user_version 0）的一次性列补齐。
/// 列已存在时 ALTER 会报错，忽略即可（缺列则补上）。
fn migrate_legacy_alters(conn: &Connection) {
    for col_sql in [
        "ALTER TABLE tasks ADD COLUMN gh_status TEXT NOT NULL DEFAULT ''",
        "ALTER TABLE tasks ADD COLUMN assignees TEXT NOT NULL DEFAULT ''",
        "ALTER TABLE tasks ADD COLUMN labels TEXT NOT NULL DEFAULT ''",
        "ALTER TABLE tasks ADD COLUMN done_at INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE tasks ADD COLUMN mentioned INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE tasks ADD COLUMN comments_count INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE tasks ADD COLUMN latest_comment_url TEXT NOT NULL DEFAULT ''",
        "ALTER TABLE tasks ADD COLUMN pr_number INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE tasks ADD COLUMN pr_url TEXT NOT NULL DEFAULT ''",
        // v0.3.10：关联 PR 的分支（head.ref）。
        "ALTER TABLE tasks ADD COLUMN branch TEXT NOT NULL DEFAULT ''",
        // v0.3.53 (#171)：agent 通过 record_session 写入的工作分支（同步不碰）。
        "ALTER TABLE tasks ADD COLUMN work_branch TEXT NOT NULL DEFAULT ''",
        // #287：agent 通过 record_session 写入的工作目录（项目路径）。
        "ALTER TABLE tasks ADD COLUMN work_dir TEXT NOT NULL DEFAULT ''",
        "ALTER TABLE tasks ADD COLUMN handoff TEXT NOT NULL DEFAULT ''",
        // v0.3.16：任务归属账号；旧库默认 1（迁移会先插一条 accounts，再保证该 id 命中）。
        "ALTER TABLE tasks ADD COLUMN account_id INTEGER NOT NULL DEFAULT 1",
    ] {
        if let Err(e) = conn.execute(col_sql, []) {
            // **不再吞掉**：v0.3.16 之前是 `let _ = ...`，导致脏 DB 被静默接受，下次 sync
            // 触发 panic。默认静默（MCP 调用时不刷屏），仅 TASKBOARD_LOG=1 时输出。
            if crate::common::verbose_enabled() {
                crate::tlog!(
                    "[db] 列迁移跳过（已存在或 schema 不兼容）: {} | sql={}",
                    e,
                    col_sql
                );
            }
        }
    }
}

/// v0.3.50 (#155)：判定 tasks 表是否仍是旧的 `key` 主键布局（含 `key` 列）。
/// 新库由 SCHEMA 直接建新布局（无 key 列）；老库保留旧布局，据此触发物理重建。
/// 重建一次后 key 列消失，即便 user_version 丢值也不会二次重建（幂等）。
fn tasks_uses_legacy_key(conn: &Connection) -> bool {
    conn.prepare("SELECT 1 FROM pragma_table_info('tasks') WHERE name = 'key'")
        .map(|mut stmt| stmt.exists([]).unwrap_or(false))
        .unwrap_or(false)
}

/// v0.3.50 (#155)：tasks 表物理重建（单事务，幂等）。
///
/// 建新表 tasks_new → INSERT..SELECT 迁移数据 → DROP 老表 → RENAME → 重建索引。
/// 列变更：key→(id, issue_key)、gh_state→issue_state、gh_status→project_status、
/// updated_at TEXT→INTEGER 秒（RFC3339 用 strftime('%s') 转换，与 synced_at/done_at 单位一致）。
///
/// 老表 key 为全局主键，因此 (repo, number) 全局唯一，INSERT..SELECT 不会撞
/// UNIQUE(repo, number, account_id)。DROP 连同老表上的索引一起删除，
/// 故 RENAME 后需重建 tasks 的全部索引（含 SCHEMA 末尾的 board/status_done_at 复合索引）。
///
/// #328：**整段必须在一个事务里**。`execute_batch` 不做隐式事务（rusqlite 只是逐条
/// `prepare` + `step`），故原写法里 `DROP TABLE tasks` 与 `ALTER … RENAME` 是两次独立
/// 提交，有两类后果：
/// ① 两步之间进程被杀 / 断电 → `tasks` 丢失、数据滞留 `tasks_new`；下次启动
///    `CREATE TABLE IF NOT EXISTS tasks` 重建**空表**，本地态（status / session_* /
///    handoff / work_branch / work_dir）永久丢失；
/// ② 中途失败残留 `tasks_new` 后，本次及此后每次 `CREATE TABLE tasks_new` 都报
///    「table tasks_new already exists」→ `tasks` 又始终带旧 `key` 列 ⇒ 后续查询报
///    `no such column: issue_key`，而日志只有默认静默的 `tlog!`，无自愈路径。
///
/// 现在：开头 `DROP TABLE IF EXISTS tasks_new` 自愈上次的残留，`BEGIN IMMEDIATE … COMMIT`
/// 保证原子，`user_version` 也在同一事务内推进（不再出现「已重建但版本未记」）。
fn migrate_tasks_v2_rebuild(conn: &Connection) -> Result<(), String> {
    const REBUILD_SQL: &str = r#"
        DROP TABLE IF EXISTS tasks_new;
        BEGIN IMMEDIATE;
        CREATE TABLE IF NOT EXISTS tasks_new (
          id             INTEGER PRIMARY KEY,
          issue_key      TEXT NOT NULL,
          owner          TEXT NOT NULL,
          repo           TEXT NOT NULL,
          number         INTEGER NOT NULL,
          title          TEXT NOT NULL,
          url            TEXT NOT NULL,
          issue_state    TEXT NOT NULL,
          ownership      TEXT NOT NULL,
          status         TEXT NOT NULL DEFAULT 'todo',
          session_id     TEXT,
          session_agent  TEXT,
          session_at     INTEGER,
          candidate_done INTEGER NOT NULL DEFAULT 0,
          stale          INTEGER NOT NULL DEFAULT 0,
          project_status TEXT NOT NULL DEFAULT '',
          assignees      TEXT NOT NULL DEFAULT '',
          labels         TEXT NOT NULL DEFAULT '',
          done_at        INTEGER NOT NULL DEFAULT 0,
          mentioned      INTEGER NOT NULL DEFAULT 0,
          comments_count INTEGER NOT NULL DEFAULT 0,
          latest_comment_url TEXT NOT NULL DEFAULT '',
          pr_number      INTEGER NOT NULL DEFAULT 0,
          pr_url         TEXT NOT NULL DEFAULT '',
          branch         TEXT NOT NULL DEFAULT '',
          work_branch    TEXT NOT NULL DEFAULT '',
          work_dir       TEXT NOT NULL DEFAULT '',
          handoff        TEXT NOT NULL DEFAULT '',
          updated_at     INTEGER,
          synced_at      INTEGER NOT NULL,
          account_id     INTEGER NOT NULL DEFAULT 1,
          UNIQUE(repo, number, account_id)
        );
        INSERT INTO tasks_new
          (issue_key, owner, repo, number, title, url, issue_state, ownership, status,
           session_id, session_agent, session_at, candidate_done, stale, project_status,
           assignees, labels, done_at, mentioned, comments_count, latest_comment_url,
           pr_number, pr_url, branch, work_branch, handoff, updated_at, synced_at, account_id)
        SELECT
           key, owner, repo, number, title, url, gh_state, ownership, status,
           session_id, session_agent, session_at, candidate_done, stale, gh_status,
           assignees, labels, done_at, mentioned, comments_count, latest_comment_url,
           pr_number, pr_url, branch, work_branch, handoff,
           COALESCE(CAST(strftime('%s', NULLIF(TRIM(updated_at), '')) AS INTEGER), 0),
           synced_at, account_id
        FROM tasks;
        DROP TABLE tasks;
        ALTER TABLE tasks_new RENAME TO tasks;
        CREATE INDEX IF NOT EXISTS idx_tasks_issue_key ON tasks(issue_key);
        CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
        CREATE INDEX IF NOT EXISTS idx_tasks_ownership ON tasks(ownership);
        CREATE INDEX IF NOT EXISTS idx_tasks_account ON tasks(account_id);
        CREATE INDEX IF NOT EXISTS idx_tasks_board ON tasks(account_id, candidate_done, status, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_tasks_status_done_at ON tasks(status, done_at);
        PRAGMA user_version = 2;
        COMMIT;
        "#;
    if let Err(e) = conn.execute_batch(REBUILD_SQL) {
        // 显式回滚：execute_batch 不替调用方收尾，失败时连接会一直挂在未提交事务里，
        // 后续 open_db 的写入会被卷进同一事务、或拖到进程退出时才被动回滚。
        let _ = conn.execute_batch("ROLLBACK;");
        return Err(format!("tasks 表重建失败: {}", e));
    }
    if crate::common::verbose_enabled() {
        crate::tlog!("[db] tasks 表 v0.3.50 物理重建完成（id + issue_key + 复合唯一键 + updated_at INTEGER）");
    }
    Ok(())
}

/// 把 v0.3.15 写在 `meta.pat_token` 的 PAT 自动迁到 `accounts` 表第一条记录。
///
/// 触发条件（全部满足才迁移）：
/// 1. `accounts` 表为空（首次启动 v0.3.16，无任何账号）
/// 2. `meta.pat_token` 非空（v0.3.15 已配过 PAT，不是新用户）
///
/// 迁移动作：
/// - INSERT 一条记录：label='默认账号', login=<meta.login>, org=<meta.org>,
///   pat_token=<meta.pat_token>, is_default=1
/// - meta.active_account_id 设为新插入的 id
/// - 若 tasks.account_id 当前默认 1，但 accounts.id=1 是新插入的，需要把所有
///   旧任务的 account_id 调整为新插入 id（避免后续多账号视图下误归到一个不存在的账号）
fn migrate_v0315_to_accounts(conn: &Connection) -> Result<(), String> {
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM accounts", [], |r| r.get(0))
        .unwrap_or(0);
    if count > 0 {
        return Ok(()); // 已迁过或用户主动加过账号，不重复处理
    }
    let pat = get_setting(conn, "pat_token");
    if pat.trim().is_empty() {
        return Ok(()); // 新用户，没历史 PAT 可迁
    }
    let login = get_setting(conn, "login");
    let org = get_setting(conn, "org");
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    conn.execute(
        "INSERT INTO accounts (label, login, org, pat_token, is_default, created_at)
         VALUES (?1, ?2, ?3, ?4, 1, ?5)",
        rusqlite::params!["默认账号", login, org, pat, now],
    )
    .map_err(|e| format!("写入默认账号失败: {}", e))?;
    let new_id: i64 = conn
        .query_row("SELECT last_insert_rowid()", [], |r| r.get(0))
        .unwrap_or(1);
    // 把当前默认账号 id（DEFAULT_SETTINGS 写的是 1）调整到新插入的 id。
    // 旧任务的 account_id 默认 1 也要改到新插入的 id——确保 view 过滤正确。
    if new_id != 1 {
        let _ = conn.execute(
            "UPDATE tasks SET account_id = ?1 WHERE account_id = 1",
            rusqlite::params![new_id],
        );
    }
    set_setting(conn, "active_account_id", &new_id.to_string())?;
    if crate::common::verbose_enabled() {
        crate::tlog!(
            "[db] v0.3.15 → v0.3.16 自动迁移完成：新账号 id={} @{} (org={})",
            new_id,
            login,
            org
        );
    }
    Ok(())
}

/// 账号记录（与 accounts 表一一对应；前端用）。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub id: i64,
    pub label: String,
    pub login: String,
    pub org: String,
    /// 是否已配置 PAT（不回显 token 本体，避免泄漏）。
    pub has_pat: bool,
    pub is_default: bool,
    /// v0.3.43+：该账号的看板列展示方式（status/project/custom），存于 meta 的 `board_mode:<id>`。
    /// 未配置时默认 project。
    pub board_mode: String,
    pub created_at: i64,
}

/// meta 表里按账号存储看板列展示方式的 key。
pub fn account_board_mode_key(account_id: i64) -> String {
    format!("board_mode:{}", account_id)
}

/// 读取某账号的看板列展示方式；未配置默认 project。
pub fn get_account_board_mode(conn: &Connection, account_id: i64) -> String {
    let v = get_setting(conn, &account_board_mode_key(account_id));
    if v.is_empty() {
        "project".to_string()
    } else {
        v
    }
}

/// 校验看板列展示方式是否合法（status/project/custom）。
pub fn is_valid_board_mode(mode: &str) -> bool {
    matches!(mode, "status" | "project" | "custom")
}

/// 写入某账号的看板列展示方式（仅接受合法值）。
pub fn set_account_board_mode(
    conn: &Connection,
    account_id: i64,
    mode: &str,
) -> Result<(), String> {
    if !is_valid_board_mode(mode) {
        return Err(format!("非法的看板列展示方式: {mode}"));
    }
    set_setting(conn, &account_board_mode_key(account_id), mode)
}

/// 列出全部账号，按 id 升序。
pub fn list_accounts(conn: &Connection) -> Result<Vec<Account>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, label, login, org, pat_token, is_default, created_at
             FROM accounts ORDER BY id ASC",
        )
        .map_err(|e| format!("查询账号列表失败: {}", e))?;
    let rows = stmt
        .query_map([], |r| {
            let pat: String = r.get(4)?;
            let is_default: i64 = r.get(5)?;
            Ok(Account {
                id: r.get(0)?,
                label: r.get(1)?,
                login: r.get(2)?,
                org: r.get(3)?,
                has_pat: !pat.is_empty(),
                is_default: is_default != 0,
                board_mode: get_account_board_mode(conn, r.get(0)?),
                created_at: r.get(6)?,
            })
        })
        .map_err(|e| format!("遍历账号失败: {}", e))?;
    let mut out: Vec<Account> = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| format!("读取账号行失败: {}", e))?);
    }
    Ok(out)
}

/// 读取单条账号的完整信息（含 PAT），仅后端内部使用；不在前端暴露。
pub fn get_account_pat(conn: &Connection, id: i64) -> Result<(String, String, String), String> {
    conn.query_row(
        "SELECT login, org, pat_token FROM accounts WHERE id = ?1",
        [id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )
    .map_err(|e| format!("读取账号 #{id} 失败: {e}"))
}

/// 默认账号 id：is_default=1 的那条；若无则退回 id 最小的。
pub fn default_account_id(conn: &Connection) -> Result<i64, String> {
    let id: Option<i64> = conn
        .query_row(
            "SELECT id FROM accounts WHERE is_default = 1 ORDER BY id ASC LIMIT 1",
            [],
            |r| r.get(0),
        )
        .ok();
    if let Some(id) = id {
        return Ok(id);
    }
    conn.query_row("SELECT id FROM accounts ORDER BY id ASC LIMIT 1", [], |r| {
        r.get(0)
    })
    .map_err(|e| format!("无任何账号: {e}"))
}

/// 把 id 指定的账号设为默认（is_default=1，其他归 0）。
pub fn set_default_account(conn: &Connection, id: i64) -> Result<(), String> {
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| format!("开启事务失败: {e}"))?;
    tx.execute("UPDATE accounts SET is_default = 0", [])
        .map_err(|e| format!("清空默认失败: {e}"))?;
    let n = tx
        .execute("UPDATE accounts SET is_default = 1 WHERE id = ?1", [id])
        .map_err(|e| format!("设置默认失败: {e}"))?;
    if n == 0 {
        return Err(format!("账号 #{id} 不存在"));
    }
    tx.commit().map_err(|e| format!("提交失败: {e}"))?;
    Ok(())
}

/// 插入一条新账号；返回新账号 id。若该账号是首个，自动设为默认。
pub fn insert_account(
    conn: &Connection,
    label: &str,
    login: &str,
    org: &str,
    pat: &str,
) -> Result<i64, String> {
    let label = label.trim();
    let login = login.trim();
    let org = org.trim();
    let pat = pat.trim();
    if label.is_empty() {
        return Err("账号名称（label）不能为空".to_string());
    }
    if login.is_empty() {
        return Err("GitHub login 不能为空".to_string());
    }
    if org.is_empty() {
        // org 允许为空（个人账号无组织归属时可省略）
    }
    if pat.is_empty() {
        return Err("PAT 不能为空".to_string());
    }
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    // 若 accounts 表为空，自动设为默认；否则显式非默认。
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM accounts", [], |r| r.get(0))
        .unwrap_or(0);
    let is_default = if count == 0 { 1 } else { 0 };
    conn.execute(
        "INSERT INTO accounts (label, login, org, pat_token, is_default, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        rusqlite::params![label, login, org, pat, is_default, now],
    )
    .map_err(|e| format!("插入账号失败: {e}"))?;
    let id: i64 = conn
        .query_row("SELECT last_insert_rowid()", [], |r| r.get(0))
        .unwrap_or(0);
    Ok(id)
}

/// 更新账号字段；pat=None 表示不动，pat=Some("") 表示清空，pat=Some(s) 表示替换。
pub fn update_account(
    conn: &Connection,
    id: i64,
    label: Option<&str>,
    login: Option<&str>,
    org: Option<&str>,
    pat: Option<&str>,
) -> Result<(), String> {
    let mut sets: Vec<String> = Vec::new();
    let mut params: Vec<String> = Vec::new();
    if let Some(v) = label {
        if v.trim().is_empty() {
            return Err("账号名称不能为空".to_string());
        }
        sets.push("label = ?".to_string());
        params.push(v.trim().to_string());
    }
    if let Some(v) = login {
        if v.trim().is_empty() {
            return Err("GitHub login 不能为空".to_string());
        }
        sets.push("login = ?".to_string());
        params.push(v.trim().to_string());
    }
    if let Some(v) = org {
        if v.trim().is_empty() {
            return Err("组织不能为空".to_string());
        }
        sets.push("org = ?".to_string());
        params.push(v.trim().to_string());
    }
    if let Some(v) = pat {
        sets.push("pat_token = ?".to_string());
        params.push(v.trim().to_string());
    }
    if sets.is_empty() {
        return Ok(()); // 没改任何字段
    }
    let sql = format!("UPDATE accounts SET {} WHERE id = ?", sets.join(", "));
    let mut all_params: Vec<&dyn rusqlite::ToSql> =
        params.iter().map(|s| s as &dyn rusqlite::ToSql).collect();
    all_params.push(&id);
    let n = conn
        .execute(&sql, all_params.as_slice())
        .map_err(|e| format!("更新账号失败: {e}"))?;
    if n == 0 {
        return Err(format!("账号 #{id} 不存在"));
    }
    Ok(())
}

/// 删除账号并级联清理该账号下所有本地数据（原子事务）。
/// 包括：tasks、projects、project_statuses、sync_logs、账号配置。
/// 默认账号不可删除；须先把另一个账号设为默认。
pub fn delete_account(conn: &Connection, id: i64) -> Result<(), String> {
    let is_default: i64 = conn
        .query_row("SELECT is_default FROM accounts WHERE id = ?1", [id], |r| {
            r.get(0)
        })
        .unwrap_or(0);
    if is_default != 0 {
        // #216：仅剩一个账号时允许删除（删后无账号无默认，调用方把 active 归零）。
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM accounts", [], |r| r.get(0))
            .unwrap_or(0);
        if count > 1 {
            return Err("默认账号不可删除，请先把另一个账号设为默认".to_string());
        }
    }
    // 检查账号是否存在
    let exists: i64 = conn
        .query_row("SELECT COUNT(*) FROM accounts WHERE id = ?1", [id], |r| {
            r.get(0)
        })
        .unwrap_or(0);
    if exists == 0 {
        return Err(format!("账号 #{id} 不存在"));
    }
    // 在同一事务中原子删除所有关联数据。
    // v0.3.49 (#147)：改用 RAII 事务（与他处 unchecked_transaction 一致）；
    // 中间失败或 panic 时自动回滚，不再残留手写 BEGIN 锁。
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| format!("开启事务失败: {e}"))?;
    // 1. 删除 tasks
    tx.execute("DELETE FROM tasks WHERE account_id = ?1", [id])
        .map_err(|e| format!("删除 tasks 失败: {e}"))?;
    // 2. 删除 projects
    tx.execute("DELETE FROM projects WHERE account_id = ?1", [id])
        .map_err(|e| format!("删除 projects 失败: {e}"))?;
    // 2b. 删除 project_items（#215 写回 id，不留脏数据）。
    tx.execute("DELETE FROM project_items WHERE account_id = ?1", [id])
        .map_err(|e| format!("删除 project_items 失败: {e}"))?;
    // 3. 删除 project_statuses
    tx.execute("DELETE FROM project_statuses WHERE account_id = ?1", [id])
        .map_err(|e| format!("删除 project_statuses 失败: {e}"))?;
    // 4. 删除 sync_logs
    tx.execute("DELETE FROM sync_logs WHERE account_id = ?1", [id])
        .map_err(|e| format!("删除 sync_logs 失败: {e}"))?;
    // 5. 删除 account_columns（v0.3.28+）
    tx.execute("DELETE FROM account_columns WHERE account_id = ?1", [id])
        .map_err(|e| format!("删除 account_columns 失败: {e}"))?;
    // 6. 删除账号本身
    tx.execute("DELETE FROM accounts WHERE id = ?1", [id])
        .map_err(|e| format!("删除账号失败: {e}"))?;
    tx.commit().map_err(|e| format!("提交事务失败: {e}"))?;
    Ok(())
}

/// 项目记录（与 projects 表一一对应；前端用）。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: i64,
    pub account_id: i64,
    pub github_id: String,
    pub name: String,
    pub number_of_items: i64,
    /// "user" 或 "org"，标识该项目挂在哪类命名空间下。
    pub owner_type: String,
    pub created_at: i64,
}

/// 列出某账号下的全部项目，按 name 升序。
pub fn list_projects(conn: &Connection, account_id: i64) -> Result<Vec<Project>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, account_id, github_id, name, number_of_items, owner_type, created_at
             FROM projects WHERE account_id = ?1 ORDER BY name ASC",
        )
        .map_err(|e| format!("查询项目列表失败: {e}"))?;
    let rows = stmt
        .query_map([account_id], |r| {
            Ok(Project {
                id: r.get(0)?,
                account_id: r.get(1)?,
                github_id: r.get(2)?,
                name: r.get(3)?,
                number_of_items: r.get(4)?,
                owner_type: r.get(5)?,
                created_at: r.get(6)?,
            })
        })
        .map_err(|e| format!("遍历项目失败: {e}"))?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| format!("读取项目行失败: {e}"))?);
    }
    Ok(out)
}

/// 批量 upsert 项目（sync 时用）。已存在的按 github_id 去重，更新 name / number_of_items。
pub fn upsert_projects(
    conn: &Connection,
    account_id: i64,
    projects: &[(String, String, i64, String)], // (github_id, name, number_of_items, owner_type)
    now: i64,
) -> Result<(), String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    for (github_id, name, num_items, owner_type) in projects {
        tx.execute(
            "INSERT INTO projects (account_id, github_id, name, number_of_items, owner_type, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(account_id, github_id) DO UPDATE SET
               name = excluded.name,
               number_of_items = excluded.number_of_items,
               owner_type = excluded.owner_type",
            rusqlite::params![account_id, github_id, name, num_items, owner_type, now],
        )
        .map_err(|e| format!("upsert 项目失败: {e}"))?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// 删除某账号下不在给定 github_id 列表中的项目（清理已删除/移出的 project）。
pub fn prune_projects(
    conn: &Connection,
    account_id: i64,
    keep_ids: &[String],
) -> Result<usize, String> {
    if keep_ids.is_empty() {
        let n = conn
            .execute("DELETE FROM projects WHERE account_id = ?1", [account_id])
            .map_err(|e| format!("清空项目失败: {e}"))?;
        // #215：条目 id 一并清空（否则脏 item 指向已删项目）。
        conn.execute(
            "DELETE FROM project_items WHERE account_id = ?1",
            [account_id],
        )
        .map_err(|e| format!("清空项目条目失败: {e}"))?;
        return Ok(n);
    }
    let placeholders: String = keep_ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
    let sql = format!(
        "DELETE FROM projects WHERE account_id = ?1 AND github_id NOT IN ({})",
        placeholders
    );
    let mut params: Vec<Box<dyn rusqlite::types::ToSql>> = vec![Box::new(account_id)];
    for id in keep_ids {
        params.push(Box::new(id.clone()));
    }
    let param_refs: Vec<&dyn rusqlite::types::ToSql> = params.iter().map(|p| p.as_ref()).collect();
    let n = conn
        .execute(&sql, param_refs.as_slice())
        .map_err(|e| format!("清理项目失败: {e}"))?;
    // #215：被清掉项目的条目 id 一并删除（同条件）。
    let item_sql = format!(
        "DELETE FROM project_items WHERE account_id = ?1 AND project_github_id NOT IN ({})",
        placeholders
    );
    conn.execute(&item_sql, param_refs.as_slice())
        .map_err(|e| format!("清理项目条目失败: {e}"))?;
    Ok(n)
}

/// 项目 Status 选项（与 project_statuses 表一一对应）。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectStatus {
    pub id: i64,
    pub account_id: i64,
    pub project_github_id: String,
    pub name: String,
    pub order_index: i64,
}

/// 列出某账号下所有项目的 Status 选项，按 order_index 升序。
pub fn list_project_statuses(
    conn: &Connection,
    account_id: i64,
) -> Result<Vec<ProjectStatus>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, account_id, project_github_id, name, order_index
             FROM project_statuses WHERE account_id = ?1
             ORDER BY project_github_id, order_index ASC",
        )
        .map_err(|e| format!("查询项目状态失败: {e}"))?;
    let rows = stmt
        .query_map([account_id], |r| {
            Ok(ProjectStatus {
                id: r.get(0)?,
                account_id: r.get(1)?,
                project_github_id: r.get(2)?,
                name: r.get(3)?,
                order_index: r.get(4)?,
            })
        })
        .map_err(|e| format!("遍历项目状态失败: {e}"))?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| format!("读取项目状态行失败: {e}"))?);
    }
    Ok(out)
}

/// 列出某项目的所有 Status 选项名称（有序），用于看板列排序。
pub fn list_project_status_names(
    conn: &Connection,
    account_id: i64,
    project_github_id: &str,
) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT name FROM project_statuses
             WHERE account_id = ?1 AND project_github_id = ?2
             ORDER BY order_index ASC",
        )
        .map_err(|e| format!("查询项目状态名失败: {e}"))?;
    let rows = stmt
        .query_map(rusqlite::params![account_id, project_github_id], |r| {
            r.get(0)
        })
        .map_err(|e| format!("遍历项目状态名失败: {e}"))?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| format!("读取项目状态名失败: {e}"))?);
    }
    Ok(out)
}

/// 批量 upsert 某项目的 Status 选项（sync 时用）。已存在的按 (account_id, project_github_id, name) 去重。
pub fn upsert_project_statuses(
    conn: &Connection,
    account_id: i64,
    project_github_id: &str,
    statuses: &[(String, String, i64)], // (name, option_id, order_index)
    _now: i64,
) -> Result<(), String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    for (name, option_id, order_idx) in statuses {
        tx.execute(
            "INSERT INTO project_statuses (account_id, project_github_id, name, order_index, option_id)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(account_id, project_github_id, name) DO UPDATE SET
               order_index = excluded.order_index,
               option_id = excluded.option_id",
            rusqlite::params![account_id, project_github_id, name, order_idx, option_id],
        )
        .map_err(|e| format!("upsert 项目状态失败: {e}"))?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// #215：记录某项目的 Status 字段 id（写回 mutation 用）。
pub fn set_project_status_field(
    conn: &Connection,
    account_id: i64,
    project_github_id: &str,
    field_id: &str,
) -> Result<(), String> {
    conn.execute(
        "UPDATE projects SET status_field_id = ?1 WHERE account_id = ?2 AND github_id = ?3",
        rusqlite::params![field_id, account_id, project_github_id],
    )
    .map_err(|e| format!("写入项目字段 id 失败: {e}"))?;
    Ok(())
}

/// #215：全量替换某项目下的 issue→item 映射（每轮同步一次）。
pub fn replace_project_items(
    conn: &Connection,
    account_id: i64,
    project_github_id: &str,
    items: &[(String, String)], // (issue_key, item_id)
) -> Result<(), String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    tx.execute(
        "DELETE FROM project_items WHERE account_id = ?1 AND project_github_id = ?2",
        rusqlite::params![account_id, project_github_id],
    )
    .map_err(|e| format!("清理项目条目失败: {e}"))?;
    for (issue_key, item_id) in items {
        tx.execute(
            "INSERT INTO project_items (account_id, project_github_id, issue_key, item_id)
             VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![account_id, project_github_id, issue_key, item_id],
        )
        .map_err(|e| format!("写入项目条目失败: {e}"))?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// #215 写回目标：选定 project 的三件套。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectWriteTarget {
    pub project_github_id: String,
    pub project_name: String,
    pub item_id: String,
    pub field_id: String,
}

/// #215：解析某任务的写回目标。多项目含该 issue 时选条目数最多的主项目
/// （与 App 取主项目列逻辑一致）。任一 ID 缺失即报错（需等下轮同步补齐）。
pub fn resolve_project_write_target(
    conn: &Connection,
    account_id: i64,
    issue_key: &str,
) -> Result<ProjectWriteTarget, String> {
    let row: Option<(String, String, String, String)> = match conn.query_row(
        "SELECT pi.project_github_id, p.name, pi.item_id, p.status_field_id
             FROM project_items pi
             JOIN projects p ON p.account_id = pi.account_id AND p.github_id = pi.project_github_id
             WHERE pi.account_id = ?1 AND pi.issue_key = ?2
             ORDER BY p.number_of_items DESC LIMIT 1",
        rusqlite::params![account_id, issue_key],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
    ) {
        Ok(v) => Some(v),
        // #328：只把「查不到行」映射为 None。其余错误（no such table / 类型不符 / IO）
        // 必须带原文上抛——原来的 `.map(Some).unwrap_or(None)` 会把真实 schema 故障
        // 折叠成「不在任何 Project 中（或同步尚未拉取条目 id）」，把排障引向无效的「再同步一次」。
        Err(rusqlite::Error::QueryReturnedNoRows) => None,
        Err(e) => return Err(format!("查询任务 {issue_key} 的写回目标失败: {e}")),
    };
    match row {
        None => Err(format!(
            "任务 {issue_key} 不在任何 Project 中（或同步尚未拉取条目 id），无法写回状态"
        )),
        Some((_gid, name, item_id, field_id)) if item_id.is_empty() || field_id.is_empty() => Err(
            format!("任务 {issue_key} 在项目「{name}」中的写回 ID 不完整，请先同步一次补齐"),
        ),
        Some((gid, name, item_id, field_id)) => Ok(ProjectWriteTarget {
            project_github_id: gid,
            project_name: name,
            item_id,
            field_id,
        }),
    }
}

/// #215：按选项名查 option_id（大小写敏感，须与 GitHub 完全一致）。
pub fn project_option_id(
    conn: &Connection,
    account_id: i64,
    project_github_id: &str,
    name: &str,
) -> Result<String, String> {
    // #328：同 `resolve_project_write_target`——只把「查不到行」当「没有该选项」，
    // 其余 DB 错误上抛，避免把 `no such table` 之类报成「选项名不存在」。
    let id: Option<String> = match conn.query_row(
        "SELECT option_id FROM project_statuses
             WHERE account_id = ?1 AND project_github_id = ?2 AND name = ?3",
        rusqlite::params![account_id, project_github_id, name],
        |r| r.get(0),
    ) {
        Ok(v) => Some(v),
        Err(rusqlite::Error::QueryReturnedNoRows) => None,
        Err(e) => {
            return Err(format!(
                "查询项目 {project_github_id} 的状态选项「{name}」失败: {e}"
            ))
        }
    };
    match id {
        Some(s) if !s.is_empty() => Ok(s),
        _ => {
            let names: Vec<String> = conn
                .prepare(
                    "SELECT name FROM project_statuses WHERE account_id = ?1 AND project_github_id = ?2 ORDER BY order_index",
                )
                .and_then(|mut st| {
                    st.query_map(rusqlite::params![account_id, project_github_id], |r| r.get(0))
                        .map(|rows| rows.filter_map(|r| r.ok()).collect())
                })
                .unwrap_or_default();
            Err(format!(
                "Project 无状态“{name}”（可选：{}；同步尚未拉取选项 id 时也会如此）",
                names.join("、")
            ))
        }
    }
}

/// 清空某账号下所有项目的 Status 选项（sync 前调用）。
pub fn clear_project_statuses(conn: &Connection, account_id: i64) -> Result<usize, String> {
    let n = conn
        .execute(
            "DELETE FROM project_statuses WHERE account_id = ?1",
            [account_id],
        )
        .map_err(|e| format!("清空项目状态失败: {e}"))?;
    Ok(n)
}

pub fn init(app: &AppHandle) -> Result<Connection, String> {
    open_db(&db_path(app)?)
}

pub fn get_setting(conn: &Connection, key: &str) -> String {
    conn.query_row("SELECT value FROM meta WHERE key = ?1", [key], |r| r.get(0))
        .unwrap_or_default()
}

pub fn set_setting(conn: &Connection, key: &str, value: &str) -> Result<(), String> {
    conn.execute(
        "INSERT INTO meta (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        rusqlite::params![key, value],
    )
    .map_err(|e| format!("保存设置失败: {}", e))?;
    Ok(())
}

/// Label 映射记录（前端用）。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LabelMapping {
    pub id: i64,
    pub org: String,
    pub repo: String,
    pub label: String,
    pub status: String,
    pub order_index: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

/// Label 映射插入/更新参数。
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LabelMappingInput {
    pub org: String,
    pub repo: String,
    pub label: String,
    pub status: String,
    pub order_index: i64,
}

/// 列出全部 label 映射，按 order_index 排序。
pub fn list_label_mappings(conn: &Connection) -> Result<Vec<LabelMapping>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, org, repo, label, status, order_index, created_at, updated_at
             FROM label_mappings ORDER BY order_index, org, repo, label",
        )
        .map_err(|e| format!("查询 label 映射失败: {}", e))?;
    let rows = stmt
        .query_map([], |r| {
            Ok(LabelMapping {
                id: r.get(0)?,
                org: r.get(1)?,
                repo: r.get(2)?,
                label: r.get(3)?,
                status: r.get(4)?,
                order_index: r.get(5)?,
                created_at: r.get(6)?,
                updated_at: r.get(7)?,
            })
        })
        .map_err(|e| format!("遍历 label 映射失败: {}", e))?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| format!("读取 label 映射行失败: {}", e))?);
    }
    Ok(out)
}

/// 插入或更新一条 label 映射（upsert）。
/// repo 为空字符串表示 org 级映射；非空表示 repo 级映射（优先级更高）。
pub fn upsert_label_mapping(conn: &Connection, input: &LabelMappingInput) -> Result<i64, String> {
    let org = input.org.trim();
    let repo = input.repo.trim();
    let label = input.label.trim();
    let status = input.status.trim();
    let order_index = input.order_index;
    if org.is_empty() {
        return Err("org 不能为空".to_string());
    }
    if label.is_empty() {
        return Err("label 不能为空".to_string());
    }
    // 校验 status 是否合法四态之一
    let valid_status = ["todo", "doing", "processed", "done"];
    if !valid_status.contains(&status) {
        return Err(format!(
            "非法 status: {status}，必须为 todo/doing/processed/done 之一"
        ));
    }
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    // 先尝试更新
    let n = conn
        .execute(
            "UPDATE label_mappings SET status = ?1, order_index = ?2, updated_at = ?3 WHERE org = ?4 AND repo = ?5 AND label = ?6",
            rusqlite::params![status, order_index, now, org, repo, label],
        )
        .map_err(|e| format!("更新 label 映射失败: {e}"))?;
    if n > 0 {
        // 更新成功，返回 id
        let id: i64 = conn
            .query_row(
                "SELECT id FROM label_mappings WHERE org = ?1 AND repo = ?2 AND label = ?3",
                rusqlite::params![org, repo, label],
                |r| r.get(0),
            )
            .map_err(|e| format!("查询更新后 id 失败: {e}"))?;
        return Ok(id);
    }
    // 不存在则插入
    conn.execute(
        "INSERT INTO label_mappings (org, repo, label, status, order_index, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
        rusqlite::params![org, repo, label, status, order_index, now],
    )
    .map_err(|e| format!("插入 label 映射失败: {e}"))?;
    let id: i64 = conn
        .query_row("SELECT last_insert_rowid()", [], |r| r.get(0))
        .unwrap_or(0);
    Ok(id)
}

/// 删除一条 label 映射。
pub fn delete_label_mapping(conn: &Connection, id: i64) -> Result<(), String> {
    let n = conn
        .execute("DELETE FROM label_mappings WHERE id = ?1", [id])
        .map_err(|e| format!("删除 label 映射失败: {e}"))?;
    if n == 0 {
        return Err(format!("label 映射 #{id} 不存在"));
    }
    Ok(())
}

/// 根据 org/repo/labels 解析状态（优先级：repo 映射 > org 映射 > 全局默认 > 兜底 state）。
/// labels 为逗号分隔的字符串。
///
/// v0.3.49 (#144)：逻辑已下沉到纯内存的 [`resolve_status_from_rules`]，
/// 本函数仅做一次全量加载后委托（调用方应优先用预加载版本，避免任务循环内 N+1 查询）。
pub fn resolve_status_from_labels(
    conn: &Connection,
    org: &str,
    repo: &str,
    labels_csv: &str,
    fallback_state: &str,
) -> String {
    match load_label_rules(conn) {
        Ok(rules) => resolve_status_from_rules(&rules, org, repo, labels_csv, fallback_state),
        Err(_) => fallback_state_from_gh_state(fallback_state),
    }
}

/// 为 Label 列视图获取某账号的列配置：返回该账号 org 下的 label 映射（按 order_index 排序）。
/// 用于前端动态生成列：每个 label 对应一列，未命中 label 的任务归入「未标记」列。
pub fn get_label_columns_for_account(
    conn: &Connection,
    account_id: i64,
) -> Result<Vec<LabelMapping>, String> {
    // 先获取账号的 org
    let org: String = conn
        .query_row(
            "SELECT org FROM accounts WHERE id = ?1",
            [account_id],
            |r| r.get(0),
        )
        .map_err(|e| format!("获取账号 org 失败: {e}"))?;

    // 查询该 org 下的所有 label 映射（按 order_index 排序）
    let mut stmt = conn
        .prepare(
            "SELECT id, org, repo, label, status, order_index, created_at, updated_at
             FROM label_mappings WHERE org = ?1 ORDER BY order_index, label",
        )
        .map_err(|e| format!("查询 label 列配置失败: {}", e))?;
    let rows = stmt
        .query_map([org], |r| {
            Ok(LabelMapping {
                id: r.get(0)?,
                org: r.get(1)?,
                repo: r.get(2)?,
                label: r.get(3)?,
                status: r.get(4)?,
                order_index: r.get(5)?,
                created_at: r.get(6)?,
                updated_at: r.get(7)?,
            })
        })
        .map_err(|e| format!("遍历 label 列配置失败: {}", e))?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| format!("读取 label 列配置行失败: {}", e))?);
    }
    Ok(out)
}

/// GitHub state (open/closed) -> 看板四态兜底。
///
/// #335：判据走 `common::is_closed_state`（大小写不敏感）。REST 给小写 `closed`，
/// GraphQL 给大写 `CLOSED`，写死小写会漏判后者。
fn fallback_state_from_gh_state(gh_state: &str) -> String {
    if crate::common::is_closed_state(gh_state) {
        "done".to_string()
    } else {
        "todo".to_string() // open 默认待处理，实际同步时会被 Project Status 覆盖
    }
}

// ============================================================================
// v0.3.49 (#144)：同步热路径预加载 — 任务循环外一次加载、循环内 O(1) 查。
// 语义与逐条查询版本完全一致（repo 级 > org 级；列按 order_index 先命中者胜）。
// ============================================================================

/// 预加载的 label 映射规则（`label_mappings` 全量快照）。
#[derive(Debug, Clone)]
pub struct LabelRule {
    pub org: String,
    pub repo: String,
    pub label: String,
    pub status: String,
}

/// 一次加载全部 label 映射规则（同步任务循环外调用一次）。
pub fn load_label_rules(conn: &Connection) -> Result<Vec<LabelRule>, String> {
    let mut stmt = conn
        .prepare("SELECT org, repo, label, status FROM label_mappings")
        .map_err(|e| format!("预加载 label 映射失败: {e}"))?;
    let rows = stmt
        .query_map([], |r| {
            Ok(LabelRule {
                org: r.get(0)?,
                repo: r.get(1)?,
                label: r.get(2)?,
                status: r.get(3)?,
            })
        })
        .map_err(|e| format!("遍历 label 映射失败: {e}"))?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| format!("读取 label 映射行失败: {e}"))?);
    }
    Ok(out)
}

/// 纯内存解析 label → 状态。优先级与旧逐条查询版本一致：
/// 先按 labels 出现顺序查 repo 级（org+repo+label），再按同样顺序查 org 级（repo=''）。
pub fn resolve_status_from_rules(
    rules: &[LabelRule],
    org: &str,
    repo: &str,
    labels_csv: &str,
    fallback_state: &str,
) -> String {
    resolve_status_from_rules_explicit(rules, org, repo, labels_csv)
        .unwrap_or_else(|| fallback_state_from_gh_state(fallback_state))
}

/// 仅显式 label 映射命中时返回 `Some(status)`（含 `todo`），无命中返回 `None`。
/// #192：调用方（同步状态机）需区分「显式映射到 todo」与「state 兜底的 todo」——
/// 前者按 AGENTS.md §2.2 优先级 #2 优先于 gh_status，后者才让位。
pub fn resolve_status_from_rules_explicit(
    rules: &[LabelRule],
    org: &str,
    repo: &str,
    labels_csv: &str,
) -> Option<String> {
    let labels: Vec<&str> = labels_csv
        .split(',')
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .collect();
    if labels.is_empty() {
        return None;
    }
    for label in &labels {
        if let Some(rule) = rules
            .iter()
            .find(|r| r.org == org && r.repo == repo && r.label == *label)
        {
            return Some(rule.status.clone());
        }
    }
    for label in &labels {
        if let Some(rule) = rules
            .iter()
            .find(|r| r.org == org && r.repo.is_empty() && r.label == *label)
        {
            return Some(rule.status.clone());
        }
    }
    None
}

/// 预加载的自定义列规则（`match_rules` JSON 已解析一次，顺序即 order_index 升序）。
#[derive(Debug, Clone)]
pub struct ColumnRule {
    pub col_key: String,
    pub rules: Vec<String>,
}

/// 一次加载某账号的自定义列规则（`match_rules` 解析一次；非法 JSON 的列跳过）。
pub fn load_column_rules(conn: &Connection, account_id: i64) -> Result<Vec<ColumnRule>, String> {
    let columns = list_account_columns(conn, account_id)?;
    let mut out = Vec::new();
    for col in &columns {
        match serde_json::from_str::<Vec<String>>(&col.match_rules) {
            Ok(rules) => out.push(ColumnRule {
                col_key: col.col_key.clone(),
                rules,
            }),
            Err(e) => {
                if crate::common::verbose_enabled() {
                    crate::tlog!(
                        "[db] 自定义列 {} 的 match_rules 非法，已跳过: {}",
                        col.col_key,
                        e
                    );
                }
            }
        }
    }
    Ok(out)
}

/// 纯内存解析 gh_status → 列 key（首个命中的列胜出，与旧循环顺序一致）。
pub fn resolve_column_from_rules(rules: &[ColumnRule], gh_status: &str) -> Option<String> {
    if gh_status.is_empty() {
        return None;
    }
    for col in rules {
        if col.rules.iter().any(|r| r == gh_status) {
            return Some(col.col_key.clone());
        }
    }
    None
}

/// 同步循环外一次加载的既有任务快照（同一 `account_id`）。
#[derive(Debug, Clone, Default)]
pub struct ExistingTask {
    pub status: String,
    pub comments: i64,
    pub mentioned: i64,
    pub pr_number: i64,
    pub pr_url: String,
    pub comment_url: String,
    pub branch: String,
    /// #278：既有父子关系（关系拉取失败时保留，避免误清空）。
    pub parent_issue: String,
    pub sub_issues: String,
}

/// 一次加载某账号下全部任务的既有快照，key 为 `repo#number`。
pub fn load_existing_tasks(
    conn: &Connection,
    account_id: i64,
) -> Result<HashMap<String, ExistingTask>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT issue_key, status, comments_count, mentioned, pr_number, pr_url,
                    latest_comment_url, branch, parent_issue, sub_issues
             FROM tasks WHERE account_id = ?1",
        )
        .map_err(|e| format!("预加载既有任务失败: {e}"))?;
    let rows = stmt
        .query_map([account_id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                ExistingTask {
                    status: r.get(1)?,
                    comments: r.get(2)?,
                    mentioned: r.get(3)?,
                    pr_number: r.get(4)?,
                    pr_url: r.get(5)?,
                    comment_url: r.get(6)?,
                    branch: r.get(7)?,
                    parent_issue: r.get(8)?,
                    sub_issues: r.get(9)?,
                },
            ))
        })
        .map_err(|e| format!("遍历既有任务失败: {e}"))?;
    let mut out = HashMap::new();
    for r in rows {
        let (k, v) = r.map_err(|e| format!("读取既有任务行失败: {e}"))?;
        out.insert(k, v);
    }
    Ok(out)
}

/// 一条待写入 `tasks` 的行内容。
///
/// v0.4.1 (#250)：由 `sync.rs` 内联的 `PendingUpsert` 抽出，供**同步**与
/// **按需拉取单个 issue** 复用同一份列清单/参数绑定——避免第二份实现分叉
/// （#147 的教训正是「两边各写一遍，逻辑已分叉」）。
///
/// `owner` / `account_id` 属于行的归属，随结构一起携带：同步时是全量拉取的目标账号，
/// 按需拉取时是按 ref 的 owner（匹配 `accounts.org`）或默认账号选出的账号。
#[derive(Debug, Clone, Default)]
pub struct TaskUpsert {
    /// 稳定业务引用，值 = `repo#number`。
    pub issue_key: String,
    /// 归属账号的 `org`（写入 `tasks.owner`）。
    pub owner: String,
    /// 归属账号 id（`tasks.account_id`，与 `(repo, number)` 共同构成唯一键）。
    pub account_id: i64,
    pub repo: String,
    pub number: i64,
    pub title: String,
    pub url: String,
    pub issue_state: String,
    pub ownership: String,
    pub status: String,
    pub project_status: String,
    pub assignees: String,
    pub labels: String,
    /// #237：issue 创建人（GitHub author login，不含 @）。
    pub author: String,
    pub done_at: i64,
    pub mentioned: i64,
    pub comments_count: i64,
    pub latest_comment_url: String,
    pub pr_number: i64,
    pub pr_url: String,
    pub branch: String,
    /// #278：父 issue（JSON 对象串 `{"number","title","url"}`），无父为空串。
    pub parent_issue: String,
    /// #278：子 issue 列表（JSON 数组串），无子为空串。
    pub sub_issues: String,
    /// #280：issue 创建时间（秒级时间戳，0 表示未知）。
    pub created_at: i64,
    pub updated_at: i64,
    /// 调用方据此统计「新增 / 更新」，**不参与 SQL**。
    pub exists: bool,
}

/// `tasks` 插入的列清单与值占位符。
///
/// 两种写入模式共用本常量做前缀，**列清单只有这一份**——新增/改名列时不可能只改一边。
/// 占位符编号：`?1`–`?19` 为行内容，`?20` 为 `updated_at`，`?21` 为 `synced_at`(now)，
/// `?22` 为 `account_id`，`?23` 为 `author`，`?24`/`?25` 为 #278 的父子关系两列。
const TASK_INSERT_HEAD: &str = "INSERT INTO tasks
   (issue_key, owner, repo, number, title, url, issue_state, ownership,
    status, project_status, assignees, labels, done_at, mentioned, comments_count,
    latest_comment_url, pr_number, pr_url, branch, candidate_done, stale, updated_at, synced_at,
    account_id, author, parent_issue, sub_issues, created_at)
  VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, 0, 0, ?20, ?21, ?22, ?23, ?24, ?25, ?26)";

/// 冲突时**覆盖**：同步路径用（该账号的数据是刚拉取的权威值）。
const TASK_CONFLICT_UPDATE: &str = "ON CONFLICT(repo, number, account_id) DO UPDATE SET
    title = excluded.title,
    repo = excluded.repo,
    issue_state = excluded.issue_state,
    ownership = excluded.ownership,
    updated_at = excluded.updated_at,
    synced_at = excluded.synced_at,
    candidate_done = 0,
    stale = 0,
    project_status = excluded.project_status,
    assignees = excluded.assignees,
    labels = excluded.labels,
    status = excluded.status,
    done_at = CASE
      WHEN excluded.status = 'done' AND done_at = 0 THEN ?20
      WHEN excluded.status <> 'done' THEN 0
      ELSE done_at
    END,
    mentioned = excluded.mentioned,
    comments_count = excluded.comments_count,
    latest_comment_url = excluded.latest_comment_url,
    pr_number = excluded.pr_number,
    pr_url = excluded.pr_url,
    branch = excluded.branch,
    account_id = excluded.account_id,
    author = excluded.author,
    parent_issue = excluded.parent_issue,
    sub_issues = excluded.sub_issues,
    created_at = excluded.created_at";

/// 冲突时**不动**：按需拉取路径用。
///
/// 按需拉取只有单个 issue 的 REST 数据，`project_status`（需 GraphQL）、`mentioned`、
/// `pr_number` 等字段拿不到；若以覆盖模式写入，会把同步刚写好的这些值清空。
/// 用 `DO NOTHING` 则「行已存在」时零副作用，天然幂等。
const TASK_CONFLICT_NOTHING: &str = "ON CONFLICT(repo, number, account_id) DO NOTHING";

/// 写入模式，见 [`write_task`]。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskWriteMode {
    /// 冲突则覆盖（同步路径）。
    Upsert,
    /// 冲突则不动（按需拉取路径；绝不覆盖既有行）。
    InsertIfAbsent,
}

/// 幂等写入一条任务行。唯一键为 `(repo, number, account_id)`。
///
/// `now` 用于 `synced_at`，以及 `done_at` 的补写（`done` 且原值为 0 时）。
/// 返回 SQLite 报告的影响行数：`InsertIfAbsent` 模式下 **0 表示该行已存在**
/// （调用方据此判断「无需新写」）。
pub fn write_task(
    conn: &Connection,
    t: &TaskUpsert,
    now: i64,
    mode: TaskWriteMode,
) -> Result<usize, String> {
    let conflict = match mode {
        TaskWriteMode::Upsert => TASK_CONFLICT_UPDATE,
        TaskWriteMode::InsertIfAbsent => TASK_CONFLICT_NOTHING,
    };
    let sql = format!("{TASK_INSERT_HEAD}\n  {conflict}");
    conn.execute(
        &sql,
        rusqlite::params![
            t.issue_key,
            t.owner,
            t.repo,
            t.number,
            t.title,
            t.url,
            t.issue_state,
            t.ownership,
            t.status,
            t.project_status,
            t.assignees,
            t.labels,
            t.done_at,
            t.mentioned,
            t.comments_count,
            t.latest_comment_url,
            t.pr_number,
            t.pr_url,
            t.branch,
            t.updated_at,
            now,
            t.account_id,
            t.author,
            t.parent_issue,
            t.sub_issues,
            t.created_at,
        ],
    )
    .map_err(|e| format!("写入任务失败: {e}"))
}

// ============================================================================
// v0.3.23+：同步日志管理
// ============================================================================

/// 同步日志记录（与 sync_logs 表一一对应；前端用）。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncLog {
    pub id: i64,
    pub account_id: i64,
    pub trigger_type: String,
    pub started_at: i64,
    pub finished_at: i64,
    pub status: String,
    pub added: i64,
    pub updated: i64,
    pub removed: i64,
    pub candidate_done: i64,
    pub pruned: i64,
    pub failed_sources: String,
    pub error_message: String,
    pub created_at: i64,
}

/// 插入一条同步日志（开始同步时调用）；返回新日志 id。
pub fn insert_sync_log(
    conn: &Connection,
    account_id: i64,
    trigger_type: &str,
    started_at: i64,
) -> Result<i64, String> {
    conn.execute(
        "INSERT INTO sync_logs (account_id, trigger_type, started_at, created_at)
         VALUES (?1, ?2, ?3, ?3)",
        rusqlite::params![account_id, trigger_type, started_at],
    )
    .map_err(|e| format!("插入同步日志失败: {e}"))?;
    let id: i64 = conn
        .query_row("SELECT last_insert_rowid()", [], |r| r.get(0))
        .unwrap_or(0);
    Ok(id)
}

/// 更新同步日志（同步完成时调用）。
#[allow(clippy::too_many_arguments)]
pub fn update_sync_log(
    conn: &Connection,
    id: i64,
    finished_at: i64,
    status: &str,
    added: i64,
    updated: i64,
    removed: i64,
    candidate_done: i64,
    pruned: i64,
    failed_sources: &str,
    error_message: &str,
) -> Result<(), String> {
    conn.execute(
        "UPDATE sync_logs SET
           finished_at = ?2, status = ?3, added = ?4, updated = ?5,
           removed = ?6, candidate_done = ?7, pruned = ?8,
           failed_sources = ?9, error_message = ?10
         WHERE id = ?1",
        rusqlite::params![
            id,
            finished_at,
            status,
            added,
            updated,
            removed,
            candidate_done,
            pruned,
            failed_sources,
            error_message
        ],
    )
    .map_err(|e| format!("更新同步日志失败: {e}"))?;
    Ok(())
}

/// 列出同步日志（最近 N 条），按 created_at 降序。
pub fn list_sync_logs(conn: &Connection, limit: i64) -> Result<Vec<SyncLog>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, account_id, trigger_type, started_at, finished_at, status,
                    added, updated, removed, candidate_done, pruned,
                    failed_sources, error_message, created_at
             FROM sync_logs ORDER BY created_at DESC LIMIT ?1",
        )
        .map_err(|e| format!("查询同步日志失败: {e}"))?;
    let rows = stmt
        .query_map([limit], |r| {
            Ok(SyncLog {
                id: r.get(0)?,
                account_id: r.get(1)?,
                trigger_type: r.get(2)?,
                started_at: r.get(3)?,
                finished_at: r.get(4)?,
                status: r.get(5)?,
                added: r.get(6)?,
                updated: r.get(7)?,
                removed: r.get(8)?,
                candidate_done: r.get(9)?,
                pruned: r.get(10)?,
                failed_sources: r.get(11)?,
                error_message: r.get(12)?,
                created_at: r.get(13)?,
            })
        })
        .map_err(|e| format!("遍历同步日志失败: {e}"))?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| format!("读取同步日志行失败: {e}"))?);
    }
    Ok(out)
}

/// 清理超过 30 天的同步日志（保留策略）。
pub fn prune_sync_logs(conn: &Connection, now: i64) -> Result<usize, String> {
    let thirty_days_secs = 30 * 24 * 60 * 60;
    let n = conn
        .execute(
            "DELETE FROM sync_logs WHERE ?1 - created_at > ?2",
            [now, thirty_days_secs],
        )
        .map_err(|e| format!("清理过期同步日志失败: {e}"))?;
    Ok(n)
}

/// 清空全部同步日志（不可恢复）。
pub fn clear_sync_logs(conn: &Connection) -> Result<usize, String> {
    let n = conn
        .execute("DELETE FROM sync_logs", [])
        .map_err(|e| format!("清空同步日志失败: {e}"))?;
    Ok(n)
}

// ============================================================================
// #235：API 调用明细（同步 / 认领 / 状态写回的请求与返回参数）
// ============================================================================

/// API 明细保留天数。明细属排障信息，短于 sync_logs 的 30 天。
pub const API_LOG_RETENTION_SECS: i64 = 7 * 24 * 60 * 60;
/// API 明细条数上限：一次同步会产生数十次调用，必须有上界。
pub const API_LOG_MAX_ROWS: i64 = 2000;

/// API 调用明细记录（与 api_logs 表一一对应；前端用）。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiLog {
    pub id: i64,
    /// `sync` | `claim` | `status`（由写库方按操作类型标注）。
    pub kind: String,
    pub account_id: i64,
    /// 关联的 sync_logs.id；独立写回操作为 0。
    pub sync_log_id: i64,
    pub method: String,
    pub target: String,
    pub status: i64,
    pub ok: bool,
    pub elapsed_ms: i64,
    pub request: String,
    pub response: String,
    pub created_at: i64,
}

/// 待落盘的一条 API 调用。由 `github.rs` 在调用处采集；
/// `kind` / `account_id` / `sync_log_id` / `created_at` 由调用方写库时统一补。
#[derive(Debug, Clone)]
pub struct ApiLogEntry {
    pub method: String,
    pub target: String,
    pub status: i64,
    pub ok: bool,
    pub elapsed_ms: i64,
    pub request: String,
    pub response: String,
}

impl ApiLogEntry {
    /// `ok` 必须显式给出：GraphQL 业务错误 HTTP 仍是 200，不能只看状态码。
    pub fn new(
        method: &str,
        target: &str,
        status: i64,
        ok: bool,
        elapsed_ms: i64,
        request: &str,
        response: &str,
    ) -> Self {
        Self {
            method: method.to_string(),
            target: target.to_string(),
            status,
            ok,
            elapsed_ms,
            request: request.to_string(),
            response: response.to_string(),
        }
    }
}

/// 批量写入 API 调用明细；`entries` 为空时直接返回 0（不开启事务）。
///
/// 仅供日志使用：失败不该影响主流程，调用方按需 `let _ =` 忽略。
pub fn insert_api_logs(
    conn: &Connection,
    kind: &str,
    account_id: i64,
    sync_log_id: i64,
    created_at: i64,
    entries: &[ApiLogEntry],
) -> Result<usize, String> {
    if entries.is_empty() {
        return Ok(0);
    }
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| format!("开启 API 日志事务失败: {e}"))?;
    {
        let mut stmt = tx
            .prepare(
                "INSERT INTO api_logs
                   (kind, account_id, sync_log_id, method, target, status, ok,
                    elapsed_ms, request, response, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            )
            .map_err(|e| format!("准备 API 日志插入失败: {e}"))?;
        for e in entries {
            stmt.execute(rusqlite::params![
                kind,
                account_id,
                sync_log_id,
                e.method,
                e.target,
                e.status,
                if e.ok { 1i64 } else { 0i64 },
                e.elapsed_ms,
                e.request,
                e.response,
                created_at
            ])
            .map_err(|e| format!("写入 API 日志失败: {e}"))?;
        }
    }
    tx.commit().map_err(|e| format!("提交 API 日志失败: {e}"))?;
    Ok(entries.len())
}

/// 列出 API 调用明细（最近 N 条），按 created_at 降序、id 降序。
pub fn list_api_logs(conn: &Connection, limit: i64) -> Result<Vec<ApiLog>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, kind, account_id, sync_log_id, method, target, status, ok,
                    elapsed_ms, request, response, created_at
             FROM api_logs ORDER BY created_at DESC, id DESC LIMIT ?1",
        )
        .map_err(|e| format!("查询 API 日志失败: {e}"))?;
    let rows = stmt
        .query_map([limit], |r| {
            Ok(ApiLog {
                id: r.get(0)?,
                kind: r.get(1)?,
                account_id: r.get(2)?,
                sync_log_id: r.get(3)?,
                method: r.get(4)?,
                target: r.get(5)?,
                status: r.get(6)?,
                ok: r.get::<_, i64>(7)? != 0,
                elapsed_ms: r.get(8)?,
                request: r.get(9)?,
                response: r.get(10)?,
                created_at: r.get(11)?,
            })
        })
        .map_err(|e| format!("遍历 API 日志失败: {e}"))?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| format!("读取 API 日志行失败: {e}"))?);
    }
    Ok(out)
}

/// 清理 API 明细：先按保留期删过期，再按条数上限裁剪最早的行，返回删除总行数。
/// `max_rows <= 0` 时跳过裁剪（仅按时间淘汰）。
pub fn prune_api_logs(conn: &Connection, now: i64, max_rows: i64) -> Result<usize, String> {
    let mut removed = conn
        .execute(
            "DELETE FROM api_logs WHERE ?1 - created_at > ?2",
            [now, API_LOG_RETENTION_SECS],
        )
        .map_err(|e| format!("清理过期 API 日志失败: {e}"))?;
    if max_rows > 0 {
        removed += conn
            .execute(
                "DELETE FROM api_logs WHERE id NOT IN (
                   SELECT id FROM api_logs ORDER BY id DESC LIMIT ?1)",
                [max_rows],
            )
            .map_err(|e| format!("裁剪 API 日志条数失败: {e}"))?;
    }
    Ok(removed)
}

/// 清空全部 API 调用明细（不可恢复）。
pub fn clear_api_logs(conn: &Connection) -> Result<usize, String> {
    let n = conn
        .execute("DELETE FROM api_logs", [])
        .map_err(|e| format!("清空 API 日志失败: {e}"))?;
    Ok(n)
}

// ── Notes ──────────────────────────────────────────────────────────────────

/// 记事本记录。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    pub id: i64,
    pub content: String,
    pub label: String,
    pub created_at: i64,
    pub updated_at: i64,
}

/// 列出所有记事，按 created_at 降序（最新的在前）。
pub fn list_notes(conn: &Connection) -> Result<Vec<Note>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, content, label, created_at, updated_at FROM notes ORDER BY created_at DESC",
        )
        .map_err(|e| format!("查询记事失败: {e}"))?;
    let rows = stmt
        .query_map([], |r| {
            Ok(Note {
                id: r.get(0)?,
                content: r.get(1)?,
                label: r.get(2)?,
                created_at: r.get(3)?,
                updated_at: r.get(4)?,
            })
        })
        .map_err(|e| format!("遍历记事失败: {e}"))?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| format!("读取记事行失败: {e}"))?);
    }
    Ok(out)
}

/// #327：判断是否为 UNIQUE 约束冲突（`SQLITE_CONSTRAINT_UNIQUE` = 2067）。
///
/// `notes.content` 上有唯一索引 `idx_notes_content`，重复内容会让 `INSERT`/`UPDATE`
/// 抛出原始的 `UNIQUE constraint failed: notes.content`。用它把原始 SQLite 文案
/// 换成用户可读的提示，避免直接暴露到 UI / MCP 返回体。
fn is_unique_violation(e: &rusqlite::Error) -> bool {
    const SQLITE_CONSTRAINT_UNIQUE: i32 = 2067;
    matches!(
        e,
        rusqlite::Error::SqliteFailure(err, _) if err.extended_code == SQLITE_CONSTRAINT_UNIQUE
    )
}

/// 新增记事，返回新记录。
pub fn add_note(conn: &Connection, content: &str, label: &str, now: i64) -> Result<Note, String> {
    conn.execute(
        "INSERT INTO notes (content, label, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)",
        rusqlite::params![content, label, now],
    )
    .map_err(|e| {
        if is_unique_violation(&e) {
            "已存在相同内容的记事，未重复添加".to_string()
        } else {
            format!("插入记事失败: {e}")
        }
    })?;
    let id: i64 = conn
        .query_row("SELECT last_insert_rowid()", [], |r| r.get(0))
        .unwrap_or(0);
    Ok(Note {
        id,
        content: content.to_string(),
        label: label.to_string(),
        created_at: now,
        updated_at: now,
    })
}

/// 更新记事内容，返回更新后的记录。
pub fn update_note(conn: &Connection, id: i64, content: &str, now: i64) -> Result<Note, String> {
    let n = conn
        .execute(
            "UPDATE notes SET content = ?1, updated_at = ?2 WHERE id = ?3",
            rusqlite::params![content, now, id],
        )
        .map_err(|e| {
            if is_unique_violation(&e) {
                "已存在相同内容的记事，未保存".to_string()
            } else {
                format!("更新记事失败: {e}")
            }
        })?;
    if n == 0 {
        return Err(format!("记事 #{id} 不存在"));
    }
    conn.query_row(
        "SELECT id, content, label, created_at, updated_at FROM notes WHERE id = ?1",
        [id],
        |r| {
            Ok(Note {
                id: r.get(0)?,
                content: r.get(1)?,
                label: r.get(2)?,
                created_at: r.get(3)?,
                updated_at: r.get(4)?,
            })
        },
    )
    .map_err(|e| format!("读取更新后记事失败: {e}"))
}

/// 更新记事标签，返回更新后的记录。
pub fn update_note_label(conn: &Connection, id: i64, label: &str) -> Result<Note, String> {
    let n = conn
        .execute(
            "UPDATE notes SET label = ?1 WHERE id = ?2",
            rusqlite::params![label, id],
        )
        .map_err(|e| format!("更新记事标签失败: {e}"))?;
    if n == 0 {
        return Err(format!("记事 #{id} 不存在"));
    }
    conn.query_row(
        "SELECT id, content, label, created_at, updated_at FROM notes WHERE id = ?1",
        [id],
        |r| {
            Ok(Note {
                id: r.get(0)?,
                content: r.get(1)?,
                label: r.get(2)?,
                created_at: r.get(3)?,
                updated_at: r.get(4)?,
            })
        },
    )
    .map_err(|e| format!("读取更新后记事失败: {e}"))
}

/// 删除记事。
pub fn delete_note(conn: &Connection, id: i64) -> Result<(), String> {
    let n = conn
        .execute("DELETE FROM notes WHERE id = ?1", [id])
        .map_err(|e| format!("删除记事失败: {e}"))?;
    if n == 0 {
        return Err(format!("记事 #{id} 不存在"));
    }
    Ok(())
}

// ============================================================================
// v0.3.28+：自定义列映射（按账号配置看板列）
// ============================================================================

/// 自定义列记录（与 account_columns 表一一对应；前端用）。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountColumn {
    pub id: i64,
    pub account_id: i64,
    pub col_key: String,
    pub col_name: String,
    /// JSON 数组，每个元素是一个 gh_status 匹配值，如 `["待开发","需求","规划"]`
    pub match_rules: String,
    pub order_index: i64,
}

/// 列出某账号下所有自定义列，按 order_index 升序。
pub fn list_account_columns(
    conn: &Connection,
    account_id: i64,
) -> Result<Vec<AccountColumn>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, account_id, col_key, col_name, match_rules, order_index
             FROM account_columns WHERE account_id = ?1
             ORDER BY order_index ASC",
        )
        .map_err(|e| format!("查询自定义列失败: {}", e))?;
    let rows = stmt
        .query_map([account_id], |r| {
            Ok(AccountColumn {
                id: r.get(0)?,
                account_id: r.get(1)?,
                col_key: r.get(2)?,
                col_name: r.get(3)?,
                match_rules: r.get(4)?,
                order_index: r.get(5)?,
            })
        })
        .map_err(|e| format!("遍历自定义列失败: {}", e))?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| format!("读取自定义列行失败: {}", e))?);
    }
    Ok(out)
}

/// 保存某账号的列配置（全量替换：先删后插，原子事务）。
/// `columns` 为待保存的列列表，order_index 由调用方决定。
/// 若列配置非空，自动将账号的 boardMode 设为 "custom"（确保同步时启用列映射）。
pub fn save_account_columns(
    conn: &Connection,
    account_id: i64,
    columns: &[AccountColumn],
) -> Result<(), String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    // 先删旧配置
    tx.execute(
        "DELETE FROM account_columns WHERE account_id = ?1",
        [account_id],
    )
    .map_err(|e| format!("清空旧列配置失败: {e}"))?;
    // 再插入新配置
    for col in columns {
        let match_rules = if col.match_rules.is_empty() {
            "[]"
        } else {
            &col.match_rules
        };
        tx.execute(
            "INSERT INTO account_columns (account_id, col_key, col_name, match_rules, order_index)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![
                account_id,
                col.col_key,
                col.col_name,
                match_rules,
                col.order_index
            ],
        )
        .map_err(|e| format!("插入列配置失败: {e}"))?;
    }
    // v0.3.48+: 有列配置时自动启用 custom 模式（同步时才会写入 col_key）
    if !columns.is_empty() {
        let current = get_account_board_mode(&tx, account_id);
        if current != "custom" {
            set_account_board_mode(&tx, account_id, "custom")
                .map_err(|e| format!("设置自定义列模式失败: {e}"))?;
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// 根据账号的列映射规则，解析 gh_status 对应的列 key。
/// 遍历所有列，逐一检查 match_rules JSON 数组是否包含该 gh_status。
/// 若命中，返回该列的 col_key；否则返回 None（由 sync 回退到默认逻辑）。
///
/// v0.3.49 (#144)：逻辑已下沉到纯内存的 [`resolve_column_from_rules`]，
/// 本函数仅做一次加载后委托（调用方应优先用预加载版本）。
pub fn resolve_column_from_gh_status(
    conn: &Connection,
    account_id: i64,
    gh_status: &str,
) -> Option<String> {
    let rules = load_column_rules(conn, account_id).ok()?;
    resolve_column_from_rules(&rules, gh_status)
}

/// v0.3.27+：导入记事。按内容 `content` 去重，已存在则跳过；保留导入文件的
/// 创建/更新时间。返回是否真正插入（`true`=新插入，`false`=重复跳过）。
pub fn import_note(
    conn: &Connection,
    content: &str,
    label: &str,
    created_at: i64,
    updated_at: i64,
) -> Result<bool, String> {
    let exists: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM notes WHERE content = ?1)",
            [content],
            |r| r.get(0),
        )
        .map_err(|e| format!("查重记事失败: {e}"))?;
    if exists {
        return Ok(false);
    }
    conn.execute(
        "INSERT INTO notes (content, label, created_at, updated_at) VALUES (?1, ?2, ?3, ?4)",
        rusqlite::params![content, label, created_at, updated_at],
    )
    .map_err(|e| format!("导入记事失败: {e}"))?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_db(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "taskboard_db_test_{}_{}",
            name,
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("taskboard.db")
    }

    /// #327：重复内容的记事应返回可读提示，而不是原始的 UNIQUE 约束报错。
    #[test]
    fn note_unique_content_conflict_is_readable() {
        let path = tmp_db("note-unique");
        let conn = open_db(&path).unwrap();
        let now = 1_700_000_000;

        add_note(&conn, "同一条内容", "", now).unwrap();
        let dup = add_note(&conn, "同一条内容", "另一个标签", now).unwrap_err();
        assert!(
            !dup.contains("UNIQUE constraint failed"),
            "不应暴露原始 SQLite 文案: {dup}"
        );
        assert!(dup.contains("已存在相同内容"), "应给出可读提示: {dup}");

        // 编辑成与另一条内容相同，同样给可读提示
        let second = add_note(&conn, "第二条", "", now).unwrap();
        let upd = update_note(&conn, second.id, "同一条内容", now).unwrap_err();
        assert!(
            !upd.contains("UNIQUE constraint failed"),
            "不应暴露原始 SQLite 文案: {upd}"
        );
        assert!(upd.contains("已存在相同内容"), "应给出可读提示: {upd}");
    }

    /// #215：写回三件套落库与解析（主项目优先、缺 ID 报错、选项名查 id）。
    #[test]
    fn project_write_target_resolves_main_project() {
        let path = tmp_db("write-target");
        let conn = open_db(&path).unwrap();
        // 新库 schema 自带新列/新表。
        for (table, col) in [
            ("projects", "status_field_id"),
            ("project_statuses", "option_id"),
        ] {
            let n: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM pragma_table_info(?) WHERE name = ?2",
                    rusqlite::params![table, col],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(n, 1, "{table}.{col} 应存在");
        }
        // 两个项目都含该 issue：条目数多的为主项目。
        upsert_projects(
            &conn,
            1,
            &[
                (
                    "PVT_small".to_string(),
                    "小".to_string(),
                    3,
                    "org".to_string(),
                ),
                (
                    "PVT_big".to_string(),
                    "大".to_string(),
                    9,
                    "org".to_string(),
                ),
            ],
            1,
        )
        .unwrap();
        set_project_status_field(&conn, 1, "PVT_small", "F1").unwrap();
        set_project_status_field(&conn, 1, "PVT_big", "F2").unwrap();
        upsert_project_statuses(
            &conn,
            1,
            "PVT_big",
            &[("开发中".to_string(), "O1".to_string(), 0)],
            1,
        )
        .unwrap();
        replace_project_items(
            &conn,
            1,
            "PVT_small",
            &[("r#1".to_string(), "I-small".to_string())],
        )
        .unwrap();
        replace_project_items(
            &conn,
            1,
            "PVT_big",
            &[("r#1".to_string(), "I-big".to_string())],
        )
        .unwrap();
        let t = resolve_project_write_target(&conn, 1, "r#1").unwrap();
        assert_eq!(
            t,
            ProjectWriteTarget {
                project_github_id: "PVT_big".to_string(),
                project_name: "大".to_string(),
                item_id: "I-big".to_string(),
                field_id: "F2".to_string(),
            }
        );
        assert_eq!(
            project_option_id(&conn, 1, "PVT_big", "开发中").unwrap(),
            "O1"
        );
        // 未知选项报错并列出可选；不在项目中的 issue 报错。
        assert!(project_option_id(&conn, 1, "PVT_big", "不存在").is_err());
        assert!(resolve_project_write_target(&conn, 1, "r#9").is_err());
        // 替换语义：二次 replace 覆盖旧条目。
        replace_project_items(&conn, 1, "PVT_big", &[]).unwrap();
        let t2 = resolve_project_write_target(&conn, 1, "r#1").unwrap();
        assert_eq!(t2.project_github_id, "PVT_small");
        drop(conn);
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    /// #146：热查询索引必须存在（新库建出、老库幂等补齐）。
    #[test]
    fn perf_indexes_exist_after_open() {
        let path = tmp_db("indexes");
        let conn = open_db(&path).unwrap();
        for idx in [
            "idx_label_mappings_org_repo_label",
            "idx_tasks_board",
            "idx_tasks_status_done_at",
            "idx_notes_content",
            // #329：这两条不在 `SCHEMA` 顶层（老库无 issue_key / project_items 时有风险），
            // 必须由迁移路径建出。
            "idx_tasks_issue_key",
            "idx_project_items_issue",
        ] {
            let n: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = ?1",
                    [idx],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(n, 1, "索引 {idx} 应存在");
        }
        // 幂等：重复 open 不报错。
        drop(conn);
        let _ = open_db(&path).unwrap();
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    /// #149：库文件含 PAT 明文，Unix 下 open 后应为 0600。
    #[cfg(unix)]
    #[test]
    fn db_file_permissions_are_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let path = tmp_db("perms");
        let _ = open_db(&path).unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "库文件应为 0600，实际 {mode:o}");
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    /// #146：老库 notes 有重复 content 时 open_db 不炸，且去重保留最早 id。
    #[test]
    fn notes_dedup_before_unique_index() {
        let path = tmp_db("dedup");
        {
            let conn = open_db(&path).unwrap();
            conn.execute(
                "INSERT INTO notes (content, label, created_at, updated_at) VALUES ('dup', 'low', 1, 1)",
                [],
            )
            .unwrap();
            // 先删索引再插脏数据，模拟老库在唯一索引建成前的重复行。
            conn.execute("DROP INDEX idx_notes_content", []).unwrap();
            conn.execute(
                "INSERT INTO notes (content, label, created_at, updated_at) VALUES ('dup', 'high', 2, 2)",
                [],
            )
            .unwrap();
        }
        // 重开：去重生效 + 唯一索引重建，不报错。
        let conn = open_db(&path).unwrap();
        let n: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM notes WHERE content = 'dup'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 1, "重复 content 应只剩 1 条");
        let label: String = conn
            .query_row("SELECT label FROM notes WHERE content = 'dup'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(label, "low", "应保留最早 id 的记录");
        drop(conn);
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    /// #144：纯内存解析与旧逐条查询语义一致（repo 级 > org 级 > 兜底）。
    #[test]
    fn resolve_status_from_rules_matches_priority() {
        let rules = vec![
            LabelRule {
                org: "acme".into(),
                repo: "".into(),
                label: "bug".into(),
                status: "doing".into(),
            },
            LabelRule {
                org: "acme".into(),
                repo: "web".into(),
                label: "bug".into(),
                status: "processed".into(),
            },
        ];
        // repo 级优先于 org 级。
        assert_eq!(
            resolve_status_from_rules(&rules, "acme", "web", "bug", "open"),
            "processed"
        );
        // 无 repo 映射时回退 org 级。
        assert_eq!(
            resolve_status_from_rules(&rules, "acme", "api", "bug", "open"),
            "doing"
        );
        // 无命中回退 state 兜底。
        assert_eq!(
            resolve_status_from_rules(&rules, "acme", "web", "chore", "closed"),
            "done"
        );
        assert_eq!(
            resolve_status_from_rules(&rules, "acme", "web", "", "open"),
            "todo"
        );
    }

    /// #192：显式命中返回 Some（含 todo），无命中/空 labels 返回 None（兜底不在此产生）。
    #[test]
    fn resolve_status_explicit_distinguishes_todo_hit_from_fallback() {
        let rules = vec![
            LabelRule {
                org: "acme".into(),
                repo: "".into(),
                label: "bug".into(),
                status: "doing".into(),
            },
            LabelRule {
                org: "acme".into(),
                repo: "web".into(),
                label: "triage".into(),
                status: "todo".into(),
            },
        ];
        // 显式命中 todo 也是 Some（调用方据此优先于 gh_status）。
        assert_eq!(
            resolve_status_from_rules_explicit(&rules, "acme", "web", "triage"),
            Some("todo".to_string())
        );
        // repo 级优先。
        assert_eq!(
            resolve_status_from_rules_explicit(&rules, "acme", "web", "bug"),
            Some("doing".to_string())
        );
        // 无命中 → None（不是兜底 todo）。
        assert_eq!(
            resolve_status_from_rules_explicit(&rules, "acme", "web", "chore"),
            None
        );
        assert_eq!(
            resolve_status_from_rules_explicit(&rules, "acme", "web", ""),
            None
        );
        // 旧 wrapper 语义不变：显式命中直返，无命中走 state 兜底。
        assert_eq!(
            resolve_status_from_rules(&rules, "acme", "web", "triage", "open"),
            "todo"
        );
        assert_eq!(
            resolve_status_from_rules(&rules, "acme", "web", "chore", "open"),
            "todo"
        );
        assert_eq!(
            resolve_status_from_rules(&rules, "acme", "web", "chore", "closed"),
            "done"
        );
    }

    /// #144：列规则首个命中胜出，空 gh_status 返回 None。
    #[test]
    fn resolve_column_from_rules_first_hit_wins() {
        let rules = vec![
            ColumnRule {
                col_key: "a".into(),
                rules: vec!["需求".into()],
            },
            ColumnRule {
                col_key: "b".into(),
                rules: vec!["需求".into(), "开发中".into()],
            },
        ];
        assert_eq!(
            resolve_column_from_rules(&rules, "开发中"),
            Some("b".to_string())
        );
        assert_eq!(
            resolve_column_from_rules(&rules, "需求"),
            Some("a".to_string())
        );
        assert_eq!(resolve_column_from_rules(&rules, ""), None);
        assert_eq!(resolve_column_from_rules(&rules, "未知"), None);
    }

    /// #216：仅剩一个账号时允许删除默认账号；多账号时仍拒绝；不存在的 id 报错。
    #[test]
    fn delete_last_account_allowed() {
        let path = tmp_db("del-last");
        let conn = open_db(&path).unwrap();
        // 首个账号自动为默认。
        let id = insert_account(&conn, "主", "me", "", "pat123").unwrap();
        delete_account(&conn, id).expect("仅剩一个时应可删除");
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM accounts", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 0, "删后应无账号");
        assert!(delete_account(&conn, 999).is_err(), "不存在的 id 应报错");
        // 两个账号时删默认仍拒绝。
        let a = insert_account(&conn, "一", "u1", "", "p1").unwrap();
        let _b = insert_account(&conn, "二", "u2", "", "p2").unwrap();
        assert!(
            delete_account(&conn, a).is_err(),
            "多账号时默认账号不可删除"
        );
        drop(conn);
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    /// #235：API 明细写入/读取往返（含 kind / ok / 关联字段）。
    #[test]
    fn api_logs_insert_and_list_roundtrip() {
        let path = tmp_db("api-logs");
        let conn = open_db(&path).unwrap();
        let entries = vec![
            ApiLogEntry::new(
                "GET",
                "/repos/a/b/issues",
                200,
                true,
                12,
                "https://x/y?q=1",
                "{\"ok\":1}",
            ),
            ApiLogEntry::new(
                "GRAPHQL",
                "updateProjectV2ItemFieldValue",
                200,
                false,
                34,
                "mutation {...}",
                "{\"errors\":[1]}",
            ),
        ];
        assert_eq!(
            insert_api_logs(&conn, "sync", 7, 42, 100, &entries).unwrap(),
            2
        );
        // 空列表不写、也不开事务。
        assert_eq!(insert_api_logs(&conn, "sync", 7, 42, 100, &[]).unwrap(), 0);

        let rows = list_api_logs(&conn, 10).unwrap();
        assert_eq!(rows.len(), 2);
        // created_at 降序 + id 降序 → 后插入的在前。
        let top = &rows[0];
        assert_eq!(top.kind, "sync");
        assert_eq!(top.account_id, 7);
        assert_eq!(top.sync_log_id, 42);
        assert_eq!(top.method, "GRAPHQL");
        assert_eq!(top.target, "updateProjectV2ItemFieldValue");
        assert!(!top.ok, "GraphQL 业务错误应落为失败");
        assert_eq!(top.elapsed_ms, 34);
        assert_eq!(top.request, "mutation {...}");
        assert_eq!(top.created_at, 100);
        let second = &rows[1];
        assert!(second.ok);
        assert_eq!(second.status, 200);
        assert_eq!(second.target, "/repos/a/b/issues");
        drop(conn);
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    /// #235：新库读不到明细时返回空列表，而不是报错。
    #[test]
    fn api_logs_empty_on_fresh_db() {
        let path = tmp_db("api-logs-empty");
        let conn = open_db(&path).unwrap();
        assert!(list_api_logs(&conn, 50).unwrap().is_empty());
        assert_eq!(clear_api_logs(&conn).unwrap(), 0);
        drop(conn);
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    /// #235：条数上限裁剪只保留最新行；超期按保留期淘汰。
    #[test]
    fn api_logs_prune_trims_to_max_rows() {
        let path = tmp_db("api-logs-prune");
        let conn = open_db(&path).unwrap();
        for i in 0..5 {
            let e = vec![ApiLogEntry::new("GET", "/x", 200, true, 1, "req", "resp")];
            insert_api_logs(&conn, "claim", 1, 0, 1000 + i, &e).unwrap();
        }
        // 上限 3（now 与 created_at 同量级 → 不触发超期淘汰）→ 只留最新 3 行。
        assert_eq!(prune_api_logs(&conn, 1000, 3).unwrap(), 2);
        let rows = list_api_logs(&conn, 10).unwrap();
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0].created_at, 1004, "应保留最新的一条");
        // 超期淘汰：now 远超保留期 → 全部清掉（max_rows=0 表示只按时间）。
        let removed = prune_api_logs(&conn, 10_000_000, 0).unwrap();
        assert_eq!(removed, 3, "全部过期应被清掉");
        assert_eq!(clear_api_logs(&conn).unwrap(), 0);
        drop(conn);
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    // ========================================================================
    // #328：tasks v2 物理重建的原子性 / 自愈，以及写回查询错误不被吞
    // ========================================================================

    /// 老布局（含 `key` 列）旧库上跑 v2 重建：残留的 `tasks_new` 必须被自愈清掉，
    /// 数据与本地态完整搬迁，且 `user_version` 在同一事务内推进到 2。
    ///
    /// 反向验证：去掉 SQL 开头的 `DROP TABLE IF EXISTS tasks_new` 后，重建会因
    /// 「table tasks_new already exists」失败（本用例 `unwrap()` 即 panic）；
    /// 去掉 `PRAGMA user_version = 2` 后最后一个断言失败。
    #[test]
    fn tasks_v2_rebuild_heals_leftover_tasks_new() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            r#"
            CREATE TABLE tasks (
                key TEXT PRIMARY KEY, owner TEXT NOT NULL, repo TEXT NOT NULL, number INTEGER NOT NULL,
                title TEXT NOT NULL, url TEXT NOT NULL, gh_state TEXT NOT NULL, ownership TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'todo', session_id TEXT, session_agent TEXT, session_at INTEGER,
                candidate_done INTEGER NOT NULL DEFAULT 0, stale INTEGER NOT NULL DEFAULT 0,
                gh_status TEXT NOT NULL DEFAULT '', assignees TEXT NOT NULL DEFAULT '',
                labels TEXT NOT NULL DEFAULT '', done_at INTEGER NOT NULL DEFAULT 0,
                mentioned INTEGER NOT NULL DEFAULT 0, comments_count INTEGER NOT NULL DEFAULT 0,
                latest_comment_url TEXT NOT NULL DEFAULT '', pr_number INTEGER NOT NULL DEFAULT 0,
                pr_url TEXT NOT NULL DEFAULT '', branch TEXT NOT NULL DEFAULT '',
                work_branch TEXT NOT NULL DEFAULT '', handoff TEXT NOT NULL DEFAULT '',
                updated_at TEXT, synced_at INTEGER NOT NULL, account_id INTEGER NOT NULL DEFAULT 1
            );
            -- 模拟「上次重建中途失败」留下的残骸
            CREATE TABLE tasks_new (bogus TEXT);
            INSERT INTO tasks (key, owner, repo, number, title, url, gh_state, ownership, status,
                               work_branch, handoff, updated_at, synced_at)
            VALUES ('o/r#1', 'o', 'r', 1, 't', 'u', 'open', 'notassignee', 'doing',
                    'feature/x', '交接内容', '2026-01-01T00:00:00Z', 100);
            "#,
        )
        .unwrap();

        migrate_tasks_v2_rebuild(&conn).expect("带残留的库必须能自愈并完成重建");

        let leftover: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE name = 'tasks_new'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(leftover, 0, "残留的 tasks_new 必须被清掉");

        let (k, status, wb, handoff, updated_at): (String, String, String, String, i64) = conn
            .query_row(
                "SELECT issue_key, status, work_branch, handoff, updated_at FROM tasks",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
            .expect("数据必须完整搬迁");
        assert_eq!(k, "o/r#1");
        assert_eq!(status, "doing", "本地手动态不能被重建丢掉");
        assert_eq!(wb, "feature/x", "agent 工作分支不能被重建丢掉");
        assert_eq!(handoff, "交接内容", "handoff 不能被重建丢掉");
        assert_eq!(updated_at, 1_767_225_600, "RFC3339 应转成 Unix 秒");

        let legacy_key: bool = conn
            .prepare("SELECT 1 FROM pragma_table_info('tasks') WHERE name = 'key'")
            .unwrap()
            .exists([])
            .unwrap();
        assert!(!legacy_key, "重建后不应再有 key 列");

        let ver: i64 = conn
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .unwrap();
        assert_eq!(ver, 2, "user_version 应在重建事务内推进");
    }

    /// 写回目标查询只把「没有行」当「不在任何 Project 中」；真实 DB 故障必须带原文上抛。
    /// 反向验证：把 `.map(Some).unwrap_or(None)` 换回来后，前两个断言失败。
    #[test]
    fn resolve_write_target_surfaces_db_errors_instead_of_hiding_them() {
        let conn = Connection::open_in_memory().unwrap();
        // 一张表都没建：真实故障是「表不存在」，不能被折叠成「不在任何 Project 中」。
        let err = resolve_project_write_target(&conn, 1, "o/r#1").unwrap_err();
        assert!(err.contains("no such table"), "{err}");
        assert!(
            !err.contains("不在任何 Project 中"),
            "DB 故障不能被伪装成业务结论: {err}"
        );

        let err = project_option_id(&conn, 1, "PVT_x", "Done").unwrap_err();
        assert!(err.contains("no such table"), "{err}");
    }

    /// 对照组：表在、只是查不到该 issue 时，仍按原语义报「不在任何 Project 中」。
    #[test]
    fn resolve_write_target_keeps_missing_row_semantics() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            r#"
            CREATE TABLE project_items (account_id INTEGER, project_github_id TEXT, issue_key TEXT, item_id TEXT);
            CREATE TABLE projects (account_id INTEGER, github_id TEXT, name TEXT, status_field_id TEXT, number_of_items INTEGER);
            CREATE TABLE project_statuses (account_id INTEGER, project_github_id TEXT, option_id TEXT, name TEXT, order_index INTEGER);
            "#,
        )
        .unwrap();
        let err = resolve_project_write_target(&conn, 1, "o/r#1").unwrap_err();
        assert!(err.contains("不在任何 Project 中"), "{err}");

        let err = project_option_id(&conn, 1, "PVT_x", "Done").unwrap_err();
        assert!(err.contains("Done"), "找不到选项名时应列出可用选项: {err}");
    }

    // ========================================================================
    // #329：open_db 稳态零写入（迁移门控 + 只读自愈探测）
    // ========================================================================

    /// 建库并跑完迁移，返回「已进入稳态」的路径。
    fn steady_db(name: &str) -> std::path::PathBuf {
        let path = tmp_db(name);
        drop(open_db(&path).unwrap());
        path
    }

    /// v2 布局（无 `key` 列）的 tasks 表 DDL，缺 #237/#278/#287/#280 之后新增的列。
    /// 用于模拟「版本号谎报为最新但结构落后」的库。
    const TASKS_V2_MINUS_NEWEST_DDL: &str = r#"
        CREATE TABLE tasks (
          id             INTEGER PRIMARY KEY,
          issue_key      TEXT NOT NULL,
          owner          TEXT NOT NULL,
          repo           TEXT NOT NULL,
          number         INTEGER NOT NULL,
          title          TEXT NOT NULL,
          url            TEXT NOT NULL,
          issue_state    TEXT NOT NULL,
          ownership      TEXT NOT NULL,
          status         TEXT NOT NULL DEFAULT 'todo',
          session_id     TEXT,
          session_agent  TEXT,
          session_at     INTEGER,
          candidate_done INTEGER NOT NULL DEFAULT 0,
          stale          INTEGER NOT NULL DEFAULT 0,
          project_status TEXT NOT NULL DEFAULT '',
          assignees      TEXT NOT NULL DEFAULT '',
          labels         TEXT NOT NULL DEFAULT '',
          done_at        INTEGER NOT NULL DEFAULT 0,
          mentioned      INTEGER NOT NULL DEFAULT 0,
          comments_count INTEGER NOT NULL DEFAULT 0,
          latest_comment_url TEXT NOT NULL DEFAULT '',
          pr_number      INTEGER NOT NULL DEFAULT 0,
          pr_url         TEXT NOT NULL DEFAULT '',
          branch         TEXT NOT NULL DEFAULT '',
          work_branch    TEXT NOT NULL DEFAULT '',
          handoff        TEXT NOT NULL DEFAULT '',
          updated_at     INTEGER,
          synced_at      INTEGER NOT NULL,
          account_id     INTEGER NOT NULL DEFAULT 1,
          UNIQUE(repo, number, account_id)
        );
    "#;

    /// #329 症状回归：稳态下 `open_db` 不得取写锁。
    ///
    /// 同步是「一个长写事务」；UI 每个 Tauri command 都新建连接，若建连时还要写
    /// （`DELETE notes` / `INSERT meta` / ALTER），就会阻塞到 `busy_timeout`（5s），
    /// 表现为「点一下卡 5 秒」。本用例在另一个连接持有写锁时建连，必须立即成功。
    ///
    /// 反向验证：把迁移门控去掉（恢复成每次建连都跑迁移）后，本用例会阻塞约 5s
    /// 并触发 `elapsed < 2s` 断言失败。
    #[test]
    fn open_db_steady_state_does_not_take_write_lock() {
        let path = steady_db("open-no-write");

        let holder = Connection::open(&path).unwrap();
        // 模拟同步的长写事务：取写锁并保持不提交。
        holder.execute_batch("BEGIN IMMEDIATE;").unwrap();
        holder
            .execute("UPDATE meta SET value = value WHERE key = 'gh_path'", [])
            .unwrap();

        let t0 = std::time::Instant::now();
        let conn = open_db(&path).expect("稳态建连不应被写锁阻塞");
        let elapsed = t0.elapsed();
        drop(conn);
        assert!(
            elapsed < std::time::Duration::from_secs(2),
            "稳态建连耗时 {elapsed:?}，疑似在等写锁（busy_timeout=5s）"
        );

        holder.execute_batch("ROLLBACK;").unwrap();
        drop(holder);
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    /// #329：新建库与迁移完成后 `user_version` 应落在 `SCHEMA_VERSION`，且重开不漂移。
    #[test]
    fn open_db_records_schema_version() {
        let path = tmp_db("schema-ver");
        let conn = open_db(&path).unwrap();
        assert_eq!(
            schema_version(&conn),
            SCHEMA_VERSION,
            "新库应记录当前 schema 版本"
        );
        drop(conn);
        let conn = open_db(&path).unwrap();
        assert_eq!(
            schema_version(&conn),
            SCHEMA_VERSION,
            "稳态重开不应改变版本号"
        );
        drop(conn);
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    /// #329：版本号被谎报成最新（或丢失）时，只读探测仍必须补齐缺索引。
    ///
    /// 用 `idx_tasks_issue_key` 而非 `idx_tasks_board`：后者在 `SCHEMA` 顶层，
    /// 每次建连的 `execute_batch(SCHEMA)` 就会重建，盖不出探测逻辑的缺失。
    /// 反向验证：从 `schema_is_current` 去掉 `missing_indexes` 后本用例失败。
    #[test]
    fn open_db_self_heals_missing_index_despite_newer_version() {
        let path = steady_db("self-heal-idx");
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute("DROP INDEX idx_tasks_issue_key", []).unwrap();
            conn.pragma_update(None, "user_version", 99).unwrap();
        }
        let conn = open_db(&path).unwrap();
        let n: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = 'idx_tasks_issue_key'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 1, "缺索引应被热路径自愈重建");
        assert_eq!(schema_version(&conn), 99, "已被写高的版本号不应被回退覆盖");
        drop(conn);
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    /// #329：版本号谎报成最新时，只读探测仍必须补齐缺列。
    /// 反向验证：从 `schema_is_current` 去掉 `missing_columns` 后本用例失败。
    #[test]
    fn open_db_self_heals_missing_column_despite_newer_version() {
        let path = tmp_db("self-heal-col");
        {
            let conn = Connection::open(&path).unwrap();
            // 老布局：tasks 缺 author / parent_issue / sub_issues / work_dir / created_at，
            // 且把版本号谎报为最新（模拟版本号丢值或被写高）。
            conn.execute_batch(TASKS_V2_MINUS_NEWEST_DDL).unwrap();
            conn.pragma_update(None, "user_version", 99).unwrap();
        }
        let conn = open_db(&path).unwrap();
        let missing = missing_columns(&conn);
        assert!(missing.is_empty(), "缺列应被自愈补齐，仍缺: {missing:?}");
        drop(conn);
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    /// #329 回归：`idx_tasks_issue_key` 故意不在 `SCHEMA` 顶层（老库无 `issue_key` 列，
    /// 放顶层会让整个 SCHEMA batch 失败），必须由迁移路径建出——否则新库永远缺这个索引，
    /// 只读探测每次判定「不达标」，稳态零写入直接失效。
    #[test]
    fn fresh_db_gets_post_schema_indexes() {
        let path = tmp_db("fresh-indexes");
        let conn = open_db(&path).unwrap();
        let missing = missing_indexes(&conn);
        assert!(
            missing.is_empty(),
            "新库应补齐全部必填索引，仍缺: {missing:?}"
        );
        assert!(
            schema_is_current(&conn),
            "新库建连后应处于稳态（版本号 + 索引 + 列全部达标）"
        );
        drop(conn);
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    /// #329：`REQUIRED_COLUMNS` / `REQUIRED_INDEXES` 是探测白名单，必须与补齐语句一一对应。
    /// 漏写会导致「探测到缺口但永远补不上」——`user_version` 卡住不推进，每次启动重跑全部迁移。
    #[test]
    fn required_columns_and_indexes_are_covered_by_migration_ddl() {
        for (table, col) in REQUIRED_COLUMNS {
            let needle = format!("ALTER TABLE {table} ADD COLUMN {col} ");
            assert!(
                MIGRATION_DDL.iter().any(|s| s.contains(&needle)),
                "`MIGRATION_DDL` 缺 {table}.{col} 的补齐语句"
            );
        }
        for idx in REQUIRED_INDEXES {
            let plain = format!("CREATE INDEX IF NOT EXISTS {idx}");
            let unique = format!("CREATE UNIQUE INDEX IF NOT EXISTS {idx}");
            assert!(
                MIGRATION_DDL
                    .iter()
                    .any(|s| s.contains(&plain) || s.contains(&unique))
                    || SCHEMA.contains(&plain)
                    || SCHEMA.contains(&unique),
                "`MIGRATION_DDL` / `SCHEMA` 缺索引 {idx} 的创建语句"
            );
        }
    }

    /// #329 附带修正：全新库不应再被 `migrate_legacy_alters` 塞进 legacy-only 的
    /// `gh_status` 列（v2 布局已改名为 `project_status`）。旧实现里该函数在
    /// `user_version=0` 时无条件执行，于是每个新库的 tasks 都会多一列垃圾列。
    /// 反向验证：把 `run_migrations` 的 `fresh` 短路去掉后本用例失败。
    #[test]
    fn fresh_db_has_no_legacy_gh_status_column() {
        let path = tmp_db("fresh-no-legacy");
        let conn = open_db(&path).unwrap();
        let n: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('tasks') WHERE name = 'gh_status'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 0, "新库不应含 legacy 的 gh_status 列");
        drop(conn);
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    /// #329：默认设置只在缺失时补写——用户改过的值不被覆盖，被删掉的键会补回。
    #[test]
    fn defaults_preserve_user_value_and_restore_deleted_key() {
        let path = tmp_db("defaults");
        {
            let conn = open_db(&path).unwrap();
            set_setting(&conn, "view_mode", "all").unwrap();
            conn.execute("DELETE FROM meta WHERE key = 'board_mode'", [])
                .unwrap();
        }
        let conn = open_db(&path).unwrap();
        assert_eq!(
            get_setting(&conn, "view_mode"),
            "all",
            "用户改过的值不应被默认值覆盖"
        );
        assert_eq!(
            get_setting(&conn, "board_mode"),
            "project",
            "被删掉的默认键应补回"
        );
        drop(conn);
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }
}

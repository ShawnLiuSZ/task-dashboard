use rusqlite::{Connection, Result};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

/// 应用标识符，与 tauri.conf.json 的 `identifier` 一致。
/// 同时用于推导无 GUI 运行时的本地数据目录（MCP 子命令等）。
pub const APP_IDENTIFIER: &str = "com.shawnliu.taskboard";

/// 检查是否启用详细日志（TASKBOARD_LOG=1 或 TASKBOARD_LOG=debug）。
/// MCP 调用时默认静默，仅在排障时显式开启。
fn verbose_enabled() -> bool {
    std::env::var("TASKBOARD_LOG")
        .map(|v| matches!(v.as_str(), "1" | "debug" | "verbose" | "true"))
        .unwrap_or(false)
}

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

CREATE TABLE IF NOT EXISTS tasks (
  key            TEXT PRIMARY KEY,
  owner          TEXT NOT NULL,
  repo           TEXT NOT NULL,
  number         INTEGER NOT NULL,
  title          TEXT NOT NULL,
  url            TEXT NOT NULL,
  gh_state       TEXT NOT NULL,
  ownership      TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'todo',
  session_id     TEXT,
  session_agent  TEXT,
  session_at     INTEGER,
  candidate_done INTEGER NOT NULL DEFAULT 0,
  stale          INTEGER NOT NULL DEFAULT 0,
  gh_status      TEXT NOT NULL DEFAULT '',
  assignees      TEXT NOT NULL DEFAULT '',
  labels         TEXT NOT NULL DEFAULT '',
  done_at        INTEGER NOT NULL DEFAULT 0,
  mentioned      INTEGER NOT NULL DEFAULT 0,
  comments_count INTEGER NOT NULL DEFAULT 0,
  latest_comment_url TEXT NOT NULL DEFAULT '',
  pr_number      INTEGER NOT NULL DEFAULT 0,
  pr_url         TEXT NOT NULL DEFAULT '',
  -- v0.3.10：关联 PR 的分支（head.ref）。v0.3.28+ 同时写入 SCHEMA，
  -- 避免任何只执行 SCHEMA 的建库路径漏掉 ALTER 迁移导致缺列。
  branch         TEXT NOT NULL DEFAULT '',
  -- v0.3.10：agent 写入的交接任务详情。
  handoff        TEXT NOT NULL DEFAULT '',
  updated_at     TEXT,
  synced_at      INTEGER NOT NULL,
  -- v0.3.16：任务归属账号（来自 accounts.id）。v0.3.15 之前的数据迁移后默认 1。
  account_id     INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_ownership ON tasks(ownership);
CREATE INDEX IF NOT EXISTS idx_tasks_account ON tasks(account_id);

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
  UNIQUE(account_id, github_id)
);
CREATE INDEX IF NOT EXISTS idx_projects_account ON projects(account_id);

CREATE TABLE IF NOT EXISTS project_statuses (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id   INTEGER NOT NULL,
  project_github_id TEXT NOT NULL,
  name         TEXT NOT NULL,
  order_index  INTEGER NOT NULL DEFAULT 0,
  UNIQUE(account_id, project_github_id, name)
);
CREATE INDEX IF NOT EXISTS idx_project_statuses_project ON project_statuses(account_id, project_github_id);

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
/// `~/Library/Application Support/com.shawnliu.taskboard`
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

/// 打开（必要时创建）数据库连接，应用 schema 与历史迁移，并写入默认设置。
/// GUI 与 MCP 子命令共用此函数，确保表结构单一来源、无漂移。
///
/// **崩溃恢复说明（v0.3.16+）**：早期默认 `journal_mode=DELETE`，进程崩溃时未提交
/// 事务会留下 `.db-journal` 文件，下次启动必须先 replay/rollback 才能继续——一旦
/// journal 不完整（如早期 v0.3.16 二进制在 macOS 26.6 的 SIGABRT），整个 DB 会
/// 进入"disk I/O error"无限循环。本函数强制 `journal_mode=WAL`，配合 `synchronous=NORMAL`：
/// WAL 文件 (`-wal`/`-shm`) 与主 DB 文件始终一致可读，崩溃不会让整个 DB 锁死。
/// WAL 与 DELETE 共存时不冲突——已有的 `-journal` 文件如果存在，SQLite 会自动 forward-rollback。
pub fn open_db(path: &Path) -> Result<Connection, String> {
    let conn = Connection::open(path).map_err(|e| format!("打开数据库失败: {}", e))?;
    // v0.3.16+: WAL 模式 + NORMAL 同步。WAL 文件保留部分未 checkpoint 数据，崩溃后仍可读。
    // 必须先设（再做任何事务），否则后续 BEGIN/COMMIT 仍走 DELETE 路径。
    let _ = conn.pragma_update(None, "journal_mode", "WAL");
    let _ = conn.pragma_update(None, "synchronous", "NORMAL");
    let _ = conn.pragma_update(None, "busy_timeout", 5000);
    // schema 初始化（WAL 模式下多个连接可并发读，但写仍互斥）。
    conn.execute_batch(SCHEMA)
        .map_err(|e| format!("初始化表结构失败: {}", e))?;
    // 迁移：兼容已存在的旧库，缺列则补（列已存在时 ALTER 会报错，忽略即可）。
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
        // v0.3.10：关联 PR 的分支（head.ref），以及 agent 写入的交接任务详情。
        "ALTER TABLE tasks ADD COLUMN branch TEXT NOT NULL DEFAULT ''",
        "ALTER TABLE tasks ADD COLUMN handoff TEXT NOT NULL DEFAULT ''",
        // v0.3.16：任务归属账号；旧库默认 1（迁移会先插一条 accounts，再保证该 id 命中）。
        "ALTER TABLE tasks ADD COLUMN account_id INTEGER NOT NULL DEFAULT 1",
    ] {
        if let Err(e) = conn.execute(col_sql, []) {
            // **不再吞掉**：v0.3.16 之前是 `let _ = ...`，导致脏 DB 被静默接受，下次 sync
            // 触发 panic。默认静默（MCP 调用时不刷屏），仅 TASKBOARD_LOG=1 时输出。
            if verbose_enabled() {
                eprintln!("[db] 列迁移跳过（已存在或 schema 不兼容）: {} | sql={}", e, col_sql);
            }
        }
    }
    for (k, v) in DEFAULT_SETTINGS {
        conn.execute(
            "INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO NOTHING",
            rusqlite::params![k, v],
        )
        .map_err(|e| format!("写入默认设置失败: {}", e))?;
    }
    // v0.3.20：label_mappings 表迁移（新表，直接 CREATE IF NOT EXISTS 已在 schema 里）。
    // 仅确保索引存在（旧库可能无索引）。
    for idx_sql in [
        "CREATE INDEX IF NOT EXISTS idx_label_mappings_org ON label_mappings(org)",
        "CREATE INDEX IF NOT EXISTS idx_label_mappings_repo ON label_mappings(repo)",
    ] {
        if let Err(e) = conn.execute(idx_sql, []) {
            if verbose_enabled() {
                eprintln!("[db] label_mappings 索引创建跳过: {}", e);
            }
        }
    }
    // v0.3.21：label_mappings 增加 order_index 列（用于 Label 列视图排序）。
    if let Err(e) = conn.execute("ALTER TABLE label_mappings ADD COLUMN order_index INTEGER NOT NULL DEFAULT 0", []) {
        if verbose_enabled() {
            eprintln!("[db] label_mappings order_index 列迁移跳过: {}", e);
        }
    }
    // v0.3.24：notes 表补 label 列。早期无标签版本的库里 notes 只有 4 列，
    // 而 `CREATE TABLE IF NOT EXISTS` 不会给已存在的表补列，导致 list_notes
    // （SELECT ... label）与 add_note（INSERT ... label）全部失败、前端静默无反应。
    if let Err(e) = conn.execute(
        "ALTER TABLE notes ADD COLUMN label TEXT NOT NULL DEFAULT 'low'",
        [],
    ) {
        if verbose_enabled() {
            eprintln!("[db] notes label 列迁移跳过（已存在）: {}", e);
        }
    }
    // v0.3.15 → v0.3.16 自动迁移：把 v0.3.15 写在 meta.pat_token 的单账号 PAT
    // 迁到 accounts 表（首条默认账号）。原 meta 字段保留作兼容兜底，单账号视图仍可读。
    if let Err(e) = migrate_v0315_to_accounts(&conn) {
        if verbose_enabled() {
            eprintln!("[db] v0.3.15 → v0.3.16 迁移失败（已保留兜底字段）: {}", e);
        }
    }
    Ok(conn)
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
    if verbose_enabled() {
        eprintln!(
            "[db] v0.3.15 → v0.3.16 自动迁移完成：新账号 id={} @{} (org={})",
            new_id, login, org
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
    pub created_at: i64,
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
    conn.query_row("SELECT id FROM accounts ORDER BY id ASC LIMIT 1", [], |r| r.get(0))
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
        .query_row(
            "SELECT is_default FROM accounts WHERE id = ?1",
            [id],
            |r| r.get(0),
        )
        .unwrap_or(0);
    if is_default != 0 {
        return Err("默认账号不可删除，请先把另一个账号设为默认".to_string());
    }
    // 检查账号是否存在
    let exists: i64 = conn
        .query_row("SELECT COUNT(*) FROM accounts WHERE id = ?1", [id], |r| r.get(0))
        .unwrap_or(0);
    if exists == 0 {
        return Err(format!("账号 #{id} 不存在"));
    }
    // 在同一事务中原子删除所有关联数据
    conn.execute_batch("BEGIN IMMEDIATE")
        .map_err(|e| format!("开启事务失败: {e}"))?;
    let result = (|| {
        // 1. 删除 tasks
        conn.execute("DELETE FROM tasks WHERE account_id = ?1", [id])
            .map_err(|e| format!("删除 tasks 失败: {e}"))?;
        // 2. 删除 projects
        conn.execute("DELETE FROM projects WHERE account_id = ?1", [id])
            .map_err(|e| format!("删除 projects 失败: {e}"))?;
        // 3. 删除 project_statuses
        conn.execute("DELETE FROM project_statuses WHERE account_id = ?1", [id])
            .map_err(|e| format!("删除 project_statuses 失败: {e}"))?;
        // 4. 删除 sync_logs
        conn.execute("DELETE FROM sync_logs WHERE account_id = ?1", [id])
            .map_err(|e| format!("删除 sync_logs 失败: {e}"))?;
        // 5. 删除 account_columns（v0.3.28+）
        conn.execute("DELETE FROM account_columns WHERE account_id = ?1", [id])
            .map_err(|e| format!("删除 account_columns 失败: {e}"))?;
        // 6. 删除账号本身
        conn.execute("DELETE FROM accounts WHERE id = ?1", [id])
            .map_err(|e| format!("删除账号失败: {e}"))?;
        Ok(())
    })();
    match result {
        Ok(()) => {
            conn.execute_batch("COMMIT")
                .map_err(|e| format!("提交事务失败: {e}"))?;
            Ok(())
        }
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(e)
        }
    }
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
        return Ok(n);
    }
    let placeholders: String = keep_ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
    let sql = format!(
        "DELETE FROM projects WHERE account_id = ?1 AND github_id NOT IN ({})",
        placeholders
    );
    let mut params: Vec<Box<dyn rusqlite::types::ToSql>> =
        vec![Box::new(account_id)];
    for id in keep_ids {
        params.push(Box::new(id.clone()));
    }
    let param_refs: Vec<&dyn rusqlite::types::ToSql> = params.iter().map(|p| p.as_ref()).collect();
    let n = conn
        .execute(&sql, param_refs.as_slice())
        .map_err(|e| format!("清理项目失败: {e}"))?;
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
pub fn list_project_statuses(conn: &Connection, account_id: i64) -> Result<Vec<ProjectStatus>, String> {
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
pub fn list_project_status_names(conn: &Connection, account_id: i64, project_github_id: &str) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT name FROM project_statuses
             WHERE account_id = ?1 AND project_github_id = ?2
             ORDER BY order_index ASC",
        )
        .map_err(|e| format!("查询项目状态名失败: {e}"))?;
    let rows = stmt
        .query_map(rusqlite::params![account_id, project_github_id], |r| r.get(0))
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
    statuses: &[(String, i64)], // (name, order_index)
    _now: i64,
) -> Result<(), String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    for (name, order_idx) in statuses {
        tx.execute(
            "INSERT INTO project_statuses (account_id, project_github_id, name, order_index)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(account_id, project_github_id, name) DO UPDATE SET
               order_index = excluded.order_index",
            rusqlite::params![account_id, project_github_id, name, order_idx],
        )
        .map_err(|e| format!("upsert 项目状态失败: {e}"))?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// 清空某账号下所有项目的 Status 选项（sync 前调用）。
pub fn clear_project_statuses(conn: &Connection, account_id: i64) -> Result<usize, String> {
    let n = conn
        .execute("DELETE FROM project_statuses WHERE account_id = ?1", [account_id])
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
        return Err(format!("非法 status: {status}，必须为 todo/doing/processed/done 之一"));
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
pub fn resolve_status_from_labels(
    conn: &Connection,
    org: &str,
    repo: &str,
    labels_csv: &str,
    fallback_state: &str,
) -> String {
    // 解析 labels
    let labels: Vec<&str> = labels_csv
        .split(',')
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .collect();
    if labels.is_empty() {
        return fallback_state_from_gh_state(fallback_state);
    }

    // 先尝试 repo 级映射（精确匹配 org+repo+label）
    for label in &labels {
        if let Ok(mapped) = conn.query_row(
            "SELECT status FROM label_mappings WHERE org = ?1 AND repo = ?2 AND label = ?3",
            rusqlite::params![org, repo, label],
            |r| r.get::<_, String>(0),
        ) {
            return mapped;
        }
    }
    // 再尝试 org 级映射（repo 为空字符串）
    for label in &labels {
        if let Ok(mapped) = conn.query_row(
            "SELECT status FROM label_mappings WHERE org = ?1 AND repo = '' AND label = ?2",
            rusqlite::params![org, label],
            |r| r.get::<_, String>(0),
        ) {
            return mapped;
        }
    }
    // 最后回退到 state 逻辑
    fallback_state_from_gh_state(fallback_state)
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
fn fallback_state_from_gh_state(gh_state: &str) -> String {
    if gh_state == "closed" {
        "done".to_string()
    } else {
        "todo".to_string() // open 默认待处理，实际同步时会被 Project Status 覆盖
    }
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
        rusqlite::params![id, finished_at, status, added, updated, removed, candidate_done, pruned, failed_sources, error_message],
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

/// 清理超过 7 天的同步日志（保留策略）。
pub fn prune_sync_logs(conn: &Connection, now: i64) -> Result<usize, String> {
    let seven_days_secs = 7 * 24 * 60 * 60;
    let n = conn
        .execute(
            "DELETE FROM sync_logs WHERE ?1 - created_at > ?2",
            [now, seven_days_secs],
        )
        .map_err(|e| format!("清理过期同步日志失败: {e}"))?;
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
        .prepare("SELECT id, content, label, created_at, updated_at FROM notes ORDER BY created_at DESC")
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

/// 新增记事，返回新记录。
pub fn add_note(conn: &Connection, content: &str, label: &str, now: i64) -> Result<Note, String> {
    conn.execute(
        "INSERT INTO notes (content, label, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)",
        rusqlite::params![content, label, now],
    )
    .map_err(|e| format!("插入记事失败: {e}"))?;
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
        .map_err(|e| format!("更新记事失败: {e}"))?;
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
pub fn list_account_columns(conn: &Connection, account_id: i64) -> Result<Vec<AccountColumn>, String> {
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
pub fn save_account_columns(
    conn: &Connection,
    account_id: i64,
    columns: &[AccountColumn],
) -> Result<(), String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    // 先删旧配置
    tx.execute("DELETE FROM account_columns WHERE account_id = ?1", [account_id])
        .map_err(|e| format!("清空旧列配置失败: {e}"))?;
    // 再插入新配置
    for col in columns {
        let match_rules = if col.match_rules.is_empty() { "[]" } else { &col.match_rules };
        tx.execute(
            "INSERT INTO account_columns (account_id, col_key, col_name, match_rules, order_index)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![account_id, col.col_key, col.col_name, match_rules, col.order_index],
        )
        .map_err(|e| format!("插入列配置失败: {e}"))?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// 根据账号的列映射规则，解析 gh_status 对应的列 key。
/// 遍历所有列，逐一检查 match_rules JSON 数组是否包含该 gh_status。
/// 若命中，返回该列的 col_key；否则返回 None（由 sync 回退到默认逻辑）。
pub fn resolve_column_from_gh_status(
    conn: &Connection,
    account_id: i64,
    gh_status: &str,
) -> Option<String> {
    if gh_status.is_empty() {
        return None;
    }
    let columns = list_account_columns(conn, account_id).ok()?;
    for col in &columns {
        if let Ok(rules) = serde_json::from_str::<Vec<String>>(&col.match_rules) {
            if rules.iter().any(|r| r == gh_status) {
                return Some(col.col_key.clone());
            }
        }
    }
    None
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

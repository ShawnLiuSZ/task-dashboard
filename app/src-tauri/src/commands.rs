use rusqlite::Connection;
use serde::Serialize;
use std::time::Duration;
use tauri::{AppHandle, Manager, State};

use crate::db::{Account, AccountColumn, LabelMapping, LabelMappingInput};
use crate::sync::SyncResult;
use crate::AppState;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub key: String,
    pub owner: String,
    pub repo: String,
    pub number: i64,
    pub title: String,
    pub url: String,
    pub gh_state: String,
    pub ownership: String,
    pub status: String,
    pub gh_status: String,
    pub assignees: String,
    pub mentioned: bool,
    pub latest_comment_url: String,
    pub pr_number: i64,
    pub pr_url: String,
    pub branch: String,
    pub session_id: Option<String>,
    pub session_agent: Option<String>,
    pub session_at: Option<i64>,
    pub candidate_done: bool,
    pub handoff: String,
    pub updated_at: Option<String>,
    /// v0.3.16：归属账号 id（指向 accounts.id），用于多账号视图过滤。
    pub account_id: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub schedule_minutes: u64,
    /// 历史字段：保留兼容（v0.3.15 起不再用于任何路径，仅显示）。
    pub gh_path: String,
    pub login: String,
    pub org: String,
    pub last_sync_at: i64,
    pub db_path: String,
    /// v0.3.15+：是否已配置 PAT（不回显 token 本体）。
    pub has_pat: bool,
    /// v0.3.15+：最近一次同步的错误信息（如「未配置 PAT」「GitHub 401…」）。
    /// 当作 banner 展示给用户，便于诊断；成功同步时清空。
    pub last_sync_error: String,
    /// v0.3.16+：当前激活账号 id（单账号视图下同步此账号）。
    pub active_account_id: i64,
    /// v0.3.16+：视图模式。'single'=仅当前激活账号；'all'=所有账号任务聚合。
    pub view_mode: String,
    /// v0.3.21+：看板列模式。'status'=四态列；'project'=Project Status 列；'custom'=自定义列。
    pub board_mode: String,
    /// v0.3.16+：所有账号列表（不含 PAT 本体）。
    pub accounts: Vec<Account>,
    /// v0.3.17+：GitHub OAuth Device Flow 的 client_id（注册 OAuth App 后填一次）。
    pub oauth_client_id: String,
}

fn rows_to_tasks(conn: &Connection, ownership: Option<&str>, account_filter: Option<i64>) -> Result<Vec<Task>, String> {
    // v0.3.16：account_filter 解析。
    // - None / Some(n>0) → 按指定账号 id 过滤
    // - Some(0) → 不加 account_id 条件（即"全部账号"聚合视图）
    let (where_extra, use_account_filter, account_id) = match account_filter {
        Some(0) => (String::new(), false, 0i64),
        Some(n) => (" AND account_id = ?".to_string(), true, n),
        None => {
            // 默认：单账号视图（active_account_id）；若无任何账号则不过滤（空集）。
            let active: i64 = conn
                .query_row(
                    "SELECT value FROM meta WHERE key = 'active_account_id'",
                    [],
                    |r| r.get::<_, String>(0),
                )
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(0);
            if active > 0 {
                (" AND account_id = ?".to_string(), true, active)
            } else {
                (String::new(), false, 0i64)
            }
        }
    };
    let (sql, use_ownership_filter) = match ownership {
        Some(_) => (
            format!(
                "SELECT key, owner, repo, number, title, url, gh_state, ownership, status, gh_status,
                        assignees, mentioned, latest_comment_url, pr_number, pr_url, branch,
                        session_id, session_agent, session_at, candidate_done, handoff, updated_at, account_id
                 FROM tasks WHERE ownership = ?{where_extra}
                 ORDER BY candidate_done ASC, status ASC, updated_at DESC"
            ),
            true,
        ),
        None => (
            format!(
                "SELECT key, owner, repo, number, title, url, gh_state, ownership, status, gh_status,
                        assignees, mentioned, latest_comment_url, pr_number, pr_url, branch,
                        session_id, session_agent, session_at, candidate_done, handoff, updated_at, account_id
                 FROM tasks WHERE 1=1{where_extra}
                 ORDER BY candidate_done ASC, status ASC, updated_at DESC"
            ),
            false,
        ),
    };

    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let mapper = |r: &rusqlite::Row| {
        Ok(Task {
            key: r.get(0)?,
            owner: r.get(1)?,
            repo: r.get(2)?,
            number: r.get(3)?,
            title: r.get(4)?,
            url: r.get(5)?,
            gh_state: r.get(6)?,
            ownership: r.get(7)?,
            status: r.get(8)?,
            gh_status: r.get(9)?,
            assignees: r.get(10)?,
            mentioned: r.get::<_, i64>(11).unwrap_or(0) != 0,
            latest_comment_url: r.get(12)?,
            pr_number: r.get(13)?,
            pr_url: r.get(14)?,
            branch: r.get(15)?,
            session_id: r.get(16)?,
            session_agent: r.get(17)?,
            session_at: r.get(18)?,
            candidate_done: r.get::<_, i64>(19).unwrap_or(0) != 0,
            handoff: r.get(20)?,
            updated_at: r.get(21)?,
            account_id: r.get(22)?,
        })
    };

    // 动态参数：归属 + account_id（按 use_*_filter 标志决定传几个）
    let rows: rusqlite::Result<rusqlite::MappedRows<'_, _>> = match (use_ownership_filter, use_account_filter) {
        (true, true) => stmt.query_map(
            rusqlite::params![ownership.unwrap_or(""), account_id],
            mapper,
        ),
        (true, false) => stmt.query_map(rusqlite::params![ownership.unwrap_or("")], mapper),
        (false, true) => stmt.query_map(rusqlite::params![account_id], mapper),
        (false, false) => stmt.query_map([], mapper),
    };
    let mut out = Vec::new();
    for r in rows.map_err(|e| e.to_string())? {
        out.push(r.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

/// 列出任务；v0.3.16 起支持按账号过滤。
///
/// `account_id` 约定：
/// - `None` → 单账号视图（默认）；后端读 `meta.active_account_id`
/// - `Some(0)` → 全部账号聚合视图
/// - `Some(n>0)` → 指定账号 id
#[tauri::command]
pub fn list_tasks(
    app: AppHandle,
    state: State<'_, AppState>,
    ownership: Option<String>,
    account_id: Option<i64>,
) -> Result<Vec<Task>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let _ = app;
    rows_to_tasks(&conn, ownership.as_deref(), account_id)
}

#[tauri::command]
pub async fn sync_now(app: AppHandle) -> Result<SyncResult, String> {
    // 同步要跑 5 次 Search API + 1 次 GraphQL（5~15s）。若作为同步命令直接跑，
    // 会阻塞 Tauri 主线程（事件循环），表现为 macOS 转圈 beachball、UI 看似卡死。
    // 改为 async + spawn_blocking：主线程仅派发后立即返回，重活在工作线程执行，
    // UI 的「同步中…」指示与渲染不受影响。
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let st = handle.state::<AppState>();
        let conn = st.db.lock().map_err(|e| e.to_string())?;
        crate::sync::run(&conn)
    })
    .await
    .map_err(|e| format!("同步线程异常: {}", e))?
}

#[tauri::command]
	pub fn update_task_status(
	    state: State<'_, AppState>,
	    key: String,
	    status: String,
	) -> Result<(), String> {
	    // 允许自定义列值（col_0, col_1 等）通过；空串视为非法。
	    if status.trim().is_empty() {
	        return Err("状态不能为空".to_string());
	    }
	    let conn = state.db.lock().map_err(|e| e.to_string())?;
	    conn.execute(
	        "UPDATE tasks SET status = ?1 WHERE key = ?2",
	        rusqlite::params![status, key],
	    )
	    .map_err(|e| e.to_string())?;
	    Ok(())
	}

#[tauri::command]
pub fn record_session(
    state: State<'_, AppState>,
    key: String,
    session_id: String,
    agent: Option<String>,
) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let now = crate::sync::now_secs();
    conn.execute(
        "UPDATE tasks SET session_id = ?1, session_agent = ?2, session_at = ?3 WHERE key = ?4",
        rusqlite::params![session_id, agent.unwrap_or_default(), now, key],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn clear_session(state: State<'_, AppState>, key: String) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE tasks SET session_id = NULL, session_agent = NULL WHERE key = ?1",
        [key],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// 记录「交接任务」详情：由接入的 agent（claude / codex 等）在识别到用户「生成交接任务」类意图时调用，
/// 把交接上下文写入该 issue 卡片的 handoff 字段，供后续接手者直接在详情页查看。
#[tauri::command]
pub fn record_handoff(
    state: State<'_, AppState>,
    key: String,
    text: String,
) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE tasks SET handoff = ?1 WHERE key = ?2",
        rusqlite::params![text, key],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn get_settings(app: AppHandle, state: State<'_, AppState>) -> Result<Settings, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let db_path = crate::db::db_path(&app).map_err(|e| e.to_string())?;
    let accounts = crate::db::list_accounts(&conn)?;
    let active_account_id: i64 = crate::db::get_setting(&conn, "active_account_id")
        .parse()
        .unwrap_or(0);
    let view_mode = crate::db::get_setting(&conn, "view_mode");
    let view_mode = if view_mode.is_empty() { "single".to_string() } else { view_mode };
    let board_mode = crate::db::get_setting(&conn, "board_mode");
    let board_mode = if board_mode.is_empty() { "project".to_string() } else { board_mode };
    Ok(Settings {
        schedule_minutes: crate::db::get_setting(&conn, "schedule_minutes")
            .parse::<u64>()
            .unwrap_or(60)
            .max(5),
        gh_path: crate::db::get_setting(&conn, "gh_path"),
        login: crate::db::get_setting(&conn, "login"),
        org: crate::db::get_setting(&conn, "org"),
        last_sync_at: crate::db::get_setting(&conn, "last_sync_at")
            .parse::<i64>()
            .unwrap_or(0),
        db_path: db_path.to_string_lossy().to_string(),
        has_pat: !crate::db::get_setting(&conn, "pat_token").is_empty(),
        last_sync_error: crate::db::get_setting(&conn, "last_sync_error"),
        active_account_id,
        view_mode,
        board_mode,
        accounts,
        oauth_client_id: crate::db::get_setting(&conn, "oauth_client_id"),
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PatStatus {
    pub login: String,
    pub has_pat: bool,
}

/// 保存 GitHub Personal Access Token。空串视为清除。
/// 成功保存后立刻探测账号（`test_connection`），把 login 写入 `meta.login`，
/// 便于前端展示「当前账号」且不必泄漏 PAT 本体。
#[allow(dead_code)] // 由 `lib.rs::invoke_handler` 反射注册使用，编译期无可达调用
#[tauri::command]
pub fn save_pat(
    app: AppHandle,
    state: State<'_, AppState>,
    pat: String,
) -> Result<PatStatus, String> {
    let trimmed = pat.trim().to_string();
    if trimmed.is_empty() {
        // 用户点「清除」：清空 pat_token / login，并清掉 last_sync_error 中与 PAT 相关提示。
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        crate::db::set_setting(&conn, "pat_token", "")?;
        crate::db::set_setting(&conn, "login", "")?;
        crate::db::set_setting(&conn, "last_sync_error", "")?;
        return Ok(PatStatus { login: String::new(), has_pat: false });
    }
    // 先在锁外构造客户端（避免构造时阻塞 db 锁）；构造仅作 PAT 形式校验，
    // 真实 login 探测走 test_connection（v0.3.16 起构造不再自动探测）。
    let client = crate::github::GitHubClient::new(trimmed.clone(), String::new(), String::new())
        .map_err(|e| format!("PAT 验证失败: {}", e))?;
    let login = client.test_connection()?.login;
    {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        crate::db::set_setting(&conn, "pat_token", &trimmed)?;
        crate::db::set_setting(&conn, "login", &login)?;
        // 写入新 PAT 后清掉旧的同步错误——这次刷新才会用到新 token。
        crate::db::set_setting(&conn, "last_sync_error", "")?;
    }
    let _ = app;
    Ok(PatStatus { login, has_pat: true })
}

/// 测试当前已保存的 PAT 是否有效，返回账号。
/// 给设置面板「测试连接」按钮专用。
#[allow(dead_code)]
#[tauri::command]
pub fn test_pat(state: State<'_, AppState>) -> Result<PatStatus, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let pat = crate::db::get_setting(&conn, "pat_token");
    if pat.is_empty() {
        return Err("未配置 PAT，请先在设置面板粘贴".to_string());
    }
    // 取锁外构造（reqwest 的网络 IO 与 db 锁解耦）；构造后探测真实 login。
    drop(conn);
    let client = crate::github::GitHubClient::new(pat, String::new(), String::new())?;
    let probe = client.test_connection()?.login;
    Ok(PatStatus { login: probe, has_pat: true })
}

/// 清除 PAT（与 `save_pat` 传空串等价，但语义独立，便于前端显式调用）。
#[allow(dead_code)]
#[tauri::command]
pub fn clear_pat(state: State<'_, AppState>) -> Result<PatStatus, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    crate::db::set_setting(&conn, "pat_token", "")?;
    crate::db::set_setting(&conn, "login", "")?;
    crate::db::set_setting(&conn, "last_sync_error", "")?;
    Ok(PatStatus { login: String::new(), has_pat: false })
}

#[tauri::command]
pub fn save_settings(
    app: AppHandle,
    state: State<'_, AppState>,
    schedule_minutes: u64,
    gh_path: String,
) -> Result<Settings, String> {
    {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        crate::db::set_setting(&conn, "schedule_minutes", &schedule_minutes.max(5).to_string())?;
        crate::db::set_setting(&conn, "gh_path", &gh_path)?;
    }
    get_settings(app, state)
}

#[tauri::command]
pub fn open_in_browser(url: String) -> Result<(), String> {
    std::process::Command::new("open")
        .arg(&url)
        .spawn()
        .map_err(|e| format!("打开浏览器失败: {}", e))?;
    Ok(())
}

// ============================================================================
// v0.3.17+：GitHub OAuth Device Flow 登录
// ============================================================================

/// 保存 Device Flow 用的 OAuth client_id（注册 OAuth App 后填一次即可）。
#[allow(dead_code)]
#[tauri::command]
pub fn save_oauth_client_id(state: State<'_, AppState>, client_id: String) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    crate::db::set_setting(&conn, "oauth_client_id", client_id.trim())
}

/// 第 1 步：申请设备码。client_id 空时回退到已保存值。
#[allow(dead_code)]
#[tauri::command]
pub async fn device_login_start(
    state: State<'_, AppState>,
    client_id: String,
) -> Result<crate::oauth::DeviceLoginStart, String> {
    // 空入参 → 用已保存的；都没有则由 oauth::start 报错提示注册。
    let cid = if client_id.trim().is_empty() {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        crate::db::get_setting(&conn, "oauth_client_id")
    } else {
        client_id.trim().to_string()
    };
    tauri::async_runtime::spawn_blocking(move || crate::oauth::start(&cid))
        .await
        .map_err(|e| format!("登录任务异常: {e}"))?
}

/// 轮询结果（前端按 interval 反复调用本命令；**后端不 sleep**）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceLoginPoll {
    /// pending | slow_down | success | error
    pub status: String,
    /// 成功时填：授权账号的 GitHub login。
    pub login: String,
    /// 成功时填：新建/更新的账号 id。
    pub account_id: i64,
    /// 提示或错误信息。
    pub message: String,
}

/// 第 2 步：单次轮询。成功时**在后端**探测 login 并直接建账号——token 全程不回流前端。
#[allow(dead_code)]
#[tauri::command]
pub async fn device_login_poll(
    app: AppHandle,
    client_id: String,
    device_code: String,
    org: String,
    label: String,
) -> Result<DeviceLoginPoll, String> {
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = handle.state::<AppState>();
        let outcome = crate::oauth::poll_once(&client_id, &device_code)?;
        match outcome {
            crate::oauth::PollOutcome::Pending => Ok(DeviceLoginPoll {
                status: "pending".to_string(),
                login: String::new(),
                account_id: 0,
                message: String::new(),
            }),
            crate::oauth::PollOutcome::SlowDown => Ok(DeviceLoginPoll {
                status: "slow_down".to_string(),
                login: String::new(),
                account_id: 0,
                message: String::new(),
            }),
            crate::oauth::PollOutcome::Failed(msg) => Ok(DeviceLoginPoll {
                status: "error".to_string(),
                login: String::new(),
                account_id: 0,
                message: msg,
            }),
            crate::oauth::PollOutcome::Success(token) => {
                // 探测真实 login（token 有效才继续）。
                let probe_client = crate::github::GitHubClient::new(
                    token.clone(),
                    String::new(),
                    String::new(),
                )?;
                let login = probe_client
                    .test_connection()
                    .map_err(|e| format!("授权成功但探测账号失败: {}", e))?
                    .login;
                // 若调用方未指定 org，自动从 GitHub API 获取用户所属的第一个组织。
                let final_org = if org.trim().is_empty() {
                    probe_client.fetch_user_org().unwrap_or_default()
                } else {
                    org.trim().to_string()
                };
                // 建账号：同 login 已存在则更新 PAT + org（重新授权场景），否则插入。
                let conn = state.db.lock().map_err(|e| e.to_string())?;
                let existing: Option<i64> = {
                    let mut stmt = conn
                        .prepare("SELECT id FROM accounts WHERE login = ?1 ORDER BY id LIMIT 1")
                        .map_err(|e| e.to_string())?;
                    stmt.query_row([&login], |r| r.get(0)).ok()
                };
                let account_id = match existing {
                    Some(id) => {
                        // 更新 PAT 和 org（org 非空时覆盖，空时不改）
                        let org_opt = if final_org.is_empty() { None } else { Some(final_org.as_str()) };
                        crate::db::update_account(&conn, id, None, None, org_opt, Some(&token))?;
                        id
                    }
                    None => {
                        let final_label = if label.trim().is_empty() {
                            login.clone()
                        } else {
                            label.trim().to_string()
                        };
                        crate::db::insert_account(&conn, &final_label, &login, &final_org, &token)?
                    }
                };
                // 新账号若是首个，把 active 拨过去（与 add_account 行为一致）。
                let active: i64 = crate::db::get_setting(&conn, "active_account_id")
                    .parse()
                    .unwrap_or(0);
                if active == 0 {
                    crate::db::set_setting(&conn, "active_account_id", &account_id.to_string())?;
                }
                crate::db::set_setting(&conn, "last_sync_error", "")?;
                let _ = handle; // AppHandle 预留给后续事件通知；当前前端轮询即可。
                Ok(DeviceLoginPoll {
                    status: "success".to_string(),
                    login,
                    account_id,
                    message: String::new(),
                })
            }
        }
    })
    .await
    .map_err(|e| format!("轮询任务异常: {e}"))?
}

// ============================================================================
// v0.3.16+：多账号管理命令
// ============================================================================

/// 列出所有账号（不含 PAT 本体）。
#[allow(dead_code)]
#[tauri::command]
pub fn list_accounts(state: State<'_, AppState>) -> Result<Vec<Account>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    crate::db::list_accounts(&conn)
}

/// 添加账号：构造客户端探测真实 login（验证 PAT 有效），再写入 DB。
/// 若探测到的真实 login 与用户输入的 login 不一致，**仍接受**——PAT 的真实 login
/// 是权威；但同时把探测到的 login 回写到 DB 字段，确保 sync 时不会用错。
#[allow(dead_code)]
#[tauri::command]
pub fn add_account(
    state: State<'_, AppState>,
    label: String,
    login: String,
    org: String,
    pat: String,
) -> Result<Account, String> {
    let pat = pat.trim().to_string();
    if pat.is_empty() {
        return Err("PAT 不能为空".to_string());
    }
    // 锁外探测（避免阻塞 db 锁做网络 IO）；构造 + 探测真实 login + org。
    let probe_client = crate::github::GitHubClient::new(pat.clone(), String::new(), String::new())?;
    let probe_login = probe_client
        .test_connection()
        .map(|r| r.login)
        .map_err(|e| format!("PAT 验证失败: {}", e))?;
    // 用探测到的真实 login 作权威；用户输入的 login 仅作 hint。
    let final_login = if probe_login.is_empty() {
        login.trim().to_string()
    } else {
        probe_login
    };
    // 若调用方未指定 org，自动从 GitHub API 获取用户所属的第一个组织。
    let final_org = if org.trim().is_empty() {
        probe_client.fetch_user_org().unwrap_or_default()
    } else {
        org.trim().to_string()
    };
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let id = crate::db::insert_account(&conn, &label, &final_login, &final_org, &pat)?;
    // 若这是首个账号，把 active_account_id 拨到它。
    let active: i64 = crate::db::get_setting(&conn, "active_account_id")
        .parse()
        .unwrap_or(0);
    if active == 0 {
        crate::db::set_setting(&conn, "active_account_id", &id.to_string())?;
    }
    // 清掉旧的同步错误——这次同步才用到新账号的 PAT。
    crate::db::set_setting(&conn, "last_sync_error", "")?;
    let accounts = crate::db::list_accounts(&conn)?;
    accounts
        .into_iter()
        .find(|a| a.id == id)
        .ok_or_else(|| format!("账号 #{id} 创建后未找到"))
}

/// 更新账号字段；pat=None 表示不动，pat=Some("") 表示清空，pat=Some(s) 表示替换。
/// 若更新了 PAT，先在锁外探测验证，避免坏 token 入库。
#[allow(dead_code)]
#[tauri::command]
pub fn update_account(
    state: State<'_, AppState>,
    id: i64,
    label: Option<String>,
    login: Option<String>,
    org: Option<String>,
    pat: Option<String>,
) -> Result<Account, String> {
    if let Some(p) = pat.as_ref() {
        let p = p.trim();
        if !p.is_empty() {
            // 锁外探测（构造 + test_connection 校验 PAT 有效）
            let probe = crate::github::GitHubClient::new(p.to_string(), String::new(), String::new())
                .and_then(|c| c.test_connection())
                .map_err(|e| format!("新 PAT 验证失败: {}", e))?;
            let _ = probe;
        }
    }
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    crate::db::update_account(
        &conn,
        id,
        label.as_deref(),
        login.as_deref(),
        org.as_deref(),
        pat.as_deref(),
    )?;
    let accounts = crate::db::list_accounts(&conn)?;
    accounts
        .into_iter()
        .find(|a| a.id == id)
        .ok_or_else(|| format!("账号 #{id} 不存在"))
}

/// 删除账号；默认账号不可删。
#[allow(dead_code)]
#[tauri::command]
pub fn delete_account(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    crate::db::delete_account(&conn, id)?;
    // 若删的是激活账号，回退到默认账号或首个账号。
    let active: i64 = crate::db::get_setting(&conn, "active_account_id")
        .parse()
        .unwrap_or(0);
    if active == id {
        if let Ok(new_id) = crate::db::default_account_id(&conn) {
            crate::db::set_setting(&conn, "active_account_id", &new_id.to_string())?;
        } else {
            crate::db::set_setting(&conn, "active_account_id", "0")?;
        }
    }
    Ok(())
}

/// 测试某账号的 PAT 是否仍有效；返回账号信息。
#[allow(dead_code)]
#[tauri::command]
pub fn test_account_pat(
    state: State<'_, AppState>,
    id: i64,
) -> Result<PatStatus, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let (login, org, pat) = crate::db::get_account_pat(&conn, id)?;
    drop(conn);
    if pat.is_empty() {
        return Err(format!("账号 #{id} ({login} / {org}) 未配置 PAT"));
    }
    let client = crate::github::GitHubClient::new(pat, String::new(), String::new())?;
    let probe = client.test_connection()?.login;
    Ok(PatStatus { login: probe, has_pat: true })
}

/// 把某账号设为默认；同时激活它。
#[allow(dead_code)]
#[tauri::command]
pub fn set_default_account(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    crate::db::set_default_account(&conn, id)?;
    crate::db::set_setting(&conn, "active_account_id", &id.to_string())?;
    Ok(())
}

/// 设置激活账号 id；后续同步与默认视图都基于它。
#[allow(dead_code)]
#[tauri::command]
pub fn set_active_account(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    // 校验账号存在
    let exists: i64 = conn
        .query_row("SELECT COUNT(*) FROM accounts WHERE id = ?1", [id], |r| r.get(0))
        .unwrap_or(0);
    if exists == 0 {
        return Err(format!("账号 #{id} 不存在"));
    }
    crate::db::set_setting(&conn, "active_account_id", &id.to_string())?;
    Ok(())
}

/// 设置视图模式：'single' / 'all'。
#[allow(dead_code)]
#[tauri::command]
pub fn set_view_mode(state: State<'_, AppState>, mode: String) -> Result<(), String> {
    if mode != "single" && mode != "all" {
        return Err(format!("非法视图模式: {mode}（应为 single / all）"));
    }
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    crate::db::set_setting(&conn, "view_mode", &mode)?;
    Ok(())
}

/// 设置看板列模式：'status' / 'project' / 'custom'。
	#[tauri::command]
	pub fn set_board_mode(state: State<'_, AppState>, mode: String) -> Result<(), String> {
	    if mode != "status" && mode != "project" && mode != "custom" {
	        return Err(format!("非法看板模式: {mode}（应为 status / project / custom）"));
	    }
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    crate::db::set_setting(&conn, "board_mode", &mode)?;
    Ok(())
}

// ============================================================================
// v0.3.19+：关于页面 —— 当前版本号 + 检查更新（GitHub Releases）
// ============================================================================

/// 返回当前应用版本号。来源为 Rust 包版本（Cargo.toml `version`），
/// 而非前端硬编码——保证「关于」页展示的版本与发布版本号一致。
#[tauri::command]
pub fn get_app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// 「检查更新」返回信息。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckUpdate {
    /// 当前版本（Cargo 包版本）。
    pub current: String,
    /// GitHub 最新 release 的版本号（去掉前缀 `v`）。
    pub latest: String,
    /// 当前是否已是最新。
    pub up_to_date: bool,
    /// 最新 release 页面地址，用于引导跳转下载。
    pub url: String,
    /// 非空表示检查失败（网络 / 解析等），前端据此展示错误。
    pub error: String,
}

/// 轻量检查更新：调用 GitHub Releases API `releases/latest`，对比最新/当前版本。
/// 只读公开数据仓库，无需 PAT；用 `spawn_blocking` 避免阻塞主线程（reqwest 为 blocking）。
#[tauri::command]
pub async fn check_latest_release() -> Result<CheckUpdate, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let current = env!("CARGO_PKG_VERSION").to_string();
        let client = reqwest::blocking::Client::builder()
            .user_agent(format!("taskboard/{current}"))
            .timeout(Duration::from_secs(20))
            .build()
            .map_err(|e| format!("构造 HTTP 客户端失败: {e}"))?;
        let resp: serde_json::Value = client
            .get("https://api.github.com/repos/ShawnLiuSZ/task-dashborad/releases/latest")
            .send()
            .map_err(|e| format!("检查更新失败（网络）：{e}"))?
            .error_for_status()
            .map_err(|e| format!("检查更新失败（GitHub 返回错误）：{e}"))?
            .json()
            .map_err(|e| format!("检查更新失败（解析响应）：{e}"))?;
        let latest = resp
            .get("tag_name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim_start_matches('v')
            .to_string();
        let url = resp
            .get("html_url")
            .and_then(|v| v.as_str())
            .unwrap_or("https://github.com/ShawnLiuSZ/task-dashborad/releases")
            .to_string();
        let up_to_date = !latest.is_empty() && latest == current;
        Ok(CheckUpdate {
            current,
            latest,
            up_to_date,
            url,
            error: String::new(),
        })
    })
    .await
    .map_err(|e| format!("检查更新线程异常: {e}"))?
}

// ============================================================================
// v0.3.20+：Label→Status 映射管理
// ============================================================================

/// 列出所有 label 映射。
#[tauri::command]
pub fn list_label_mappings(state: State<'_, AppState>) -> Result<Vec<LabelMapping>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    crate::db::list_label_mappings(&conn)
}

/// 新增或更新一条 label 映射。
#[tauri::command]
pub fn upsert_label_mapping(
    state: State<'_, AppState>,
    org: String,
    repo: String,
    label: String,
    status: String,
    order_index: i64,
) -> Result<LabelMapping, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let id = crate::db::upsert_label_mapping(
        &conn,
        &LabelMappingInput { org, repo, label, status, order_index },
    )?;
    // 返回完整对象
    let mut stmt = conn
        .prepare("SELECT id, org, repo, label, status, order_index, created_at, updated_at FROM label_mappings WHERE id = ?1")
        .map_err(|e| e.to_string())?;
    let mapping = stmt
        .query_row([id], |r| {
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
        .map_err(|e| e.to_string())?;
    Ok(mapping)
}

/// 删除一条 label 映射。
#[tauri::command]
pub fn delete_label_mapping(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    crate::db::delete_label_mapping(&conn, id)
}

/// 获取某账号的 Label 列视图配置（按 order_index 排序）。
/// 用于前端 Label 列模式动态生成列。
#[tauri::command]
pub fn get_label_columns_for_account(
    state: State<'_, AppState>,
    account_id: i64,
) -> Result<Vec<LabelMapping>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    crate::db::get_label_columns_for_account(&conn, account_id)
}

/// 诊断：测试当前账号的 Project Status 拉取（用于排查 "未标注" 问题）。
#[tauri::command]
pub fn diagnose_project_status(
    state: State<'_, AppState>,
    account_id: i64,
) -> Result<serde_json::Value, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let (login, org, pat) = crate::db::get_account_pat(&conn, account_id)?;
    drop(conn);

    if pat.is_empty() {
        return Err("账号未配置 PAT".to_string());
    }
    let client = crate::github::GitHubClient::new(pat, login.clone(), org.clone())?;

    // 1. 拉取全部 project
    let all_projects = client.fetch_all_projects()?;
    let project_ids: Vec<String> = all_projects.iter().map(|p| p.0.clone()).collect();

    // 2. 用所有 project 拉取 status
    let status_map = client.fetch_project_status(&project_ids)?;

    // 3. 查询每个 project 的字段定义（诊断用）
    let mut projects_info = Vec::new();
    for (id, name, num, owner) in &all_projects {
        let fields_q = format!(
            r#"query {{ node(id:"{id}") {{ ... on ProjectV2 {{ fields(first:20) {{ nodes {{ ... on ProjectV2SingleSelectField {{ name options {{ name }} }} ... on ProjectV2IterationField {{ name }} ... on ProjectV2NumberField {{ name }} }} }} }} }} }}"#,
            id = id
        );
        let fields: Vec<String> = client.graphql(&fields_q)
            .ok()
            .and_then(|v| v["data"]["node"]["fields"]["nodes"].as_array().cloned())
            .unwrap_or_default()
            .iter()
            .filter_map(|n| n["name"].as_str().map(|s| s.to_string()))
            .collect();
        projects_info.push(serde_json::json!({
            "github_id": id,
            "name": name,
            "number_of_items": num,
            "owner_type": owner,
            "fields": fields,
        }));
    }

    Ok(serde_json::json!({
        "org": org,
        "login": login,
        "projects": projects_info,
        "status_count": status_map.len(),
        "sample_statuses": status_map.iter().take(10).collect::<Vec<_>>(),
    }))
}

/// 列出某账号下已存储的项目（来自 projects 表）。
#[tauri::command]
pub fn list_projects(state: State<'_, AppState>, account_id: i64) -> Result<Vec<crate::db::Project>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    crate::db::list_projects(&conn, account_id)
}

/// 列出某账号下所有项目的 Status 选项（来自 project_statuses 表）。
#[tauri::command]
pub fn list_project_statuses(state: State<'_, AppState>, account_id: i64) -> Result<Vec<crate::db::ProjectStatus>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    crate::db::list_project_statuses(&conn, account_id)
}

// ============================================================================
// v0.3.23+：同步日志管理
// ============================================================================

/// 列出同步日志（最近 N 条），按 created_at 降序。
#[tauri::command]
pub fn list_sync_logs(state: State<'_, AppState>, limit: Option<i64>) -> Result<Vec<crate::db::SyncLog>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let limit = limit.unwrap_or(50).max(1).min(500);
    crate::db::list_sync_logs(&conn, limit)
}

/// 清理超过 7 天的同步日志。
#[tauri::command]
pub fn prune_sync_logs(state: State<'_, AppState>) -> Result<usize, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let now = crate::sync::now_secs();
    crate::db::prune_sync_logs(&conn, now)
}

// ============================================================================
// v0.3.24+：记事本管理
// ============================================================================

/// 列出所有记事。
#[tauri::command]
pub fn list_notes(state: State<'_, AppState>) -> Result<Vec<crate::db::Note>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    crate::db::list_notes(&conn)
}

/// 新增记事。
#[tauri::command]
pub fn add_note(state: State<'_, AppState>, content: String, label: Option<String>) -> Result<crate::db::Note, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let now = crate::sync::now_secs();
    let label = label.unwrap_or_else(|| "low".to_string());
    crate::db::add_note(&conn, &content, &label, now)
}

/// 更新记事内容。
#[tauri::command]
pub fn update_note(state: State<'_, AppState>, id: i64, content: String) -> Result<crate::db::Note, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let now = crate::sync::now_secs();
    crate::db::update_note(&conn, id, &content, now)
}

/// 更新记事标签。
#[tauri::command]
pub fn update_note_label(state: State<'_, AppState>, id: i64, label: String) -> Result<crate::db::Note, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    crate::db::update_note_label(&conn, id, &label)
}

/// 删除记事。
#[tauri::command]
pub fn delete_note(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    crate::db::delete_note(&conn, id)
}

// v0.3.27+：记事本导入 / 导出（防止破坏性更新时数据丢失）。

/// 导出记事为 JSON 文件，返回写入的完整路径与条数。
///
/// 写入位置固定为应用数据目录下 `notes-backup/`（macOS：
/// `~/Library/Application Support/com.shawnliu.taskboard/notes-backup/`），
/// 文件名 `notes-backup-YYYYMMDD-HHMMSS.json`。仅含记事业务数据，不含 token 等敏感信息。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportNotesResult {
    pub path: String,
    pub count: usize,
}

#[tauri::command]
pub fn export_notes(state: State<'_, AppState>) -> Result<ExportNotesResult, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let notes = crate::db::list_notes(&conn)?;

    let dir = crate::db::data_dir()?.join("notes-backup");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建备份目录失败: {e}"))?;

    let now = crate::sync::now_secs();
    let ts = format!(
        "{}{}",
        time_str(now, "%Y%m%d"),
        time_str(now, "%H%M%S")
    );
    let path = dir.join(format!("notes-backup-{ts}.json"));

    #[derive(serde::Serialize)]
    struct Payload<'a> {
        version: u32,
        exported_at: i64,
        notes: &'a [crate::db::Note],
    }
    let payload = Payload {
        version: 1,
        exported_at: now,
        notes: &notes,
    };
    let json = serde_json::to_string_pretty(&payload).map_err(|e| format!("序列化失败: {e}"))?;
    std::fs::write(&path, json).map_err(|e| format!("写入导出文件失败: {e}"))?;

    Ok(ExportNotesResult {
        path: path.to_string_lossy().to_string(),
        count: notes.len(),
    })
}

/// 从 JSON 文本导入记事（由前端 file input 读取文件内容后传入，避免依赖文件系统权限）。
/// 按内容 `content` 去重：已存在的跳过，其余插入并保留原始创建/更新时间。
/// 返回导入条数与跳过条数。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportNotesResult {
    pub imported: usize,
    pub skipped: usize,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImportNoteItem {
    #[serde(default)]
    content: String,
    #[serde(default)]
    label: String,
    #[serde(default)]
    created_at: i64,
    #[serde(default)]
    updated_at: i64,
}

#[derive(Debug, serde::Deserialize)]
struct ImportFile {
    #[allow(dead_code)]
    version: Option<u32>,
    notes: Vec<ImportNoteItem>,
}

#[tauri::command]
pub fn import_notes(state: State<'_, AppState>, json: String) -> Result<ImportNotesResult, String> {
    let file: ImportFile =
        serde_json::from_str(&json).map_err(|e| format!("解析导入数据失败: {e}"))?;

    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let now = crate::sync::now_secs();
    let mut imported = 0usize;
    let mut skipped = 0usize;
    for n in file.notes {
        if n.content.trim().is_empty() {
            continue;
        }
        let label = if n.label.is_empty() {
            "low".to_string()
        } else {
            n.label
        };
        let created = if n.created_at > 0 { n.created_at } else { now };
        let updated = if n.updated_at > 0 { n.updated_at } else { created };
        match crate::db::import_note(&conn, &n.content, &label, created, updated) {
            Ok(true) => imported += 1,
            Ok(false) => skipped += 1,
            Err(e) => return Err(e),
        }
    }
    Ok(ImportNotesResult { imported, skipped })
}

// ============================================================================
// v0.3.28+：自定义列映射（按账号配置看板列）
// ============================================================================

/// 列出某账号下所有自定义列。
#[tauri::command]
pub fn list_account_columns(
    state: State<'_, AppState>,
    account_id: i64,
) -> Result<Vec<AccountColumn>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    crate::db::list_account_columns(&conn, account_id)
}

/// 保存某账号的列配置（全量替换）。
#[tauri::command]
pub fn save_account_columns(
    state: State<'_, AppState>,
    account_id: i64,
    columns: Vec<AccountColumn>,
) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    crate::db::save_account_columns(&conn, account_id, &columns)
}

/// `now_secs` 按秒格式化为指定 `strftime` 模式（用于导出文件名）。
fn time_str(ts: i64, fmt: &str) -> String {
    let secs = ts as i64;
    let days = secs.div_euclid(86400);
    let rem = secs.rem_euclid(86400);
    let (y, m, d) = civil_from_days(days);
    let h = rem / 3600;
    let mi = (rem % 3600) / 60;
    let s = rem % 60;
    match fmt {
        "%Y%m%d" => format!("{y:04}{m:02}{d:02}"),
        "%H%M%S" => format!("{h:02}{mi:02}{s:02}"),
        _ => format!("{y:04}{m:02}{d:02}-{h:02}{mi:02}{s:02}"),
    }
}

/// 自 1970-01-01 的 days 起算 civil date（EPOCH 兼容，无依赖）。
fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719468;
    let era = z.div_euclid(146097);
    let doe = z.rem_euclid(146097);
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

#[cfg(test)]
mod tests {
    use rusqlite::Connection;

    /// 打开内存库临时文件的连接，并初始化 schema。
    fn mem_conn() -> Connection {
        let path = std::env::temp_dir().join(format!(
            "taskboard_cmds_test_{}.db",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&path);
        let conn = crate::db::open_db(&path).expect("打开测试库");
        // 测试进程结束后清理
        let _ = std::fs::remove_file(&path);
        conn
    }

    // 导出文件名的时间戳：epoch 0、近期典型值。
    #[test]
    fn time_str_formats_epoch_and_boundaries() {
        assert_eq!(super::time_str(0, "%Y%m%d"), "19700101");
        assert_eq!(super::time_str(0, "%H%M%S"), "000000");
        // 2025-01-05 08:00:00 UTC
        assert_eq!(super::time_str(1736064000i64, "%Y%m%d"), "20250105");
        assert_eq!(super::time_str(1736064000i64, "%H%M%S"), "080000");
        // 1972-12-19 08:00:00 UTC
        assert_eq!(super::time_str(93600000, "%Y%m%d"), "19721219");
    }

    // 导入去重：相同 content 只插入一次，保留时间字段。
    #[test]
    fn import_note_dedupes_by_content() {
        let conn = mem_conn();
        let first = crate::db::import_note(&conn, "hello", "low", 100, 200).unwrap();
        assert!(first, "首次应插入");
        let dup = crate::db::import_note(&conn, "hello", "high", 300, 400).unwrap();
        assert!(!dup, "重复 content 应跳过");
        let other = crate::db::import_note(&conn, "world", "medium", 500, 600).unwrap();
        assert!(other, "不同 content 应插入");
        let all = crate::db::list_notes(&conn).unwrap();
        assert_eq!(all.len(), 2, "应有 2 条（hello + world）");
        let hello = all.iter().find(|n| n.content == "hello").unwrap();
        assert_eq!(hello.created_at, 100);
        assert_eq!(hello.updated_at, 200);
        assert_eq!(hello.label, "low");
    }
}

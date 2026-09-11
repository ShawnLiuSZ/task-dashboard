use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use rusqlite::Connection;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager,
};

mod commands;
mod common;
pub mod db;
mod github;
mod hooks;
mod mcp;
mod oauth;
mod sync;

/// #101：macOS 首次启动自动清除自身可执行文件上的 `com.apple.quarantine`。
///
/// 背景：本 App 为 ad-hoc 签名（`signingIdentity = "-"`，未公证）。Gatekeeper 会对带
/// quarantine 标记的二进制做首次评估，使 MCP 客户端 spawn 主二进制（`taskboard mcp`）时
/// 拖慢 / 拦截握手 → `connection timed out after 30000ms`。
///
/// 关键事实：当前登录用户拥有自身 bundle，移除自身文件的 quarantine **无需 sudo**。
/// 因此只要 GUI 打开过一次（Gatekeeper 放行一次），即可在启动时自动递归清除，此后 MCP
/// 子进程 spawn 不再触发慢评估。返回是否发生清除，供前端弹一次性提示。
#[cfg(target_os = "macos")]
pub fn autoclear_self_quarantine() -> bool {
    use std::process::Command;

    let Ok(exe) = std::env::current_exe() else {
        return false;
    };
    let path = exe.to_string_lossy().into_owned();

    let has_quarantine = |p: &str| -> bool {
        Command::new("xattr")
            .arg("-l")
            .arg(p)
            .output()
            .ok()
            .map(|o| String::from_utf8_lossy(&o.stdout).contains("com.apple.quarantine"))
            .unwrap_or(false)
    };

    if !has_quarantine(&path) {
        return false;
    }
    // 递归清除自身 quarantine（当前用户拥有自身 bundle，免 root）。
    let removed = Command::new("xattr")
        .arg("-dr")
        .arg("com.apple.quarantine")
        .arg(&path)
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    !has_quarantine(&path) || removed
}

/// 启动时执行 #101 自动清除并可外发一次性提示事件。
#[cfg(target_os = "macos")]
pub fn autoclear_self_quarantine_and_notify(app: &AppHandle) {
    if autoclear_self_quarantine() {
        let msg = "已自动清除应用的 Gatekeeper 隔离标记，重新连接 MCP 即可。";
        let _ = app.emit("quarantine-cleared", msg);
        eprintln!("[#101] quarantine cleared for self executable");
    }
}

/// 同步进行中去重标志：true 表示已有一次同步正在跑，后续触发直接跳过。
/// 防止 Tray「立即同步」、启动同步、定时同步、前端按钮并发时背靠背跑多次全量同步。
pub struct AppState {
    pub db: Mutex<Connection>,
    pub syncing: AtomicBool,
}

const TRAY_ID: &str = "main";
pub const SYNCED_EVENT: &str = "taskboard://synced";
/// #181：App 内写入（看板状态 / session / handoff）后通知前端重查。
/// MCP 子进程无 AppHandle 发不出此事件，仍靠前端聚焦 + 轮询兜底。
pub const TASKS_CHANGED_EVENT: &str = "taskboard://tasks-changed";

fn schedule_minutes(app: &AppHandle) -> u64 {
    let state = app.state::<AppState>();
    let mins = match state.db.lock() {
        Ok(conn) => db::get_setting(&conn, "schedule_minutes")
            .parse::<u64>()
            .unwrap_or(60)
            .max(5),
        Err(_) => 60,
    };
    mins
}

fn toggle_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        if w.is_visible().unwrap_or(false) {
            let _ = w.hide();
        } else {
            let _ = w.show();
            let _ = w.set_focus();
        }
    }
}

fn refresh_tray(app: &AppHandle) {
    let count: i64 = {
        let state = app.state::<AppState>();
        let n = match state.db.lock() {
            Ok(conn) => conn
                .query_row(
                    "SELECT COUNT(*) FROM tasks WHERE status = 'doing' AND candidate_done = 0",
                    [],
                    |r| r.get(0),
                )
                .unwrap_or(0),
            Err(_) => 0,
        };
        n
    };
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_title(if count > 0 { Some(count.to_string()) } else { None });
        let _ = tray.set_tooltip(Some(format!("TaskBoard · 处理中 {}", count)));
    }
}

/// 同步进行中 RAII 标记：函数返回（含提前 return）时自动复位 `syncing`。
/// `acquire` 返回 `None` 表示已有同步在跑（去重），调用方应直接跳过本次触发。
pub(crate) struct SyncGuard<'a>(pub(crate) &'a AtomicBool);
impl<'a> SyncGuard<'a> {
    pub(crate) fn acquire(flag: &'a AtomicBool) -> Option<Self> {
        if flag.swap(true, Ordering::SeqCst) {
            None
        } else {
            Some(SyncGuard(flag))
        }
    }
}
impl Drop for SyncGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sync_guard_dedupes_concurrent_acquisition() {
        let flag = AtomicBool::new(false);
        let a = SyncGuard::acquire(&flag).expect("首次应可获取");
        // 已有 guard 持有期间，再次获取应去重返回 None
        assert!(SyncGuard::acquire(&flag).is_none(), "并发第二次获取应被去重");
        drop(a);
        // guard 释放后应能再次获取
        assert!(SyncGuard::acquire(&flag).is_some(), "释放后应可重新获取");
        assert!(!flag.load(Ordering::SeqCst), "释放后标志应复位");
    }
}

/// 打开专用于同步的独立连接。
///
/// 同步会跨大量 GitHub 网络 I/O 反复写库，若与 UI 命令共享 `AppState.db` 的
/// `Mutex<Connection>`，同步期间所有读取命令（设置/账号/同步日志/自定义列等面板）
/// 都要排队等锁——这些命令又跑在主线程，表现为 macOS beachball、鼠标卡死转圈。
/// 改为独立连接后，同步不再占用共享锁：WAL + `busy_timeout` 保证多连接并发安全
/// （读不阻塞，写互斥按 busy_timeout 依次排队）。
fn open_sync_conn(app: &AppHandle) -> Result<Connection, String> {
    db::open_db(&db::db_path(app)?)
}

/// 执行一次同步，并刷新菜单栏角标、通知前端刷新列表。
/// `trigger_type`: "startup" | "auto" | "manual" — 用于同步日志记录触发来源。
pub fn run_sync(app: &AppHandle, trigger_type: &str) -> Option<sync::SyncResult> {
    // 并发去重。已有同步在跑（Tray/启动/定时/前端按钮并发触发）时直接跳过本次，
    // 避免背靠背跑多次全量同步：既放大 GitHub 限流又阻塞编辑。
    let state = app.state::<AppState>();
    let _in_progress = SyncGuard::acquire(&state.syncing)?;

    // 同步使用独立连接，避免长持有共享 `AppState.db` 的 Mutex（见 open_sync_conn 注释）。
    let conn = match open_sync_conn(app) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[sync] 打开同步连接失败: {}", e);
            return None;
        }
    };

    // 检查是否有可用账号（accounts 表）或旧版 PAT（兼容）。
    // 不存在则跳过本次、记错误、清错误信息。
    // 之所以跳过而非报错：避免自动同步在用户未配置时反复循环报错刷屏。
    let has_accounts = {
        let accounts = db::list_accounts(&conn).unwrap_or_default();
        !accounts.is_empty() || !db::get_setting(&conn, "pat_token").is_empty()
    };
    if !has_accounts {
        let _ = db::set_setting(
            &conn,
            "last_sync_error",
            "未配置 GitHub 账号，请在账号管理中添加账号",
        );
        return None;
    }
    let result = match sync::run(&conn, trigger_type) {
        Ok(r) => {
            // 成功同步：清掉旧错误信息，banner 自动消失。
            let _ = db::set_setting(&conn, "last_sync_error", "");
            Some(r)
        }
        Err(e) => {
            eprintln!("[sync] 同步失败: {}", e);
            let _ = db::set_setting(&conn, "last_sync_error", &e);
            None
        }
    };
    refresh_tray(app);
    if let Some(res) = result {
        let _ = app.emit(SYNCED_EVENT, res.clone());
        Some(res)
    } else {
        None
    }
}

/// MCP 子命令入口：argv 含 `mcp` 时由 `main.rs` 调用，以 stdio JSON-RPC 进程运行，
/// 复用与 GUI 相同的本地 SQLite 数据库，不启动窗口。
pub fn run_mcp() {
    mcp::run();
}

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            // #101：macOS 首启自动清除自身 quarantine，免 sudo 修复 MCP 连接超时。
            #[cfg(target_os = "macos")]
            autoclear_self_quarantine_and_notify(app.handle());

            // #206：不再启动自动注册全局 hooks——接入一律由用户在设置页手动一键安装。
            let handle = app.handle().clone();
            let conn = db::init(&handle).map_err(|e| {
                Box::new(std::io::Error::new(std::io::ErrorKind::Other, e))
                    as Box<dyn std::error::Error>
            })?;
            app.manage(AppState {
                db: Mutex::new(conn),
                syncing: AtomicBool::new(false),
            });

            let show_item = MenuItem::with_id(app, "show", "显示看板", true, None::<&str>)?;
            let sync_item = MenuItem::with_id(app, "sync", "立即同步", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &sync_item, &quit_item])?;

            let mut builder = TrayIconBuilder::with_id(TRAY_ID)
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "show" => toggle_window(app),
                    "sync" => {
                        let h = app.clone();
                        thread::spawn(move || {
                            run_sync(&h, "manual");
                        });
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        toggle_window(tray.app_handle());
                    }
                });

            if let Some(icon) = app.default_window_icon().cloned() {
                builder = builder.icon(icon);
            }
            builder.build(app)?;

            let h_startup = handle.clone();
            thread::spawn(move || {
                thread::sleep(Duration::from_secs(2));
                run_sync(&h_startup, "startup");
            });

            let h_tick = handle.clone();
            thread::spawn(move || loop {
                let mins = schedule_minutes(&h_tick);
                thread::sleep(Duration::from_secs(mins * 60));
                run_sync(&h_tick, "auto");
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_tasks,
            commands::sync_now,
            commands::update_task_status,
            commands::record_session,
            commands::clear_session,
            commands::record_handoff,
            // #214：认领任务（首个 GitHub 写回操作，用户确认后显式调用）。
            commands::claim_issue,
            commands::get_settings,
            commands::save_settings,
            commands::open_in_browser,
            // v0.3.15：PAT 管理（保留兼容，单账号视图仍可用）。
            commands::save_pat,
            commands::test_pat,
            commands::clear_pat,
            // v0.3.16+：多账号管理。
            commands::list_accounts,
            commands::add_account,
            commands::update_account,
            commands::delete_account,
            commands::test_account_pat,
            commands::set_default_account,
            commands::set_active_account,
            commands::set_view_mode,
            // v0.3.17+：GitHub OAuth Device Flow 登录。
            commands::save_oauth_client_id,
            commands::device_login_start,
            commands::device_login_poll,
            // v0.3.19+：关于页面 —— 当前版本号 + 检查更新。
            commands::get_app_version,
            commands::check_latest_release,
            // v0.3.20+：Label→Status 映射管理。
            commands::list_label_mappings,
            commands::upsert_label_mapping,
            commands::delete_label_mapping,
            // v0.3.21+：Label 列视图 + 看板模式切换。
            commands::get_label_columns_for_account,
            commands::set_account_board_mode,
            // v0.3.22+：Project Status 诊断。
            commands::diagnose_project_status,
            commands::list_projects,
            commands::list_project_statuses,
            // v0.3.23+：同步日志管理。
            commands::list_sync_logs,
            commands::prune_sync_logs,
            commands::clear_sync_logs,
            // v0.3.24+：记事本管理。
            commands::list_notes,
            commands::add_note,
            commands::update_note,
            commands::update_note_label,
            commands::delete_note,
            // v0.3.27+：记事本导出 / 导入。
            commands::export_notes,
            commands::import_notes,
            // v0.3.28+：自定义列映射（按账号配置看板列）。
            commands::list_account_columns,
            commands::save_account_columns,
            // #177：一键安装/卸载 agent 看板 hooks（claude/opencode × 项目/全局）。
            // 实现参考 clawd-on-desk 的 Settings → Agents：per-agent 安装器 + 跳过未安装 host。
            hooks::install_agent_hooks,
            hooks::uninstall_agent_hooks,
            hooks::get_agent_hooks_status,
        ])
        .run(tauri::generate_context!())
        .expect("TaskBoard 启动失败");
}

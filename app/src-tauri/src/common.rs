//! 任务写操作公共逻辑（v0.3.49，#147）。
//!
//! `commands.rs`（Tauri 命令）与 `mcp.rs`（MCP stdio）曾各写一遍状态校验、
//! session/handoff SQL，逻辑已分叉。本模块是唯一权威实现，两边只做薄包装
//! （参数形态与“任务不存在”时的报错策略保留各自原有行为）。
//!
//! v0.3.49（#149）：追加日志门控与浏览器外链白名单。

use rusqlite::Connection;

/// 检查是否启用详细日志（TASKBOARD_LOG=1 或 TASKBOARD_LOG=debug）。
/// MCP 调用时默认静默，仅在排障时显式开启。
/// （自 `db.rs::verbose_enabled` 迁移至此，全仓统一入口。）
pub fn verbose_enabled() -> bool {
    std::env::var("TASKBOARD_LOG")
        .map(|v| matches!(v.as_str(), "1" | "debug" | "verbose" | "true"))
        .unwrap_or(false)
}

/// 门控日志：默认静默（release / MCP stdio 不刷屏），`TASKBOARD_LOG=1` 时输出。
/// 诊断类 `eprintln!` 一律走本宏；真正的错误走结构化通道
/// （同步结果 warning、MCP JSON-RPC 错误、`lib.rs` 的启动/同步失败日志）。
#[macro_export]
macro_rules! tlog {
    ($($arg:tt)*) => {
        if $crate::common::verbose_enabled() {
            eprintln!($($arg)*)
        }
    };
}

/// 浏览器外链白名单校验：仅放行 `https://github.com/` 与企业版 `*.ghe.com`。
/// 返回 trim 后的 URL。零新依赖，手写最小解析（只取 scheme + host）。
pub fn validate_browser_url(url: &str) -> Result<String, String> {
    let u = url.trim().to_string();
    let rest = u
        .strip_prefix("https://")
        .ok_or_else(|| format!("仅允许打开 https 外链: {u}"))?;
    let host = rest.split('/').next().unwrap_or("");
    if host.eq_ignore_ascii_case("github.com") || host.to_lowercase().ends_with(".ghe.com") {
        Ok(u)
    } else {
        Err(format!("仅允许打开 GitHub 链接: {u}"))
    }
}

/// RFC3339 "YYYY-MM-DDTHH:MM:SSZ" → Unix 秒；空/解析失败返回 0。
/// v0.3.50 (#155)：`tasks.updated_at` 由 TEXT 改为 INTEGER 秒后，同步写入前用此函数换算。
pub fn iso8601_to_secs(s: &str) -> i64 {
    let s = s.trim();
    if s.len() < 19 {
        return 0;
    }
    let mut parts = s.split(&['T', 'Z']);
    let date = parts.next().unwrap_or("");
    let time = parts.next().unwrap_or("");
    let mut date_parts = date.split('-');
    let y = date_parts.next().and_then(|s| s.parse::<i32>().ok()).unwrap_or(0);
    let m = date_parts.next().and_then(|s| s.parse::<u32>().ok()).unwrap_or(0);
    let d = date_parts.next().and_then(|s| s.parse::<u32>().ok()).unwrap_or(0);
    let mut time_parts = time.split(':');
    let h = time_parts.next().and_then(|s| s.parse::<u32>().ok()).unwrap_or(0);
    let mi = time_parts.next().and_then(|s| s.parse::<u32>().ok()).unwrap_or(0);
    let sec = time_parts.next().and_then(|s| s.parse::<u32>().ok()).unwrap_or(0);
    if y < 1970 || m < 1 || m > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || sec > 59 {
        return 0;
    }
    // 1970-01-01 起算的天数（Gregorian，无历法库依赖）
    const DAYS_BEFORE_MONTH: [i64; 12] = [
        0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334,
    ];
    let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
    let month_adjust = if leap && m > 2 { 1 } else { 0 };
    let days = (y - 1970) as i64 * 365
        + ((y - 1) / 4 - 1970 / 4) as i64
        - ((y - 1) / 100 - 1970 / 100) as i64
        + ((y - 1) / 400 - 1970 / 400) as i64
        + DAYS_BEFORE_MONTH[(m - 1) as usize]
        + month_adjust
        + (d as i64 - 1);
    days * 86400 + h as i64 * 3600 + mi as i64 * 60 + sec as i64
}

// ============================================================================
// v0.3.53 (#114 P1)：跨进程任务写入标记
// ============================================================================

/// `meta` 表中记录「最后一次任务写操作」的 key（毫秒时间戳）。
pub const LAST_TASK_WRITE_TS_KEY: &str = "last_task_write_ts";

/// 当前时间（毫秒）。用毫秒而非秒：MCP 批量改多个任务可能落在同一秒内，
/// 秒级精度会让 GUI 轮询漏掉后一次变更。
pub fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 读取最后一次任务写操作时间戳；未写过返回 0。
pub fn last_task_write_ts(conn: &Connection) -> i64 {
    crate::db::get_setting(conn, LAST_TASK_WRITE_TS_KEY)
        .parse::<i64>()
        .unwrap_or(0)
}

/// Bump「最后一次任务写操作」时间戳。
///
/// 放在公共模块而非 `commands.rs`：MCP（`mcp.rs`）与 GUI 走的是同一批写函数，
/// 只有写在这里才能保证两个进程的写入都被记录，GUI 轮询才能感知 MCP 的改动。
/// 失败只记门控日志——标记写入失败不应让业务写操作回滚。
fn bump_task_write_ts(conn: &Connection) {
    let ts = now_millis().to_string();
    if let Err(e) = crate::db::set_setting(conn, LAST_TASK_WRITE_TS_KEY, &ts) {
        tlog!("[#114] 写入 {LAST_TASK_WRITE_TS_KEY} 失败: {e}");
    }
}

/// 中英四态归一化。返回 `None` 表示非四态（调用方再按自定义列校验）。
pub fn normalize_status(s: &str) -> Option<String> {
    match s.trim() {
        "todo" | "doing" | "processed" | "done" => Some(s.trim().to_string()),
        "待处理" => Some("todo".to_string()),
        "处理中" => Some("doing".to_string()),
        "已处理" => Some("processed".to_string()),
        "已完成" => Some("done".to_string()),
        _ => None,
    }
}

/// 校验 status 是否合法：四态或该任务所属账号已知的自定义列 col_key。
/// 不合法直接返回 Err，DB 不改动，避免任务因落入未知列而在看板「消失」。
/// （自 `commands.rs::validate_task_status` 原样迁移。）
pub fn validate_task_status(conn: &Connection, key: &str, status: &str) -> Result<(), String> {
    if matches!(status, "todo" | "doing" | "processed" | "done") {
        return Ok(());
    }
    let account_id: Option<i64> = conn
        .query_row(
            "SELECT account_id FROM tasks WHERE issue_key = ?1 LIMIT 1",
            rusqlite::params![key],
            |r| r.get(0),
        )
        .map(Some)
        .unwrap_or(None);
    if let Some(id) = account_id {
        let cols = crate::db::list_account_columns(conn, id)?;
        if cols.iter().any(|c| c.col_key == status) {
            return Ok(());
        }
        let names: Vec<&str> = cols.iter().map(|c| c.col_key.as_str()).collect();
        return Err(format!(
            "非法状态: {status}（应为四态 todo/doing/processed/done 或该账号自定义列之一: {}）",
            names.join("/")
        ));
    }
    Err(format!(
        "非法状态: {status}（应为四态 todo/doing/processed/done 或该任务账号的自定义列）"
    ))
}

/// 校验并写入任务状态。返回实际更新行数（0 表示 key 不存在，调用方自定报错策略）。
pub fn set_task_status(conn: &Connection, key: &str, status: &str) -> Result<usize, String> {
    validate_task_status(conn, key, status)?;
    let n = conn
        .execute(
            "UPDATE tasks SET status = ?1 WHERE issue_key = ?2",
            rusqlite::params![status, key],
        )
        .map_err(|e| e.to_string())?;
    if n > 0 {
        bump_task_write_ts(conn);
    }
    Ok(n)
}

/// 写入 session 记录。返回实际更新行数（调用方自定“任务不存在”策略）。
pub fn touch_session(
    conn: &Connection,
    key: &str,
    session_id: &str,
    agent: Option<&str>,
    now: i64,
) -> Result<usize, String> {
    let n = conn
        .execute(
            "UPDATE tasks SET session_id = ?1, session_agent = ?2, session_at = ?3 WHERE issue_key = ?4",
            rusqlite::params![session_id, agent.unwrap_or_default(), now, key],
        )
        .map_err(|e| e.to_string())?;
    if n > 0 {
        bump_task_write_ts(conn);
    }
    Ok(n)
}

/// 清空 session（保留 `session_at` 审计）。返回实际更新行数。
pub fn clear_task_session(conn: &Connection, key: &str) -> Result<usize, String> {
    let n = conn
        .execute(
            "UPDATE tasks SET session_id = NULL, session_agent = NULL WHERE issue_key = ?1",
            [key],
        )
        .map_err(|e| e.to_string())?;
    if n > 0 {
        bump_task_write_ts(conn);
    }
    Ok(n)
}

/// 写入交接任务详情。返回实际更新行数。
pub fn record_task_handoff(conn: &Connection, key: &str, text: &str) -> Result<usize, String> {
    let n = conn
        .execute(
            "UPDATE tasks SET handoff = ?1 WHERE issue_key = ?2",
            rusqlite::params![text, key],
        )
        .map_err(|e| e.to_string())?;
    if n > 0 {
        bump_task_write_ts(conn);
    }
    Ok(n)
}

/// 合法记事标签（与 `mcp_server/server.py::VALID_NOTE_LABELS` 一致）。
pub const NOTE_LABELS: [&str; 4] = ["low", "medium", "high", "urgent"];

/// 记事标签归一化：缺省/空白 → `low`；大小写不敏感；非法值报错。
/// （自 `mcp.rs::normalize_note_label` 迁移；`commands.rs` 此前无校验，现统一入口。）
pub fn normalize_note_label(label: Option<&str>) -> Result<String, String> {
    let l = label.unwrap_or("low").trim().to_lowercase();
    if l.is_empty() {
        return Ok("low".to_string());
    }
    if NOTE_LABELS.contains(&l.as_str()) {
        Ok(l)
    } else {
        Err(format!("无效标签: {l}（可选: low/medium/high/urgent）"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_status_covers_four_states_and_chinese() {
        for s in ["todo", "doing", "processed", "done"] {
            assert_eq!(normalize_status(s), Some(s.to_string()));
        }
        assert_eq!(normalize_status("待处理"), Some("todo".to_string()));
        assert_eq!(normalize_status("处理中"), Some("doing".to_string()));
        assert_eq!(normalize_status("已处理"), Some("processed".to_string()));
        assert_eq!(normalize_status("已完成"), Some("done".to_string()));
        assert_eq!(normalize_status("  doing  "), Some("doing".to_string()));
        assert_eq!(normalize_status("col_1"), None);
        assert_eq!(normalize_status(""), None);
    }

    /// 最小可用内存库：只建 `meta` + `tasks` 两张表，够覆盖写路径的 bump 逻辑。
    fn mem_db() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(
            "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             CREATE TABLE tasks (
               issue_key TEXT PRIMARY KEY,
               status TEXT, session_id TEXT, session_agent TEXT,
               handoff TEXT, account_id INTEGER
             );
             INSERT INTO tasks (issue_key, status, account_id) VALUES ('repo#1', 'todo', 1);",
        )
        .unwrap();
        c
    }

    #[test]
    fn now_millis_is_unix_epoch_millis() {
        // 2026-09 的量级约 1.78e12；只断言落在合理区间，避免时钟被墙时误报。
        let ms = now_millis();
        assert!(ms > 1_700_000_000_000, "毫秒时间戳过小: {ms}");
        assert!(ms < 4_000_000_000_000, "毫秒时间戳过大: {ms}");
    }

    #[test]
    fn task_writes_bump_last_task_write_ts() {
        let conn = mem_db();
        assert_eq!(last_task_write_ts(&conn), 0, "从未写过时应为 0");

        assert_eq!(set_task_status(&conn, "repo#1", "doing").unwrap(), 1);
        let ts1 = last_task_write_ts(&conn);
        assert!(ts1 > 0, "写成功后必须 bump，GUI 轮询才能感知");

        // 0 行更新（key 不存在）不应 bump：没有任何数据变化，避免前端空刷新。
        assert_eq!(record_task_handoff(&conn, "repo#404", "x").unwrap(), 0);
        assert_eq!(last_task_write_ts(&conn), ts1, "0 行更新不应 bump");

        assert_eq!(clear_task_session(&conn, "repo#1").unwrap(), 1);
        assert!(
            last_task_write_ts(&conn) >= ts1,
            "再次写入后时间戳不应回退"
        );
    }

    #[test]
    fn normalize_note_label_defaults_and_rejects() {
        assert_eq!(normalize_note_label(None).unwrap(), "low");
        assert_eq!(normalize_note_label(Some("  ")).unwrap(), "low");
        assert_eq!(normalize_note_label(Some("HIGH")).unwrap(), "high");
        assert!(normalize_note_label(Some("bogus")).is_err());
    }

    #[test]
    fn validate_browser_url_allows_github_only() {
        assert_eq!(
            validate_browser_url("https://github.com/o/r/issues/1").unwrap(),
            "https://github.com/o/r/issues/1"
        );
        // 首尾空白容忍
        assert!(validate_browser_url("  https://github.com/o/r  ").is_ok());
        // 非 https 拒绝
        assert!(validate_browser_url("http://github.com/o/r").is_err());
        // 非 GitHub 域拒绝
        assert!(validate_browser_url("https://evil.com/github.com/x").is_err());
        assert!(validate_browser_url("https://github.com.evil.com/x").is_err());
        // 企业版放行
        assert!(validate_browser_url("https://acme.ghe.com/o/r").is_ok());
        assert!(validate_browser_url("").is_err());
    }
}

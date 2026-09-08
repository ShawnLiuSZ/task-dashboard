//! 任务写操作公共逻辑（v0.3.49，#147）。
//!
//! `commands.rs`（Tauri 命令）与 `mcp.rs`（MCP stdio）曾各写一遍状态校验、
//! session/handoff SQL，逻辑已分叉。本模块是唯一权威实现，两边只做薄包装
//! （参数形态与“任务不存在”时的报错策略保留各自原有行为）。

use rusqlite::Connection;

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
            "SELECT account_id FROM tasks WHERE key = ?1 LIMIT 1",
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
            "UPDATE tasks SET status = ?1 WHERE key = ?2",
            rusqlite::params![status, key],
        )
        .map_err(|e| e.to_string())?;
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
            "UPDATE tasks SET session_id = ?1, session_agent = ?2, session_at = ?3 WHERE key = ?4",
            rusqlite::params![session_id, agent.unwrap_or_default(), now, key],
        )
        .map_err(|e| e.to_string())?;
    Ok(n)
}

/// 清空 session（保留 `session_at` 审计）。返回实际更新行数。
pub fn clear_task_session(conn: &Connection, key: &str) -> Result<usize, String> {
    let n = conn
        .execute(
            "UPDATE tasks SET session_id = NULL, session_agent = NULL WHERE key = ?1",
            [key],
        )
        .map_err(|e| e.to_string())?;
    Ok(n)
}

/// 写入交接任务详情。返回实际更新行数。
pub fn record_task_handoff(conn: &Connection, key: &str, text: &str) -> Result<usize, String> {
    let n = conn
        .execute(
            "UPDATE tasks SET handoff = ?1 WHERE key = ?2",
            rusqlite::params![text, key],
        )
        .map_err(|e| e.to_string())?;
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

    #[test]
    fn normalize_note_label_defaults_and_rejects() {
        assert_eq!(normalize_note_label(None).unwrap(), "low");
        assert_eq!(normalize_note_label(Some("  ")).unwrap(), "low");
        assert_eq!(normalize_note_label(Some("HIGH")).unwrap(), "high");
        assert!(normalize_note_label(Some("bogus")).is_err());
    }
}

//! 任务写操作公共逻辑（v0.3.49，#147）。
//!
//! `commands.rs`（Tauri 命令）与 `mcp.rs`（MCP stdio）曾各写一遍状态校验、
//! session/handoff SQL，逻辑已分叉。本模块是唯一权威实现，两边只做薄包装
//! （参数形态与“任务不存在”时的报错策略保留各自原有行为）。
//!
//! v0.3.49（#149）：追加日志门控与浏览器外链白名单。

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

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

/// #278：关联 issue（parent / sub-issue）的最小描述。
///
/// 只缓存详情页展示必需的三件套（编号 / 标题 / 网页链接）——不含 `state` / 标签 /
/// 更新时间等会漂移的字段，避免一次同步延迟就把过期信息呈现给用户。
/// 跨仓库时 owner/repo 由 `url` 隐含（GitHub URL 必为 `/issues/<n>` 形态），
/// 因此无需再单独存 `repo`，详情「打开 / 复制」直接复用 `url`。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct IssueLink {
    pub number: i64,
    pub title: String,
    pub url: String,
}

/// #278：一条 issue 的父子关系（GraphQL `parent` / `subIssues` 的落库形态）。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct IssueLinks {
    pub parent: Option<IssueLink>,
    pub sub_issues: Vec<IssueLink>,
}

impl IssueLinks {
    pub fn is_empty(&self) -> bool {
        self.parent.is_none() && self.sub_issues.is_empty()
    }

    /// 序列化为 `tasks.parent_issue` / `tasks.sub_issues` 两列的值。
    ///
    /// 无关系时返回空串，保持两列 `NOT NULL DEFAULT ''` 的既有约定
    /// （与 `branch` / `work_branch` / `author` 一致，前端按空值判定「无关联」）。
    pub fn to_columns(&self) -> (String, String) {
        let parent = match &self.parent {
            Some(p) => serde_json::to_string(p).unwrap_or_default(),
            None => String::new(),
        };
        let sub_issues = if self.sub_issues.is_empty() {
            String::new()
        } else {
            serde_json::to_string(&self.sub_issues).unwrap_or_default()
        };
        (parent, sub_issues)
    }
}

/// 解析 `tasks.parent_issue` 列（JSON 对象）。空串 / 非法 JSON → `None`。
///
/// 解析失败静默降级：关联信息属装饰性展示，不该让 `list_tasks` 因一行脏数据报错
/// （与 `author_from_user` 的「取不到就空串」同策略）。
/// 参数取 `impl AsRef<str>`，便于在 SQL 行映射里直接传 `r.get::<_, String>(n)?`。
pub fn parse_parent_link(s: impl AsRef<str>) -> Option<IssueLink> {
    let t = s.as_ref().trim();
    if t.is_empty() {
        return None;
    }
    serde_json::from_str(t).ok()
}

/// 解析 `tasks.sub_issues` 列（JSON 数组）。空串 / 非法 JSON → 空列表。
pub fn parse_sub_links(s: impl AsRef<str>) -> Vec<IssueLink> {
    let t = s.as_ref().trim();
    if t.is_empty() {
        return Vec::new();
    }
    serde_json::from_str(t).unwrap_or_default()
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
    if y < 1970 || !(1..=12).contains(&m) || !(1..=31).contains(&d) || h > 23 || mi > 59 || sec > 59 {
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
    Ok(n)
}

/// 写入 session 记录。`branch` 非空才同时写入 `work_branch` 列（agent 工作分支，
/// 与同步自动拉的 PR `branch` 列分离，同步不碰 work_branch）。空则不写。
/// 返回实际更新行数（调用方自定“任务不存在”策略）。
pub fn touch_session(
    conn: &Connection,
    key: &str,
    session_id: &str,
    agent: Option<&str>,
    now: i64,
    branch: Option<&str>,
) -> Result<usize, String> {
    let br = branch.map(str::trim).unwrap_or("").to_string();
    let n = if br.is_empty() {
        conn.execute(
            "UPDATE tasks SET session_id = ?1, session_agent = ?2, session_at = ?3 WHERE issue_key = ?4",
            rusqlite::params![session_id, agent.unwrap_or_default(), now, key],
        )
        .map_err(|e| e.to_string())?
    } else {
        conn.execute(
            "UPDATE tasks SET session_id = ?1, session_agent = ?2, session_at = ?3, work_branch = ?5 WHERE issue_key = ?4",
            rusqlite::params![session_id, agent.unwrap_or_default(), now, key, br],
        )
        .map_err(|e| e.to_string())?
    };
    Ok(n)
}

/// #279：单独设置任务的工作分支 `work_branch`（agent 在**创建 / 切换分支之后**调用，
/// 纠正 `record_session` 在「开始任务」时录到的基线分支 develop/master）。
/// 与同步自动拉的 PR `branch` 列分离，同步不碰 work_branch。
///
/// 本函数只做 SQL 更新：`branch` 为空串会把该列清空（清空语义在本层保留，便于复用）。
/// **MCP 工具边界拒绝空 `branch`**（`mcp.rs::tool_set_work_branch` 与 `server.py` 报
/// 「branch 不能为空」），防止误清掉工作分支——本层不校验，调用方自行把关。
/// 返回实际更新行数（0 表示任务不存在）。
pub fn set_work_branch(conn: &Connection, key: &str, branch: &str) -> Result<usize, String> {
    let br = branch.trim().to_string();
    let n = conn
        .execute(
            "UPDATE tasks SET work_branch = ?1 WHERE issue_key = ?2",
            rusqlite::params![br, key],
        )
        .map_err(|e| e.to_string())?;
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

    #[test]
    fn issue_links_roundtrip_and_degrade_on_bad_data() {
        // 空关系 → 两列都空串（保持 NOT NULL DEFAULT '' 约定）。
        let (p, s) = IssueLinks::default().to_columns();
        assert_eq!((p, s), (String::new(), String::new()));
        assert!(IssueLinks::default().is_empty());

        // 有父无子：parent 列是 JSON 对象，sub_issues 列仍是空串。
        let links = IssueLinks {
            parent: Some(IssueLink {
                number: 12,
                title: "epic".into(),
                url: "https://github.com/o/r/issues/12".into(),
            }),
            sub_issues: Vec::new(),
        };
        assert!(!links.is_empty());
        let (p, s) = links.to_columns();
        assert!(p.starts_with('{'));
        assert_eq!(s, "");
        assert_eq!(parse_parent_link(&p), links.parent.clone());
        assert!(parse_sub_links(&s).is_empty());

        // 无父有子：sub_issues 列是 JSON 数组，parent 列空串。
        let links2 = IssueLinks {
            parent: None,
            sub_issues: vec![
                IssueLink {
                    number: 13,
                    title: "a".into(),
                    url: "https://github.com/o/r/issues/13".into(),
                },
                IssueLink {
                    number: 14,
                    title: "b".into(),
                    url: "https://github.com/o/r/issues/14".into(),
                },
            ],
        };
        let (p, s) = links2.to_columns();
        assert_eq!(p, "");
        assert!(s.starts_with('['));
        assert!(parse_parent_link(&p).is_none());
        assert_eq!(parse_sub_links(&s), links2.sub_issues);
    }

    #[test]
    fn issue_link_parsers_degrade_silently() {
        // 空串 / 空白 → 空值（老库迁移前与「无关联」同义）。
        assert!(parse_parent_link("").is_none());
        assert!(parse_parent_link("   ").is_none());
        assert!(parse_sub_links("").is_empty());
        // 脏数据（截断的 JSON / 类型不符）不报错、不 panic。
        assert!(parse_parent_link("{not json").is_none());
        assert!(parse_sub_links("]{").is_empty());
        // 父列存了数组（形状错）→ None；子列存了对象 → 空列表。
        assert!(parse_parent_link("[1]").is_none());
        assert!(parse_sub_links("{}").is_empty());
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

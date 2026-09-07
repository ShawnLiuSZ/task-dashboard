//! TaskBoard MCP server —— stdio 传输，JSON-RPC 2.0，零第三方网络依赖。
//!
//! 作为 `taskboard` 二进制的 `mcp` 子命令运行（`main.rs` 检测 argv 后直接调用
//! [`run`]，不启动 GUI）。让外部 AI agent（claude-code / codex / WorkBuddy /
//! Cursor …）能直接读写与 Tauri 应用**同一份**本地 SQLite 数据库，无需独立的
//! Python 进程、无散落文件夹、无 schema 漂移。
//!
//! 数据库路径：默认 `~/Library/Application Support/com.shawnliu.taskboard/taskboard.db`
//! （与 `db.rs::db_path` 一致），可用 `TASKBOARD_DB` 环境变量覆盖。
//!
//! 工具（与 `mcp_server/server.py` 保持兼容）：
//! - list_my_tasks(status?, ownership?)
//! - get_task_status(issue)
//! - update_task_status(issue, status)
//! - record_session(issue, session_id, agent?)
//! - record_handoff(issue, text)
//! - clear_session(issue)
//! - list_notes()
//! - add_note(content, label?)
//! - update_note(note_id, content)
//! - update_note_label(note_id, label)
//! - delete_note(note_id)

use std::io::{Read, Write};

use rusqlite::Connection;
use serde_json::{json, Map, Value};

const PROTOCOL_VERSION: &str = "2024-11-05";
const SERVER_VERSION: &str = "0.3.24";

/// 返回给 agent 的列（与 `commands.rs::Task` 顺序兼容的子集）。
const SELECT_COLS: &str =
    "key, repo, number, title, status, ownership, assignees, session_id, session_agent, handoff, updated_at";

fn db_path_for_mcp() -> Result<std::path::PathBuf, String> {
    if let Ok(p) = std::env::var("TASKBOARD_DB") {
        if !p.trim().is_empty() {
            return Ok(std::path::PathBuf::from(p.trim()));
        }
    }
    crate::db::db_path_default()
}

fn resolve_status(s: &str) -> Option<String> {
    match s {
        "todo" | "doing" | "processed" | "done" => Some(s.to_string()),
        "待处理" => Some("todo".to_string()),
        "处理中" => Some("doing".to_string()),
        "已处理" => Some("processed".to_string()),
        "已完成" => Some("done".to_string()),
        _ => None,
    }
}

/// 把多种 issue 引用归一化为 DB 主键 `repo#number`。
fn parse_issue_ref(ref_: &str) -> Result<String, String> {
    let r = ref_.trim();
    if r.is_empty() {
        return Err("issue 引用为空".to_string());
    }
    // URL 形式：https://github.com/{owner}/{repo}/issues/{n}
    if let Some(idx) = r.find("github.com/") {
        let rest = &r[idx + "github.com/".len()..];
        let parts: Vec<&str> = rest.split('/').collect();
        if parts.len() >= 4 {
            let repo = parts[1];
            if let Ok(n) = parts[3].trim_start_matches('#').parse::<i64>() {
                if n > 0 && !repo.is_empty() {
                    return Ok(format!("{}#{}", repo, n));
                }
            }
        }
        return Err(format!("无法解析 issue URL: {ref_}"));
    }
    // repo#number 或 owner/repo#number
    if let Some(pos) = r.rfind('#') {
        let left = &r[..pos];
        let right = &r[pos + 1..];
        let n: i64 = right
            .parse()
            .map_err(|_| format!("issue 编号非法: {right}"))?;
        if n <= 0 {
            return Err("issue 编号必须 > 0".to_string());
        }
        let repo = left.rsplit('/').next().unwrap_or("").trim();
        if repo.is_empty() {
            return Err(format!("无法从引用解析仓库名: {ref_}"));
        }
        return Ok(format!("{}#{}", repo, n));
    }
    Err(format!("无法解析 issue 引用: {ref_}"))
}

fn row_to_value(r: &rusqlite::Row) -> rusqlite::Result<Value> {
    let mut m = Map::new();
    m.insert("key".into(), Value::String(r.get::<_, String>(0)?));
    m.insert("repo".into(), Value::String(r.get::<_, String>(1)?));
    m.insert("number".into(), Value::Number(r.get::<_, i64>(2)?.into()));
    m.insert("title".into(), Value::String(r.get::<_, String>(3)?));
    m.insert("status".into(), Value::String(r.get::<_, String>(4)?));
    m.insert("ownership".into(), Value::String(r.get::<_, String>(5)?));
    m.insert("assignees".into(), Value::String(r.get::<_, String>(6)?));
    let sid: Option<String> = r.get(7)?;
    m.insert(
        "session_id".into(),
        sid.map(Value::String).unwrap_or(Value::Null),
    );
    let sag: Option<String> = r.get(8)?;
    m.insert(
        "session_agent".into(),
        sag.map(Value::String).unwrap_or(Value::Null),
    );
    m.insert("handoff".into(), Value::String(r.get::<_, String>(9)?));
    m.insert(
        "updated_at".into(),
        match r.get::<_, Option<String>>(10)? {
            Some(s) => Value::String(s),
            None => Value::Null,
        },
    );
    Ok(Value::Object(m))
}

fn tool_list(
    conn: &Connection,
    status: Option<&str>,
    ownership: Option<&str>,
) -> Result<Value, String> {
    let mut sql = format!("SELECT {SELECT_COLS} FROM tasks");
    let mut wheres: Vec<&str> = Vec::new();
    let mut owned: Vec<String> = Vec::new();
    if let Some(s) = status {
        let sk = resolve_status(s).ok_or_else(|| format!("非法状态: {s}"))?;
        wheres.push("status = ?");
        owned.push(sk);
    }
    if let Some(o) = ownership {
        wheres.push("ownership = ?");
        owned.push(o.to_string());
    }
    if !wheres.is_empty() {
        sql.push_str(" WHERE ");
        sql.push_str(&wheres.join(" AND "));
    }
    sql.push_str(" ORDER BY candidate_done ASC, status ASC, updated_at DESC");
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let refs: Vec<&dyn rusqlite::ToSql> = owned
        .iter()
        .map(|s| s as &dyn rusqlite::ToSql)
        .collect();
    let rows = stmt
        .query_map(refs.as_slice(), row_to_value)
        .map_err(|e| e.to_string())?;
    let mut out: Vec<Value> = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| e.to_string())?);
    }
    Ok(Value::Array(out))
}

fn tool_get(conn: &Connection, issue: &str) -> Result<Value, String> {
    let key = parse_issue_ref(issue)?;
    let mut stmt = conn
        .prepare(&format!("SELECT {SELECT_COLS} FROM tasks WHERE key = ?1"))
        .map_err(|e| e.to_string())?;
    let mut rows = stmt
        .query_map([key.clone()], row_to_value)
        .map_err(|e| e.to_string())?;
    match rows.next() {
        Some(Ok(v)) => {
            let mut m = match v {
                Value::Object(m) => m,
                _ => Map::new(),
            };
            m.insert("found".into(), Value::Bool(true));
            m.insert("key".into(), Value::String(key));
            Ok(Value::Object(m))
        }
        Some(Err(e)) => Err(e.to_string()),
        None => Ok(json!({ "found": false, "key": key })),
    }
}

fn tool_update(conn: &Connection, issue: &str, status: &str) -> Result<Value, String> {
    let key = parse_issue_ref(issue)?;
    let sk = resolve_status(status)
        .ok_or_else(|| format!("非法状态: {status}（应为 todo/doing/processed/done 或中文四态）"))?;
    let n = conn
        .execute(
            "UPDATE tasks SET status = ?1 WHERE key = ?2",
            rusqlite::params![sk, key],
        )
        .map_err(|e| e.to_string())?;
    if n == 0 {
        return Err(format!("任务不存在: {key}"));
    }
    Ok(json!({ "ok": true, "key": key, "status": sk }))
}

fn tool_record_session(
    conn: &Connection,
    issue: &str,
    session_id: &str,
    agent: Option<&str>,
) -> Result<Value, String> {
    let key = parse_issue_ref(issue)?;
    let sid = session_id.trim();
    if sid.is_empty() {
        return Err("session_id 不能为空".to_string());
    }
    let agent = agent.unwrap_or_default().trim().to_string();
    let now = crate::sync::now_secs();
    let n = conn
        .execute(
            "UPDATE tasks SET session_id = ?1, session_agent = ?2, session_at = ?3 WHERE key = ?4",
            rusqlite::params![sid, agent, now, key],
        )
        .map_err(|e| e.to_string())?;
    if n == 0 {
        return Err(format!("任务不存在: {key}"));
    }
    Ok(json!({ "ok": true, "key": key }))
}

fn tool_record_handoff(conn: &Connection, issue: &str, text: &str) -> Result<Value, String> {
    let key = parse_issue_ref(issue)?;
    let n = conn
        .execute(
            "UPDATE tasks SET handoff = ?1 WHERE key = ?2",
            rusqlite::params![text, key],
        )
        .map_err(|e| e.to_string())?;
    if n == 0 {
        return Err(format!("任务不存在: {key}"));
    }
    Ok(json!({ "ok": true, "key": key, "handoff_len": text.len() }))
}

fn tool_clear_session(conn: &Connection, issue: &str) -> Result<Value, String> {
    let key = parse_issue_ref(issue)?;
    let n = conn
        .execute(
            "UPDATE tasks SET session_id = NULL, session_agent = NULL WHERE key = ?1",
            [key.clone()],
        )
        .map_err(|e| e.to_string())?;
    if n == 0 {
        return Err(format!("任务不存在: {key}"));
    }
    Ok(json!({ "ok": true, "key": key }))
}

// ============================================================================
// v0.3.28+：记事本工具（与 `mcp_server/server.py` 同名同参，返回结构一致）
// ============================================================================

/// 合法记事标签（与 `mcp_server/server.py::VALID_NOTE_LABELS` 一致）。
const NOTE_LABELS: [&str; 4] = ["low", "medium", "high", "urgent"];

/// 序列化为 snake_case，与既有工具（session_id 等）及 server.py 的 sqlite row 保持一致。
fn note_to_value(n: &crate::db::Note) -> Value {
    json!({
        "id": n.id,
        "content": n.content,
        "label": n.label,
        "created_at": n.created_at,
        "updated_at": n.updated_at,
    })
}

fn normalize_note_label(label: Option<&str>) -> Result<String, String> {
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

/// `note_id` 既接受 JSON 数字，也容忍字符串形式的数字（部分 agent 会传字符串）。
fn note_id_arg(args: &Map<String, Value>) -> Result<i64, String> {
    match args.get("note_id") {
        Some(Value::Number(n)) => n.as_i64().ok_or_else(|| "note_id 必须是整数".to_string()),
        Some(Value::String(s)) => s
            .trim()
            .parse::<i64>()
            .map_err(|_| format!("note_id 非法: {s}")),
        _ => Err("缺少 note_id 参数".to_string()),
    }
}

fn tool_list_notes(conn: &Connection) -> Result<Value, String> {
    let notes = crate::db::list_notes(conn)?;
    Ok(Value::Array(notes.iter().map(note_to_value).collect()))
}

fn tool_add_note(
    conn: &Connection,
    content: Option<&str>,
    label: Option<&str>,
) -> Result<Value, String> {
    let content = content.unwrap_or_default().trim();
    if content.is_empty() {
        return Err("记事内容不能为空".to_string());
    }
    let label = normalize_note_label(label)?;
    let note = crate::db::add_note(conn, content, &label, crate::sync::now_secs())?;
    Ok(note_to_value(&note))
}

fn tool_update_note(conn: &Connection, id: i64, content: Option<&str>) -> Result<Value, String> {
    let content = content.unwrap_or_default().trim();
    if content.is_empty() {
        return Err("记事内容不能为空".to_string());
    }
    let note = crate::db::update_note(conn, id, content, crate::sync::now_secs())?;
    Ok(note_to_value(&note))
}

fn tool_update_note_label(
    conn: &Connection,
    id: i64,
    label: Option<&str>,
) -> Result<Value, String> {
    let label = normalize_note_label(label)?;
    let note = crate::db::update_note_label(conn, id, &label)?;
    Ok(note_to_value(&note))
}

fn tool_delete_note(conn: &Connection, id: i64) -> Result<Value, String> {
    crate::db::delete_note(conn, id)?;
    Ok(json!({ "ok": true, "note_id": id }))
}

fn call_tool(conn: &Connection, name: &str, args: &Map<String, Value>) -> Result<Value, String> {
    let get = |k: &str| -> Option<String> {
        args.get(k).and_then(|v| v.as_str()).map(|s| s.to_string())
    };
    match name {
        "list_my_tasks" => tool_list(conn, get("status").as_deref(), get("ownership").as_deref()),
        "get_task_status" => {
            let issue = get("issue").ok_or("缺少 issue 参数")?;
            tool_get(conn, &issue)
        }
        "update_task_status" => {
            let issue = get("issue").ok_or("缺少 issue 参数")?;
            let status = get("status").ok_or("缺少 status 参数")?;
            tool_update(conn, &issue, &status)
        }
        "record_session" => {
            let issue = get("issue").ok_or("缺少 issue 参数")?;
            let sid = get("session_id").ok_or("缺少 session_id 参数")?;
            tool_record_session(conn, &issue, &sid, get("agent").as_deref())
        }
        "record_handoff" => {
            let issue = get("issue").ok_or("缺少 issue 参数")?;
            let text = get("text").ok_or("缺少 text 参数")?;
            tool_record_handoff(conn, &issue, &text)
        }
        "clear_session" => {
            let issue = get("issue").ok_or("缺少 issue 参数")?;
            tool_clear_session(conn, &issue)
        }
        "list_notes" => tool_list_notes(conn),
        "add_note" => {
            let content = get("content").ok_or("缺少 content 参数")?;
            tool_add_note(conn, Some(&content), get("label").as_deref())
        }
        "update_note" => {
            let id = note_id_arg(args)?;
            let content = get("content").ok_or("缺少 content 参数")?;
            tool_update_note(conn, id, Some(&content))
        }
        "update_note_label" => {
            let id = note_id_arg(args)?;
            let label = get("label").ok_or("缺少 label 参数")?;
            tool_update_note_label(conn, id, Some(&label))
        }
        "delete_note" => {
            let id = note_id_arg(args)?;
            tool_delete_note(conn, id)
        }
        _ => Err(format!("未知工具: {name}")),
    }
}

/// 工具清单（tools/list 返回），描述与 `mcp_server/server.py` 对齐。
fn tools_list() -> Value {
    json!([
        {
            "name": "list_my_tasks",
            "description": "列出看板任务；可按 status(todo/doing/processed/done 或中文四态) 与 ownership(assigned/notassignee/assigned-others) 过滤。返回任务数组。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "status": { "type": "string", "description": "可选，按看板状态过滤" },
                    "ownership": { "type": "string", "description": "可选，按归属过滤" }
                }
            }
        },
        {
            "name": "get_task_status",
            "description": "查询单个任务的当前看板状态，以及已记录的 session_id / session_agent / handoff。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "issue": { "type": "string", "description": "issue 引用：repo#number / owner/repo#number / GitHub URL" }
                },
                "required": ["issue"]
            }
        },
        {
            "name": "update_task_status",
            "description": "将任务在看板上的状态更新为 待处理/处理中/已处理/已完成（只写本地 SQLite，不碰 GitHub）。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "issue": { "type": "string", "description": "issue 引用" },
                    "status": { "type": "string", "description": "目标状态：todo/doing/processed/done 或 待处理/处理中/已处理/已完成" }
                },
                "required": ["issue", "status"]
            }
        },
        {
            "name": "record_session",
            "description": "记录中断会话的 session id 到该任务卡片（session_id / session_agent / session_at）。只写本地 SQLite，不碰 GitHub。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "issue": { "type": "string", "description": "issue 引用" },
                    "session_id": { "type": "string", "description": "会话 id（如 claude-code / codex 的会话标识）" },
                    "agent": { "type": "string", "description": "可选，来源 agent：claude-code / codex / opencode / zcode / workbuddy …" }
                },
                "required": ["issue", "session_id"]
            }
        },
        {
            "name": "record_handoff",
            "description": "记录「交接任务」详情到该任务（handoff 字段）。只写本地 SQLite，不碰 GitHub。用于 agent 识别到用户「生成交接任务」类意图时调用。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "issue": { "type": "string", "description": "issue 引用" },
                    "text": { "type": "string", "description": "交接详情文本" }
                },
                "required": ["issue", "text"]
            }
        },
        {
            "name": "clear_session",
            "description": "任务完成后清空 session_id / session_agent 字段（保留 session_at 审计）。只写本地 SQLite。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "issue": { "type": "string", "description": "issue 引用" }
                },
                "required": ["issue"]
            }
        },
        {
            "name": "list_notes",
            "description": "列出所有记事，按创建时间降序（最新的在前）。",
            "inputSchema": {
                "type": "object",
                "properties": {}
            }
        },
        {
            "name": "add_note",
            "description": "新增一条记事，返回新记录（含 id、创建时间）。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "content": { "type": "string", "description": "记事内容" },
                    "label": {
                        "type": "string",
                        "description": "标签：low/medium/high/urgent（默认 low）",
                        "enum": ["low", "medium", "high", "urgent"]
                    }
                },
                "required": ["content"]
            }
        },
        {
            "name": "update_note",
            "description": "更新记事内容，返回更新后的记录。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "note_id": { "type": "integer", "description": "记事 id" },
                    "content": { "type": "string", "description": "新的记事内容" }
                },
                "required": ["note_id", "content"]
            }
        },
        {
            "name": "update_note_label",
            "description": "更新记事标签（low/medium/high/urgent），返回更新后的记录。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "note_id": { "type": "integer", "description": "记事 id" },
                    "label": {
                        "type": "string",
                        "description": "标签：low/medium/high/urgent",
                        "enum": ["low", "medium", "high", "urgent"]
                    }
                },
                "required": ["note_id", "label"]
            }
        },
        {
            "name": "delete_note",
            "description": "删除一条记事。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "note_id": { "type": "integer", "description": "记事 id" }
                },
                "required": ["note_id"]
            }
        }
    ])
}

fn handle(conn: &Connection, msg: &Value) -> Option<Value> {
    let method = msg.get("method").and_then(|m| m.as_str()).unwrap_or("");
    let id = match msg.get("id") {
        Some(v) => v.clone(),
        None => return None, // 通知（无 id）不需要回复
    };
    match method {
        "initialize" => Some(json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": {
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "taskboard", "version": SERVER_VERSION }
            }
        })),
        "ping" => Some(json!({ "jsonrpc": "2.0", "id": id, "result": {} })),
        "tools/list" => Some(json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": { "tools": tools_list() }
        })),
        "tools/call" => {
            let params = msg
                .get("params")
                .and_then(|p| p.as_object())
                .cloned()
                .unwrap_or_default();
            let name = params
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let args = params
                .get("arguments")
                .and_then(|v| v.as_object())
                .cloned()
                .unwrap_or_default();
            match call_tool(conn, &name, &args) {
                Ok(content_val) => Some(json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": {
                        "content": [{ "type": "text", "text": content_val.to_string() }],
                        "isError": false
                    }
                })),
                Err(e) => Some(json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": {
                        "content": [{ "type": "text", "text": format!("错误：{e}") }],
                        "isError": true
                    }
                })),
            }
        }
        _ => Some(json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": { "code": -32601, "message": format!("方法未实现: {method}") }
        })),
    }
}

/// 从二进制流（如 stdin）读取一条带 `Content-Length` 头的 JSON-RPC 消息。
/// 逐字节读取以避免 BufRead 缓冲与 `read_exact` 混用导致的数据错位。EOF 返回 None。
fn read_message(r: &mut impl Read) -> Option<Value> {
    let mut header_bytes: Vec<u8> = Vec::new();
    let mut content_length: Option<usize> = None;
    loop {
        let mut byte = [0u8; 1];
        if r.read(&mut byte).ok()? == 0 {
            return None; // EOF
        }
        header_bytes.push(byte[0]);
        // 头部结束标志：\r\n\r\n 或 \n\n
        let done = header_bytes.ends_with(b"\r\n\r\n") || header_bytes.ends_with(b"\n\n");
        if done {
            let header_str = String::from_utf8_lossy(&header_bytes);
            for line in header_str.split('\n') {
                let line = line.trim_end(); // 去除可能的 \r
                if let Some((k, v)) = line.split_once(':') {
                    if k.trim().eq_ignore_ascii_case("content-length") {
                        content_length = v.trim().parse().ok();
                    }
                }
            }
            break;
        }
    }
    let len = content_length?;
    if len == 0 {
        return None;
    }
    let mut body = vec![0u8; len];
    r.read_exact(&mut body).ok()?;
    serde_json::from_slice(&body).ok()
}

fn write_message(w: &mut impl Write, msg: &Value) {
    let data = serde_json::to_vec(msg).unwrap_or_default();
    let mut frame = Vec::new();
    frame.extend_from_slice(format!("Content-Length: {}\r\n\r\n", data.len()).as_bytes());
    frame.extend_from_slice(&data);
    let _ = w.write_all(&frame);
    let _ = w.flush();
}

/// MCP 子命令入口：作为独立 stdio 进程运行，绝不启动 GUI。
pub fn run() {
    let path = match db_path_for_mcp() {
        Ok(p) => p,
        Err(e) => {
            eprintln!("[taskboard-mcp] 无法确定数据库路径: {e}");
            std::process::exit(1);
        }
    };
    let conn = match crate::db::open_db(&path) {
        Ok(c) => c,
        Err(e) => {
            eprintln!(
                "[taskboard-mcp] 打开数据库失败（请先运行一次 TaskBoard App 生成 {}）: {e}",
                path.display()
            );
            std::process::exit(1);
        }
    };
    if let Err(e) = conn.execute_batch("PRAGMA busy_timeout=5000;") {
        eprintln!("[taskboard-mcp] 设置 busy_timeout 失败: {e}");
    }

    let mut stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    loop {
        let msg = match read_message(&mut stdin) {
            Some(m) => m,
            None => break, // EOF：客户端断开
        };
        if let Some(resp) = handle(&conn, &msg) {
            write_message(&mut stdout, &resp);
        }
    }
}

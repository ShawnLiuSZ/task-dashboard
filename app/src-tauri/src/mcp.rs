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
//! - record_session(issue, session_id, agent?, branch?)
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
// 由 Cargo 包版本注入，与发版路径（package.json / Cargo.toml / tauri.conf.json）保持单点一致，
// 避免手改字符串导致 serverInfo 版本落后。

/// 返回给 agent 的列。
///
/// v0.3.53 (#169)：与 Python 侧 `mcp_server/server.py::SELECT_COLS` 必须逐字一致，
/// 否则同一个工具在两个 MCP 实现里返回给 agent 的字段不一样。CI 由
/// `scripts/check-mcp-columns.py` 双向比对（含与本 crate `db.rs::SCHEMA` 的列名校验）。
/// #171：`work_branch` 为 agent 记录的工作分支，与同步的 PR `branch` 分离。
/// #278：`parent_issue` / `sub_issues` 为 GitHub 父子关系（与 DB 一致，存 JSON 串；
/// 空串表示无关联）。MCP 不做二次解析——agent 直接读 JSON，两个 MCP 实现语义一致。
const SELECT_COLS: &str = "issue_key, owner, repo, number, title, url, issue_state, ownership, status, project_status, assignees, mentioned, latest_comment_url, pr_number, pr_url, branch, work_branch, session_id, session_agent, session_at, handoff, candidate_done, account_id, updated_at, parent_issue, sub_issues, created_at";

fn db_path_for_mcp() -> Result<std::path::PathBuf, String> {
    if let Ok(p) = std::env::var("TASKBOARD_DB") {
        if !p.trim().is_empty() {
            return Ok(std::path::PathBuf::from(p.trim()));
        }
    }
    crate::db::db_path_default()
}

/// v0.3.49 (#147)：中英四态归一化走公共模块（与 commands.rs 同一实现）。
fn resolve_status(s: &str) -> Option<String> {
    crate::common::normalize_status(s)
}

/// 把多种 issue 引用归一化为 DB 主键 `repo#number`。
///
/// v0.4.1 (#250)：解析实现下沉到 [`crate::on_demand::parse_issue_ref_parts`]
/// （它额外保留 owner，供按需拉取定位资源），本函数只取主键。
/// 错误文案不变——它对 agent 可见。
fn parse_issue_ref(ref_: &str) -> Result<String, String> {
    crate::on_demand::parse_issue_ref_parts(ref_).map(|r| r.key)
}

/// 把一行 tasks 记录序列化为返回给 agent 的 JSON 对象。
///
/// 位置索引必须与 [`SELECT_COLS`] 的列顺序**严格逐一对应**。历史 bug（#173）：
/// #155 重建 tasks 表并往里插入 `url` / `issue_state` / `project_status` / `pr_number`
/// 等列后，SELECT_COLS 被 #169/#171 扩成 24 列、列序大变，但这里仍按老的精简列序用
/// 位置 `get(0..10)` 取值，导致 `list_my_tasks` / `get_task_status` 返回字段几乎全部
/// 错位（`repo` 填 owner、`number` 填 repo 字符串……），CI 测不到是因为
/// `check-mcp-columns.py` 只比 SELECT_COLS 字符串、管不了「位置映射」。
/// 现逐列对齐，语义与 Python 侧 `server.py` 的 `dict(row)` 保持一致。
fn row_to_value(r: &rusqlite::Row) -> rusqlite::Result<Value> {
    let mut m = Map::new();
    m.insert("issue_key".into(), Value::String(r.get::<_, String>(0)?)); // 0
    m.insert("owner".into(), Value::String(r.get::<_, String>(1)?)); // 1
    m.insert("repo".into(), Value::String(r.get::<_, String>(2)?)); // 2
    m.insert("number".into(), Value::Number(r.get::<_, i64>(3)?.into())); // 3
    m.insert("title".into(), Value::String(r.get::<_, String>(4)?)); // 4
    m.insert("url".into(), Value::String(r.get::<_, String>(5)?)); // 5
    m.insert("issue_state".into(), Value::String(r.get::<_, String>(6)?)); // 6
    m.insert("ownership".into(), Value::String(r.get::<_, String>(7)?)); // 7
    m.insert("status".into(), Value::String(r.get::<_, String>(8)?)); // 8
    m.insert("project_status".into(), Value::String(r.get::<_, String>(9)?)); // 9
    m.insert("assignees".into(), Value::String(r.get::<_, String>(10)?)); // 10
    m.insert("mentioned".into(), Value::Number(r.get::<_, i64>(11)?.into())); // 11
    m.insert(
        "latest_comment_url".into(),
        Value::String(r.get::<_, String>(12)?), // 12
    );
    m.insert("pr_number".into(), Value::Number(r.get::<_, i64>(13)?.into())); // 13
    m.insert("pr_url".into(), Value::String(r.get::<_, String>(14)?)); // 14
    m.insert("branch".into(), Value::String(r.get::<_, String>(15)?)); // 15
    m.insert("work_branch".into(), Value::String(r.get::<_, String>(16)?)); // 16
    let sid: Option<String> = r.get(17)?; // 17 可空
    m.insert(
        "session_id".into(),
        sid.map(Value::String).unwrap_or(Value::Null),
    );
    let sag: Option<String> = r.get(18)?; // 18 可空
    m.insert(
        "session_agent".into(),
        sag.map(Value::String).unwrap_or(Value::Null),
    );
    m.insert(
        "session_at".into(),
        match r.get::<_, Option<i64>>(19)? {
            Some(s) => Value::Number(s.into()),
            None => Value::Null,
        },
    );
    m.insert("handoff".into(), Value::String(r.get::<_, String>(20)?)); // 20
    m.insert(
        "candidate_done".into(),
        Value::Number(r.get::<_, i64>(21)?.into()), // 21
    );
    m.insert(
        "account_id".into(),
        Value::Number(r.get::<_, i64>(22)?.into()), // 22
    );
    m.insert(
        "updated_at".into(),
        match r.get::<_, Option<i64>>(23)? {
            Some(s) => Value::Number(s.into()),
            None => Value::Null,
        },
    );
    // #278：父子关系。原样返回 DB 里的 JSON 串（空串 = 无关联），
    // 与 Python 侧 `dict(row)` 的取值方式一致。
    m.insert(
        "parent_issue".into(),
        Value::String(r.get::<_, String>(24)?), // 24
    );
    m.insert("sub_issues".into(), Value::String(r.get::<_, String>(25)?)); // 25
    m.insert(
        "created_at".into(),
        Value::Number(r.get::<_, i64>(26)?.into()), // 26
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

/// 按主键查一行任务（给 `get_task_status` 用）。
/// 返回 `None` 表示本地没有这一行（区别于 DB 错误）。
fn fetch_task_row(conn: &Connection, key: &str) -> Result<Option<Value>, String> {
    let mut stmt = conn
        .prepare(&format!("SELECT {SELECT_COLS} FROM tasks WHERE issue_key = ?1"))
        .map_err(|e| e.to_string())?;
    let mut rows = stmt
        .query_map([key], row_to_value)
        .map_err(|e| e.to_string())?;
    match rows.next() {
        Some(Ok(v)) => Ok(Some(v)),
        Some(Err(e)) => Err(e.to_string()),
        None => Ok(None),
    }
}

/// 把「按需拉取」的结果翻译成给 agent 的错误文案（仍不可用时）。
fn ensure_failure_message(key: &str, outcome: &crate::on_demand::EnsureOutcome) -> String {
    match outcome {
        crate::on_demand::EnsureOutcome::RemoteNotFound(detail) => {
            format!("任务不存在且无法从 GitHub 拉取: {key}（{detail}）")
        }
        crate::on_demand::EnsureOutcome::Unavailable(reason) => {
            format!("任务不存在且无法从 GitHub 拉取: {key}（{reason}）")
        }
        // 已存在 / 已拉取由调用方处理，不会走到这里
        _ => format!("任务不存在: {key}"),
    }
}

/// 本地未命中时的统一前置处理：按需拉取该 issue（v0.4.1 / #250）。
///
/// 返回 `Ok(true)` 表示本次真的从 GitHub 拉取并落库了。
///
/// ⚠️ 必须在写入**之前**调用：`common::set_task_status` 会先做状态校验，而自定义列（非四态）
/// 的校验要读该行的 `account_id`——行还不存在时会误报「非法状态」。
/// `ref_` 传**原始**引用（可能带 owner），owner 是账号归属匹配的依据。
fn ensure_local_task(
    conn: &Connection,
    key: &str,
    ref_: &str,
) -> Result<bool, String> {
    if crate::on_demand::task_exists(conn, key)? {
        return Ok(false);
    }
    let outcome = crate::on_demand::ensure_task_available(conn, ref_)?;
    match outcome {
        crate::on_demand::EnsureOutcome::Pulled => Ok(true),
        crate::on_demand::EnsureOutcome::AlreadyLocal => Ok(false),
        other => Err(ensure_failure_message(key, &other)),
    }
}

/// 执行「返回影响行数」的写操作：先确保任务存在（必要时按需拉取），再写入。
///
/// 返回 `(影响行数, 本次是否按需拉取过)`。`write` 返回 0 表示行仍不存在——拉取成功
/// 后不应出现，故直接按「任务不存在」报错（保守）。
fn write_with_on_demand(
    conn: &Connection,
    key: &str,
    ref_: &str,
    mut write: impl FnMut() -> Result<usize, String>,
) -> Result<(usize, bool), String> {
    let pulled = ensure_local_task(conn, key, ref_)?;
    let n = write()?;
    if n == 0 {
        return Err(format!("任务不存在: {key}"));
    }
    Ok((n, pulled))
}

fn tool_get(conn: &Connection, issue: &str) -> Result<Value, String> {
    let key = parse_issue_ref(issue)?;
    if let Some(v) = fetch_task_row(conn, &key)? {
        let mut m = match v {
            Value::Object(m) => m,
            _ => Map::new(),
        };
        m.insert("found".into(), Value::Bool(true));
        m.insert("issue_key".into(), Value::String(key));
        return Ok(Value::Object(m));
    }
    // 本地未命中 → 按需拉取后再查一次（v0.4.1 / #250）。
    //
    // 读路径保持「永远能回答」的旧契约：账号缺失 / 网络失败 / 甚至本地 DB 出错都**不报错**，
    // 一律降级为 `found: false` + `reason`（信息不丢，只是不把读操作变成异常）。
    let outcome = match crate::on_demand::ensure_task_available(conn, issue) {
        Ok(o) => o,
        Err(e) => crate::on_demand::EnsureOutcome::Unavailable(format!("按需拉取失败: {e}")),
    };
    let pulled = outcome.pulled();
    if pulled || outcome == crate::on_demand::EnsureOutcome::AlreadyLocal {
        if let Some(v) = fetch_task_row(conn, &key)? {
            let mut m = match v {
                Value::Object(m) => m,
                _ => Map::new(),
            };
            m.insert("found".into(), Value::Bool(true));
            m.insert("issue_key".into(), Value::String(key));
            m.insert("pulled".into(), Value::Bool(pulled));
            return Ok(Value::Object(m));
        }
    }
    // 仍未命中：把「远端没有 / 无法拉取」的原因带回（不报错，保持原 found:false 语义）。
    let reason = match &outcome {
        crate::on_demand::EnsureOutcome::RemoteNotFound(detail) => {
            format!("本地无此任务，且{detail}")
        }
        crate::on_demand::EnsureOutcome::Unavailable(r) => {
            format!("本地无此任务，且无法从 GitHub 拉取：{r}")
        }
        _ => "本地无此任务".to_string(),
    };
    Ok(json!({ "found": false, "issue_key": key, "reason": reason }))
}

fn tool_update(conn: &Connection, issue: &str, status: &str) -> Result<Value, String> {
    let key = parse_issue_ref(issue)?;
    // v0.3.49 (#147)：归一化 + 校验 + 写入走公共模块（与 commands.rs 同一实现）。
    let t = status.trim();
    if t.is_empty() {
        return Err("状态不能为空".to_string());
    }
    let sk = resolve_status(t).unwrap_or_else(|| t.to_string());
    let (_, pulled) = write_with_on_demand(conn, &key, issue, || {
        crate::common::set_task_status(conn, &key, &sk)
    })?;
    Ok(json!({ "ok": true, "issue_key": key, "status": sk, "pulled": pulled }))
}

fn tool_record_session(
    conn: &Connection,
    issue: &str,
    session_id: &str,
    agent: Option<&str>,
    branch: Option<&str>,
) -> Result<Value, String> {
    let key = parse_issue_ref(issue)?;
    let sid = session_id.trim();
    if sid.is_empty() {
        return Err("session_id 不能为空".to_string());
    }
    let agent = agent.unwrap_or_default().trim().to_string();
    let now = crate::sync::now_secs();
    // v0.3.49 (#147)：SQL 走公共模块（与 commands.rs 同一实现）；branch 非空才写。
    let (_, pulled) = write_with_on_demand(conn, &key, issue, || {
        crate::common::touch_session(conn, &key, sid, Some(&agent), now, branch)
    })?;
    Ok(json!({ "ok": true, "issue_key": key, "pulled": pulled }))
}

/// #279：单独设置任务的工作分支（agent 在**创建 / 切换分支之后**调用，纠正
/// `record_session` 在「开始任务」时录到的基线分支 develop/master）。只写本地
/// SQLite 的 `work_branch` 列，不碰 GitHub、不碰同步的 PR `branch` 列。
fn tool_set_work_branch(
    conn: &Connection,
    issue: &str,
    branch: &str,
) -> Result<Value, String> {
    let key = parse_issue_ref(issue)?;
    let br = branch.trim();
    if br.is_empty() {
        return Err("branch 不能为空（清空请使用 clear_work_branch）".to_string());
    }
    // 走按需拉取：若该 issue 尚未同步到本地，先拉取这一个再写入。
    let (_, pulled) = write_with_on_demand(conn, &key, issue, || {
        crate::common::set_work_branch(conn, &key, br)
    })?;
    Ok(json!({ "ok": true, "issue_key": key, "work_branch": br, "pulled": pulled }))
}

fn tool_record_handoff(conn: &Connection, issue: &str, text: &str) -> Result<Value, String> {
    let key = parse_issue_ref(issue)?;
    // v0.3.49 (#147)：SQL 走公共模块（与 commands.rs 同一实现）。
    let (_, pulled) = write_with_on_demand(conn, &key, issue, || {
        crate::common::record_task_handoff(conn, &key, text)
    })?;
    Ok(json!({ "ok": true, "issue_key": key, "handoff_len": text.len(), "pulled": pulled }))
}

fn tool_clear_session(conn: &Connection, issue: &str) -> Result<Value, String> {
    let key = parse_issue_ref(issue)?;
    // v0.3.49 (#147)：SQL 走公共模块（与 commands.rs 同一实现）。
    let (_, pulled) = write_with_on_demand(conn, &key, issue, || {
        crate::common::clear_task_session(conn, &key)
    })?;
    Ok(json!({ "ok": true, "issue_key": key, "pulled": pulled }))
}

// ============================================================================
// v0.3.28+：记事本工具（与 `mcp_server/server.py` 同名同参，返回结构一致）
// ============================================================================

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

/// v0.3.49 (#147)：标签归一化走公共模块（与 commands.rs 同一实现）。
fn normalize_note_label(label: Option<&str>) -> Result<String, String> {
    crate::common::normalize_note_label(label)
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
            tool_record_session(conn, &issue, &sid, get("agent").as_deref(), get("branch").as_deref())
        }
        "set_work_branch" => {
            let issue = get("issue").ok_or("缺少 issue 参数")?;
            let branch = get("branch").ok_or("缺少 branch 参数")?;
            tool_set_work_branch(conn, &issue, &branch)
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
            "description": "查询单个任务的当前看板状态，以及已记录的 session_id / session_agent / handoff。若该 issue 尚未同步到本地，会按需从 GitHub 拉取这一个 issue（返回体 pulled=true 表示本次拉取过）；拉取不到时返回 found=false 并在 reason 里说明原因。",
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
            "description": "将任务在看板上的状态更新为 待处理/处理中/已处理/已完成（只写本地 SQLite，不碰 GitHub）。若该 issue 还没同步到本地，会自动按需从 GitHub 拉取这一个 issue 再写入（返回体 pulled=true 表示本次拉取过，无需再手动触发同步）。",
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
            "description": "记录中断会话的 session id 到该任务卡片（session_id / session_agent / session_at；branch 非空则一并记录工作分支到 work_branch，与同步的 PR branch 分离）。只写本地 SQLite，不碰 GitHub。若该 issue 尚未同步到本地，会按需从 GitHub 拉取这一个 issue 再写入。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "issue": { "type": "string", "description": "issue 引用" },
                    "session_id": { "type": "string", "description": "会话 id（如 claude-code / codex 的会话标识）" },
                    "agent": { "type": "string", "description": "可选，来源 agent：claude-code / codex / opencode / zcode / workbuddy …" },
                    "branch": { "type": "string", "description": "可选，当前工作分支（如 git branch --show-current），非空才写入 work_branch 列" }
                },
                "required": ["issue", "session_id"]
            }
        },
        {
            "name": "set_work_branch",
            "description": "单独设置任务的工作分支（work_branch 列），用于 agent 在**创建 / 切换分支之后**纠正「开始任务」时录到的基线分支（如 develop/master）。只写本地 SQLite，不碰 GitHub、不碰同步的 PR branch 列。若该 issue 尚未同步到本地，会按需从 GitHub 拉取这一个 issue 再写入。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "issue": { "type": "string", "description": "issue 引用" },
                    "branch": { "type": "string", "description": "当前实际工作分支（如 git branch --show-current 取到的值）" }
                },
                "required": ["issue", "branch"]
            }
        },
        {
            "name": "record_handoff",
            "description": "记录「交接任务」详情到该任务（handoff 字段）。只写本地 SQLite，不碰 GitHub。用于 agent 识别到用户「生成交接任务」类意图时调用。若该 issue 尚未同步到本地，会按需从 GitHub 拉取这一个 issue 再写入。",
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
            "description": "任务完成后清空 session_id / session_agent 字段（保留 session_at 审计）。只写本地 SQLite。若该 issue 尚未同步到本地，会按需从 GitHub 拉取这一个 issue 再写入。",
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
    let id = {
        let v = msg.get("id")?;
        v.clone()
    };
    match method {
        "initialize" => Some(json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": {
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "taskboard", "version": env!("CARGO_PKG_VERSION") }
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

/// stdio 分帧格式。MCP 规范为换行分隔 JSON；LSP 风格的 Content-Length 头作为历史兼容保留。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Framing {
    Ndjson,
    ContentLength,
}

/// 从二进制流（如 stdin）读取一条 JSON-RPC 消息，并返回它使用的分帧格式。
/// 逐字节读取以避免 BufRead 缓冲与 `read_exact` 混用导致的数据错位。EOF 返回 None。
///
/// 首个有效字节判定分帧格式：
/// - `{` → NDJSON（MCP 规范，Claude Code / Cursor 等标准客户端）
/// - 否则 → Content-Length 头（LSP 风格，WorkBuddy / Codex 等历史兼容）
fn read_message(r: &mut impl Read) -> Option<(Value, Framing)> {
    // 跳过消息之间的空白（换行 / 空行），首个有效字节用于判定分帧格式
    let mut first = [0u8; 1];
    loop {
        if r.read(&mut first).ok()? == 0 {
            return None; // EOF
        }
        if !first[0].is_ascii_whitespace() {
            break;
        }
    }

    // NDJSON：本行剩余部分即完整 JSON（规范禁止消息内嵌换行）
    if first[0] == b'{' {
        let mut line = vec![first[0]];
        let mut byte = [0u8; 1];
        loop {
            if r.read(&mut byte).ok()? == 0 {
                break; // 末行可能无换行结尾
            }
            if byte[0] == b'\n' {
                break;
            }
            line.push(byte[0]);
        }
        return match serde_json::from_slice(&line) {
            Ok(v) => Some((v, Framing::Ndjson)),
            Err(e) => {
                crate::tlog!("[taskboard-mcp] NDJSON 解析失败，跳过该行: {e}");
                None
            }
        };
    }

    // Content-Length 头：首字节已消费，需回填进头部缓冲
    let mut header_bytes: Vec<u8> = vec![first[0]];
    let mut content_length: Option<usize> = None;
    loop {
        let mut byte = [0u8; 1];
        if r.read(&mut byte).ok()? == 0 {
            return None; // EOF
        }
        header_bytes.push(byte[0]);
        if header_bytes.ends_with(b"\r\n\r\n") || header_bytes.ends_with(b"\n\n") {
            let header_str = String::from_utf8_lossy(&header_bytes);
            for line in header_str.split('\n') {
                if let Some((k, v)) = line.trim_end().split_once(':') {
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
    serde_json::from_slice(&body)
        .ok()
        .map(|v| (v, Framing::ContentLength))
}

fn write_message(w: &mut impl Write, msg: &Value, framing: Framing) {
    let data = serde_json::to_vec(msg).unwrap_or_default();
    match framing {
        Framing::Ndjson => {
            let _ = w.write_all(&data);
            let _ = w.write_all(b"\n");
        }
        Framing::ContentLength => {
            let _ = w.write_all(format!("Content-Length: {}\r\n\r\n", data.len()).as_bytes());
            let _ = w.write_all(&data);
        }
    }
    let _ = w.flush();
}

/// MCP 子命令入口：作为独立 stdio 进程运行，绝不启动 GUI。
pub fn run() {
    let path = match db_path_for_mcp() {
        Ok(p) => p,
        Err(e) => {
            crate::tlog!("[taskboard-mcp] 无法确定数据库路径: {e}");
            std::process::exit(1);
        }
    };
    let conn = match crate::db::open_db(&path) {
        Ok(c) => c,
        Err(e) => {
            crate::tlog!(
                "[taskboard-mcp] 打开数据库失败（请先运行一次 TaskBoard App 生成 {}）: {e}",
                path.display()
            );
            std::process::exit(1);
        }
    };
    if let Err(e) = conn.execute_batch("PRAGMA busy_timeout=5000;") {
        crate::tlog!("[taskboard-mcp] 设置 busy_timeout 失败: {e}");
    }

    let mut stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    let mut handled = 0u32;
    while let Some((msg, framing)) = read_message(&mut stdin) {
        if let Some(resp) = handle(&conn, &msg) {
            write_message(&mut stdout, &resp, framing);
        }
        handled += 1;
    }
    if handled == 0 {
        crate::tlog!(
            "[taskboard-mcp] 未收到任何有效 JSON-RPC 消息即断开——请检查客户端分帧格式"
        );
    }
}

// ============================================================================
// 读路径回归测试（#173）。
//
// 为什么测：`row_to_value` 用位置索引取值，必须与 `SELECT_COLS` 的列顺序严格一致。
// #155 表重建改列序、#169/#171 扩列后这里曾整体错位，且 `check-mcp-columns.py` 只比
// SELECT_COLS 字符串、管不了「位置映射」，CI 测不到。这里在内存库建一张含全部被选列
// 的 tasks 表，每列填可辨识的值，断言 `list_my_tasks` / `get_task_status` 返回的每个
// 字段都能对上「字段名 → 正确值」，杜绝错位回归。
// ============================================================================
#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    /// 建一张覆盖 SELECT_COLS 全部 26 列的最小 tasks 表（内存库）。
    fn test_conn() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(
            "CREATE TABLE tasks (
                issue_key TEXT, owner TEXT, repo TEXT, number INTEGER, title TEXT,
                url TEXT, issue_state TEXT, ownership TEXT, status TEXT, project_status TEXT,
                assignees TEXT, mentioned INTEGER, latest_comment_url TEXT, pr_number INTEGER,
                pr_url TEXT, branch TEXT, work_branch TEXT, session_id TEXT, session_agent TEXT,
                session_at INTEGER, handoff TEXT, candidate_done INTEGER, account_id INTEGER,
                updated_at INTEGER, parent_issue TEXT, sub_issues TEXT
            );",
        )
        .unwrap();
        c
    }

    /// 插入一行每列值都互不相同、可辨识的样例数据。
    fn insert_sample(conn: &Connection) {
        conn.execute(
            "INSERT INTO tasks (
                issue_key, owner, repo, number, title, url, issue_state, ownership, status,
                project_status, assignees, mentioned, latest_comment_url, pr_number, pr_url,
                branch, work_branch, session_id, session_agent, session_at, handoff,
                candidate_done, account_id, updated_at, parent_issue, sub_issues
            ) VALUES (
                'fad-backend#1247', 'FoodsUp-Inc', 'fad-backend', 1247, '修复支付回调',
                'https://github.com/FoodsUp-Inc/fad-backend/issues/1247', 'open', 'notassignee',
                'doing', 'In Progress', 'alice', 1, 'www.comment', 42, 'www.pr',
                'main', 'feature/pay', 'sess-1', 'claude-code', 1700000000, 'handoff-1',
                0, 1, 1700000100,
                '{\"number\":900,\"title\":\"支付重构\",\"url\":\"https://github.com/FoodsUp-Inc/fad-backend/issues/900\"}',
                '[{\"number\":1300,\"title\":\"支付回调子任务\",\"url\":\"https://github.com/FoodsUp-Inc/fad-backend/issues/1300\"}]'
            );",
            [],
        )
        .unwrap();
    }

    #[test]
    fn list_my_tasks_returns_correct_column_values() {
        let c = test_conn();
        insert_sample(&c);
        let out = tool_list(&c, None, None).unwrap();
        let arr = out.as_array().expect("list_my_tasks 应返回数组");
        assert_eq!(arr.len(), 1);
        let obj = arr[0].as_object().expect("元素应为 object");

        assert_eq!(obj["issue_key"].as_str(), Some("fad-backend#1247"));
        assert_eq!(obj["owner"].as_str(), Some("FoodsUp-Inc"));
        assert_eq!(obj["repo"].as_str(), Some("fad-backend"));
        assert_eq!(obj["number"].as_i64(), Some(1247));
        assert_eq!(obj["title"].as_str(), Some("修复支付回调"));
        assert_eq!(
            obj["url"].as_str(),
            Some("https://github.com/FoodsUp-Inc/fad-backend/issues/1247")
        );
        assert_eq!(obj["issue_state"].as_str(), Some("open"));
        assert_eq!(obj["ownership"].as_str(), Some("notassignee"));
        assert_eq!(obj["status"].as_str(), Some("doing"));
        assert_eq!(obj["project_status"].as_str(), Some("In Progress"));
        assert_eq!(obj["assignees"].as_str(), Some("alice"));
        assert_eq!(obj["mentioned"].as_i64(), Some(1));
        assert_eq!(obj["latest_comment_url"].as_str(), Some("www.comment"));
        assert_eq!(obj["pr_number"].as_i64(), Some(42));
        assert_eq!(obj["pr_url"].as_str(), Some("www.pr"));
        assert_eq!(obj["branch"].as_str(), Some("main"));
        assert_eq!(obj["work_branch"].as_str(), Some("feature/pay"));
        assert_eq!(obj["session_id"].as_str(), Some("sess-1"));
        assert_eq!(obj["session_agent"].as_str(), Some("claude-code"));
        assert_eq!(obj["session_at"].as_i64(), Some(1700000000));
        assert_eq!(obj["handoff"].as_str(), Some("handoff-1"));
        assert_eq!(obj["candidate_done"].as_i64(), Some(0));
        assert_eq!(obj["account_id"].as_i64(), Some(1));
        assert_eq!(obj["updated_at"].as_i64(), Some(1700000100));
        // #278：父子关系原样透传（JSON 串，非结构化）——位置索引 24/25 不能错位。
        assert_eq!(
            obj["parent_issue"].as_str(),
            Some(
                "{\"number\":900,\"title\":\"支付重构\",\"url\":\"https://github.com/FoodsUp-Inc/fad-backend/issues/900\"}"
            ),
            "parent_issue 应为 JSON 对象串"
        );
        assert_eq!(
            obj["sub_issues"].as_str(),
            Some(
                "[{\"number\":1300,\"title\":\"支付回调子任务\",\"url\":\"https://github.com/FoodsUp-Inc/fad-backend/issues/1300\"}]"
            ),
            "sub_issues 应为 JSON 数组串"
        );
    }

    #[test]
    fn get_task_status_returns_correct_column_values() {
        let c = test_conn();
        insert_sample(&c);
        let out = tool_get(&c, "fad-backend#1247").unwrap();
        let obj = out.as_object().expect("get_task_status 应返回 object");
        assert_eq!(obj["found"].as_bool(), Some(true));
        assert_eq!(obj["issue_key"].as_str(), Some("fad-backend#1247"));
        assert_eq!(obj["owner"].as_str(), Some("FoodsUp-Inc"));
        assert_eq!(obj["repo"].as_str(), Some("fad-backend"));
        assert_eq!(obj["number"].as_i64(), Some(1247));
        assert_eq!(obj["title"].as_str(), Some("修复支付回调"));
        assert_eq!(obj["project_status"].as_str(), Some("In Progress"));
        assert_eq!(obj["assignees"].as_str(), Some("alice"));
        assert_eq!(obj["work_branch"].as_str(), Some("feature/pay"));
        assert_eq!(obj["session_id"].as_str(), Some("sess-1"));
        assert_eq!(obj["handoff"].as_str(), Some("handoff-1"));
        assert_eq!(obj["updated_at"].as_i64(), Some(1700000100));
        // #278：父子关系同样透传到单 issue 查询。
        assert!(obj["parent_issue"].as_str().unwrap().starts_with("{\"number\":900"));
        assert!(obj["sub_issues"].as_str().unwrap().starts_with("[{\"number\":1300"));
        // 用一条不存在的引用验证「未找到」分支
        let missing = tool_get(&c, "nope#999").unwrap();
        assert_eq!(missing["found"].as_bool(), Some(false));
        assert_eq!(missing["issue_key"].as_str(), Some("nope#999"));
    }

    // ── v0.4.1 (#250)：未命中时的按需拉取契约 ──────────────────────────────
    //
    // 完整路径要打真实 GitHub，无法在单测里跑；这里锁住两条**不发网络请求**的契约，
    // 它们正是「未同步的 issue 卡死 agent」修复里最容易回归的部分。

    /// 本地已有该行 → 不做任何拉取（返回 false = 未拉取），无账号也不影响。
    #[test]
    fn on_demand_skips_network_when_row_exists() {
        let c = test_conn();
        insert_sample(&c);
        let pulled = ensure_local_task(&c, "fad-backend#1247", "FoodsUp-Inc/fad-backend#1247")
            .expect("行已存在时不应报错");
        assert!(!pulled, "行已存在时不应触发按需拉取");
        // 写操作照旧生效，返回体带 pulled: false
        let out = tool_update(&c, "FoodsUp-Inc/fad-backend#1247", "已完成").unwrap();
        assert_eq!(out["ok"].as_bool(), Some(true));
        assert_eq!(out["pulled"].as_bool(), Some(false));
        assert_eq!(out["status"].as_str(), Some("done"));
    }

    /// 无任何账号时：报错并说明原因，**不发网络请求**（连客户端都不会构造）。
    #[test]
    fn on_demand_without_account_fails_fast_with_reason() {
        let c = test_conn();
        c.execute_batch("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);")
            .unwrap();
        c.execute_batch(
            "CREATE TABLE accounts (
                id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT NOT NULL, login TEXT NOT NULL,
                org TEXT NOT NULL, pat_token TEXT NOT NULL, is_default INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL);",
        )
        .unwrap();
        let err = ensure_local_task(&c, "task-dashboard#248", "task-dashboard#248").unwrap_err();
        assert!(err.contains("无法从 GitHub 拉取"), "错误应说明无法拉取: {err}");
        assert!(err.contains("没有任何 GitHub 账号"), "错误应带具体原因: {err}");
        // 写工具同样给出可读错误，而不是含糊的「任务不存在」
        let werr = tool_update(&c, "task-dashboard#248", "处理中").unwrap_err();
        assert!(werr.contains("没有任何 GitHub 账号"), "{werr}");
    }

    // ── #279：set_work_branch 只更新 work_branch，不碰 PR branch ───────────────

    /// set_work_branch 写入 work_branch，且不影响 PR 的 branch 列。
    #[test]
    fn set_work_branch_updates_only_work_branch() {
        let c = test_conn();
        insert_sample(&c);
        // 样本中 branch=main、work_branch=feature/pay
        let out = tool_set_work_branch(&c, "fad-backend#1247", "feature/issue-279-fix").unwrap();
        assert_eq!(out["ok"].as_bool(), Some(true));
        assert_eq!(out["work_branch"].as_str(), Some("feature/issue-279-fix"));

        let obj = tool_get(&c, "fad-backend#1247").unwrap();
        assert_eq!(obj["work_branch"].as_str(), Some("feature/issue-279-fix"));
        // PR branch 列不受影响
        assert_eq!(obj["branch"].as_str(), Some("main"));
    }

    /// set_work_branch 对不存在的 issue 报错（不清空、不静默）。
    /// 需显式建空 `accounts` 表（与 `on_demand_without_account_fails_fast_with_reason` 同夹具），
    /// 否则按需拉取在「查账号列表」时先报 no such table，掩盖真实错误文案。
    #[test]
    fn set_work_branch_errors_on_missing_issue() {
        let c = test_conn();
        c.execute_batch("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);")
            .unwrap();
        c.execute_batch(
            "CREATE TABLE accounts (
                id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT NOT NULL, login TEXT NOT NULL,
                org TEXT NOT NULL, pat_token TEXT NOT NULL, is_default INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL);",
        )
        .unwrap();
        let err = tool_set_work_branch(&c, "nope#999", "feature/x").unwrap_err();
        // 无账号：走按需拉取 → 明确报「无法从 GitHub 拉取」，而不是含糊的「任务不存在」
        assert!(
            err.contains("无法从 GitHub 拉取") || err.contains("没有任何 GitHub 账号"),
            "{err}"
        );
        assert!(!err.contains("no such table"), "{err}");
    }

    /// set_work_branch 的 branch 为空时报错（清空请用 clear_work_branch）。
    #[test]
    fn set_work_branch_rejects_empty_branch() {
        let c = test_conn();
        insert_sample(&c);
        let err = tool_set_work_branch(&c, "fad-backend#1247", "   ").unwrap_err();
        assert!(err.contains("branch 不能为空"), "{err}");
    }
}

//! 按需拉取单个 issue（v0.4.1 / #250）。
//!
//! 背景：`tasks` 表**只由 `sync.rs` 从 GitHub 单向拉取填充**，而 MCP 工具是纯本地
//! SQL。刚创建、还没同步到的 issue 会让所有写路径报「任务不存在」，把 agent 工作流
//! 卡在第一步（实测：issue 建于 10:26，10:52 调用 `update_task_status` 仍失败）。
//!
//! 本模块补上「本地未命中 → 拉取该单个 issue → 落库」这条通道：
//! - 只读 GitHub（单次 `GET /repos/{owner}/{repo}/issues/{n}`），**不写回、不触发全量同步**
//! - 只在**本地未命中**时发生网络请求；已存在的任务零额外调用
//! - 落库用 [`TaskWriteMode::InsertIfAbsent`]，绝不覆盖同步写入的字段（见该枚举说明）

use rusqlite::Connection;

use crate::db::{Account, TaskUpsert, TaskWriteMode};

/// 归一化后的 issue 引用。
///
/// 与 `mcp.rs` 原有的 `parse_issue_ref`（只回 `repo#number` 主键）不同，本结构**保留 owner**
/// —— 拉取单个 issue 需要 `owner` + `repo` 才能定位资源。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IssueRef {
    /// 引用里**显式**给出的 owner（`owner/repo#N` 或 URL）。只给 `repo#N` 时为 `None`。
    pub owner: Option<String>,
    pub repo: String,
    pub number: i64,
    /// DB 主键口径：`repo#number`。
    pub key: String,
}

/// 解析 issue 引用：`repo#number` / `owner/repo#number` / GitHub URL 三种写法。
///
/// 错误文案与 `mcp.rs` 原实现逐字一致（对 agent 可见，不随意改写）。
pub fn parse_issue_ref_parts(ref_: &str) -> Result<IssueRef, String> {
    let r = ref_.trim();
    if r.is_empty() {
        return Err("issue 引用为空".to_string());
    }
    // URL 形式：https://github.com/{owner}/{repo}/issues/{n}
    if let Some(idx) = r.find("github.com/") {
        let rest = &r[idx + "github.com/".len()..];
        let parts: Vec<&str> = rest.split('/').collect();
        if parts.len() >= 4 {
            let owner = parts[0].trim();
            let repo = parts[1];
            if let Ok(n) = parts[3].trim_start_matches('#').parse::<i64>() {
                if n > 0 && !repo.is_empty() {
                    return Ok(IssueRef {
                        owner: if owner.is_empty() {
                            None
                        } else {
                            Some(owner.to_string())
                        },
                        repo: repo.to_string(),
                        number: n,
                        key: format!("{repo}#{n}"),
                    });
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
        // owner 只在写了 `owner/repo#N`（含 `/`）时才采信，否则留给账号的 org 兜底。
        let owner = left
            .rsplit_once('/')
            .map(|(o, _)| o.trim().to_string())
            .filter(|o| !o.is_empty());
        return Ok(IssueRef {
            owner,
            repo: repo.to_string(),
            number: n,
            key: format!("{repo}#{n}"),
        });
    }
    Err(format!("无法解析 issue 引用: {ref_}"))
}

/// [`ensure_task_available`] 的结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EnsureOutcome {
    /// 本地已有该任务：无需任何网络请求。
    AlreadyLocal,
    /// 已从 GitHub 拉取并落库。
    Pulled,
    /// 远端确实没有这个 issue（404，或该编号其实是 PR）。
    ///
    /// 携带**实际查询目标**的说明：`ref` 不带 owner 时 owner 是按账号推断的，
    /// 此时「远端没有」很可能是推断错了命名空间（`AGENTS.md §7` 允许 `repo#N` 写法），
    /// 必须让 agent 看得出这一点，否则会误判成「issue 不存在」。
    RemoteNotFound(String),
    /// 无法拉取（无账号 / owner 无匹配账号 / 未配 PAT / 网络或鉴权失败），附原因。
    Unavailable(String),
}

impl EnsureOutcome {
    /// 本次调用是否真的拉取并落库（供 MCP 在返回体里标 `pulled`）。
    pub fn pulled(&self) -> bool {
        matches!(self, Self::Pulled)
    }
}

/// 「远端没有」的说明文案：带上实际查询目标；owner 系推断时提示改用显式引用。
fn missing_detail(owner: &str, r: &IssueRef, owner_inferred: bool) -> String {
    let mut s = format!(
        "已按 `{owner}/{}#{}` 查询，远端没有该 issue（或该编号是 PR）",
        r.repo, r.number
    );
    if owner_inferred {
        s.push_str("；该 owner 是由账号推断的，若仓库属于其他命名空间，请用 `owner/repo#N` 形式指定");
    }
    s
}

/// 账号选择结果。`Unavailable` 是**正常的业务结论**（不是程序错误），
/// 所以要带回原因给 agent，而不是与 DB 错误混在一个 `Err` 里。
#[derive(Debug)]
enum PickAccount {
    Found(Account),
    Unavailable(String),
}

/// 账号可认领的 owner 集合（统一小写）。
///
/// **`org` 与 `login` 都算认领者**：实测本地库里 task-dashboard 所属账号的 `org` 是**空串**
/// （个人命名空间仓库），此时 `tasks.owner` 也写成空。若只按 `org` 匹配，
/// `ShawnLiuSZ/task-dashboard#250` 会找不到账号——恰好是本功能最需要可用的场景。
/// 个人命名空间下仓库 owner 就是登录名，所以 `login` 必须参与匹配。
fn account_owners(a: &Account) -> Vec<String> {
    let mut v: Vec<String> = Vec::new();
    for s in [a.org.trim(), a.login.trim()] {
        if !s.is_empty() {
            let l = s.to_lowercase();
            if !v.contains(&l) {
                v.push(l);
            }
        }
    }
    v
}

/// 已知 owner 列表（保留原始大小写、去重），仅用于错误文案提示。
fn known_owners(accounts: &[Account]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for a in accounts {
        for s in [a.org.trim(), a.login.trim()] {
            if s.is_empty() {
                continue;
            }
            if !out.iter().any(|x| x.eq_ignore_ascii_case(s)) {
                out.push(s.to_string());
            }
        }
    }
    out
}

/// 选出用于拉取的账号。
///
/// `tasks` 的唯一键是 `(repo, number, account_id)`，选错账号会插出一行**重复任务**，
/// 所以优先按 ref 里的 owner 精确匹配：
/// 1. ref 带 owner → 与账号的 `org` / `login`（大小写不敏感）匹配（多个候选取 `is_default`，否则第一个）
/// 2. ref 只有 repo → 退回 `db::default_account_id`
/// 3. owner 无匹配账号 → `Unavailable` 并列出已知 owner（不静默落到默认账号）
/// 4. 无账号 / PAT 为空 → `Unavailable`（**不发无意义的网络请求**）
fn pick_account(conn: &Connection, owner: Option<&str>) -> Result<PickAccount, String> {
    let accounts = crate::db::list_accounts(conn)?;
    if accounts.is_empty() {
        return Ok(PickAccount::Unavailable(
            "本地没有任何 GitHub 账号，请先在 TaskBoard 中添加账号与 PAT".to_string(),
        ));
    }
    let chosen = match owner {
        Some(o) => {
            let lower = o.to_lowercase();
            let matched: Vec<&Account> = accounts
                .iter()
                .filter(|a| account_owners(a).contains(&lower))
                .collect();
            match matched.iter().find(|a| a.is_default).or_else(|| matched.first()) {
                Some(a) => (*a).clone(),
                None => {
                    return Ok(PickAccount::Unavailable(format!(
                        "ref 里的 owner `{o}` 没有对应账号（已知 owner/org: {}）",
                        known_owners(&accounts).join(", ")
                    )));
                }
            }
        }
        None => {
            let id = crate::db::default_account_id(conn)?;
            accounts
                .iter()
                .find(|a| a.id == id)
                .cloned()
                .unwrap_or_else(|| accounts[0].clone())
        }
    };
    if !chosen.has_pat {
        // `has_pat` 由 `list_accounts` 从 `pat_token` 是否为空算出；仅空白字符的情况
        // 由调用方取到真 token 后再校验（见 ensure_task_available）。
        return Ok(PickAccount::Unavailable(format!(
            "账号 @{} 未配置 PAT",
            chosen.login
        )));
    }
    Ok(PickAccount::Found(chosen))
}

/// 任务是否已在本地库中。供 MCP 写路径在写入前判断是否需要按需拉取。
pub fn task_exists(conn: &Connection, key: &str) -> Result<bool, String> {
    let n: i64 = conn
        .query_row(
            "SELECT COUNT(1) FROM tasks WHERE issue_key = ?1",
            [key],
            |r| r.get(0),
        )
        .map_err(|e| format!("查询任务失败: {e}"))?;
    Ok(n > 0)
}

/// 账号的「默认 owner」：`org` 优先，为空则退回 `login`（个人命名空间仓库）。
///
/// 实测 task-dashboard 所属账号 `org` 为空串，直接拼 URL 会得到 `/repos//repo/...`。
fn default_owner_of(a: &Account) -> String {
    let org = a.org.trim();
    if !org.is_empty() {
        org.to_string()
    } else {
        a.login.trim().to_string()
    }
}

/// 把拉取到的单个 issue 组装成待写入行。
///
/// 状态与归属**复用同步的同一套判定**（[`crate::sync::resolve_final_status`] /
/// [`crate::sync::classify`]），不另写一套口径。
///
/// `task.owner` 写 `account.org`（**与同步一致**，即便是空串）——该列是「归属账号的 org」
/// 语义，不是 API 请求用的 owner，两者不要混。
fn build_task_row(
    conn: &Connection,
    r: &IssueRef,
    account: &Account,
    raw: &crate::github::RawTask,
    now: i64,
) -> Result<TaskUpsert, String> {
    let labels_csv = raw.labels.join(",");
    let label_rules = crate::db::load_label_rules(conn)?;
    // 显式 label 映射（含映射到 todo 的情况，#192）优先于 Project Status。
    let explicit_label = crate::db::resolve_status_from_rules_explicit(
        &label_rules,
        &account.org,
        &r.repo,
        &labels_csv,
    );
    // Project Status 只能走 GraphQL，单 issue REST 响应没有 → 传空串 / None，
    // 于是 `resolve_final_status` 走到「兜底」分支：新建行按 §2.2 口径取 todo。
    let status = crate::sync::resolve_final_status(raw.state == "closed", None, explicit_label, "", "todo");
    let done_at = if status == "done" { now } else { 0 };
    Ok(TaskUpsert {
        issue_key: r.key.clone(),
        // 归属列与同步一致：写账号的 org（可能为空串），不是 API 请求用的 owner。
        owner: account.org.clone(),
        account_id: account.id,
        repo: r.repo.clone(),
        number: r.number,
        title: raw.title.clone(),
        url: raw.url.clone(),
        issue_state: raw.state.clone(),
        ownership: crate::sync::classify(&raw.assignees, &account.login).to_string(),
        status,
        project_status: String::new(),
        assignees: raw.assignees.join(","),
        labels: labels_csv,
        author: raw.author.clone(),
        done_at,
        // `mentioned` 依赖 Search API 的 mentions 源；按需拉取只认显式引用的这个 issue，
        // 记 0。下次全量同步会按真实情况修正。
        mentioned: 0,
        comments_count: raw.comments as i64,
        // 以下字段来自多源聚合（评论回源 / PR 关联 / 分支反查 / 父子关系 GraphQL），
        // 单 issue REST 给不了，留空；下次全量同步补。
        latest_comment_url: String::new(),
        pr_number: 0,
        pr_url: String::new(),
        branch: String::new(),
        parent_issue: String::new(),
        sub_issues: String::new(),
        updated_at: crate::common::iso8601_to_secs(&raw.updated_at),
        exists: false,
    })
}

/// 保证该 issue 在本地库中存在；不存在则按需从 GitHub 拉取并落库。
///
/// 调用方约定：拿到 `Ok(EnsureOutcome::*)` 后按语义决定返回给 agent 的文案；
/// `Err` 仅表示本地 DB 层面的失败。
pub fn ensure_task_available(conn: &Connection, ref_: &str) -> Result<EnsureOutcome, String> {
    let r = parse_issue_ref_parts(ref_)?;
    if task_exists(conn, &r.key)? {
        return Ok(EnsureOutcome::AlreadyLocal);
    }
    let account = match pick_account(conn, r.owner.as_deref())? {
        PickAccount::Found(a) => a,
        PickAccount::Unavailable(reason) => return Ok(EnsureOutcome::Unavailable(reason)),
    };
    // API 请求用的 owner：ref 显式给的优先；否则用账号的 org，org 为空则退回 login
    // （个人命名空间仓库，实测 task-dashboard 所属账号 org 就是空串）。
    // `owner_inferred` 决定「远端没有」时要不要提示改写引用形式。
    let owner_inferred = r.owner.is_none();
    let api_owner = match &r.owner {
        Some(o) => o.clone(),
        None => default_owner_of(&account),
    };
    // `Account` 刻意不回显 token（只给 has_pat），真 token 须单独取。
    let (_login, _org, pat) = match crate::db::get_account_pat(conn, account.id) {
        Ok(v) => v,
        Err(e) => return Ok(EnsureOutcome::Unavailable(e)),
    };
    if pat.trim().is_empty() {
        return Ok(EnsureOutcome::Unavailable(format!(
            "账号 @{} 未配置 PAT",
            account.login
        )));
    }

    let client = match crate::github::GitHubClient::new(pat, account.login.clone(), api_owner.clone()) {
        Ok(c) => c,
        Err(e) => {
            return Ok(EnsureOutcome::Unavailable(format!(
                "构造 GitHub 客户端失败: {e}"
            )))
        }
    };
    let raw = match client.fetch_issue(&api_owner, &r.repo, r.number) {
        Ok(Some(t)) => t,
        Ok(None) => {
            return Ok(EnsureOutcome::RemoteNotFound(missing_detail(
                &api_owner,
                &r,
                owner_inferred,
            )))
        }
        Err(e) => return Ok(EnsureOutcome::Unavailable(e)),
    };
    // `GET /issues/{n}` 对 PR 也返回 200（响应带 `pull_request`）；看板任务只认 issue。
    if raw.is_pr {
        return Ok(EnsureOutcome::RemoteNotFound(missing_detail(
            &api_owner,
            &r,
            owner_inferred,
        )));
    }

    let now = crate::sync::now_secs();
    let row = build_task_row(conn, &r, &account, &raw, now)?;
    // 竞态防护：拉取期间 App 的同步可能刚好写入了这一行。用 InsertIfAbsent——
    // 行已存在则零副作用，**绝不覆盖**同步写入的 project_status / mentioned / pr_* 等字段
    // （按需拉取拿不到这些值，覆盖即等于清空）。
    crate::db::write_task(conn, &row, now, TaskWriteMode::InsertIfAbsent)?;
    Ok(EnsureOutcome::Pulled)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_ref_keeps_owner_when_given() {
        let r = parse_issue_ref_parts("FoodsUp-Inc/fad-backend#1234").unwrap();
        assert_eq!(r.owner.as_deref(), Some("FoodsUp-Inc"));
        assert_eq!(r.repo, "fad-backend");
        assert_eq!(r.number, 1234);
        assert_eq!(r.key, "fad-backend#1234");
    }

    #[test]
    fn parse_ref_without_owner_leaves_none() {
        let r = parse_issue_ref_parts("task-dashboard#248").unwrap();
        assert_eq!(r.owner, None);
        assert_eq!(r.repo, "task-dashboard");
        assert_eq!(r.key, "task-dashboard#248");
    }

    #[test]
    fn parse_ref_from_url_keeps_owner() {
        let r = parse_issue_ref_parts("https://github.com/ShawnLiuSZ/task-dashboard/issues/248").unwrap();
        assert_eq!(r.owner.as_deref(), Some("ShawnLiuSZ"));
        assert_eq!(r.repo, "task-dashboard");
        assert_eq!(r.number, 248);
        assert_eq!(r.key, "task-dashboard#248");
        // 尾部锚点 / 空白容忍
        assert_eq!(
            parse_issue_ref_parts("  https://github.com/o/r/issues/7  ").unwrap().key,
            "r#7"
        );
    }

    #[test]
    fn parse_ref_rejects_invalid() {
        assert!(parse_issue_ref_parts("").is_err());
        assert!(parse_issue_ref_parts("plain text").is_err());
        assert!(parse_issue_ref_parts("repo#abc").is_err());
        assert!(parse_issue_ref_parts("repo#0").is_err());
        assert!(parse_issue_ref_parts("#12").is_err());
        // 错误文案保持原样（对 agent 可见）
        assert_eq!(
            parse_issue_ref_parts("repo#abc").unwrap_err(),
            "issue 编号非法: abc"
        );
        assert_eq!(parse_issue_ref_parts("").unwrap_err(), "issue 引用为空");
    }

    /// 建一张含 accounts 表的内存库，用于账号选择分支的测试。
    /// 行格式：`(id, login, org, is_default)`。
    fn conn_with_accounts(rows: &[(i64, &str, &str, i64)]) -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(
            "CREATE TABLE accounts (
                id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT NOT NULL, login TEXT NOT NULL,
                org TEXT NOT NULL, pat_token TEXT NOT NULL, is_default INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL);
             CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
        )
        .unwrap();
        for (id, login, org, is_default) in rows {
            c.execute(
                "INSERT INTO accounts (id, label, login, org, pat_token, is_default, created_at)
                 VALUES (?1, 'l', ?2, ?3, 'pat-x', ?4, 0)",
                rusqlite::params![id, login, org, is_default],
            )
            .unwrap();
        }
        c
    }

    #[test]
    fn pick_account_matches_owner_case_insensitively() {
        let c = conn_with_accounts(&[(1, "alice", "Acme", 0), (2, "bob", "FoodsUp-Inc", 1)]);
        match pick_account(&c, Some("foodsup-inc")).unwrap() {
            PickAccount::Found(a) => assert_eq!(a.login, "bob"),
            other => panic!("应命中 org 匹配的账号，实际: {other:?}"),
        }
    }

    #[test]
    fn pick_account_unknown_owner_is_unavailable_with_org_list() {
        let c = conn_with_accounts(&[(1, "alice", "Acme", 0)]);
        match pick_account(&c, Some("nope")).unwrap() {
            PickAccount::Unavailable(reason) => {
                assert!(reason.contains("nope"), "原因应含 owner: {reason}");
                assert!(reason.contains("Acme"), "原因应列出已知 org: {reason}");
            }
            other => panic!("无匹配账号应为 Unavailable，实际: {other:?}"),
        }
    }

    #[test]
    fn pick_account_without_owner_uses_default() {
        let c = conn_with_accounts(&[(1, "alice", "Acme", 0), (2, "bob", "Other", 1)]);
        match pick_account(&c, None).unwrap() {
            PickAccount::Found(a) => assert_eq!(a.login, "bob"), // is_default = 1
            other => panic!("应取默认账号，实际: {other:?}"),
        }
    }

    #[test]
    fn pick_account_matches_login_when_org_is_empty() {
        // 真实场景（实测本地库）：task-dashboard 所属账号 org 为空串（个人命名空间），
        // 只按 org 匹配会让 `ShawnLiuSZ/task-dashboard#N` 找不到账号，本功能对该仓库完全不可用。
        let c = conn_with_accounts(&[
            (4, "ShawnLiuSZ", "", 0),
            (5, "liushizhao2025", "FoodsUp-Inc", 1),
        ]);
        match pick_account(&c, Some("shawnliusz")).unwrap() {
            PickAccount::Found(a) => assert_eq!(a.login, "ShawnLiuSZ"),
            other => panic!("owner 应按 login 命中的账号，实际: {other:?}"),
        }
        // org 仍照旧可命中
        match pick_account(&c, Some("foodsup-inc")).unwrap() {
            PickAccount::Found(a) => assert_eq!(a.login, "liushizhao2025"),
            other => panic!("owner 应按 org 命中的账号，实际: {other:?}"),
        }
    }

    fn account(id: i64, login: &str, org: &str) -> Account {
        Account {
            id,
            label: "l".to_string(),
            login: login.to_string(),
            org: org.to_string(),
            has_pat: true,
            is_default: false,
            board_mode: "project".to_string(),
            created_at: 0,
        }
    }

    #[test]
    fn default_owner_falls_back_to_login_when_org_empty() {
        // org 为空时必须退回 login，否则 API URL 会拼成 `/repos//repo/...`
        assert_eq!(default_owner_of(&account(1, "ShawnLiuSZ", "")), "ShawnLiuSZ");
        assert_eq!(
            default_owner_of(&account(2, "bob", "FoodsUp-Inc")),
            "FoodsUp-Inc"
        );
    }

    #[test]
    fn pick_account_empty_pat_is_unavailable() {
        let c = conn_with_accounts(&[(1, "alice", "Acme", 1)]);
        // has_pat = false：把 pat_token 置空
        c.execute("UPDATE accounts SET pat_token = '' WHERE id = 1", [])
            .unwrap();
        match pick_account(&c, None).unwrap() {
            PickAccount::Unavailable(reason) => assert!(reason.contains("未配置 PAT"), "{reason}"),
            other => panic!("PAT 为空应为 Unavailable（且不发网络请求），实际: {other:?}"),
        }
    }

    #[test]
    fn pick_account_no_accounts_is_unavailable() {
        let c = conn_with_accounts(&[]);
        match pick_account(&c, None).unwrap() {
            PickAccount::Unavailable(reason) => assert!(reason.contains("没有任何 GitHub 账号"), "{reason}"),
            other => panic!("无账号应为 Unavailable，实际: {other:?}"),
        }
    }
}

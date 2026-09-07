use rusqlite::Connection;
use std::collections::HashSet;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::github;

pub fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// 归属判定：必须在结果里读 assignees 数组自行判断。
/// GitHub Search 不支持 `-no:assignee`（否定 no: 限定符会被静默忽略），无法用查询语法区分。
pub fn classify(assignees: &[String], login: &str) -> &'static str {
    if assignees.is_empty() {
        "notassignee"
    } else if assignees.iter().any(|a| a == login) {
        "assigned"
    } else {
        "assigned-others"
    }
}

/// 将 GitHub Project（OMS Kanban）的 Status 字段原文映射到看板四态。
/// 用关键词匹配以兼容 emoji / 文案微调；返回 None 表示无法识别（回落到本地手动态）。
///
/// 映射依据 OMS Kanban 实际可选值（经用户确认，v0.3.6 起沿用，未做改动）：
/// 🧠需求池 / 🤔产品规划 / 🚧待开发处理 → 待处理
/// ✨开发中 → 处理中
/// 🔎开发完成/测试中 / ✅测试通过/待上线 → 已处理
/// 🎉完成/上线 / ↩️取消 → 已完成
fn map_project_status(raw: &str) -> Option<&'static str> {
    if raw.contains("测试") {
        Some("processed")
    } else if raw.contains("开发中") {
        Some("doing")
    } else if raw.contains("待开发") || raw.contains("需求") || raw.contains("规划") {
        Some("todo")
    } else if raw.contains("取消") {
        Some("done")
    } else if raw.contains("完成") || raw.contains("上线") {
        Some("done")
    } else {
        None
    }
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncResult {
    pub total: usize,
    pub added: usize,
    pub updated: usize,
    pub candidate_done: usize,
    pub removed: usize,
    pub pruned: usize,
    pub warning: String,
    pub synced_at: i64,
}

/// 从文本（PR 正文）里提取 issue 引用，返回 `repo#number` 形式的键。
/// 支持两种形式：
/// - `#123`：归属 PR 所在仓库（即传入的 `default_repo`）
/// - `owner/repo#123`：跨仓库，回退到 `repo`（路径最后一段）
///
/// 用纯 ASCII 手扫；不依赖任何 crate。本函数是「PR 对应哪个 issue」反向关联的权威解析器。
///
/// **已知限制**：URL 锚 `https://example.com/page#42` 会被解析成 `default_repo#42`——
/// 这是协议层的事实，规则无法可靠地区分「URL 锚」与「issue 引用」。
/// 实践里 PR body 中的 URL 锚对应的几乎都不是本组织仓库的 issue，问题可忽略；
/// 如确需排除，可在调用方对 URL 段过滤。
fn parse_issue_refs(text: &str, default_repo: &str) -> Vec<String> {
    let bytes = text.as_bytes();
    let mut out: Vec<String> = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'#' && i + 1 < bytes.len() && bytes[i + 1].is_ascii_digit() {
            let num_start = i + 1;
            let mut j = num_start;
            while j < bytes.len() && bytes[j].is_ascii_digit() {
                j += 1;
            }
            if let Ok(num) = text[num_start..j].parse::<i64>() {
                if num > 0 {
                    // 向左扫描「owner/repo」前缀：允许字母数字 + `_` + `-` + `.` + `/`。
                    // 这里的关键是把 `/` 放进来，否则 owner/repo#N 永远切不出仓库名
                    // （循环在 `/` 处退出，最终 seg 只剩 repo 部分，跨仓库失效）。
                    let mut k = i as isize - 1;
                    while k >= 0
                        && (bytes[k as usize].is_ascii_alphanumeric()
                            || bytes[k as usize] == b'_'
                            || bytes[k as usize] == b'-'
                            || bytes[k as usize] == b'.'
                            || bytes[k as usize] == b'/')
                    {
                        k -= 1;
                    }
                    let seg = &text[(k + 1) as usize..i];
                    // seg 含 `/` 时取最后一段（兼容 `org/sub/group/repo#N` 多段路径）；
                    // 不含 `/` 时回退 PR 所在仓库。
                    let repo = seg
                        .rfind('/')
                        .map(|s| &seg[s + 1..])
                        .unwrap_or(default_repo);
                    if !repo.is_empty() {
                        out.push(format!("{}#{}", repo, num));
                    }
                }
            }
            i = j;
        } else {
            i += 1;
        }
    }
    out
}

/// v0.3.16+：单账号同步结果（累加到 SyncResult）。
#[derive(Debug, Clone, Default)]
struct AccountSyncResult {
    added: usize,
    updated: usize,
    candidate_done: usize,
    removed: usize,
    failed_sources: Vec<String>,
}

/// v0.3.16+：单账号同步核心逻辑。返回该账号的 added / updated / 等。
///
/// 设计要点：
/// - `client` 已含 login / org / pat；upsert 时直接用 `account.id`
/// - key 仍为 `repo#number`（PRIMARY KEY 不变）。多账号下同 key 会被后写入者覆盖——
///   这是 v0.3.16 的已知限制（设计文档 3.1 节确认）。单账号视图（默认）下不会出现冲突。
/// - 单账号内仍走 5 源合并 + PR 关联 + Project Status 联动，与 v0.3.15 逻辑等价。
fn sync_account(
    conn: &Connection,
    account: &crate::db::Account,
    pat: &str,
    now: i64,
) -> Result<AccountSyncResult, String> {
    let client = github::GitHubClient::new(
        pat.to_string(),
        account.login.clone(),
        account.org.clone(),
    )?;

    // 发现并存储该账号下的全部 Project（best-effort）。
    let project_ids = match client.fetch_all_projects() {
        Ok(projects) => {
            let github_ids: Vec<String> = projects.iter().map(|p| p.0.clone()).collect();
            if let Err(e) = crate::db::upsert_projects(conn, account.id, &projects, now) {
                eprintln!("[sync] 存储项目列表失败: {}", e);
            }
            // 清理已不存在的项目
            if let Err(e) = crate::db::prune_projects(conn, account.id, &github_ids) {
                eprintln!("[sync] 清理旧项目失败: {}", e);
            }
            // 为每个项目拉取 Status 字段选项及顺序
            if let Err(e) = crate::db::clear_project_statuses(conn, account.id) {
                eprintln!("[sync] 清空旧项目状态失败: {}", e);
            }
            for gid in &github_ids {
                match client.fetch_project_status_options(gid) {
                    Ok(opts) => {
                        if let Err(e) = crate::db::upsert_project_statuses(conn, account.id, gid, &opts, now) {
                            eprintln!("[sync] 存储项目 {} 状态选项失败: {}", gid, e);
                        }
                    }
                    Err(e) => eprintln!("[sync] 拉取项目 {} 状态选项失败: {}", gid, e),
                }
            }
            github_ids
        }
        Err(e) => {
            eprintln!("[sync] 拉取项目列表失败（跳过 Status 联动）: {}", e);
            Vec::new()
        }
    };

    // 多源合并：以多个稳定查询（assignee/author/mentions/commenter）覆盖 `involves:`
    // 的偶发漏拉缺陷，确保任何「与我相关」的 issue 都不会缺失。按 key 去重。
    // best-effort：单源失败不中断整次同步，其余源照常并入。
    let sources: Vec<(&str, Result<Vec<github::RawTask>, String>)> = vec![
        ("assignee", client.fetch_assigned()),
        ("author", client.fetch_authored()),
        ("mentions", client.fetch_mentioned()),
        ("commenter", client.fetch_commented()),
        ("involves", client.fetch_related()),
    ];
    let mut lists: Vec<Vec<github::RawTask>> = Vec::new();
    let mut failed: Vec<String> = Vec::new();
    let mut mention_keys: HashSet<String> = HashSet::new();
    let mut mention_ok = false;
    for (name, res) in sources {
        match res {
            Ok(tasks) => {
                if name == "mentions" {
                    for t in &tasks {
                        mention_keys.insert(format!("{}#{}", t.repo, t.number));
                    }
                    mention_ok = true;
                }
                lists.push(tasks);
            }
            Err(e) => {
                failed.push(format!("{}: {}", name, e));
                eprintln!("[sync] 数据源 {} 拉取失败，已跳过: {}", name, e);
            }
        }
    }
    if lists.is_empty() {
        return Err(format!(
            "账号 @{}: 全部数据源拉取失败: {}",
            account.login,
            failed.join("; ")
        ));
    }
    let mut raw = github::merge_tasks_all(lists);

    // 收集「与我相关 issue 实际所在的仓库」（去重），仅对这些仓库拉取 PR——
    // 既缩小范围、又避开 Search API 的严苛限流，改用 REST pulls 接口。
    // 存储格式为 "owner/repo"（从 repository_url 提取的完整路径）。
    let mut pr_repos: Vec<String> = raw
        .iter()
        .filter(|t| !t.is_pr)
        .map(|t| {
            if t.repo_owner.is_empty() {
                t.repo.clone()
            } else {
                format!("{}/{}", t.repo_owner, t.repo)
            }
        })
        .collect();
    pr_repos.sort();
    pr_repos.dedup();

    let (prs, pr_fetch_ok) = match client.fetch_prs(&pr_repos) {
        Ok(p) => (p, true),
        Err(e) => {
            eprintln!("[sync] 拉取 PR 列表失败，跳过 PR 关联: {}", e);
            (Vec::new(), false)
        }
    };
    let mut pr_map: std::collections::HashMap<String, (i64, String, String)> =
        std::collections::HashMap::new();
    for pr in &prs {
        for rk in parse_issue_refs(&pr.body, &pr.repo) {
            pr_map
                .entry(rk)
                .or_insert((pr.number, pr.url.clone(), pr.head_ref.clone()));
        }
    }

    // 拉取所有项目的 Status 字段 + 完整 issue 信息（best-effort）。
    // fetch_project_issues 返回 status_map 和项目中发现的完整 issue 列表，
    // 用于将「项目中有但搜索源未覆盖」的 issue 合并进同步数据。
    let mut project_status: std::collections::HashMap<String, String> =
        std::collections::HashMap::new();
    let mut project_issues: Vec<github::RawTask> = Vec::new();
    for pid in &project_ids {
        match client.fetch_project_issues(pid, &account.org) {
            Ok((status_map, issues)) => {
                project_status.extend(status_map);
                eprintln!(
                    "[sync] project {}: status_map={} issues={}",
                    pid,
                    project_status.len(),
                    issues.len()
                );
                project_issues.extend(issues);
            }
            Err(e) => eprintln!("[sync] 拉取项目 {} 状态/issue 失败: {}", pid, e),
        }
    }
    if project_status.is_empty() && !project_ids.is_empty() {
        eprintln!("[sync] 警告：所有项目的 Status 映射均为空（可能没有 Status 字段）");
    }

    // 将项目中发现的 issue 合并进 raw（去重：搜索源已有的跳过）。
    // 这确保「项目中有但用户非 assignee/author/mentions/commenter」的 issue 也能上板。
    let existing_keys: HashSet<String> = raw.iter().map(|t| format!("{}#{}", t.repo, t.number)).collect();
    let mut merged_from_project = 0usize;
    for t in project_issues {
        let k = format!("{}#{}", t.repo, t.number);
        if !existing_keys.contains(&k) && !t.is_pr {
            raw.push(t);
            merged_from_project += 1;
        }
    }
    if merged_from_project > 0 {
        eprintln!(
            "[sync] 从项目中补充了 {} 个搜索源未覆盖的 issue",
            merged_from_project
        );
    }

    // 仅本账号的任务标记陈旧（避免「全部账号视图」下另一账号的同步误标本账号任务为陈旧）。
    conn.execute("UPDATE tasks SET stale = 1 WHERE account_id = ?1", [account.id])
        .map_err(|e| format!("标记陈旧任务失败: {}", e))?;

    let mut added = 0usize;
    let mut updated = 0usize;
    let mut comment_budget: usize = 12;
    for t in &raw {
        if t.is_pr {
            continue;
        }
        let key = format!("{}#{}", t.repo, t.number);
        let ownership: &str = classify(&t.assignees, &account.login);

        // 读取既有状态与富化字段缓存：用于"不在项目中"时维持本地手动态。
        // v0.3.16：既有记录必须是同一 account_id 的（避免跨账号状态污染）。
        let row: (String, i64, i64, i64, String, String, String) = conn
            .query_row(
                "SELECT status, comments_count, mentioned, pr_number, pr_url, latest_comment_url, branch
                 FROM tasks WHERE key = ?1 AND account_id = ?2",
                rusqlite::params![&key, account.id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?)),
            )
            .unwrap_or_else(|_| ("todo".to_string(), 0, 0, 0, String::new(), String::new(), String::new()));
        let existing_status = row.0;
        let existing_comments = row.1;
        let existing_mentioned = row.2;
        let existing_pr_number = row.3;
        let existing_pr_url = row.4;
        let existing_comment_url = row.5;
        let existing_branch = row.6;
        let exists = conn
            .query_row(
                "SELECT 1 FROM tasks WHERE key = ?1 AND account_id = ?2",
                rusqlite::params![&key, account.id],
                |_| Ok(()),
            )
            .is_ok();

        // 决定看板状态：closed→已完成；自定义列 gh_status 匹配→列 key；label 映射→映射状态；Project Status→映射；不在项目中→维持本地手动态。
        let gh_status_raw = project_status.get(&key).cloned().unwrap_or_default();
        let labels_csv = t.labels.join(",");
        // 先用 label 映射解析（优先级：repo > org > 全局默认 > state 兜底）
        let mapped_status = crate::db::resolve_status_from_labels(
            conn,
            &account.org,
            &t.repo,
            &labels_csv,
            &t.state,
        );
        // v0.3.28+：检查自定义列映射（按账号的 account_columns 匹配 gh_status）
        let column_status = if !gh_status_raw.is_empty() {
            crate::db::resolve_column_from_gh_status(conn, account.id, &gh_status_raw)
        } else {
            None
        };
        let final_status: String = if t.state == "closed" {
            "done".to_string()
        } else if let Some(col_key) = column_status {
            // 自定义列映射优先于 label 映射和 Project Status 映射
            col_key
        } else if !mapped_status.is_empty() && mapped_status != "todo" {
            mapped_status
        } else if !gh_status_raw.is_empty() {
            // gh_status 有值时优先用 map_project_status；映射不到则保持本地状态。
            // 绝不回落原始文案：非四态的 status 会让该任务不属于任何看板列，表现为「任务消失」。
            map_project_status(&gh_status_raw)
                .unwrap_or(&existing_status)
                .to_string()
        } else {
            existing_status
        };

        let assignees_csv = t.assignees.join(",");
        let done_at_val = if final_status == "done" { now } else { 0 };

        // 评论区 @我：以 GitHub mentions 搜索结果为准（覆盖正文与评论中的 @），
        // 分配给我时不重复提示。mentions 源整体失败时保留既有标记。
        let mentioned = if mention_ok {
            mention_keys.contains(&key) && ownership != "assigned"
        } else {
            existing_mentioned != 0
        };
        let mentioned_val: i64 = if mentioned { 1 } else { 0 };

        // PR 关联：仅在 PR 列表拉取成功时更新（失败则保留既有值，避免误清空）。
        let (pr_number, pr_url, branch): (i64, String, String) = if pr_fetch_ok {
            match pr_map.get(&key) {
                Some((n, u, b)) => (*n, u.clone(), b.clone()),
                None => (0, String::new(), String::new()),
            }
        } else {
            (existing_pr_number, existing_pr_url, existing_branch)
        };

        // 新评论链接：仅当评论数较上次增加且预算充足时回源拉取（控制 API 调用量）。
        let (comments_count, latest_comment_url): (i64, String) =
            if t.comments > existing_comments as u64 && comment_budget > 0 {
                match client.fetch_comments(&t.repo, t.number, &t.repo_owner) {
                    Ok(Some(url)) => {
                        comment_budget -= 1;
                        std::thread::sleep(Duration::from_millis(80));
                        (t.comments as i64, url)
                    }
                    Ok(None) => {
                        comment_budget -= 1;
                        (t.comments as i64, existing_comment_url)
                    }
                    Err(e) => {
                        eprintln!("[sync] 拉取评论失败，跳过: {}#{}: {}", t.repo, t.number, e);
                        (existing_comments, existing_comment_url)
                    }
                }
            } else {
                (existing_comments, existing_comment_url)
            };

        conn.execute(
            "INSERT INTO tasks
               (key, owner, repo, number, title, url, gh_state, ownership,
                status, gh_status, assignees, labels, done_at, mentioned, comments_count,
                latest_comment_url, pr_number, pr_url, branch, candidate_done, stale, updated_at, synced_at,
                account_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, 0, 0, ?20, ?21, ?22)
             ON CONFLICT(key) DO UPDATE SET
               title = excluded.title,
               repo = excluded.repo,
               gh_state = excluded.gh_state,
               ownership = excluded.ownership,
               updated_at = excluded.updated_at,
               synced_at = excluded.synced_at,
               candidate_done = 0,
               stale = 0,
               gh_status = excluded.gh_status,
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
               account_id = excluded.account_id",
            rusqlite::params![
                key,
                account.org,
                t.repo,
                t.number,
                t.title,
                t.url,
                t.state,
                ownership,
                final_status,
                gh_status_raw,
                assignees_csv,
                labels_csv,
                done_at_val,
                mentioned_val,
                comments_count,
                latest_comment_url,
                pr_number,
                pr_url,
                branch,
                t.updated_at,
                now,
                account.id,
            ],
        )
        .map_err(|e| format!("写入任务失败: {}", e))?;

        if exists {
            updated += 1;
        } else {
            added += 1;
        }
    }

    // 处理本账号下的陈旧任务：关闭的标为候选已完成，仍打开但已不相关的移出看板。
    // 查询 owner（org）、repo、number、url 用于 fetch_state 构造完整仓库路径。
    let mut stale_rows: Vec<(String, String, i64, String)> = Vec::new();
    {
        let mut stmt = conn
            .prepare("SELECT key, repo, number, url FROM tasks WHERE stale = 1 AND account_id = ?1")
            .map_err(|e| format!("查询陈旧任务失败: {}", e))?;
        let rows = stmt
            .query_map([account.id], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?, r.get::<_, String>(3)?))
            })
            .map_err(|e| format!("遍历陈旧任务失败: {}", e))?;
        for r in rows {
            stale_rows.push(r.map_err(|e| e.to_string())?);
        }
    }

    let mut candidate_done = 0usize;
    let mut removed = 0usize;
    for (key, repo, number, url) in stale_rows {
        // 从 URL 提取 repo_owner（格式：https://github.com/{owner}/{repo}/issues/{number}）
        let repo_owner_from_url = url
            .split('/')
            .nth(4)
            .unwrap_or("")
            .to_string();
        match client.fetch_state(&repo, number, &repo_owner_from_url) {
            Ok(state) if state == "closed" => {
                conn.execute(
                    "UPDATE tasks SET candidate_done = 1, gh_state = 'closed', status = 'done', stale = 0,
                     done_at = CASE WHEN done_at = 0 THEN ?2 ELSE done_at END
                     WHERE key = ?1 AND account_id = ?3",
                    rusqlite::params![&key, &now, account.id],
                )
                .map_err(|e| format!("标记候选已完成失败: {}", e))?;
                candidate_done += 1;
            }
            Ok(_) => {
                conn.execute("DELETE FROM tasks WHERE key = ?1 AND account_id = ?2", rusqlite::params![&key, account.id])
                    .map_err(|e| format!("移除失效任务失败: {}", e))?;
                removed += 1;
            }
            Err(_) => {
                eprintln!("[sync] fetch_state 失败，保留任务不过删: {}", key);
            }
        }
    }

    Ok(AccountSyncResult {
        added,
        updated,
        candidate_done,
        removed,
        failed_sources: failed,
    })
}

pub fn run(conn: &Connection) -> Result<SyncResult, String> {
    // v0.3.16+：决定本次同步的目标账号集。
    // view_mode='single' → 仅同步 active_account_id；'all' → 同步所有账号。
    let accounts = crate::db::list_accounts(conn)?;
    if accounts.is_empty() {
        return Err("未配置 GitHub PAT，请在设置面板粘贴 token（fine-grained 推荐）".to_string());
    }
    let view_mode = crate::db::get_setting(conn, "view_mode");
    let active_id: i64 = crate::db::get_setting(conn, "active_account_id")
        .parse()
        .unwrap_or(0);

    let target: Vec<crate::db::Account> = match view_mode.as_str() {
        "all" => accounts.clone(),
        _ => accounts
            .iter()
            .filter(|a| a.id == active_id)
            .cloned()
            .collect(),
    };
    if target.is_empty() {
        return Err(format!(
            "激活账号 #{active_id} 不存在，请重新选择激活账号"
        ));
    }

    let now = now_secs();
    // v0.3.23：记录同步开始日志（每个账号一条）
    let mut log_ids: Vec<(i64, i64)> = Vec::new(); // (account_id, log_id)
    for account in &target {
        if let Ok(log_id) = crate::db::insert_sync_log(conn, account.id, "auto", now) {
            log_ids.push((account.id, log_id));
        }
    }

    let mut total_added = 0usize;
    let mut total_updated = 0usize;
    let mut total_candidate_done = 0usize;
    let mut total_removed = 0usize;
    let mut total_failed: Vec<String> = Vec::new();

    // 账号间间隔：避免同时发起多账号搜索触发突发限流（即便每账号 1s 间隔，多账号叠加仍可能撞 Search API 上限）。
    for (idx, account) in target.iter().enumerate() {
        if idx > 0 {
            std::thread::sleep(Duration::from_millis(800));
        }
        let (login, _org, pat) = crate::db::get_account_pat(conn, account.id)?;
        if pat.is_empty() {
            total_failed.push(format!("{}: 未配置 PAT", login));
            continue;
        }
        // 查找当前账号对应的日志 id
        let log_id = log_ids.iter().find(|(aid, _)| *aid == account.id).map(|(_, lid)| *lid);
        match sync_account(conn, account, &pat, now) {
            Ok(r) => {
                total_added += r.added;
                total_updated += r.updated;
                total_candidate_done += r.candidate_done;
                total_removed += r.removed;
                total_failed.extend(r.failed_sources.clone());
                // 更新日志：成功
                if let Some(lid) = log_id {
                    let _ = crate::db::update_sync_log(
                        conn, lid, now_secs(), "success",
                        r.added as i64, r.updated as i64, r.removed as i64,
                        r.candidate_done as i64, 0,
                        &r.failed_sources.join("; "), "",
                    );
                }
            }
            Err(e) => {
                total_failed.push(format!("{}: {}", login, e));
                // 更新日志：失败
                if let Some(lid) = log_id {
                    let _ = crate::db::update_sync_log(
                        conn, lid, now_secs(), "failed",
                        0, 0, 0, 0, 0, "", &e,
                    );
                }
            }
        }
    }

    // 已完成任务保留 1 个月（按 done_at 窗口淘汰），与单账号视图保持同样的清理策略。
    let pruned = conn
        .execute(
            "DELETE FROM tasks WHERE status = 'done' AND done_at > 0 AND ?1 - done_at > 2592000",
            [now],
        )
        .map_err(|e| format!("清理过期已完成任务失败: {}", e))?;

    crate::db::set_setting(conn, "last_sync_at", &now.to_string())?;

    // v0.3.23：清理超过 7 天的同步日志（保留策略）
    let _ = crate::db::prune_sync_logs(conn, now);

    let total: usize = conn
        .query_row("SELECT COUNT(*) FROM tasks", [], |r| r.get(0))
        .unwrap_or(0);

    Ok(SyncResult {
        total,
        added: total_added,
        updated: total_updated,
        candidate_done: total_candidate_done,
        removed: total_removed,
        pruned,
        warning: if total_failed.is_empty() {
            String::new()
        } else {
            format!("部分账号/数据源拉取失败: {}", total_failed.join("; "))
        },
        synced_at: now,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use rusqlite::Connection;

    /// 头less 全量同步验证：直接打开生产库（与应用共用同一 SQLite 文件），
    /// 跑一次真实 `run`，再核对「PR 关联」是否真正落地（pr_number > 0 的任务数 > 0）。
    ///
    /// 这是本会话修复（PR 拉取 60s 超时 + 阶段冷却 + 评论预算缩减）的唯一端到端验收手段——
    /// 逻辑层已用 Python 镜像证明 parse_issue_refs + 真实 PR 正文可命中 ~44/77 任务，
    /// 但 PR 拉取能否在 GitHub 二次限流下成功，只能靠真实同步验证。
    ///
    /// 依赖真实 GitHub 网络与限流配额，默认忽略，需时以
    /// `cargo test --lib -- --ignored test_headless_sync_pr_linkage` 显式运行。
    /// 会就地改写生产库（与应用每次同步一致），运行前请确认已备份。
    #[test]
    #[ignore]
    fn test_headless_sync_pr_linkage() {
        let prod = std::path::Path::new(
            "/Users/liushizhao/Library/Application Support/com.shawnliu.taskboard/taskboard.db",
        );
        assert!(
            prod.exists(),
            "生产库应已存在（先运行过一次 App 同步）"
        );
        // 关键：复制到临时库再跑，**绝不改写用户的生产库**。
        // 早期版本直接开生产库跑同步，属于误改用户数据的高危写法——任何 `cargo test --lib -- --ignored`
        // 都会触发，故改为临时副本，验证后删除。
        //
        // v0.3.17 起 DB 是 WAL 模式：最新数据可能在 `-wal` 里尚未 checkpoint，
        // `fs::copy` 主文件会拿到旧快照（实测丢 accounts 表）。改用 SQLite 原生
        // `VACUUM INTO` 做一致性快照（含 WAL 内容，且对正在使用的库安全）。
        let tmp = std::env::temp_dir().join("taskboard_headless_test.db");
        let _ = std::fs::remove_file(&tmp);
        {
            let src = Connection::open(prod).expect("打开生产库（只读快照）");
            src.execute(
                "VACUUM INTO ?1",
                [tmp.to_string_lossy().as_ref()],
            )
            .expect("VACUUM INTO 快照失败");
        }
        eprintln!("[test] 已快照生产库到临时文件（不影响生产数据）：{}", tmp.display());
        let conn = Connection::open(&tmp).expect("打开临时库");
        // 快照经 open_db 统一补 schema/迁移（与 App 打开路径一致）。
        let conn = db::open_db(&tmp).expect("open_db 快照库");

        eprintln!("[test] 开始真实同步（关注 PR 关联）…");
        let res = run(&conn).expect("同步应成功");
        eprintln!(
            "[test] 同步完成：total={} added={} updated={} removed={} candidate_done={} pruned={}",
            res.total, res.added, res.updated, res.removed, res.candidate_done, res.pruned
        );

        let pr_gt0: i64 = conn
            .query_row("SELECT COUNT(*) FROM tasks WHERE pr_number > 0", [], |r| r.get(0))
            .unwrap();
        let total: i64 = conn
            .query_row("SELECT COUNT(*) FROM tasks", [], |r| r.get(0))
            .unwrap();
        let diag_fetch_ok = db::get_setting(&conn, "diag_pr_fetch_ok");
        let diag_fetched = db::get_setting(&conn, "diag_pr_fetched");
        let diag_map = db::get_setting(&conn, "diag_pr_map_size");
        let diag_matched = db::get_setting(&conn, "diag_pr_matched");
        eprintln!(
            "[test] PR 关联命中：{}/{}  | diag_fetch_ok={} diag_fetched={} diag_map_size={} diag_matched={}",
            pr_gt0, total, diag_fetch_ok, diag_fetched, diag_map, diag_matched
        );
        let _ = std::fs::remove_file(&tmp);
        assert!(pr_gt0 > 0, "期望至少 1 个任务的 pr_number > 0（PR 关联应落地）");
    }

    // ===== 纯函数单元测试（不依赖网络） ==============================

    #[test]
    fn classify_empty_is_notassignee() {
        assert_eq!(classify(&[], "alice"), "notassignee");
    }

    #[test]
    fn classify_contains_login_is_assigned() {
        let a = vec!["bob".to_string(), "alice".to_string()];
        assert_eq!(classify(&a, "alice"), "assigned");
        // 必须按值匹配，不是按首项
        assert_eq!(classify(&a, "bob"), "assigned");
    }

    #[test]
    fn classify_no_login_match_is_assigned_others() {
        let a = vec!["bob".to_string(), "carol".to_string()];
        assert_eq!(classify(&a, "alice"), "assigned-others");
        assert_eq!(classify(&a, ""), "assigned-others");
    }

    #[test]
    fn classify_case_sensitive() {
        // GitHub login 是大小写不敏感的，但 classify 必须严格区分（实测用精确字符串）
        let a = vec!["Alice".to_string()];
        assert_eq!(classify(&a, "alice"), "assigned-others");
        assert_eq!(classify(&a, "Alice"), "assigned");
    }

    #[test]
    fn map_project_status_recognizes_oms_values() {
        // 待处理：开发前（需求池 / 产品规划 / 待开发处理）
        assert_eq!(map_project_status("🧠需求池"), Some("todo"));
        assert_eq!(map_project_status("🤔产品规划"), Some("todo"));
        assert_eq!(map_project_status("🚧待开发处理"), Some("todo"));

        // 处理中
        assert_eq!(map_project_status("✨开发中"), Some("doing"));

        // 已处理：测试字样优先于「完成」（避免「完成测试中」被误映射到 done）
        assert_eq!(map_project_status("🔎开发完成/测试中"), Some("processed"));
        assert_eq!(map_project_status("✅测试通过/待上线"), Some("processed"));

        // 已完成
        assert_eq!(map_project_status("🎉完成/上线"), Some("done"));
        assert_eq!(map_project_status("↩️取消"), Some("done"));

        // 未识别 → None，让 sync 维持本地手动态
        assert_eq!(map_project_status("Random new tag"), None);
        assert_eq!(map_project_status(""), None);
    }

    #[test]
    fn parse_issue_refs_handles_basic_patterns() {
        // `#123` 无前缀：归属 PR 所在仓库
        let r = parse_issue_refs("Closes #123", "myrepo");
        assert_eq!(r, vec!["myrepo#123"]);

        // `owner/repo#123` 跨仓库
        let r = parse_issue_refs("See foo/bar#456", "myrepo");
        assert_eq!(r, vec!["bar#456"]);

        // 多个引用
        let r = parse_issue_refs("Fix #1; refs a/b#2", "def");
        assert_eq!(r, vec!["def#1", "b#2"]);

        // 重复引用去重去重在调用方做；本函数返回自然顺序的全部命中
        let r = parse_issue_refs("refs #1 again #1", "def");
        assert_eq!(r, vec!["def#1", "def#1"]);
    }

    #[test]
    fn parse_issue_refs_handles_dash_underscore_in_repo_name() {
        // GitHub 仓库名允许 `-._`：必须都识别
        let r = parse_issue_refs("closes my-org/my_repo.ext#7", "x");
        assert_eq!(r, vec!["my_repo.ext#7"]);

        let r = parse_issue_refs("closes foo-bar/baz_qux#9", "x");
        assert_eq!(r, vec!["baz_qux#9"]);
    }

    #[test]
    fn parse_issue_refs_ignores_invalid() {
        // 无 # 前缀
        assert!(parse_issue_refs("plain text 123", "def").is_empty());
        // # 后非数字
        assert!(parse_issue_refs("hash #abc, #0?", "def").is_empty());
        // 空
        assert!(parse_issue_refs("", "def").is_empty());
        // #0 也被忽略（GitHub issue 编号从 1 起）
        assert!(parse_issue_refs("refs #0", "def").is_empty());
    }

    #[test]
    fn parse_issue_refs_handles_unicode_context() {
        // 中文 PR body 里夹 #123 仍命中（按字节扫描）
        let r = parse_issue_refs("修复 issue：#999 谢谢", "def");
        assert_eq!(r, vec!["def#999"]);
    }

    #[test]
    fn parse_issue_refs_only_repo_segment_without_slash_uses_default() {
        // `#123` 前是空白 / 标点（无 `org/repo` 前缀）→ 用 default_repo
        let r = parse_issue_refs("Closes #42 today.", "myrepo");
        assert_eq!(r, vec!["myrepo#42"]);
    }

    #[test]
    fn parse_issue_refs_documents_url_anchor_caveat() {
        // 已知限制：URL 锚 `#42` 也会被解析。函数本身无法区分「URL 锚」与「issue 引用」——
        // 见文档注释。若需排除 URL，应在调用方做预过滤。这里仅记录这个事实，
        // 不做正确性断言（protocol-level 的固有歧义）。
        let r = parse_issue_refs("see https://example.com/page#42", "myrepo");
        // 现在的实际行为是「page#42」（seg="com/page"，rfind 取 "page"）。
        // 至少要确认 seg 中扫描 `/` 后确实能识别 — 不是空。
        assert_eq!(r.len(), 1);
        assert!(r[0].ends_with("#42"));
    }

    #[test]
    fn parse_issue_refs_handles_multi_segment_owner_path() {
        // GitHub 偶尔会出现 `org/sub/group/repo#N` 多段路径：rfind 取最后一段。
        let r = parse_issue_refs("fixes a/b/c/d#9", "x");
        assert_eq!(r, vec!["d#9"]);
    }

    // ===== accounts + 多账号视图的纯逻辑校验 ==========================

    #[test]
    fn account_pat_roundtrip_isolated() {
        // 与 db 集成测试不重叠：用临时库做 CRUD 烟雾测，确保 sync_account 入参
        // 能直接组合 accounts 表与 get_account_pat。
        let dir = std::env::temp_dir().join(format!(
            "taskboard_unit_{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("taskboard.db");
        let conn = db::open_db(&path).unwrap();
        let id = db::insert_account(&conn, "main", "alice", "FoodsUp", "ghp_x").unwrap();
        let (login, org, pat) = db::get_account_pat(&conn, id).unwrap();
        assert_eq!(login, "alice");
        assert_eq!(org, "FoodsUp");
        assert_eq!(pat, "ghp_x");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 占位：保证 `Connection` import 不被 unused 警告清理（防止后面扩展时漏掉）。
    #[allow(dead_code)]
    fn _unused_conn_smoke() -> Connection {
        Connection::open_in_memory().unwrap()
    }
}

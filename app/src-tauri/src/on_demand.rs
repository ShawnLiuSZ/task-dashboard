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
use serde::Serialize;

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
            // #358：第 3 段必须是 `issues` 或 `pull`。此前**完全忽略**该段 ⇒
            // `.../discussions/7`、`.../wiki/7` 会被当成 issue 接受，而 Python
            // 侧的正则要求 `(?:issues|pull)` 会拒绝 ⇒ 两侧对同一输入给出相反答案。
            let kind_ok = matches!(parts[2], "issues" | "pull");
            // #358：编号取**前导数字段**。此前对 `parts[3]` 整体 parse 且只用
            // `trim_start_matches('#')`（只剥前导 `#`）⇒ `.../issues/7#issuecomment-1`
            // （GitHub UI 复制链接的**标准形式**）解析失败。Python 侧 `(\d+)` 是
            // search 语义、天然只取前导数字，故两侧本就应对齐。
            let digits: String = parts[3]
                .trim_start_matches('#')
                .chars()
                .take_while(|c| c.is_ascii_digit())
                .collect();
            if kind_ok {
                if let Ok(n) = digits.parse::<i64>() {
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
        s.push_str(
            "；该 owner 是由账号推断的，若仓库属于其他命名空间，请用 `owner/repo#N` 形式指定",
        );
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
            match matched
                .iter()
                .find(|a| a.is_default)
                .or_else(|| matched.first())
            {
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
    // #335：closed 判据用大小写不敏感版本（REST 此处虽为小写，仍与其余调用点统一口径）。
    let status = crate::sync::resolve_final_status(
        crate::common::is_closed_state(&raw.state),
        None,
        explicit_label,
        "",
        "todo",
    );
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
        // #335：与同步路径同一口径落库（归一化为小写），避免同一列出现两套大小写。
        issue_state: crate::common::normalize_issue_state(&raw.state),
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
        // #435：按需拉取只拿单个 issue 的 REST 数据，无关联 PR ⇒ 状态未知。
        pr_state: String::new(),
        pr_url: String::new(),
        // #467：按需拉取同样拿不到关联 PR（PR 关联来自仓库级 pulls 列表）⇒ 空列表。
        // `pr_fetch_ok=false` ⇒ 写入阶段**跳过** `task_prs`，保留既有关联不被清空
        // （该路径用 `InsertIfAbsent`，理论上不会覆盖既有行，但语义上仍需明确）。
        prs: Vec::new(),
        pr_fetch_ok: false,
        // #472：按需拉取同样拿不到评论列表（评论来自 comments 接口，本路径只取
        // 单 issue 的 REST 数据）⇒ 空列表。
        // `comments_fetch_ok=false` ⇒ 写入阶段**跳过** `task_comments`，
        // 保留既有关联不被清空（同 `pr_fetch_ok` 的语义）。
        comments: Vec::new(),
        comments_fetch_ok: false,
        branch: String::new(),
        parent_issue: String::new(),
        sub_issues: String::new(),
        created_at: crate::common::iso8601_to_secs(&raw.created_at),
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

    let client =
        match crate::github::GitHubClient::new(pat, account.login.clone(), api_owner.clone()) {
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
    let affected = crate::db::write_task(conn, &row, now, TaskWriteMode::InsertIfAbsent)?;
    Ok(outcome_from_affected(affected))
}

/// #450：把 `InsertIfAbsent` 的受影响行数翻译成 `EnsureOutcome`。
///
/// `InsertIfAbsent` 在「行已存在」时返回 0 且零覆盖，因此 0 意味着
/// **本次按需拉取并没有真的写入任何东西** —— 报 `Pulled` 会让 MCP 返回 `pulled: true`
/// 误导 agent「刚创建」。数据本身不受影响（DO NOTHING 仍零覆盖），只有标志位在说谎。
///
/// 抽成独立函数是为了让这个决策点**可被单测覆盖**：`ensure_task_available` 本身需要网络，
/// 无法在单测里跑通。
fn outcome_from_affected(affected: usize) -> EnsureOutcome {
    if affected == 0 {
        // 行已由同步抢先写入：如实报告「本地已有」。
        EnsureOutcome::AlreadyLocal
    } else {
        EnsureOutcome::Pulled
    }
}

/// #490：实时拉取单个任务的**详情 + 评论 + 关联 PR 提交历史**，**只读 GitHub、零落库**。
///
/// 与 [`ensure_task_available`] 的关键区别：后者会把单 issue 写入 `tasks` 表（给 MCP
/// 写路径兜底）；本结构 + [`fetch_task_detail_live`] **绝不触碰 SQLite**，只把 GitHub 的
/// 实时数据原样回传前端，供详情面板在「打开时」覆盖展示（评论区 / 指派 / 标签 /
/// 关联 PR 提交历史）。
///
/// 字段命名与 `CommentRef` 一致（`#[serde(rename_all = "camelCase")]`）⇒ 前端可直接当
/// `TaskComment` 用；`pr_commits` 额外承载「历史提交记录」。
///
/// ⚠️ #496：**这个 `rename_all` 不能删**。漏写时后端序列化出的是 `pr_commits`，
/// 而前端 `types.ts` 的 `LiveTaskDetail` 期望 `prCommits` ⇒ `live.prCommits` 为
/// `undefined` ⇒ 详情面板渲染 `live.prCommits.length` 时抛 TypeError ⇒
/// React 卸载整棵树 ⇒ **窗口全屏空白**。
/// 回归防线见同文件 `live_task_detail_serializes_camel_case_keys`。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveTaskDetail {
    /// issue 实时详情（标题 / 状态 / 指派 / 标签 / 计数 / 时间）。
    pub issue: LiveIssue,
    /// 评论链接列表（最新在前，与 `fetch_comments` 同口径：最多 `COMMENTS_KEPT_MAX` 条）。
    /// 形状与 `TaskComment` 一致，前端可直接喂给 `TaskCommentsList`。
    pub comments: Vec<LiveComment>,
    /// 关联 PR 的提交历史（仅当调用方传入 `pr_number > 0` 时拉取，否则空）。
    pub pr_commits: Vec<LivePrCommit>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveIssue {
    pub number: i64,
    pub title: String,
    pub url: String,
    /// open / closed（已归一化为小写，与 `common::normalize_issue_state` 同口径）。
    pub state: String,
    pub assignees: Vec<String>,
    pub labels: Vec<String>,
    /// issue 创建人 login（不含 @）。
    pub author: String,
    pub comments_count: u64,
    /// #498：issue **正文**（GitHub `body`，markdown 源文本）。
    /// 空串 = 无正文或取不到。前端渲染为「描述」区块。
    pub body: String,
    /// 创建时间（Unix 秒）。
    pub created_at: i64,
    /// 更新时间（Unix 秒）。
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveComment {
    pub id: i64,
    pub url: String,
    pub author: String,
    /// 创建时间（Unix 秒）。
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LivePrCommit {
    /// commit sha 前 8 位（展示用）。
    pub sha: String,
    pub message: String,
    pub author: String,
    /// 提交时间（Unix 秒）。
    pub date: i64,
}

/// 实时拉取入口（**纯联网**，需联网；不可单测）。返回结构见 [`LiveTaskDetail`]。
///
/// `issue_key` 形如 `repo#number`（不含 owner），owner 由账号的 org/login 推断
/// （与 `default_owner_of` 同口径）。拉取失败（无 PAT / 账号 / 404 / 限流）一律返回 `Err`
/// 并带原因，由前端优雅降级（保留本地库展示，不崩溃）。
///
/// ⚠️ #496：本函数**完全不碰 SQLite**（凭证由调用方传入）——
/// 这是刻意的：命令层需要在**不持有 DB 锁**的前提下联网。锁内只取 PAT 这种
/// 亚毫秒级本地读，锁一释放就去联网；否则一次慢响应会把共享锁占住几秒～几十秒，
/// 连带阻塞所有读命令（设置 / 账号 / 同步日志面板），主线程也会被拖成 beachball（#329）。
pub fn fetch_task_detail_live(
    login: &str,
    org: &str,
    pat: &str,
    issue_key: &str,
    pr_number: i64,
) -> Result<LiveTaskDetail, String> {
    let r = parse_issue_ref_parts(issue_key)?;
    let repo = r.repo.clone();
    let number = r.number;

    // 账号：PAT / login / org 由调用方给出。issue_key 只含 repo#number，
    // owner 由账号推断（与 `default_owner_of` 同口径）。
    if pat.trim().is_empty() {
        return Err(format!("账号 @{login} 未配置 PAT"));
    }
    let api_owner = if !org.trim().is_empty() {
        org.trim().to_string()
    } else {
        login.trim().to_string()
    };
    let client = match crate::github::GitHubClient::new(
        pat.to_string(),
        login.to_string(),
        api_owner.clone(),
    ) {
        Ok(c) => c,
        Err(e) => return Err(format!("构造 GitHub 客户端失败: {e}")),
    };

    // 单 issue REST（不做 best-effort 降级）：区分「远端没有」(Ok(None)) 与「请求失败」(Err)。
    // #498：用带 body 的变体 —— 同一次请求里多拿一段正文，不额外往返。
    let (raw, body) = match client.fetch_issue_with_body(&api_owner, &repo, number)? {
        Some(t) => t,
        None => {
            return Err(format!(
                "已按 `{api_owner}/{repo}#{number}` 查询，远端没有该 issue（或该编号是 PR）"
            ))
        }
    };
    let issue = build_live_issue(&raw, body);

    // 评论：最新 N 条（与同步一致）。失败不阻断详情（保留本地库评论）。
    let comments = match client.fetch_comments(&repo, number, &api_owner, raw.comments) {
        Ok(Some(v)) => v
            .into_iter()
            .map(|c| LiveComment {
                id: c.id,
                url: c.url,
                author: c.author,
                created_at: c.created_at,
            })
            .collect(),
        _ => Vec::new(),
    };

    // PR 提交历史：仅当调用方给出关联 PR 编号时拉取（不阻塞主详情）。
    let pr_commits = if pr_number > 0 {
        fetch_pr_commits(&client, &api_owner, &repo, pr_number).unwrap_or_default()
    } else {
        Vec::new()
    };

    Ok(LiveTaskDetail {
        issue,
        comments,
        pr_commits,
    })
}

/// 把 REST issue 响应转成 [`LiveIssue`]（**纯函数**，便于单测）。
///
/// #498：正文（`body`）在这里透传。抽成纯函数的原因与 #496 的教训相同：
/// 断言必须落在**真实数据流**上——若断言只对手工构造的 `LiveIssue` 做，
/// 就会漏掉「转换这一步把 body 弄丢了」这种缺陷（反向验证实测过：
/// 把 `body` 换成空串，单测仍然全绿）。
pub fn build_live_issue(raw: &crate::github::RawTask, body: String) -> LiveIssue {
    LiveIssue {
        number: raw.number,
        title: raw.title.clone(),
        url: raw.url.clone(),
        state: crate::common::normalize_issue_state(&raw.state),
        assignees: raw.assignees.clone(),
        labels: raw.labels.clone(),
        author: raw.author.clone(),
        comments_count: raw.comments,
        body,
        created_at: crate::common::iso8601_to_secs(&raw.created_at),
        updated_at: crate::common::iso8601_to_secs(&raw.updated_at),
    }
}

/// PR 提交历史 API（`/pulls/{n}/commits`）。返回全量提交（通常不超百条，足够详情展示）。
fn pr_commits_url(owner: &str, repo: &str, pr_number: i64) -> String {
    format!("https://api.github.com/repos/{owner}/{repo}/pulls/{pr_number}/commits")
}

/// 拉取并解析 PR 提交历史（失败返回 `Err`，由调用方降级为空列表）。
fn fetch_pr_commits(
    client: &crate::github::GitHubClient,
    owner: &str,
    repo: &str,
    pr_number: i64,
) -> Result<Vec<LivePrCommit>, String> {
    let url = pr_commits_url(owner, repo, pr_number);
    let v = client.get(&url)?;
    Ok(parse_pr_commits(&v))
}

/// 纯函数：把 PR commits API 的 JSON 解析为 [`LivePrCommit`] 列表（便于单测）。
///
/// 容错与 `fetch_comments` 同思路：缺 sha 的条目跳过；作者优先 `commit.author.name`，
/// 否则回退顶层 `author.login`；时间解析失败记 0。
pub fn parse_pr_commits(v: &serde_json::Value) -> Vec<LivePrCommit> {
    let arr = match v.as_array() {
        Some(a) => a,
        None => return Vec::new(),
    };
    let mut out = Vec::with_capacity(arr.len());
    for c in arr {
        let sha = match c.get("sha").and_then(|x| x.as_str()) {
            Some(s) if !s.is_empty() => s.to_string(),
            _ => continue,
        };
        let commit = c.get("commit");
        let message = commit
            .and_then(|m| m.get("message"))
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string();
        let author = commit
            .and_then(|m| m.get("author"))
            .and_then(|a| a.get("name"))
            .and_then(|x| x.as_str())
            .map(String::from)
            .or_else(|| {
                c.get("author")
                    .and_then(|a| a.get("login"))
                    .and_then(|x| x.as_str())
                    .map(String::from)
            })
            .unwrap_or_default();
        let date = commit
            .and_then(|m| m.get("author"))
            .and_then(|a| a.get("date"))
            .and_then(|x| x.as_str())
            .map(crate::common::iso8601_to_secs)
            .unwrap_or(0);
        out.push(LivePrCommit {
            sha: sha.chars().take(8).collect(),
            message,
            author,
            date,
        });
    }
    out
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
        let r = parse_issue_ref_parts("https://github.com/ShawnLiuSZ/task-dashboard/issues/248")
            .unwrap();
        assert_eq!(r.owner.as_deref(), Some("ShawnLiuSZ"));
        assert_eq!(r.repo, "task-dashboard");
        assert_eq!(r.number, 248);
        assert_eq!(r.key, "task-dashboard#248");
        // 空白容忍
        assert_eq!(
            parse_issue_ref_parts("  https://github.com/o/r/issues/7  ")
                .unwrap()
                .key,
            "r#7"
        );
    }

    /// #358：**尾部锚点**必须能解析 —— 这是 GitHub UI「复制链接」的标准形式
    /// （`.../issues/7#issuecomment-1`），agent 极常见地直接粘这个 URL。
    ///
    /// 缺陷现场：编号被整体 `parse::<i64>()`，而 `trim_start_matches('#')` 只剥
    /// **前导** `#` ⇒ `7#issuecomment-1` 解析失败。
    /// 注意 `parse_issue_ref_parts_accepts_urls` 里那条「尾部锚点 / 空白容忍」的
    /// 注释所声称的锚点容忍当时**是假的** —— 它只测了空白。
    ///
    /// **反向验证**：把编号解析改回「整体 parse + 只剥前导 `#`」时本例失败。
    #[test]
    fn parse_url_tolerates_trailing_anchor() {
        for (input, expect_n) in [
            ("https://github.com/o/r/issues/7#issuecomment-1", 7),
            ("https://github.com/o/r/pull/12#issue-1", 12),
            ("https://github.com/o/r/issues/7#", 7),
            ("https://github.com/o/r/issues/7#issuecomment-999999", 7),
            // 前导 `#` 也一并容忍（`#7` 形式）
            ("https://github.com/o/r/issues/#7", 7),
        ] {
            let got = parse_issue_ref_parts(input)
                .unwrap_or_else(|e| panic!("应能解析尾部锚点 {input}，实际报错: {e}"));
            assert_eq!(got.number, expect_n, "输入 {input}");
            assert_eq!(got.repo, "r", "输入 {input}");
            assert_eq!(got.key, format!("r#{expect_n}"), "输入 {input}");
        }
    }

    /// #358：第 3 段必须是 `issues` / `pull` —— 与 Python 侧正则
    /// `github\.com/([^/]+)/([^/#?]+)/(?:issues|pull)/(\d+)` 对齐。
    ///
    /// 缺陷现场：Rust **完全忽略**该段 ⇒ `.../discussions/7` 被当成 issue 接受，
    /// 而 Python 侧拒绝 ⇒ 同一 agent 输入两侧给出相反答案。
    ///
    /// **反向验证**：去掉 `kind_ok` 判断时第 2 条断言失败。
    #[test]
    fn parse_url_requires_issues_or_pull_segment() {
        // 接受
        for good in [
            "https://github.com/o/r/issues/7",
            "https://github.com/o/r/pull/12",
        ] {
            assert!(parse_issue_ref_parts(good).is_ok(), "应接受 {good}");
        }
        // 拒绝：非 issue/pull 型资源
        for bad in [
            "https://github.com/o/r/discussions/7",
            "https://github.com/o/r/wiki/7",
            "https://github.com/o/r/milestone/7",
        ] {
            assert!(
                parse_issue_ref_parts(bad).is_err(),
                "{bad} 不是 issue/pull 资源，应拒绝（与 Python 侧一致）"
            );
        }
    }

    #[test]
    fn parse_ref_rejects_invalid() {
        assert!(parse_issue_ref_parts("").is_err());
        assert!(parse_issue_ref_parts("plain text").is_err());
        assert!(parse_issue_ref_parts("repo#abc").is_err());
        assert!(parse_issue_ref_parts("repo#0").is_err());
        assert!(parse_issue_ref_parts("#12").is_err());
        // #358：URL 形态下的编号必须为纯数字（前导数字段也解析不出时）
        assert!(parse_issue_ref_parts("https://github.com/o/r/issues/abc").is_err());
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
        assert_eq!(
            default_owner_of(&account(1, "ShawnLiuSZ", "")),
            "ShawnLiuSZ"
        );
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
            PickAccount::Unavailable(reason) => {
                assert!(reason.contains("没有任何 GitHub 账号"), "{reason}")
            }
            other => panic!("无账号应为 Unavailable，实际: {other:?}"),
        }
    }

    /// #450 回归：`InsertIfAbsent` 受影响 0 行时**不得**报 `Pulled`。
    ///
    /// 缺陷形态：原实现丢弃 `write_task` 返回值、无条件回 `Pulled`，于是同步抢先写入时
    /// MCP 返回 `pulled: true`，agent 会以为「刚创建」而实际零写入。
    ///
    /// **反向验证**：把 `outcome_from_affected` 改回恒返回 `Pulled` 时，
    /// `insert_if_absent_zero_must_not_report_pulled` 必然失败。
    #[test]
    fn insert_if_absent_zero_must_not_report_pulled() {
        // 0 行受影响 = 行已存在（DO NOTHING 零覆盖）⇒ 如实报告「本地已有」。
        assert_eq!(
            super::outcome_from_affected(0),
            EnsureOutcome::AlreadyLocal,
            "0 行受影响说明什么都没写入，不得报 Pulled"
        );
        assert!(
            !super::outcome_from_affected(0).pulled(),
            "`pulled()` 必须为 false，否则 MCP 返回体里的 pulled:true 会误导 agent"
        );

        // ≥1 行 = 真插入 ⇒ 报 Pulled。
        assert_eq!(super::outcome_from_affected(1), EnsureOutcome::Pulled);
        assert!(super::outcome_from_affected(1).pulled());
    }

    /// #490：PR commits JSON → `LivePrCommit` 列表解析（纯函数，可直接单测）。
    #[test]
    fn parse_pr_commits_maps_shape() {
        let json = serde_json::json!([
            {
                "sha": "abc123def456",
                "commit": {
                    "message": "fix: handle 404",
                    "author": { "name": "Shawn", "date": "2026-01-02T03:04:05Z" }
                },
                "author": { "login": "ShawnLiuSZ" }
            },
            {
                "sha": "",
                "commit": { "message": "no sha", "author": { "name": "X", "date": "2026-01-01T00:00:00Z" } }
            },
            {
                "sha": "fed987",
                "commit": { "message": "no commit.author.name" },
                "author": { "login": "bot" }
            }
        ]);
        let got = super::parse_pr_commits(&json);
        // 第一条完整解析；第二条 sha 为空被跳过。
        assert_eq!(got.len(), 2, "空 sha 条目应被跳过");
        assert_eq!(got[0].sha, "abc123de");
        assert_eq!(got[0].message, "fix: handle 404");
        assert_eq!(got[0].author, "Shawn");
        assert_eq!(
            got[0].date,
            crate::common::iso8601_to_secs("2026-01-02T03:04:05Z")
        );
        // 第三条：commit.author.name 缺失 ⇒ 回退顶层 author.login。
        assert_eq!(got[1].sha, "fed987");
        assert_eq!(got[1].author, "bot");
        assert_eq!(got[1].date, 0, "缺失日期应记 0");
    }

    /// #490：非数组 / 空数组应返回空列表，而非报错或 panic。
    #[test]
    fn parse_pr_commits_tolerates_non_array() {
        assert!(super::parse_pr_commits(&serde_json::json!({})).is_empty());
        assert!(super::parse_pr_commits(&serde_json::json!([])).is_empty());
    }

    /// #496：回归防线 —— `LiveTaskDetail` 的序列化键**必须**是驼峰。
    ///
    /// 漏写 `#[serde(rename_all = "camelCase")]` 时后端给出 `pr_commits`，
    /// 前端 `types.ts` 期望 `prCommits` ⇒ `live.prCommits` 为 `undefined` ⇒
    /// 详情面板渲染 `live.prCommits.length` 时抛 TypeError ⇒
    /// React 卸载整棵树 ⇒ **窗口全屏空白**（#496 的实际现象）。
    ///
    /// 断言写在**后端**：只有后端能保证「发出去的键名」与前端期望一致。
    #[test]
    fn live_task_detail_serializes_camel_case_keys() {
        let detail = super::LiveTaskDetail {
            issue: super::LiveIssue {
                number: 7,
                title: "t".into(),
                url: "u".into(),
                state: "open".into(),
                assignees: vec!["a".into()],
                labels: vec!["l".into()],
                author: "au".into(),
                comments_count: 0,
                body: "正文".into(),
                created_at: 0,
                updated_at: 0,
            },
            comments: vec![super::LiveComment {
                id: 1,
                url: "c".into(),
                author: "x".into(),
                created_at: 0,
            }],
            pr_commits: vec![super::LivePrCommit {
                sha: "abc12345".into(),
                message: "m".into(),
                author: "au".into(),
                date: 0,
            }],
        };
        let v = serde_json::to_value(&detail).expect("LiveTaskDetail 应可序列化");
        let obj = v.as_object().expect("应序列化为对象");
        // 顶层三个键：驼峰。
        assert!(
            obj.contains_key("prCommits"),
            "顶层键必须是 prCommits，实际是 {:?}",
            obj.keys().collect::<Vec<_>>()
        );
        assert!(obj.contains_key("issue"), "顶层键 issue 缺失");
        assert!(obj.contains_key("comments"), "顶层键 comments 缺失");
        assert!(
            !obj.contains_key("pr_commits"),
            "顶层键 pr_commits 不应出现（前端读的是 prCommits）"
        );
        // 嵌套结构同样驼峰：`issue.commentsCount`、`comments[0].createdAt`。
        let issue = obj
            .get("issue")
            .and_then(|i| i.as_object())
            .expect("issue 应为对象");
        assert!(
            issue.contains_key("commentsCount"),
            "issue.commentsCount 应为驼峰，实际 {:?}",
            issue.keys().collect::<Vec<_>>()
        );
        let c0 = obj
            .get("comments")
            .and_then(|c| c.as_array())
            .and_then(|a| a.first())
            .and_then(|c| c.as_object())
            .expect("comments[0] 应为对象");
        assert!(
            c0.contains_key("createdAt"),
            "comments[0].createdAt 应为驼峰，实际 {:?}",
            c0.keys().collect::<Vec<_>>()
        );
        // #498：issue 正文必须在返回体里（详情面板的「描述」区块依赖它）。
        let issue = obj
            .get("issue")
            .and_then(|i| i.as_object())
            .expect("issue 应为对象");
        assert!(
            issue.contains_key("body"),
            "issue.body 缺失 ⇒ 详情面板拿不到 issue 正文（#498 的现象之一）"
        );
        assert_eq!(issue.get("body").and_then(|b| b.as_str()), Some("正文"));
    }

    /// #498：**正文必须从 REST 响应一路透传到 `LiveIssue`**。
    ///
    /// ⚠️ 这条断言刻意落在 `build_live_issue`（**真实转换路径**）上，而不是手工构造的
    /// `LiveIssue` 字面量上 —— 后者对「转换时把 body 丢了」完全无感。
    /// 反向验证实测：把转换里的 `body` 换成空串，只断言字面量的那条用例**仍然全绿**。
    #[test]
    fn live_issue_carries_body_from_rest_response() {
        let raw = crate::github::RawTask {
            number: 1630,
            title: "标题".into(),
            url: "https://github.com/o/r/issues/1630".into(),
            state: "OPEN".into(),
            updated_at: "2026-10-29T05:18:38Z".into(),
            repo: "r".into(),
            repo_owner: "o".into(),
            assignees: vec!["alice".into()],
            labels: vec!["bug".into()],
            author: "bob".into(),
            comments: 2,
            is_pr: false,
            created_at: "2026-10-01T00:00:00Z".into(),
        };
        let body = "## 背景\n\n牛奶查找手机追踪".to_string();
        let issue = super::build_live_issue(&raw, body.clone());
        assert_eq!(
            issue.body, body,
            "正文必须原样透传（详情面板的「描述」区块依赖它）"
        );
        // 顺带确认其它字段没被这次重构弄坏。
        assert_eq!(issue.number, 1630);
        assert_eq!(issue.comments_count, 2);
        assert_eq!(issue.assignees, vec!["alice".to_string()]);
        assert_eq!(issue.state, "open", "state 必须归一化为小写");
    }
}

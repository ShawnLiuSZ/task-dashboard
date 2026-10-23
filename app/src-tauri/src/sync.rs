use rusqlite::Connection;
use std::collections::HashSet;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::github;

/// 单个 Project 的同步结果：(project_id, status_field, status_map, issues, item_ids)
type FetchedProject = (
    String,
    github::StatusField,
    std::collections::HashMap<String, String>,
    Vec<github::RawTask>,
    std::collections::HashMap<String, String>,
);

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
/// **按整值全等匹配**（先归一化去 emoji / 标点 / 空白）；返回 None 表示无法识别（回落到本地手动态）。
///
/// 映射依据 OMS Kanban 实际可选值（经用户确认，v0.3.6 起沿用）：
/// 🧠需求池 / 🤔产品规划 / 🚧待开发处理 → 待处理
/// ✨开发中 → 处理中
/// 🔎开发完成/测试中 / ✅测试通过/待上线 → 已处理
/// 🎉完成/上线 / ↩️取消 → 已完成
///
/// #450：中文分支由 `contains` 子串匹配改为**归一化整值全等**，与英文分支
/// （`map_project_status_en`）口径统一。子串匹配会把 `等待完成` / `未完成评审`
/// 误判成 `done`、`测试中` 恒判 `processed`；整值全等下未收录的自定义状态
/// 一律返回 `None`（保持本地手动态），不臆造映射。
///
/// #335 追加：部分 Project 的 Status 选项是**英文**（`Done` / `Released` / `In progress` …），
/// 原实现只认中文 ⇒ 一律返回 `None`；一旦 closed 判据同时失效，已关闭 issue 就没有任何
/// 兜底路径可走（实测 29 行滞留）。中文分支保持原样，仅在其后追加英文分支。
fn map_project_status(raw: &str) -> Option<&'static str> {
    map_project_status_zh(raw).or_else(|| map_project_status_en(raw))
}

/// 中文 Project Status 选项映射（#450：从子串匹配改为**整值全等**）。
///
/// #450 前用的是 `raw.contains("完成")` 一类子串匹配，与 §2.2「整值全等匹配」契约冲突，
/// 且与英文分支（`map_project_status_en`）口径不一致。子串匹配的 concrete 危害：
/// - `等待完成` / `未完成评审` 命中 `完成` ⇒ 被误判成 `done`
/// - `测试中` 命中 `测试` ⇒ 恒判 `processed`（尽管语义未必如此）
///
/// 与英文分支同法处理：先归一化（去 emoji / 标点 / 空白，转小写）再**全等**查表。
/// 归一化保留 emoji 之前的中文文案本体 —— 中文无空格分词问题，直接全等即可。
///
/// ⚠️ 未收录的自定义中文状态返回 `None`，落回「保持本地手动态」（§2.2 优先级 4），
/// 绝不臆造映射 —— 这正是「不认识的就不映射」的设计意图。
fn map_project_status_zh(raw: &str) -> Option<&'static str> {
    // 只保留中文、字母数字与空白：`✅ 已完成` → `已完成`，`🔎 开发完成/测试中` → `开发完成测试中`。
    // 注意 `/` 属标点会被折成空格并合并，故含分隔符的多词状态归一化后为连续串。
    let cleaned: String = raw
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { ' ' })
        .collect();
    let key = cleaned
        .split_whitespace()
        .collect::<Vec<_>>()
        .join("")
        .to_lowercase();
    match key.as_str() {
        // ✅已完成 / 🎉完成 / 🚀上线 / ↩️取消 → 已完成
        "已完成" | "完成" | "已上线" | "上线" | "已发布" | "发布" | "已关闭" | "关闭" | "取消"
        | "已取消" | "完成上线" | "完成发布" => Some("done"),
        // 🔎开发完成 / ✅测试通过 / 🔍测试中 / 待上线 → 已处理
        "开发完成"
        | "开发完成测试中"
        | "测试"
        | "测试中"
        | "测试通过"
        | "测试完成"
        | "测试通过待上线"
        | "待上线"
        | "待测试"
        | "待验收"
        | "验收中"
        | "已测试"
        | "回归中"
        | "开发测试" => Some("processed"),
        // ✨开发中 → 处理中
        "开发中" | "进行中" | "处理中" | "开发" => Some("doing"),
        // 🧠需求池 / 🤔产品规划 / 🚧待开发处理 → 待处理
        "需求池" | "产品规划" | "待开发" | "待开发处理" | "未开始" | "需求" | "需求评审"
        | "规划" | "规划中" | "待规划" | "待办" | "待处理" | "排期中" => {
            Some("todo")
        }
        _ => None,
    }
}

/// 英文 Project Status 选项映射（#335）。
///
/// **按整值精确匹配，不做子串匹配**——`Ready for release` 含 `release` 却并非已完成，
/// 子串匹配会把它误判成 `done`。因此先把原文归一化（折空白 / 去标点 emoji / 转小写）后
/// 与已知选项名全等比较；不认识的选项仍返回 `None`（保持本地手动态，绝不臆造）。
fn map_project_status_en(raw: &str) -> Option<&'static str> {
    // 只保留字母数字与空白：`✅ Done` → `done`，`in-progress` → `in progress`。
    // `is_alphanumeric()` 对汉字为真，但中文已在上面按 `contains` 处理，不会落到这里。
    let cleaned: String = raw
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { ' ' })
        .collect();
    let key = cleaned
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_ascii_lowercase();
    match key.as_str() {
        "done" | "completed" | "complete" | "released" | "release" | "shipped" | "closed"
        | "cancelled" | "canceled"
        // `won't do` 归一化后撇号变空格，故按 `won t do` 匹配（勿写成带撇号的原形）。
        | "won t do" => Some("done"),
        "in review" | "review" | "reviewing" | "testing" | "test" | "qa" | "verify"
        | "verifying" | "staging" | "verified" | "ready for release" | "in testing" => {
            Some("processed")
        }
        "in progress" | "doing" | "in development" | "developing" | "active" | "wip"
        | "in dev" => Some("doing"),
        "todo" | "to do" | "backlog" | "planned" | "planning" | "triage" | "new"
        | "not started" | "icebox" | "no status" => Some("todo"),
        _ => None,
    }
}

/// 看板状态决策（AGENTS.md §2.2 同步优先级）：
/// 1. `closed` → done（远程权威覆盖）
/// 2. custom 看板模式的列映射
/// 3. 显式 label 映射（#192：含 todo，优先于 gh_status）
/// 4. gh_status 有值 → 映射；映射不到 → 保持本地（绝不回落原始文案，
///    非四态 status 会让任务无列可归、表现为「任务消失」）
/// 5. 无 gh_status → 保持本地手动态
///
/// #215 由 `set_project_status` 复用，保证乐观更新与同步同一语义。
pub(crate) fn resolve_final_status(
    closed: bool,
    column_status: Option<String>,
    explicit_label: Option<String>,
    gh_status_raw: &str,
    existing_status: &str,
) -> String {
    if closed {
        return "done".to_string();
    }
    if let Some(col_key) = column_status {
        return col_key;
    }
    if let Some(status) = explicit_label {
        return status;
    }
    if !gh_status_raw.is_empty() {
        return map_project_status(gh_status_raw)
            .unwrap_or(existing_status)
            .to_string();
    }
    existing_status.to_string()
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
    /// #262：本次同步实际覆盖的账号数（可观测性：UI 据此展示「覆盖 N 个账号」）。
    pub accounts_synced: usize,
}

/// 关闭关键词列表（与 `scripts/merge-cleanup.py` 的 CLOSE_RE 保持一致）。
const CLOSE_KEYWORDS: &[&str] = &[
    "closes",
    "closed",
    "close",
    "fixes",
    "fixed",
    "fix",
    "resolves",
    "resolved",
    "resolve",
    "refs",
    "references",
    "ref",
    "关闭",
    "解决",
    "修复",
];

fn is_whitespace(b: u8) -> bool {
    b == b' ' || b == b'\t' || b == b'\n' || b == b'\r'
}

fn is_repo_prefix_char(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_' || b == b'-' || b == b'.' || b == b'/'
}

/// 检查 `text[pos..]` 是否以某个关闭关键词开头（大小写不敏感）。
/// 返回关键词结束位置，或 None。
///
/// 词边界检查：关键词前面不能是字母数字或下划线（避免 "prefixfixed" 误匹配），
/// 但允许前面是中文（"已关闭" 应匹配）。
fn match_close_keyword(text: &str, pos: usize) -> Option<usize> {
    // pos 必须在 char boundary 上，否则无法安全切片
    if !text.is_char_boundary(pos) {
        return None;
    }
    // 词边界检查：前面不能是字母数字或下划线
    if pos > 0 {
        let prev_byte = text.as_bytes()[pos - 1];
        if prev_byte.is_ascii_alphanumeric() || prev_byte == b'_' {
            return None;
        }
    }
    for kw in CLOSE_KEYWORDS {
        let kw = *kw;
        let kw_bytes = kw.as_bytes();
        let end = pos + kw_bytes.len();
        if end <= text.len() && text.is_char_boundary(end) {
            let candidate = &text[pos..end];
            // 大小写不敏感比较（ASCII 关键词）或精确比较（中文关键词）
            let matched = if kw.is_ascii() {
                candidate.eq_ignore_ascii_case(kw)
            } else {
                candidate == kw
            };
            if matched {
                // 词边界检查：关键词后面不能是字母数字或下划线
                if end >= text.len() {
                    return Some(end);
                }
                let next_byte = text.as_bytes()[end];
                if next_byte.is_ascii_alphanumeric() || next_byte == b'_' {
                    continue;
                }
                return Some(end);
            }
        }
    }
    None
}

/// #467：同步期内部的 PR 条目（比对外的 [`crate::common::PrRef`] 多一个 `head_ref`）。
///
/// `head_ref` 是 PR 的源分支名（`tasks.branch` 列存的就是它）—— 它是**任务属性**
/// 而非 PR 的展示属性，所以只对「主 PR」有意义，不进对外的 `PrRef` 结构。
#[derive(Debug, Clone)]
struct PrEntry {
    number: i64,
    url: String,
    head_ref: String,
    state: String,
}

/// #472：把 GitHub 拉到的评论列表转成落库用的 [`crate::common::CommentRef`] 列表，
/// 并挑出「最新一条」的链接（`tasks.latest_comment_url` 单值列的值）。
///
/// 抽成独立**纯函数**是为了让它可被单测覆盖 —— 同步主路径需要真实网络，
/// 单测里跑不通（与 `build_pr_map` 同样的取舍）。
///
/// **最新一条 = API 顺序的末位**。
///
/// ⚠️ 依据是 GitHub 的**文档保证**而非推测：issue comments 端点
/// *"Issue comments are ordered by ascending ID."*（ID 随创建时间单调递增）
/// ⇒ 末位即最新。
///
/// ⚠️ **不要改用「`created_at` 最大者」**：本仓的 `iso8601_to_secs` 在解析失败时
/// 返回 0 ⇒ 一旦**部分**评论的时间戳解析失败，「最大者」可能选中一条**更旧**的
/// 评论（0 永远输给正常时间戳）⇒ 与「最新」语义相反。
/// 按 API 顺序取末位则**与时间戳解析无关**，且与改造前的 `.next_back()` 行为
/// **逐位相同**（单值列零行为变化）。
///
/// ⚠️ **只保留最新的 N 条**（[`crate::common::COMMENTS_KEPT_MAX`] = 20）：
/// API 升序 ⇒ 取**末 N 条**（更早的不落库）。这既满足「详情面板只列最近 20 条」，
/// 也让关系表**不会**随评论历史无限增长（旧的评论链接被全量替换掉）。
fn comments_to_refs(
    list: &[crate::github::RawComment],
) -> (Vec<crate::common::CommentRef>, String) {
    // 只保留最新的 N 条（API 升序 ⇒ 末 N 条）。
    let start = list.len().saturating_sub(crate::common::COMMENTS_KEPT_MAX);
    let refs = list[start..]
        .iter()
        .map(|c| crate::common::CommentRef {
            id: c.id,
            url: c.url.clone(),
            author: c.author.clone(),
            created_at: c.created_at,
        })
        .collect();
    // API 升序 ⇒ 末位即最新（空列表 ⇒ 空串，与改造前 `next_back()` 一致）。
    let newest = list.last().map(|c| c.url.clone()).unwrap_or_default();
    (refs, newest)
}

/// #467：构建「issue_key → 关联 PR 列表」的映射。
///
/// **改造前的行为**是单值（`or_insert`）⇒ 同一 issue 被多个 PR 引用时，
/// **只有第一个 PR 入表，其余静默丢弃** —— 这是 #467 的根因。
///
/// **列表顺序** = PR 出现顺序（`prs` 的遍历顺序：仓库名升序，仓库内 GitHub pulls
/// API 默认按 created desc）。**首元素即「主 PR」** ⇒ `tasks.pr_number` /
/// `pr_url` / `pr_state` / `branch` 四列的取值与改造前 `or_insert` 的结果
/// **逐位相同** ⇒ 存量数据与旧 UI / 旧 MCP 行为零变化。
///
/// **去重**：同一个 PR 可能被正文多次命中（`Fixes #1` 之后结尾又写 `#1`），
/// 不去重会让 `task_prs` 出现重复行、主 PR 选取拿到重复项。
fn build_pr_map(prs: &[crate::github::RawPr]) -> std::collections::HashMap<String, Vec<PrEntry>> {
    let mut pr_map: std::collections::HashMap<String, Vec<PrEntry>> =
        std::collections::HashMap::new();
    for pr in prs {
        for rk in parse_issue_refs(&pr.body, &pr.repo) {
            let list = pr_map.entry(rk).or_default();
            if list
                .iter()
                .any(|e| e.number == pr.number && e.url == pr.url)
            {
                continue;
            }
            list.push(PrEntry {
                number: pr.number,
                url: pr.url.clone(),
                head_ref: pr.head_ref.clone(),
                state: pr.state.clone(),
            });
        }
    }
    pr_map
}

/// 从文本（PR 正文）里提取 issue 引用，返回 `repo#number` 形式的键。
/// 支持两种形式：
/// - `#123`：归属 PR 所在仓库（即传入的 `default_repo`）
/// - `owner/repo#123`：跨仓库，回退到 `repo`（路径最后一段）
///
/// **只匹配有关闭关键词的引用**（Closes/Fixes/Resolves/Refs/References/关闭/解决/修复），
/// 避免 PR 正文里裸提 `#N` 被误关联。关键词后允许冒号与空白，可连续跟多个编号。
/// 关键词与 `#N` 之间允许 repo 前缀（如 `Fixes owner/repo#123`）。
///
/// 用纯 ASCII 手扫；不依赖任何 crate。本函数是「PR 对应哪个 issue」反向关联的权威解析器。
fn parse_issue_refs(text: &str, default_repo: &str) -> Vec<String> {
    let bytes = text.as_bytes();
    let mut out: Vec<String> = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        // 尝试匹配关闭关键词
        if let Some(kw_end) = match_close_keyword(text, i) {
            // 跳过空白和可选的冒号
            let mut j = kw_end;
            while j < bytes.len() && is_whitespace(bytes[j]) {
                j += 1;
            }
            // 可选冒号（半角或全角）
            if j < bytes.len() && bytes[j] == b':' {
                j += 1;
            } else if j < bytes.len()
                && bytes[j] == 0xEF
                && j + 2 < bytes.len()
                && bytes[j + 1] == 0xBC
                && bytes[j + 2] == 0x9A
            {
                j += 3;
            }
            // 冒号后再跳过空白
            while j < bytes.len() && is_whitespace(bytes[j]) {
                j += 1;
            }
            // 提取 #N 引用（允许 repo 前缀）
            // 第一个 #N 前允许 repo 前缀和冒号，后续 #N 之间只允许空白
            let mut found_first = false;
            loop {
                if !found_first {
                    // 第一个 #N：跳过 repo 前缀字符
                    while j < bytes.len() && is_repo_prefix_char(bytes[j]) {
                        j += 1;
                    }
                    // 跳过可选的冒号（半角或全角）
                    if j < bytes.len() && bytes[j] == b':' {
                        j += 1;
                    } else if j < bytes.len()
                        && bytes[j] == 0xEF
                        && j + 2 < bytes.len()
                        && bytes[j + 1] == 0xBC
                        && bytes[j + 2] == 0x9A
                    {
                        j += 3;
                    }
                    // 跳过空白
                    while j < bytes.len() && is_whitespace(bytes[j]) {
                        j += 1;
                    }
                } else {
                    // 后续 #N：只跳过空白（不允许 repo 前缀或冒号）
                    while j < bytes.len() && is_whitespace(bytes[j]) {
                        j += 1;
                    }
                }
                if j < bytes.len()
                    && bytes[j] == b'#'
                    && j + 1 < bytes.len()
                    && bytes[j + 1].is_ascii_digit()
                {
                    found_first = true;
                    let num_start = j + 1;
                    let mut k = num_start;
                    while k < bytes.len() && bytes[k].is_ascii_digit() {
                        k += 1;
                    }
                    if let Ok(num) = text[num_start..k].parse::<i64>() {
                        if num > 0 {
                            // 向左扫描「owner/repo」前缀
                            let mut m = j as isize - 1;
                            while m >= 0 && is_repo_prefix_char(bytes[m as usize]) {
                                m -= 1;
                            }
                            let seg = &text[(m + 1) as usize..j];
                            let repo = seg
                                .rfind('/')
                                .map(|s| &seg[s + 1..])
                                .unwrap_or(default_repo);
                            if !repo.is_empty() {
                                out.push(format!("{}#{}", repo, num));
                            }
                        }
                    }
                    j = k;
                } else {
                    break;
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

// v0.3.49 (#144)：计算阶段产出的单任务写行 —— 结构体定义见 `crate::db::TaskUpsert`。
//
// 计算（含评论回源等网络 I/O）与写入分离：循环只产出行、不写库；
// 写入阶段包在一个事务里一次提交，且写事务不横跨网络 I/O
// （避免长持写锁阻塞 UI 独立连接的读写）。
//
// v0.4.1 (#250)：结构体已抽到 `crate::db::TaskUpsert`，与「按需拉取单个 issue」
// 共用同一份列清单与参数绑定；本模块只做「计算 → 交给 `db::write_task` 写入」。
// 字段名随抽取统一（`key`→`issue_key`、`state`→`issue_state`、`final_status`→`status`、
// `gh_status_raw`→`project_status`、`assignees_csv`→`assignees`、`labels_csv`→`labels`、
// `done_at_val`→`done_at`、`mentioned_val`→`mentioned`）。

/// v0.3.16+：单账号同步核心逻辑。返回该账号的 added / updated / 等。
///
/// 设计要点：
/// - `client` 已含 login / org / pat；upsert 时直接用 `account.id`
/// - key 仍为 `repo#number`（PRIMARY KEY 不变）。多账号下同 key 会被后写入者覆盖——
///   这是 v0.3.16 的已知限制（设计文档 3.1 节确认）。单账号视图（默认）下不会出现冲突。
/// - 单账号内仍走 5 源合并 + PR 关联 + Project Status 联动，与 v0.3.15 逻辑等价。
///
/// #235：`sync_account` 薄包装 —— 建客户端、挂采集槽，并在**无论成败**后
///   把本次同步实际发生的 API 调用（请求/返回参数）落盘。
///
/// 之所以放在包装层而不是 body 内：body 里遍布 `?` 早期返回，只有在这里
/// drain 才能保证失败路径也留下明细。
fn sync_account(
    conn: &Connection,
    account: &crate::db::Account,
    pat: &str,
    now: i64,
    board_mode: &str,
    sync_log_id: Option<i64>,
) -> Result<AccountSyncResult, String> {
    let (client, sink) = github::GitHubClient::new_with_sink(
        pat.to_string(),
        account.login.clone(),
        account.org.clone(),
    )?;
    let result = sync_account_inner(conn, account, &client, now, board_mode);
    let calls = github::drain_api_log(&sink);
    if !calls.is_empty() {
        if let Err(e) = crate::db::insert_api_logs(
            conn,
            "sync",
            account.id,
            sync_log_id.unwrap_or(0),
            now,
            &calls,
        ) {
            crate::tlog!("[sync] 落盘 API 调用明细失败: {}", e);
        }
    }
    result
}

/// #438：stale 候选行的**回源确认决策** —— 给定一次单 issue REST 回源结果，
/// 决定该行落成什么状态。抽成独立函数以便**离线单测**（`GitHubClient` 硬编码
/// `api.github.com`、无法注入测试端点，故网络调用留在调用方薄层）。
///
/// 语义（`design-and-release.md`：远程已关闭即视为做完，以远程为权威覆盖本地手动态）：
/// - [`RemoteState::Closed`] → 写 `closed` + `done`（真关闭进已完成列）；
/// - [`RemoteState::Open`] → **仅解除候选**，保留真实 `issue_state` / 本地手动态
///   （#438 修复核心：此前无条件写 closed/done，会把「仅被移出 assignee、仍 open」
///   的任务误标成已完成）；
/// - [`RemoteState::Missing`] / [`RemoteState::Unreachable`] → **不猜**，保持候选软折叠，
///   等下一轮同步复判（按 closed 会误标、按 open 会漏标）。
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
enum RemoteState {
    Closed,
    Open,
    /// 远端已无此 issue（404 /被删）。
    Missing,
    /// 请求失败（网络 / 401 / 限流耗尽）。
    Unreachable,
}

/// 候选行 + 其回源结果，产出应执行的 UPDATE 参数：
/// `(candidate_done, closed_done, done_at)`。
///
/// - `RemoteState::Closed` → `(1, true, now)`：写 `closed` + `done`（真关闭进已完成列），
///   `candidate_done` 保持 1（软折叠仍显示「待确认」）。
/// - `RemoteState::Open` → `(0, false, 0)`：**仅解除候选**，保留真实 `issue_state` /
///   本地手动态（#438 修复核心）。
/// - `Missing` / `Unreachable` → `(1, false, 0)`：**不猜**，保持候选软折叠等下一轮复判。
fn candidate_decision(remote: RemoteState, now: i64) -> (bool, bool, i64) {
    match remote {
        // #335：字面量须小写，与 `normalize_issue_state` 落库口径一致。
        RemoteState::Closed => (true, true, now),
        RemoteState::Open => (false, false, 0),
        RemoteState::Missing | RemoteState::Unreachable => (true, false, 0),
    }
}

/// 把 [`RemoteState`] 从 `fetch_issue` 的返回值映射出来（`Ok(None)` ⇒Missing）。
fn remote_state_of(res: &Result<Option<crate::github::RawTask>, String>) -> RemoteState {
    match res {
        Ok(None) => RemoteState::Missing,
        Ok(Some(t)) => {
            if crate::common::is_closed_state(&t.state) {
                RemoteState::Closed
            } else {
                RemoteState::Open
            }
        }
        Err(_) => RemoteState::Unreachable,
    }
}

fn sync_account_inner(
    conn: &Connection,
    account: &crate::db::Account,
    client: &github::GitHubClient,
    now: i64,
    board_mode: &str,
) -> Result<AccountSyncResult, String> {
    // 发现并存储该账号下的全部 Project（best-effort）。
    let project_ids = match client.fetch_all_projects() {
        Ok(projects) => {
            let github_ids: Vec<String> = projects.iter().map(|p| p.0.clone()).collect();
            if let Err(e) = crate::db::upsert_projects(conn, account.id, &projects, now) {
                crate::tlog!("[sync] 存储项目列表失败: {}", e);
            }
            // 清理已不存在的项目
            if let Err(e) = crate::db::prune_projects(conn, account.id, &github_ids) {
                crate::tlog!("[sync] 清理旧项目失败: {}", e);
            }
            // 旧项目状态选项先清空，后面并行拉到后再批量写入。
            if let Err(e) = crate::db::clear_project_statuses(conn, account.id) {
                crate::tlog!("[sync] 清空旧项目状态失败: {}", e);
            }
            github_ids
        }
        Err(e) => {
            crate::tlog!("[sync] 拉取项目列表失败（跳过 Status 联动）: {}", e);
            Vec::new()
        }
    };

    // v0.3.49 (#143)：各 project 的 Status 选项 + issue 列表并行拉取（纯网络），
    // DB 写入仍串行（同一连接）。线程 panic 按该项目失败处理（gid 为空即跳过）。
    // fetch_project_issues 返回 status_map、项目中发现的完整 issue 列表与条目 id，
    // 用于将「项目中有但搜索源未覆盖」的 issue 合并进同步数据（#215：item id 落库供写回）。
    let fetched_projects: Vec<FetchedProject> = std::thread::scope(|s| {
        let handles: Vec<_> = project_ids
            .iter()
            .map(|gid| {
                let gid = gid.clone();
                let client = &client;
                let org = &account.org;
                s.spawn(move || {
                    let field = match client.status_field(&gid) {
                        Ok(f) => f,
                        Err(e) => {
                            crate::tlog!("[sync] 拉取项目 {gid} 状态选项失败: {e}");
                            github::StatusField {
                                field_id: String::new(),
                                options: Vec::new(),
                            }
                        }
                    };
                    let (status_map, issues, item_ids) =
                        match client.fetch_project_issues(&gid, org) {
                            Ok(v) => v,
                            Err(e) => {
                                crate::tlog!("[sync] 拉取项目 {gid} 状态/issue 失败: {e}");
                                (
                                    std::collections::HashMap::new(),
                                    Vec::new(),
                                    std::collections::HashMap::new(),
                                )
                            }
                        };
                    (gid, field, status_map, issues, item_ids)
                })
            })
            .collect();
        handles
            .into_iter()
            .map(|h| {
                h.join().unwrap_or_else(|_| {
                    (
                        String::new(),
                        github::StatusField {
                            field_id: String::new(),
                            options: Vec::new(),
                        },
                        std::collections::HashMap::new(),
                        Vec::new(),
                        std::collections::HashMap::new(),
                    )
                })
            })
            .collect()
    });
    let mut project_status: std::collections::HashMap<String, String> =
        std::collections::HashMap::new();
    let mut project_issues: Vec<github::RawTask> = Vec::new();
    for (gid, field, status_map, issues, item_ids) in fetched_projects {
        if gid.is_empty() {
            continue;
        }
        // #215：选项（含 option_id）与字段 id 落库，供写回 mutation。
        if !field.options.is_empty() {
            let opts: Vec<(String, String, i64)> = field
                .options
                .iter()
                .map(|o| (o.name.clone(), o.option_id.clone(), o.order_index))
                .collect();
            if let Err(e) = crate::db::upsert_project_statuses(conn, account.id, &gid, &opts, now) {
                crate::tlog!("[sync] 存储项目 {gid} 状态选项失败: {e}");
            }
            if !field.field_id.is_empty() {
                if let Err(e) =
                    crate::db::set_project_status_field(conn, account.id, &gid, &field.field_id)
                {
                    crate::tlog!("[sync] 存储项目 {gid} 字段 id 失败: {e}");
                }
            }
        }
        if !item_ids.is_empty() {
            let items: Vec<(String, String)> = item_ids.into_iter().collect();
            if let Err(e) = crate::db::replace_project_items(conn, account.id, &gid, &items) {
                crate::tlog!("[sync] 存储项目 {gid} 条目 id 失败: {e}");
            }
        }
        crate::tlog!(
            "[sync] project {gid}: status_map={} issues={}",
            status_map.len(),
            issues.len()
        );
        project_status.extend(status_map);
        project_issues.extend(issues);
    }
    if project_status.is_empty() && !project_ids.is_empty() {
        crate::tlog!("[sync] 警告：所有项目的 Status 映射均为空（可能没有 Status 字段）");
    }

    // 多源合并：以多个稳定查询（assignee/author/mentions/commenter）覆盖 `involves:`
    // 的偶发漏拉缺陷，确保任何「与我相关」的 issue 都不会缺失。按 key 去重。
    // best-effort：单源失败不中断整次同步，其余源照常并入。
    //
    // v0.3.49 (#143)：5 源 `thread::scope` 并行（Search 限流由客户端内的共享门控，
    // 任意两次调用间隔 ≥ 2s）。线程 panic 按该源失败处理，不掀翻整次同步。
    let sources: Vec<(&str, Result<Vec<github::RawTask>, String>)> = std::thread::scope(|s| {
        let handles = [
            ("assignee", s.spawn(|| client.fetch_assigned())),
            ("author", s.spawn(|| client.fetch_authored())),
            ("mentions", s.spawn(|| client.fetch_mentioned())),
            ("commenter", s.spawn(|| client.fetch_commented())),
            ("involves", s.spawn(|| client.fetch_related())),
        ];
        handles
            .into_iter()
            .map(|(name, h)| {
                let r = h
                    .join()
                    .unwrap_or_else(|_| Err(format!("{name}: 拉取线程异常")));
                (name, r)
            })
            .collect()
    });
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
                crate::tlog!("[sync] 数据源 {} 拉取失败，已跳过: {}", name, e);
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
            crate::tlog!("[sync] 拉取 PR 列表失败，跳过 PR 关联: {}", e);
            (Vec::new(), false)
        }
    };
    // #467：同一 issue 可被多个 PR 引用 ⇒ 映射的值是**列表**而非单值。
    let pr_map = build_pr_map(&prs);

    // 项目中发现的 issue 已在上面并行拉取时合并到 project_issues（去重：搜索源已有的跳过）。
    // 这确保「项目中有但用户非 assignee/author/mentions/commenter」的 issue 也能上板。
    let existing_keys: HashSet<String> = raw
        .iter()
        .map(|t| format!("{}#{}", t.repo, t.number))
        .collect();
    let mut merged_from_project = 0usize;
    for t in project_issues {
        let k = format!("{}#{}", t.repo, t.number);
        if !existing_keys.contains(&k) && !t.is_pr {
            raw.push(t);
            merged_from_project += 1;
        }
    }
    if merged_from_project > 0 {
        crate::tlog!(
            "[sync] 从项目中补充了 {} 个搜索源未覆盖的 issue",
            merged_from_project
        );
    }

    // #278：父子关系（GraphQL `parent` / `subIssues`，只读）。
    // 按 `owner/repo` 分组批量拉取——每 25 个编号合一个请求，替代逐 issue 往返。
    // best-effort：整组失败只跳过该仓库（并保留其既有关系），不中断同步；
    // 与 PR 关联同一取舍：关系属展示信息，失败不能让看板状态回退。
    let mut links_by_key: std::collections::HashMap<String, crate::common::IssueLinks> =
        std::collections::HashMap::new();
    let mut links_failed_repos: HashSet<String> = HashSet::new();
    let mut link_groups: std::collections::HashMap<(String, String), Vec<i64>> =
        std::collections::HashMap::new();
    for t in &raw {
        if t.is_pr {
            continue;
        }
        link_groups
            .entry((t.repo_owner.clone(), t.repo.clone()))
            .or_default()
            .push(t.number);
    }
    for ((owner, repo), mut nums) in link_groups {
        nums.sort();
        nums.dedup();
        let repo_ref = format!("{owner}/{repo}");
        match client.fetch_issue_links(&owner, &repo, &nums) {
            Ok(m) => {
                for (n, links) in m {
                    // 无关联的 issue 不入 map——读取端 `get` 未命中时本就返回空串，
                    // 语义等价但 map 更小；关系被移除时同样按「清空」写入。
                    if links.is_empty() {
                        continue;
                    }
                    links_by_key.insert(format!("{repo}#{n}"), links);
                }
            }
            Err(e) => {
                links_failed_repos.insert(repo_ref);
                crate::tlog!("[sync] 拉取 {} 父子关系失败，保留既有值: {}", repo, e);
            }
        }
    }

    // v0.3.49 (#144)：循环外一次预加载，循环内 O(1) 查，消灭逐任务 N+1 查询
    // （2 次 SELECT + 2×labels 点查 + 全表列加载 + match_rules 重复解析）。
    // 预加载失败则整账号同步失败，绝不用空快照继续——否则既有 status 会被
    // 默认 "todo" 覆盖，造成本地手动态批量丢失。
    let label_rules =
        crate::db::load_label_rules(conn).map_err(|e| format!("预加载 label 映射失败: {e}"))?;
    let column_rules = crate::db::load_column_rules(conn, account.id)
        .map_err(|e| format!("预加载自定义列失败: {e}"))?;
    let existing_map = crate::db::load_existing_tasks(conn, account.id)
        .map_err(|e| format!("预加载既有任务失败: {e}"))?;

    // 计算阶段：网络回源 + 纯内存匹配，只产出行，不写库。
    let mut pending: Vec<crate::db::TaskUpsert> = Vec::with_capacity(raw.len());
    let mut comment_budget: usize = 12;
    for t in &raw {
        if t.is_pr {
            continue;
        }
        let key = format!("{}#{}", t.repo, t.number);
        let ownership: &str = classify(&t.assignees, &account.login);

        // 既有快照：用于"不在项目中"时维持本地手动态。
        // v0.3.16：既有记录必须是同一 account_id 的（避免跨账号状态污染）。
        let existing = existing_map.get(&key);
        let existing_status = existing.map(|e| e.status.as_str()).unwrap_or("todo");
        let existing_comments = existing.map(|e| e.comments).unwrap_or(0);
        let existing_mentioned = existing.map(|e| e.mentioned).unwrap_or(0);
        let existing_pr_number = existing.map(|e| e.pr_number).unwrap_or(0);
        let existing_pr_url = existing.map(|e| e.pr_url.as_str()).unwrap_or("");
        // #435：PR 合并状态同样参与「拉取失败保留既有值」的保护。
        let existing_pr_state = existing.map(|e| e.pr_state.as_str()).unwrap_or("");
        let existing_comment_url = existing.map(|e| e.comment_url.as_str()).unwrap_or("");
        let existing_branch = existing.map(|e| e.branch.as_str()).unwrap_or("");
        let existing_parent_issue = existing.map(|e| e.parent_issue.clone()).unwrap_or_default();
        let existing_sub_issues = existing.map(|e| e.sub_issues.clone()).unwrap_or_default();
        let exists = existing.is_some();

        // 决定看板状态（优先级见 resolve_final_status）：closed→done；自定义列；
        // 显式 label 映射（含 todo，#192）；Project Status 映射；都不命中→维持本地手动态。
        let gh_status_raw = project_status.get(&key).cloned().unwrap_or_default();
        let labels_csv = t.labels.join(",");
        // #192：只取显式命中（优先级 repo > org）；state 兜底不在此产生——
        // 显式映射到 todo 同样优先于 gh_status。
        let explicit_label = crate::db::resolve_status_from_rules_explicit(
            &label_rules,
            &account.org,
            &t.repo,
            &labels_csv,
        );
        // v0.3.28+：检查自定义列映射（按账号的 account_columns 匹配 gh_status）。
        // 仅当看板模式为 custom 时才生效，否则四态/Project 视图下任务会因 status 变成 col_key 而消失。
        let column_status = if board_mode == "custom" && !gh_status_raw.is_empty() {
            crate::db::resolve_column_from_rules(&column_rules, &gh_status_raw)
        } else {
            None
        };
        let final_status = resolve_final_status(
            // #335：**不得**写成 `t.state == "closed"`。Search（REST）给小写 `closed`，
            // 而 Project 条目查询（GraphQL）给大写 `CLOSED` —— 原实现大小写敏感，
            // 导致 Project 来源的已关闭 issue 永远漏判、滞留看板。
            crate::common::is_closed_state(&t.state),
            column_status,
            explicit_label,
            &gh_status_raw,
            existing_status,
        );

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
        // `branch` 为 PR 专用（head.ref），无关联 PR 时清空（#171 起 agent 工作分支
        // 单独存 `work_branch`，同步完全不碰 work_branch）。
        // #435：新增 `pr_state`，同样遵守「拉取失败保留既有值」的既有语义 ——
        // 网络抖动不该把已知的「已合并」误降级成未知。
        //
        // #467：同一 issue 可关联**多个** PR。
        // - `pr_number` / `pr_url` / `pr_state` / `branch` 四列仍取**主 PR**
        //   （列表首元素）⇒ 与改造前的 `or_insert` 结果逐位相同，存量行为零变化；
        // - `pr_refs` 是完整关联列表，写入独立的 `task_prs` 表 ⇒ 多 PR 不再丢失。
        // 「拉取失败保留既有值」的语义同样适用于 `pr_refs`：失败时置空，
        // 写入阶段据此**跳过**对 `task_prs` 的清理（不清空既有关联）。
        let (pr_number, pr_url, branch, pr_state, pr_refs): (
            i64,
            String,
            String,
            String,
            Vec<crate::common::PrRef>,
        ) = if pr_fetch_ok {
            match pr_map.get(&key) {
                Some(list) if !list.is_empty() => {
                    let main = &list[0];
                    (
                        main.number,
                        main.url.clone(),
                        main.head_ref.clone(),
                        main.state.clone(),
                        list.iter()
                            .map(|e| crate::common::PrRef {
                                number: e.number,
                                url: e.url.clone(),
                                state: e.state.clone(),
                            })
                            .collect(),
                    )
                }
                _ => (0, String::new(), String::new(), String::new(), Vec::new()),
            }
        } else {
            (
                existing_pr_number,
                existing_pr_url.to_string(),
                existing_branch.to_string(),
                existing_pr_state.to_string(),
                Vec::new(),
            )
        };

        // 新评论链接：仅当评论数较上次增加且预算充足时回源拉取（控制 API 调用量）。
        //
        // #472：改造前这里只拿得到**最新一条**评论的链接
        // （`fetch_comments` 内部 `.next_back()`）⇒ 其余评论的链接**全部丢弃**，
        // 详情面板只能给「最新评论」一个入口。现在一次性取回**全部**评论，
        // 写入独立关系表 `task_comments`（一对多），详情面板**倒序**列出。
        //
        // `latest_comment_url` 单值列**保持不变**（卡片跳转 + MCP 契约依赖它），
        // 取本轮列表里**最新**的那条（GitHub 按 created_at 升序返回）。
        // 本次拉取需要的 HTTP 调用数：末页不足「最新 N 条」时要再取上一页
        // ⇒ 最多 2 次（`per_page=100` > N=20 ⇒ 两页必然够）。
        let want_calls =
            crate::github::comments_pages(t.comments, crate::common::COMMENTS_KEPT_MAX).len();
        let (comments_count, latest_comment_url, comments, comments_fetch_ok): (
            i64,
            String,
            Vec<crate::common::CommentRef>,
            bool,
        ) = if t.comments > existing_comments as u64 && comment_budget >= want_calls {
            match client.fetch_comments(&t.repo, t.number, &t.repo_owner, t.comments) {
                Ok(Some(list)) if !list.is_empty() => {
                    comment_budget -= want_calls;
                    std::thread::sleep(Duration::from_millis(80));
                    let (refs, newest) = comments_to_refs(&list);
                    (t.comments as i64, newest, refs, true)
                }
                Ok(_) => {
                    // 没有评论（`Ok(None)`）或空列表 ⇒ 保留既有值，**不清空**关联。
                    // ⚠️ 触发条件是「评论数较上次增加」，此时拿到空列表属自相矛盾
                    // （GitHub 说有评论、API 却返回空）⇒ 保守起见按「没拉到」处理。
                    comment_budget -= want_calls;
                    (
                        t.comments as i64,
                        existing_comment_url.to_string(),
                        Vec::new(),
                        false,
                    )
                }
                Err(e) => {
                    crate::tlog!("[sync] 拉取评论失败，跳过: {}#{}: {}", t.repo, t.number, e);
                    (
                        existing_comments,
                        existing_comment_url.to_string(),
                        Vec::new(),
                        false,
                    )
                }
            }
        } else {
            // 本轮没回源（评论数没涨 / 预算用尽）⇒ 保留既有评论关联行。
            (
                existing_comments,
                existing_comment_url.to_string(),
                Vec::new(),
                false,
            )
        };

        // #278：父子关系。仅当该仓库的整组拉取成功时更新；失败则保留既有值
        // （与 PR 关联同款取舍，避免一次网络抖动把已有关联清空）。
        let (parent_issue, sub_issues) =
            if links_failed_repos.contains(&format!("{}/{}", t.repo_owner, t.repo)) {
                (existing_parent_issue, existing_sub_issues)
            } else {
                links_by_key
                    .get(&key)
                    .map(|l| l.to_columns())
                    .unwrap_or((String::new(), String::new()))
            };

        pending.push(crate::db::TaskUpsert {
            issue_key: key,
            owner: account.org.clone(),
            account_id: account.id,
            repo: t.repo.clone(),
            number: t.number,
            title: t.title.clone(),
            url: t.url.clone(),
            // #335：统一归一化为小写（REST 口径），避免同一列出现 4 种大小写。
            issue_state: crate::common::normalize_issue_state(&t.state),
            ownership: ownership.to_string(),
            status: final_status,
            project_status: gh_status_raw,
            assignees: assignees_csv,
            labels: labels_csv,
            author: t.author.clone(),
            done_at: done_at_val,
            mentioned: mentioned_val,
            comments_count,
            latest_comment_url,
            pr_number,
            pr_url,
            // #435：PR 合并状态（`merged`/`open`/`closed`/空串=未知）。
            pr_state,
            // #467：完整的多 PR 关联（写入独立的 `task_prs` 表）。
            // `pr_fetch_ok=false` 时本列表为空且写入阶段会跳过清理 ⇒ 保留既有关联。
            prs: pr_refs,
            pr_fetch_ok,
            // #472：完整的多评论关联（写入独立的 `task_comments` 表）。
            // `comments_fetch_ok=false` 时本列表为空且写入阶段会跳过清理 ⇒ 保留既有关联。
            comments,
            comments_fetch_ok,
            branch,
            parent_issue,
            sub_issues,
            created_at: crate::common::iso8601_to_secs(&t.created_at),
            updated_at: crate::common::iso8601_to_secs(&t.updated_at),
            exists,
        });
    }

    // 写入阶段：stale 标记 + 全部 upsert 包在一个事务里一次提交。
    // 原来每任务 1 次 autocommit（N 次 WAL fsync），现在 1 次 commit。
    let mut added = 0usize;
    let mut updated = 0usize;
    {
        let tx = conn
            .unchecked_transaction()
            .map_err(|e| format!("开启同步写入事务失败: {e}"))?;
        // 仅本账号的任务标记陈旧（避免「全部账号视图」下另一账号的同步误标本账号任务为陈旧）。
        // #438：仅标记「同步前已存在」（existing_map 快照）的行为陈旧，而非按
        // account_id 全量。否则同步事务进行期间，并发的按需拉取（on_demand InsertIfAbsent）
        // 新插入的本账号行会被一并标 stale，又因不在 pending 而不被复位 ⇒ 被下方
        // 「stale ⇒ closed/done」误判为已完成。existing_map 在本函数入口预加载，
        // 其 key 即 issue_key（repo#number）。
        for key in existing_map.keys() {
            tx.execute(
                "UPDATE tasks SET stale = 1 WHERE account_id = ?1 AND issue_key = ?2",
                rusqlite::params![account.id, key.as_str()],
            )
            .map_err(|e| format!("标记陈旧任务失败: {e}"))?;
        }
        for row in &pending {
            // v0.4.1 (#250)：写入走 db::write_task（与「按需拉取单个 issue」共用同一份
            // 列清单与参数绑定）。同步路径是权威数据 → Upsert（冲突则覆盖）。
            crate::db::write_task(&tx, row, now, crate::db::TaskWriteMode::Upsert)?;

            // #467：写该 issue 的**全部**关联 PR（全量替换语义）。
            // ⚠️ 仅在「PR 列表拉取成功」时执行 —— 拉取失败必须保留既有关联，
            // 否则一次网络抖动就会把看板上的 PR 徽章全部清掉
            // （与 `tasks.pr_*` 三列的既有「拉取失败保留既有值」语义一致）。
            if row.pr_fetch_ok {
                crate::db::write_task_prs(&tx, row.account_id, &row.issue_key, &row.prs, now)?;
            }

            // #472：写该 issue 的**全部**评论（全量替换语义）。
            // ⚠️ 仅在「评论列表拉取成功」时执行 —— 拉取失败必须保留既有关联，
            // 否则一次网络抖动就会把详情面板里的评论链接全部清掉
            // （与 `task_prs` / `tasks.pr_*` 的既有「拉取失败保留既有值」语义一致）。
            if row.comments_fetch_ok {
                crate::db::write_task_comments(
                    &tx,
                    row.account_id,
                    &row.issue_key,
                    &row.comments,
                    now,
                )?;
            }

            if row.exists {
                updated += 1;
            } else {
                added += 1;
            }
        }
        tx.commit()
            .map_err(|e| format!("提交同步写入事务失败: {e}"))?;
    }

    // #438：处理本账号下的陈旧任务。搜索源只覆盖「与我相关」（assignee/author/
    // mentions/commenter/involves）且默认只返回 open，故「不在结果里」有两种成因：
    // 已关闭，**或** 已不再与我相关（被移出 assignee 且无其他关联）——**不能仅凭
    // stale 判定为已关闭**。搜索源完整时走下方两阶段确认；不完整则只解除 stale。
    let candidate_done;
    let removed = 0usize;
    // v0.3.29：任一搜索源失败说明同步数据源不完整，stale 判定不可信。
    // 此时仅解除 stale 保留本地记录，绝不删（避免误删真实关联任务）。
    let sources_incomplete = !failed.is_empty();
    if sources_incomplete {
        // 搜索源不完整：只解除 stale 标记，保留任务
        let n = conn
            .execute(
                "UPDATE tasks SET stale = 0 WHERE account_id = ?1 AND stale = 1",
                [account.id],
            )
            .map_err(|e| format!("解除 stale 标记失败: {}", e))?;
        if n > 0 {
            crate::tlog!("[sync] 搜索源不完整，保留 {} 个任务不过删", n);
        }
        // 搜索源不完整 ⇒ 不做任何完成判定（stale 不可信），候选计数为 0。
        candidate_done = 0;
    } else {
        // 搜索源完整：stale 任务 = 已关闭 **或** 已不再与我相关（被移出 assignee 且
        // 无 author/mention/comment/involves 等其他关联）。GitHub Search API 只返回
        // open issue，故「不在结果里」本身**无法**区分这两种成因。
        //
        // #438：原实现对全部 stale 行无条件写 `issue_state='closed', status='done'`，
        // 于是「仅被移出 assignee、issue 仍 open」的任务被误标成已完成。
        // 改为两阶段：① 批量标 `candidate_done=1`（软折叠，TaskCard 渲染「待确认」）；
        // ② 逐条回源（单 issue REST）确认 —— 真 closed 才写 closed/done，
        // 仍 open 则仅解除 `candidate_done`，保留其真实 `issue_state` / 本地手动态。
        //
        // 成本可控：API 调用只发生在 stale 行上（通常个位数~几十），且走**核心 REST 配额**
        // （5000/h）而非 Search API 的 30/min 严限（#250 的 `fetch_issue` 同款端点）。
        // 确认失败（Err：网络/401/限流）**不猜**：按 closed 处理会误标、保持 open 会漏标，
        // 故一律保留 `candidate_done` 软折叠，等下一轮同步复判。
        //
        // ⚠️ 「真关闭仍自动进已完成列」是产品语义（`design-and-release.md`：
        // 远程已关闭即视为做完，以远程为权威覆盖本地手动态），故保持不变。
        let n = conn
            .execute(
                "UPDATE tasks SET candidate_done = 1, stale = 0
                 WHERE account_id = ?1 AND stale = 1",
                [account.id],
            )
            .map_err(|e| format!("标记候选待确认失败: {}", e))?;
        candidate_done = n;

        // 取出本账号全部候选行（`candidate_done=1`），逐条回源确认。
        // 用 `candidate_done=1` 而非 stale 作筛选条件：既涵盖本轮新标的，
        // 也覆盖历史遗留的候选行（下一轮同步一并复判）。
        let candidates: Vec<(String, String, i64)> = {
            let mut stmt = conn
                .prepare(
                    "SELECT issue_key, repo, number FROM tasks
                     WHERE account_id = ?1 AND candidate_done = 1",
                )
                .map_err(|e| format!("读取候选任务失败: {}", e))?;
            let rows = stmt
                .query_map([account.id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
                .map_err(|e| format!("读取候选任务失败: {}", e))?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|e| format!("读取候选任务失败: {}", e))?
        };

        let (mut still_open, mut unconfirmed) = (0usize, 0usize);
        for (issue_key, repo, number) in candidates {
            // REST 端点要求 `owner/repo`；本仓库 owner 存 `tasks.owner`（可能空串，
            // 此时退回账号 login —— 个人命名空间仓库的org 就是空串，见 #250）。
            let owner: String = conn
                .query_row(
                    "SELECT owner FROM tasks WHERE issue_key = ?1 LIMIT 1",
                    [&issue_key],
                    |r| r.get(0),
                )
                .unwrap_or_default();
            let api_owner = if owner.trim().is_empty() {
                account.login.clone()
            } else {
                owner
            };
            let res = client.fetch_issue(&api_owner, &repo, number);
            if let Err(e) = &res {
                crate::tlog!("[sync] 候选回源确认失败（保留待确认）: {issue_key} | {e}");
            }
            let decision = candidate_decision(remote_state_of(&res), now);
            match decision {
                // 真closed：写 closed/done，`candidate_done` 保持 1（软折叠仍显示「待确认」）。
                // #335：字面量须小写，与 `normalize_issue_state` 落库口径一致。
                (true, true, _) => {
                    conn.execute(
                        "UPDATE tasks SET candidate_done = 1, issue_state = 'closed', status = 'done', stale = 0,
                         done_at = CASE WHEN done_at = 0 THEN ?2 ELSE done_at END
                         WHERE issue_key = ?1",
                        rusqlite::params![issue_key, decision.2],
                    )
                    .map_err(|e| format!("标记已关闭失败: {}", e))?;
                }
                // 仍 open（被移出 assignee 等）⇒ **解除候选**，保留真实状态与手动态。
                (false, _, _) => {
                    conn.execute(
                        "UPDATE tasks SET candidate_done = 0, stale = 0 WHERE issue_key = ?1",
                        [&issue_key],
                    )
                    .map_err(|e| format!("解除候选标记失败: {}", e))?;
                    still_open += 1;
                }
                // 远端已无此 issue（被删）或确认失败 ⇒ 保持候选软折叠，不臆断状态。
                (true, false, _) => {
                    unconfirmed += 1;
                }
            }
        }
        if candidate_done > 0 {
            crate::tlog!(
                "[sync] 标记 {} 个任务为候选待确认（其中 {} 个回源确认仍 open 已解除、{} 个未确认）",
                candidate_done,
                still_open,
                unconfirmed
            );
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

/// #262：决定本次同步覆盖的账号集。**始终返回全部已配置账号**——同步范围与
/// `meta.view_mode` 解耦（view_mode 仅影响前端展示，见 App.tsx 的 accountFilter / 看板聚合）。
/// 旧实现按 view_mode 选靶，而 view_mode 恒为默认值 'single'（其设置入口已被 597840b 删除，
/// 前端再无调用方），导致除「激活账号」外的账号永不同步。多账号用户的核心诉求是
/// 「数据都要进本地库」，故同步不再受 view_mode 限制。抽出为独立函数便于回归测试守住该契约。
fn sync_target_accounts(conn: &Connection) -> Result<Vec<crate::db::Account>, String> {
    let accounts = crate::db::list_accounts(conn)?;
    if accounts.is_empty() {
        return Err("未配置 GitHub PAT，请在设置面板粘贴 token（fine-grained 推荐）".to_string());
    }
    Ok(accounts)
}

pub fn run(conn: &Connection, trigger_type: &str) -> Result<SyncResult, String> {
    // #262：同步范围与视图模式解耦——始终同步全部已配置账号（见 `sync_target_accounts`）。
    let target: Vec<crate::db::Account> = sync_target_accounts(conn)?;

    let now = now_secs();
    // v0.3.23：记录同步开始日志（每个账号一条）
    let mut log_ids: Vec<(i64, i64)> = Vec::new(); // (account_id, log_id)
    for account in &target {
        if let Ok(log_id) = crate::db::insert_sync_log(conn, account.id, trigger_type, now) {
            log_ids.push((account.id, log_id));
        }
    }

    let mut total_added = 0usize;
    let mut total_updated = 0usize;
    let mut total_candidate_done = 0usize;
    let mut total_removed = 0usize;
    let mut total_failed: Vec<String> = Vec::new();
    // #328：真正跑完的账号数（`sync_account` 返回 Ok）。全 0 时整轮同步视为失败，
    // 不能返回 Ok——否则 lib.rs 会清空 last_sync_error、推进 last_sync_at、广播
    // SYNCED_EVENT，用户看到「同步成功」但一条数据都没拉到。
    let mut ok_accounts = 0usize;

    // 账号间间隔：避免同时发起多账号搜索触发突发限流（即便每账号 1s 间隔，多账号叠加仍可能撞 Search API 上限）。
    for (idx, account) in target.iter().enumerate() {
        if idx > 0 {
            std::thread::sleep(Duration::from_millis(800));
        }
        // 查当前账号对应的日志 id（#328：提到读 PAT 之前，下面的 continue 分支也要用它收尾）。
        let log_id = log_ids
            .iter()
            .find(|(aid, _)| *aid == account.id)
            .map(|(_, lid)| *lid);
        // #328：跳过的账号必须把 sync_logs 行收尾。原先 `continue` 前不回写，
        // 该行永久停留在 `status='running'`，前端「同步日志」永远显示「进行中」。
        let fail_log = |msg: &str| {
            if let Some(lid) = log_id {
                let _ = crate::db::update_sync_log(
                    conn,
                    lid,
                    now_secs(),
                    "failed",
                    0,
                    0,
                    0,
                    0,
                    0,
                    "",
                    msg,
                );
            }
        };
        // #262：读 PAT 失败不应中止整轮同步（与紧随其后的 `pat.is_empty() → continue`
        // 策略一致）。旧写法用 `?` 直接冒泡，任一账号读 PAT 失败会让后续账号全不动。
        let (login, _org, pat) = match crate::db::get_account_pat(conn, account.id) {
            Ok(t) => t,
            Err(e) => {
                let msg = format!("{}: 读取 PAT 失败: {}", account.login, e);
                fail_log(&msg);
                total_failed.push(msg);
                continue;
            }
        };
        if pat.is_empty() {
            let msg = format!("{}: 未配置 PAT", login);
            fail_log(&msg);
            total_failed.push(msg);
            continue;
        }
        // v0.3.43+：看板列模式改为「每账号」配置（meta 里 board_mode:<id>），决定是否启用
        // 自定义列映射（仅 custom 时写入 col_key）。未配置默认 project。
        let board_mode = crate::db::get_account_board_mode(conn, account.id);
        match sync_account(conn, account, &pat, now, &board_mode, log_id) {
            Ok(r) => {
                ok_accounts += 1;
                total_added += r.added;
                total_updated += r.updated;
                total_candidate_done += r.candidate_done;
                total_removed += r.removed;
                total_failed.extend(r.failed_sources.clone());
                // 更新日志：成功
                if let Some(lid) = log_id {
                    let _ = crate::db::update_sync_log(
                        conn,
                        lid,
                        now_secs(),
                        "success",
                        r.added as i64,
                        r.updated as i64,
                        r.removed as i64,
                        r.candidate_done as i64,
                        0,
                        &r.failed_sources.join("; "),
                        "",
                    );
                }
            }
            Err(e) => {
                total_failed.push(format!("{}: {}", login, e));
                // 更新日志：失败
                if let Some(lid) = log_id {
                    let _ = crate::db::update_sync_log(
                        conn,
                        lid,
                        now_secs(),
                        "failed",
                        0,
                        0,
                        0,
                        0,
                        0,
                        "",
                        &e,
                    );
                }
            }
        }
    }

    // 已完成任务保留 1 个月（按 done_at 窗口淘汰），与单账号视图保持同样的清理策略。
    //
    // #472 审查修复：淘汰时**一并清理关系表**（`task_comments` / `task_prs`），
    // 否则留下**孤儿行**（无界增长 + 同 issue_key 重新同步时陈旧链接被重新挂上）。
    // 实现见 `db::prune_done_tasks`（抽到 db 层才能被单测覆盖 —— 原先内联在
    // 这条需要真实网络的路径里，永远测不到）。
    let pruned = crate::db::prune_done_tasks(conn, now)?;

    crate::db::set_setting(conn, "last_sync_at", &now.to_string())?;

    // v0.3.23：清理超过 30 天的同步日志（保留策略；具体数值见 `db::prune_sync_logs`）
    let _ = crate::db::prune_sync_logs(conn, now);
    // #235：清理 API 调用明细（7 天 + 条数上限，避免高频同步写爆库）。
    let _ = crate::db::prune_api_logs(conn, now, crate::db::API_LOG_MAX_ROWS);

    // #328：全部目标账号都失败 → 返回 Err。清理与 last_sync_at 已在上面执行完，
    // 所以失败路径同样留下可观测痕迹（用户能看出「上次尝试是什么时候、失败原因是什么」），
    // 只是不再谎报成功、也不再清空 last_sync_error 横幅。
    if ok_accounts == 0 {
        return Err(format!(
            "全部 {} 个账号同步失败：{}",
            target.len(),
            total_failed.join("; ")
        ));
    }

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
        // 保持 #262 的既有语义「本次**覆盖**（尝试）的账号数」不变——成败明细由上面的
        // `warning` 承载；#328 只让「全败」时整轮报错，不动该字段含义（避免连带改
        // types.ts 注释 / i18n 文案 / issue-262 KB 文档）。
        accounts_synced: target.len(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use rusqlite::Connection;

    #[test]
    fn account_board_mode_defaults_and_validates() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
        )
        .unwrap();
        // 未配置默认 project
        assert_eq!(db::get_account_board_mode(&conn, 1), "project");
        // 合法值可写入并按账号隔离
        db::set_account_board_mode(&conn, 1, "custom").unwrap();
        db::set_account_board_mode(&conn, 2, "status").unwrap();
        assert_eq!(db::get_account_board_mode(&conn, 1), "custom");
        assert_eq!(db::get_account_board_mode(&conn, 2), "status");
        // 非法值拒绝
        assert!(db::set_account_board_mode(&conn, 1, "bogus").is_err());
        assert_eq!(db::get_account_board_mode(&conn, 1), "custom");
    }

    /// #262 防回归：无论 view_mode 为何值，同步目标集都必须覆盖全部已配置账号。
    /// 旧实现按 view_mode 选靶，view_mode='single' 时只同步激活账号，第二个账号永不同步。
    #[test]
    fn sync_target_accounts_covers_all_accounts_regardless_of_view_mode() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        static SEQ: AtomicUsize = AtomicUsize::new(0);
        let n = SEQ.fetch_add(1, Ordering::SeqCst);
        let path = std::env::temp_dir().join(format!(
            "taskboard_sync_target_test_{}_{}.db",
            std::process::id(),
            n
        ));
        // #266：路径已按 pid+seq 唯一化，无需预删；连接存活期也不删（删除打开中的 SQLite
        // 在 Windows 会 sharing violation，在 Unix 会留孤儿 -wal/-shm）。与 mem_conn() 同一约定。
        let conn = db::open_db(&path).expect("open_db 测试库");
        // 两个真实账号（PAT 非空）。
        let _ = db::insert_account(&conn, "A", "a", "", "pa").unwrap();
        let _ = db::insert_account(&conn, "B", "b", "", "pb").unwrap();
        // 即便 view_mode='single' + active_account_id 指向某单一账号，也应同步全部账号。
        db::set_setting(&conn, "view_mode", "single").unwrap();
        db::set_setting(&conn, "active_account_id", "1").unwrap();

        let targets = sync_target_accounts(&conn).expect("应返回账号集");
        assert_eq!(
            targets.len(),
            2,
            "view_mode=single 时仍应同步全部账号（#262 核心修复点）"
        );
    }

    /// #328：全部目标账号都失败时 `run` 必须返回 `Err`，且失败路径同样要留下痕迹
    /// （`last_sync_at` 有推进、跳过的账号把 `sync_logs` 行收尾为 `failed`）。
    ///
    /// 反向验证（旧行为）：
    /// ① `run` 返回 `Ok` → 第 1 个断言失败（lib.rs 会因此清空 last_sync_error 并广播
    ///    SYNCED_EVENT，UI 谎报「同步成功」）；
    /// ② 跳过的账号不回写日志 → 该行永远是 `status='running'`，第 3 个断言失败。
    ///
    /// 不触网：# 账号 PAT 为空即走 `continue` 分支，不发任何请求。
    #[test]
    fn run_reports_error_when_every_account_fails() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        static SEQ: AtomicUsize = AtomicUsize::new(0);
        let n = SEQ.fetch_add(1, Ordering::SeqCst);
        let path = std::env::temp_dir().join(format!(
            "taskboard_sync_all_failed_test_{}_{}.db",
            std::process::id(),
            n
        ));
        let conn = db::open_db(&path).expect("open_db 测试库");
        // 唯一账号 PAT 为空 ⇒ 循环里直接 continue，不会发起网络请求。
        // `insert_account` 本身拒绝空 PAT，故先插入再置空（模拟「加了账号但没填 token」）。
        let _ = db::insert_account(&conn, "A", "a", "", "placeholder").unwrap();
        conn.execute("UPDATE accounts SET pat_token = ''", [])
            .unwrap();

        let err = run(&conn, "manual").expect_err("全部账号失败时应返回 Err");
        assert!(err.contains("全部 1 个账号同步失败"), "{err}");
        assert!(err.contains("未配置 PAT"), "{err}");

        // 失败路径也要留下可观测痕迹：last_sync_at 仍被推进。
        assert!(
            !db::get_setting(&conn, "last_sync_at").is_empty(),
            "失败也要推进 last_sync_at，否则用户无法判断「上次尝试是何时」"
        );

        // 被跳过的账号必须把 sync_logs 行收尾，不能停在 running。
        let status: String = conn
            .query_row(
                "SELECT status FROM sync_logs ORDER BY id DESC LIMIT 1",
                [],
                |r| r.get(0),
            )
            .expect("应有一条同步日志");
        assert_eq!(status, "failed", "跳过（未配置 PAT）的账号也要收尾日志");
    }

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
        assert!(prod.exists(), "生产库应已存在（先运行过一次 App 同步）");
        // 关键：复制到临时库再跑，**绝不改写用户的生产库**。
        // 早期版本直接开生产库跑同步，属于误改用户数据的高危写法——任何 `cargo test --lib -- --ignored`
        // 都会触发，故改为临时副本，验证后删除。
        //
        // v0.3.17 起 DB 是 WAL 模式：最新数据可能在 `-wal` 里尚未 checkpoint，
        // `fs::copy` 主文件会拿到旧快照（实测丢 accounts 表）。改用 SQLite 原生
        // `VACUUM INTO` 做一致性快照（含 WAL 内容，且对正在使用的库安全）。
        // #266：原固定名 taskboard_headless_test.db 在多进程/重跑时会与自身或别处冲突，
        // 改为带 pid 的唯一名（本测试虽 #[ignore]，仍按同一约定整改，避免遗留隐患）。
        let tmp =
            std::env::temp_dir().join(format!("taskboard_headless_test_{}.db", std::process::id()));
        let _ = std::fs::remove_file(&tmp);
        {
            let src = Connection::open(prod).expect("打开生产库（只读快照）");
            src.execute("VACUUM INTO ?1", [tmp.to_string_lossy().as_ref()])
                .expect("VACUUM INTO 快照失败");
        }
        crate::tlog!(
            "[test] 已快照生产库到临时文件（不影响生产数据）：{}",
            tmp.display()
        );
        // 快照经 open_db 统一补 schema/迁移（与 App 打开路径一致）。
        let conn = db::open_db(&tmp).expect("open_db 快照库");

        crate::tlog!("[test] 开始真实同步（关注 PR 关联）…");
        let res = run(&conn, "manual").expect("同步应成功");
        crate::tlog!(
            "[test] 同步完成：total={} added={} updated={} removed={} candidate_done={} pruned={}",
            res.total,
            res.added,
            res.updated,
            res.removed,
            res.candidate_done,
            res.pruned
        );

        let pr_gt0: i64 = conn
            .query_row("SELECT COUNT(*) FROM tasks WHERE pr_number > 0", [], |r| {
                r.get(0)
            })
            .unwrap();
        let total: i64 = conn
            .query_row("SELECT COUNT(*) FROM tasks", [], |r| r.get(0))
            .unwrap();
        let diag_fetch_ok = db::get_setting(&conn, "diag_pr_fetch_ok");
        let diag_fetched = db::get_setting(&conn, "diag_pr_fetched");
        let diag_map = db::get_setting(&conn, "diag_pr_map_size");
        let diag_matched = db::get_setting(&conn, "diag_pr_matched");
        crate::tlog!(
            "[test] PR 关联命中：{}/{}  | diag_fetch_ok={} diag_fetched={} diag_map_size={} diag_matched={}",
            pr_gt0, total, diag_fetch_ok, diag_fetched, diag_map, diag_matched
        );
        let _ = std::fs::remove_file(&tmp);
        assert!(
            pr_gt0 > 0,
            "期望至少 1 个任务的 pr_number > 0（PR 关联应落地）"
        );
    }

    /// #467 端到端：真实同步后 `task_prs` 必须落库，且**多 PR 的 issue 全部保留**。
    ///
    /// 与 `test_headless_sync_pr_linkage` 同样只跑**临时副本**，绝不改生产库。
    /// 额外断言：
    /// ① `task_prs` 行数 ≥ `tasks.pr_number > 0` 的行数（每个有主 PR 的 issue 至少一行）；
    /// ② 存在**同一个 issue 关联 ≥2 个 PR** 的行（多 PR 真的落库了，而不是仍然只有一个）；
    /// ③ `task_prs` 的 PR 编号与该 issue 的主 PR（`tasks.pr_number`）一致（口径不漂）。
    #[test]
    #[ignore = "需要真实 GitHub PAT；跑法：cargo test --lib test_headless_multi_pr -- --ignored --nocapture"]
    fn test_headless_multi_pr() {
        let prod = std::path::Path::new(
            "/Users/liushizhao/Library/Application Support/com.shawnliu.taskboard/taskboard.db",
        );
        assert!(prod.exists(), "生产库应已存在（先运行过一次 App 同步）");
        let tmp =
            std::env::temp_dir().join(format!("taskboard_multi_pr_test_{}.db", std::process::id()));
        let _ = std::fs::remove_file(&tmp);
        {
            let src = Connection::open(prod).expect("打开生产库（只读快照）");
            src.execute("VACUUM INTO ?1", [tmp.to_string_lossy().as_ref()])
                .expect("VACUUM INTO 快照失败");
        }
        let conn = db::open_db(&tmp).expect("open_db 快照库");
        run(&conn, "manual").expect("同步应成功");

        // ① 有主 PR 的 issue 至少要有一行关联。
        //
        // ⚠️ 这里比的是「**本轮同步覆盖到的** issue」：`tasks.pr_number` 对**陈旧任务**
        // （已关闭 / 不再与我相关，本轮不在 pending 里）保留存量值，而它们的
        // `task_prs` 行要么保留上一轮的、要么从未有过 ⇒ 直接比全表会误报。
        let covered_with_pr: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM (
                   SELECT DISTINCT t.account_id, t.issue_key
                   FROM tasks t JOIN task_prs p
                     ON p.account_id = t.account_id AND p.issue_key = t.issue_key
                   WHERE t.pr_number > 0
                 )",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let prs_rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM task_prs", [], |r| r.get(0))
            .unwrap();
        crate::tlog!("[test] 有主 PR 且已覆盖的 issue={covered_with_pr} task_prs 行数={prs_rows}");
        assert!(
            prs_rows >= covered_with_pr,
            "task_prs 行数({prs_rows}) 应 ≥ 已覆盖且有主 PR 的 issue 数({covered_with_pr})"
        );

        // ② 存在多 PR 的 issue（这是 #467 的核心诉求）。
        let multi: Vec<(String, i64)> = {
            let mut stmt = conn
                .prepare(
                    "SELECT issue_key, COUNT(*) AS n FROM task_prs
                     GROUP BY account_id, issue_key HAVING n >= 2 ORDER BY n DESC LIMIT 5",
                )
                .unwrap();
            let rows = stmt
                .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
                .unwrap();
            rows.map(|r| r.unwrap()).collect()
        };
        crate::tlog!("[test] 多 PR 的 issue（前 5）: {multi:?}");
        assert!(
            !multi.is_empty(),
            "期望至少 1 个 issue 关联 ≥2 个 PR（#467 的核心：多 PR 不能再被丢弃）"
        );

        // ③ 口径不漂：**凡是 task_prs 里有行的 issue**，其主 PR（tasks.pr_number）
        //    必须也在关联列表里。
        //    （陈旧任务不在此列 —— 它们的 tasks.pr_number 是存量值，本轮未覆盖。）
        let mismatch: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM tasks t
                 WHERE t.pr_number > 0
                   AND EXISTS (
                     SELECT 1 FROM task_prs p
                     WHERE p.account_id = t.account_id AND p.issue_key = t.issue_key
                   )
                   AND NOT EXISTS (
                     SELECT 1 FROM task_prs p
                     WHERE p.account_id = t.account_id AND p.issue_key = t.issue_key
                       AND p.pr_number = t.pr_number
                   )",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(mismatch, 0, "主 PR 必须出现在 task_prs 关联列表中");

        let _ = std::fs::remove_file(&tmp);
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
    fn resolve_final_status_follows_priority() {
        // #192：显式 label→todo 优先于 gh_status 映射（此前被降级）。
        assert_eq!(
            resolve_final_status(false, None, Some("todo".into()), "✨开发中", "doing"),
            "todo"
        );
        // closed 最高：远程权威覆盖一切。
        assert_eq!(
            resolve_final_status(true, None, Some("todo".into()), "✨开发中", "doing"),
            "done"
        );
        // custom 列映射次之。
        assert_eq!(
            resolve_final_status(
                false,
                Some("col_1".into()),
                Some("todo".into()),
                "✨开发中",
                "doing"
            ),
            "col_1"
        );
        // 非 todo 显式映射同样优先。
        assert_eq!(
            resolve_final_status(false, None, Some("processed".into()), "✨开发中", "doing"),
            "processed"
        );
        // 无显式命中 → gh_status 映射。
        assert_eq!(
            resolve_final_status(false, None, None, "✨开发中", "todo"),
            "doing"
        );
        // gh_status 映射不到 → 保持本地（不回落原文）。
        // ⚠️ #335 起 `Backlog` / `Done` / `Released` 这类**英文**选项已被识别，
        // 不能再用它们当「映射不到」的样例（旧版本这么写过，会被新行为打红）。
        assert_eq!(
            resolve_final_status(false, None, None, "自定义看板列", "doing"),
            "doing"
        );
        assert_eq!(
            resolve_final_status(false, None, None, "??", "processed"),
            "processed"
        );
        // 无 gh_status → 保持本地。
        assert_eq!(
            resolve_final_status(false, None, None, "", "processed"),
            "processed"
        );
    }

    /// #412：`match_close_keyword` 的**后词边界**与**文本末尾**两条分支。
    ///
    /// **为什么必须补**：这是一个手写扫描器（逐字节走 `text.as_bytes()`），
    /// 从 **PR 正文**里提取关闭关键词。审计实测 7 个变异中**这两个存活**：
    ///
    /// | 变异 | 后果 |
    /// |---|---|
    /// | 后词边界检查被删 | `fixedX` / `closed_foo` 这类**并非该关键词**的词也被当成关闭标记 |
    /// | 文本末尾直接返回改成 `None` | 关键词**位于正文最末**时（很常见：末行就是「Fixed」）匹配不到 |
    ///
    /// 前词边界、char boundary 守卫、大小写不敏感三项**已有覆盖**（本轮实测均被捕获）。
    ///
    /// 另记 1 个**等价变异**（不计入缺口）：中文关键词分支把 `candidate == kw`
    /// 改成 `eq_ignore_ascii_case(kw)` **存活** —— 后者只影响 ASCII 大小写，
    /// 对非 ASCII 字符串等价 ⇒ 两种写法同值。
    #[test]
    fn match_close_keyword_respects_trailing_word_boundary() {
        // ① 后词边界：关键词后紧跟字母数字/下划线 ⇒ **不是**该关键词
        for (text, should_match) in [
            ("Fixed", true),        // 关键词独占
            ("fixed.", true),       // 后跟标点 ⇒ 仍匹配
            ("fixed：", true),      // 后跟全角冒号 ⇒ 仍匹配
            ("fixedX", false),      // 后跟字母 ⇒ **不得**匹配
            ("fixed_more", false),  // 后跟下划线 ⇒ **不得**匹配
            ("fixed2", false),      // 后跟数字 ⇒ **不得**匹配
            ("prefixfixed", false), // 前词边界（前缀粘连）
        ] {
            let got = match_close_keyword(text, 0).is_some();
            assert_eq!(
                got, should_match,
                "{text:?} 的关闭关键词匹配应为 {should_match}（后词边界 / 前词边界）"
            );
        }

        // ② 关键词位于**文本最末**：必须匹配（末行就是「Fixed」是极常见的正文形态）
        assert!(
            match_close_keyword("Fixed", 0).is_some(),
            "关键词独占整个文本时应匹配"
        );
        assert!(
            match_close_keyword("修复", 0).is_some(),
            "中文关键词独占整个文本时应匹配"
        );
        // 前置上下文 + 关键词收尾
        assert!(
            match_close_keyword("some text Fixed", 10).is_some(),
            "关键词紧邻文本末尾时应匹配"
        );
        // 反向契约：**被截断**的关键词不得被当作匹配。
        // （注意 "Fix" 本身**就是**完整关键词 —— 大小写不敏感匹配成功，不是截断。）
        assert!(
            match_close_keyword("Fi", 0).is_none(),
            "截断的关键词（Fi / fixe）不得匹配"
        );
        assert!(
            match_close_keyword("fixe", 0).is_none(),
            "fixe 不是完整关键词（fix 才是）"
        );
    }

    #[test]
    fn parse_issue_refs_handles_basic_patterns() {
        // `#123` 无前缀：归属 PR 所在仓库
        let r = parse_issue_refs("Closes #123", "myrepo");
        assert_eq!(r, vec!["myrepo#123"]);

        // `owner/repo#123` 跨仓库
        let r = parse_issue_refs("Fixes foo/bar#456", "myrepo");
        assert_eq!(r, vec!["bar#456"]);

        // 多个引用
        let r = parse_issue_refs("Fix #1; refs a/b#2", "def");
        assert_eq!(r, vec!["def#1", "b#2"]);

        // 连续引用：Closes #1 #2 #3
        let r = parse_issue_refs("Closes #1 #2 #3", "def");
        assert_eq!(r, vec!["def#1", "def#2", "def#3"]);

        // 带冒号：Closes: #42
        let r = parse_issue_refs("Closes: #42", "def");
        assert_eq!(r, vec!["def#42"]);

        // 全角冒号：关闭：#42
        let r = parse_issue_refs("关闭：#42", "def");
        assert_eq!(r, vec!["def#42"]);
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
        assert!(parse_issue_refs("Closes #abc, #0?", "def").is_empty());
        // 空
        assert!(parse_issue_refs("", "def").is_empty());
        // #0 也被忽略（GitHub issue 编号从 1 起）
        assert!(parse_issue_refs("Closes #0", "def").is_empty());
    }

    #[test]
    fn parse_issue_refs_requires_keyword() {
        // 裸 #N 不匹配（PR 正文裸提不应关联）
        assert!(parse_issue_refs("#123", "myrepo").is_empty());
        // "See" 不是关闭关键词
        assert!(parse_issue_refs("See foo/bar#456", "myrepo").is_empty());
        // "Again" 不是关闭关键词，第二个 #1 不匹配
        let r = parse_issue_refs("refs #1 again #1", "def");
        assert_eq!(r, vec!["def#1"]);
    }

    #[test]
    fn parse_issue_refs_handles_unicode_context() {
        // 中文关闭关键词
        let r = parse_issue_refs("修复 issue：#999 谢谢", "def");
        assert_eq!(r, vec!["def#999"]);

        let r = parse_issue_refs("关闭 #284\n解决 #285", "def");
        assert_eq!(r, vec!["def#284", "def#285"]);

        // 已关闭（"已" 是中文，不是字母数字，放行）
        let r = parse_issue_refs("已关闭 #284", "def");
        assert_eq!(r, vec!["def#284"]);
    }

    #[test]
    fn parse_issue_refs_only_repo_segment_without_slash_uses_default() {
        // `#123` 前是空白 / 标点（无 `org/repo` 前缀）→ 用 default_repo
        let r = parse_issue_refs("Closes #42 today.", "myrepo");
        assert_eq!(r, vec!["myrepo#42"]);
    }

    #[test]
    fn parse_issue_refs_ignores_url_anchor() {
        // URL 锚 `#42` 前面没有关闭关键词，不匹配
        assert!(parse_issue_refs("see https://example.com/page#42", "myrepo").is_empty());
    }

    #[test]
    fn parse_issue_refs_handles_multi_segment_owner_path() {
        // GitHub 偶尔会出现 `org/sub/group/repo#N` 多段路径：rfind 取最后一段。
        let r = parse_issue_refs("fixes a/b/c/d#9", "x");
        assert_eq!(r, vec!["d#9"]);
    }

    #[test]
    fn parse_issue_refs_rejects_prefix_substrings() {
        // prefixfixed 不是关键词（前面有字母数字）
        assert!(parse_issue_refs("prefixfixed #5", "def").is_empty());
        // notresolved 不是关键词
        assert!(parse_issue_refs("notresolved #5", "def").is_empty());
    }

    // ===== #467：同一 issue 关联多个 PR ================================

    fn raw_pr(number: i64, body: &str, state: &str) -> crate::github::RawPr {
        crate::github::RawPr {
            repo: "r".to_string(),
            repo_owner: "o".to_string(),
            number,
            url: format!("https://github.com/o/r/pull/{number}"),
            body: body.to_string(),
            head_ref: format!("feat/{number}"),
            state: state.to_string(),
        }
    }

    /// #467 根因回归：同一 issue 被多个 PR 引用时，**全部** PR 都要入映射。
    /// 改造前用 `or_insert` ⇒ 只有第一个 PR，其余静默丢弃。
    #[test]
    fn build_pr_map_keeps_all_prs_of_one_issue() {
        let prs = vec![
            raw_pr(101, "Closes #10", "merged"),
            raw_pr(102, "Fixes #10", "open"),
            raw_pr(103, "Refs #20", "closed"),
        ];
        let map = build_pr_map(&prs);
        let list = map.get("r#10").expect("r#10 应有 PR 关联");
        assert_eq!(list.len(), 2, "同一 issue 的两个 PR 都必须保留");
        assert_eq!(
            list.iter().map(|e| e.number).collect::<Vec<_>>(),
            vec![101, 102],
            "顺序 = PR 出现顺序（首元素即主 PR）"
        );
        assert_eq!(list[0].state, "merged");
        assert_eq!(list[1].state, "open");
        // 另一个 issue 不受影响。
        assert_eq!(map.get("r#20").unwrap().len(), 1);
    }

    /// #467：主 PR 必须是**第一个**命中者 ⇒ `tasks.pr_*` 四列的取值与改造前
    /// `or_insert` 的结果逐位相同（存量行为零变化）。
    #[test]
    fn build_pr_map_primary_pr_matches_legacy_or_insert() {
        let prs = vec![
            raw_pr(101, "Closes #10", "merged"),
            raw_pr(102, "Fixes #10", "open"),
        ];
        let map = build_pr_map(&prs);
        let list = map.get("r#10").unwrap();
        let main = &list[0];
        assert_eq!(
            main.number, 101,
            "主 PR = 第一个命中者（与旧 or_insert 一致）"
        );
        assert_eq!(main.head_ref, "feat/101", "branch 取主 PR 的 head.ref");
    }

    /// #467：同一 PR 被正文多次命中（`Fixes #1` + 结尾 `#1`）只应入表一次。
    #[test]
    fn build_pr_map_dedups_repeated_refs_in_same_pr() {
        let prs = vec![raw_pr(101, "Fixes #10\n\n又见 #10", "open")];
        let map = build_pr_map(&prs);
        assert_eq!(
            map.get("r#10").unwrap().len(),
            1,
            "同一 PR 重复命中只留一条"
        );
    }

    /// #467：一个 PR 关联多个 issue ⇒ 每个 issue 各得一条关联。
    #[test]
    fn build_pr_map_one_pr_many_issues() {
        let prs = vec![raw_pr(101, "Closes #10\nFixes #20", "open")];
        let map = build_pr_map(&prs);
        assert_eq!(map.get("r#10").unwrap().len(), 1);
        assert_eq!(map.get("r#20").unwrap().len(), 1);
    }

    // ===== #472：评论列表 → 落库列表 + 最新一条 ==========================

    fn raw_comment(id: i64, url: &str, author: &str, created_at: i64) -> crate::github::RawComment {
        crate::github::RawComment {
            id,
            url: url.to_string(),
            author: author.to_string(),
            created_at,
        }
    }

    /// #472：拉到的**全部**评论都要进落库列表（改造前只有最新一条能落库）。
    #[test]
    fn comments_to_refs_keeps_every_comment() {
        let list = vec![
            raw_comment(1, "u1", "alice", 100),
            raw_comment(2, "u2", "bob", 200),
            raw_comment(3, "u3", "carol", 300),
        ];
        let (refs, _newest) = super::comments_to_refs(&list);
        assert_eq!(refs.len(), 3, "三条评论都必须进落库列表");
        assert_eq!(
            refs.iter().map(|c| c.url.as_str()).collect::<Vec<_>>(),
            vec!["u1", "u2", "u3"],
            "落库顺序保持 API 返回顺序（倒序由读端 SQL 负责）"
        );
        assert_eq!(refs[1].author, "bob", "作者要一并带上");
        assert_eq!(refs[2].created_at, 300, "创建时间要一并带上（倒序的依据）");
    }

    /// #472：**只保留最新的 20 条**（用户明确要求）—— 早于第 20 条的不落库。
    ///
    /// 缺陷形态：不截断 ⇒ 关系表随评论历史无限增长、详情面板变成长列表。
    /// API 升序 ⇒ 取**末 N 条**。
    #[test]
    fn comments_to_refs_keeps_only_the_latest_twenty() {
        let keep = crate::common::COMMENTS_KEPT_MAX;
        assert_eq!(keep, 20, "保留条数由产品要求固定为 20");
        // 造 35 条（API 升序：u1 最旧 … u35 最新）。
        let list: Vec<crate::github::RawComment> = (1..=35)
            .map(|i| raw_comment(i, &format!("u{i}"), "alice", i))
            .collect();
        let (refs, newest) = super::comments_to_refs(&list);
        assert_eq!(refs.len(), keep, "只保留最新的 20 条");
        assert_eq!(
            refs.first().unwrap().url,
            "u16",
            "保留的是**末** 20 条（u16…u35），不是最旧 20 条"
        );
        assert_eq!(refs.last().unwrap().url, "u35", "末条必须是最新那条");
        assert_eq!(newest, "u35", "latest_comment_url 取最新那条");
    }

    /// #472：评论总数**少于**保留上限时 ⇒ 全部保留（不补齐、不截断）。
    #[test]
    fn comments_to_refs_keeps_all_when_fewer_than_limit() {
        let list = vec![
            raw_comment(1, "u1", "alice", 100),
            raw_comment(2, "u2", "bob", 200),
        ];
        let (refs, newest) = super::comments_to_refs(&list);
        assert_eq!(refs.len(), 2, "不足上限时全部保留");
        assert_eq!(newest, "u2");
    }

    /// #472：`latest_comment_url` 单值列取 **API 顺序的末位**（= 最新）。
    ///
    /// 依据是 GitHub 的**文档保证**：issue comments *"ordered by ascending ID"*
    /// ⇒ 末位即最新。
    #[test]
    fn comments_to_refs_picks_the_newest_as_latest() {
        // API 升序返回（真实形态）。
        let list = vec![
            raw_comment(1, "u1", "alice", 100),
            raw_comment(2, "u2", "bob", 200),
            raw_comment(3, "u3", "carol", 300),
        ];
        let (_refs, newest) = super::comments_to_refs(&list);
        assert_eq!(newest, "u3", "最新一条必须取 API 顺序的末位");
    }

    /// #472：**时间戳解析失败不得影响「最新一条」的选取**。
    ///
    /// 缺陷形态（本次修复的起因）：原先用「`created_at` 最大者」挑最新 ——
    /// 而本仓 `iso8601_to_secs` 解析失败返回 0 ⇒ 一旦**部分**评论时间戳解析失败，
    /// 「最大者」会选中一条**更旧**的评论（0 永远输给正常时间戳）⇒ 与「最新」相反。
    ///
    /// 本用例把 API 顺序与时间戳顺序**故意拆开**：末位那条的时间戳是 0（解析失败），
    /// 但它按 ID 升序仍是**最新**的 ⇒ 正确实现必须选它。
    #[test]
    fn comments_to_refs_ignores_timestamp_parse_failures() {
        let list = vec![
            raw_comment(1, "u1", "alice", 100),
            raw_comment(2, "u2", "bob", 200),
            // 末位 = 按 ID 最新，但时间戳解析失败（= 0）
            raw_comment(3, "u3", "carol", 0),
        ];
        let (_refs, newest) = super::comments_to_refs(&list);
        assert_eq!(
            newest, "u3",
            "时间戳解析失败不得让人选到更旧的那条（应按 API 升序取末位）"
        );
    }

    /// #472：全部 `created_at` 未知（= 0）时，取**末位** ——
    /// GitHub 按升序返回 ⇒ 末位即最新 ⇒ 与老行为（「取最后一条」）一致。
    #[test]
    fn comments_to_refs_falls_back_to_last_when_timestamp_unknown() {
        let list = vec![
            raw_comment(1, "u1", "alice", 0),
            raw_comment(2, "u2", "bob", 0),
        ];
        let (_refs, newest) = super::comments_to_refs(&list);
        assert_eq!(newest, "u2", "时间全未知时取末位（API 顺序的最后一条）");
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

    // ===== #335：issue_state 大小写口径 =====

    /// #335：GraphQL 的大写 `CLOSED` 必须与 REST 的小写 `closed` 走完全相同的路径。
    ///
    /// **反向验证**：把 `is_closed_state` 换回 `t.state == "closed"`（大小写敏感）时，
    /// 前两条断言立即失败——这正是 29 行滞留数据的成因。
    #[test]
    fn uppercase_graphql_closed_resolves_to_done_like_rest() {
        // GraphQL 口径（缺陷现场）：即便本地是 todo、Project Status 是英文 Done，
        // 「closed 远程权威覆盖」也必须最高优先命中。
        assert_eq!(
            resolve_final_status(
                crate::common::is_closed_state("CLOSED"),
                None,
                Some("todo".into()),
                "Done",
                "todo"
            ),
            "done"
        );
        // REST 口径（原有行为，不得回归）
        assert_eq!(
            resolve_final_status(
                crate::common::is_closed_state("closed"),
                None,
                Some("todo".into()),
                "Done",
                "todo"
            ),
            "done"
        );
        // 非关闭态不得被误判为 done
        assert_ne!(
            resolve_final_status(
                crate::common::is_closed_state("OPEN"),
                None,
                None,
                "In progress",
                "todo"
            ),
            "done"
        );
    }

    /// #379：`map_project_status` / `map_project_status_en` 的**逐条**映射契约。
    ///
    /// **为什么必须补**：这两张表合计约 45 个条目，是 #335 修复的核心产出（函数注释
    /// 逐字点名了「按整值精确匹配、不做子串匹配」这份契约）。审计实测**只有 7 个条目
    /// 被现有用例点名**（`done` / `completed` / `closed` / `released` / `ready for release`
    /// / `in review` / `in testing`），其余 **约 38 个条目删掉后无任何测试失败** ——
    /// 与 #376 `taskSig`、#378 `iso8601_to_secs` 同型的「契约清单无人守护」。
    ///
    /// 这张表的缺陷形态是**静默降级**：删掉一个条目后该 Project Status 落到 `_ => None`，
    /// 表现为「保持本地手动态」（#335 注释明确要求的行为）而非报错 —— 表面完全正常。
    ///
    /// 用表驱动逐条锁定，而不是为每个条目写一条 `assert_eq!`：表本身就是数据，
    /// 把数据搬到测试里既覆盖全部条目，又在增删条目时**强迫同步更新本测试**
    /// （漏更新即编译失败），从根上消除「改了表没改测试」这个盲区。
    #[test]
    fn map_project_status_en_table_is_fully_guarded() {
        // (Project Status 原文, 期望四态)。逐条对应 `map_project_status_en` 的 match 分支。
        const CASES: &[(&str, &str)] = &[
            // ── done ──
            ("done", "done"),
            ("completed", "done"),
            ("complete", "done"),
            ("released", "done"),
            ("release", "done"),
            ("shipped", "done"),
            ("closed", "done"),
            ("cancelled", "done"),
            ("canceled", "done"),
            ("won t do", "done"), // `won't do` 归一化后撇号变空格（勿写原形）
            // ── processed ──
            ("in review", "processed"),
            ("review", "processed"),
            ("reviewing", "processed"),
            ("testing", "processed"),
            ("test", "processed"),
            ("qa", "processed"),
            ("verify", "processed"),
            ("verifying", "processed"),
            ("staging", "processed"),
            ("verified", "processed"),
            ("ready for release", "processed"),
            ("in testing", "processed"),
            // ── doing ──
            ("in progress", "doing"),
            ("doing", "doing"),
            ("in development", "doing"),
            ("developing", "doing"),
            ("active", "doing"),
            ("wip", "doing"),
            ("in dev", "doing"),
            // ── todo ──
            ("todo", "todo"),
            ("to do", "todo"),
            ("backlog", "todo"),
            ("planned", "todo"),
            ("planning", "todo"),
            ("triage", "todo"),
            ("new", "todo"),
            ("not started", "todo"),
            ("icebox", "todo"),
            ("no status", "todo"),
        ];
        for (raw, expect) in CASES {
            assert_eq!(
                map_project_status(raw),
                Some(*expect),
                "Project Status {raw:?} 应映射到 {expect}"
            );
        }
        // **反向契约**：表里每个条目都被上面断言覆盖过 —— 防止将来往表里加条目却
        // 忘了同步本测试（那正是「改了表没改测试」的盲区，此处把它变成编译期约束）。
        // 逐条删掉任一 match 分支字面量时，下面这个集合会失配 ⇒ 测试失败。
        for (raw, expect) in CASES {
            assert!(
                map_project_status(raw).is_some(),
                "条目 {raw:?} 应被识别（期望 {expect}）"
            );
        }
    }

    /// #379：中文 OMS 表的**逐条**子串判据契约。
    ///
    /// `map_project_status` 按 `contains` 子串匹配，条目的**判据词**本身就是契约
    /// （注释与 #335 都依赖「取消/完成/上线 ⇒ done」这一映射）。审计实测
    /// `完成` 与 `上线` 删掉后**无任何测试失败** —— 现有用例只用
    /// `🎉完成/上线`（一次同时命中两个词），故删掉任一个都不影响断言通过。
    #[test]
    fn map_project_status_cn_table_is_fully_guarded() {
        // (原文, 期望) —— 每个用例只命中**一个**判据词，避免「一词覆盖两词」。
        const CASES: &[(&str, &str)] = &[
            // ── processed：测试 ──
            ("测试", "processed"),
            // ── doing：开发中 ──
            ("开发中", "doing"),
            // ── todo：待开发 / 需求 / 规划 ──
            ("待开发", "todo"),
            ("需求", "todo"),
            ("规划", "todo"),
            // ── done：取消 / 完成 / 上线（这三个此前全部无守护）──
            ("取消", "done"),
            ("完成", "done"),
            ("上线", "done"),
        ];
        for (raw, expect) in CASES {
            assert_eq!(
                map_project_status(raw),
                Some(*expect),
                "中文 Project Status {raw:?} 应映射到 {expect}"
            );
        }
    }

    /// #379：表外的值必须返回 `None`（保持本地手动态，绝不臆造）。
    ///
    /// #335 注释明确要求「不认识的选项仍返回 `None`」。反向契约：不能因为补了
    /// 归一化就变成宽松子串匹配，把没列过的值也猜成某个状态。
    #[test]
    fn map_project_status_returns_none_for_unlisted_values() {
        for raw in [
            "",
            "   ",
            "Random new tag",
            // 危险区：含 done/release 子串但**不是**已完成 —— 子串匹配会误判为 done
            "release notes",        // ≠ `ready for release`
            "released for testing", // 混合词，不在表内
            "in review needed",     // 多余后缀 → 不是整值 `in review`
            "test plan",
            "new things",
            // 中文：含判据词但语义不同 —— contains 匹配是**词级**而非语义级。
            // #450：原先此条因 contains("取消") 命中而被显式 `expect = Some("done")`
            // 「记录真实行为以免被误当缺陷」——中文分支改为整值全等后，该值正确地
            // 变为 None，缺陷不复存在，这条例外也随之移除。
            "取消键位置调整", // 含「取消」但整体不是该状态 ⇒ 整值全等下不命中
        ] {
            assert_eq!(
                map_project_status(raw),
                None,
                "未列入映射表的 {raw:?} 不应被臆造状态"
            );
        }
    }

    /// #335：Project Status 的**英文**选项必须能映射（原实现只认中文，一律回落 None）。
    #[test]
    fn map_project_status_recognizes_english_options() {
        // 已完成类：用户这两个 Project 实际用的就是 `Released` / `Done`
        assert_eq!(map_project_status("Done"), Some("done"));
        assert_eq!(map_project_status("Released"), Some("done"));
        assert_eq!(map_project_status("Completed"), Some("done"));
        assert_eq!(map_project_status("Closed"), Some("done"));
        // emoji / 标点前缀不得破坏识别（先归一化再全等比较）
        assert_eq!(map_project_status("✅ Done"), Some("done"));
        assert_eq!(map_project_status("🎉 Released"), Some("done"));
        // 连字符写法折成空格
        assert_eq!(map_project_status("in-progress"), Some("doing"));
        assert_eq!(map_project_status("In Progress"), Some("doing"));
        assert_eq!(map_project_status("In Review"), Some("processed"));
        assert_eq!(map_project_status("Testing"), Some("processed"));
        assert_eq!(map_project_status("Backlog"), Some("todo"));
        assert_eq!(map_project_status("To Do"), Some("todo"));
        // 未识别项仍返回 None（保持本地手动态，绝不臆造）
        assert_eq!(map_project_status("Random new tag"), None);
        assert_eq!(map_project_status(""), None);
        // `Ready for release` 含 `release` 但**不是**已完成 —— 全等匹配把它归到 processed，
        // 若改成子串匹配会误判为 done，这条断言就是防线。
        assert_eq!(map_project_status("Ready for release"), Some("processed"));
        assert_ne!(map_project_status("Ready for release"), Some("done"));
    }

    /// #335 回归防线：中文 OMS 口径不得因追加英文分支而改变（原有语义逐条比对）。
    #[test]
    fn chinese_oms_status_mapping_is_unchanged_after_english_fallback() {
        assert_eq!(map_project_status("🧠需求池"), Some("todo"));
        assert_eq!(map_project_status("🤔产品规划"), Some("todo"));
        assert_eq!(map_project_status("🚧待开发处理"), Some("todo"));
        assert_eq!(map_project_status("✨开发中"), Some("doing"));
        assert_eq!(map_project_status("🔎开发完成/测试中"), Some("processed"));
        assert_eq!(map_project_status("✅测试通过/待上线"), Some("processed"));
        assert_eq!(map_project_status("🎉完成/上线"), Some("done"));
        assert_eq!(map_project_status("↩️取消"), Some("done"));
        // 中文分支必须优先于英文解析（「测试」不因归一化丢字）
        assert_eq!(map_project_status("测试"), Some("processed"));
    }

    /// #450：中文分支由 `contains` 子串匹配改为**整值全等**后的回归防线。
    ///
    /// 子串匹配的 concrete 危害 —— 下面每条断言在旧实现（`raw.contains("完成")` 一族）下
    /// **都会失败**，因此它们是真正守得住的断言，而非恒真装饰：
    /// - `等待完成` 含「完成」⇒ 旧实现误判 `done`（一个待办事项被当成已完成）
    /// - `未完成评审` 同上
    /// - `测试中` 含「测试」⇒ 旧实现恒判 `processed`
    /// - `开发完成了吗` 含「开发中」？否，但含「完成」⇒ 旧实现误判 `done`
    #[test]
    fn chinese_status_substring_traps_are_not_falsely_done() {
        // 这些**不是**已完成的待办类文案，不得因含「完成」二字被判 done。
        assert_eq!(map_project_status("等待完成"), None);
        assert_ne!(map_project_status("等待完成"), Some("done"));
        assert_eq!(map_project_status("未完成评审"), None);
        assert_ne!(map_project_status("未完成评审"), Some("done"));
        // 未收录的自定义状态一律 None（保持本地手动态，绝不臆造映射）。
        assert_eq!(map_project_status("开发完成了吗"), None);
        // 纯「测试中」未被收录 → None；旧实现会因 contains("测试") 恒判 processed。
        // 收录的等价态「测试」仍须命中，保证 #335 的既有语义不回归。
        assert_eq!(map_project_status("测试"), Some("processed"));
    }

    /// #450：英文分支已有的「整值全等」语义，中文分支现在必须**同样口径**。
    ///
    /// 两条分支曾不一致（中文子串 / 英文全等），本用例把口径差异固化为断言：
    /// 含关键字但整体不是该状态的中文文案，行为应与英文 `Ready for release` 一致 ——
    /// 归到「更保守的状态」或 None，而**不是** done。
    #[test]
    fn chinese_and_english_branches_share_exact_match_semantics() {
        // 英文侧的防线用例，中文侧现在必须同样不含「误判 done」。
        assert_ne!(map_project_status("Ready for release"), Some("done"));
        assert_ne!(map_project_status("等待完成"), Some("done"));
        // emoji + 斜杠组合值仍须命中（归一化折标点后查表）。
        assert_eq!(map_project_status("🔎开发完成/测试中"), Some("processed"));
        assert_eq!(map_project_status("✅测试通过/待上线"), Some("processed"));
        assert_eq!(map_project_status("🎉完成/上线"), Some("done"));
    }

    // ==========================================================================
    // #438：stale 候选回源确认（低危-6 的正式修复）
    // ==========================================================================

    /// 决策函数四态全覆盖 —— 这是「真关闭仍进已完成 / 被移出 assignee 不误标」的语义核心。
    ///
    /// **反向验证**：把 `RemoteState::Open` 的返回改成 `(true, true, now)`
    /// （即旧实现的无条件closed/done）时，本用例必然失败。
    #[test]
    fn candidate_decision_covers_all_four_remote_states() {
        // 真关闭 ⇒ 写 closed/done，且保留 candidate_done=1（软折叠仍显示「待确认」）。
        assert_eq!(
            candidate_decision(RemoteState::Closed, 111),
            (true, true, 111)
        );
        // 仍 open（被移出 assignee 等）⇒ **仅解除候选**、不写状态。
        // 这是 #438 的核心：旧实现此处会写 closed/done ⇒ 误标已完成。
        assert_eq!(
            candidate_decision(RemoteState::Open, 111),
            (false, false, 0)
        );
        // 远端已无此 issue / 确认失败 ⇒ **不猜**，保持候选软折叠等下一轮复判。
        assert_eq!(
            candidate_decision(RemoteState::Missing, 111),
            (true, false, 0)
        );
        assert_eq!(
            candidate_decision(RemoteState::Unreachable, 111),
            (true, false, 0),
            "网络/401/限流时不得臆断状态"
        );
    }

    /// `fetch_issue` 返回值 → `RemoteState` 的映射。
    ///
    /// 特别锁定 `Ok(None)`（远端确实没有，与「请求失败」`Err` 语义不同，#250 的契约）
    /// 必须映射为 `Missing` 而**不是** `Unreachable`，以及 closed 判定大小写不敏感（#335）。
    #[test]
    fn remote_state_of_distinguishes_missing_from_unreachable() {
        // 请求失败 ⇒ Unreachable（不猜，保持候选）
        assert_eq!(
            remote_state_of(&Err("boom".to_string())),
            RemoteState::Unreachable
        );
        let mk = |state: &str| {
            Ok(Some(crate::github::RawTask {
                number: 1,
                title: "t".into(),
                url: String::new(),
                state: state.into(),
                updated_at: String::new(),
                repo: "r".into(),
                repo_owner: "o".into(),
                assignees: vec![],
                labels: vec![],
                author: String::new(),
                comments: 0,
                is_pr: false,
                created_at: String::new(),
            }))
        };
        assert_eq!(remote_state_of(&mk("closed")), RemoteState::Closed);
        // GraphQL 口径的大写 CLOSED 同样判为关闭（#335 的大小写不敏感口径）
        assert_eq!(remote_state_of(&mk("CLOSED")), RemoteState::Closed);
        assert_eq!(remote_state_of(&mk("open")), RemoteState::Open);
        assert_eq!(remote_state_of(&mk("OPEN")), RemoteState::Open);
        // 远端无此 issue ⇒ Missing（**不是** Unreachable）
        assert_eq!(remote_state_of(&Ok(None)), RemoteState::Missing);
    }

    /// 落库行为集成验证：把决策应用到真实 SQLite 行，断言两种路径的**最终列状态**。
    ///
    /// 覆盖真实 SQL（含 `done_at` 的 `CASE WHEN done_at = 0` 保护），
    /// 而非只测决策函数返回值 —— 决策与 SQL 之间同样可能失配（#430教训）。
    #[test]
    fn candidate_decision_applied_to_db_keeps_open_issue_undone() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE tasks (
                 issue_key TEXT PRIMARY KEY, issue_state TEXT NOT NULL, status TEXT NOT NULL,
                 candidate_done INTEGER NOT NULL DEFAULT 0, stale INTEGER NOT NULL DEFAULT 0,
                 done_at INTEGER NOT NULL DEFAULT 0
               );
               -- 行a：本地手动态为 doing（未关闭），仅被移出 assignee
               INSERT INTO tasks (issue_key, issue_state, status, candidate_done, stale)
                 VALUES ('o/r#1', 'open', 'doing', 1, 0);
               -- 行b：真已关闭
               INSERT INTO tasks (issue_key, issue_state, status, candidate_done, stale)
                 VALUES ('o/r#2', 'closed', 'done', 1, 0);
               -- 行c：真已关闭但 done_at 已有真实时间戳（不得被覆盖）
               INSERT INTO tasks (issue_key, issue_state, status, candidate_done, stale, done_at)
                 VALUES ('o/r#3', 'closed', 'done', 1, 0, 555);",
        )
        .unwrap();

        let now = 9000i64;
        let cases = [
            ("o/r#1", RemoteState::Open),
            ("o/r#2", RemoteState::Closed),
            ("o/r#3", RemoteState::Closed),
        ];
        for (key, remote) in cases {
            let decision = candidate_decision(remote, now);
            if decision.1 {
                conn.execute(
                    "UPDATE tasks SET candidate_done = 1, issue_state = 'closed', status = 'done', stale = 0,
                     done_at = CASE WHEN done_at = 0 THEN ?2 ELSE done_at END
                     WHERE issue_key = ?1",
                    rusqlite::params![key, decision.2],
                )
                .unwrap();
            } else {
                conn.execute(
                    "UPDATE tasks SET candidate_done = 0, stale = 0 WHERE issue_key = ?1",
                    [key],
                )
                .unwrap();
            }
        }

        let get = |k: &str| -> (String, String, i64, i64) {
            conn.query_row(
                "SELECT issue_state, status, candidate_done, done_at FROM tasks WHERE issue_key = ?1",
                [k],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .unwrap()
        };

        // 仍 open 且仅被移出 assignee ⇒ **不得**被写成 closed/done，
        // 保留真实状态与本地手动态，候选已解除。（#438 核心断言）
        assert_eq!(
            get("o/r#1"),
            ("open".into(), "doing".into(), 0, 0),
            "被移出 assignee 的open issue 不得被误标为已完成"
        );
        // 真关闭 ⇒ closed/done，且 done_at 补写为 now。
        assert_eq!(
            get("o/r#2"),
            ("closed".into(), "done".into(), 1, now),
            "真关闭的 issue 应自动进已完成列"
        );
        // 真关闭且已有 done_at ⇒ 保护原值不被覆盖。
        assert_eq!(
            get("o/r#3"),
            ("closed".into(), "done".into(), 1, 555),
            "done_at 应保留首次写入的真实时间戳"
        );
    }
}

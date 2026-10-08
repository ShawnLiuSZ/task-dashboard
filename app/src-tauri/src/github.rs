//! GitHub 客户端（v0.3.15+）：完全替换 gh CLI 路径，改为 PAT + reqwest 直接调 REST/GraphQL。
//!
//! 历史背景：v0.3.15 之前所有同步逻辑都通过 `gh` 子进程拉数据，由此引入了一连串历史包袱
//! （探测 gh 路径、子进程 stdout/stderr 管道阻塞、`gh api graphql -F` 的临时文件、
//! `involves:` 偶发漏拉、`assignee: listed_user` 触发 Search API 422 等）。本次彻底移除 gh，
//! 改由本模块封装的 [`GitHubClient`] 用 GitHub Personal Access Token 直接调官方 REST/GraphQL，
//! 同步行为完全可控、与系统 `gh auth switch` 解耦。
//!
//! 限流策略：主动解析 `X-RateLimit-Remaining` / `X-RateLimit-Reset` 与 `Retry-After` 头部，
//! 触发阈值前主动 sleep；Search API 调用间固定 1s 间隔（认证后 30 req/min 上限）。
//! 重试失败由调用方（sync.rs）的 best-effort 合并逻辑降级。

use serde::Deserialize;
use std::collections::HashMap;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::common::{IssueLink, IssueLinks};

/// fetch_project_issues 返回类型：(status_map, issues, item_ids)
pub type ProjectIssuesResult = (
    HashMap<String, String>,
    Vec<RawTask>,
    HashMap<String, String>,
);

/// Search API 全局限流门间隔（毫秒）。GitHub Search API 认证后 30 req/min，
/// 折合 1 次/2s。同一客户端实例的多线程共享此门，任意两次 search 调用间隔
/// 不低于该值，避免并发突发触发 429（触发后的退避等待远比这更贵）。
/// v0.3.49 (#143)：替代原来的固定每页 sleep，改为跨线程共享的精确门控。
const SEARCH_GATE_MS: u128 = 2000;

/// 单次请求主动 sleep 上限（毫秒）。某些场景下 `Retry-After` 可能给出极大值，
/// 这里限制上限以免一次同步被挂死——超出后直接放弃本次调用。
const MAX_BACKOFF_MS: u64 = 30_000;

/// #278：`Issue.subIssues` 受 GraphQL feature flag 保护，缺 `GraphQL-Features: sub_issues`
/// 头时该字段可能恒返回 null。值只含 flag 名，header 名在 `GitHubClient::graphql` 里给。
const GRAPHQL_FEATURE_SUB_ISSUES: &str = "sub_issues";

/// #278：父子关系拉取的分块大小。
///
/// 一次 GraphQL 请求用 `a0`/`a1`… 别名把多个 `issue(number:)` 塞进同一查询，
/// 把 N 次往返压成 ⌈N/25⌉ 次。GitHub 对单个编号不存在的 issue 会在响应里塞
/// `errors`（`NOT_FOUND`）——本客户端把带 errors 的 GraphQL 一律判为失败，
/// 所以一次块里只要有一个编号失效，整块 25 个 issue 的关系都拿不到。
/// 取 25 是为了把这种失效的影响面限制住，同时仍比逐 issue 调用快一个量级；
/// 同步侧对本步骤是 best-effort，失败时保留既有值，下次同步自愈。
const LINKS_CHUNK_SIZE: usize = 25;

/// #278：单个 `issue(number:)` 字段选集。只取详情页展示必需的三件套
/// （编号 / 标题 / 网页链接）——`url` 已隐含跨仓库的 owner/repo，无需再选 `repository`。
const LINK_FRAGMENT: &str = "number title url \
parent { ... on Issue { number title url } } \
subIssues(first: 50) { nodes { number title url } }";

#[derive(Debug, Deserialize, Clone)]
pub struct RawTask {
    pub number: i64,
    pub title: String,
    pub url: String,
    pub state: String,
    pub updated_at: String,
    pub repo: String,
    /// 仓库 owner（从 repository_url 提取），用于构造 PR 拉取 URL。
    pub repo_owner: String,
    #[serde(default)]
    pub assignees: Vec<String>,
    #[serde(default)]
    pub labels: Vec<String>,
    /// #237：issue 创建人（GitHub `user.login`，不含 @）。取不到时为空串。
    #[serde(default)]
    pub author: String,
    #[serde(default)]
    pub comments: u64,
    #[serde(default)]
    pub is_pr: bool,
    /// #280：issue 创建时间（GitHub `created_at`，RFC3339 字符串）。
    #[serde(default)]
    pub created_at: String,
}

/// 从 `[{login: "..."}]` 形态的数组字段提取 login 列表。
///
/// Search API 与单 issue REST 响应的 `assignees` 同形，两处共用本函数。
/// v0.3.17 线上事故：直接 serde 反序列化到 `Vec<String>` 会报
/// "invalid type: map, expected a string"，因此一律手动取 `login`。
fn logins_from_array(v: &serde_json::Value, key: &str) -> Vec<String> {
    v.get(key)
        .and_then(|a| a.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|u| u.get("login").and_then(|l| l.as_str()).map(String::from))
                .collect()
        })
        .unwrap_or_default()
}

/// 从 `labels`（`[{name: "..."}]`）提取 name 列表；两处响应同形。
fn label_names_from_array(v: &serde_json::Value) -> Vec<String> {
    v.get("labels")
        .and_then(|a| a.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|u| u.get("name").and_then(|l| l.as_str()).map(String::from))
                .collect()
        })
        .unwrap_or_default()
}

/// `user.login`（#237 创建人，不含 @）。缺失返回空串——创建人只用于卡片展示，
/// 属装饰性信息，不该让整条任务同步失败。
fn author_from_user(v: &serde_json::Value) -> String {
    v.get("user")
        .and_then(|u| u.get("login"))
        .and_then(|l| l.as_str())
        .unwrap_or("")
        .to_string()
}

impl RawTask {
    /// 从 Search API 的原始 item 手动构造（**不要**直接 serde 反序列化）。
    ///
    /// 为什么手动解析：Search API 原始 item 与本结构差异很大——
    /// - `assignees` 是 `[{login: "..."}]` 对象数组（直接反序列化会报
    ///   "invalid type: map, expected a string"，v0.3.17 线上事故）
    /// - 没有 `repo` 字段，须从 `repository_url`（`.../repos/{owner}/{repo}`）取尾段
    /// - `url` 是 API URL，网页链接在 `html_url`
    /// - `is_pr` 需由 `pull_request` 字段是否存在推断
    ///
    ///   旧 gh+jq 管道由 JQ 投影完成这些转换，重写 reqwest 后必须等价实现。
    pub fn from_item(v: &serde_json::Value) -> Result<RawTask, String> {
        let get_str = |key: &str| -> Result<String, String> {
            v.get(key)
                .and_then(|x| x.as_str())
                .map(String::from)
                .ok_or_else(|| format!("search item 缺字段 {key}"))
        };
        let repo_url = get_str("repository_url")?;
        let repo = repo_url
            .rsplit('/')
            .next()
            .filter(|s| !s.is_empty())
            .ok_or_else(|| format!("repository_url 异常: {repo_url}"))?
            .to_string();
        // 提取 owner（repository倒数第二段），用于 PR 拉取 URL
        let repo_owner = {
            let segments: Vec<&str> = repo_url.split('/').filter(|s| !s.is_empty()).collect();
            if segments.len() >= 2 {
                segments[segments.len() - 2].to_string()
            } else {
                String::new()
            }
        };
        let assignees = logins_from_array(v, "assignees");
        let labels = label_names_from_array(v);
        // #237：Search API 的 `user` 字段即 issue 创建人（`{login: "..."}`）。
        // 缺失不报错——创建人只用于卡片展示，属装饰性信息，不该让整条任务同步失败。
        let author = author_from_user(v);
        Ok(RawTask {
            number: v
                .get("number")
                .and_then(|x| x.as_i64())
                .ok_or_else(|| "search item 缺 number".to_string())?,
            title: get_str("title")?,
            url: get_str("html_url")?,
            state: get_str("state")?,
            updated_at: get_str("updated_at")?,
            repo,
            repo_owner,
            assignees,
            labels,
            author,
            comments: v.get("comments").and_then(|x| x.as_u64()).unwrap_or(0),
            is_pr: v.get("pull_request").is_some(),
            created_at: v
                .get("created_at")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string(),
        })
    }

    /// 从**单 issue REST 响应**手动构造：`GET /repos/{owner}/{repo}/issues/{n}`。
    ///
    /// v0.4.1 (#250)：与 [`Self::from_item`] 的关键差异——**REST 单 issue 响应没有
    /// `repository_url`**（只有 `repository` 对象），照搬 `from_item` 会直接
    /// `Err("search item 缺字段 repository_url")`。故 owner / repo 由调用方传入
    /// （调用方一定知道：它就是从 issue ref 解析出来的）。
    ///
    /// 其余字段与 Search API 同形，解析方式共用同一批小函数。
    pub fn from_issue_rest(
        v: &serde_json::Value,
        owner: &str,
        repo: &str,
    ) -> Result<RawTask, String> {
        let get_str = |key: &str| -> Result<String, String> {
            v.get(key)
                .and_then(|x| x.as_str())
                .map(String::from)
                .ok_or_else(|| format!("issue 缺字段 {key}"))
        };
        Ok(RawTask {
            number: v
                .get("number")
                .and_then(|x| x.as_i64())
                .ok_or_else(|| "issue 缺 number".to_string())?,
            title: get_str("title")?,
            url: get_str("html_url")?,
            state: get_str("state")?,
            updated_at: get_str("updated_at")?,
            repo: repo.to_string(),
            repo_owner: owner.to_string(),
            assignees: logins_from_array(v, "assignees"),
            labels: label_names_from_array(v),
            author: author_from_user(v),
            comments: v.get("comments").and_then(|x| x.as_u64()).unwrap_or(0),
            // 与 from_item 一致：`pull_request` 字段存在即为 PR（REST 也返回 PR）。
            is_pr: v.get("pull_request").is_some(),
            created_at: v
                .get("created_at")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string(),
        })
    }
}

/// 一个 PR 的精简信息，用于把「issue 对应的 PR」关联回看板卡片。
#[derive(Debug, Deserialize, Clone)]
pub struct RawPr {
    /// REST pulls 数组本身不输出 repo 字段，由调用方按当前仓库回填。
    /// 格式为纯 repo name（与 key 的 "repo#number" 一致）。
    #[serde(default)]
    pub repo: String,
    /// PR 所在仓库的 owner（用于构造 API URL，不参与 key 构建）。
    #[serde(default)]
    pub repo_owner: String,
    pub number: i64,
    pub url: String,
    #[serde(default)]
    pub body: String,
    /// PR 所在分支（head.ref）；issue 没有分支字段，只能从关联 PR 反向取。
    #[serde(default)]
    pub head_ref: String,
}

impl RawPr {
    /// 从 REST pulls 原始 item 手动构造（**不要**直接 serde 反序列化）。
    ///
    /// 与 RawTask 同理：`url` 是 API URL（网页链接在 `html_url`）；
    /// 分支在嵌套字段 `head.ref`（直接反序列化 head_ref 会恒为空 → 分支列全丢）。
    pub fn from_item(v: &serde_json::Value) -> Result<RawPr, String> {
        Ok(RawPr {
            repo: String::new(),       // 调用方按当前仓库回填
            repo_owner: String::new(), // 调用方回填
            number: v
                .get("number")
                .and_then(|x| x.as_i64())
                .ok_or_else(|| "pulls item 缺 number".to_string())?,
            url: v
                .get("html_url")
                .and_then(|x| x.as_str())
                .map(String::from)
                .ok_or_else(|| "pulls item 缺 html_url".to_string())?,
            body: v
                .get("body")
                .and_then(|x| x.as_str())
                .unwrap_or_default()
                .to_string(),
            head_ref: v
                .get("head")
                .and_then(|h| h.get("ref"))
                .and_then(|r| r.as_str())
                .unwrap_or_default()
                .to_string(),
        })
    }
}

/// 仅在 Search API 路径作为分页上限 fallback 使用；当前实现改为请求 `per_page=100`
/// 后整页解析，不再依赖 JQ 投影。
#[allow(dead_code)]
const SEARCH_PROJECTION: &str = "[.items[] | {
  number, title, url: .html_url, state, updated_at,
  repo: (.repository_url | split(\"/\") | .[-1]),
  assignees: [.assignees[].login],
  comments: (.comments // 0),
  is_pr: (.pull_request != null)
}]";

/// REST pulls 投影同样改为原生解析；保留常量仅为在调试中对照使用。
#[allow(dead_code)]
const PRS_REST_PROJECTION: &str = "[.[] | {
  number, url: .html_url, body: (.body // \"\"), head_ref: (.head.ref // \"\")
}]";

/// `search/issues` 走 Search API（严格限流 30 req/min），其余走核心配额（5000/h）。
/// 调用方需用不同入口区分，避免 Search API 计数污染核心配额统计。
const SEARCH_PATH: &str = "search/issues";

/// GitHub 客户端：一次构造长期复用（共享 reqwest 连接池）。
///
/// v0.3.16 起改为三参数 `new(pat, login, org)`：每个账号独立 login 与 org。
/// 构造时**不探测**——`test_connection` 是显式校验入口（PAT 是否仍有效、
/// 探测到的真实 login），由调用方按需触发。空 PAT 构造直接返回错误，
/// 由调用方提示用户去设置面板补 token。
/// #235：API 调用采集槽。操作方（同步 / 认领 / 状态写回）持有一份，
/// 在操作结束后 `drain` 出全部调用并落盘 `api_logs`。
/// `Arc<Mutex<_>>` 因为 `GitHubClient` 可能被跨线程共享（Search 限流门同理）。
pub type ApiLogSink = std::sync::Arc<std::sync::Mutex<Vec<crate::db::ApiLogEntry>>>;

/// #235：`target`（端点标识）摘要上限。
const API_LOG_TARGET_MAX: usize = 160;
/// #235：`request`（请求参数）摘要上限。
const API_LOG_REQ_MAX: usize = 400;
/// #235：`response`（返回参数）摘要上限。响应体可能很大，只留开头。
const API_LOG_RESP_MAX: usize = 600;

/// 取出采集槽中的全部记录（`None` 槽或锁中毒时返回空 vec）。
pub fn drain_api_log(sink: &ApiLogSink) -> Vec<crate::db::ApiLogEntry> {
    match sink.lock() {
        Ok(mut v) => std::mem::take(&mut *v),
        Err(e) => std::mem::take(&mut *e.into_inner()),
    }
}

/// #235：从完整 URL 取用于展示的 path（去掉 scheme / host / query）。
/// 纯函数，可单测。
pub fn url_display_path(url: &str) -> String {
    let after_scheme = url.split_once("://").map(|(_, r)| r).unwrap_or(url);
    let path = match after_scheme.find('/') {
        Some(i) => &after_scheme[i..],
        None => after_scheme,
    };
    summarize_text(path.split('?').next().unwrap_or(path), API_LOG_TARGET_MAX)
}

/// #235：GraphQL query 的展示标签。优先取 `query`/`mutation` 之后的第一个标识符
/// （跳过形如 `($a: String!)` 的变量声明块），让日志表能一眼看出调的是哪个操作；
/// 取不到时回退为 query 开头摘要。纯函数，可单测。
pub fn graphql_op_label(query: &str) -> String {
    let compact = query.split_whitespace().collect::<Vec<_>>().join(" ");
    let rest = ["mutation", "query"]
        .iter()
        .find_map(|kw| compact.strip_prefix(*kw))
        .unwrap_or(compact.as_str());
    let mut rest = rest.trim_start();
    // 跳过变量声明块 `(...)`，否则会误取变量名（如 `searchQuery`）。
    if rest.starts_with('(') {
        if let Some(i) = rest.find(')') {
            rest = &rest[i + 1..];
        }
    }
    let name: String = rest
        .trim_start_matches(|c: char| !(c.is_alphanumeric() || c == '_'))
        .chars()
        .take_while(|c| c.is_alphanumeric() || *c == '_')
        .collect();
    if name.is_empty() {
        return summarize_text(&compact, 80);
    }
    summarize_text(&name, API_LOG_TARGET_MAX)
}

pub struct GitHubClient {
    pat: String,
    /// 调用方提供的 login（来自 accounts 表）；用于构造 search 查询的 `assignee:` 等限定符。
    /// 注意：探测到的真实 login 见 [`Self::test_connection`]。
    login: String,
    /// 调用方提供的 org（来自 accounts 表）；用于 `org:` 限定符。
    org: String,
    http: reqwest::blocking::Client,
    /// 缓存 token 可访问的仓库列表（org/repo 格式），避免重复调用 API。
    accessible_repos: std::sync::Mutex<Option<Vec<String>>>,
    /// v0.3.49 (#143)：Search 限流门（上次 search 调用时刻）。多线程共享，
    /// `wait_search_gate` 保证任意两次调用间隔 ≥ SEARCH_GATE_MS。
    search_gate: std::sync::Mutex<Option<Instant>>,
    /// #235：API 调用采集槽；`None` = 不采集（既有调用方零改动）。
    sink: Option<ApiLogSink>,
}

/// Status 单选选项（含写回用的 option id，#215）。
#[derive(Debug, Clone)]
pub struct StatusOption {
    pub name: String,
    pub option_id: String,
    pub order_index: i64,
}

/// 项目的 Status 字段（含写回用的 field id 与选项，#215）。
#[derive(Debug, Clone)]
pub struct StatusField {
    pub field_id: String,
    pub options: Vec<StatusOption>,
}

/// #278：从一个 `issue` 节点（或 `parent` / `subIssues.nodes[]` 子节点）取关联信息。
///
/// 纯函数、对形状异常宽容：`number` 缺失即返回 `None`，不 panic。
fn link_from_node(n: &serde_json::Value) -> Option<IssueLink> {
    let number = n.get("number")?.as_i64()?;
    Some(IssueLink {
        number,
        title: n
            .get("title")
            .and_then(|s| s.as_str())
            .unwrap_or("")
            .to_string(),
        url: n
            .get("url")
            .and_then(|s| s.as_str())
            .unwrap_or("")
            .to_string(),
    })
}

/// #278：拼一块父子关系查询。抽成纯函数以便单测锁住别名与字段选集的形状
/// （GraphQL 语法错只在真实请求时才暴露，代价高）。
pub fn build_links_query(owner: &str, repo: &str, numbers: &[i64]) -> String {
    let mut fields = String::new();
    for (i, n) in numbers.iter().enumerate() {
        fields.push_str(&format!(
            "  a{i}: issue(number: {n}) {{ {LINK_FRAGMENT} }}\n"
        ));
    }
    format!(
        "query {{ r: repository(owner:\"{owner}\", name:\"{repo}\") {{ name owner {{ login }} {fields} }} }}"
    )
}

/// #342：判断 `fetch_issue_links` 的返回是否为**仓库级失败**。
///
/// 判据是 `data.r`（GraphQL 查询里 `repository(...)` 的别名）为 null 或缺失。
/// **不能**用顶层 `data` 是否为 null——那是非 null 的包装对象，即使仓库整体解析失败
/// 也依然有值，那样判据永不触发。
///
/// 仓库有效但个别 issue 别名 NOT_FOUND 时 `data.r` 是对象（有 `name` / `owner` 字段），
/// 不判为失败——这正是 #328 想要的宽松容错，二者必须区分开。
fn repo_level_failure(v: &serde_json::Value) -> bool {
    match v.get("data").and_then(|d| d.get("r")) {
        Some(r) => r.is_null() || !r.is_object(),
        None => true,
    }
}

/// #278：解析 `fetch_issue_links` 的 GraphQL 返回，纯函数（不发网络）。
///
/// 入参形如 `{"data": {"r": {"name", "owner", "a0": {...}, "a1": null, ...}}}`。
/// 按返回节点自身的 `number` 建键（不依赖别名顺序），键缺失的编号由调用方按
/// 「本次未取到」处理。形状不对时返回空 map——关系属装饰性信息，不能让它让同步报错。
pub fn parse_links_from_graphql(v: &serde_json::Value) -> HashMap<i64, IssueLinks> {
    let mut out = HashMap::new();
    let Some(repo) = v
        .get("data")
        .and_then(|d| d.get("r"))
        .and_then(|r| r.as_object())
    else {
        return out;
    };
    for (key, node) in repo {
        // 别名固定为 `a<序号>`；`name` / `owner` 是仓库自身字段，跳过。
        //
        // #383：`key.len() < 2` 不可省 —— `chars().skip(1).all(is_ascii_digit)` 在**空
        // 序列上空洞地为真**（Rust 的 `Iterator::all` 对空迭代器返回 `true`），所以
        // 光秃秃的 `"a"` 会被当成合法别名放行，与本行注释声明的契约相悖。
        if key.len() < 2
            || !key.starts_with('a')
            || !key.chars().skip(1).all(|c| c.is_ascii_digit())
        {
            continue;
        }
        let Some(n) = node.as_object() else { continue };
        let Some(number) = n.get("number").and_then(|x| x.as_i64()) else {
            continue;
        };
        // `parent` 为 `IssueOrPullRequest` union：不是 issue（PR 作父）时字段形状不同，
        // 直接交给 link_from_node 判空取号；此处只过滤 JSON null。
        let parent = n
            .get("parent")
            .filter(|p| !p.is_null())
            .and_then(link_from_node);
        let mut sub_issues = Vec::new();
        if let Some(nodes) = n
            .get("subIssues")
            .and_then(|s| s.get("nodes"))
            .and_then(|a| a.as_array())
        {
            for c in nodes {
                if let Some(link) = link_from_node(c) {
                    sub_issues.push(link);
                }
            }
        }
        out.insert(number, IssueLinks { parent, sub_issues });
    }
    out
}

impl GitHubClient {
    /// 构造客户端。`login` / `org` 为空时仍允许（外部调用方可能用不到）。
    ///
    /// 失败：PAT 为空。鉴权失败/网络错误不在构造时检查——交给 `test_connection` 显式触发，
    /// 这样批量 sync 时构造 N 个客户端不会再触发 N 次探测（每次同步 1 次即可）。
    pub fn new(pat: String, login: String, org: String) -> Result<Self, String> {
        Self::build(pat, login, org, None)
    }

    /// #235：带采集槽构造。返回 `(client, sink)`；操作结束后由调用方
    /// `drain_api_log(&sink)` 取出全部调用记录并落盘 `api_logs`。
    ///
    /// 采集是**按操作**的：一次同步 / 一次认领 / 一次状态写回各用一个 sink，
    /// 这样 `kind` 由调用方在落盘时统一标注，无需在每个调用点判断语义。
    pub fn new_with_sink(
        pat: String,
        login: String,
        org: String,
    ) -> Result<(Self, ApiLogSink), String> {
        let sink: ApiLogSink = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let client = Self::build(pat, login, org, Some(sink.clone()))?;
        Ok((client, sink))
    }

    /// #235：采集一次 API 调用。无槽或锁中毒时静默跳过 —— 日志失败绝不影响主流程。
    fn emit_api(&self, entry: crate::db::ApiLogEntry) {
        if let Some(sink) = &self.sink {
            if let Ok(mut v) = sink.lock() {
                v.push(entry);
            }
        }
    }

    fn build(
        pat: String,
        login: String,
        org: String,
        sink: Option<ApiLogSink>,
    ) -> Result<Self, String> {
        let pat = pat.trim().to_string();
        if pat.is_empty() {
            return Err("GitHub PAT 为空，请在设置面板粘贴 token".to_string());
        }
        let http = reqwest::blocking::Client::builder()
            .user_agent("taskboard/0.3.22")
            .timeout(Duration::from_secs(30))
            .connect_timeout(Duration::from_secs(10))
            .build()
            .map_err(|e| format!("构造 HTTP 客户端失败: {}", e))?;
        Ok(Self {
            pat,
            login,
            org,
            http,
            accessible_repos: std::sync::Mutex::new(None),
            search_gate: std::sync::Mutex::new(None),
            sink,
        })
    }

    /// v0.3.49 (#143)：Search 限流门。跨线程共享，调用前等待到距上次 ≥ 2s。
    /// 锁中毒时取内部值继续（门控降级为尽力而为，不阻断同步）。
    fn wait_search_gate(&self) {
        let mut guard = self.search_gate.lock().unwrap_or_else(|e| e.into_inner());
        let now = Instant::now();
        if let Some(last) = *guard {
            let elapsed = now.duration_since(last).as_millis();
            if elapsed < SEARCH_GATE_MS {
                std::thread::sleep(Duration::from_millis((SEARCH_GATE_MS - elapsed) as u64));
            }
        }
        *guard = Some(Instant::now());
    }

    /// 探测当前 PAT 是否有效，返回账号登录名。
    ///
    /// 用途：
    /// - 设置面板「测试连接」按钮（`test_pat` / `test_account_pat`）
    /// - 添加账号时探测真实 login 以覆盖用户可能填错的 login（`add_account`）
    pub fn test_connection(&self) -> Result<TestConnectionResult, String> {
        let url = "https://api.github.com/user";
        let resp = self.get(url)?;
        let login = resp
            .get("login")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "GitHub 返回无 login 字段".to_string())?
            .to_string();
        if login.is_empty() {
            return Err("GitHub 返回空 login（账号不可用）".to_string());
        }
        Ok(TestConnectionResult { login })
    }

    /// 获取当前 token 用户所属的组织列表（`GET /user/orgs`）。
    /// 返回 `(login, org_login)` — 第一个组织的 login；用户无组织时 org 为空。
    /// 需要 `read:org` scope（Device Flow 已包含）。
    pub fn fetch_user_org(&self) -> Result<String, String> {
        let url = "https://api.github.com/user/orgs?per_page=10";
        let resp = self.get(url)?;
        let arr = resp
            .as_array()
            .ok_or_else(|| "user orgs 返回非数组".to_string())?;
        // 取第一个组织的 login
        let org = arr
            .first()
            .and_then(|o| o.get("login"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        Ok(org)
    }

    /// 获取当前 token 可访问的仓库列表（在配置的 org 范围内）。
    ///
    /// 使用 REST API `/orgs/{org}/repos` 列出组织仓库，过滤出 token 有权限访问的。
    /// 结果缓存在 `accessible_repos` 中，同一客户端实例仅查询一次。
    ///
    /// 返回 `org/repo` 或 `user/repo` 格式的仓库全名列表，供 Search API 的 `repo:` 限定符使用。
    /// 先查组织级仓库，再查用户级仓库（合并去重）。
    fn get_accessible_repos(&self) -> Result<Vec<String>, String> {
        if let Ok(guard) = self.accessible_repos.lock() {
            if let Some(ref cached) = *guard {
                return Ok(cached.clone());
            }
        }

        let mut repos = Vec::new();

        // 1) 组织级仓库
        if !self.org.is_empty() {
            for page in 1..=10 {
                let url = format!(
                    "https://api.github.com/orgs/{}/repos?type=all&per_page=100&page={}",
                    self.org, page
                );
                let v = match self.get(&url) {
                    Ok(v) => v,
                    Err(_) => break,
                };
                let arr = match v.as_array() {
                    Some(a) => a,
                    None => break,
                };
                if arr.is_empty() {
                    break;
                }
                for repo in arr {
                    if let Some(name) = repo.get("name").and_then(|n| n.as_str()) {
                        repos.push(format!("{}/{}", self.org, name));
                    }
                }
                if arr.len() < 100 {
                    break;
                }
            }
        }

        // 2) 用户级仓库（Project v2 可能挂在个人账号下）
        if !self.login.is_empty() {
            for page in 1..=10 {
                let url = format!(
                    "https://api.github.com/users/{}/repos?type=all&per_page=100&page={}",
                    self.login, page
                );
                let v = match self.get(&url) {
                    Ok(v) => v,
                    Err(_) => break,
                };
                let arr = match v.as_array() {
                    Some(a) => a,
                    None => break,
                };
                if arr.is_empty() {
                    break;
                }
                for repo in arr {
                    if let Some(full_name) = repo.get("full_name").and_then(|n| n.as_str()) {
                        if !repos.iter().any(|r| r == full_name) {
                            repos.push(full_name.to_string());
                        }
                    }
                }
                if arr.len() < 100 {
                    break;
                }
            }
        }

        if let Ok(mut guard) = self.accessible_repos.lock() {
            *guard = Some(repos.clone());
        }
        Ok(repos)
    }

    /// 构造 Search API 查询字符串的基础部分（仓库限定符）。
    ///
    /// 优先使用 token 可访问的仓库列表构造 `repo:org/repo1 repo:org/repo2 ...`；
    /// 若无可访问仓库或获取失败，回退到不带 `org:`/`repo:` 限定符（搜索 token 所有可见仓库）。
    fn build_repo_qualifier(&self, base_query: &str) -> String {
        match self.get_accessible_repos() {
            Ok(repos) if !repos.is_empty() => {
                let repo_qualifiers = repos
                    .iter()
                    .map(|r| format!("repo:{}", r))
                    .collect::<Vec<_>>()
                    .join(" ");
                format!("{} {}", repo_qualifiers, base_query)
            }
            _ => {
                crate::tlog!(
                    "[sync] 无可访问仓库或获取失败，回退到全可见范围搜索: {}",
                    base_query
                );
                base_query.to_string()
            }
        }
    }

    /// 拉取「明确分配给我」的 open issue。权威来源，确保「分配给我」永不漏拉。
    pub fn fetch_assigned(&self) -> Result<Vec<RawTask>, String> {
        let base = format!("assignee:{} is:issue", self.login);
        self.search(&self.build_repo_qualifier(&base))
    }

    /// 拉取「我创建」的 issue。
    pub fn fetch_authored(&self) -> Result<Vec<RawTask>, String> {
        let base = format!("author:{} is:issue", self.login);
        self.search(&self.build_repo_qualifier(&base))
    }

    /// 拉取「@提到我」的 issue。
    pub fn fetch_mentioned(&self) -> Result<Vec<RawTask>, String> {
        let base = format!("mentions:{} is:issue", self.login);
        self.search(&self.build_repo_qualifier(&base))
    }

    /// 拉取「我评论过」的 issue。
    pub fn fetch_commented(&self) -> Result<Vec<RawTask>, String> {
        let base = format!("commenter:{} is:issue", self.login);
        self.search(&self.build_repo_qualifier(&base))
    }

    /// 拉取「与我相关」的全部 issue。仅作补充源：GitHub 的 `involves:` 对
    /// assignee 覆盖偶发不可靠，故主覆盖由上面 4 个专属查询保证。
    pub fn fetch_related(&self) -> Result<Vec<RawTask>, String> {
        let base = format!("involves:{} is:issue", self.login);
        self.search(&self.build_repo_qualifier(&base))
    }

    /// 拉取指定仓库的全部 PR（open + closed），用于把「PR 关联的 issue」反向关联回看板卡片。
    ///
    /// REST pulls 接口（核心配额 5000/h，无 Search API 的 30/min 严限）。
    /// 逐页 best-effort：单页失败仅记录日志跳过，不中断整个仓库列表。
    ///
    /// v0.3.49 (#143)：多仓库并行拉取（`thread::scope`，共享同一连接池）。
    /// 核心配额充裕，并行数等于仓库数（实测仅 2 个有任务的仓库）。
    pub fn fetch_prs(&self, repos: &[String]) -> Result<Vec<RawPr>, String> {
        let per_repo: Vec<Vec<RawPr>> = std::thread::scope(|s| {
            let handles: Vec<_> = repos
                .iter()
                .map(|repo| {
                    s.spawn(|| {
                        if repo.is_empty() {
                            return Vec::new();
                        }
                        self.fetch_prs_for_repo(repo)
                    })
                })
                .collect();
            handles
                .into_iter()
                .map(|h| h.join().unwrap_or_default())
                .collect()
        });
        Ok(per_repo.into_iter().flatten().collect())
    }

    /// 单仓库的 PR 拉取（`fetch_prs` 的并行单元）。失败仅记日志返回空集。
    fn fetch_prs_for_repo(&self, repo: &str) -> Vec<RawPr> {
        let mut out: Vec<RawPr> = Vec::new();
        // repo 已是 "owner/name" 格式；若只是 name 则回退到 org/name
        let full_repo = if repo.contains('/') {
            repo.to_string()
        } else {
            format!("{}/{}", self.org, repo)
        };
        for page in 1..=3 {
            let url = format!(
                "https://api.github.com/repos/{}/pulls?state=all&per_page=100&page={}",
                full_repo, page
            );
            // 走核心配额，不计入 Search API 节流；且 PR 数据量可能很大（一次同步达数十 MB），
            // 设较大超时避免大仓库拉取被中断。
            let items: Vec<RawPr> = match self.get_with_timeout(&url, 60) {
                Ok(v) => match v.as_array() {
                    Some(arr) => arr
                        .iter()
                        .filter_map(|item| match RawPr::from_item(item) {
                            Ok(p) => Some(p),
                            Err(e) => {
                                crate::tlog!("[sync] {}/PR item 解析失败，跳过: {}", repo, e);
                                None
                            }
                        })
                        .collect(),
                    None => {
                        crate::tlog!("[sync] {}/PR 第 {} 页响应非数组，跳过", repo, page);
                        Vec::new()
                    }
                },
                Err(e) => {
                    crate::tlog!("[sync] {}/PR 第 {} 页拉取失败，跳过: {}", repo, page, e);
                    Vec::new()
                }
            };
            let n = items.len();
            for mut pr in items {
                // repo 字段保持纯 name（与 key 的 "repo#number" 一致）；
                // repo_owner 用于需要完整路径的场景。
                let (owner, name) = if let Some(pos) = full_repo.find('/') {
                    (&full_repo[..pos], &full_repo[pos + 1..])
                } else {
                    ("", full_repo.as_str())
                };
                pr.repo = name.to_string();
                pr.repo_owner = owner.to_string();
                out.push(pr);
            }
            if n < 100 {
                break;
            }
        }
        out
    }

    /// 拉取某 issue 的全部评论，返回最新一条评论的永久链接（html_url），供卡片一键跳转。
    /// 无评论返回 None。best-effort：失败返回 Err。
    /// `repo_owner` 用于 org 为空时构造完整仓库路径。
    pub fn fetch_comments(
        &self,
        repo: &str,
        number: i64,
        repo_owner: &str,
    ) -> Result<Option<String>, String> {
        let full_repo = if !self.org.is_empty() {
            format!("{}/{}", self.org, repo)
        } else if !repo_owner.is_empty() {
            format!("{}/{}", repo_owner, repo)
        } else {
            return Err("无法确定仓库 owner（org 为空且无 repo_owner）".to_string());
        };
        let url = format!(
            "https://api.github.com/repos/{}/issues/{}/comments?per_page=100",
            full_repo, number
        );
        let v = self.get(&url)?;
        let arr = v
            .as_array()
            .ok_or_else(|| "comments 返回非数组".to_string())?;
        Ok(arr
            .iter()
            .filter_map(|c| c.get("html_url").and_then(|u| u.as_str()).map(String::from))
            .next_back())
    }

    /// 拉取 GitHub Project「OMS Kanban」中每个 issue 的 Status 字段，
    /// 返回 `repo#number -> Status 原文` 的映射，供 sync 映射到看板四态。
    ///
    /// 为什么需要：看板状态联动不能只看 issue 的 open/closed——团队用 Project 的
    /// Status 字段（如「🔎开发完成/测试中」）表达进度，Search API 不返回该字段。
    /// 拉取当前账号可见的全部 Project v2（组织级 + 用户级）。
    /// 返回 `(github_id, title, number_of_items, owner_type)` 列表。
    /// 拉取**单个 issue**：`GET /repos/{owner}/{repo}/issues/{n}`（走核心配额，非 Search API）。
    ///
    /// v0.4.1 (#250)：供 MCP「按需拉取」使用。与 `fetch_*` 系列不同，本方法
    /// **不做 best-effort 降级**：调用方必须能区分
    /// 「远端确实没有」(`Ok(None)`) 与「请求失败」(`Err`，网络 / 401 / 限流耗尽)。
    ///
    /// 注意：REST issues 端点**同样会返回 PR**（响应带 `pull_request` 字段），
    /// 由 [`RawTask::is_pr`] 标出，是否接受由调用方决定。
    pub fn fetch_issue(
        &self,
        owner: &str,
        repo: &str,
        number: i64,
    ) -> Result<Option<RawTask>, String> {
        let url = format!("https://api.github.com/repos/{owner}/{repo}/issues/{number}");
        match self.get_opt(&url)? {
            Some(v) => RawTask::from_issue_rest(&v, owner, repo).map(Some),
            None => Ok(None),
        }
    }

    /// #278：批量拉取同一仓库内一组 issue 的父子关系（GraphQL，只读）。
    ///
    /// 一次请求覆盖 `LINKS_CHUNK_SIZE` 个编号（别名 `a0`…），把 N 次往返压成
    /// ⌈N/25⌉ 次；调用方（sync.rs）按 `(owner, repo)` 分组后整组传入。
    ///
    /// 返回 `number -> IssueLinks`。某编号本次取不到（如同步期间被删）则不出现在
    /// map 里，由调用方按「未取到」处理；整块请求失败返回 `Err`，调用方保留既有值。
    ///
    /// #328：改用**宽松模式**（[`Self::graphql_partial`]）。原先走严格模式，只要整块
    /// 返回里带 `errors`（单个编号 NOT_FOUND / FORBIDDEN 即可触发）就整块失败，
    /// 25 个 issue 的父子关系一起丢。宽松模式下 `data` 有值即采信，取不到的编号自然
    /// 不落进 map，其余编号照常更新。
    ///
    /// #342：宽松判据必须落在 **`data.r`（仓库包装层）** 这一点上，而不是顶层 `data`。
    /// 仓库改名 / 转移 / 删除 / token 失权时 GitHub 返回 `{"data":{"r":null},"errors":[…]}`，
    /// 顶层 `data` 是**非 null 对象** ⇒ [`Self::graphql_partial`] 的 `v["data"].is_null()`
    /// 不触发 ⇒ 宽松放行 ⇒ 解析器命中 `data.r` 为 null 返回**空 map**（非 `Err`），
    /// 上层 `sync.rs` 视作成功、`links_failed_repos` 收不到该仓库 ⇒ 已有关联被空值覆盖。
    /// 那道「失败则保留既有值」的安全网恰好在最需要它的场景被绕过。
    /// 故本函数显式把 `data.r` 为 null / 缺失视为**整块失败**并返回 `Err`，
    /// 宽松只保留给「仓库有效、个别别名 NOT_FOUND」的容错语义。
    pub fn fetch_issue_links(
        &self,
        owner: &str,
        repo: &str,
        numbers: &[i64],
    ) -> Result<HashMap<i64, IssueLinks>, String> {
        let mut out = HashMap::new();
        for chunk in numbers.chunks(LINKS_CHUNK_SIZE) {
            if chunk.is_empty() {
                continue;
            }
            let v = self.graphql_partial(&build_links_query(owner, repo, chunk))?;
            // #342：`data.r` 为 null/缺失 ⇒ 仓库级失败（改名/转移/无权），必须 Err。
            // 注意不能用 `data` 是否为 null 判断——它是非 null 的包装对象。
            if repo_level_failure(&v) {
                return Err(format!(
                    "{owner}/{repo} 关联查询返回空仓库（仓库改名/转移/删除，或 token 无权访问？）"
                ));
            }
            out.extend(parse_links_from_graphql(&v));
        }
        Ok(out)
    }

    /// #327：组织级 projectsV2 查询串（抽成纯函数以便单测查询形状）。
    fn org_projects_query(org: &str) -> String {
        format!(
            r#"query {{ organization(login:"{org}") {{ projectsV2(first:100, orderBy:{{field:UPDATED_AT,direction:DESC}}) {{ nodes {{ id title number closed items {{ totalCount }} }} }} }} }}"#
        )
    }

    /// #327：用户级 projectsV2 查询串。
    fn user_projects_query(login: &str) -> String {
        format!(
            r#"query {{ user(login:"{login}") {{ projectsV2(first:100, orderBy:{{field:UPDATED_AT,direction:DESC}}) {{ nodes {{ id title number closed items {{ totalCount }} }} }} }} }}"#
        )
    }

    /// #327：解析 projectsV2 `nodes` → `(github_id, title, 条目数, owner_type)`。
    ///
    /// 条目数取 `items.totalCount`。**不能**取 `number` —— 那是项目编号（如 #20），
    /// 曾因此把 `projects.number_of_items` 存成编号，使
    /// `resolve_project_write_target` 的 `ORDER BY number_of_items DESC`
    /// 退化成「按项目编号选」，多 Project 时写错写回目标。
    fn parse_projects_nodes(
        nodes: &[serde_json::Value],
        owner_type: &str,
    ) -> Vec<(String, String, i64, String)> {
        let mut out: Vec<(String, String, i64, String)> = Vec::new();
        for n in nodes {
            if n["closed"].as_bool() == Some(true) {
                continue;
            }
            if let (Some(id), Some(title)) = (n["id"].as_str(), n["title"].as_str()) {
                let num = n["items"]["totalCount"].as_i64().unwrap_or(0);
                out.push((
                    id.to_string(),
                    title.to_string(),
                    num,
                    owner_type.to_string(),
                ));
            }
        }
        out
    }

    pub fn fetch_all_projects(&self) -> Result<Vec<(String, String, i64, String)>, String> {
        let mut out: Vec<(String, String, i64, String)> = Vec::new();

        // 1) 组织级 projectsV2
        if let Ok(v) = self.graphql(&Self::org_projects_query(&self.org)) {
            if let Some(nodes) = v["data"]["organization"]["projectsV2"]["nodes"].as_array() {
                out.extend(Self::parse_projects_nodes(nodes, "org"));
            }
        }

        // 2) 用户级 projectsV2
        if let Ok(v) = self.graphql(&Self::user_projects_query(&self.login)) {
            if let Some(nodes) = v["data"]["user"]["projectsV2"]["nodes"].as_array() {
                out.extend(Self::parse_projects_nodes(nodes, "user"));
            }
        }

        Ok(out)
    }

    /// 拉取多个 Project 的 Status 条目，合并为 `repo#number -> Status` 映射。
    pub fn fetch_project_status(
        &self,
        project_ids: &[String],
    ) -> Result<HashMap<String, String>, String> {
        let mut map: HashMap<String, String> = HashMap::new();
        for pid in project_ids {
            match self.fetch_project_items(pid) {
                Ok(m) => map.extend(m),
                Err(e) => crate::tlog!("[gh] 拉取 project {} 条目失败: {}", pid, e),
            }
        }
        Ok(map)
    }

    /// 查询某项目的 Status 字段（含字段/选项 id，供 #215 写回）。
    pub fn status_field(&self, project_id: &str) -> Result<StatusField, String> {
        // 查项目所有字段，找 Status 类型的 SingleSelectField，取其 id 与 options（含 id）
        let q = format!(
            r#"query {{ node(id:"{pid}") {{ ... on ProjectV2 {{
              fields(first:50) {{
                nodes {{
                  ... on ProjectV2SingleSelectField {{
                    id
                    name
                    options {{ id name }}
                  }}
                }}
              }}
            }} }} }}"#,
            pid = project_id
        );
        let v = self.graphql(&q)?;
        let nodes = v["data"]["node"]["fields"]["nodes"]
            .as_array()
            .ok_or_else(|| "查询项目字段失败".to_string())?;
        // 找名为 Status 的 SingleSelectField
        for n in nodes {
            let fname = n["name"].as_str().unwrap_or("");
            if fname.eq_ignore_ascii_case("Status")
                || fname.contains("tatus")
                || fname.contains("状态")
            {
                let field_id = n["id"].as_str().unwrap_or("").to_string();
                let options = n["options"]
                    .as_array()
                    .ok_or_else(|| format!("字段 '{}' 无 options", fname))?;
                let result: Vec<StatusOption> = options
                    .iter()
                    .enumerate()
                    .map(|(i, o)| StatusOption {
                        name: o["name"].as_str().unwrap_or("").to_string(),
                        option_id: o["id"].as_str().unwrap_or("").to_string(),
                        order_index: i as i64,
                    })
                    .collect();
                if !result.is_empty() {
                    crate::tlog!(
                        "[gh] project {} field '{}' options={:?}",
                        project_id,
                        fname,
                        result.iter().map(|o| &o.name).collect::<Vec<_>>()
                    );
                    return Ok(StatusField {
                        field_id,
                        options: result,
                    });
                }
            }
        }
        Err("项目中未找到 Status 字段".to_string())
    }

    /// 分页拉取单个项目的全部条目，构建 `repo#number -> Status` 映射。
    fn fetch_project_items(&self, project_id: &str) -> Result<HashMap<String, String>, String> {
        let mut map: HashMap<String, String> = HashMap::new();
        let mut cursor: Option<String> = None;
        for _ in 0..100 {
            let after = match &cursor {
                Some(c) => format!(r#", after:"{}""#, c),
                None => String::new(),
            };
            let items_q = format!(
                r#"query {{ node(id:"{pid}") {{ ... on ProjectV2 {{ items(first:50{after}) {{
                  pageInfo {{ hasNextPage endCursor }}
                  nodes {{
                    content {{ ... on Issue {{ number repository {{ name }} }} }}
                    fieldValues(first:20) {{
                      nodes {{ ... on ProjectV2ItemFieldSingleSelectValue {{
                        name field {{ ... on ProjectV2SingleSelectField {{ name }} }}
                      }} }}
                    }}
                  }}
                }} }} }} }}"#,
                pid = project_id,
                after = after
            );
            let resp = self.graphql(&items_q)?;
            let items = &resp["data"]["node"]["items"];
            let page_nodes = items["nodes"]
                .as_array()
                .ok_or_else(|| "项目条目格式异常".to_string())?;
            for n in page_nodes {
                let content = &n["content"];
                let num = content["number"].as_i64();
                let repo = content["repository"]["name"].as_str();
                if let (Some(num), Some(repo)) = (num, repo) {
                    let key = format!("{}#{}", repo, num);
                    let mut status = String::new();
                    if let Some(fvs) = n["fieldValues"]["nodes"].as_array() {
                        for fv in fvs {
                            let field_name = fv["field"]["name"].as_str().unwrap_or("");
                            let val_name = fv["name"].as_str().unwrap_or("");
                            // 通用匹配：字段名含 "Status" 或 "状态"（中英文变体）
                            if (field_name.eq_ignore_ascii_case("Status")
                                || field_name.contains("tatus")
                                || field_name.contains("状态"))
                                && !val_name.is_empty()
                            {
                                status = val_name.to_string();
                            }
                        }
                        // 诊断：打印第一个 item 的所有 field name + value
                        if map.len() < 3 {
                            for fv in fvs {
                                let fn_ = fv["field"]["name"].as_str().unwrap_or("?");
                                let vn_ = fv["name"].as_str().unwrap_or("?");
                                crate::tlog!("[gh] project item field='{}' value='{}'", fn_, vn_);
                            }
                        }
                    }
                    if !status.is_empty() {
                        map.insert(key, status);
                    }
                }
            }
            if items["pageInfo"]["hasNextPage"].as_bool() == Some(true) {
                cursor = items["pageInfo"]["endCursor"]
                    .as_str()
                    .map(|s| s.to_string());
            } else {
                break;
            }
        }
        Ok(map)
    }

    /// #356：项目条目查询串（抽成纯函数，沿用 #327 `org_projects_query` 的做法，
    /// 使「查询形状」可被单测锁定）。
    ///
    /// ⚠️ issue 分支里的 `updatedAt` **不可删**：漏选它会让 `updated_at` 恒为 0，
    /// 仅经 Project 发现的 issue 卡片日期永久空白（该缺陷已真实发生过一次）。
    fn project_items_query(project_id: &str, after: &str) -> String {
        format!(
            r#"query {{ node(id:"{pid}") {{ ... on ProjectV2 {{ items(first:50{after}) {{
                  pageInfo {{ hasNextPage endCursor }}
                  nodes {{
                    id
                    content {{
                      __typename
                      ... on Issue {{
                        number title url state updatedAt
                        repository {{ name owner {{ login }} }}
                        assignees(first:10) {{ nodes {{ login }} }}
                        labels(first:20) {{ nodes {{ name }} }}
                        comments {{ totalCount }}
                        author {{ login }}
                      }}
                      ... on PullRequest {{
                        number title url state
                        repository {{ name owner {{ login }} }}
                      }}
                    }}
                    fieldValues(first:20) {{
                      nodes {{ ... on ProjectV2ItemFieldSingleSelectValue {{
                        name field {{ ... on ProjectV2SingleSelectField {{ name }} }}
                      }} }}
                    }}
                  }}
                }} }} }} }}"#,
            pid = project_id,
            after = after,
        )
    }

    /// #356：读项目条目的 `updatedAt`（RFC3339）。
    ///
    /// 缺失或为 null 时返回空串（下游 `iso8601_to_secs` 转 0），与该文件既有的
    /// 「字段缺失即回落」容错策略一致，不 panic。抽成纯函数以便单测。
    fn project_item_updated_at(content: &serde_json::Value) -> String {
        content["updatedAt"].as_str().unwrap_or("").to_string()
    }

    /// 拉取项目中全部 issue 条目的完整信息（title, state, labels, assignees 等），
    /// 用于发现「项目中有但搜索源未覆盖」的 issue，合并进同步数据。
    /// 返回 `(status_map, discovered_issues, item_ids)`。
    pub fn fetch_project_issues(
        &self,
        project_id: &str,
        org: &str,
    ) -> Result<ProjectIssuesResult, String> {
        let mut status_map: HashMap<String, String> = HashMap::new();
        let mut issues: Vec<RawTask> = Vec::new();
        // #215：issue_key -> project item id（写回用）。
        let mut item_ids: HashMap<String, String> = HashMap::new();
        let mut cursor: Option<String> = None;
        for _ in 0..100 {
            let after = match &cursor {
                Some(c) => format!(r#", after:"{}""#, c),
                None => String::new(),
            };
            let q = Self::project_items_query(project_id, &after);
            let resp = self.graphql(&q)?;
            let items = &resp["data"]["node"]["items"];
            let page_nodes = items["nodes"]
                .as_array()
                .ok_or_else(|| "项目条目格式异常".to_string())?;
            for n in page_nodes {
                let content = &n["content"];
                // 跳过 PR：按 GraphQL __typename 可靠判型。
                // 修复前尝试用 pull_request/mergedAt/headRefOid 字段判型，但查询并未选取这些字段，
                // 判断恒为假，导致 Project V2 中的 PR 被当作 issue 上板。
                if content["__typename"].as_str() == Some("PullRequest") {
                    continue;
                }
                let num = match content["number"].as_i64() {
                    Some(n) => n,
                    None => continue,
                };
                let repo = match content["repository"]["name"].as_str() {
                    Some(r) => r.to_string(),
                    None => continue,
                };
                let owner = content["repository"]["owner"]["login"]
                    .as_str()
                    .unwrap_or(org);
                let title = content["title"].as_str().unwrap_or("").to_string();
                let state = content["state"].as_str().unwrap_or("open").to_string();
                let _url = content["url"].as_str().unwrap_or("").to_string();
                let assignees: Vec<String> = content["assignees"]["nodes"]
                    .as_array()
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|n| n["login"].as_str().map(String::from))
                            .collect()
                    })
                    .unwrap_or_default();
                let labels: Vec<String> = content["labels"]["nodes"]
                    .as_array()
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|n| n["name"].as_str().map(String::from))
                            .collect()
                    })
                    .unwrap_or_default();
                let comments = content["comments"]["totalCount"].as_u64().unwrap_or(0);
                let key = format!("{}#{}", repo, num);
                // 提取 Status 字段值
                let mut status = String::new();
                if let Some(fvs) = n["fieldValues"]["nodes"].as_array() {
                    for fv in fvs {
                        let field_name = fv["field"]["name"].as_str().unwrap_or("");
                        let val_name = fv["name"].as_str().unwrap_or("");
                        if (field_name.eq_ignore_ascii_case("Status")
                            || field_name.contains("tatus")
                            || field_name.contains("状态"))
                            && !val_name.is_empty()
                        {
                            status = val_name.to_string();
                        }
                    }
                }
                if !status.is_empty() {
                    status_map.insert(key.clone(), status);
                }
                // #215：条目 id（写回 mutation 用；空则该条不可写回）。
                if let Some(iid) = n["id"].as_str().filter(|s| !s.is_empty()) {
                    item_ids.insert(key.clone(), iid.to_string());
                }
                // 用 owner 构造 GitHub 网页 URL（项目条目的 url 是 GraphQL node url，非网页链接）
                let html_url = format!("https://github.com/{}/{}/issues/{}", owner, repo, num);
                // #237：创建人。`author` 可为 null（用户已注销）→ 空串，卡片不渲染该行。
                let author = content["author"]["login"]
                    .as_str()
                    .unwrap_or("")
                    .to_string();
                issues.push(RawTask {
                    number: num,
                    title,
                    url: html_url,
                    state,
                    // #356：取 GraphQL 的 `updatedAt`（RFC3339）。缺失/为 null
                    // 时回落空串 —— 与既有容错一致，且下游 iso8601_to_secs 会转 0。
                    updated_at: Self::project_item_updated_at(content),
                    repo,
                    repo_owner: owner.to_string(),
                    assignees,
                    labels,
                    author,
                    comments,
                    is_pr: false,
                    created_at: String::new(),
                });
            }
            if items["pageInfo"]["hasNextPage"].as_bool() == Some(true) {
                cursor = items["pageInfo"]["endCursor"]
                    .as_str()
                    .map(|s| s.to_string());
            } else {
                break;
            }
        }
        Ok((status_map, issues, item_ids))
    }

    // ===== 私有方法 =====

    /// 限流感知的 GET：依据 `X-RateLimit-Remaining` / `X-RateLimit-Reset` / `Retry-After`
    /// 主动 sleep；遇 4xx/5xx 返回带状态码的错误。
    fn get(&self, url: &str) -> Result<serde_json::Value, String> {
        self.get_with_timeout(url, self.http_timeout())
    }

    fn get_with_timeout(&self, url: &str, timeout_secs: u64) -> Result<serde_json::Value, String> {
        match self.get_impl(url, timeout_secs, false)? {
            Some(v) => Ok(v),
            // not_found_as_none = false 时 get_impl 不会返回 None；仅为类型完备。
            None => Err(format!("GitHub API 错误 (404): {url}")),
        }
    }

    /// 同 [`Self::get_with_timeout`]，但 **404 返回 `Ok(None)`**（远端确实没有该资源）。
    ///
    /// v0.4.1 (#250)：单 issue 按需拉取必须把「远端没有这个 issue」与
    /// 「网络 / 鉴权 / 限流失败」区分开——前者是正常业务结论，后者要带原因上抛给 agent。
    fn get_opt(&self, url: &str) -> Result<Option<serde_json::Value>, String> {
        self.get_impl(url, self.http_timeout(), true)
    }

    /// [`Self::get_with_timeout`] 与 [`Self::get_opt`] 的共用实现。
    ///
    /// 限流感知的 GET：依据 `X-RateLimit-Remaining` / `X-RateLimit-Reset` / `Retry-After`
    /// 主动 sleep；遇 4xx/5xx 返回带状态码的错误（`not_found_as_none` 时 404 例外）。
    fn get_impl(
        &self,
        url: &str,
        timeout_secs: u64,
        not_found_as_none: bool,
    ) -> Result<Option<serde_json::Value>, String> {
        // v0.3.49 (#143)：删除原来 Search 每页固定 1s sleep，改为 search() 入口的
        // 共享限流门（精确到 2s 间隔）。其余路径走核心配额，仍尊重响应头的
        // 剩余计数，避免触发 Search API 二次（突发）限流。

        for attempt in 0..3 {
            // #228：单次尝试计时（成功/失败都记调用日志，verbose 门控）。
            let start = std::time::Instant::now();
            let resp = self
                .http
                .get(url)
                .header("Authorization", format!("Bearer {}", self.pat))
                .header("Accept", "application/vnd.github+json")
                .header("X-GitHub-Api-Version", "2022-11-28")
                .timeout(Duration::from_secs(timeout_secs))
                .send()
                .map_err(|e| format!("网络请求失败: {}", e))?;

            let status = resp.status();
            // 1. 主动限流：仅当响应头确实指向限流时才等待重试。
            //    #328：403 需先区分「限流」与「权限不足 / SSO 未授权」——后者若也当成限流，
            //    每次请求白睡默认 10s、重试 3 次共 ~30s，最后仍然失败，排障体验极差。
            if status.as_u16() == 429 || status.as_u16() == 403 {
                if let Some(retry_after) = self.rate_limit_wait(status.as_u16(), resp.headers()) {
                    let wait_ms = (retry_after * 1000).min(MAX_BACKOFF_MS);
                    crate::tlog!(
                        "[gh] 限流（{}），等待 {}ms 后重试（第 {} 次）",
                        status.as_u16(),
                        wait_ms,
                        attempt + 1
                    );
                    std::thread::sleep(Duration::from_millis(wait_ms));
                    continue;
                }
                // 非限流（权限/SSO）：不等待，落到下面的错误分支并附上权限指引。
            }

            // 2. 其它非 2xx（如 404/422/401）：立即返回错误，由 best-effort 逻辑降级。
            if !status.is_success() {
                let body = resp.text().unwrap_or_default();
                let elapsed_ms = start.elapsed().as_millis();
                log_api_call(
                    "GET",
                    url,
                    status.as_u16(),
                    elapsed_ms,
                    &summarize_text(&body, 160),
                );
                // #235：落盘请求/返回参数（GET 的「请求参数」= 完整 URL 含 query）。
                self.emit_api(crate::db::ApiLogEntry::new(
                    "GET",
                    &url_display_path(url),
                    status.as_u16() as i64,
                    false,
                    elapsed_ms as i64,
                    &summarize_text(url, API_LOG_REQ_MAX),
                    &summarize_text(&body, API_LOG_RESP_MAX),
                ));
                if not_found_as_none && status.as_u16() == 404 {
                    // v0.4.1 (#250)：调用方要区分「远端没有」与「请求失败」。
                    return Ok(None);
                }
                return Err(format!(
                    "GitHub API 错误 ({}): {}{}",
                    status.as_u16(),
                    body.chars().take(160).collect::<String>(),
                    non_rate_limit_hint(status.as_u16())
                ));
            }

            // 3. 成功：根据 X-RateLimit-Remaining 决定是否需要主动 sleep 等配额回补。
            let remaining: Option<i64> = resp
                .headers()
                .get("X-RateLimit-Remaining")
                .and_then(|v| v.to_str().ok())
                .and_then(|s| s.parse().ok());
            if let Some(r) = remaining {
                if r <= 2 {
                    // 即将耗尽，主动等到窗口重置；上限保护避免挂死。
                    let wait_ms = self
                        .seconds_until_reset(resp.headers())
                        .map(|s| (s * 1000).min(MAX_BACKOFF_MS))
                        .unwrap_or(5000);
                    crate::tlog!("[gh] 配额剩余 {}，等待 {}ms 回补", r, wait_ms);
                    std::thread::sleep(Duration::from_millis(wait_ms));
                }
            }

            let elapsed_ms = start.elapsed().as_millis();
            log_api_call("GET", url, status.as_u16(), elapsed_ms, "");
            // #235：成功路径此前只记状态码，响应体完全没留 —— 这里补上。
            // 先取文本再解析（`Response::json()` 会消费 body）；失败文案保持原样。
            let body_text = resp
                .text()
                .map_err(|e| format!("解析 GitHub 返回失败: {}", e))?;
            self.emit_api(crate::db::ApiLogEntry::new(
                "GET",
                &url_display_path(url),
                status.as_u16() as i64,
                true,
                elapsed_ms as i64,
                &summarize_text(url, API_LOG_REQ_MAX),
                &summarize_text(&body_text, API_LOG_RESP_MAX),
            ));
            return serde_json::from_str::<serde_json::Value>(&body_text)
                .map(Some)
                .map_err(|e| format!("解析 GitHub 返回失败: {}", e));
        }
        Err(format!("达到最大重试次数（限流持续）: {}", url))
    }

    /// Search API 调用的统一入口：单页结果（自动投影）。
    ///
    /// 对于 422 Validation Failed（限定词引用不可访问资源），返回空结果并记录警告，
    /// 由调用方的 best-effort 合并逻辑降级处理，避免单个数据源失败导致整次同步中断。
    fn search(&self, q: &str) -> Result<Vec<RawTask>, String> {
        let encoded = urlencode(q);
        let mut all = Vec::new();
        // GitHub Search API：每页最多100，总计最多1000 → 最多10页
        for page in 1..=10 {
            // v0.3.49 (#143)：每页调用前过共享限流门（多源并发时跨线程精确节流）。
            self.wait_search_gate();
            let url = format!(
                "https://api.github.com/{}?q={}&per_page=100&page={}",
                SEARCH_PATH, encoded, page
            );
            let resp = self.http_get(&url)?;
            let status = resp.status();

            if status.as_u16() == 422 {
                let body = resp.text().unwrap_or_default();
                crate::tlog!(
                    "[sync] Search API 422: {} - {}",
                    q,
                    body.chars().take(120).collect::<String>()
                );
                // v0.3.29：422 是对整个 query 无效（限定的 repo 引用不可访问资源），
                // 该源应视为「失败」而非「成功但无结果」，返回 Err 交由调用方计入 failed，
                // 否则会被误当空结果，进而把真实关联任务标记陈旧后移出看板。
                return Err(format!(
                    "Search API 422: {}",
                    body.chars().take(120).collect::<String>()
                ));
            }
            if status.as_u16() == 429 || status.as_u16() == 403 {
                // #328：403 先区分限定流与权限/SSO——后者不能白等 30 秒。
                let Some(retry_after) = self.rate_limit_wait(status.as_u16(), resp.headers())
                else {
                    let body = resp.text().unwrap_or_default();
                    return Err(format!(
                        "GitHub API 错误 ({}): {}{}",
                        status.as_u16(),
                        body.chars().take(160).collect::<String>(),
                        non_rate_limit_hint(status.as_u16())
                    ));
                };
                let wait_ms = (retry_after * 1000).min(MAX_BACKOFF_MS);
                crate::tlog!(
                    "[gh] 限流（{}），等待 {}ms 后重试",
                    status.as_u16(),
                    wait_ms
                );
                std::thread::sleep(Duration::from_millis(wait_ms));
                let resp2 = self.http_get(&url)?;
                let status2 = resp2.status();
                if status2.as_u16() == 422 || !status2.is_success() {
                    let body = resp2.text().unwrap_or_default();
                    crate::tlog!(
                        "[sync] Search API 重试失败 ({}): {}",
                        status2.as_u16(),
                        body.chars().take(120).collect::<String>()
                    );
                    // v0.3.29：重试后仍失败（含 422/非 2xx），视为该源失败，避免被当空结果误删任务。
                    return Err(format!(
                        "Search API 重试失败 ({}): {}",
                        status2.as_u16(),
                        body.chars().take(120).collect::<String>()
                    ));
                }
                let v = resp2
                    .json::<serde_json::Value>()
                    .map_err(|e| e.to_string())?;
                let items = v
                    .get("items")
                    .and_then(|i| i.as_array())
                    .cloned()
                    .unwrap_or_default();
                if items.is_empty() {
                    break;
                }
                push_parsed_items(&mut all, &items);
                // #328：补上与正常路径一致的分页终止条件。重试路径原先漏了它，
                // 满页后还会再打一次必然为空的请求。
                if items.len() < 100 {
                    break;
                }
                continue;
            }
            if !status.is_success() {
                let body = resp.text().unwrap_or_default();
                return Err(format!(
                    "GitHub API 错误 ({}): {}{}",
                    status.as_u16(),
                    body.chars().take(160).collect::<String>(),
                    non_rate_limit_hint(status.as_u16())
                ));
            }
            let v = resp
                .json::<serde_json::Value>()
                .map_err(|e| e.to_string())?;
            let items = v
                .get("items")
                .and_then(|i| i.as_array())
                .cloned()
                .unwrap_or_default();
            if items.is_empty() {
                break;
            }
            push_parsed_items(&mut all, &items);
            // 如果返回的条数少于100，说明已经是最后一页
            if items.len() < 100 {
                break;
            }
        }
        Ok(all)
    }

    /// 带认证的 HTTP GET（复用连接池）。
    fn http_get(&self, url: &str) -> Result<reqwest::blocking::Response, String> {
        self.http
            .get(url)
            .header("Authorization", format!("Bearer {}", self.pat))
            .header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28")
            .timeout(Duration::from_secs(self.http_timeout()))
            .send()
            .map_err(|e| format!("网络请求失败: {}", e))
    }

    /// GraphQL POST（严格模式）：把 query 直接放进 JSON body，任何 `errors` 都算失败。
    pub fn graphql(&self, query: &str) -> Result<serde_json::Value, String> {
        self.graphql_impl(query, true)
    }

    /// #328：宽松模式——只要 `data` 有值就采信，`errors` 仅记日志。
    ///
    /// GraphQL 允许「部分成功」：`data` 有值同时 `errors` 非空（典型：批量查询中某个
    /// 别名指向的资源 NOT_FOUND / FORBIDDEN）。严格模式对 [`Self::fetch_issue_links`]
    /// 这种「25 个编号拼一个查询」的场景代价过大——一个编号失效就让整块 25 个 issue 的
    /// 父子关系全丢。仅用于只读的批量关系查询；写路径一律走严格模式。
    fn graphql_partial(&self, query: &str) -> Result<serde_json::Value, String> {
        self.graphql_impl(query, false)
    }

    /// [`Self::graphql`] / [`Self::graphql_partial`] 的共用实现。
    ///
    /// #328：补上与 `get_impl` 同款的限流处理。GraphQL 有**独立配额**，超限同样返回
    /// 403 + `Retry-After` / `X-RateLimit-*`；原实现只判 `!status.is_success()` 即 `Err`，
    /// 而调用方（`fetch_all_projects` / `status_field` / `fetch_project_issues` /
    /// `fetch_issue_links`）全是 best-effort，于是在限流窗口内**静默降级**：
    /// Project Status 全空、父子关系不更新，用户只看到「数据莫名少了」。
    fn graphql_impl(&self, query: &str, strict_errors: bool) -> Result<serde_json::Value, String> {
        let url = "https://api.github.com/graphql";
        let body = serde_json::json!({ "query": query });
        for attempt in 0..3 {
            // #228：计时（成功/失败都记调用日志，verbose 门控）。
            let start = std::time::Instant::now();
            let resp = self
                .http
                .post(url)
                .header("Authorization", format!("Bearer {}", self.pat))
                .header("Accept", "application/json")
                // #278：`Issue.subIssues` 受 GraphQL feature flag 保护，缺 `GraphQL-Features: sub_issues`
                // 时该字段可能恒返回 null。对不使用该字段的既有查询无副作用，故在所有 GraphQL
                // 请求上一并带上，避免为单一调用点维护第二份 POST 实现（列清单/日志/重试都重复）。
                .header("GraphQL-Features", GRAPHQL_FEATURE_SUB_ISSUES)
                .json(&body)
                .send()
                .map_err(|e| format!("GraphQL 网络请求失败: {}", e))?;
            let status = resp.status();
            // #328：先看响应头判断是不是真限流（403 也可能是权限问题，见 `rate_limit_wait`）；
            // 是限流才等待重试，否则直接落到下面的错误分支并给出权限指引。
            if status.as_u16() == 429 || status.as_u16() == 403 {
                if let Some(retry_after) = self.rate_limit_wait(status.as_u16(), resp.headers()) {
                    let wait_ms = (retry_after * 1000).min(MAX_BACKOFF_MS);
                    crate::tlog!(
                        "[gh] GraphQL 限流（{}），等待 {}ms 后重试（第 {} 次）",
                        status.as_u16(),
                        wait_ms,
                        attempt + 1
                    );
                    std::thread::sleep(Duration::from_millis(wait_ms));
                    continue;
                }
            }
            let v: serde_json::Value = resp
                .json()
                .map_err(|e| format!("解析 GraphQL 返回失败: {}", e))?;
            let elapsed_ms = start.elapsed().as_millis();
            if !status.is_success() {
                let snippet = summarize_text(&v.to_string(), 160);
                log_api_call("POST", query, status.as_u16(), elapsed_ms, &snippet);
                // #235：请求参数 = GraphQL query 文本（不含 PAT）。
                self.emit_api(crate::db::ApiLogEntry::new(
                    "GRAPHQL",
                    &graphql_op_label(query),
                    status.as_u16() as i64,
                    false,
                    elapsed_ms as i64,
                    &summarize_text(query, API_LOG_REQ_MAX),
                    &summarize_text(&v.to_string(), API_LOG_RESP_MAX),
                ));
                return Err(format!(
                    "GraphQL API 错误 ({}): {}{}",
                    status.as_u16(),
                    v.to_string().chars().take(160).collect::<String>(),
                    non_rate_limit_hint(status.as_u16())
                ));
            }
            // HTTP 200 但带 errors：严格模式视为失败；宽松模式在 `data` 有值时采信。
            let mut partial_errors: Option<String> = None;
            if let Some(errs) = v.get("errors") {
                if !errs.is_null() && errs.as_array().map(|a| !a.is_empty()).unwrap_or(false) {
                    if strict_errors || v["data"].is_null() {
                        log_api_call(
                            "POST",
                            query,
                            status.as_u16(),
                            elapsed_ms,
                            &summarize_text(&errs.to_string(), 200),
                        );
                        // #235：HTTP 200 但带 errors 的 GraphQL 也算失败（不能只看状态码）。
                        self.emit_api(crate::db::ApiLogEntry::new(
                            "GRAPHQL",
                            &graphql_op_label(query),
                            status.as_u16() as i64,
                            false,
                            elapsed_ms as i64,
                            &summarize_text(query, API_LOG_REQ_MAX),
                            &summarize_text(&errs.to_string(), API_LOG_RESP_MAX),
                        ));
                        return Err(format!("GraphQL 业务错误: {}", errs));
                    }
                    partial_errors = Some(errs.to_string());
                }
            }
            if let Some(errs) = &partial_errors {
                crate::tlog!(
                    "[gh] GraphQL 部分成功（{}），按可用字段采信",
                    summarize_text(errs, 120)
                );
            }
            log_api_call(
                "POST",
                query,
                status.as_u16(),
                elapsed_ms,
                partial_errors.as_deref().unwrap_or(""),
            );
            self.emit_api(crate::db::ApiLogEntry::new(
                "GRAPHQL",
                &graphql_op_label(query),
                status.as_u16() as i64,
                true,
                elapsed_ms as i64,
                &summarize_text(query, API_LOG_REQ_MAX),
                &summarize_text(&v.to_string(), API_LOG_RESP_MAX),
            ));
            return Ok(v);
        }
        Err(format!(
            "GraphQL 达到最大重试次数（限流持续）: {}",
            graphql_op_label(query)
        ))
    }

    /// 认领 URL（纯函数，可单测）：`POST /repos/{owner}/{repo}/issues/{n}/assignees`。
    pub fn assignees_url(owner: &str, repo: &str, number: i64) -> String {
        format!("https://api.github.com/repos/{owner}/{repo}/issues/{number}/assignees")
    }

    /// 从 issue URL 提取 owner（纯函数，可单测）：`https://github.com/{owner}/{repo}/issues/{n}`。
    /// #214 fallback：老库 `tasks.owner` 存的是账号 org（个人账号为空），为空时用 URL 反推。
    pub fn owner_from_issue_url(url: &str) -> Option<String> {
        let rest = url.trim().strip_prefix("https://github.com/")?;
        let mut segs = rest.split('/').filter(|s| !s.is_empty());
        let owner = segs.next()?.to_string();
        let repo = segs.next()?;
        if repo.is_empty() || owner.is_empty() {
            return None;
        }
        // 至少形如 owner/repo/issues/n（多一段才可信，避免错切）。
        segs.next()?;
        Some(owner)
    }

    /// 写操作错误映射（纯函数，可单测）：401/403/404 给重配指引，其余带状态码+片段。
    pub fn write_error(action: &str, status: u16, body: &str) -> String {
        let snippet: String = body.chars().take(160).collect();
        match status {
            401 => format!("{action}失败：PAT 无效或已过期，请重配 token"),
            403 => format!(
                "{action}失败：PAT 缺少写权限（classic 需 `repo`；fine-grained 需 Issues 读写）或 SSO 未授权。GitHub 返回：{snippet}"
            ),
            404 => format!("{action}失败：仓库不存在或 token 无访问权限。GitHub 返回：{snippet}"),
            _ => format!("{action}失败：GitHub API 错误 ({status}): {snippet}"),
        }
    }

    /// 把 `login` 加为 issue assignee（#214 写回：用户确认框后显式调用）。
    /// 单次请求（写操作不盲目重试）；返回远端确认的 assignees 列表。
    pub fn add_assignee(
        &self,
        owner: &str,
        repo: &str,
        number: i64,
        login: &str,
    ) -> Result<Vec<String>, String> {
        let url = Self::assignees_url(owner, repo, number);
        let body = serde_json::json!({ "assignees": [login] });
        // #214 写回日志：记方法/地址/账号与结果，绝不记 PAT。
        // #228：补请求体摘要（常开，低频）。
        eprintln!(
            "[claim] POST {url} login={login} body={}",
            summarize_text(&body.to_string(), 160)
        );
        let start = std::time::Instant::now();
        let resp = self
            .http
            .post(&url)
            .header("Authorization", format!("Bearer {}", self.pat))
            .header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28")
            .timeout(Duration::from_secs(self.http_timeout()))
            .json(&body)
            .send()
            .map_err(|e| format!("网络请求失败: {}", e))?;
        let status = resp.status().as_u16();
        // POST assignees 成功返回 201（幂等：重复添加同一个人同样成功）。
        if status == 200 || status == 201 {
            let v: serde_json::Value = resp
                .json()
                .map_err(|e| format!("解析 GitHub 返回失败: {}", e))?;
            let names = v
                .get("assignees")
                .and_then(|a| a.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|u| u.get("login").and_then(|l| l.as_str()).map(String::from))
                        .collect()
                })
                .unwrap_or_default();
            let elapsed_ms = start.elapsed().as_millis();
            eprintln!(
                "[claim] GitHub 回应 {status}（{}ms），远端 assignees 已确认：{}",
                elapsed_ms,
                summarize_text(&format!("{names:?}"), 200)
            );
            // #235：落盘请求（POST body + login）与返回（远端确认的 assignees）。
            self.emit_api(crate::db::ApiLogEntry::new(
                "POST",
                &url_display_path(&url),
                status as i64,
                true,
                elapsed_ms as i64,
                &summarize_text(&format!("{body}\nlogin={login}"), API_LOG_REQ_MAX),
                &summarize_text(&v.to_string(), API_LOG_RESP_MAX),
            ));
            return Ok(names);
        }
        let body_text = resp.text().unwrap_or_default();
        let elapsed_ms = start.elapsed().as_millis();
        eprintln!(
            "[claim] GitHub 回应 {status}（{}ms），失败：{}",
            elapsed_ms,
            summarize_text(&body_text, 200)
        );
        // #235：失败也落盘（请求照记，返回为错误体）。
        self.emit_api(crate::db::ApiLogEntry::new(
            "POST",
            &url_display_path(&url),
            status as i64,
            false,
            elapsed_ms as i64,
            &summarize_text(&format!("{body}\nlogin={login}"), API_LOG_REQ_MAX),
            &summarize_text(&body_text, API_LOG_RESP_MAX),
        ));
        Err(Self::write_error("认领", status, &body_text))
    }

    /// Project 状态写回 mutation 文本（纯函数，可单测）。
    pub fn project_status_mutation(
        project_id: &str,
        item_id: &str,
        field_id: &str,
        option_id: &str,
    ) -> String {
        format!(
            r#"mutation {{ updateProjectV2ItemFieldValue(input: {{ projectId: "{project_id}", itemId: "{item_id}", fieldId: "{field_id}", value: {{ singleSelectOptionId: "{option_id}" }} }}) {{ projectV2Item {{ id }} }} }}"#
        )
    }

    /// 设置 Project 条目的 Status（#215 写回：用户确认框后显式调用）。
    pub fn set_project_item_status(
        &self,
        project_id: &str,
        item_id: &str,
        field_id: &str,
        option_id: &str,
    ) -> Result<(), String> {
        // #215 写回日志：记三件套与结果，绝不记 PAT。
        // #228：补请求目标 id（常开，低频）。
        eprintln!("[proj-write] mutation project={project_id} item={item_id} field={field_id} option={option_id}");
        let start = std::time::Instant::now();
        let v = self
            .graphql(&Self::project_status_mutation(
                project_id, item_id, field_id, option_id,
            ))
            .map_err(|e| {
                if e.contains("FORBIDDEN")
                    || e.contains("not accessible")
                    || e.contains("requires")
                    || e.contains("INSUFFICIENT_SCOPES")
                {
                    format!("{e}（解决：classic PAT 去 GitHub Settings → Developer settings → Personal access tokens 勾选 `project` 后重新生成，再到本应用账号管理更新该账号 PAT；fine-grained 则给 Projects 读写权限）")
                } else {
                    format!("状态回写失败：{e}")
                }
            });
        let v = match v {
            Ok(v) => v,
            Err(e) => {
                // #228：失败记返回摘要（常开，低频）。
                eprintln!(
                    "[proj-write] 失败（{}ms）：{}",
                    start.elapsed().as_millis(),
                    summarize_text(&e, 240)
                );
                return Err(e);
            }
        };
        let back = v["data"]["updateProjectV2ItemFieldValue"]["projectV2Item"]["id"]
            .as_str()
            .unwrap_or("");
        if back.is_empty() {
            return Err(
                "状态回写失败：GitHub 未返回确认（mutation 无 projectV2Item.id）".to_string(),
            );
        }
        eprintln!(
            "[proj-write] GitHub 已确认 {}（{}ms）",
            summarize_text(back, 60),
            start.elapsed().as_millis()
        );
        Ok(())
    }

    fn http_timeout(&self) -> u64 {
        30
    }

    /// 解析 `X-RateLimit-Reset`（Unix 时间戳）→ 距今秒数；解析不到返回 None。
    fn seconds_until_reset(&self, headers: &reqwest::header::HeaderMap) -> Option<u64> {
        let ts: i64 = headers
            .get("X-RateLimit-Reset")
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.parse().ok())?;
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        let diff = ts - now;
        if diff <= 0 {
            Some(0)
        } else {
            Some(diff as u64)
        }
    }

    /// #328：判断 403 / 429 是否**真的是限流**，是则返回建议等待秒数。
    ///
    /// GitHub 的 403 有两种完全不同的含义：限流（主配额耗尽 / 二级限流）与
    /// 「token 权限不足 / SSO 未授权 / 组织策略」。原实现对二者一视同仁，缺权限时
    /// 每次请求还要白睡默认 10s（重试 3 次共 ~30s），最后仍然失败。
    ///
    /// 判定依据（`get_impl` / `search` / `graphql` 三处共用，避免各写一套而漂移）：
    /// - 429：本身就是限流；
    /// - 403：仅当 `X-RateLimit-Remaining: 0`（主配额耗尽）**或**存在 `Retry-After`
    ///   （二级限流）时才按限流处理，否则返回 `None`，由调用方立刻报权限错误。
    fn rate_limit_wait(&self, status: u16, headers: &reqwest::header::HeaderMap) -> Option<u64> {
        rate_limit_wait_from_headers(status, headers, now_unix_secs())
    }
}

/// 当前 Unix 秒。抽成自由函数便于限流判定的单测注入固定时间。
fn now_unix_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// [`GitHubClient::rate_limit_wait`] 的纯函数核心（`now` 显式传入，便于单测）。
fn rate_limit_wait_from_headers(
    status: u16,
    headers: &reqwest::header::HeaderMap,
    now: i64,
) -> Option<u64> {
    let retry_after = headers
        .get("Retry-After")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse::<u64>().ok());
    let until_reset = || -> Option<u64> {
        let ts: i64 = headers
            .get("X-RateLimit-Reset")
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.parse().ok())?;
        Some((ts - now).max(0) as u64)
    };
    if status == 429 {
        return Some(retry_after.or_else(until_reset).unwrap_or(10));
    }
    if status != 403 {
        return None;
    }
    let quota_exhausted = headers
        .get("X-RateLimit-Remaining")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.trim().parse::<i64>().ok())
        .map(|r| r <= 0)
        .unwrap_or(false);
    if quota_exhausted {
        return Some(retry_after.or_else(until_reset).unwrap_or(10));
    }
    // 二级限流只有 Retry-After 这一个信号；都没有就是权限/SSO 问题。
    retry_after
}

/// #328：403 但响应头无任何限流信号时的补充说明（拼在错误文案尾部）。
/// 目的是把「等一会儿再试」换成「去检查权限」，避免用户在权限问题上反复重试。
fn non_rate_limit_hint(status: u16) -> &'static str {
    if status == 403 {
        "（403 且响应头无限流信号：更可能是 token 权限不足 / SSO 未授权 / 组织策略限制；\
         请确认 PAT 具备 repo 权限，且该组织已完成 SSO 授权，而不是网络抖动）"
    } else {
        ""
    }
}

/// #328：逐条解析 Search 结果，单条坏数据只跳过它自己。
///
/// 原实现是 `for item in &items { all.push(RawTask::from_item(item)?) }`——一条缺字段的
/// 坏 item 会让整个 `search()` 返回 `Err`，该数据源进 `failed`，同源其它几百条正常数据
/// 一起丢。对照 [`GitHubClient::fetch_prs_for_repo`] 早已是逐条 `filter_map` 跳过坏数据，
/// 两处行为不一致；这里统一为「跳过坏项」。
fn push_parsed_items(all: &mut Vec<RawTask>, items: &[serde_json::Value]) {
    for item in items {
        match RawTask::from_item(item) {
            Ok(t) => all.push(t),
            Err(e) => crate::tlog!("[sync] 跳过无法解析的 Search 结果项: {e}"),
        }
    }
}

/// `test_connection` 返回值：当前只承载 login，后续可扩展（scopes / 过期时间等）。
pub struct TestConnectionResult {
    pub login: String,
}

/// 合并多组搜索结果，按 `repo#number` 去重（后写入者覆盖前者）。
///
/// 与原 gh 实现保持完全一致：sync.rs 依赖这个签名。
pub fn merge_tasks_all(lists: Vec<Vec<RawTask>>) -> Vec<RawTask> {
    let mut map: HashMap<String, RawTask> = HashMap::new();
    for list in lists {
        for t in list {
            map.insert(format!("{}#{}", t.repo, t.number), t);
        }
    }
    map.into_values().collect()
}

/// 日志摘要：空白折叠后按字符截断（纯函数，可单测；多字节安全）。
/// #228：请求/返回记日志时防刷屏。
pub fn summarize_text(s: &str, max: usize) -> String {
    let one_line: String = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if one_line.chars().count() <= max {
        one_line
    } else {
        let mut out: String = one_line.chars().take(max).collect();
        out.push('…');
        out
    }
}

/// 统一 API 调用日志（#228，verbose 门控 `TASKBOARD_LOG=1`）。
/// 高频同步路径默认静默；用户主动写操作另有 `eprintln!` 常开行。
fn log_api_call(method: &str, target: &str, status: u16, elapsed_ms: u128, note: &str) {
    crate::tlog!(
        "[api] {} {} → {} ({}ms) {}",
        method,
        summarize_text(target, 200),
        status,
        elapsed_ms,
        note
    );
}

/// 极简 URL 编码（仅编码 Search API 查询里 unsafe 字符），不依赖 `url` crate。
/// Search API 的 q 值已用 ASCII 字母/数字/冒号/空格，最小集够用。
fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for &b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char);
            }
            _ => {
                out.push_str(&format!("%{:02X}", b));
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// #327：项目条目数必须取 `items.totalCount`，不能取 `number`（那是项目编号）。
    ///
    /// 回归：此前误把 `number` 存进 `projects.number_of_items`，使
    /// `resolve_project_write_target` 的 `ORDER BY number_of_items DESC`
    /// 退化成「按项目编号排序」→ 多 Project 时写错写回目标。
    #[test]
    fn parse_projects_nodes_uses_total_count_not_number() {
        let nodes = vec![
            serde_json::json!({
                "id": "PVT_a", "title": "OMS Kanban", "number": 20,
                "closed": false, "items": { "totalCount": 273 }
            }),
            serde_json::json!({
                "id": "PVT_b", "title": "untitled", "number": 21,
                "closed": false, "items": { "totalCount": 0 }
            }),
            serde_json::json!({
                "id": "PVT_c", "title": "closed", "number": 99,
                "closed": true, "items": { "totalCount": 5 }
            }),
        ];
        let out = GitHubClient::parse_projects_nodes(&nodes, "org");
        assert_eq!(out.len(), 2, "closed 项目应被跳过");
        assert_eq!(out[0].0, "PVT_a");
        assert_eq!(out[0].2, 273, "应取 items.totalCount，而非 number(20)");
        assert_eq!(out[1].2, 0, "空项目应为 0，而非编号 21");
        assert_eq!(out[0].3, "org");

        // 缺 items 字段时回落 0，不 panic
        let empty = GitHubClient::parse_projects_nodes(
            &[serde_json::json!({ "id": "PVT_d", "title": "no items", "closed": false })],
            "user",
        );
        assert_eq!(empty[0].2, 0);
        assert_eq!(empty[0].3, "user");
    }

    /// #327：两处查询串都必须请求 `items { totalCount }`，否则解析不到真实条目数。
    #[test]
    fn projects_queries_request_total_count() {
        assert!(GitHubClient::org_projects_query("acme").contains("items { totalCount }"));
        assert!(GitHubClient::user_projects_query("me").contains("items { totalCount }"));
    }

    /// #214：认领 URL 与写错误映射（纯函数，不碰网络）。
    #[test]
    fn claim_url_and_write_errors() {
        assert_eq!(
            GitHubClient::assignees_url("acme", "web", 7),
            "https://api.github.com/repos/acme/web/issues/7/assignees"
        );
        // owner 缺失时从 URL 反推（老库 owner 列可能为空）。
        assert_eq!(
            GitHubClient::owner_from_issue_url("https://github.com/acme/web/issues/7"),
            Some("acme".to_string())
        );
        assert_eq!(
            GitHubClient::owner_from_issue_url("https://github.com/acme/web/pull/7"),
            Some("acme".to_string())
        );
        assert_eq!(
            GitHubClient::owner_from_issue_url("https://github.com/acme"),
            None
        );
        assert_eq!(GitHubClient::owner_from_issue_url("not a url"), None);
        assert_eq!(GitHubClient::owner_from_issue_url(""), None);
        assert!(GitHubClient::write_error("认领", 401, "").contains("过期"));
        assert!(GitHubClient::write_error("认领", 403, "x").contains("写权限"));
        assert!(GitHubClient::write_error("认领", 404, "x").contains("不存在"));
        assert!(GitHubClient::write_error("认领", 500, "boom").contains("500"));
    }

    /// #215：写回 mutation 文本组装（纯函数，不碰网络）。
    /// #356 防回归：项目条目查询**必须选取 `updatedAt`**。
    ///
    /// 缺陷现场：查询里没有该字段、而 `RawTask.updated_at` 又写死空串 ⇒ 仅经
    /// Project 发现的 issue `updated_at` 恒为 0，卡片日期永久空白。
    ///
    /// **反向验证**：从查询串里删掉 `updatedAt` 时本例必然失败。
    #[test]
    fn project_items_query_selects_updated_at() {
        let q = GitHubClient::project_items_query("PVT_1", "");
        assert!(
            q.contains("updatedAt"),
            "issue 分支必须选取 updatedAt，否则 updated_at 恒为 0"
        );
        // updatedAt 必须落在 Issue 分支里（PullRequest 分支不需要）
        let issue_part = q
            .split("... on Issue")
            .nth(1)
            .and_then(|s| s.split("... on PullRequest").next())
            .expect("应能切出 Issue 分支");
        assert!(
            issue_part.contains("updatedAt"),
            "updatedAt 必须属于 Issue 分支"
        );
        // 分页游标仍正常注入（抽成纯函数后不能漏 after）
        let page2 = GitHubClient::project_items_query("PVT_1", r#", after:"CUR""#);
        assert!(page2.contains(r#", after:"CUR""#), "分页游标必须注入查询");
    }

    /// #407：`project_items_query` 的**完整字段选集**逐条锁定。
    ///
    /// **为什么必须补**：该函数的注释里写着
    /// 「⚠️ issue 分支里的 `updatedAt` **不可删** … **该缺陷已真实发生过一次**」——
    /// 即这个文件**已经被「漏选字段 ⇒ 静默降级」咬过一次**。但当时只补了
    /// `updatedAt` 一条断言，**其余 9 处字段选集全部无人守护**。
    ///
    /// 实测 9 个变异**全部存活**（漏 `pageInfo` / `hasNextPage` / `endCursor` /
    /// `fieldValues` / `assignees` / `labels` / `comments` / `author` /
    /// 把 `first:50` 改成 `first:1`）。后果**全部是静默降级**，不报语法错：
    ///
    /// | 漏选 | 后果 |
    /// |---|---|
    /// | `pageInfo { hasNextPage endCursor }` | **分页在第 50 条停住**，之后的 issue 永不出现 |
    /// | `items(first:50)` | 同上（每次只取 1 条） |
    /// | `fieldValues` | Project Status 列映射丢失 ⇒ 卡片落进 unclassified |
    /// | `assignees` | 归属判定失准（assigned / notassignee 算错） |
    /// | `labels` | label → 状态映射失效 |
    /// | `comments { totalCount }` | 评论数恒 0 |
    /// | `author { login }` | 作者列空白 |
    ///
    /// 与 #407（顶层字段选集）同族：**断言了「构造出的串」，没逐条断言「选了哪些字段」**。
    #[test]
    fn project_items_query_field_selection_is_fully_guarded() {
        let q = GitHubClient::project_items_query("PVT_1", "");

        // ── 分页驱动：漏任一个都会让「第 50 条之后」的 issue 静默消失
        assert!(
            q.contains("pageInfo"),
            "必须选 pageInfo，否则无法判断是否还有下一页"
        );
        assert!(
            q.contains("hasNextPage") && q.contains("endCursor"),
            "pageInfo 必须含 hasNextPage 与 endCursor —— 缺前者无法续拉，缺后者无法定位"
        );
        assert!(
            q.contains("items(first:50"),
            "items 必须取 50 条 —— 改小会静默截断（分页能续拉但代价高，改 0 则完全取不到）"
        );

        // ── 内容字段：逐条列出，每条都对应一个用户可见功能
        for (field, why) in [
            ("fieldValues(first:20)", "Project Status 列映射"),
            ("assignees(first:10)", "归属判定（assigned / notassignee）"),
            ("labels(first:20)", "label → 状态映射"),
            ("comments { totalCount }", "评论数"),
            ("author { login }", "issue 作者"),
            ("repository { name owner { login } }", "仓库归属与颜色映射"),
            ("__typename", "content 的 Issue / PullRequest 分派"),
        ] {
            assert!(q.contains(field), "字段选集缺少 {field} —— 会导致{why}失效");
        }

        // ── 反向契约：`first:N` 的 N 不得被改成 0（0 = 什么都不返回）
        for n in [50, 20, 10] {
            assert!(
                q.contains(&format!("first:{n}")),
                "first:{n} 不得缺失或被改成 0"
            );
        }
        assert!(
            !q.contains("first:0"),
            "任何 first:0 都会让对应字段静默返回空 —— 这是最隐蔽的一种退化"
        );

        // ── 分支结构：updatedAt 属Issue 分支，PullRequest 分支不需要（#356 的既有约定）
        let issue_part = q
            .split("... on Issue")
            .nth(1)
            .and_then(|s| s.split("... on PullRequest").next())
            .expect("应能切出 Issue 分支");
        assert!(
            issue_part.contains("updatedAt"),
            "updatedAt 必须属于 Issue 分支"
        );
        let pr_part = q
            .split("... on PullRequest")
            .nth(1)
            .expect("应能切出 PullRequest 分支");
        assert!(
            !pr_part.contains("updatedAt"),
            "PullRequest 分支不含 updatedAt（GraphQL 会因字段不存在而报错）"
        );
    }

    /// #356：`updatedAt` 缺失 / 为 null 时回落空串，不得 panic。
    #[test]
    fn project_item_updated_at_tolerates_missing_and_null() {
        assert_eq!(
            GitHubClient::project_item_updated_at(
                &serde_json::json!({"updatedAt": "2026-09-20T10:00:00Z"})
            ),
            "2026-09-20T10:00:00Z"
        );
        // 缺失 / null / 非字符串 —— 一律空串（下游 iso8601_to_secs 转 0）
        assert_eq!(
            GitHubClient::project_item_updated_at(&serde_json::json!({})),
            ""
        );
        assert_eq!(
            GitHubClient::project_item_updated_at(&serde_json::json!({"updatedAt": null})),
            ""
        );
        assert_eq!(
            GitHubClient::project_item_updated_at(&serde_json::json!({"updatedAt": 12345})),
            ""
        );
        // 落库侧：真实时间戳能被转成秒（不再是 0）
        assert!(
            crate::common::iso8601_to_secs(&GitHubClient::project_item_updated_at(
                &serde_json::json!({"updatedAt": "2026-09-20T10:00:00Z"})
            )) > 0,
            "真实 updatedAt 必须能转成非 0 秒，否则卡片日期仍为空"
        );
    }

    #[test]
    fn project_status_mutation_shape() {
        let q = GitHubClient::project_status_mutation("P", "I", "F", "O");
        assert!(q.contains("updateProjectV2ItemFieldValue"));
        assert!(q.contains(r#"projectId: "P""#));
        assert!(q.contains(r#"itemId: "I""#));
        assert!(q.contains(r#"fieldId: "F""#));
        assert!(q.contains(r#"singleSelectOptionId: "O""#));
    }

    /// #228：日志摘要截断（空白折叠 + 多字节安全）。
    #[test]
    fn summarize_text_truncates() {
        assert_eq!(summarize_text("a  b\n c", 10), "a b c");
        assert_eq!(summarize_text("123456789", 5), "12345…");
        assert_eq!(summarize_text("开发中测试", 2), "开发…");
        assert_eq!(summarize_text("", 5), "");
    }

    /// #235：URL → 展示 path（去 scheme / host / query）。
    #[test]
    fn url_display_path_strips_host_and_query() {
        assert_eq!(
            url_display_path("https://api.github.com/repos/acme/web/issues?per_page=100"),
            "/repos/acme/web/issues"
        );
        assert_eq!(
            url_display_path("https://api.github.com/graphql"),
            "/graphql"
        );
        // 无 scheme 时按原串取 path。
        assert_eq!(url_display_path("/user"), "/user");
    }

    /// #235：GraphQL 操作标签必须跳过变量声明块，否则会误取变量名。
    #[test]
    fn graphql_op_label_skips_variable_block() {
        assert_eq!(
            graphql_op_label(
                r#"mutation { updateProjectV2ItemFieldValue(input: { projectId: "P" }) { projectV2Item { id } } }"#
            ),
            "updateProjectV2ItemFieldValue"
        );
        assert_eq!(
            graphql_op_label(
                "query($searchQuery: String!) { search(query: $searchQuery) { issueCount } }"
            ),
            "search"
        );
        // 无 query/mutation 前缀时取首个标识符。
        assert_eq!(graphql_op_label("{ viewer { login } }"), "viewer");
    }

    /// 隔离验证：不跑任何 issue 搜索，单独测 `fetch_prs` 能否在测试环境里正常拉到 PR。
    /// 用途：区分环境/rate-limit/网络三类根因。默认忽略，需时
    /// `cargo test --lib -- --ignored test_fetch_prs_isolated` 显式运行。
    #[test]
    #[ignore]
    fn test_fetch_prs_isolated() {
        let pat =
            std::env::var("TASKBOARD_TEST_PAT").expect("需设置 TASKBOARD_TEST_PAT=<GitHub PAT>");
        let login = std::env::var("TASKBOARD_TEST_LOGIN")
            .expect("需设置 TASKBOARD_TEST_LOGIN=<GitHub login>");
        let org = std::env::var("TASKBOARD_TEST_ORG").unwrap_or_else(|_| "FoodsUp-Inc".to_string());
        let client = GitHubClient::new(pat, login, org).expect("客户端构造应成功");
        let repos = vec![
            "fad-backend".to_string(),
            "pq-backend".to_string(),
            "flutter-driver".to_string(),
            "foodsup-client".to_string(),
        ];
        let t0 = std::time::Instant::now();
        let prs = client.fetch_prs(&repos).expect("fetch_prs 不应报错");
        crate::tlog!(
            "[test] 隔离 fetch_prs 拉到 {} 个 PR，耗时 {:.1}s",
            prs.len(),
            t0.elapsed().as_secs_f64()
        );
        assert!(!prs.is_empty(), "隔离调用应至少拉到一个 PR");
        for pr in prs.iter().take(3) {
            assert!(pr.number > 0);
            assert!(pr.url.contains("github.com"));
            assert!(!pr.repo.is_empty(), "repo 应由调用方回填");
        }
    }

    #[test]
    fn test_urlencode() {
        assert_eq!(
            urlencode("org:Foo assignee:bar"),
            "org%3AFoo%20assignee%3Abar"
        );
        assert_eq!(urlencode("a-b_c.d~e"), "a-b_c.d~e");
    }

    /// 回归（v0.3.17 线上事故）：Search API 原始 item 必须手动解析。
    /// 直接 serde 反序列化会因 assignees 是对象数组而报
    /// "invalid type: map, expected a string"，5 源全灭、看板空转。
    #[test]
    fn raw_task_from_search_api_item() {
        let item: serde_json::Value = serde_json::json!({
            "id": 1,
            "number": 1237,
            "title": "[Bug] 手摘/下游Oas 免登录链接未校验",
            "url": "https://api.github.com/repos/FoodsUp-Inc/pq-backend/issues/1237",
            "html_url": "https://github.com/FoodsUp-Inc/pq-backend/issues/1237",
            "state": "open",
            "updated_at": "2026-09-04T10:00:00Z",
            "comments": 3,
            "repository_url": "https://api.github.com/repos/FoodsUp-Inc/pq-backend",
            // #237：Search API 的 `user` 即 issue 创建人。
            "user": {"login": "liushizhao2025", "id": 7},
            "assignees": [
                {"login": "liushizhao2025", "id": 1},
                {"login": "dingminggg", "id": 2}
            ],
            "labels": [{"name": "bug"}]
        });
        let t = RawTask::from_item(&item).expect("解析应成功");
        assert_eq!(t.number, 1237);
        assert_eq!(t.repo, "pq-backend");
        // 网页链接，不是 API URL
        assert_eq!(
            t.url,
            "https://github.com/FoodsUp-Inc/pq-backend/issues/1237"
        );
        assert_eq!(t.assignees, vec!["liushizhao2025", "dingminggg"]);
        assert_eq!(t.comments, 3);
        // #237：创建人取自 user.login（注意 ≠ assignees[0]，两者是不同概念）。
        assert_eq!(t.author, "liushizhao2025");
        assert!(!t.is_pr);
    }

    #[test]
    fn raw_task_detects_pr_and_defaults() {
        let item: serde_json::Value = serde_json::json!({
            "number": 99,
            "title": "feat: x",
            "html_url": "https://github.com/o/r/pull/99",
            "state": "open",
            "updated_at": "2026-09-04T10:00:00Z",
            "repository_url": "https://api.github.com/repos/o/r",
            "pull_request": {"merged_at": null}
            // 无 assignees / comments / user —— default 应生效
        });
        let t = RawTask::from_item(&item).expect("解析应成功");
        assert!(t.is_pr);
        assert!(t.assignees.is_empty());
        assert_eq!(t.comments, 0);
        // #237：缺 user 字段不报错，创建人为空串（卡片不渲染该行）。
        assert_eq!(t.author, "");
    }

    /// 回归：REST pulls 原始 item —— url 应取 html_url（网页链接），
    /// head_ref 应取嵌套 head.ref（直接反序列化恒为空 → 分支信息全丢）。
    #[test]
    fn raw_pr_from_rest_pulls_item() {
        let item: serde_json::Value = serde_json::json!({
            "number": 1252,
            "url": "https://api.github.com/repos/FoodsUp-Inc/pq-backend/pulls/1252",
            "html_url": "https://github.com/FoodsUp-Inc/pq-backend/pull/1252",
            "body": "Closes #1248",
            "head": {"ref": "fix/deliver-assign-at", "sha": "abc"}
        });
        let pr = RawPr::from_item(&item).expect("解析应成功");
        assert_eq!(pr.number, 1252);
        assert_eq!(
            pr.url,
            "https://github.com/FoodsUp-Inc/pq-backend/pull/1252"
        );
        assert_eq!(pr.head_ref, "fix/deliver-assign-at");
        assert_eq!(pr.body, "Closes #1248");
        assert_eq!(pr.repo, "", "repo 由调用方回填");
    }

    // ── #278：父子关系（GraphQL `parent` / `subIssues`）──
    //
    // 网络往返在单测里跑不起，所以把「查询构造」与「返回解析」都抽成纯函数来测：
    // GraphQL 语法错只在真实请求时才暴露（代价高），解析错位会让详情页张冠李戴。

    #[test]
    fn build_links_query_layout() {
        let q = build_links_query("ShawnLiuSZ", "task-dashboard", &[278, 279]);
        assert!(
            q.starts_with("query { r: repository(owner:\"ShawnLiuSZ\", name:\"task-dashboard\") {")
        );
        assert!(q.contains("name owner { login }"));
        // 别名按序号递增，编号原样嵌入。
        assert!(q.contains("a0: issue(number: 278)"));
        assert!(q.contains("a1: issue(number: 279)"));
        // #406：**顶层字段选集**必须显式断言。
        // 原有断言只查了 `issue(number: N)` 这个**参数**，没查节点**选了什么字段** ——
        // 审计实测把 LINK_FRAGMENT 顶层的 `number title url` 去掉（改成 `"title url` 或
        // `"number `），**全部测试仍然通过**。
        //
        // 后果不是语法错而是**静默降级**：
        // · 去掉 `number` ⇒ `parse_links_from_graphql` 的 `n.get("number")` 拿不到值 ⇒
        //   `continue` ⇒ **父子关系整体丢失**，且无任何报错；
        // · 去掉 `title` / `url` ⇒ `link_from_node` 回落到空串 ⇒ 子 issue 卡片与
        //   父链接渲染成空白文案。
        assert!(
            q.contains("a0: issue(number: 278) { number title url"),
            "顶层字段选集必须含 number title url（去掉任一个都会静默降级）"
        );
        // 反向契约：顶层选集**紧接别名之后**就是 number title url，再跟 parent/subIssues。
        // （不能用 `split_once("}")` 切 —— 片段里有嵌套花括号，会把 parent 的内容一起吃进来。）
        let frag = q
            .split_once("a0: issue(number: 278) { ")
            .map(|(_, rest)| rest)
            .expect("应能切出 a0 之后的选集");
        assert!(
            frag.starts_with("number title url parent"),
            "顶层选集应紧接 number title url 再 parent，实际开头：{frag:.60}"
        );
        // 字段选集：parent 必须走 `... on Issue` 内联片段（父节点是 union 类型）。
        assert!(q.contains("parent { ... on Issue { number title url } }"));
        assert!(q.contains("subIssues(first: 50) { nodes { number title url } }"));
        // 每个别名字段都独立闭合，查询整体闭合。
        assert_eq!(q.matches("issue(number:").count(), 2);
        assert!(q.ends_with("} }"));
    }

    #[test]
    fn parse_links_handles_parent_and_sub_issues() {
        let v = serde_json::json!({
            "data": {
                "r": {
                    "name": "task-dashboard",
                    "owner": {"login": "ShawnLiuSZ"},
                    "a0": {
                        "number": 278,
                        "title": "子任务",
                        "url": "https://github.com/o/r/issues/278",
                        "parent": {"number": 100, "title": "epic",
                                   "url": "https://github.com/o/r/issues/100"},
                        "subIssues": {
                            "nodes": [
                                {"number": 279, "title": "a", "url": "https://github.com/o/r/issues/279"},
                                {"number": 280, "title": "跨仓库",
                                 "url": "https://github.com/other/repo/issues/7"}
                            ]
                        }
                    },
                    "a1": {
                        "number": 279,
                        "title": "无关联",
                        "url": "https://github.com/o/r/issues/279",
                        "parent": null,
                        "subIssues": {"nodes": []}
                    }
                }
            }
        });
        let m = parse_links_from_graphql(&v);
        assert_eq!(m.len(), 2);
        let l = &m[&278];
        assert_eq!(
            l.parent,
            Some(IssueLink {
                number: 100,
                title: "epic".into(),
                url: "https://github.com/o/r/issues/100".into()
            })
        );
        assert_eq!(l.sub_issues.len(), 2);
        assert_eq!(l.sub_issues[1].number, 280);
        assert_eq!(
            l.sub_issues[1].url, "https://github.com/other/repo/issues/7",
            "跨仓库子 issue 的 owner/repo 由 url 隐含"
        );
        // 无关联：parent 为 None、sub_issues 为空 vec（非缺键）。
        let l2 = &m[&279];
        assert!(l2.parent.is_none());
        assert!(l2.sub_issues.is_empty());
        assert!(l2.is_empty());
        assert!(!l.is_empty());
    }

    #[test]
    fn parse_links_is_tolerant_of_shape_errors() {
        // 缺 data / r → 空 map，不 panic。
        assert!(parse_links_from_graphql(&serde_json::json!({})).is_empty());
        assert!(parse_links_from_graphql(&serde_json::json!({"data": {}})).is_empty());
        assert!(parse_links_from_graphql(&serde_json::json!({"data": {"r": {}}})).is_empty());
    }

    /// #383：`parse_links_from_graphql` 对**真实响应形状**的解析契约。
    ///
    /// **为什么必须补**：审计前该函数只有两条平凡断言（`{}` 与 `{"data": {}}` → 空），
    /// 即**整条解析路径几乎没有直接覆盖**。变异实测两个关键守卫无人守：
    ///
    /// - 别名前缀过滤 `!key.starts_with('a')` —— 删掉后 `name` / `owner`
    ///   这两个**仓库自身字段**会被当别名处理；
    /// - 纯数字校验 `all(is_ascii_digit)` —— 删掉后 `aX1` 这类脏别名会漏进来。
    ///
    /// 两者当前**都是安全的**，但安全完全依赖一个**未被断言的隐含前提**：
    /// 「`repo` 对象里除别名外只有 `name` / `owner`，且它们不带 `number` 字段」。
    /// 一旦查询选集变化（或 GraphQL 加上 `viewer { ... }` 之类同名字段），就会静默
    /// 把仓库字段当成 issue 解析 —— 而 `name` 是字符串、`as_object()` 返回 `None`
    /// 恰好挡住，所以**连报错都没有**。
    #[test]
    fn parse_links_from_graphql_parses_real_response_shape() {
        // 形状取自 `build_links_query` 生成的查询：别名 `a<序号>` + 仓库自身字段。
        let v = serde_json::json!({
            "data": { "r": {
                // 仓库自身字段：**必须被跳过**（name 是字符串，owner 无 number）
                "name": "my-repo",
                "owner": { "login": "acme" },
                "a1": {
                    "number": 101,
                    "parent": { "number": 100, "title": "父 issue", "url": "https://github.com/acme/my-repo/issues/100" },
                    "subIssues": { "nodes": [
                        { "number": 102, "title": "子 A", "url": "https://github.com/acme/my-repo/issues/102" },
                        { "number": 103, "title": "子 B", "url": "https://github.com/acme/my-repo/issues/103" }
                    ]}
                },
                "a2": {
                    "number": 201,
                    "parent": null,
                    "subIssues": { "nodes": [] }
                }
            }}
        });
        let out = parse_links_from_graphql(&v);
        // 只应有两项：name / owner 不得被当作别名解析进来
        assert_eq!(
            out.len(),
            2,
            "仓库自身字段（name/owner）须被跳过，实际 {:?}",
            out.keys()
        );
        assert!(!out.contains_key(&0), "name 字段被误当别名解析");

        // 父子与子列表内容
        let a1 = out.get(&101).expect("a1 应被解析");
        let parent = a1.parent.as_ref().expect("a1 应有父 issue");
        assert_eq!(parent.number, 100);
        assert_eq!(parent.title, "父 issue");
        assert_eq!(parent.url, "https://github.com/acme/my-repo/issues/100");
        let subs: Vec<i64> = a1.sub_issues.iter().map(|s| s.number).collect();
        assert_eq!(subs, vec![102, 103], "子 issue 顺序与数量须保真");
        assert_eq!(a1.sub_issues[0].title, "子 A", "子 issue 字段须透传");

        // parent 为 null → None（不是 panic，也不是空链接）
        let a2 = out.get(&201).expect("a2 应被解析");
        assert!(a2.parent.is_none(), "parent: null 应得 None");
        assert!(a2.sub_issues.is_empty());
    }

    /// #383：别名守卫的**反向契约** —— 非 `a<纯数字>` 的键一律不得进入结果。
    ///
    /// 与上一条互补：上一条用「真实响应形状」证明跳过逻辑有效；本条直接把
    /// 守卫的判据逐个点名，让删掉任一分支都立刻失败。
    #[test]
    fn parse_links_from_graphql_rejects_non_alias_keys() {
        let v = serde_json::json!({
            "data": { "r": {
                // 以下键都带合法 number，但**不是** `a<纯数字>` 形态
                "name":   { "number": 999 },
                "owner":  { "number": 998 },
                "b1":     { "number": 997 },
                "aX1":    { "number": 996 },   // 别名里混了字母
                "a1x":    { "number": 995 },   // 序号后混了字母
                "a":      { "number": 994 },   // 光秃秃的 a，无序号
                "a-1":    { "number": 993 },
                "a1":     { "number": 101 }    // 唯一合法别名
            }}
        });
        let out = parse_links_from_graphql(&v);
        assert_eq!(
            out.keys().copied().collect::<Vec<_>>(),
            vec![101],
            "只应保留合法别名 a1，实际 {:?}",
            out.keys()
        );
    }

    /// #383：脏数据不得 panic（`serde_json::Value` 全是动态类型）。
    #[test]
    fn parse_links_from_graphql_tolerates_dirty_shapes() {
        for v in [
            serde_json::json!({"data": {"r": null}}),
            serde_json::json!({"data": {"r": []}}), // 非对象
            serde_json::json!({"data": {"r": {"a1": null}}}),
            serde_json::json!({"data": {"r": {"a1": 42}}}), // 节点是数字
            serde_json::json!({"data": {"r": {"a1": {"number": "101"}}}}), // number 类型错
            serde_json::json!({"data": {"r": {"a1": {"number": 101, "subIssues": null}}}}),
            serde_json::json!({"data": {"r": {"a1": {"number": 101, "subIssues": {"nodes": null}}}}}),
            serde_json::json!({"data": {"r": {"a1": {"number": 101, "subIssues": {"nodes": [null, 7]}}}}}),
            serde_json::json!({"data": null}),
        ] {
            // 关键：不 panic；脏形状要么被跳过、要么给出可用的结果
            let _ = parse_links_from_graphql(&v);
        }
        // 最后一例：合法 number + 脏 subIssues → 仍应保留该项
        let v = serde_json::json!({"data": {"r": {"a1": {"number": 101, "subIssues": null}}}});
        let out = parse_links_from_graphql(&v);
        assert!(out.contains_key(&101), "脏 subIssues 不应导致整项被丢弃");
    }

    /// #383：`link_from_node` 缺失 `title` / `url` 时须回落**空串**，而非任意占位。
    ///
    /// 审计实测：把 `unwrap_or("")` 改成 `unwrap_or("X")` **无任何测试失败**。
    /// 该默认值直接进 UI（子 issue 标题、链接文案），故须锁定为「空」而非某个字面量。
    #[test]
    fn link_from_node_defaults_missing_text_fields_to_empty_string() {
        let v = serde_json::json!({
            "data": { "r": { "a1": { "number": 101,
                "parent": { "number": 100 },          // 无 title / url
                "subIssues": { "nodes": [ { "number": 102 } ] }  // 无 title / url
            }}}
        });
        let out = parse_links_from_graphql(&v);
        let a1 = out.get(&101).expect("a1 应被解析");
        let parent = a1.parent.as_ref().expect("parent 应被解析");
        assert_eq!(parent.title, "", "缺失 title 应回落空串");
        assert_eq!(parent.url, "", "缺失 url 应回落空串");
        assert_eq!(a1.sub_issues[0].title, "", "子 issue 缺失 title 应回落空串");
        assert_eq!(a1.sub_issues[0].url, "");
        // 字段类型不符（数字而非字符串）同样回落空串，不 panic
        let v2 = serde_json::json!({
            "data": { "r": { "a1": { "number": 101, "title": 42, "url": 7 } } }
        });
        let out2 = parse_links_from_graphql(&v2);
        let p = &out2[&101].sub_issues;
        assert!(p.is_empty());
        // 编号缺失的节点、非对象别名、缺 number 的子节点都被跳过。
        let v = serde_json::json!({
            "data": {"r": {
                "name": "r", "owner": {"login": "o"},
                "a0": {"title": "no number", "url": "u"},
                "a1": null,
                "a2": {"number": 5, "title": "ok", "url": "https://github.com/o/r/issues/5",
                       "parent": {"title": "parent without number"},
                       "subIssues": {"nodes": [{"number": 6, "title": "x", "url": "u6"},
                                               {"title": "missing number"}]}}
            }}
        });
        let m = parse_links_from_graphql(&v);
        assert_eq!(m.len(), 1);
        let l = &m[&5];
        assert!(l.parent.is_none(), "缺 number 的 parent 应丢弃");
        assert_eq!(l.sub_issues.len(), 1);
        assert_eq!(l.sub_issues[0].number, 6);
    }

    // ========================================================================
    // #342：仓库级失败不得被降级成 Ok(空)
    // ========================================================================

    /// #342 核心防线：**仓库级失败**（改名/转移/删除/token 失权）必须被识别为失败。
    ///
    /// 缺陷现场：GitHub 返回 `{"data":{"r":null},"errors":[…NOT_FOUND…]}`，
    /// 顶层 `data` 是**非 null 的包装对象** ⇒ `graphql_partial` 的 `v["data"].is_null()`
    /// 不触发 ⇒ 宽松放行 ⇒ 解析器返回空 map 而非 `Err` ⇒ 上层 `sync.rs` 视作成功、
    /// `links_failed_repos` 收不到该仓库 ⇒ 已有关联被空值覆盖（父子关系静默清空）。
    ///
    /// **反向验证**：把判据改回「顶层 `data` 是否为 null」时本例必然失败。
    #[test]
    fn repo_level_null_is_detected_as_failure() {
        // 缺陷现场：仓库整体解析失败
        let not_found = serde_json::json!({
            "data": {"r": null},
            "errors": [{"type": "NOT_FOUND", "message": "Could not resolve to a Repository"}]
        });
        // 关键前提：顶层 data 非 null —— 这正是旧判据漏掉它的原因
        assert!(
            !not_found["data"].is_null(),
            "顶层 data 是包装对象，非 null"
        );
        assert!(
            repo_level_failure(&not_found),
            "data.r 为 null ⇒ 仓库级失败"
        );

        // 同类形态：`data.r` 非 null 但不是对象（形状异常时同样不可采信）
        assert!(repo_level_failure(
            &serde_json::json!({"data": {"r": "oops"}})
        ));
        // 缺失 `data` / 缺失 `r` 也算失败（无法确认仓库有效）
        assert!(repo_level_failure(&serde_json::json!({})));
        assert!(repo_level_failure(&serde_json::json!({"data": {}})));
        // data 整体为 null（限流等场景，graphql_partial 已会 Err，这里兜底）
        assert!(repo_level_failure(&serde_json::json!({"data": null})));
    }

    /// #342 反向对照：**仓库有效 + 个别别名 NOT_FOUND** 必须**不算**失败。
    ///
    /// 这是 #328 引入宽松模式的本意，不能被本修复误伤（否则 25 个 issue 的父子
    /// 关系又会因为一个编号被删而整块丢失）。
    #[test]
    fn repo_level_failure_keeps_partial_tolerance() {
        let v = serde_json::json!({
            "data": {"r": {
                "name": "task-dashboard",
                "owner": {"login": "ShawnLiuSZ"},
                "a0": {"number": 278, "title": "ok",
                       "url": "https://github.com/o/r/issues/278",
                       "parent": {"number": 100, "title": "epic",
                                  "url": "https://github.com/o/r/issues/100"}},
                "a1": null   // 个别编号取不到（被删 / 无权）—— 不应整块失败
            }},
            "errors": [{"type": "NOT_FOUND", "path": ["r","a1"]}]
        });
        assert!(
            !repo_level_failure(&v),
            "仓库有效时不得判失败（否则丢掉 #328 的宽松收益）"
        );
        // 且仍应正常解析出 a0 的关联
        let m = parse_links_from_graphql(&v);
        assert_eq!(m.len(), 1);
        assert_eq!(m[&278].parent.as_ref().unwrap().number, 100);
    }

    // ========================================================================
    // #328：限流 / 权限区分 + Search 单条坏数据隔离
    // ========================================================================

    fn hmap(pairs: &[(&'static str, &str)]) -> reqwest::header::HeaderMap {
        let mut h = reqwest::header::HeaderMap::new();
        for (k, v) in pairs {
            h.insert(*k, v.parse::<reqwest::header::HeaderValue>().unwrap());
        }
        h
    }

    /// 403 必须区分「限定流」与「权限不足」——后者原来会白睡默认 10s（三次共 ~30s）。
    /// 反向验证：把 403 分支改回「一律当限流」时，后两条 `None` 断言会失败。
    #[test]
    fn rate_limit_wait_discriminates_permission_from_throttle() {
        let now = 1_700_000_000i64;
        // 403 + 配额耗尽 → 限流，优先 Retry-After
        assert_eq!(
            rate_limit_wait_from_headers(
                403,
                &hmap(&[("X-RateLimit-Remaining", "0"), ("Retry-After", "7")]),
                now
            ),
            Some(7)
        );
        // 403 + 配额耗尽但无 Retry-After → 用 X-RateLimit-Reset 的差值
        assert_eq!(
            rate_limit_wait_from_headers(
                403,
                &hmap(&[
                    ("X-RateLimit-Remaining", "0"),
                    ("X-RateLimit-Reset", "1700000030")
                ]),
                now
            ),
            Some(30)
        );
        // 403 + 二级限流（只有 Retry-After）
        assert_eq!(
            rate_limit_wait_from_headers(403, &hmap(&[("Retry-After", "3")]), now),
            Some(3)
        );
        // 403 + 配额明明还有 → 是权限/SSO 问题，绝不能等待
        assert_eq!(
            rate_limit_wait_from_headers(403, &hmap(&[("X-RateLimit-Remaining", "4999")]), now),
            None
        );
        // 403 + 无任何响应头 → 权限问题
        assert_eq!(rate_limit_wait_from_headers(403, &hmap(&[]), now), None);
        // 429 天然是限流（无头时默认 10s）
        assert_eq!(rate_limit_wait_from_headers(429, &hmap(&[]), now), Some(10));
        // 其它状态码不参与限流判定
        assert_eq!(
            rate_limit_wait_from_headers(404, &hmap(&[("Retry-After", "5")]), now),
            None
        );
        assert_eq!(rate_limit_wait_from_headers(500, &hmap(&[]), now), None);
    }

    /// 非限流 403 的错误文案必须带权限指引（否则用户会以为只是网络抖动）。
    #[test]
    fn permission_hint_only_for_403() {
        assert!(non_rate_limit_hint(403).contains("SSO"));
        assert!(non_rate_limit_hint(404).is_empty());
        assert!(non_rate_limit_hint(500).is_empty());
    }

    /// search() 里一条坏 item 不得拖垮整个数据源（与 `fetch_prs_for_repo` 的
    /// 逐条跳过行为对齐）。反向验证：把 `push_parsed_items` 改回
    /// `all.push(RawTask::from_item(item)?)` 时，`all.len()` 会变成 0 且整体失败。
    #[test]
    fn push_parsed_items_skips_bad_item_instead_of_failing_all() {
        let items = vec![
            serde_json::json!({
                "number": 1,
                "title": "ok",
                "html_url": "https://github.com/o/r/issues/1",
                "repository_url": "https://api.github.com/repos/o/r",
                "state": "open",
                "updated_at": "2026-01-01T00:00:00Z",
                "user": {"login": "alice"}
            }),
            // 缺 repository_url / number / html_url / state / updated_at ⇒ from_item 必然失败
            serde_json::json!({"title": "broken"}),
        ];
        let mut all: Vec<RawTask> = Vec::new();
        push_parsed_items(&mut all, &items);
        assert_eq!(all.len(), 1, "坏 item 应被跳过，而不是让整批失败");
        assert_eq!(all[0].number, 1);
        assert_eq!(all[0].repo, "r");
    }
}

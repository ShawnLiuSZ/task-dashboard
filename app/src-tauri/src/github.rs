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

/// Search API 全局限流门间隔（毫秒）。GitHub Search API 认证后 30 req/min，
/// 折合 1 次/2s。同一客户端实例的多线程共享此门，任意两次 search 调用间隔
/// 不低于该值，避免并发突发触发 429（触发后的退避等待远比这更贵）。
/// v0.3.49 (#143)：替代原来的固定每页 sleep，改为跨线程共享的精确门控。
const SEARCH_GATE_MS: u128 = 2000;

/// 单次请求主动 sleep 上限（毫秒）。某些场景下 `Retry-After` 可能给出极大值，
/// 这里限制上限以免一次同步被挂死——超出后直接放弃本次调用。
const MAX_BACKOFF_MS: u64 = 30_000;

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
    #[serde(default)]
    pub comments: u64,
    #[serde(default)]
    pub is_pr: bool,
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
    /// 旧 gh+jq 管道由 JQ 投影完成这些转换，重写 reqwest 后必须等价实现。
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
        let assignees = v
            .get("assignees")
            .and_then(|a| a.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|u| {
                        u.get("login").and_then(|l| l.as_str()).map(String::from)
                    })
                    .collect()
            })
            .unwrap_or_default();
        let labels = v
            .get("labels")
            .and_then(|a| a.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|u| u.get("name").and_then(|l| l.as_str()).map(String::from))
                    .collect()
            })
            .unwrap_or_default();
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
            comments: v.get("comments").and_then(|x| x.as_u64()).unwrap_or(0),
            is_pr: v.get("pull_request").is_some(),
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
            repo: String::new(), // 调用方按当前仓库回填
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

impl GitHubClient {
    /// 构造客户端。`login` / `org` 为空时仍允许（外部调用方可能用不到）。
    ///
    /// 失败：PAT 为空。鉴权失败/网络错误不在构造时检查——交给 `test_connection` 显式触发，
    /// 这样批量 sync 时构造 N 个客户端不会再触发 N 次探测（每次同步 1 次即可）。
    pub fn new(pat: String, login: String, org: String) -> Result<Self, String> {
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
        Ok(Self { pat, login, org, http, accessible_repos: std::sync::Mutex::new(None), search_gate: std::sync::Mutex::new(None) })
    }

    /// v0.3.49 (#143)：Search 限流门。跨线程共享，调用前等待到距上次 ≥ 2s。
    /// 锁中毒时取内部值继续（门控降级为尽力而为，不阻断同步）。
    fn wait_search_gate(&self) {
        let mut guard = self
            .search_gate
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let now = Instant::now();
        if let Some(last) = *guard {
            let elapsed = now.duration_since(last).as_millis();
            if elapsed < SEARCH_GATE_MS {
                std::thread::sleep(Duration::from_millis(
                    (SEARCH_GATE_MS - elapsed) as u64,
                ));
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
                if arr.is_empty() { break; }
                for repo in arr {
                    if let Some(name) = repo.get("name").and_then(|n| n.as_str()) {
                        repos.push(format!("{}/{}", self.org, name));
                    }
                }
                if arr.len() < 100 { break; }
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
                if arr.is_empty() { break; }
                for repo in arr {
                    if let Some(full_name) = repo.get("full_name").and_then(|n| n.as_str()) {
                        if !repos.iter().any(|r| r == full_name) {
                            repos.push(full_name.to_string());
                        }
                    }
                }
                if arr.len() < 100 { break; }
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
                let repo_qualifiers = repos.iter().map(|r| format!("repo:{}", r)).collect::<Vec<_>>().join(" ");
                format!("{} {}", repo_qualifiers, base_query)
            }
            _ => {
                crate::tlog!("[sync] 无可访问仓库或获取失败，回退到全可见范围搜索: {}", base_query);
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
        let arr = v.as_array().ok_or_else(|| "comments 返回非数组".to_string())?;
        Ok(arr
            .iter()
            .filter_map(|c| c.get("html_url").and_then(|u| u.as_str()).map(String::from))
            .last())
    }

    /// 拉取 GitHub Project「OMS Kanban」中每个 issue 的 Status 字段，
    /// 返回 `repo#number -> Status 原文` 的映射，供 sync 映射到看板四态。
    ///
    /// 为什么需要：看板状态联动不能只看 issue 的 open/closed——团队用 Project 的
    /// Status 字段（如「🔎开发完成/测试中」）表达进度，Search API 不返回该字段。
    /// 拉取当前账号可见的全部 Project v2（组织级 + 用户级）。
    /// 返回 `(github_id, title, number_of_items, owner_type)` 列表。
    pub fn fetch_all_projects(&self) -> Result<Vec<(String, String, i64, String)>, String> {
        let mut out: Vec<(String, String, i64, String)> = Vec::new();

        // 1) 组织级 projectsV2
        let org_q = format!(
            r#"query {{ organization(login:"{org}") {{ projectsV2(first:100, orderBy:{{field:UPDATED_AT,direction:DESC}}) {{ nodes {{ id title number closed }} }} }} }}"#,
            org = self.org
        );
        if let Ok(v) = self.graphql(&org_q) {
            if let Some(nodes) = v["data"]["organization"]["projectsV2"]["nodes"].as_array() {
                for n in nodes {
                    if n["closed"].as_bool() == Some(true) { continue; }
                    if let (Some(id), Some(title)) = (n["id"].as_str(), n["title"].as_str()) {
                        let num = n["number"].as_i64().unwrap_or(0);
                        out.push((id.to_string(), title.to_string(), num, "org".to_string()));
                    }
                }
            }
        }

        // 2) 用户级 projectsV2
        let user_q = format!(
            r#"query {{ user(login:"{login}") {{ projectsV2(first:100, orderBy:{{field:UPDATED_AT,direction:DESC}}) {{ nodes {{ id title number closed }} }} }} }}"#,
            login = self.login
        );
        if let Ok(v) = self.graphql(&user_q) {
            if let Some(nodes) = v["data"]["user"]["projectsV2"]["nodes"].as_array() {
                for n in nodes {
                    if n["closed"].as_bool() == Some(true) { continue; }
                    if let (Some(id), Some(title)) = (n["id"].as_str(), n["title"].as_str()) {
                        let num = n["number"].as_i64().unwrap_or(0);
                        out.push((id.to_string(), title.to_string(), num, "user".to_string()));
                    }
                }
            }
        }

        Ok(out)
    }

    /// 拉取多个 Project 的 Status 条目，合并为 `repo#number -> Status` 映射。
    pub fn fetch_project_status(&self, project_ids: &[String]) -> Result<HashMap<String, String>, String> {
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
            if fname.eq_ignore_ascii_case("Status") || fname.contains("tatus") || fname.contains("状态") {
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
                    crate::tlog!("[gh] project {} field '{}' options={:?}", project_id, fname, result.iter().map(|o| &o.name).collect::<Vec<_>>());
                    return Ok(StatusField { field_id, options: result });
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
                            if field_name.eq_ignore_ascii_case("Status")
                                || field_name.contains("tatus")
                                || field_name.contains("状态")
                            {
                                if !val_name.is_empty() {
                                    status = val_name.to_string();
                                }
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

    /// 拉取项目中全部 issue 条目的完整信息（title, state, labels, assignees 等），
    /// 用于发现「项目中有但搜索源未覆盖」的 issue，合并进同步数据。
    /// 返回 `(status_map, discovered_issues)`。
    pub fn fetch_project_issues(
        &self,
        project_id: &str,
        org: &str,
    ) -> Result<(HashMap<String, String>, Vec<RawTask>, HashMap<String, String>), String> {
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
            let q = format!(
                r#"query {{ node(id:"{pid}") {{ ... on ProjectV2 {{ items(first:50{after}) {{
                  pageInfo {{ hasNextPage endCursor }}
                  nodes {{
                    id
                    content {{
                      __typename
                      ... on Issue {{
                        number title url state
                        repository {{ name owner {{ login }} }}
                        assignees(first:10) {{ nodes {{ login }} }}
                        labels(first:20) {{ nodes {{ name }} }}
                        comments {{ totalCount }}
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
            );
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
                let comments = content["comments"]["totalCount"]
                    .as_u64()
                    .unwrap_or(0);
                let key = format!("{}#{}", repo, num);
                // 提取 Status 字段值
                let mut status = String::new();
                if let Some(fvs) = n["fieldValues"]["nodes"].as_array() {
                    for fv in fvs {
                        let field_name = fv["field"]["name"].as_str().unwrap_or("");
                        let val_name = fv["name"].as_str().unwrap_or("");
                        if field_name.eq_ignore_ascii_case("Status")
                            || field_name.contains("tatus")
                            || field_name.contains("状态")
                        {
                            if !val_name.is_empty() {
                                status = val_name.to_string();
                            }
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
                issues.push(RawTask {
                    number: num,
                    title,
                    url: html_url,
                    state,
                    updated_at: String::new(),
                    repo,
                    repo_owner: owner.to_string(),
                    assignees,
                    labels,
                    comments,
                    is_pr: false,
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
            // 1. 主动限流：响应头 Retry-After 数值（秒）遵守。
            if status.as_u16() == 429 || status.as_u16() == 403 {
                let retry_after = resp
                    .headers()
                    .get("Retry-After")
                    .and_then(|v| v.to_str().ok())
                    .and_then(|s| s.parse::<u64>().ok())
                    .or_else(|| self.seconds_until_reset(resp.headers()))
                    .unwrap_or(10);
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

            // 2. 其它非 2xx（如 404/422/401）：立即返回错误，由 best-effort 逻辑降级。
            if !status.is_success() {
                let body = resp.text().unwrap_or_default();
                log_api_call(
                    "GET",
                    url,
                    status.as_u16(),
                    start.elapsed().as_millis(),
                    &summarize_text(&body, 160),
                );
                return Err(format!(
                    "GitHub API 错误 ({}): {}",
                    status.as_u16(),
                    body.chars().take(160).collect::<String>()
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
                    crate::tlog!(
                        "[gh] 配额剩余 {}，等待 {}ms 回补",
                        r, wait_ms
                    );
                    std::thread::sleep(Duration::from_millis(wait_ms));
                }
            }

            log_api_call("GET", url, status.as_u16(), start.elapsed().as_millis(), "");
            return resp
                .json::<serde_json::Value>()
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
                crate::tlog!("[sync] Search API 422: {} - {}", q, body.chars().take(120).collect::<String>());
                // v0.3.29：422 是对整个 query 无效（限定的 repo 引用不可访问资源），
                // 该源应视为「失败」而非「成功但无结果」，返回 Err 交由调用方计入 failed，
                // 否则会被误当空结果，进而把真实关联任务标记陈旧后移出看板。
                return Err(format!("Search API 422: {}", body.chars().take(120).collect::<String>()));
            }
            if status.as_u16() == 429 || status.as_u16() == 403 {
                let retry_after = resp
                    .headers()
                    .get("Retry-After")
                    .and_then(|v| v.to_str().ok())
                    .and_then(|s| s.parse::<u64>().ok())
                    .or_else(|| self.seconds_until_reset(resp.headers()))
                    .unwrap_or(10);
                let wait_ms = (retry_after * 1000).min(MAX_BACKOFF_MS);
                crate::tlog!("[gh] 限流（{}），等待 {}ms 后重试", status.as_u16(), wait_ms);
                std::thread::sleep(Duration::from_millis(wait_ms));
                let resp2 = self.http_get(&url)?;
                let status2 = resp2.status();
                if status2.as_u16() == 422 || !status2.is_success() {
                    let body = resp2.text().unwrap_or_default();
                    crate::tlog!("[sync] Search API 重试失败 ({}): {}", status2.as_u16(), body.chars().take(120).collect::<String>());
                    // v0.3.29：重试后仍失败（含 422/非 2xx），视为该源失败，避免被当空结果误删任务。
                    return Err(format!("Search API 重试失败 ({}): {}", status2.as_u16(), body.chars().take(120).collect::<String>()));
                }
                let v = resp2.json::<serde_json::Value>().map_err(|e| e.to_string())?;
                let items = v.get("items").and_then(|i| i.as_array()).cloned().unwrap_or_default();
                if items.is_empty() { break; }
                for item in &items {
                    all.push(RawTask::from_item(item)?);
                }
                continue;
            }
            if !status.is_success() {
                let body = resp.text().unwrap_or_default();
                return Err(format!("GitHub API 错误 ({}): {}", status.as_u16(), body.chars().take(160).collect::<String>()));
            }
            let v = resp.json::<serde_json::Value>().map_err(|e| e.to_string())?;
            let items = v.get("items").and_then(|i| i.as_array()).cloned().unwrap_or_default();
            if items.is_empty() { break; }
            for item in &items {
                all.push(RawTask::from_item(item)?);
            }
            // 如果返回的条数少于100，说明已经是最后一页
            if items.len() < 100 { break; }
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

    /// GraphQL POST：把 query 直接放进 JSON body。
    pub fn graphql(&self, query: &str) -> Result<serde_json::Value, String> {
        let url = "https://api.github.com/graphql";
        let body = serde_json::json!({ "query": query });
        // #228：计时（成功/失败都记调用日志，verbose 门控）。
        let start = std::time::Instant::now();
        let resp = self
            .http
            .post(url)
            .header("Authorization", format!("Bearer {}", self.pat))
            .header("Accept", "application/json")
            .json(&body)
            .send()
            .map_err(|e| format!("GraphQL 网络请求失败: {}", e))?;
        let status = resp.status();
        let v: serde_json::Value = resp
            .json()
            .map_err(|e| format!("解析 GraphQL 返回失败: {}", e))?;
        let elapsed_ms = start.elapsed().as_millis();
        if !status.is_success() {
            let snippet = summarize_text(&v.to_string(), 160);
            log_api_call("POST", query, status.as_u16(), elapsed_ms, &snippet);
            return Err(format!(
                "GraphQL API 错误 ({}): {}",
                status.as_u16(),
                v.to_string().chars().take(160).collect::<String>()
            ));
        }
        if let Some(errs) = v.get("errors") {
            if !errs.is_null() && errs.as_array().map(|a| !a.is_empty()).unwrap_or(false) {
                log_api_call(
                    "POST",
                    query,
                    status.as_u16(),
                    elapsed_ms,
                    &summarize_text(&errs.to_string(), 200),
                );
                return Err(format!("GraphQL 业务错误: {}", errs));
            }
        }
        log_api_call("POST", query, status.as_u16(), elapsed_ms, "");
        Ok(v)
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
        if segs.next().is_none() {
            return None;
        }
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
            let v: serde_json::Value =
                resp.json().map_err(|e| format!("解析 GitHub 返回失败: {}", e))?;
            let names = v
                .get("assignees")
                .and_then(|a| a.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|u| {
                            u.get("login").and_then(|l| l.as_str()).map(String::from)
                        })
                        .collect()
                })
                .unwrap_or_default();
            eprintln!(
                "[claim] GitHub 回应 {status}（{}ms），远端 assignees 已确认：{}",
                start.elapsed().as_millis(),
                summarize_text(&format!("{names:?}"), 200)
            );
            return Ok(names);
        }
        let body_text = resp.text().unwrap_or_default();
        eprintln!(
            "[claim] GitHub 回应 {status}（{}ms），失败：{}",
            start.elapsed().as_millis(),
            summarize_text(&body_text, 200)
        );
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
            return Err("状态回写失败：GitHub 未返回确认（mutation 无 projectV2Item.id）".to_string());
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
        assert_eq!(GitHubClient::owner_from_issue_url("https://github.com/acme"), None);
        assert_eq!(GitHubClient::owner_from_issue_url("not a url"), None);
        assert_eq!(GitHubClient::owner_from_issue_url(""), None);
        assert!(GitHubClient::write_error("认领", 401, "").contains("过期"));
        assert!(GitHubClient::write_error("认领", 403, "x").contains("写权限"));
        assert!(GitHubClient::write_error("认领", 404, "x").contains("不存在"));
        assert!(GitHubClient::write_error("认领", 500, "boom").contains("500"));
    }

    /// #215：写回 mutation 文本组装（纯函数，不碰网络）。
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

    /// 隔离验证：不跑任何 issue 搜索，单独测 `fetch_prs` 能否在测试环境里正常拉到 PR。
    /// 用途：区分环境/rate-limit/网络三类根因。默认忽略，需时
    /// `cargo test --lib -- --ignored test_fetch_prs_isolated` 显式运行。
    #[test]
    #[ignore]
    fn test_fetch_prs_isolated() {
        let pat = std::env::var("TASKBOARD_TEST_PAT")
            .expect("需设置 TASKBOARD_TEST_PAT=<GitHub PAT>");
        let login = std::env::var("TASKBOARD_TEST_LOGIN")
            .expect("需设置 TASKBOARD_TEST_LOGIN=<GitHub login>");
        let org = std::env::var("TASKBOARD_TEST_ORG")
            .unwrap_or_else(|_| "FoodsUp-Inc".to_string());
        let client = GitHubClient::new(pat, login, org).expect("客户端构造应成功");
        let repos = vec![
            "fad-backend".to_string(),
            "pq-backend".to_string(),
            "flutter-driver".to_string(),
            "foodsup-client".to_string(),
        ];
        let t0 = std::time::Instant::now();
        let prs = client
            .fetch_prs(&repos)
            .expect("fetch_prs 不应报错");
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
        assert_eq!(urlencode("org:Foo assignee:bar"), "org%3AFoo%20assignee%3Abar");
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
        assert_eq!(t.url, "https://github.com/FoodsUp-Inc/pq-backend/issues/1237");
        assert_eq!(t.assignees, vec!["liushizhao2025", "dingminggg"]);
        assert_eq!(t.comments, 3);
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
            // 无 assignees / comments —— default 应生效
        });
        let t = RawTask::from_item(&item).expect("解析应成功");
        assert!(t.is_pr);
        assert!(t.assignees.is_empty());
        assert_eq!(t.comments, 0);
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
        assert_eq!(pr.url, "https://github.com/FoodsUp-Inc/pq-backend/pull/1252");
        assert_eq!(pr.head_ref, "fix/deliver-assign-at");
        assert_eq!(pr.body, "Closes #1248");
        assert_eq!(pr.repo, "", "repo 由调用方回填");
    }
}

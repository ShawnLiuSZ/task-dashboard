//! #177：一键安装/卸载 agent 看板 hooks（claude-code + opencode，项目/全局两档）。
//!
//! 本仓库根的 `.claude/` / `.opencode/` 只是自用（dogfood）；用户在其他仓库
//! （如 fad-backend）干活时，agent 读的是**那个仓库**的配置。本模块把模板以
//! `include_str!` 内嵌进二进制（单一来源，只在仓库根维护），通过 Tauri command
//! 安装到用户选定的目标（项目仓库目录 / 全局用户目录），同时**合并而非覆盖**
//! 既有配置文件（保留用户自有 hooks，去重后追加 ours；卸载时只摘 ours）。
//!
//! 全局安装说明：hooks 会在该 agent 的所有仓库触发；不在 TaskBoard 看板里的
//! 任务调 MCP 会温和报错"任务不存在"，不写脏数据。opencode 全局的 MCP 注册因
//! `opencode.jsonc` 含注释不做自动合并，只检测并给出手动步骤。

use std::path::{Path, PathBuf};

/// 模板单一来源：仓库根 `.claude/` / `.opencode/`（`src/` → `src-tauri/` → `app/` → 仓库根）。
const SESSION_START_SH: &str = include_str!("../../../.claude/hooks/taskboard-session-start.sh");
const PROMPT_REMINDER_SH: &str = include_str!("../../../.claude/hooks/taskboard-prompt-reminder.sh");
const TASK_START_MD: &str = include_str!("../../../.claude/commands/task-start.md");
const TASK_DONE_MD: &str = include_str!("../../../.claude/commands/task-done.md");
const TASK_HANDOFF_MD: &str = include_str!("../../../.claude/commands/task-handoff.md");
const OPENCODE_PLUGIN_JS: &str = include_str!("../../../.opencode/plugins/taskboard.js");
const OC_TASK_START_MD: &str = include_str!("../../../.opencode/commands/task-start.md");
const OC_TASK_DONE_MD: &str = include_str!("../../../.opencode/commands/task-done.md");
const OC_TASK_HANDOFF_MD: &str = include_str!("../../../.opencode/commands/task-handoff.md");

/// hook 命令的去重后缀（按此子串匹配 ours；与具体配置根无关，dev/正式版路径迁移同样命中）。
const HOOK_SESSION_CMD_SUFFIX: &str = "hooks/taskboard-session-start.sh";
const HOOK_PROMPT_CMD_SUFFIX: &str = "hooks/taskboard-prompt-reminder.sh";

fn err(s: impl Into<String>) -> String {
    s.into()
}

/// 目标目录校验：必须存在且为目录；所有写入限定在 `<target>/.claude/**` 内。
fn resolve_target(target_dir: &str) -> Result<PathBuf, String> {
    let t = target_dir.trim();
    if t.is_empty() {
        return Err(err("目标目录不能为空"));
    }
    let p = PathBuf::from(t);
    if !p.is_dir() {
        return Err(err(format!("目标目录不存在或不是目录: {t}")));
    }
    Ok(p)
}

fn write_file(path: &Path, content: &str, executable: bool) -> Result<bool, String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| err(format!("创建目录失败 {}: {e}", parent.display())))?;
    }
    let changed = match std::fs::read_to_string(path) {
        Ok(old) => old != content,
        Err(_) => true,
    };
    if changed {
        std::fs::write(path, content)
            .map_err(|e| err(format!("写入文件失败 {}: {e}", path.display())))?;
    }
    #[cfg(unix)]
    if executable {
        use std::os::unix::fs::PermissionsExt;
        let mut perm = std::fs::metadata(path)
            .map_err(|e| err(format!("读取权限失败: {e}")))?
            .permissions();
        perm.set_mode(0o755);
        std::fs::set_permissions(path, perm).map_err(|e| err(format!("设置可执行位失败: {e}")))?;
    }
    Ok(changed)
}

/// 合并 settings.json：保留用户原有 hooks，去重后追加 ours。返回 (json文本, 是否有变更）。
///
/// `script_cmd_prefix` 为 hook 脚本所在目录的命令前缀：项目级用
/// `"${CLAUDE_PROJECT_DIR}/.claude"`（跟随仓库走），全局用对应配置根的绝对路径。
/// 命令整体加双引号（路径含空格时不断裂；旧版未加引号的条目按后缀去重自动迁移）。
fn merged_settings(existing: Option<&str>, script_cmd_prefix: &str) -> Result<(String, bool), String> {
    let mut root: serde_json::Value = match existing {
        Some(s) if !s.trim().is_empty() => {
            serde_json::from_str(s).map_err(|e| err(format!("已有 .claude/settings.json 解析失败（未改动）: {e}")))?
        }
        _ => serde_json::json!({}),
    };
    if !root.is_object() {
        return Err(err("已有 .claude/settings.json 顶层不是 object（未改动）"));
    }
    let before = root.clone();

    let hooks = root
        .as_object_mut()
        .expect("checked object")
        .entry("hooks")
        .or_insert_with(|| serde_json::json!({}));
    if !hooks.is_object() {
        return Err(err("已有 settings.json 的 hooks 不是 object（未改动）"));
    }
    let hooks_obj = hooks.as_object_mut().expect("checked object");

    for (event, suffix) in [
        ("SessionStart", HOOK_SESSION_CMD_SUFFIX),
        ("UserPromptSubmit", HOOK_PROMPT_CMD_SUFFIX),
    ] {
        let arr = hooks_obj
            .entry(event)
            .or_insert_with(|| serde_json::json!([]));
        let groups = arr.as_array_mut().ok_or_else(|| err(format!("已有 hooks.{event} 不是数组（未改动）")))?;
        // 去重：删掉之前版本装进去的同名 hook（幂等重装），保留用户其他的。
        for g in groups.iter_mut() {
            if let Some(handlers) = g.get_mut("hooks").and_then(|h| h.as_array_mut()) {
                handlers.retain(|h| {
                    h.get("command")
                        .and_then(|c| c.as_str())
                        .map(|c| !c.contains(suffix))
                        .unwrap_or(true)
                });
            }
        }
        groups.push(serde_json::json!({
            "matcher": "",
            "hooks": [{ "type": "command", "command": format!("\"{script_cmd_prefix}/{suffix}\""), "timeout": 10 }]
        }));
        // 清理因去重变空的组，避免残留空壳。
        groups.retain(|g| {
            g.get("hooks")
                .and_then(|h| h.as_array())
                .map(|a| !a.is_empty())
                .unwrap_or(true)
        });
    }

    let changed = root != before;
    let text = serde_json::to_string_pretty(&root).map_err(|e| err(format!("序列化失败: {e}")))?;
    Ok((text + "\n", changed))
}

/// 模板文件清单（相对路径，内容，是否可执行）。安装/卸载/状态共用。
/// 路径均相对于各 agent 的配置根（项目：`<repo>/.claude`；全局：`~/.claude`）。
fn claude_files() -> [(&'static str, &'static str, bool); 5] {
    [
        ("hooks/taskboard-session-start.sh", SESSION_START_SH, true),
        ("hooks/taskboard-prompt-reminder.sh", PROMPT_REMINDER_SH, true),
        ("commands/task-start.md", TASK_START_MD, false),
        ("commands/task-done.md", TASK_DONE_MD, false),
        ("commands/task-handoff.md", TASK_HANDOFF_MD, false),
    ]
}

/// opencode 模板清单（相对于 `.opencode` 配置根：项目 `<repo>/.opencode`；
/// 全局 `~/.config/opencode`）。
fn opencode_files() -> [(&'static str, &'static str, bool); 4] {
    [
        ("plugins/taskboard.js", OPENCODE_PLUGIN_JS, false),
        ("commands/task-start.md", OC_TASK_START_MD, false),
        ("commands/task-done.md", OC_TASK_DONE_MD, false),
        ("commands/task-handoff.md", OC_TASK_HANDOFF_MD, false),
    ]
}

// ================= agent 注册表（Clawd 式 per-agent 安装器） =================
//
// id 取任务详情 session 下拉的 value（前后端同一套），一键安装覆盖其中已验证
// hook 机制的 agent；其余走手动指引（manual_hint，不伪造成功）。

/// 单个 agent 的安装契约。
struct AgentSpec {
    id: &'static str,
    /// 项目级配置目录名（仅 claude-code / opencode；其余 None = 仅支持全局）。
    project_dir: Option<&'static str>,
    /// `$HOME` 下的全局配置候选（按序）：首个按目录存在命中，其余按 settings 文件
    /// 存在命中（workbuddy legacy 规则：裸目录可能是工具链，需 settings.json 佐证）。
    global_candidates: &'static [&'static str],
    /// 需要合并的 settings 文件（claude 系有；opencode 插件目录自动扫描，无需改配置）。
    settings_name: Option<&'static str>,
    /// 项目级 MCP 注册文件（opencode 有；其余 MCP 配在用户级，由用户自理）。
    mcp_file: Option<&'static str>,
    /// hook 脚本是否用 Claude 专用文案（${CLAUDE_SESSION_ID} / /task-start）；
    /// false 则用通用变体（MCP 直调指引）。
    claude_copy: bool,
}

const AGENTS: [AgentSpec; 5] = [
    AgentSpec {
        id: "claude-code",
        project_dir: Some(".claude"),
        global_candidates: &[".claude"],
        settings_name: Some("settings.json"),
        mcp_file: None,
        claude_copy: true,
    },
    AgentSpec {
        id: "opencode",
        project_dir: Some(".opencode"),
        global_candidates: &[".config/opencode"],
        settings_name: None,
        mcp_file: Some("opencode.json"),
        claude_copy: true,
    },
    AgentSpec {
        id: "workbuddy",
        project_dir: None,
        global_candidates: &[".workbuddy-ai", ".workbuddy"],
        settings_name: Some("settings.json"),
        mcp_file: None,
        claude_copy: false,
    },
    AgentSpec {
        id: "codebuddy",
        project_dir: None,
        global_candidates: &[".codebuddy"],
        settings_name: Some("settings.json"),
        mcp_file: None,
        claude_copy: false,
    },
    AgentSpec {
        id: "trae",
        project_dir: None,
        global_candidates: &[".trae-cn"],
        settings_name: Some("hooks.json"),
        mcp_file: None,
        claude_copy: false,
    },
];

fn spec_of(agent: &str) -> Option<&'static AgentSpec> {
    AGENTS.iter().find(|a| a.id == agent)
}

/// 未验证一键安装的 agent 的手动指引（配置路径来自 clawd-on-desk 的公开文档汇编，
/// 仅作指路，不做自动写）。
fn manual_hint(agent: &str) -> &'static str {
    match agent {
        "codex" => "Codex hooks 为实验性：~/.codex/ 下配 hooks.json 并开启 codex_hooks，详见 AGENT_INSTRUCTIONS",
        "cursor" => "~/.cursor/hooks.json（Cursor IDE hooks），详见 AGENT_INSTRUCTIONS",
        "copilot" => "~/.copilot/hooks/hooks.json，详见 AGENT_INSTRUCTIONS",
        "gemini-cli" => "~/.gemini/settings.json，详见 AGENT_INSTRUCTIONS",
        "qwen-code" => "~/.qwen/settings.json，详见 AGENT_INSTRUCTIONS",
        "kimi" => "~/.kimi/config.toml [[hooks]]，详见 AGENT_INSTRUCTIONS",
        "zcode" => "~/.zcode/cli/config.json → hooks.events，详见 AGENT_INSTRUCTIONS",
        _ => "见 mcp_server/AGENT_INSTRUCTIONS.md 手工配置",
    }
}

/// 非 Claude agent 的脚本变体：去掉 `${CLAUDE_SESSION_ID}` 与 `/task-start` slash
/// 引用（这些 agent 不一定有 slash 命令），改为 MCP 直调指引。基于模板精确替换，
/// 替换失败则回退 Claude 原文（测试断言覆盖关键 token）。
fn script_variant(content: &str) -> String {
    content
        .replace(
            "（slash command 里可用 ${CLAUDE_SESSION_ID}；Bash 里可用 $TASKBOARD_SESSION_ID，二者同值。）",
            "（Bash 里可用 $TASKBOARD_SESSION_ID。）",
        )
        // 头部注释里的同类引用一并中性化（hook stdout 不含注释，但 agent 可能读文件）
        .replace("；slash command 里也可用 ${CLAUDE_SESSION_ID}", "")
        .replace("（或 /task-start）", "")
        .replace(
            "快捷方式：直接执行 /task-start <repo#num>。完成时 /task-done，交接时 /task-handoff。",
            "直接调 MCP 看板工具：先 get_task_status 查现状，再 update_task_status（处理中）+ record_session；完工更新已完成、中途交接记 handoff。",
        )
        .replace(
            "然后 /task-start <repo#num> （自动完成 update_task_status→处理中 + record_session 含分支）；完工 /task-done，中途交接 /task-handoff。",
            "然后调 update_task_status（处理中）+ record_session；完工更新已完成、中途交接记 handoff。",
        )
}

fn files_of(agent: &str) -> Vec<(&'static str, String, bool)> {
    let raw: Vec<(&'static str, &'static str, bool)> = match agent {
        "opencode" => opencode_files().into_iter().collect(),
        _ => claude_files().into_iter().collect(),
    };
    let generic = !matches!(spec_of(agent).map(|s| s.claude_copy), Some(true));
    raw.into_iter()
        .filter(|(rel, _, _)| {
            // 无 slash 命令机制的 agent 只装 hooks 脚本，不装 commands
            agent == "claude-code" || agent == "opencode" || !rel.starts_with("commands/")
        })
        .map(|(rel, content, exec)| {
            let body = if generic && rel.ends_with(".sh") {
                script_variant(content)
            } else {
                content.to_string()
            };
            (rel, body, exec)
        })
        .collect()
}

/// 解析用户请求：scope 必须 project|global；agents 去重（未知 id 不报错，
/// 安装/卸载/状态时按手动指引返回 notice，不伪造成功）。
fn parse_request(
    scope: &str,
    target_dir: Option<String>,
    agents: Vec<String>,
) -> Result<(bool, Option<PathBuf>, Vec<String>), String> {
    let global = match scope.trim() {
        "global" => true,
        "project" => false,
        s => return Err(err(format!("非法 scope: {s}（应为 project / global）"))),
    };
    let mut seen = std::collections::HashSet::new();
    let mut list = Vec::new();
    for a in agents {
        let a = a.trim().to_string();
        if a.is_empty() {
            continue;
        }
        if seen.insert(a.clone()) {
            list.push(a);
        }
    }
    if list.is_empty() {
        return Err(err("至少选择一个 agent"));
    }
    let target = if global {
        None
    } else {
        Some(resolve_target(&target_dir.unwrap_or_default())?)
    };
    Ok((global, target, list))
}

fn home_dir() -> Result<PathBuf, String> {
    dirs::home_dir().ok_or_else(|| err("无法定位用户主目录"))
}

/// agent 在某作用域下的配置根。global 下按候选规则解析（首个目录命中，其余需
/// settings 文件佐证），解析不到返回 None（调用方报跳过）。
fn config_root(home: &Path, project: Option<&Path>, agent: &AgentSpec) -> Option<PathBuf> {
    match project {
        Some(p) => agent.project_dir.map(|d| p.join(d)),
        None => {
            let mut iter = agent.global_candidates.iter();
            let first = iter.next()?;
            let first_dir = home.join(first);
            if first_dir.is_dir() {
                return Some(first_dir);
            }
            for c in iter {
                let d = home.join(c);
                if let Some(name) = agent.settings_name {
                    if d.join(name).is_file() {
                        return Some(d);
                    }
                } else if d.is_dir() {
                    return Some(d);
                }
            }
            None
        }
    }
}

/// UI 展示用路径（`~/.claude/...` / `.claude/...` 形式）。
fn display_path(home: &Path, project: Option<&Path>, path: &Path) -> String {
    if project.is_some() {
        if let Some(proj) = project {
            if let Ok(rel) = path.strip_prefix(proj) {
                return rel.display().to_string();
            }
        }
    }
    if let Ok(rel) = path.strip_prefix(home) {
        return format!("~/{}", rel.display());
    }
    path.display().to_string()
}

/// 原子写：tmp + rename，避免崩溃留半文件（Clawd 同款）。
fn write_atomic(path: &Path, content: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| err(format!("创建目录失败 {}: {e}", parent.display())))?;
    }
    let tmp = path.with_extension("taskboard-tmp");
    std::fs::write(&tmp, content).map_err(|e| err(format!("写入临时文件失败: {e}")))?;
    std::fs::rename(&tmp, path).map_err(|e| err(format!("原子替换失败 {}: {e}", path.display())))?;
    Ok(())
}

/// 卸载改动配置文件前留备份（仅首份，不覆写已有备份）。
fn backup_once(path: &Path) -> Result<Option<String>, String> {
    let bak = path.with_extension("taskboard-bak");
    if !bak.exists() {
        std::fs::copy(path, &bak).map_err(|e| err(format!("备份失败: {e}")))?;
        return Ok(Some(bak.display().to_string()));
    }
    Ok(None)
}

/// 本 app 二进制绝对路径（opencode.json 的 MCP command 用；dev/正式版路径不同无妨，
/// 重装时按 basename 原位更新）。
fn mcp_bin() -> Result<String, String> {
    std::env::current_exe()
        .map(|p| p.display().to_string())
        .map_err(|e| err(format!("无法定位 app 二进制: {e}")))
}

fn exe_basename(cmd: &str) -> String {
    cmd.replace('\\', "/").rsplit('/').next().unwrap_or("").to_string()
}

/// 合并项目级 `opencode.json` 的 `mcp.taskboard`。
/// 已有条目且命令 basename 也是 taskboard* → 原位更新（dev/正式版路径迁移）；
/// 已有条目但指向别处 → 保留 + notice。返回 (changed, notice)。
fn merge_opencode_mcp(repo: &Path, mcp_file: &str, exe: &str) -> Result<(bool, Option<String>), String> {
    let path = repo.join(mcp_file);
    let mut root: serde_json::Value = match std::fs::read_to_string(&path) {
        Ok(s) if !s.trim().is_empty() => {
            serde_json::from_str(&s).map_err(|e| err(format!("已有 opencode.json 解析失败（未改动）: {e}")))?
        }
        _ => serde_json::json!({}),
    };
    if !root.is_object() {
        return Err(err("已有 opencode.json 顶层不是 object（未改动）".to_string()));
    }
    let before = root.clone();
    let mut notice = None;
    {
        let mcp = root
            .as_object_mut()
            .expect("checked object")
            .entry("mcp")
            .or_insert_with(|| serde_json::json!({}));
        let mcp_obj =
            mcp.as_object_mut().ok_or_else(|| err("已有 opencode.json 的 mcp 不是 object（未改动）"))?;
        let want = serde_json::json!({"type": "local", "command": [exe, "mcp"], "enabled": true});
        match mcp_obj.get("taskboard") {
            None => {
                mcp_obj.insert("taskboard".into(), want);
            }
            Some(cur) => {
                let cur_bin = cur
                    .get("command")
                    .and_then(|c| c.as_array())
                    .and_then(|a| a.first())
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                if exe_basename(cur_bin).starts_with("taskboard") {
                    mcp_obj.insert("taskboard".into(), want);
                } else {
                    notice = Some(format!(
                        "已保留 opencode.json 既有 taskboard MCP 配置（{cur_bin}），未覆盖"
                    ));
                }
            }
        }
    }
    if root == before {
        return Ok((false, notice));
    }
    let text =
        serde_json::to_string_pretty(&root).map_err(|e| err(format!("序列化失败: {e}")))?;
    write_atomic(&path, &(text + "\n"))?;
    Ok((true, notice))
}

/// 全局 opencode 的 MCP 注册只检测不自动合并（jsonc 含注释，自动改写会丢注释）。
/// 返回 None 表示已注册；Some 为手动步骤提示。
fn global_opencode_mcp_notice(home: &Path, exe: &str) -> Option<String> {
    let dir = home.join(".config").join("opencode");
    for name in ["config.json", "opencode.json", "opencode.jsonc"] {
        if let Ok(s) = std::fs::read_to_string(dir.join(name)) {
            if s.contains("\"taskboard\"") {
                return None;
            }
        }
    }
    Some(format!(
        "全局 opencode 未注册 taskboard MCP（jsonc 不自动合并，请手动在全局配置的 mcp 中加：\"taskboard\": {{\"type\": \"local\", \"command\": [\"{exe}\", \"mcp\"], \"enabled\": true}}）"
    ))
}

/// 安装结果（camelCase 供前端直接展示）。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallResult {
    pub scope: String,
    pub target: String,
    pub files_written: Vec<String>,
    pub settings_merged: bool,
    pub mcp_configured: bool,
    pub notices: Vec<String>,
}

impl InstallResult {
    fn empty(scope: &str, target: &str) -> Self {
        InstallResult {
            scope: scope.to_string(),
            target: target.to_string(),
            files_written: Vec::new(),
            settings_merged: false,
            mcp_configured: false,
            notices: Vec::new(),
        }
    }
}

/// 单 agent 安装。project.global 下 host 未装则跳过（不污染）。
fn install_one(
    home: &Path,
    project: Option<&Path>,
    agent_id: &str,
    exe: &str,
    res: &mut InstallResult,
) -> Result<(), String> {
    let Some(spec) = spec_of(agent_id) else {
        res.notices.push(format!("{agent_id}：暂不支持一键安装。{hint}", hint = manual_hint(agent_id)));
        return Ok(());
    };
    let Some(root) = config_root(home, project, spec) else {
        if project.is_some() {
            res.notices.push(format!("{agent_id}：仅支持全局安装，项目级请手工配置"));
        } else {
            res.notices.push(format!("{agent_id}：未检测到全局配置（host 疑似未安装），已跳过"));
        }
        return Ok(());
    };
    for (rel, content, exec) in files_of(agent_id) {
        let p = root.join(rel);
        if write_file(&p, &content, exec)? {
            res.files_written.push(display_path(home, project, &p));
        }
    }
    if let Some(settings_name) = spec.settings_name {
        let sp = root.join(settings_name);
        // 命令前缀：项目级跟仓库走（Claude 变量），全局用配置根绝对路径
        // （merged_settings 统一加双引号，含空格路径不断裂）
        let prefix = match project {
            Some(_) => format!("${{CLAUDE_PROJECT_DIR}}/{}", spec.project_dir.unwrap_or(".claude")),
            None => root.display().to_string(),
        };
        let existing = std::fs::read_to_string(&sp).ok();
        let (merged, changed) = merged_settings(existing.as_deref(), &prefix)?;
        if changed || !sp.exists() {
            write_atomic(&sp, &merged)?;
            res.files_written.push(display_path(home, project, &sp));
            res.settings_merged = true;
        }
    } else if let Some(proj) = project {
        let mcp_file = spec.mcp_file.unwrap_or("opencode.json");
        let (changed, notice) = merge_opencode_mcp(proj, mcp_file, exe)?;
        res.mcp_configured = true;
        if changed {
            res.files_written.push(mcp_file.to_string());
        }
        if let Some(n) = notice {
            res.notices.push(n);
        }
    } else if let Some(n) = global_opencode_mcp_notice(home, exe) {
        res.notices.push(n);
    } else {
        res.mcp_configured = true;
    }
    Ok(())
}

/// 卸载结果。`files_kept` 为内容与模板不一致、为安全保留的文件。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UninstallResult {
    pub scope: String,
    pub target: String,
    pub files_removed: Vec<String>,
    pub files_kept: Vec<String>,
    pub settings_cleaned: bool,
    pub backups: Vec<String>,
    pub notices: Vec<String>,
}

impl UninstallResult {
    fn empty(scope: &str, target: &str) -> Self {
        UninstallResult {
            scope: scope.to_string(),
            target: target.to_string(),
            files_removed: Vec::new(),
            files_kept: Vec::new(),
            settings_cleaned: false,
            backups: Vec::new(),
            notices: Vec::new(),
        }
    }
}

/// 删空的子目录（hooks/commands/plugins），非空保留。
fn prune_empty_subdirs(root: &Path) {
    for d in ["hooks", "commands", "plugins"] {
        let dir = root.join(d);
        if dir.is_dir()
            && std::fs::read_dir(&dir).map(|mut it| it.next().is_none()).unwrap_or(false)
        {
            let _ = std::fs::remove_dir(&dir);
        }
    }
}

/// 项目级 opencode.json 摘除 mcp.taskboard（仅当命令指向 ours：相等或 basename taskboard*）。
/// 返回 (changed, file_deleted, notice)。
fn strip_opencode_mcp(repo: &Path, mcp_file: &str, exe: &str) -> Result<(bool, bool, Option<String>), String> {
    let path = repo.join(mcp_file);
    let existing = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(_) => return Ok((false, false, None)),
    };
    let mut root: serde_json::Value = serde_json::from_str(&existing)
        .map_err(|e| err(format!("已有 opencode.json 解析失败（未改动）: {e}")))?;
    if !root.is_object() {
        return Err(err("已有 opencode.json 顶层不是 object（未改动）".to_string()));
    }
    let before = root.clone();
    let mut notice = None;
    if let Some(mcp_obj) = root.get_mut("mcp").and_then(|m| m.as_object_mut()) {
        let ours = match mcp_obj.get("taskboard") {
            None => false,
            Some(cur) => {
                let cur_bin = cur
                    .get("command")
                    .and_then(|c| c.as_array())
                    .and_then(|a| a.first())
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                if cur_bin == exe || exe_basename(cur_bin).starts_with("taskboard") {
                    true
                } else {
                    notice = Some(format!(
                        "opencode.json 的 taskboard MCP 指向别处（{cur_bin}），已保留"
                    ));
                    false
                }
            }
        };
        if ours {
            mcp_obj.remove("taskboard");
        }
        if mcp_obj.is_empty() {
            root.as_object_mut().expect("checked object").remove("mcp");
        }
    }
    if root == before {
        return Ok((false, false, notice));
    }
    if root.as_object().map(|o| o.is_empty()).unwrap_or(false) {
        std::fs::remove_file(&path).map_err(|e| err(format!("删除 opencode.json 失败: {e}")))?;
        return Ok((true, true, notice));
    }
    let text =
        serde_json::to_string_pretty(&root).map_err(|e| err(format!("序列化失败: {e}")))?;
    write_atomic(&path, &(text + "\n"))?;
    Ok((true, false, notice))
}

/// 单 agent 卸载：只删内容与模板一致的文件；settings 改动前备份。
fn uninstall_one(
    home: &Path,
    project: Option<&Path>,
    agent_id: &str,
    exe: &str,
    res: &mut UninstallResult,
) -> Result<(), String> {
    let Some(spec) = spec_of(agent_id) else {
        res.notices.push(format!("{agent_id}：暂不支持一键卸载。{hint}", hint = manual_hint(agent_id)));
        return Ok(());
    };
    let Some(root) = config_root(home, project, spec) else {
        res.notices.push(format!("{agent_id}：未检测到全局配置，已跳过"));
        return Ok(());
    };
    for (rel, content, _) in files_of(agent_id) {
        let p = root.join(rel);
        match std::fs::read_to_string(&p) {
            Ok(old) if old == content => {
                std::fs::remove_file(&p).map_err(|e| err(format!("删除失败 {}: {e}", p.display())))?;
                res.files_removed.push(display_path(home, project, &p));
            }
            Ok(_) => res.files_kept.push(display_path(home, project, &p)),
            Err(_) => {}
        }
    }
    prune_empty_subdirs(&root);
    if let Some(settings_name) = spec.settings_name {
        let sp = root.join(settings_name);
        if let Ok(existing) = std::fs::read_to_string(&sp) {
            let (new_text, changed) = stripped_settings(&existing)?;
            if changed {
                if let Some(b) = backup_once(&sp)? {
                    res.backups.push(b);
                }
                match new_text {
                    Some(t) => write_atomic(&sp, &t)?,
                    None => {
                        std::fs::remove_file(&sp)
                            .map_err(|e| err(format!("删除 {settings_name} 失败: {e}")))?;
                        res.files_removed.push(display_path(home, project, &sp));
                    }
                }
                res.settings_cleaned = true;
            }
        }
    } else if project.is_some() && spec.mcp_file.is_some() {
        let proj = project.expect("checked some");
        let mcp_file = spec.mcp_file.unwrap_or("opencode.json");
        let (changed, deleted, notice) = strip_opencode_mcp(proj, mcp_file, exe)?;
        if changed {
            res.settings_cleaned = true;
            if deleted {
                res.files_removed.push(mcp_file.to_string());
            } else if let Some(b) = backup_once(&proj.join(mcp_file))? {
                res.backups.push(b);
            }
        }
        if let Some(n) = notice {
            res.notices.push(n);
        }
    }
    Ok(())
}

/// 单 agent 安装状态（供 UI 打勾）。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStatus {
    pub agent: String,
    pub installed: bool,
    pub hooks_ok: bool,
    pub commands_ok: bool,
    pub settings_ok: bool,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusResult {
    pub scope: String,
    pub target: String,
    pub agents: Vec<AgentStatus>,
    pub notices: Vec<String>,
}

fn opencode_mcp_present_text(home: &Path, project: Option<&Path>, mcp_file: &str) -> bool {
    if let Some(proj) = project {
        return std::fs::read_to_string(proj.join(mcp_file))
            .map(|s| s.contains("\"taskboard\""))
            .unwrap_or(false);
    }
    let dir = home.join(".config").join("opencode");
    ["config.json", "opencode.json", "opencode.jsonc"].iter().any(|n| {
        std::fs::read_to_string(dir.join(n)).map(|s| s.contains("\"taskboard\"")).unwrap_or(false)
    })
}

fn status_one(home: &Path, project: Option<&Path>, agent_id: &str) -> AgentStatus {
    let bad = AgentStatus {
        agent: agent_id.to_string(),
        installed: false,
        hooks_ok: false,
        commands_ok: false,
        settings_ok: false,
    };
    let Some(spec) = spec_of(agent_id) else { return bad };
    let Some(root) = config_root(home, project, spec) else { return bad };
    let has = |rel: &str| root.join(rel).is_file();
    // 无 commands 机制的 agent：commands_ok 恒 true（只考核 hooks + settings）
    let expects_commands = agent_id == "claude-code" || agent_id == "opencode";
    let (hooks_ok, commands_ok) = match spec.id {
        "opencode" => (
            has("plugins/taskboard.js"),
            ["commands/task-start.md", "commands/task-done.md", "commands/task-handoff.md"]
                .iter()
                .all(|r| has(r)),
        ),
        _ => (
            has("hooks/taskboard-session-start.sh") && has("hooks/taskboard-prompt-reminder.sh"),
            !expects_commands
                || ["commands/task-start.md", "commands/task-done.md", "commands/task-handoff.md"]
                    .iter()
                    .all(|r| has(r)),
        ),
    };
    let settings_ok = match spec.id {
        "opencode" => opencode_mcp_present_text(home, project, spec.mcp_file.unwrap_or("opencode.json")),
        _ => std::fs::read_to_string(root.join(spec.settings_name.unwrap_or("settings.json")))
            .map(|s| s.contains("taskboard-session-start.sh"))
            .unwrap_or(false),
    };
    AgentStatus {
        agent: agent_id.to_string(),
        installed: hooks_ok && commands_ok && settings_ok,
        hooks_ok,
        commands_ok,
        settings_ok,
    }
}

/// 启动时自动注册全局默认集（注册表全体）：host 已装但 ours 缺失才装，
/// 全程 best-effort 不抛错。返回实际安装的 agent（"" = 无动作）。Clawd 同款。
pub fn ensure_global_defaults() -> String {
    let home = match home_dir() {
        Ok(h) => h,
        Err(_) => return String::new(),
    };
    let exe = mcp_bin().unwrap_or_default();
    let mut done = Vec::new();
    for spec in AGENTS.iter() {
        let agent_id = spec.id;
        if config_root(&home, None, spec).is_none() {
            continue;
        }
        if status_one(&home, None, agent_id).installed {
            continue;
        }
        let mut res = InstallResult::empty("global", &home.display().to_string());
        if install_one(&home, None, agent_id, &exe, &mut res).is_ok()
            && !res.files_written.is_empty()
        {
            done.push(agent_id);
        }
    }
    done.join(",")
}

/// Tauri command：一键安装（scope=project|global，agents 为 session 下拉 value；
/// 未验证一键的不报错，按手动指引返回 notice）。
#[tauri::command]
pub fn install_agent_hooks(
    scope: String,
    target_dir: Option<String>,
    agents: Vec<String>,
) -> Result<InstallResult, String> {
    let (global, project, list) = parse_request(&scope, target_dir, agents)?;
    let home = home_dir()?;
    let exe = mcp_bin()?;
    let scope_s = if global { "global" } else { "project" };
    let target_s = project.as_ref().map(|p| p.display().to_string()).unwrap_or_else(|| home.display().to_string());
    let mut res = InstallResult::empty(scope_s, &target_s);
    for agent_id in &list {
        install_one(&home, project.as_deref(), agent_id, &exe, &mut res)?;
    }
    Ok(res)
}

/// Tauri command：一键卸载（只删模板一致的文件，用户改过的保留上报）。
#[tauri::command]
pub fn uninstall_agent_hooks(
    scope: String,
    target_dir: Option<String>,
    agents: Vec<String>,
) -> Result<UninstallResult, String> {
    let (global, project, list) = parse_request(&scope, target_dir, agents)?;
    let home = home_dir()?;
    let exe = mcp_bin()?;
    let scope_s = if global { "global" } else { "project" };
    let target_s = project.as_ref().map(|p| p.display().to_string()).unwrap_or_else(|| home.display().to_string());
    let mut res = UninstallResult::empty(scope_s, &target_s);
    for agent_id in &list {
        uninstall_one(&home, project.as_deref(), agent_id, &exe, &mut res)?;
    }
    Ok(res)
}

/// Tauri command：查询安装状态（供 UI 打勾）。
#[tauri::command]
pub fn get_agent_hooks_status(
    scope: String,
    target_dir: Option<String>,
    agents: Vec<String>,
) -> Result<StatusResult, String> {
    let (global, project, list) = parse_request(&scope, target_dir, agents)?;
    let home = home_dir()?;
    let scope_s = if global { "global" } else { "project" };
    let target_s = project.as_ref().map(|p| p.display().to_string()).unwrap_or_else(|| home.display().to_string());
    let mut out = StatusResult {
        scope: scope_s.to_string(),
        target: target_s,
        agents: Vec::new(),
        notices: Vec::new(),
    };
    for agent_id in &list {
        if global && spec_of(agent_id).is_some() && config_root(&home, None, spec_of(agent_id).expect("checked some")).is_none() {
            out.notices.push(format!("{agent_id}：未检测到全局配置（host 疑似未安装）"));
        }
        if spec_of(agent_id).is_none() {
            out.notices.push(format!("{agent_id}：暂不支持一键安装。{hint}", hint = manual_hint(agent_id)));
        }
        out.agents.push(status_one(&home, project.as_deref(), agent_id));
    }
    if !global {
        // 项目级 opencode 若缺 MCP，给出一句提醒（安装时会自动配，这里只读）
        if list.iter().any(|a| a == "opencode")
            && !opencode_mcp_present_text(&home, project.as_deref(), "opencode.json")
            && project.as_deref().map(|p| p.join("opencode.json").exists()).unwrap_or(false)
        {
            out.notices.push("项目 opencode.json 存在但未注册 taskboard MCP，安装时会自动补".to_string());
        }
    }
    Ok(out)
}

/// 从 settings.json 文本中移除 ours 的 hook 组。返回 (新文本或None, 是否变更)。
/// 若移除后顶层变为空 object，返回 None（调用方删除该文件）。
fn stripped_settings(existing: &str) -> Result<(Option<String>, bool), String> {
    let mut root: serde_json::Value = serde_json::from_str(existing)
        .map_err(|e| err(format!("已有 .claude/settings.json 解析失败（未改动）: {e}")))?;
    if !root.is_object() {
        return Err(err("已有 .claude/settings.json 顶层不是 object（未改动）"));
    }
    let before = root.clone();
    if let Some(hooks_obj) = root.get_mut("hooks").and_then(|h| h.as_object_mut()) {
        for event in ["SessionStart", "UserPromptSubmit"] {
            if let Some(groups) = hooks_obj.get_mut(event).and_then(|g| g.as_array_mut()) {
                for g in groups.iter_mut() {
                    if let Some(handlers) = g.get_mut("hooks").and_then(|h| h.as_array_mut()) {
                        handlers.retain(|h| {
                            h.get("command")
                                .and_then(|c| c.as_str())
                                .map(|c| {
                                    !c.contains(HOOK_SESSION_CMD_SUFFIX)
                                        && !c.contains(HOOK_PROMPT_CMD_SUFFIX)
                                })
                                .unwrap_or(true)
                        });
                    }
                }
                groups.retain(|g| {
                    g.get("hooks")
                        .and_then(|h| h.as_array())
                        .map(|a| !a.is_empty())
                        .unwrap_or(true)
                });
            }
        }
        // hooks 下事件全空则删 hooks 键，避免残留空壳。
        hooks_obj.retain(|_, v| v.as_array().map(|a| !a.is_empty()).unwrap_or(true));
        if hooks_obj.is_empty() {
            root.as_object_mut().expect("checked object").remove("hooks");
        }
    }
    if root != before {
        if root.as_object().map(|o| o.is_empty()).unwrap_or(false) {
            Ok((None, true))
        } else {
            let text = serde_json::to_string_pretty(&root).map_err(|e| err(format!("序列化失败: {e}")))?;
            Ok((Some(text + "\n"), true))
        }
    } else {
        Ok((None, false))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("tb_hooks2_{}_{}", std::process::id(), name));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    /// 假 HOME（不碰真实 ~，各测试独立目录，并行安全）。
    fn fake_home(name: &str) -> PathBuf {
        tmp(&format!("home-{name}"))
    }

    fn install_project(repo: &Path, agents: &[&str]) -> InstallResult {
        let home = fake_home("unused");
        let exe = "/Applications/TaskBoard.app/Contents/MacOS/taskboard";
        let mut res = InstallResult::empty("project", &repo.display().to_string());
        for a in agents {
            install_one(&home, Some(repo), a, exe, &mut res).unwrap();
        }
        res
    }

    fn install_global(home: &Path, agents: &[&str]) -> InstallResult {
        let exe = "/bin/taskboard";
        let mut res = InstallResult::empty("global", &home.display().to_string());
        for a in agents {
            install_one(home, None, a, exe, &mut res).unwrap();
        }
        res
    }

    #[test]
    fn project_install_both_agents_idempotent() {
        let repo = tmp("proj-both");
        let home = fake_home("proj-both-home");
        let exe = "/Applications/TaskBoard.app/Contents/MacOS/taskboard";
        let mut r1 = InstallResult::empty("project", "x");
        for a in ["claude-code", "opencode"] {
            install_one(&home, Some(&repo), a, exe, &mut r1).unwrap();
        }
        assert!(r1.settings_merged, "claude settings 应合并");
        assert!(r1.mcp_configured, "opencode.json 应注册");
        assert!(r1.files_written.contains(&"opencode.json".to_string()));
        // 项目级命令用 ${CLAUDE_PROJECT_DIR} 变量形式
        let s = std::fs::read_to_string(repo.join(".claude/settings.json")).unwrap();
        assert!(s.contains("${CLAUDE_PROJECT_DIR}/.claude/hooks/taskboard-session-start.sh"));
        for a in ["claude-code", "opencode"] {
            assert!(status_one(&home, Some(&repo), a).installed, "{a} 应装好");
        }
        // 幂等重装：零写入
        let mut r2 = InstallResult::empty("project", "x");
        for a in ["claude-code", "opencode"] {
            install_one(&home, Some(&repo), a, exe, &mut r2).unwrap();
        }
        assert!(r2.files_written.is_empty(), "幂等重装不应再写文件");
        let _ = std::fs::remove_dir_all(&repo);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn global_skips_missing_host() {
        let home = fake_home("skip");
        // home 下无任何 agent 配置 → 全部跳过，且不创建任何目录
        let res = install_global(&home, &["claude-code", "opencode", "workbuddy"]);
        assert!(res.files_written.is_empty());
        assert_eq!(res.notices.len(), 3);
        assert!(!home.join(".claude").exists(), "不得为未安装的 host 建目录");
        assert!(!home.join(".config").exists());
        assert!(!home.join(".workbuddy-ai").exists());
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn global_install_claude_uses_absolute_command() {
        let home = fake_home("global-abs");
        std::fs::create_dir_all(home.join(".claude")).unwrap();
        install_global(&home, &["claude-code"]);
        let s = std::fs::read_to_string(home.join(".claude/settings.json")).unwrap();
        // 全局必须用绝对路径（${CLAUDE_PROJECT_DIR} 在全局无意义）；命令值本身带双引号
        // （JSON 里转义为 \"），含空格路径不断裂
        let v: serde_json::Value = serde_json::from_str(&s).unwrap();
        let cmd = v["hooks"]["SessionStart"][0]["hooks"][0]["command"].as_str().unwrap();
        assert_eq!(
            cmd,
            format!("\"{}/hooks/taskboard-session-start.sh\"", home.join(".claude").display())
        );
        assert!(!s.contains("CLAUDE_PROJECT_DIR"), "全局不得出现项目变量");
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn global_install_into_existing_host() {
        let home = fake_home("global-ok");
        std::fs::create_dir_all(home.join(".claude")).unwrap();
        std::fs::create_dir_all(home.join(".config").join("opencode")).unwrap();
        // 全局 opencode 配一个含注释的 jsonc 且无 taskboard → 只给 notice，不改文件
        std::fs::write(
            home.join(".config").join("opencode").join("opencode.jsonc"),
            "// user comment\n{\"model\": \"x\"}\n",
        )
        .unwrap();
        let exe = "/bin/taskboard";
        let mut res = InstallResult::empty("global", "x");
        for a in ["claude-code", "opencode"] {
            install_one(&home, None, a, exe, &mut res).unwrap();
        }
        assert!(home.join(".claude/hooks/taskboard-session-start.sh").is_file());
        assert!(home.join(".config/opencode/plugins/taskboard.js").is_file());
        assert!(res.notices.iter().any(|n| n.contains("手动")), "应提示手动注册 MCP");
        let after =
            std::fs::read_to_string(home.join(".config/opencode/opencode.jsonc")).unwrap();
        assert!(after.contains("// user comment"), "jsonc 注释必须原样保留");
        // 卸载：备份 settings.json，用户文件保留
        let mut u = UninstallResult::empty("global", "x");
        for a in ["claude-code", "opencode"] {
            uninstall_one(&home, None, a, exe, &mut u).unwrap();
        }
        assert!(!home.join(".claude/hooks/taskboard-session-start.sh").exists());
        assert!(!u.backups.is_empty(), "settings 改动应留备份");
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn workbuddy_prefers_ai_dir_and_legacy_file() {
        // 仅 legacy settings.json（无 -ai 目录）→ 落到 legacy
        let home = fake_home("wb-legacy");
        std::fs::create_dir_all(home.join(".workbuddy")).unwrap();
        std::fs::write(home.join(".workbuddy/settings.json"), "{}").unwrap();
        let spec = spec_of("workbuddy").unwrap();
        assert_eq!(
            config_root(&home, None, spec),
            Some(home.join(".workbuddy")),
            "legacy settings.json 存在时应用"
        );
        install_global(&home, &["workbuddy"]);
        assert!(home.join(".workbuddy/hooks/taskboard-session-start.sh").is_file());
        assert!(!home.join(".workbuddy-ai").exists(), "不得新建 -ai 目录");
        // 通用变体：无 slash 引用
        let sh = std::fs::read_to_string(home.join(".workbuddy/hooks/taskboard-session-start.sh")).unwrap();
        assert!(!sh.contains("/task-start"), "通用变体不得含 slash 命令");
        assert!(!sh.contains("CLAUDE_SESSION_ID"), "通用变体不得含 Claude 变量");
        let _ = std::fs::remove_dir_all(&home);

        // -ai 目录存在 → 优先 -ai
        let home2 = fake_home("wb-ai");
        std::fs::create_dir_all(home2.join(".workbuddy-ai")).unwrap();
        std::fs::create_dir_all(home2.join(".workbuddy")).unwrap();
        assert_eq!(config_root(&home2, None, spec), Some(home2.join(".workbuddy-ai")));
        let _ = std::fs::remove_dir_all(&home2);
    }

    #[test]
    fn trae_and_codebuddy_install_hooks_json() {
        let home = fake_home("tc-cb");
        std::fs::create_dir_all(home.join(".trae-cn")).unwrap();
        std::fs::create_dir_all(home.join(".codebuddy")).unwrap();
        install_global(&home, &["trae", "codebuddy"]);
        assert!(home.join(".trae-cn/hooks/taskboard-session-start.sh").is_file());
        assert!(home.join(".codebuddy/hooks/taskboard-session-start.sh").is_file());
        // trae 写的是 hooks.json（不是 settings.json）
        assert!(home.join(".trae-cn/hooks.json").is_file());
        assert!(!home.join(".trae-cn/settings.json").exists());
        assert!(status_one(&home, None, "trae").installed);
        assert!(status_one(&home, None, "codebuddy").installed);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn manual_agent_returns_notice_not_error() {
        let home = fake_home("manual");
        let exe = "/bin/taskboard";
        let mut res = InstallResult::empty("global", "x");
        install_one(&home, None, "codex", exe, &mut res).unwrap();
        assert!(res.files_written.is_empty());
        assert!(res.notices.iter().any(|n| n.contains("codex") && n.contains("codex_hooks") || n.contains("AGENT_INSTRUCTIONS")));
        assert!(!status_one(&home, None, "codex").installed);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn script_variant_falls_back_safely() {
        // 模板漂移（句子对不上）时回退原文，不panic、不损坏
        let out = script_variant("nothing matches here");
        assert_eq!(out, "nothing matches here");
        let v = script_variant(SESSION_START_SH);
        assert!(!v.contains("/task-start"));
        assert!(!v.contains("${CLAUDE_SESSION_ID}"));
        assert!(v.contains("$TASKBOARD_SESSION_ID"));
    }

    #[test]
    fn opencode_json_merge_updates_stale_bin() {
        let repo = tmp("stale-bin");
        std::fs::write(
            repo.join("opencode.json"),
            r#"{"mcp":{"taskboard":{"type":"local","command":["/tmp/old-debug/taskboard","mcp"],"enabled":true}},"other":1}"#,
        )
        .unwrap();
        let (changed, notice) = merge_opencode_mcp(&repo, "opencode.json", "/Applications/TaskBoard.app/Contents/MacOS/taskboard").unwrap();
        assert!(changed, "stale dev 路径应原位更新");
        assert!(notice.is_none());
        let s = std::fs::read_to_string(repo.join("opencode.json")).unwrap();
        assert!(s.contains("/Applications/TaskBoard.app/Contents/MacOS/taskboard"));
        assert!(s.contains("\"other\": 1"), "用户其他配置保留");
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn opencode_json_keeps_foreign_entry() {
        let repo = tmp("foreign");
        std::fs::write(
            repo.join("opencode.json"),
            r#"{"mcp":{"taskboard":{"type":"local","command":["/usr/local/bin/myboard","serve"],"enabled":true}}}"#,
        )
        .unwrap();
        let (changed, notice) =
            merge_opencode_mcp(&repo, "opencode.json", "/Applications/TaskBoard.app/Contents/MacOS/taskboard").unwrap();
        assert!(!changed);
        assert!(notice.is_some(), "应提示保留");
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn uninstall_project_roundtrip() {
        let repo = tmp("uninst");
        install_project(&repo, &["claude-code", "opencode"]);
        let home = fake_home("uninst-home");
        let exe = "/Applications/TaskBoard.app/Contents/MacOS/taskboard";
        let mut u = UninstallResult::empty("project", "x");
        for a in ["claude-code", "opencode"] {
            uninstall_one(&home, Some(&repo), a, exe, &mut u).unwrap();
        }
        assert!(!status_one(&home, Some(&repo), "claude-code").installed);
        assert!(!status_one(&home, Some(&repo), "opencode").installed);
        assert!(!repo.join("opencode.json").exists(), "只含 ours 的 opencode.json 应删除");
        assert!(!u.backups.is_empty());
        let _ = std::fs::remove_dir_all(&repo);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn rejects_missing_dir() {
        let bad = std::env::temp_dir().join("tb_hooks_no_such_dir_xyz");
        let _ = std::fs::remove_dir_all(&bad);
        assert!(resolve_target(bad.to_str().unwrap()).is_err());
    }

    #[test]
    fn parse_request_validates() {
        assert!(parse_request("bogus", None, vec!["claude-code".into()]).is_err());
        assert!(parse_request("project", None, vec!["claude-code".into()]).is_err());
        assert!(parse_request("global", None, vec![]).is_err());
        // 未知 agent 不报错（安装/状态时按手动指引返回 notice）
        let (_, _, list) = parse_request("global", None, vec!["nope".into()]).unwrap();
        assert_eq!(list, vec!["nope".to_string()]);
        let (global, _, list) =
            parse_request("global", None, vec!["opencode".into(), "claude-code".into(), "claude-code".into()]).unwrap();
        assert!(global);
        assert_eq!(list, vec!["opencode".to_string(), "claude-code".to_string()]);
    }
}

//! #177：一键安装/卸载 agent 看板 hooks（claude-code + opencode，项目/全局两档）。
//!
//! 本仓库根的 `.claude/` / `.opencode/` 只是自用（dogfood）；用户在其他仓库
//! （如 fad-backend）干活时，agent 读的是**那个仓库**的配置。本模块把模板以
//! `include_str!` 内嵌进二进制（单一来源，只在仓库根维护），通过 Tauri command
//! 安装到用户选定的目标（项目仓库目录 / 全局用户目录），同时**合并而非覆盖**
//! 既有配置文件（保留用户自有 hooks，去重后追加 ours；卸载时只摘 ours）。
//!
//! 全局安装说明：hooks 会在该 agent 的所有仓库触发；不在 TaskBoard 看板里的
//! 任务调 MCP 会温和报错"任务不存在"，不写脏数据。opencode 全局 MCP 注册走
//! winning-file 自动合并（jsonc/json/config.json 按上游加载优先级取首个已存在
//! 文件，注释原样保留；见 merge_global_opencode_mcp 与 clawd-on-desk
//! agents/opencode-family.js 的 configCandidates）。

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

/// 对已解析的 JSON Value 执行 `mcp.taskboard` 合并（与 merge_opencode_mcp 同规则）。
/// 已有条目且命令 basename 也是 taskboard* → 原位更新（dev/正式版路径迁移）；
/// 已有条目但指向别处 → 保留 + 返回 notice。
fn merge_mcp_value(
    root: &mut serde_json::Value,
    exe: &str,
) -> Result<Option<String>, String> {
    let mcp = root
        .as_object_mut()
        .ok_or_else(|| err("配置顶层不是 object（未改动）"))?
        .entry("mcp")
        .or_insert_with(|| serde_json::json!({}));
    let mcp_obj =
        mcp.as_object_mut().ok_or_else(|| err("配置的 mcp 不是 object（未改动）"))?;
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
                return Ok(Some(format!(
                    "已保留既有 taskboard MCP 配置（{cur_bin}），未覆盖"
                )));
            }
        }
    }
    Ok(None)
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
    let notice = merge_mcp_value(&mut root, exe)?;
    if root == before {
        return Ok((false, notice));
    }
    let text =
        serde_json::to_string_pretty(&root).map_err(|e| err(format!("序列化失败: {e}")))?;
    write_atomic(&path, &(text + "\n"))?;
    Ok((true, notice))
}

/// 全局 opencode 的 MCP 手动指引：仅当自动合并失败（merge_global_opencode_mcp
/// 返回 Err）时作为回退展示。返回 None 表示已注册，无需提示。
fn global_opencode_mcp_notice(home: &Path, exe: &str) -> Option<String> {
    let dir = home.join(".config").join("opencode");
    for name in ["config.json", "opencode.json", "opencode.jsonc"] {
        if let Ok(s) = std::fs::read_to_string(dir.join(name)) {
            if s.contains("\"taskboard\"") {
                return None;
            }
        }
    }
    let mut tip = format!(
        "全局 opencode 未注册 taskboard MCP（jsonc 不自动合并，请手动在全局配置的 mcp 中加：\"taskboard\": {{\"type\": \"local\", \"command\": [\"{exe}\", \"mcp\"], \"enabled\": true}}）"
    );
    if exe.contains("/target/") {
        tip.push_str("注意：当前 App 运行的是开发版，该路径重编即失效；正式使用请换成安装版二进制（如 macOS 的 /Applications/TaskBoard.app/Contents/MacOS/taskboard）");
    }
    Some(tip)
}

/// JSONC 感知的字符串跳过：返回字符串结束引号之后的位置（处理 `\"` 转义）。
fn skip_json_string(b: &[u8], start: usize) -> usize {
    let mut i = start + 1;
    while i < b.len() {
        if b[i] == b'\\' {
            i += 2;
            continue;
        }
        if b[i] == b'"' {
            return i + 1;
        }
        i += 1;
    }
    b.len()
}

/// 从 `{`（含）起找配对 `}` 之**后**的位置；字符串/注释内的括号不计数。
/// 找不到返回 None。
fn match_json_brace(b: &[u8], open: usize) -> Option<usize> {
    if b.get(open) != Some(&b'{') {
        return None;
    }
    let mut depth = 0;
    let mut i = open;
    while i < b.len() {
        match b[i] {
            b'"' => i = skip_json_string(b, i),
            b'/' if i + 1 < b.len() && b[i + 1] == b'/' => {
                while i < b.len() && b[i] != b'\n' {
                    i += 1;
                }
            }
            b'/' if i + 1 < b.len() && b[i + 1] == b'*' => {
                i += 2;
                while i + 1 < b.len() && !(b[i] == b'*' && b[i + 1] == b'/') {
                    i += 1;
                }
                i += 2;
            }
            b'{' => {
                depth += 1;
                i += 1;
            }
            b'}' => {
                depth -= 1;
                i += 1;
                if depth == 0 {
                    return Some(i);
                }
            }
            _ => i += 1,
        }
    }
    None
}

/// 在 JSONC 文本顶层定位 `"key": {...}`（键起始..值结束 `}` 之后）。
/// 与 find_taskboard_entry_span 同样的字符串/注释感知（只找第一个顶层命中）。
fn find_top_object_span(text: &str, key: &str) -> Option<(usize, usize)> {
    let b = text.as_bytes();
    let n = b.len();
    let want = format!("\"{key}\"");
    let mut i = 0;
    while i < n {
        match b[i] {
            b'"' => {
                if text[i..].starts_with(&want) {
                    let key_start = i;
                    let mut j = i + want.len();
                    while j < n && (b[j] as char).is_whitespace() {
                        j += 1;
                    }
                    if j < n && b[j] == b':' {
                        j += 1;
                        while j < n && (b[j] as char).is_whitespace() {
                            j += 1;
                        }
                        if j < n && b[j] == b'{' {
                            if let Some(end) = match_json_brace(b, j) {
                                return Some((key_start, end));
                            }
                        }
                    }
                    i = (j + 1).max(key_start + 1);
                    continue;
                }
                i = skip_json_string(b, i);
            }
            b'/' if i + 1 < n && b[i + 1] == b'/' => {
                while i < n && b[i] != b'\n' {
                    i += 1;
                }
            }
            b'/' if i + 1 < n && b[i + 1] == b'*' => {
                i += 2;
                while i + 1 < n && !(b[i] == b'*' && b[i + 1] == b'/') {
                    i += 1;
                }
                i += 2;
            }
            _ => i += 1,
        }
    }
    None
}

/// 文本中是否存在任意 `"taskboard":` 键（值形状不限；字符串/注释内不算）。
/// find_taskboard_entry_span 只找对象值；本函数用于插入前排重，避免造出重复键。
fn has_any_taskboard_key(text: &str) -> bool {
    let b = text.as_bytes();
    let n = b.len();
    let mut i = 0;
    while i < n {
        match b[i] {
            b'"' => {
                if text[i..].starts_with("\"taskboard\"") {
                    let mut j = i + "\"taskboard\"".len();
                    while j < n && (b[j] as char).is_whitespace() {
                        j += 1;
                    }
                    if j < n && b[j] == b':' {
                        return true;
                    }
                    i = j + 1;
                    continue;
                }
                i = skip_json_string(b, i);
            }
            b'/' if i + 1 < n && b[i + 1] == b'/' => {
                while i < n && b[i] != b'\n' {
                    i += 1;
                }
            }
            b'/' if i + 1 < n && b[i + 1] == b'*' => {
                i += 2;
                while i + 1 < n && !(b[i] == b'*' && b[i + 1] == b'/') {
                    i += 1;
                }
                i += 2;
            }
            _ => i += 1,
        }
    }
    false
}

/// taskboard MCP 条目片段（`serde` 转义 exe，Windows 反斜杠安全）。
fn taskboard_mcp_kv(exe: &str) -> String {
    let v = serde_json::json!({"type": "local", "command": [exe, "mcp"], "enabled": true});
    format!("\"taskboard\": {}", serde_json::to_string(&v).unwrap_or_default())
}

/// 全局 opencode MCP 注册：winning-file 自动合并（原先只检测给手动步骤）。
///
/// 优先级与上游 `loadGlobal` 一致（后者覆盖前者，clawd-on-desk
/// agents/opencode-family.js `configCandidates` 同序）：首个**已存在**的文件生效，
/// 都不存在则新建 `opencode.json`。JSONC 注释原样保留：
/// - 严格 JSON → 走 merge_mcp_value 整体解析后 pretty 回写；
/// - JSONC（含注释）→ 字符串手术（mcp 对象内追加 / 顶层新增 mcp / 陈旧 ours 原位更新）；
/// - 他人条目 → 保留 + notice；形状无法识别 → Err（调用方回退手动指引）。
/// 返回 (changed, target_display, notice)。
fn merge_global_opencode_mcp(
    home: &Path,
    exe: &str,
) -> Result<(bool, String, Option<String>), String> {
    const CANDIDATES: [&str; 3] = ["opencode.jsonc", "opencode.json", "config.json"];
    let dir = home.join(".config").join("opencode");
    if !dir.is_dir() {
        return Ok((false, String::new(), Some("未检测到全局 opencode 配置（host 疑似未安装），已跳过".to_string())));
    }
    let mut target: Option<(&str, String)> = None;
    for name in CANDIDATES {
        if let Ok(s) = std::fs::read_to_string(dir.join(name)) {
            target = Some((name, s));
            break;
        }
    }
    let (name, text) = match target {
        Some(t) => t,
        None => ("opencode.json", String::new()),
    };
    let display = format!("~/.config/opencode/{name}（MCP）");
    let path = dir.join(name);

    // 严格 JSON 路径（含空文件）：整体解析
    if text.trim().is_empty() {
        let mut root = serde_json::json!({});
        let notice = merge_mcp_value(&mut root, exe)?;
        let out = serde_json::to_string_pretty(&root).map_err(|e| err(format!("序列化失败: {e}")))?;
        write_atomic(&path, &(out + "\n"))?;
        return Ok((true, display, notice));
    }
    if let Ok(mut root) = serde_json::from_str::<serde_json::Value>(&text) {
        if !root.is_object() {
            return Err(err(format!("{name} 顶层不是 object（未改动）")));
        }
        let before = root.clone();
        let notice = merge_mcp_value(&mut root, exe)?;
        if root == before {
            return Ok((false, display, notice));
        }
        let out = serde_json::to_string_pretty(&root).map_err(|e| err(format!("序列化失败: {e}")))?;
        backup_once(&path)?;
        write_atomic(&path, &(out + "\n"))?;
        return Ok((true, display, notice));
    }

    // JSONC 路径：注释保留的字符串手术
    if let Some((s, e)) = find_taskboard_entry_span(&text) {
        if taskboard_entry_is_ours(&text[s..e], exe) {
            if text[s..e].contains(exe) {
                return Ok((false, display, None));
            }
            // 陈旧 ours（dev 路径等）→ 原位更新
            let next = format!("{}{}{}", &text[..s], taskboard_mcp_kv(exe), &text[e..]);
            backup_once(&path)?;
            write_atomic(&path, &next)?;
            return Ok((true, display, None));
        }
        return Ok((false, display, Some(format!("{name} 的 taskboard MCP 指向别处，已保留"))));
    }
    if has_any_taskboard_key(&text) {
        // 非对象值等异形条目：不敢动，回退手动
        return Err(err(format!("{name} 含无法识别的 taskboard 条目（未改动）")));
    }
    let entry = taskboard_mcp_kv(exe);
    let next = if let Some((ms, me)) = find_top_object_span(&text, "mcp") {
        let inner = &text[ms + 1..me - 1];
        if inner.trim().is_empty() {
            format!("{}{{\n  {}\n}}{}", &text[..ms + 1], entry, &text[me - 1..])
        } else {
            format!("{},\n  {}{}", &text[..me - 1], entry, &text[me - 1..])
        }
    } else {
        // 无 mcp 键：挂到根对象尾部
        let trimmed_end = text.trim_end();
        if !trimmed_end.ends_with('}') {
            return Err(err(format!("{name} 根对象不完整（未改动）")));
        }
        let close = text.trim_end_matches(|c: char| c.is_whitespace()).len();
        let head = &text[..close - 1];
        let non_empty = head
            .trim_start()
            .strip_prefix('{')
            .map(|rest| !rest.trim().is_empty())
            .unwrap_or(true);
        if non_empty {
            format!("{head},\n  \"mcp\": {{\n    {entry}\n  }}\n}}\n")
        } else {
            format!("{head}\n  \"mcp\": {{\n    {entry}\n  }}\n}}\n")
        }
    };
    backup_once(&path)?;
    write_atomic(&path, &next)?;
    Ok((true, display, None))
}
fn find_taskboard_entry_span(text: &str) -> Option<(usize, usize)> {
    let b = text.as_bytes();
    let n = b.len();
    let key = b"\"taskboard\"";
    let mut i = 0;
    while i < n {
        match b[i] {
            b'"' => {
                if text[i..].starts_with("\"taskboard\"") {
                    let key_start = i;
                    let mut j = i + key.len();
                    while j < n && (b[j] as char).is_whitespace() {
                        j += 1;
                    }
                    if j < n && b[j] == b':' {
                        j += 1;
                        while j < n && (b[j] as char).is_whitespace() {
                            j += 1;
                        }
                        if j < n && b[j] == b'{' {
                            if let Some(end) = match_json_brace(b, j) {
                                return Some((key_start, end));
                            }
                        }
                    }
                    i = (j + 1).max(key_start + 1);
                    continue;
                }
                i = skip_json_string(b, i);
            }
            b'/' if i + 1 < n && b[i + 1] == b'/' => {
                while i < n && b[i] != b'\n' {
                    i += 1;
                }
            }
            b'/' if i + 1 < n && b[i + 1] == b'*' => {
                i += 2;
                while i + 1 < n && !(b[i] == b'*' && b[i + 1] == b'/') {
                    i += 1;
                }
                i += 2;
            }
            _ => i += 1,
        }
    }
    None
}

/// 条目值是否指向 ours（安装版/dev taskboard 二进制，或 server.py 兜底）。
/// 只看带路径分隔符的片段，避免键名本身 `"taskboard"` 恒成立。
fn taskboard_entry_is_ours(span: &str, exe: &str) -> bool {
    if span.contains(exe) {
        return true;
    }
    for seg in span.split('"') {
        if !seg.contains('/') && !seg.contains('\\') {
            continue;
        }
        let base = seg.replace('\\', "/").rsplit('/').next().unwrap_or("").trim().to_string();
        if base == "taskboard"
            || base == "taskboard.exe"
            || seg.contains("mcp_server/server.py")
            || seg.contains("mcp_server\\server.py")
        {
            return true;
        }
    }
    false
}

/// 删除条目 span（含相邻一个逗号：优先吃后逗号，否则吃前逗号）。
fn remove_entry_span(text: &str, start: usize, end: usize) -> String {
    let b = text.as_bytes();
    let n = text.len();
    let mut e = end;
    while e < n && (b[e] as char).is_whitespace() {
        e += 1;
    }
    if e < n && b[e] == b',' {
        return text[..start].to_string() + &text[e + 1..];
    }
    let mut s = start;
    while s > 0 && (b[s - 1] as char).is_whitespace() {
        s -= 1;
    }
    if s > 0 && b[s - 1] == b',' {
        s -= 1;
        return text[..s].to_string() + &text[end..];
    }
    text[..start].to_string() + &text[end..]
}

/// 全局 opencode 配置的文本级摘除：遍历 config.json/opencode.json/opencode.jsonc，
/// 删掉指向 ours 的 taskboard MCP 条目（注释原样保留，改动前备份）。
/// 返回 (removed_display, backups, notices)。
fn strip_global_opencode_mcp(
    home: &Path,
    exe: &str,
) -> (Vec<String>, Vec<String>, Vec<String>) {
    let dir = home.join(".config").join("opencode");
    let mut removed = Vec::new();
    let mut backups = Vec::new();
    let mut notices = Vec::new();
    for name in ["config.json", "opencode.json", "opencode.jsonc"] {
        let path = dir.join(name);
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        let Some((s, e)) = find_taskboard_entry_span(&text) else {
            continue;
        };
        if !taskboard_entry_is_ours(&text[s..e], exe) {
            notices.push(format!("{name} 的 taskboard MCP 指向别处，已保留"));
            continue;
        }
        let next = remove_entry_span(&text, s, e);
        if next == text {
            continue;
        }
        match backup_once(&path) {
            Ok(b) => backups.extend(b),
            Err(e) => {
                notices.push(format!("{name} 备份失败未改动：{e}"));
                continue;
            }
        }
        match std::fs::write(&path, next) {
            Ok(()) => removed.push(format!("~/.config/opencode/{name}（MCP 条目）")),
            Err(e) => notices.push(format!("{name} 回写失败：{e}")),
        }
    }
    (removed, backups, notices)
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
        // #190 用户定制保护：已存在且与模板不一致 → 先备份（仅首份），覆盖记入 notice。
        if let Ok(old) = std::fs::read_to_string(&p) {
            if old != content {
                if let Some(b) = backup_once(&p)? {
                    res.notices.push(format!(
                        "{} 与内置模板不一致，已按新模板覆盖，用户定制备份于 {b}",
                        display_path(home, project, &p)
                    ));
                }
            }
        }
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
            // #190：改动既有配置先备份（仅首份）；新建文件无需备份。
            if sp.exists() {
                backup_once(&sp)?;
            }
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
    } else {
        // 全局 opencode：winning-file 自动合并；实在合并不了才回退手动指引。
        match merge_global_opencode_mcp(home, exe) {
            Ok((changed, target, notice)) => {
                res.mcp_configured = true;
                if changed {
                    res.files_written.push(target);
                }
                if let Some(n) = notice {
                    res.notices.push(n);
                }
            }
            Err(e) => {
                res.notices.push(format!("全局 opencode MCP 自动合并失败（未改动）：{e}"));
                if let Some(n) = global_opencode_mcp_notice(home, exe) {
                    res.notices.push(n);
                }
            }
        }
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
/// 返回 (changed, file_deleted, notice, backup)。改动前先备份（#190：此前调用方在
/// 写后备份，`.taskboard-bak` 里是摘除后的内容、无法恢复；与全局路径对齐）。
fn strip_opencode_mcp(repo: &Path, mcp_file: &str, exe: &str) -> Result<(bool, bool, Option<String>, Option<String>), String> {
    let path = repo.join(mcp_file);
    let existing = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(_) => return Ok((false, false, None, None)),
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
        return Ok((false, false, notice, None));
    }
    // 先备份原文（仅首份），再写/删（#190）。
    let backup = backup_once(&path)?;
    if root.as_object().map(|o| o.is_empty()).unwrap_or(false) {
        std::fs::remove_file(&path).map_err(|e| err(format!("删除 opencode.json 失败: {e}")))?;
        return Ok((true, true, notice, backup));
    }
    let text =
        serde_json::to_string_pretty(&root).map_err(|e| err(format!("序列化失败: {e}")))?;
    write_atomic(&path, &(text + "\n"))?;
    Ok((true, false, notice, backup))
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
    } else if spec.mcp_file.is_some() {
        if let Some(proj) = project {
            let mcp_file = spec.mcp_file.unwrap_or("opencode.json");
            // #190：备份由 strip 内部在改动前完成（返回值），调用方只负责上报。
            let (changed, deleted, notice, backup) = strip_opencode_mcp(proj, mcp_file, exe)?;
            if changed {
                res.settings_cleaned = true;
                if deleted {
                    res.files_removed.push(mcp_file.to_string());
                }
                if let Some(b) = backup {
                    res.backups.push(b);
                }
            }
            if let Some(n) = notice {
                res.notices.push(n);
            }
        } else {
            // 全局：jsonc 文本级摘除 ours 条目（注释保留，改动前备份）
            let (files, backups, notes) = strip_global_opencode_mcp(home, exe);
            if !files.is_empty() {
                res.settings_cleaned = true;
                res.files_removed.extend(files);
                res.backups.extend(backups);
            }
            res.notices.extend(notes);
        }
    }
    Ok(())
}

/// 单 agent 安装状态（供 UI 分组展示：installed=已接入；
/// host_present&&!installed=可接入；!host_present=未安装）。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStatus {
    pub agent: String,
    pub installed: bool,
    pub hooks_ok: bool,
    pub commands_ok: bool,
    pub settings_ok: bool,
    /// host 是否装过该 agent（全局下配置根可解析；项目级恒 true）。
    pub host_present: bool,
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
    let bad = |host_present: bool| AgentStatus {
        agent: agent_id.to_string(),
        installed: false,
        hooks_ok: false,
        commands_ok: false,
        settings_ok: false,
        host_present,
    };
    let Some(spec) = spec_of(agent_id) else { return bad(false) };
    // 项目级：target 目录已校验，host 恒视为 present；全局：配置根可解析才算装过
    let root = match config_root(home, project, spec) {
        Some(r) => r,
        None => return bad(false),
    };
    let host_present = project.is_some() || root.is_dir();
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
        host_present,
    }
}

/// 开发版二进制判定：`target/` 下的路径重编即失效（#193）。
/// 调用方（ensure_global_defaults）在命中时跳过自动注册，避免把一次性路径
/// 写进用户全局配置（手动指引 global_opencode_mcp_notice 亦有同款警告）。
fn is_dev_binary(exe: &str) -> bool {
    exe.contains("/target/") || exe.contains("\\target\\")
}

/// 启动时自动注册全局默认集（注册表全体）：host 已装但 ours 缺失才装，
/// 全程 best-effort 不抛错。返回实际安装的 agent（"" = 无动作）。Clawd 同款。
pub fn ensure_global_defaults() -> String {
    let home = match home_dir() {
        Ok(h) => h,
        Err(_) => return String::new(),
    };
    let exe = mcp_bin().unwrap_or_default();
    // #193：开发版不自动写全局配置（路径重编即失效）。
    if is_dev_binary(&exe) {
        return String::new();
    }
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
        // 全局 opencode 配一个含注释的 jsonc 且无 taskboard → 自动合并（注释保留），不再只给 notice
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
        assert!(res.mcp_configured, "全局 MCP 应自动注册");
        assert!(
            !res.notices.iter().any(|n| n.contains("手动")),
            "自动合并成功后不应再提示手动"
        );
        let after =
            std::fs::read_to_string(home.join(".config/opencode/opencode.jsonc")).unwrap();
        assert!(after.contains("// user comment"), "jsonc 注释必须原样保留");
        assert!(after.contains("\"taskboard\""), "MCP 条目应写入");
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

    fn global_cfg(home: &Path) -> PathBuf {
        let cfg = home.join(".config").join("opencode");
        std::fs::create_dir_all(&cfg).unwrap();
        cfg
    }

    #[test]
    fn global_merge_prefers_jsonc_over_json() {
        // winning-file：jsonc 已存在时 json 纹丝不动（上游 loadGlobal 后者覆盖前者）
        let home = fake_home("gwinner");
        let cfg = global_cfg(&home);
        std::fs::write(cfg.join("opencode.json"), r#"{"other":1}"#).unwrap();
        std::fs::write(cfg.join("opencode.jsonc"), "// hello\n{\"model\": \"x\"}\n").unwrap();
        let (changed, target, notice) = merge_global_opencode_mcp(&home, "/bin/taskboard").unwrap();
        assert!(changed);
        assert!(target.contains("opencode.jsonc"), "应命中 jsonc，实际 {target}");
        assert!(notice.is_none());
        let json = std::fs::read_to_string(cfg.join("opencode.json")).unwrap();
        assert_eq!(json, r#"{"other":1}"#, "json 不得被碰");
        let jsonc = std::fs::read_to_string(cfg.join("opencode.jsonc")).unwrap();
        assert!(jsonc.contains("// hello"), "注释保留");
        assert!(jsonc.contains("\"taskboard\""), "条目写入");
        assert!(jsonc.contains("\"model\": \"x\""), "既有键保留");
        // 幂等
        let (c2, _, _) = merge_global_opencode_mcp(&home, "/bin/taskboard").unwrap();
        assert!(!c2, "重装不应再写");
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn global_merge_jsonc_appends_into_existing_mcp() {
        let home = fake_home("gappend");
        let cfg = global_cfg(&home);
        std::fs::write(
            cfg.join("opencode.jsonc"),
            "// keep\n{\"mcp\": {\n  \"other\": {\"type\": \"remote\", \"url\": \"https://x\"}\n}}\n",
        )
        .unwrap();
        let (changed, _, _) = merge_global_opencode_mcp(&home, "/bin/taskboard").unwrap();
        assert!(changed);
        let out = std::fs::read_to_string(cfg.join("opencode.jsonc")).unwrap();
        assert!(out.contains("// keep"), "注释保留");
        assert!(out.contains("\"other\""), "兄弟 server 保留");
        assert!(out.contains("\"taskboard\"") && out.contains("/bin/taskboard"), "条目追加");
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn global_merge_creates_json_when_missing() {
        let home = fake_home("gcreate");
        global_cfg(&home);
        let (changed, target, _) = merge_global_opencode_mcp(&home, "/bin/taskboard").unwrap();
        assert!(changed);
        assert!(target.contains("opencode.json"), "缺省新建 opencode.json，实际 {target}");
        let v: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(home.join(".config/opencode/opencode.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(v["mcp"]["taskboard"]["command"][0], "/bin/taskboard");
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn global_merge_keeps_foreign_and_updates_stale() {
        let home = fake_home("gforeign");
        let cfg = global_cfg(&home);
        // 外来条目：保留 + notice
        std::fs::write(
            cfg.join("opencode.json"),
            "{\"mcp\": {\"taskboard\": {\"command\": [\"/usr/local/bin/myboard\", \"serve\"]}}}",
        )
        .unwrap();
        let (changed, _, notice) = merge_global_opencode_mcp(&home, "/bin/taskboard").unwrap();
        assert!(!changed);
        assert!(notice.is_some(), "应提示保留");
        // 陈旧 ours（dev 路径）：jsonc 原位更新
        std::fs::write(
            cfg.join("opencode.jsonc"),
            "{\"mcp\": {\"taskboard\": {\"command\": [\"/tmp/old-debug/taskboard\", \"mcp\"]}}}",
        )
        .unwrap();
        std::fs::remove_file(cfg.join("opencode.json")).unwrap();
        let (c2, _, n2) = merge_global_opencode_mcp(&home, "/Applications/TaskBoard.app/Contents/MacOS/taskboard").unwrap();
        assert!(c2, "陈旧路径应更新");
        assert!(n2.is_none());
        let out = std::fs::read_to_string(cfg.join("opencode.jsonc")).unwrap();
        assert!(out.contains("/Applications/TaskBoard.app/Contents/MacOS/taskboard"));
        assert!(!out.contains("/tmp/old-debug"), "旧路径清除");
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn global_merge_broken_file_errors_without_touching() {
        let home = fake_home("gbroken");
        let cfg = global_cfg(&home);
        std::fs::write(cfg.join("opencode.jsonc"), "not json at all {{{").unwrap();
        let r = merge_global_opencode_mcp(&home, "/bin/taskboard");
        assert!(r.is_err(), "无法识别应报错回退手动");
        assert_eq!(
            std::fs::read_to_string(cfg.join("opencode.jsonc")).unwrap(),
            "not json at all {{{",
            "报错时不得改动"
        );
        let _ = std::fs::remove_dir_all(&home);
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
    fn uninstall_project_opencode_backup_holds_original() {
        // #190：备份必须在摘除前完成，.bak 里是原文（含 taskboard 条目）。
        let repo = tmp("uninst-bak");
        let orig = r#"{"mcp":{"taskboard":{"type":"local","command":["/Applications/TaskBoard.app/Contents/MacOS/taskboard","mcp"],"enabled":true}},"other":1}"#;
        std::fs::write(repo.join("opencode.json"), orig).unwrap();
        let home = fake_home("uninst-bak-home");
        let exe = "/Applications/TaskBoard.app/Contents/MacOS/taskboard";
        let mut u = UninstallResult::empty("project", "x");
        uninstall_one(&home, Some(&repo), "opencode", exe, &mut u).unwrap();
        let bak = std::fs::read_to_string(repo.join("opencode.taskboard-bak")).unwrap();
        assert_eq!(bak, orig, "备份应为改前原文");
        let after = std::fs::read_to_string(repo.join("opencode.json")).unwrap();
        assert!(!after.contains("taskboard"), "条目应被摘除");
        assert!(after.contains("\"other\""), "兄弟键保留");
        assert!(u.backups.iter().any(|b| b.contains("taskboard-bak")), "应上报备份路径");
        let _ = std::fs::remove_dir_all(&repo);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn install_overwrites_custom_script_with_backup() {
        // #190：用户定制的 hook 脚本被新模板覆盖时，必须先留备份并 notice。
        let repo = tmp("custom-script");
        let home = fake_home("custom-script-home");
        let dir = repo.join(".claude").join("hooks");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("taskboard-session-start.sh"), "#!/bin/bash\necho mine\n").unwrap();
        let exe = "/Applications/TaskBoard.app/Contents/MacOS/taskboard";
        let mut res = InstallResult::empty("project", "x");
        install_one(&home, Some(&repo), "claude-code", exe, &mut res).unwrap();
        let bak = std::fs::read_to_string(dir.join("taskboard-session-start.taskboard-bak")).unwrap();
        assert!(bak.contains("echo mine"), "备份应为用户定制原文");
        let now = std::fs::read_to_string(dir.join("taskboard-session-start.sh")).unwrap();
        assert_eq!(now, SESSION_START_SH, "文件应已按模板覆盖");
        assert!(res.notices.iter().any(|n| n.contains("备份")), "应 notice 告知覆盖+备份");
        let _ = std::fs::remove_dir_all(&repo);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn install_settings_merge_backs_up_existing() {
        // #190：合并改写既有 settings.json 前留备份（仅首份）。
        let repo = tmp("settings-bak");
        let home = fake_home("settings-bak-home");
        let claude = repo.join(".claude");
        std::fs::create_dir_all(&claude).unwrap();
        let orig = r#"{"hooks":{"SessionStart":[{"matcher":"","hooks":[{"type":"command","command":"echo hi","timeout":5}]}]}}"#;
        std::fs::write(claude.join("settings.json"), orig).unwrap();
        let exe = "/Applications/TaskBoard.app/Contents/MacOS/taskboard";
        let mut res = InstallResult::empty("project", "x");
        install_one(&home, Some(&repo), "claude-code", exe, &mut res).unwrap();
        assert!(res.settings_merged);
        let bak = std::fs::read_to_string(claude.join("settings.taskboard-bak")).unwrap();
        assert_eq!(bak, orig, "备份应为改前原文");
        let merged = std::fs::read_to_string(claude.join("settings.json")).unwrap();
        assert!(merged.contains("echo hi"), "用户原有 hook 保留");
        assert!(merged.contains("taskboard-session-start.sh"), "ours 已合并");
        // 幂等：重装不再写文件
        let mut r2 = InstallResult::empty("project", "x");
        install_one(&home, Some(&repo), "claude-code", exe, &mut r2).unwrap();
        assert!(r2.files_written.is_empty(), "幂等重装不应再写文件");
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
    fn global_mcp_notice_warns_on_dev_binary() {
        let home = fake_home("mcp-notice");
        // 空配置目录：三个候选文件都不存在 → 给出手动步骤
        std::fs::create_dir_all(home.join(".config").join("opencode")).unwrap();
        let n = global_opencode_mcp_notice(&home, "/tmp/build/target/debug/taskboard").unwrap();
        assert!(n.contains("手动") && n.contains("开发版"));
        let n2 = global_opencode_mcp_notice(&home, "/Applications/TaskBoard.app/Contents/MacOS/taskboard").unwrap();
        assert!(!n2.contains("开发版"));
        // 已注册则无 notice
        std::fs::write(
            home.join(".config/opencode/opencode.jsonc"),
            "{\"mcp\": {\"taskboard\": {}}}",
        )
        .unwrap();
        assert!(global_opencode_mcp_notice(&home, "/bin/taskboard").is_none());
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn global_jsonc_strip_keeps_comments() {
        // 注释里含花括号 + taskboard 字样也不得误伤
        let src = "// \"taskboard\": { broken\n{\n  // comment { with brace\n  \"mcp\": {\n    \"taskboard\": {\n      \"type\": \"local\",\n      \"command\": [\"/Applications/TaskBoard.app/Contents/MacOS/taskboard\", \"mcp\"],\n      \"enabled\": true\n    },\n    \"other\": {\"type\": \"remote\", \"url\": \"https://x\"}\n  },\n  \"model\": \"y\" // trailing { \n}\n";
        let (s, e) = find_taskboard_entry_span(src).expect("应定位到真正的条目");
        assert!(src[s..e].contains("/Applications/TaskBoard.app"));
        let out = remove_entry_span(src, s, e);
        assert!(!out.contains("/Applications/TaskBoard.app"), "条目应被删掉");
        assert!(out.contains("// \"taskboard\": { broken"), "注释必须保留");
        assert!(out.contains("\"other\""), "兄弟条目保留");
        assert!(out.contains("\"model\": \"y\""), "其他顶层键保留");
        // 删后仍是合法 JSON（本例无其他注释干扰结构）
        let v: serde_json::Value = serde_json::from_str(&out.replace("// \"taskboard\": { broken\n", "").replace("// comment { with brace\n", "").replace("// trailing { \n", "")).unwrap();
        assert!(v["mcp"].get("taskboard").is_none());
        assert_eq!(v["mcp"]["other"]["type"], "remote");
    }

    #[test]
    fn global_jsonc_strip_last_and_only_child() {
        // 末条目：吃前逗号
        let src = "{\"mcp\": {\"a\": 1, \"taskboard\": {\"command\": [\"/bin/taskboard\", \"mcp\"]}}}";
        let (s, e) = find_taskboard_entry_span(src).unwrap();
        let out = remove_entry_span(src, s, e);
        assert_eq!(out, "{\"mcp\": {\"a\": 1}}");
        // 唯一子条目：mcp 变空对象（无害，后续 status 即判未安装）
        let src2 = "{\"mcp\": {\"taskboard\": {\"command\": [\"/bin/taskboard\", \"mcp\"]}}}";
        let (s2, e2) = find_taskboard_entry_span(src2).unwrap();
        assert_eq!(remove_entry_span(src2, s2, e2), "{\"mcp\": {}}");
        // 值不是对象时不匹配
        assert!(find_taskboard_entry_span("{\"taskboard\": \"nope\"}").is_none());
    }

    #[test]
    fn entry_ours_detection() {
        let exe = "/Applications/TaskBoard.app/Contents/MacOS/taskboard";
        assert!(taskboard_entry_is_ours("\"taskboard\": {\"command\": [\"/Applications/TaskBoard.app/Contents/MacOS/taskboard\", \"mcp\"]}", exe));
        assert!(taskboard_entry_is_ours("\"taskboard\": {\"command\": [\"python3\", \"mcp_server/server.py\"]}", exe));
        assert!(taskboard_entry_is_ours("\"taskboard\": {\"command\": [\"C:\\\\Program Files\\\\TaskBoard\\\\taskboard.exe\", \"mcp\"]}", exe));
        assert!(!taskboard_entry_is_ours("\"taskboard\": {\"command\": [\"/usr/local/bin/myboard\", \"serve\"]}", exe));
    }

    #[test]
    fn global_uninstall_strips_jsonc_with_backup() {
        let home = fake_home("gstrip");
        let cfg = home.join(".config").join("opencode");
        std::fs::create_dir_all(&cfg).unwrap();
        std::fs::write(
            cfg.join("opencode.jsonc"),
            "// keep me\n{\"mcp\": {\"taskboard\": {\"command\": [\"/bin/taskboard\", \"mcp\"]}, \"o\": 1}}\n",
        )
        .unwrap();
        // 先装上插件文件，使卸载流程完整
        install_global(&home, &["opencode"]);
        let exe = "/bin/taskboard";
        let mut u = UninstallResult::empty("global", "x");
        uninstall_one(&home, None, "opencode", exe, &mut u).unwrap();
        let after = std::fs::read_to_string(cfg.join("opencode.jsonc")).unwrap();
        assert!(!after.contains("/bin/taskboard"), "MCP 条目应被摘除");
        assert!(after.contains("// keep me"), "注释保留");
        assert!(after.contains("\"o\": 1"), "兄弟键保留");
        assert!(u.backups.iter().any(|b| b.contains("taskboard-bak")), "应留备份");
        assert!(!status_one(&home, None, "opencode").installed);
        // 外来条目：保留 + notice
        std::fs::write(
            cfg.join("opencode.jsonc"),
            "{\"mcp\": {\"taskboard\": {\"command\": [\"/usr/local/bin/myboard\", \"serve\"]}}}",
        )
        .unwrap();
        let mut u2 = UninstallResult::empty("global", "x");
        uninstall_one(&home, None, "opencode", exe, &mut u2).unwrap();
        let kept = std::fs::read_to_string(cfg.join("opencode.jsonc")).unwrap();
        assert!(kept.contains("myboard"), "外来条目保留");
        assert!(u2.notices.iter().any(|n| n.contains("保留")));
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn status_distinguishes_missing_host() {
        // 全局 + host 不存在 → host_present=false（“未安装”组）
        let home = fake_home("host-flag");
        let st = status_one(&home, None, "codebuddy");
        assert!(!st.installed && !st.host_present);
        // host 存在但 ours 缺失 → host_present=true（“可接入”组）
        std::fs::create_dir_all(home.join(".codebuddy")).unwrap();
        let st2 = status_one(&home, None, "codebuddy");
        assert!(!st2.installed && st2.host_present);
        // 项目级：有项目支持的恒视为 present；无项目支持的不可装（手动组）
        let repo = tmp("host-flag-proj");
        assert!(status_one(&home, Some(&repo), "claude-code").host_present);
        assert!(!status_one(&home, Some(&repo), "codebuddy").host_present);
        let _ = std::fs::remove_dir_all(&home);
        let _ = std::fs::remove_dir_all(&repo);
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

    #[test]
    fn dev_binary_detection() {
        // #193：target 下的 dev 路径重编即失效，不得自动写入全局配置。
        assert!(is_dev_binary("/tmp/build/target/debug/taskboard"));
        assert!(is_dev_binary("C:\\proj\\target\\debug\\taskboard.exe"));
        assert!(!is_dev_binary("/Applications/TaskBoard.app/Contents/MacOS/taskboard"));
        assert!(!is_dev_binary("/usr/local/bin/taskboard"));
        assert!(!is_dev_binary(""));
    }
}

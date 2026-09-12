//! GitHub OAuth Device Flow（RFC 8628）——v0.3.17 登录方式。
//!
//! 流程：
//! 1. `start`：POST /login/device/code → 拿 `device_code` + `user_code` + `verification_uri`
//! 2. 用户在浏览器打开 verification_uri（或 verification_uri_complete，user_code 已预填），
//!    登录 GitHub 并输入 user_code 授权
//! 3. `poll_once`：POST /login/oauth/access_token（grant_type=device_code），按 interval 轮询，
//!    直到 `access_token` / `expired_token` / `access_denied`
//!
//! 为什么用 Device Flow 而不是 PAT 粘贴 / 回调服务器：
//! - 无需 client secret（只需注册 OAuth App 时勾选「Enable Device Flow」拿 client_id）
//! - 无需本地回调端口（Tauri app 不必起 HTTP server）
//! - 体验等同「链接登录」：点按钮 → 浏览器授权 → 回来自动登录
//!
//! token 安全：成功后由 commands 层直接写入 DB（新账号），token 不回流前端。

use serde::{Deserialize, Serialize};
use std::time::Duration;

const DEVICE_CODE_URL: &str = "https://github.com/login/device/code";
const TOKEN_URL: &str = "https://github.com/login/oauth/access_token";

/// OAuth scope 与 PAT 权限集对齐：仓库读写 + 组织读 + Projects V2 读写。
/// #215：含 `project` 写 scope（写回 Project 状态用）。已发出的旧 token 不会自动
/// 获得新 scope，改动后需重新走一遍授权登录换 token。
pub const DEVICE_FLOW_SCOPES: &str = "repo read:org read:project project";

/// 默认 client_id：GitHub CLI 官方 OAuth App 的公开 client_id（内嵌于开源仓库 cli/cli）。
///
/// 为什么内置它：Device Flow 协议要求必须有 client_id（OAuth 的应用身份）。
/// VS Code / gh CLI 的「点击直接登录」体验 = 厂商预注册 + client_id 内置，用户无感。
/// 用户未注册自己的 OAuth App 时，回落到该公开身份，实现零注册直接登录；
/// 高级用户仍可通过 `meta.oauth_client_id` 覆盖为自己的应用。
pub const DEFAULT_CLIENT_ID: &str = "178c6fc778ccc68e1d6a";

/// 解析生效的 client_id：调用方提供值优先，空则用内置默认。
fn effective_client_id(client_id: &str) -> &str {
    let trimmed = client_id.trim();
    if trimmed.is_empty() {
        DEFAULT_CLIENT_ID
    } else {
        trimmed
    }
}

/// `start` 的返回：前端展示 user_code 并打开授权页，随后按 interval 轮询。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceLoginStart {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    /// 已预填 user_code 的完整 URL；直接打开可免手动输码。
    pub verification_uri_complete: String,
    /// user_code 有效期（秒），GitHub 通常 900。
    pub expires_in: u64,
    /// 建议轮询间隔（秒），GitHub 通常 5。
    pub interval: u64,
}

/// `poll_once` 的结果（token 不外传，见模块注释）。
#[derive(Debug, Clone)]
pub enum PollOutcome {
    /// 用户还没在浏览器完成授权，继续按 interval 轮询。
    Pending,
    /// GitHub 要求放慢（interval += 5s）。
    SlowDown,
    /// 授权成功，携带 access_token。
    Success(String),
    /// 明确失败：expired_token / access_denied / 其他。
    Failed(String),
}

fn http() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .user_agent("taskboard/0.3.17")
        .timeout(Duration::from_secs(30))
        .connect_timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| format!("构造 HTTP 客户端失败: {}", e))
}

/// 第 1 步：申请设备码。client_id 空时用内置默认（GitHub CLI 公开身份），零注册直接登录。
pub fn start(client_id: &str) -> Result<DeviceLoginStart, String> {
    let client_id = effective_client_id(client_id);
    let http = http()?;
    #[derive(Deserialize)]
    struct Raw {
        device_code: String,
        user_code: String,
        verification_uri: String,
        #[serde(default)]
        verification_uri_complete: Option<String>,
        #[serde(default)]
        expires_in: Option<u64>,
        #[serde(default)]
        interval: Option<u64>,
    }
    #[derive(Deserialize)]
    struct ErrRaw {
        error: String,
        #[serde(default)]
        error_description: Option<String>,
    }
    let resp = http
        .post(DEVICE_CODE_URL)
        .header("Accept", "application/json")
        .json(&serde_json::json!({
            "client_id": client_id,
            "scope": DEVICE_FLOW_SCOPES,
        }))
        .send()
        .map_err(|e| format!("请求设备码失败: {}", e))?;
    let status = resp.status();
    let body = resp.bytes().map_err(|e| format!("读取设备码响应失败: {}", e))?;
    if let Ok(err) = serde_json::from_slice::<ErrRaw>(&body) {
        return Err(format!(
            "申请设备码被拒（{}）：{}",
            err.error,
            err.error_description.unwrap_or_default()
        ));
    }
    let raw: Raw = serde_json::from_slice(&body)
        .map_err(|e| format!("解析设备码响应失败（HTTP {}）: {}", status, e))?;
    Ok(DeviceLoginStart {
        device_code: raw.device_code,
        user_code: raw.user_code,
        verification_uri_complete: raw
            .verification_uri_complete
            .unwrap_or_else(|| raw.verification_uri.clone()),
        verification_uri: raw.verification_uri,
        expires_in: raw.expires_in.unwrap_or(900),
        interval: raw.interval.unwrap_or(5).max(1),
    })
}

/// 第 2 步：单次轮询。**不内置 sleep**——由前端按 interval 控制节奏，避免阻塞命令线程。
pub fn poll_once(client_id: &str, device_code: &str) -> Result<PollOutcome, String> {
    let client_id = effective_client_id(client_id);
    let http = http()?;
    #[derive(Deserialize)]
    struct OkRaw {
        #[serde(default)]
        access_token: Option<String>,
    }
    #[derive(Deserialize)]
    struct ErrRaw {
        #[serde(default)]
        error: Option<String>,
        #[serde(default)]
        error_description: Option<String>,
    }
    let resp = http
        .post(TOKEN_URL)
        .header("Accept", "application/json")
        .json(&serde_json::json!({
            "client_id": client_id.trim(),
            "device_code": device_code,
            "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
        }))
        .send()
        .map_err(|e| format!("轮询授权状态失败: {}", e))?;
    let body = resp.bytes().map_err(|e| format!("读取轮询响应失败: {}", e))?;
    // GitHub 对 pending 也返回 200 + {error: authorization_pending}，两种结构都试着解析。
    if let Ok(err) = serde_json::from_slice::<ErrRaw>(&body) {
        match err.error.as_deref() {
            Some("authorization_pending") => return Ok(PollOutcome::Pending),
            Some("slow_down") => return Ok(PollOutcome::SlowDown),
            Some("expired_token") => {
                return Ok(PollOutcome::Failed(
                    "设备码已过期（15 分钟），请重新发起登录".to_string(),
                ))
            }
            Some("access_denied") => {
                return Ok(PollOutcome::Failed("你在浏览器里取消了授权".to_string()))
            }
            Some(other) => {
                return Ok(PollOutcome::Failed(format!(
                    "{} {}",
                    other,
                    err.error_description.unwrap_or_default()
                )))
            }
            None => {}
        }
    }
    let ok: OkRaw = serde_json::from_slice(&body)
        .map_err(|e| format!("解析轮询响应失败: {}", e))?;
    match ok.access_token {
        Some(t) if !t.is_empty() => Ok(PollOutcome::Success(t)),
        _ => Ok(PollOutcome::Pending),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_client_id_falls_back_to_builtin() {
        // 零注册体验：空 client_id 回落到 GitHub CLI 公开身份，而不是报错。
        assert_eq!(effective_client_id(""), DEFAULT_CLIENT_ID);
        assert_eq!(effective_client_id("  "), DEFAULT_CLIENT_ID);
        assert_eq!(effective_client_id(" my-app "), "my-app");
        // 不再拒绝空值（v0.3.17 初版会报错要求注册，已废弃）。
        let err = start("  ");
        // start 现在会发起真实 HTTP 请求（沙箱内可能失败），但不能是「Client ID 为空」错误。
        if let Err(e) = err {
            assert!(!e.contains("Client ID 为空"), "不应再要求注册: {e}");
        }
    }

    #[test]
    fn scopes_match_pat_permission_set() {
        assert_eq!(DEVICE_FLOW_SCOPES, "repo read:org read:project project");
    }
}

# Issue #149：安全加固（文件权限 + CSP + 外链白名单 + 日志门控）

## 背景 / 动机

PAT 明文存 SQLite、`tauri.conf.json` CSP=null、`open_in_browser` 写死 macOS `open` 且无 URL 校验、诊断 `eprintln!` 全开刷屏（`db.rs` 除外已有门控）。

## 设计 / 方案

### 短期落地（本 PR）

- **库文件权限**：`open_db` 打开后 Unix 下 `chmod 0600`（best-effort，失败不阻断）。核查结论：PAT 仅出现在 `Authorization` 请求头（`github.rs` 三处），从不进入日志/错误串，无需脱敏改造。
- **CSP 最小策略**：`default-src 'self'`；`connect-src` 放行 `'self` + GitHub API 域 + Tauri IPC（`ipc:` / `http://ipc.localhost`，invoke 必需）；`script-src 'self'`（禁 eval）；`style-src 'self' 'unsafe-inline'`（React 行内样式必需）；`img-src` 放行 data 与 githubusercontent。⚠️ 未在本机 webview 实测，需合并后在 dev 构建看 Console 有无拦截。
- **`open_in_browser`**：先过 `common::validate_browser_url`（仅 `https://github.com/` 与 `*.ghe.com`），再 `cfg(target_os)` 分发（macOS `open` / Windows `cmd /C start ""` / 其余 `xdg-open`）。Windows/Linux 路径需在对应 runner/机器实测（关联 #119）。
- **日志门控**：`verbose_enabled` 迁入 `common` + 新增 `crate::tlog!` 宏；`github.rs` / `sync.rs` / `mcp.rs` / `db.rs` 的诊断输出全量改走 `tlog!`（默认静默，`TASKBOARD_LOG=1` 放行）。真实失败仍走结构化通道：同步 warning→UI 横幅/`sync_logs`、MCP→JSON-RPC 错误、`lib.rs` 三处（连接失败/同步失败/quarantine）保持常开。

### 明确没做的

- **Keychain 存 PAT**：需引入 `keyring` 新依赖，按 §2.5 暂缓；当前“0600 文件权限 + token 不落日志”作为短期方案。长期方案（DB 只存 hash + Keychain 存本体）留后续 issue。
- **`delete_account` RAII**：已在 PR-2（#147）落地，本 issue 略过。

## 接口 / 行为变更

- `open_in_browser`：非 GitHub 链接现在报错（此前任意 URL 直接打开）；Windows/Linux 从“静默失败”变为可用。
- 默认日志变安静；排障需 `TASKBOARD_LOG=1`（含 e2e 快照测试的诊断输出）。
- 其余签名无变更。

## 数据 / Schema 变更

- 无（`user_version` 不变；权限变更作用于文件系统，不进库）。

## 测试 / 验收

- `cargo check` 通过；`cargo test --lib` 34 passed（含新增 URL 白名单 1 例、0600 权限 1 例）。
- e2e：`TASKBOARD_LOG=1` 下快照同步 487/8/88/33/5（与基线一致，17.5s）；默认环境同步通过且零诊断输出（门控生效）。
- 待人工：dev 构建看 Console CSP 无拦截；Windows/Linux 实点外链；`ls -l` 确认生产库 0600（下次打开自动收紧）。

## 相关链接

- Issue: #149（安全加固）
- 分支：`feature/issue-149-security-hardening` → PR 到 `develop`
- 前置 KB：[docs/perf-audit-optimization.md](./perf-audit-optimization.md) P2 章节
- 改动文件：`common.rs`（门控宏/URL 白名单）、`db.rs`（门控统一+0600）、`github.rs`/`sync.rs`/`mcp.rs`（tlog）、`commands.rs`（open 分发）、`tauri.conf.json`（CSP）

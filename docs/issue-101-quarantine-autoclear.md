# issue-101：首启自动清除 gatekeeper quarantine，MCP 免 sudo 开箱即用

> v0.3.44 · 关联 [Issue #101](https://github.com/ShawnLiuSZ/task-dashboard/issues/101) · 前置根因 [Issue #87](https://github.com/ShawnLiuSZ/task-dashboard/issues/87)

## 背景 / 动机

内置 MCP server 以 stdio 被客户端拉起（`/Applications/TaskBoard.app/Contents/MacOS/taskboard` + `args:["mcp"]`）。用户配好 MCP 后高频报：

```
Failed to reconnect to taskboard: MCP server taskboard connection timed out after 30000ms
```

[Issue #87](https://github.com/ShawnLiuSZ/task-dashboard/issues/87) 已定位根因：本 App 为 **ad-hoc 签名**（`tauri.conf.json` 的 `macOS.signingIdentity = "-"`，无 Developer ID / 未公证）。客户端 spawn 主二进制时，Gatekeeper 对带 **`com.apple.quarantine`** 的二进制做首启评估，显著拖慢/拦截握手，30s 窗口内等不到握手即超时。此前解法是让用户手动 `sudo xattr -dr com.apple.quarantine`。

本 issue 目标：**无证书前提下，安装后配好 MCP 即可直接可用**，不再要求手动 sudo。

## 设计 / 方案

### 核心事实（实测）

- 当前 `/Applications/TaskBoard.app/Contents/MacOS/taskboard` 确实带 `com.apple.quarantine`（Safari 下载标记）。**注意实际隔离属性在可执行文件上。**
- **移除自身文件 quarantine 无需 sudo**：当前登录用户拥有自身 bundle，`xattr -d com.apple.quarantine <自己的文件>` 对当前用户即成功。于是 App 应用主体现有足够权限在运行时自清 quarantine。

### 实现（主案，见 [lib.rs](file:///Users/liushizhao/dev/dashboard/app/src-tauri/src/lib.rs)）

在 Tauri `setup()` 启动入口、任何初始化之前：

1. `std::env::current_exe()` 取主二进制自身路径。
2. `xattr -l` 检测是否含 `com.apple.quarantine`（闭包 `has_quarantine`）。
3. 有则 `xattr -dr com.apple.quarantine <path>` 递归清除（**免 root**）；再 `has_quarantine` 复核。
4. 清除成功则 `app.emit("quarantine-cleared", ...)` 外发一次性提示，并 `eprintln!` 启动日志记录。

代码以 `#[cfg(target_os = "macos")]` 隔离，非 macOS 完全不编译；不引入新依赖。

### 关键权衡

- **为何不等 `mcp` 子进程再去清**：MCP 子进程由客户端 spawn，路径/身份与 GUI 一致但非用户主动打开，清自身同样可行；但集中在 `setup()` 一次搞定更简单，覆盖所有后续 spawn。
- **为何保留手动 fallback（Option C）**：若 App 被 Gatekeeper 硬拦、连首启逻辑都进不去，无法自清，只能手动清理。故 [troubleshoot-mcp-timeout.md](./troubleshoot-mcp-timeout.md) 保留 `sudo xattr -dr` 一条命令兜底。
- **未实现 Option B（首启预热 MCP 子进程）**：会额外 spawn 子进程、增加首启开销，收益有限，本期不引入（避免 scope 膨胀）。

### 一次人工步骤说明

macOS 对 ad-hoc 未公证 App「首次 GUI 打开需放行一次」（右键-打开或系统弹窗）是系统强制行为，无法也无须绕过。这正是设计上唯一一次人工步骤，之后全靠自动清除。

## 接口 / 行为变更

- **无外部 API / MCP 工具变更**；新增 Tauri 事件 `quarantine-cleared`（一次性提示，前端可选监听）。
- 新增 macOS-only 私有函数 `autoclear_self_quarantine` / `autoclear_self_quarantine_and_notify`。
- 行为：首次 GUI 启动自动清除自身 quarantine；[troubleshoot-mcp-timeout.md](./troubleshoot-mcp-timeout.md) 更新「App 自动清除」为首选方案。

## 数据 / Schema 变更

无（纯启动期环境自检修复）。

## 测试 / 验收

- `cargo check`（macOS）通过（逻辑为 OS 集成，无纯逻辑可单测）。
- 手动验收（多机 / 全新下载）：
  1. 复现：`xattr -w com.apple.quarantine "<sig>" "/Applications/TaskBoard.app/Contents/MacOS/taskboard"` 使其带 quarantine。
  2. 启动 App → `xattr -l` 该文件不再显示 quarantine；日志出现 `[#101] quarantine cleared`。
  3. WorkBuddy / Claude Code 配好 MCP 触发连接 → 工具可发现可调用（`update_task_status` / `get_task_status` 正常），连续多次会话不再 `connection timed out`。
  4. 全新 Safari 下载安装 → 首次 GUI 放行 → App 自动清除 → MCP 直接可用。

## 相关链接

- Issue：[#101](https://github.com/ShawnLiuSZ/task-dashboard/issues/101)（本）；根因 [#87](https://github.com/ShawnLiuSZ/task-dashboard/issues/87)
- 代码：`app/src-tauri/src/lib.rs`（`setup()` + `autoclear_self_quarantine*`）
- 排障：[troubleshoot-mcp-timeout.md](./troubleshoot-mcp-timeout.md)
- MCP 契约：[mcp_server/AGENT_INSTRUCTIONS.md](../mcp_server/AGENT_INSTRUCTIONS.md)
- CHANGELOG：`docs/CHANGELOG.md` / `docs/CHANGELOG.en.md` v0.3.44
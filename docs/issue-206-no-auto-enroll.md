# Issue #206：取消启动自动接入

## 背景 / 动机

App 启动时 `ensure_global_defaults()` 自动给所有已装 host 注册全局 hooks/MCP。owner 要求安装完不自动接入，一律由用户在设置页点"一键安装"手动接入。对应 issue：[#206](https://github.com/ShawnLiuSZ/task-dashboard/issues/206)。

## 设计 / 方案

- `lib.rs` 启动流程删除自动注册调用（#101 quarantine 清除保留）
- `hooks.rs` 删除 `ensure_global_defaults`（唯一调用方已删，避免 dead_code）
- `is_dev_binary` 转给手动安装流程：开发版手动安装成功时追加时效提醒 notice（保留 #193 意图，行为从"跳过"变为"提示"）；`global_opencode_mcp_notice` 的开发版警告不变
- 安装/状态/卸载命令与前端均不动（均直调 `install_one`/`status_one`）

## 接口 / 行为变更

- 启动行为：全新环境启动不再写任何全局配置
- 手动安装：开发版成功时多一条"路径重编即失效" notice；正式版无变化

## 数据 / Schema 变更

无。

## 测试 / 验收

- 新增 `manual_install_with_dev_binary_warns`（dev 提示有、正式版无）
- `cargo test` 67 + 19 passed；`cargo check` 无新增 warning

## 相关链接

- Issue：[#206](https://github.com/ShawnLiuSZ/task-dashboard/issues/206)
- 分支：`fix/issue-206-no-auto-enroll`
- 前序：`docs/issue-177-claude-session-hooks.md`（启动自动注册）、`docs/issue-193-polish.md`（dev 跳过）
- `CHANGELOG.md`：待发版时追加

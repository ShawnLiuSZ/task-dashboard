# Issue #190：hooks 安装/卸载备份不对称

## 背景 / 动机

2026-09-11 review 发现 `app/src-tauri/src/hooks.rs` 安装/卸载路径备份策略不对称：卸载处处留备份，安装路径三处丢备份/错备份。用户定制被静默覆盖后无法回滚。对应 issue：[#190](https://github.com/ShawnLiuSZ/task-dashboard/issues/190)。

## 设计 / 方案

原则：**任何破坏性写之前先 `backup_once`（仅首份），调用方只负责上报备份路径**，与全局 opencode 路径（`strip_global_opencode_mcp` / `merge_global_opencode_mcp`）对齐：

1. `strip_opencode_mcp` 内部在改动前备份，签名新增 `backup: Option<String>` 返回值；`uninstall_one` 删除事后备份调用，只上报。
2. `install_one` 文件循环：已存在且与模板不一致 → `backup_once` + `notices` 告知覆盖。
3. `install_one` settings 合并：`sp.exists()` 时先备份再 `write_atomic`（新建文件跳过）。

## 接口 / 行为变更

- `strip_opencode_mcp` 签名：`(bool, bool, Option<String>)` → `(bool, bool, Option<String>, Option<String>)`（内部函数，无 Tauri command 变更）。
- 安装覆盖用户定制脚本时新增一条 `notices`（含备份路径）。
- 其余 Tauri command 入参/返回值不变。

## 数据 / Schema 变更

无（只涉及用户配置目录下的 `.taskboard-bak` 备份文件）。

## 测试 / 验收

- 新增 3 单测（`hooks.rs::tests`）：`uninstall_project_opencode_backup_holds_original`、`install_overwrites_custom_script_with_backup`、`install_settings_merge_backs_up_existing`
- `cargo test hooks::`：27 passed；全量 `cargo test`：63 + 19 passed
- 验收标准见 issue #190（备份内容等于改前原文、上报备份路径、幂等重装零写入）

## 相关链接

- Issue：[#190](https://github.com/ShawnLiuSZ/task-dashboard/issues/190)
- 分支：`fix/issue-190-191-hooks-backup-auto-start`
- `CHANGELOG.md`：待发版时追加

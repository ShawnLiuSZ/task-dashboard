# Issue #228：同步/写回记录请求与返回参数

## 背景 / 动机

排查问题需要看到发了什么、回了什么。认领/写回只有结果行，同步各 API 调用几乎无记录。对应 issue：[#228](https://github.com/ShawnLiuSZ/task-dashboard/issues/228)。

## 设计 / 方案

- `github.rs` 新增统一 `log_api_call`（走 `tlog!` verbose 门控）：方法 + URL/查询头 + 状态码 + 耗时；`get_with_timeout` 成功/失败、`graphql` 成功/业务错误全埋点（成功日志此前没有）
- 用户主动写操作保留 `eprintln!` 常开行并补摘要：认领（请求体 + 远端 assignees + 失败片段）、状态写回（四件套 id + 确认 id + 失败片段）；绝不记 PAT
- 同步高频调用默认静默（`TASKBOARD_LOG=1` 开启）；错误原文案一字未动（只加日志行）
- 纯函数 `summarize_text`（空白折叠 + 按字符截断，多字节安全）可单测

## 接口 / 行为变更

无（只加日志）。

## 数据 / Schema 变更

无（落盘日志表如需 in-app 查询再另起 issue）。

## 测试 / 验收

- `summarize_text_truncates` + 既有 mutation 用例
- `cargo test` 72 passed、`cargo check` 零 warning
- `TASKBOARD_LOG=1` 下同步可见每路调用；认领/写回默认日志含请求与返回摘要

## 相关链接

- Issue：[#228](https://github.com/ShawnLiuSZ/task-dashboard/issues/228)
- 分支：`feature/issue-228-api-logging`
- 后续：[#235 应用内 API 调用明细](./issue-235-in-app-api-log.md) —— 本文的埋点只到 stderr（默认静默），#235 补上「落盘 `api_logs` + 应用内日志面板可视化」，即本文「数据 / Schema 变更」中预判的「落盘日志表如需 in-app 查询再另起 issue」。

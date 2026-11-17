# issue-589：test_server RepoFilterAC docstring 移除过时「先测后写」声明

> 关联：[#589](https://github.com/ShawnLiuSZ/task-dashboard/issues/589) ｜ 2026-11-17 全量核查报告 低危-8

## 背景 / 动机

`mcp_server/test_server.py::RepoFilterAC` 类的 docstring 仍写：

> ⚠️ 先测后写：实现尚未含 `repo` 参数。AC-1/3/4 调用时会因「`repo` 不是合法关键字参数」
> 抛 TypeError（红，属实现未就绪的可接受红）；AC-2 不传 repo，现行为应已通过。

但实现**已完成**：`server.py::tool_list_my_tasks(status, ownership, repo)`（:894）已含
`repo` 参数（#546），且 #575（中危-8）又补了三入参统一类型校验。本类 5 例全绿、退出码 0。
docstring 误导后来者以为实现未就绪。

## 设计 / 方案

**纯文档修正（无行为变更）**：docstring 改为「#546 实现已含 `repo` 参数，四条 AC 全部由
`tool_list_my_tasks(status, ownership, repo)` 直接支持；#575 补了三入参统一类型校验
（非字符串 ⇒ ValueError）。本类 5 例全绿，属实现后的 AC 验收，不再是先测后写、可接受红」。

## 接口 / 行为变更

- 无（仅 docstring 文本，不改断言）。

## 测试 / 验收

- `python3 -m unittest mcp_server.test_server.RepoFilterAC` 5 例全绿（文档修正不改变断言）。
- docstring 现与 `server.py::tool_list_my_tasks` 签名（含 `repo`）与 #575 类型校验注释一致。

## 相关链接

- Issue：[#589](https://github.com/ShawnLiuSZ/task-dashboard/issues/589)
- 核查报告：`CODE-REVIEW-2026-11-17.md`（低危-8）
- 既有：#546（repo 过滤引入）、#575（三入参类型校验）

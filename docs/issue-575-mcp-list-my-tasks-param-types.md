# issue-575：list_my_tasks 三入参缺类型检查

> 关联：[#575](https://github.com/ShawnLiuSZ/task-dashboard/issues/575) ｜ 2026-11-17 全量核查报告 中危-8

## 背景 / 动机

`mcp_server/server.py` 的 `tool_list_my_tasks(status=None, ownership=None, repo=None)`
（:894-917）三入参无类型校验。非字符串入参导致：

- `ownership` 传 `["a"]` / `repo` 传 `["r"]` / `{"a": 1}` ⇒
  `sqlite3.InterfaceError: Error binding parameter 0 - probably unsupported type`
  （**不透明**，客户端拿到非干净错误）。
- `repo` 传 `5`（int）⇒ `not 5` 为 False，绕过「空串非法」检查（:909），静默查
  `repo=5` 返回 0 行（**语义错**，非「类型错误」）。
- `status` 传 `["x"]` ⇒ `resolve_status` 返回 None ⇒ `ValueError: 非法状态: ['x']`
  （文案丑陋但可接受）。

对照 Rust 侧 `tool_list_my_tasks` 的 serde 反序列化：非字符串类型直接反序列化失败。

## 设计 / 方案

1. `tool_list_my_tasks` 顶部统一校验三入参：非 None 且非 str ⇒
   `raise ValueError(f"{name} 必须是字符串，实际是 {type(...).__name__}")`。
2. 补正反用例 + 按 AGENTS.md §5.6 做注入确认。

## 接口 / 行为变更

- 非字符串入参从「不透明 sqlite3.InterfaceError / 静默错行为」改为干净的
  `ValueError: X 必须是字符串`。
- 合法字符串行为不变。

## 测试 / 验收

- `test_server.py::RepoFilterAC::test_param_types_must_be_string`：status/ownership/repo
  各传 list/int/dict ⇒ `ValueError` 且消息含「必须是字符串」。
- 全量 `python3 -m unittest discover -s mcp_server -p 'test_server.py'` 79 例全绿。
- **反向验证**（§5.6）：移除类型校验 ⇒ 子用例 `InterfaceError` / 错文案变红；还原全绿。

## 相关链接

- Issue：[#575](https://github.com/ShawnLiuSZ/task-dashboard/issues/575)
- 核查报告：`CODE-REVIEW-2026-11-17.md`（中危-8）
- 既有：#546（repo 维度过滤）/ #357（空 repo 非法）

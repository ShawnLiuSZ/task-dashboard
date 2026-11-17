# issue-573：tools/call 的 params 非对象导致无响应挂起

> 关联：[#573](https://github.com/ShawnLiuSZ/task-dashboard/issues/573) ｜ 2026-11-17 全量核查报告 中危-7

## 背景 / 动机

`mcp_server/server.py` 的 `handle()`（:1650-1652）：

```python
name = msg.get("params", {}).get("name")
arguments = msg.get("params", {}).get("arguments", {})
```

JSON-RPC 2.0 规定 `params` 可为任意类型，`tools/call` 规范要求是对象，但**不校验的
客户端会发非对象**。若 `"params": "oops"` / `["a"]` / `null` / `123`，则
`str/list/NoneType/int` 没有 `.get()` ⇒ `AttributeError`，且发生在 :1653 的 try **之外**。

main 循环（:1704-1708）有兜底 try ⇒ 进程不断流，但该帧被丢弃、**无任何响应** ⇒
agent 侧等待超时挂起（比断流更难察觉）。

## 设计 / 方案

1. `tools/call` 分支先校验 `params` 必须是 dict（object），否则按 JSON-RPC 2.0 返回
   `error: {code: -32602, message: "tools/call 的 params 必须是对象，实际是 <type>"}`。
2. `arguments` 在 `call_tool` 内经 `(arguments or {}).items()` 已有兜底，未改。
3. 补正反用例 + 按 AGENTS.md §5.6 做注入确认。

## 接口 / 行为变更

- 非法 `params` 从「无响应挂起」改为「返回 -32602 Invalid params」（规范行为）。
- 合法 dict `params` 行为不变。

## 测试 / 验收

- `test_server.py::HandleParamsTest`：
  - `test_non_dict_params_returns_invalid_params`（str/list/None/int/float/bool → -32602）
  - `test_dict_params_still_works`（dict 行为不变，未知工具 isError）
  - `test_missing_params_defaults_to_empty`（无 params 键安全处理）
- 全量 `python3 -m unittest discover -s mcp_server -p 'test_server.py'` 78 例全绿。
- **反向验证**（§5.6）：移除 isinstance 校验 ⇒ `test_non_dict_params_returns_invalid_params`
  全部子用例 AttributeError 变红；还原全绿。

## 相关链接

- Issue：[#573](https://github.com/ShawnLiuSZ/task-dashboard/issues/573)
- 核查报告：`CODE-REVIEW-2026-11-17.md`（中危-7）
- 既有：#345（畸形帧不得终止进程）/ #328（Rust 侧同类修复）

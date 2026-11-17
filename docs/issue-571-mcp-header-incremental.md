# issue-571：Content-Length 头部改逐字节读取（增量判限，堵 OOM）

> 关联：[#571](https://github.com/ShawnLiuSZ/task-dashboard/issues/571) ｜ 2026-11-17 全量核查报告 中危-6

## 背景 / 动机

`mcp_server/server.py` 的 `read_message` Content-Length 分支（:1514-1540）解析**头部**
仍用 `_read_line`（`stream.readline()`）：把整行先读进内存、**之后**才判
`MAX_FRAME_HEADER`（:1527）。对一条无终止符的超长头部行（如 `X-Pad: <GB 级无换行>`），
等于「先 OOM 再判超限」，上限形同虚设 —— 与 #451 修 NDJSON 分支时**同病**。

NDJSON 分支已在 #451 改为逐字节增量读取（:1498-1506），头部漏改。双路径不一致。

`test_header_over_limit_is_fatal`（:956）只断言结果 FATAL，**没验证增量** —— 不证明
「超限前未把整行读走」，退化 readline 实现同样通过该用例。

## 设计 / 方案

1. 新增 `_read_header_line(stream, first=b"")`：按**字节**读一行头部（含已消费首字节），
   逐字节累积、边累积边判 `MAX_FRAME_HEADER`，超限立即返回 fatal（内存不膨胀）。
   返回 `(line, is_eof, fatal_reason)`。
2. `read_message` 的头部循环改用 `_read_header_line`（首行回填 `first`，后续行不带）。
3. 保留既有语义：正常 Content-Length / 缺头 FATAL / 头 EOF / 越界长度 FATAL 全部不回归。

## 接口 / 行为变更

无（对外分帧协议不变；仅头部读取从「先整行后判限」改为「边读边判限」）。

## 测试 / 验收

- `test_server.py::FramingTests`：
  - 新增 `test_header_limit_is_enforced_incrementally`（按需供给流：退化 readline 会把
    整个流读走 ≈ 上限+4096；增量实现 ≤ 上限+8）。
  - 既有 18 例帧测试全绿（无回归）。
- 全量 `python3 -m unittest discover -s mcp_server -p 'test_server.py'` 75 例全绿。
- **反向验证**（§5.6）：把 `_read_header_line` 退化回 `readline` ⇒
  `test_header_limit_is_enforced_incrementally` 变红（实际已读 12295 字节 > 上限+8）；
  还原全绿。

## 相关链接

- Issue：[#571](https://github.com/ShawnLiuSZ/task-dashboard/issues/571)
- 核查报告：`CODE-REVIEW-2026-11-17.md`（中危-6）
- 既有：#451（NDJSON 增量读取）/ #357（缺 Content-Length 判 FATAL）
- Rust 参考：`app/src-tauri/src/mcp.rs`（分帧同源）

# issue-579：分帧空白处理与 Rust 分歧（帧间 tab 误入 Content-Length 分支）

> 关联：[#579](https://github.com/ShawnLiuSZ/task-dashboard/issues/579) ｜ 2026-11-17 全量核查报告 低危-3

## 背景 / 动机

报告低危-3 指 `mcp_server/server.py`（:1440-1459）两处分帧空白处理与 Rust `mcp.rs` 分歧。
经黑盒核实，**实际只有一处是真分歧**：

**② 帧间空白跳过（真分歧）**：`read_message` 开头 `while first in (b"\n", b"\r", b" ")`
不认 `\t`；Rust `mcp.rs:1000` 用 `is_ascii_whitespace()`（含 `\t`）。消息间以 tab 分隔时，
Python 把 `\t` 当作 Content-Length 分支首字节，后续 `{"jsonrpc"...` 被当头部解析失败 ⇒
合法 NDJSON 消息被误判畸形。

**① 头行尾部空白（伪分歧）**：报告称 `line.rstrip(b"\r\n")` 不跳 tab 与 Rust `trim_end()`
分歧。经黑盒核实**等价**：解析处 `k, v = stripped.split(":", 1); headers[k.strip().lower()] =
v.strip()`（:1568-1569），`k.strip()` / `v.strip()` 会把 `\t` 完全吞掉 —— 头行值尾随 tab
（`Content-Length: 12\t`）在 `rstrip(b"\r\n")` 下同样解析成功。**非行为差异，无需改。**

**BOM 部分（无需改）**：报告称「BOM 前缀两侧都判 EOF 退出，而 `mcp.rs:971` 又把 BOM 列为
已修症状」。经核实 `mcp.rs:971` 的「客户端发 UTF-8 BOM → connection closed」是
`ReadOutcome` 枚举的**历史症状描述**（说明为什么区分 Eof 与 Malformed），**非**「已修」声称；
两侧遇 BOM（`\xef`）行为一致（都走 Content-Length 分支解析失败）。无需改实现。

## 设计 / 方案

1. `read_message` 帧间空白跳过改 `while first is not None and first in (b"\n", b"\r", b" ", b"\t")`
   —— 补 `\t`，对齐 Rust `is_ascii_whitespace()`。
2. ①、BOM 经核实非行为差异，不改代码（最小改动原则）。
3. 补 `test_interframe_tab_is_skipped` 守门用例 + 按 §5.6 注入确认。

## 接口 / 行为变更

- 帧间空白跳过补 `\t`：消息间以 tab 分隔的合法 NDJSON 不再被误判畸形。
- 头行解析、BOM 处理行为不变（经核实等价）。

## 测试 / 验收

- `test_server.py::FramingTests::test_interframe_tab_is_skipped`：`\t` 前缀的合法 NDJSON
  正确解析（MSG + NDJSON framing）。
- 全量 `python3 -m unittest discover -s mcp_server -p 'test_server.py'` 81 例全绿。
- **反向验证踩坑**（§5.6）：初版还补了 `test_header_value_with_trailing_tab_is_parsed`
  （守①），注入 `rstrip` 改回 `rstrip(b"\r\n")` 后**用例仍绿** —— 因为 `v.strip()` 兜底了
  tab，该用例守的不是①而是 `v.strip()`，属**伪守门**。删除之，只保留真正守②的
  `test_interframe_tab_is_skipped`（注入 `b" "` 改回 ⇒ 变红 `'eof' != 'msg'`）。
- **反向验证**：把 `b"\n", b"\r", b" ", b"\t"` 改回 `b"\n", b"\r", b" "` ⇒
  `test_interframe_tab_is_skipped` 变红；还原全绿。

## 相关链接

- Issue：[#579](https://github.com/ShawnLiuSZ/task-dashboard/issues/579)
- 核查报告：`CODE-REVIEW-2026-11-17.md`（低危-3）
- Rust 对照：`app/src-tauri/src/mcp.rs::read_message`（:993-1005 空白跳过）
- 既有：#571（头部逐字节，本分支改动的上下文）

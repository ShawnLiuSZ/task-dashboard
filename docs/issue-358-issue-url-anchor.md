# #358 issue 永久链接的尾部锚点（`#issuecomment-`）在正式 MCP 路径被拒

> 对应 issue：[#358](https://github.com/ShawnLiuSZ/task-dashboard/issues/358)
>
> 分支：`fix/issue-358-issue-url-anchor`
>
> 类别：Rust 后端 / 按需拉取（issue 引用解析，两侧一致性）

## 背景 / 动机

深度 review（#339–#346 批次）的遗留项之一。现象：**从 GitHub UI 复制的 issue 永久链接在正式 MCP 路径上被拒绝**，而 Python 兜底路径能正确解析 —— 而永久链接（形如 `.../issues/7#issuecomment-1`）是 agent 极常见的输入（用户直接粘贴）。

## 设计 / 方案

### 根因：编号解析 + 段校验两处都与 Python 侧不一致

`on_demand.rs::parse_issue_ref_parts`：

```rust
// 修复前
let repo = parts[1];
if let Ok(n) = parts[3].trim_start_matches('#').parse::<i64>() {
```

两个问题：

1. **完全忽略第 3 段**（`issues` / `pull` / `discussions` / …）⇒ `.../discussions/7` 被当成 issue 接受，而 Python 侧正则要求 `(?:issues|pull)` 会拒绝。
2. **编号整体 `parse::<i64>()`**，而 `trim_start_matches('#')` 只剥**前导** `#` ⇒ `parts[3]` 为 `7#issuecomment-1` 时解析失败。

Python 侧的对应实现：

```python
m = re.search(r"github\.com/([^/]+)/([^/#?]+)/(?:issues|pull)/(\d+)", ref)
```

`(\d+)` 在 `re.search` 语义下天然只取**前导数字**，`(?:issues|pull)` 则限定段类型 —— 两侧本就该对齐。

### 修法

```rust
let kind_ok = matches!(parts[2], "issues" | "pull");
let digits: String = parts[3]
    .trim_start_matches('#')
    .chars()
    .take_while(|c| c.is_ascii_digit())
    .collect();
if kind_ok {
    if let Ok(n) = digits.parse::<i64>() { … }
}
```

`kind_ok == false`（非 issue/pull 型资源）或编号无数字 ⇒ 走既有 `Err("无法解析 issue URL: …")`，错误文案不变（对 agent 可见，不随意改写）。

## ⚠️ 顺带纠正一条**名不副实**的既有测试

`parse_issue_ref_parts_accepts_urls` 里有一条注释：

```rust
// 尾部锚点 / 空白容忍
assert_eq!(
    parse_issue_ref_parts("  https://github.com/o/r/issues/7  ")  // ← 只有空白
        .unwrap().key,
    "r#7"
);
```

**「尾部锚点」是假的** —— 它只测了首尾空白，从未测过锚点。这与 #355 那条失效的静态守卫同源：**注释声称覆盖了什么，实际没覆盖**。本次把该注释改为「空白容忍」（只声称它真做了的事），并另加真正覆盖锚点的用例。

## 两侧一致性实测

修复后逐条对照（Rust 单测 + Python 实际调用）：

| 输入 | Python 侧 | Rust 侧（修复后） |
|---|---|---|
| `.../issues/7` | `r#7` | `r#7` ✅ |
| `.../issues/7#issuecomment-1` | `r#7` | `r#7` ✅（修复前 ❌） |
| `.../pull/12#issue-1` | `r#12` | `r#12` ✅（修复前 ❌） |
| `.../discussions/7` | 拒绝 | 拒绝 ✅（修复前接受 ❌） |
| `.../issues/abc` | 拒绝 | 拒绝 ✅ |
| `.../issues/7/extra` | `r#7` | `r#7` ✅ |

## 接口 / 行为变更

- **行为修复**（正式 MCP 路径 + GUI 按需拉取共用该函数）：带锚点的 issue/PR 永久链接现在可解析。
- **行为收紧**：非 `issues` / `pull` 型资源 URL 现在被拒绝（此前被误当作 issue）。
- **无 schema / MCP 工具签名 / i18n key 变更**；错误文案不变。

## 数据 / Schema 变更

无。

## 测试 / 验收

`app/src-tauri/src/on_demand.rs` 新增 2 例、修正 1 例注释、补 1 条断言：

1. `parse_url_tolerates_trailing_anchor` — 5 种带锚点形态（`#issuecomment-1`、`#issue-1`、`#`、`#issuecomment-999999`、前导 `#7`）均可解析，断言 `number` / `repo` / `key`。
2. `parse_url_requires_issues_or_pull_segment` — 接受 `issues` / `pull`；拒绝 `discussions` / `wiki` / `milestone`（并注明这是与 Python 侧对齐的判据）。
3. 既有 `parse_issue_ref_parts_accepts_urls` 的注释由「尾部锚点 / 空白容忍」改为「空白容忍」（只声称真实覆盖范围）。
4. `parse_ref_rejects_invalid` 补一条 URL 形态的非法编号（`.../issues/abc`）。

**反向验证（两处子修复各自独立）**：

| 回退 | 结果 |
|---|---|
| 编号改回「整体 parse + 只剥前导 `#`」 | `parse_url_tolerates_trailing_anchor` FAILED（`无法解析 issue URL: .../issues/7#issuecomment-1`） |
| `kind_ok` 恒为 `true` | `parse_url_requires_issues_or_pull_segment` FAILED（`discussions/7` 被接受） |

恢复后 152 passed。

已跑：`cargo test --lib` 152 passed（151 → +1，同步的 #355/#357 在各自分支）、`cargo fmt --check`、`cargo clippy --lib -- -D warnings`、Python MCP 单测 53 passed。

## 相关链接

- Issue：[#358](https://github.com/ShawnLiuSZ/task-dashboard/issues/358)
- 源文件：[`app/src-tauri/src/on_demand.rs`](../app/src-tauri/src/on_demand.rs)；对照 [`mcp_server/server.py`](../mcp_server/server.py)
- 同类问题（注释声称的覆盖范围与实际不符）：[#355](./issue-355-require-affected-remaining-writes.md)

- 本批其余项：[#355](./issue-355-require-affected-remaining-writes.md) / [#356](./issue-356-project-issue-updated-at.md) / [#357](./issue-357-mcp-framing-and-args.md) / [#359](./issue-359-tooling-hygiene.md)
- CHANGELOG：[`docs/CHANGELOG.md`](./CHANGELOG.md)
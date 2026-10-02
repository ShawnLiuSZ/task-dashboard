# #341 全局 `opencode.jsonc` 空 `mcp` 对象被合并成非法 JSON

> 对应 issue：[#341](https://github.com/ShawnLiuSZ/task-dashboard/issues/341)
>
> 分支：`fix/issue-341-opencode-jsonc-empty-mcp`
>
> 类别：Rust 后端 / hooks（agent 工具安装）/ 数据安全（写坏用户配置）

## 背景 / 动机

一次跨模块深度 code review 发现：给 opencode 安装 TaskBoard MCP（**全局**作用域）时，若用户的全局配置是**注释型 `opencode.jsonc` 且 `"mcp"` 是空对象**，安装完成后 `~/.config/opencode/opencode.jsonc` 变成**非法 JSON**：

```jsonc
// keep
{
  "mcp": {,                                          ← 语法错误
  "taskboard": {"command":["/bin/taskboard","mcp"],"enabled":true,"type":"local"}}
}
```

后果：**opencode 自身无法启动**（全局配置解析失败）。而安装流程返回 `Ok`、UI 报「安装成功」，**无任何错误提示** —— 用户不会知道自己需要从备份恢复。

「注释型 JSONC + 空 `mcp`」正是 opencode 的标准配置形态（用户手写最小配置的常见结果），不是边缘场景。

## 设计 / 方案

### 根因：span 契约与调用方语义错位

`hooks.rs::find_top_object_span` 返回 `(start, end)`。缺陷版本返回的 `start` 是**键起始引号**的位置：

```rust
let key_start = i;                                  // 键起始引号位置
...
if j < n && b[j] == b'{' {
    if let Some(end) = match_json_brace(b, j) {
        return Some((key_start, end));              // ← 返回 key_start，不是 j
    }
}
```

而唯一调用方（`hooks.rs:1266`）按「`ms` 是 `{` 的位置」使用它：

```rust
let inner = &text[ms + 1..me - 1];
if inner.trim().is_empty() {
    format!("{}{{\n  {}\n}}{}", &text[..ms + 1], entry, &text[me - 1..])
} else {
    format!("{},\n  {}{}", &text[..me - 1], entry, &text[me - 1..])
}
```

`ms + 1` 落在键名首字母上 ⇒ `inner` 必然以 `mcp":` 开头 ⇒ **`inner.trim().is_empty()` 恒为 false，空对象守卫是死代码**，`else` 分支永远执行，把 `,` 插到 `{` 后面。

**为什么非空场景没暴露缺陷**：非空时 `&text[..me-1]` 是 `..."mcp": {"other": {...}`，插 `,` 恰好是合法的追加操作。缺陷只在**空对象**下显形（插入点落在 `{` 之后而非值内部）。

### 修法（两处，缺一不可）

1. **返回值改为 `{` 的位置**（`return Some((j, end))`）—— 让 span 契约与调用方语义一致，空判定恢复正确。
2. **空对象分支的格式串修正**：改动 1 之后 `text[..ms + 1]` 已**含**开括号，原格式串 `{}{{\n  {}\n}}` 会多写一个字面 `{`，产出 `"mcp": {{`。改为 `"{}\n  {}\n{}"`。

> 第 2 点是本次新写测试当场抓出来的——修好第 1 点后若不复查调用方，会把 `"mcp": {,` 换成 `"mcp": {{`，仍是非法 JSON。**两处必须同时改**。

### 权衡：不改成「按值内部定位」等其他方案

另一种思路是保持返回键位置、改调用方去补偿。但那样 span 的两个返回值语义依旧错位（一个键、一个值），后续任何新调用方都要重新踩坑；让 span 自身语义自洽（`{` 到 `}` 之后）是更小的坑。

## 接口 / 行为变更

- `find_top_object_span` 返回值语义修正（私有函数，全仓库仅 1 处调用方）。
- **UI 行为修复**：全局安装场景下，用户 `opencode.jsonc` 中的空 `mcp` 对象被正确填充为含 `taskboard` 的对象，配置文件保持合法 JSON，opencode 可正常启动。
- **无 schema / MCP 工具签名 / i18n key 变更**。

## 数据 / Schema 变更

无。

## 测试 / 验收

`app/src-tauri/src/hooks.rs` 新增 2 例：

1. `global_merge_jsonc_empty_mcp_object_stays_valid_json` — 覆盖空 `mcp` 的两种书写形态（`"mcp": {}` 紧凑 / 带空格换行），断言：注释保留、条目写入、**剥离注释后能被 `serde_json::from_str` 解析**、且 `mcp.taskboard.command[0]` 结构正确。
2. `find_top_object_span_returns_brace_position` — 直接锁住 span 契约本身（`src[ms] == '{'`、`src[me-1] == '}'`、派生切片自洽），使「返回值语义被改回键起始位置」在任何调用方之前就被发现。

**反向验证**：把返回值改回 `key_start`（`cp` 备份 → `sed` 还原 → 跑测）后两例同时失败：

```
返回值应指向 `{`；实际 src[1..]="\""（src={"mcp": {}}）
[spaced] 产出非法 JSON: // keep { "mcp": {, ...
test result: FAILED. 146 passed; 2 failed
```

恢复修复后 148 passed。

**既有测试未被削弱**：`global_merge_jsonc_appends_into_existing_mcp`（非空 `mcp` 追加）与 `global_merge_creates_json_when_missing`（新建 `.json`）保持通过。

已跑：`cargo test --lib` 148 passed（146 → +2）、`cargo test --test db_test` 25 passed、`cargo fmt --check`、`cargo clippy --lib -- -D warnings`、`scripts/check-doc-links.py`、`check-mcp-columns.py`、`check-versions.py`。

## 相关链接

- Issue：[#341](https://github.com/ShawnLiuSZ/task-dashboard/issues/341)
- 源文件：[`app/src-tauri/src/hooks.rs`](../app/src-tauri/src/hooks.rs)
- 深度 review 中发现的其余 7 个缺陷：#339（卡片点击失灵）/ #340 / #342 / #343 / #344 / #345 / #346
- CHANGELOG：[`docs/CHANGELOG.md`](./CHANGELOG.md)
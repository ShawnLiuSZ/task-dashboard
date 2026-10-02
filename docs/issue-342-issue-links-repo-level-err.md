# #342 仓库级 GraphQL 失败被降级成 `Ok(空)`，父子 issue 关联被静默清空

> 对应 issue：[#342](https://github.com/ShawnLiuSZ/task-dashboard/issues/342)
>
> 分支：`fix/issue-342-issue-links-repo-level-err`
>
> 类别：Rust 后端 / GitHub 只读同步 / 数据安全（既有本地数据被清空）

## 背景 / 动机

一次跨模块深度 code review 发现：某些仓库的 issue 在详情面板的「关联 issue」区域（父 issue / 子 issue）为空，明明在 GitHub 上有父子关系，**同步过程无任何报错**。

触发场景：仓库被改名 / 转移 / 删除，或 token 失去该仓库访问权（SSO 撤权、组织策略变更）。

## 设计 / 方案

### 根因：宽松模式的判据看错了层级

#328 为解决「单个编号 NOT_FOUND 导致 25 个 issue 的父子关系一起丢」，把 `fetch_issue_links` 从严格模式 `graphql` 改为宽松模式 `graphql_partial`。其放行判据是：

```rust
// github.rs
if strict_errors || v["data"].is_null() {
    return Err(...);
}
```

但 **`v["data"]` 是仓库包装层，不是 issue 数据**。仓库级失败时 GitHub 返回：

```json
{"data":{"r":null},"errors":[{"type":"NOT_FOUND","message":"Could not resolve to a Repository"}]}
```

`data` 是**非 null 对象** ⇒ 守卫不触发 ⇒ 宽松放行 ⇒ `parse_links_from_graphql` 随后命中：

```rust
let Some(repo) = v.get("data").and_then(|d| d.get("r")).and_then(|r| r.as_object())
else { return out; };   // ← 返回空 map，不是 Err
```

实测：`{"data":{"r":null},"errors":[NOT_FOUND]}` ⇒ `data_is_null=false`、`has_errors=true`、`parsed_len=0`。

> 注：`parse_links_from_graphql` 返回空 map 本身不算错（签名 `-> HashMap` 无错误通道，且「形状不对不该让同步报错」是有意的设计）。问题出在 `fetch_issue_links` **没把这种空识别为失败**。

### 后果：安全网恰好在最需要时失效

`fetch_issue_links` 返回 `Ok(空)` ⇒ `sync.rs` 视为成功 ⇒ `links_failed_repos` **永远收不到该仓库** ⇒ 落入：

```rust
links_by_key.get(&key).map(|l| l.to_columns())
    .unwrap_or((String::new(), String::new()))   // ← 写空
```

而 `db.rs` 的 `TASK_CONFLICT_UPDATE` **无条件覆盖** `parent_issue` / `sub_issues` ⇒ 已有关联被静默清空。

`sync.rs:781-782` 注释里那道保险（「失败则保留既有值，避免一次网络抖动把已有关联清空」）**正是为这种场景设计的**，却被绕过。

### 修法

新增纯函数 `repo_level_failure`，把判据精确落在 **`data.r`** 这一层：

```rust
fn repo_level_failure(v: &serde_json::Value) -> bool {
    match v.get("data").and_then(|d| d.get("r")) {
        Some(r) => r.is_null() || !r.is_object(),
        None => true,
    }
}
```

`fetch_issue_links` 在 `parse_links_from_graphql` **之前**调用它，命中即返回 `Err`，让上层 `links_failed_repos` 正常收集、既有值得以保留。

### 关键权衡：不能把宽松整体关掉

宽松的**本意**是容忍「仓库有效、个别 issue 别名 NOT_FOUND」（同步期间该 issue 被删 / 无权）。若改回严格模式，#328 想修的「25 个关联一起丢」会重新出现。

两类失败的区分点很清晰：

| 场景 | `data.r` | 判定 |
|---|---|---|
| 仓库改名 / 转移 / 删除 / token 失权 | `null` | **失败** ⇒ 保留既有值 |
| 仓库有效，个别别名取不到 | 对象（有 `name` / `owner`） | 成功 ⇒ 其余编号照常更新 |

`!r.is_object()` 一并覆盖形状异常（`data.r` 存在但不是对象）——同样不可采信。

## 接口 / 行为变更

- `fetch_issue_links` 新增一类错误返回：仓库级失败时返回 `Err`（此前返回 `Ok(空)`）。
- **同步行为修复**：仓库改名 / 转移 / 删除 / token 失权时，`parent_issue` / `sub_issues` **保留既有值**，不再被空值覆盖。
- **仍为只读**：本改动不新增任何对 GitHub 的写操作（`AGENTS.md §2.1` 数据单向流动约束不变）。
- **无 schema / MCP 工具签名 / i18n key 变更**。

## 数据 / Schema 变更

无。

## 测试 / 验收

`app/src-tauri/src/github.rs` 新增 2 例：

1. `repo_level_null_is_detected_as_failure` — 锁定 5 种形态：`{"data":{"r":null}}`（缺陷现场）、`data.r` 非对象、缺 `data`、缺 `r`、`data` 为 null。**首条断言显式验证 `!not_found["data"].is_null()`** —— 把「顶层 `data` 是非 null 包装对象」这一旧判据失效的前提本身固化成断言。
2. `repo_level_failure_keeps_partial_tolerance` — **反向对照**：仓库有效 + 个别别名 `null`（附 `errors` 且 `path` 指向 `a1`）⇒ 必须**不**判失败，且仍能解析出其余编号的关联。防止修复过度、连带把 #328 的宽松收益也关掉。

**反向验证**：把判据改回旧写法（只看顶层 `data` 是否为 null）后，用例 1 失败：

```
test result: FAILED. 1 passed; 1 failed
```

恢复后 148 passed。

已跑：`cargo test --lib` 148 passed（146 → +2）、`cargo test --test db_test` 25 passed、`cargo fmt --check`、`cargo clippy --lib -- -D warnings`、`scripts/check-mcp-columns.py`、`check-doc-links.py`、`check-versions.py`。

## 相关链接

- Issue：[#342](https://github.com/ShawnLiuSZ/task-dashboard/issues/342)
- 引入宽松模式的前序改动：#328（见 [`docs/issue-328-p1-data-safety.md`](./issue-328-p1-data-safety.md)）
- 源文件：[`app/src-tauri/src/github.rs`](../app/src-tauri/src/github.rs)
- 深度 review 中发现的其余 7 个缺陷：#339 / #340 / #341 / #343 / #344 / #345 / #346
- CHANGELOG：[`docs/CHANGELOG.md`](./CHANGELOG.md)
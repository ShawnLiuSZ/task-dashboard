# #407：GraphQL 链接查询的顶层字段选集无人断言

> 断言强度审计续篇 —— `github.rs` 的 `build_links_query` / `repo_level_failure`。
> 所属版本：v0.3.22（待发版）· 关联 issue [#407](https://github.com/ShawnLiuSZ/task-dashboard/issues/407)
> 方法论见 [`methodology-assertion-strength-audit.md`](./methodology-assertion-strength-audit.md)

## 背景 / 动机

选这两个函数的理由：#278 把它们抽成纯函数时，注释就写明「GraphQL 语法错只在真实请求时才暴露，**代价高**」—— 即它们的价值全在**预防性断言**上。

## 审计结果：14 个变异 —— 10 捕获、1 等价、**2 真实存活**

### 捕获良好（10 个）

| 函数 | 变异 | 结果 |
|---|---|---|
| `repo_level_failure` | `data.r` 缺失判失败 | 捕获 ✅ |
| | `r` 为 null 不判失败（**#342 缺陷本体**） | 捕获 ✅ |
| | 改用顶层 `data` 判据（**#342 注释警告的错误做法**） | 捕获 ✅ |
| `build_links_query` | owner/repo 不转义 | 捕获 ✅ |
| | 漏 `name owner` 字段选集 | 捕获 ✅ |
| | `subIssues` 的 `first` 上限被改 | 捕获 ✅ |
| | 别名序号偏移（从 1 开始） | 捕获 ✅ |
| | 别名不带序号（键冲突） | 捕获 ✅ |
| | `parent` 去 `... on Issue` 内联片段 | 捕获 ✅ |
| | `parent` / `subIssues` 内漏 `number` | 捕获 ✅ |

### 等价变异（1 个，非缺陷）

```rust
Some(r) => r.is_null() || !r.is_object(),   // 存活
Some(r) => !r.is_object(),                  // 等价
```

因 `serde_json::Value::Null.is_object()` 恒为 `false` ⇒ `!is_object()` 已涵盖 null
⇒ **两种写法同值**。已记入方法论文档的等价变异清单。

### 真实存活（2 个）—— 本 issue

把 `LINK_FRAGMENT` 顶层的 `"number title url ` 改成 `"title url ` 或 `"number `，
**全部测试仍然通过**。

## 根因：只断言了**参数**，没断言**字段选集**

```rust
assert!(q.contains("a0: issue(number: 278)"));   // ← 这是 issue 的**参数**
```

**从未断言节点选了什么字段**（`LINK_FRAGMENT` 的顶层部分）。

## 后果：静默降级，而非语法错

| 去掉 | 后果 |
|---|---|
| `number` | `parse_links_from_graphql` 的 `n.get("number")` 拿不到值 ⇒ `continue` ⇒ **父子关系整体丢失**，**无任何报错** |
| `title` / `url` | `link_from_node` 回落到空串 ⇒ 子 issue 卡片与父链接渲染成**空白文案** |

**耐人寻味的是**：`parent` 与 `subIssues` **内部**的 `number title url` 都有断言，
唯独**顶层**漏了 —— 而顶层恰好是 `parse_links_from_graphql` **建键的依据**。

> 这与 #376 的「字段组断言」是同一族问题：**断言了容器（参数），没断言被取用的字段（选集）**。

## 修复

在 `build_links_query_layout` 补两条：

1. `q.contains("a0: issue(number: 278) { number title url")` —— 顶层选集必须含三字段
2. **反向契约**：顶层选集**紧接别名之后**就是 `number title url parent`

### 第 2 条踩的坑

一开始用 `split_once("}")` 切选集，结果把 `parent { ... }` 的**嵌套花括号内容**
一起吃进来了：

```
left:  ["number", "title", "url", "parent", "{", "...", "on", "Issue", "{", ...]
right: ["number", "title", "url"]
```

改为 `starts_with("number title url parent")` —— 只校验**前缀顺序**，不试图解析嵌套结构
（本仓无 GraphQL 解析器，且 §2.5 不引入新依赖）。

## 反向验证 6/6

| 变异 | 结果 |
|---|---|
| 顶层去 `number` | 捕获 ✅ |
| 顶层去 `title` | 捕获 ✅ |
| 顶层去 `url` | 捕获 ✅ |
| 顶层只留 `id` | 捕获 ✅ |
| `parent` 去内联片段 | 捕获 ✅ |
| `subIssues` 内去 `number` | 捕获 ✅ |

## 接口 / 行为变更

无。纯测试补充（断言加在已有用例内，测试数不变）。

## 测试 / 验收

- [x] 2 个原存活变异转为捕获，另 4 个此前未测项亦捕获
- [x] `lib` 174 全绿
- [x] `cargo clippy --all-targets -D warnings` 0 error
- [x] `cargo fmt --check` 退出码 0

## 相关链接

- issue [#407](https://github.com/ShawnLiuSZ/task-dashboard/issues/407)
- 方法论：[`methodology-assertion-strength-audit.md`](./methodology-assertion-strength-audit.md)
- 前置：#378（把这对函数抽成纯函数的背景）、#384（`parse_links_from_graphql` 的别名守卫）、#396（跨侧 fixture 的做法）
- 源文件：`app/src-tauri/src/github.rs`（`LINK_FRAGMENT`、`build_links_query`、`repo_level_failure`）

# #384：GraphQL 父子链接解析的别名守卫空洞为真

> 断言强度审计（mutation testing）第二轮，Rust 侧第四批。
> 所属版本：v0.3.22（待发版）· 关联 issue [#384](https://github.com/ShawnLiuSZ/task-dashboard/issues/384)

## 背景 / 动机

审 `github.rs::parse_links_from_graphql` / `link_from_node`（#278 引入，抽成纯函数以便单测）。

审计前该函数只有 **2 条平凡断言**：

```rust
assert!(parse_links_from_graphql(&serde_json::json!({})).is_empty());
assert!(parse_links_from_graphql(&serde_json::json!({"data": {}})).is_empty());
```

即**整条解析路径几乎没有直接覆盖**（仅靠 `sync.rs` 的 mock 间接覆盖）。

## 发现一：别名守卫存在真实的空洞为真漏洞

```rust
// 别名固定为 `a<序号>`；`name` / `owner` 是仓库自身字段，跳过。
if !key.starts_with('a') || !key.chars().skip(1).all(|c| c.is_ascii_digit()) {
    continue;
}
```

Rust 的 `Iterator::all` 对**空迭代器返回 `true`**。所以光秃秃的 `"a"` 会被当成合法别名放行 —— **与紧邻其上的注释声明的契约相悖**（注释说「别名固定为 `a<序号>`」）。

实测确认：

```json
{"data":{"r":{"a":{"number":994}, "a1":{"number":101}}}}
```

解析结果：`[994, 101]` —— 多出一条。

### 严重性评估（如实记录，不夸大）

**当前不可达**。`build_links_query` 生成的别名永远是 `a1..aN`，真实响应里不会出现裸 `"a"`。所以这是**潜在缺陷**，不是线上 bug。

但它的问题在于**位置**：这段守卫的唯一职责就是「防御 `repo` 对象里的非别名字段」，而它恰好在**最该生效的场景**（出现一个奇怪的键）失效。若 GraphQL 查询选集变化、或有人手工加 `viewer { ... }` 之类同形字段，就会静默把仓库字段当 issue 解析。

而且 `name` 是字符串、`as_object()` 返回 `None` **恰好**挡住了它 —— 连报错都没有。这与 #380 的「静默降级」是同一族问题。

修复：`if key.len() < 2 || ...`

## 发现二：缺失 `title` / `url` 的默认值无人锁

`link_from_node` 里两处 `.unwrap_or("")`，改成 `.unwrap_or("X")` **无任何测试失败**。

该默认值直接进 UI —— 子 issue 标题、链接文案。空串是「无标题」的诚实表达，`X` 是伪造内容。

## 设计 / 方案

补 4 例，**分工互补而非重复**：

| 测试 | 覆盖 | 形态 |
|---|---|---|
| `parses_real_response_shape` | 真实响应形状：别名 + `name`/`owner` 仓库字段 + parent + subIssues | 正向：证明解析正确**且**仓库字段被跳过 |
| `rejects_non_alias_keys` | 逐个点名守卫判据：`name` `owner` `b1` `aX1` `a1x` **`a`** `a-1` | 反向：删掉任一分支立刻失败 |
| `tolerates_dirty_shapes` | 9 种脏形状（`r: null` / `r: []` / 节点是数字 / `number` 类型错 / `subIssues: null` / `nodes: null` / `nodes: [null, 7]` …） | 健壮性：不得 panic |
| `link_from_node_defaults_missing_text_fields_to_empty_string` | 缺失与**类型不符**两种情况的 `title`/`url` 回落 | 默认值锁定 |

第 1 例与第 2 例刻意做成互补：前者用「真实响应形状」证明跳过逻辑**有效**，后者把守卫判据**逐个点名**，让删掉任一分支都无法蒙混。

`parses_real_response_shape` 里额外断言 `!out.contains_key(&0)`（`name` 字段的误解析）与 `sub_issues` 的**顺序与数量保真**。

## 变异结果

| 变异 | 修复前 | 修复后 |
|---|---|---|
| `key.len() < 2` 守卫（发现一的修复本身） | — | 捕获 ✅ |
| 删掉 `starts_with('a')` | **存活** | 捕获 ✅ |
| 删掉 `all(is_ascii_digit)` | **存活** | 捕获 ✅ |
| `title` 默认值改 `"X"` | **存活** | 捕获 ✅ |
| `url` 默认值改 `"X"` | 未测 | 捕获 ✅ |
| 删掉 `out.insert` | 捕获 | 捕获 |
| 删掉 `sub_issues.push` | 捕获 | 捕获 |

## 两个「存活但不该捕获」的变异（记录以免重复排查）

审计过程中出现两个存活，逐一确认**它们不是缺陷**：

| 变异 | 为何不该捕获 |
|---|---|
| 删掉 `.filter(\|p\| !p.is_null())` | `link_from_node` 对 JSON null 走 `.get("number")?` 本就返回 `None` ⇒ **等价变异**，两种写法行为相同 |
| host 提取取 `@` **后段**（见 #382） | `@` 后段才是真实 host ⇒ 那是**正确行为** |

## 本轮的一次验证失误（重要）

第一次验证 `title-X` / `url-X` 时用了过滤条件：

```
cargo test --lib parse_links
```

而新用例名是 `link_from_node_defaults_missing_text_fields_to_empty_string` —— **不含 `parse_links`，根本没被执行**。于是两个变异都报「存活」。

改跑**全量 lib 测试**后：**3/3 全部捕获**。

> **教训：过滤条件必须覆盖新用例，否则「存活」只是验证方法的假象。**

这与本轮系列的三条纪律并列为第四条：

| # | 纪律 | 场合 |
|---|---|---|
| 1 | 注入必须确认生效 | #367（shell 吞 `${}`）、#382 |
| 2 | 变异方向必须表达真实缺陷 | #380（无限循环）、#382（`@` 后段） |
| 3 | 期望值必须外部来源 | #378（手算 `2024-02-27` 出错） |
| **4** | **过滤条件必须覆盖被测用例** | **本轮（`parse_links` 漏掉 `link_from_node_*`）** |

共同点：**先验证测量手段本身，再采信结论**。

## 接口 / 行为变更

- `parse_links_from_graphql` 的别名守卫新增 `key.len() < 2`，裸 `"a"` 键不再被当作别名
- 该键在当前查询下不会出现，故**对现有行为无影响**（纯防御性加固）

## 数据 / Schema 变更

无。

## 测试 / 验收

- [x] 4 个新用例全绿
- [x] 3 个存活变异全部捕获（改跑全量确认）
- [x] 守卫漏洞已修：`{"a": {...}}` 不再进入结果
- [x] lib 测试无回归：168 → **172**
- [x] `cargo clippy --all-targets -D warnings` 干净
- [x] `cargo fmt --check` 干净

## 相关链接

- issue [#384](https://github.com/ShawnLiuSZ/task-dashboard/issues/384)
- PR #385
- 前置：#378、#380、#382（本轮 Rust 侧前三项）、#376（前端）
- 该函数引入：#278（把父子关系查询抽成纯函数以便单测）
- 源文件：`app/src-tauri/src/github.rs::parse_links_from_graphql` / `link_from_node`
# #409：Project 条目查询的字段选集几乎全无守护

> 断言强度审计续篇 —— `GitHubClient::project_items_query`（#356 抽成纯函数）。
> 所属版本：v0.3.22（待发版）· 关联 issue [#409](https://github.com/ShawnLiuSZ/task-dashboard/issues/409)
> 方法论见 [`methodology-assertion-strength-audit.md`](./methodology-assertion-strength-audit.md)

## 背景：这个函数**已经被同类缺陷咬过一次**

`project_items_query` 的注释写着：

> ⚠️ issue 分支里的 `updatedAt` **不可删**：漏选它会让 `updated_at` 恒为 0，
> 仅经 Project 发现的 issue 卡片日期永久空白（**该缺陷已真实发生过一次**）。

即：**这个文件已经因「漏选字段 ⇒ 静默降级」付出过实际代价**。

但 #356 当时**只补了 `updatedAt` 一条断言**，其余字段选集全部无人守护。

## 实测：9 个变异全部存活

| 变异 | 后果 |
|---|---|
| 漏 `pageInfo { hasNextPage endCursor }` | **分页在第 50 条停住**，之后的 issue 永不出现 |
| 漏 `hasNextPage` | 同上（无法判断是否还有下一页） |
| 漏 `endCursor` | 同上（无法定位下一页） |
| `items(first:50)` → `first:1` | 每次只取 1 条（能续拉但代价剧增） |
| `fieldValues(first:20)` → `first:0` | Project Status 映射丢失 ⇒ 卡片落进 unclassified |
| `assignees(first:10)` → `first:0` | 归属判定失准 |
| `labels(first:20)` → `first:0` | label → 状态映射失效 |
| `comments { totalCount }` → `totalCount: 0` | 评论数恒 0 |
| `author { login }` → `login: ""` | 作者列空白 |

**全部是静默降级，不报 GraphQL 语法错。**

### `first:0` 特别隐蔽

`items(first:0)` / `fieldValues(first:0)` / `assignees(first:0)` / `labels(first:0)`
**都是合法 GraphQL 语法** —— 请求成功返回，字段为空数组，客户端回落默认值，
**没有任何错误信号**。

## 修复：1 例，四层断言

| 层 | 锁定 |
|---|---|
| **分页驱动** | `pageInfo` + `hasNextPage` + `endCursor` + `items(first:50` |
| **内容字段** | 7 条 `(字段, 它支撑什么功能)` 表驱动 |
| **反向契约** | **任何 `first:0` 都不得出现** |
| **分支结构** | `updatedAt` 属 Issue 分支、**不得**出现在 PullRequest 分支 |

### 反向契约为什么专门针对 `first:0`

它与「漏字段」不同：**语法合法、请求成功、结果为空**。
断言 `!q.contains("first:0")` 是唯一能在语法层面拦住它的手段 ——
因为你无法通过「字段是否存在」发现它。

### 分支结构那条为什么必要

GraphQL 在 `... on PullRequest` 分支里选 `updatedAt` 会因**字段不存在而整条查询报错**。
即「多选一个字段」的代价不是静默降级，而是**查询直接失败**。故显式锁住。

## 过程中又一次「变异打错位置」（本系列第三次）

第一轮验证时 5 个变异仍存活。原因：

```python
s.replace(old, new, 1)   # ❌ 命中 1083 行**另一个函数**里的同名片段
```

而目标在 `project_items_query`（1151 行）**内部**。改为按位置限定：

```python
FUNC = s.index('fn project_items_query')
i = s.index(old, FUNC)   # ✅ 只在该函数内找
```

改后 **9/9 全部捕获**。

> 这是本系列**第三次**犯「变异落到错误位置」：
> #380 / #396（插入点 anchor 只取 `fn xxx() {`）、#405（空操作变异）、**本项**（同名片段在别处）。
>
> **纪律（新增）**：变异脚本必须断言「我改的是我以为的那一处」，
> 否则「存活」只是**测量假象** —— 与纪律 1「注入须确认生效」同源，
> 但更隐蔽：注入**确实生效了**，只是生效在错误的位置。

## 反向验证 9/9

漏 `pageInfo` / `hasNextPage` / `endCursor`、`items(first:1)` / `first:0`、
`fieldValues(first:0)`、`assignees(first:0)`、`labels(first:0)`、
`comments { totalCount: 0 }`、`author { login: "" }`、`repository` 改空串、
PullRequest 分支误加 `updatedAt` —— **全部捕获**。

## 接口 / 行为变更

无。纯测试补充。

## 测试 / 验收

- [x] 9 个原存活变异全部捕获
- [x] lib 174 → **175**
- [x] `cargo clippy --all-targets -D warnings` 0 error
- [x] `cargo fmt --check` 退出码 0

## 与 #407 的关系

同一文件、相邻函数、**同一类缺口**：

| # | 函数 | 漏掉的后果 |
|---|---|---|
| #407 | `build_links_query` | 父子关系整体丢失 |
| **#409** | `project_items_query` | **分页静默停在第 50 条** |

两者共同的根因：

> **断言了「构造出的查询串包含某个别名/参数」，没逐条断言「选了哪些字段」。**

#356 已经为 `updatedAt` 付过一次代价，#407 与本项说明**同一教训需要在每个字段选集上重复施加**。

## 相关链接

- issue [#409](https://github.com/ShawnLiuSZ/task-dashboard/issues/409)
- 方法论：[`methodology-assertion-strength-audit.md`](./methodology-assertion-strength-audit.md)
- 前置：#356（抽出本函数 + `updatedAt` 那次真实事故）、#407（同文件相邻函数的同类缺口）
- 源文件：`app/src-tauri/src/github.rs::project_items_query`

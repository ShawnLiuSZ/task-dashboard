# #411：Project 状态写回 mutation 的形状断言过弱

> 断言强度审计续篇 —— #215 写回路径（TaskBoard **唯一向 GitHub 写入**的地方）。
> 所属版本：v0.3.22（待发版）· 关联 issue [#411](https://github.com/ShawnLiuSZ/task-dashboard/issues/411)
> 方法论见 [`methodology-assertion-strength-audit.md`](./methodology-assertion-strength-audit.md)

## 背景 / 动机

审 `GitHubClient::project_status_mutation` —— **用户在 UI 确认框后显式触发**的写回。

按方法论文档的目标优先级，它满足「被显式抽成纯函数以便单测」+「唯一写路径」两条，
属本仓**风险最高**的未审函数。

## 现有断言的问题：子串匹配

```rust
assert!(q.contains("updateProjectV2ItemFieldValue"));
```

把名字改成 `updateProjectV2ItemFieldValues`（拼写错误）⇒ **断言仍然通过** ——
`contains` 只要求「包含」。

> 这是**子串断言的经典漏网形态**：名称类断言必须配一条**反向契约**
> （「不得出现名字 + 多余字符的变体」），否则任何拼写错误都拦不住。

## 实测：8 个变异，5 个存活

| 变异 | 结果 | 运行期表现 |
|---|---|---|
| `mutation` → `query` | **存活** | GitHub 拒绝 ⇒ 响亮失败 |
| 响应选集 `{ projectV2Item { id } }` 丢弃 | **存活** | 调用方报「GitHub 未返回确认」⇒ **#215 功能整体失效** |
| `input:` 包装丢弃 | **存活** | GraphQL 语法错 ⇒ 响亮失败 |
| mutation 名字拼错 | **存活** | GitHub 报未知字段 ⇒ 响亮失败 |
| 参数顺序错位 | 捕获 ✅ | — |
| 单选值字段改名 | 捕获 ✅ | — |
| 值字段名拼写错 | 捕获 ✅ | — |
| 响应选集改成别的字段 | 捕获 ✅（子串 `projectV2Item` 仍在） | — |

## 严重性如实界定：**低于 #409**

**这 5 处失效在运行期都是响亮失败，不是静默损坏。**

`set_project_item_status` 明确校验响应：

```rust
let back = v["data"]["updateProjectV2ItemFieldValue"]["projectV2Item"]["id"]
    .as_str().unwrap_or("");
if back.is_empty() {
    return Err("状态回写失败：GitHub 未返回确认（mutation 无 projectV2Item.id）".to_string());
}
```

故**不存在静默数据损坏** —— 这与 [#409](./issue-409-project-items-fields.md)
（分页静默停在第 50 条）是不同量级。

## 但仍需锁定，理由有二

### ① 响应选集是查询与调用方之间的**契约**

`set_project_item_status` 依赖 `projectV2Item { id }`。漏掉它 ⇒
**每次写回都报「GitHub 未返回确认」** ⇒ #215 功能**整体不可用**。

而这个症状**极具误导性**：排查者会去查 PAT 权限（代码里那段错误提示正是这么引导的），
不会想到是查询少选了一个字段。

### ② 本函数存在的**全部意义**就是「纯函数、可单测」

让 GraphQL 形状错误在 CI 就暴露，而不是等真实请求 —— 这是 #278 立这套纯函数时的原话。

## 修复：1 例六层

| 层 | 锁定 |
|---|---|
| 1 | **必须 `mutation` 开头**（并显式断言**不是** `query`） |
| 2 | mutation 名字**精确匹配** + **反向契约「不得出现名字+多余字符的变体」** |
| 3 | `input:` 包装必须存在 |
| 4 | **响应选集 `projectV2Item { id }`**（与调用方的契约） |
| 5 | 四个 id 各自跟在对应字段名之后（防参数错位） |
| 6 | 断言消息里直接给出实际开头，排查时不必猜 |

## 反向验证 7/7

`mutation`→`query`、响应选集丢弃、`input:` 包装丢弃、mutation 名字拼错、
参数顺序错位、单选值字段改名、值字段名拼写错 —— **全部捕获**。

## 过程中一次事故（如实记录）

为验证「还原是否干净」我跑了 `git checkout app/src-tauri/src/github.rs`，
**把自己的 68 行测试删掉了**。所幸事先留了 `/tmp/g.bak`，恢复后确认改动完好。

> **教训**：检查工作区是否干净时，`git status` / `git diff --stat` 是**安全**的；
> 而 `git checkout <file>` 是**破坏性**的 —— 它不区分「变异残留」与「我自己的改动」。
> 正确顺序：**先 `git diff --stat` 看清内容，再决定是否 checkout**。

另：更早一轮我的还原脚本引用了已删除的备份文件，导致变异**累积**在文件里，
靠 `git status` 显示 M 而发现。**还原失败必须有显式中止**（现已加进脚本）。

## 接口 / 行为变更

无。纯测试补充。

## 测试 / 验收

- [x] 5 个原存活变异全部捕获，另 2 个回归无恙
- [x] lib 175 → **176**
- [x] `cargo clippy --all-targets -D warnings` 0 error
- [x] `cargo fmt --check` 干净

## 方法论新增（可复用）

### 子串断言必须配反向契约

名称类 / 标识符类断言（`contains("someName")`）**必须**额外断言
「不出现 `someName` + 多余字符的变体」，否则：

- 拼写错误（`...Value` → `...Values`）
- 版本后缀（`v1` → `v1Beta`）
- 前缀重复（`item` → `itemItem`）

**全部逃逸**。

本系列的 #407（顶层字段选集）与本项是同一族的两种表现：
**断言了「包含某物」，没断言「恰好是某物」**。

## 相关链接

- issue [#411](https://github.com/ShawnLiuSZ/task-dashboard/issues/411)
- 方法论：[`methodology-assertion-strength-audit.md`](./methodology-assertion-strength-audit.md)
- 前置：#409（同文件、字段选集类）、#407（子串/容器断言族）
- 产品约束：[#215](https://github.com/ShawnLiuSZ/task-dashboard/issues/215)（Project 状态写回，用户确认后显式触发）
- 源文件：`app/src-tauri/src/github.rs::project_status_mutation`、`set_project_item_status`

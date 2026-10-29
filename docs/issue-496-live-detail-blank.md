# 任务详情点击后整页全屏空白 — #496

> 关联 issue：[#496](https://github.com/ShawnLiuSZ/task-dashboard/issues/496)

## 现象

点击任务卡片的「查看详情」后，**整个窗口变成一片空白**（不是弹窗没弹出、也不是遮罩太暗，而是整棵 React 树被卸载，webview 里什么都不剩）。

## 根因：一处后端字段名漂移 = 整个应用白屏

`#490` 新增的实时拉取结构体 `LiveTaskDetail`（`app/src-tauri/src/on_demand.rs`）**漏写了 `#[serde(rename_all = "camelCase")]`**：

```rust
#[derive(Debug, Clone, Serialize)]
// ← 这里少了 #[serde(rename_all = "camelCase")]
pub struct LiveTaskDetail {
    pub issue: LiveIssue,
    pub comments: Vec<LiveComment>,
    pub pr_commits: Vec<LivePrCommit>,   // ⇒ 发出去是 pr_commits
}
```

它的三个兄弟结构 `LiveIssue` / `LiveComment` / `LivePrCommit` **都带**该属性，唯独最外层这个漏了。于是：

| 环节 | 值 |
|---|---|
| 后端序列化 | `{ "issue": {...}, "comments": [...], "pr_commits": [...] }` |
| 前端 `types.ts` 期望 | `{ issue, comments, prCommits }` |
| 运行时实际 | `live.prCommits === undefined` |

`issue` / `comments` 是单个单词，camelCase 与否同名 ⇒ **只有 `pr_commits` 暴露问题**，这正是它能潜藏到「一点就崩」的原因。

然后 `DetailPanel.tsx` 里：

```tsx
{live && live.prCommits.length > 0 && (   // undefined.length ⇒ TypeError
```

→ 详情面板渲染抛 `TypeError: Cannot read properties of undefined (reading 'length')`
→ React 卸载整棵树 → **窗口全屏空白**。

时间线完全吻合：`#490` 引入实时拉取 ⇒ 打开详情 ⇒ 实时数据到达 ⇒ `setState` 触发重渲染 ⇒ 崩。崩在「数据到达后」，所以本地库阶段（未拿到实时数据）一切正常。

### 为什么影响面这么大

一处**后端字段名**的漂移，直接等价于「整个前端白屏」。中间的每一环都「看起来是对的」：

- `api.ts` 写的是 `invoke<LiveTaskDetail>(...)` —— `invoke<T>` 只是**类型断言**，运行时**不校验**形状；
- `types.ts` 的 `LiveTaskDetail` 声明得完全正确 —— TS 编译期不会发现后端没按它来；
- 后端也没有任何测试断言「发出去的键名」。

三处都只声明了契约，**没有一处验证契约**，漂移就一路畅通到渲染期。

## 修复

### 1. 后端补上 camelCase（`on_demand.rs`）

`LiveTaskDetail` 补 `#[serde(rename_all = "camelCase")]`，并在注释里写明**这个属性不能删**及其后果。

### 2. 后端加回归防线（单测）

`on_demand::tests::live_task_detail_serializes_camel_case_keys` —— 直接断言**序列化后的键名**：

- 顶层是 `prCommits`（且**不是** `pr_commits`）；
- 嵌套 `issue.commentsCount`、`comments[0].createdAt` 同样是驼峰。

只有后端能保证「发出去的键名」与前端期望一致，所以断言写在后端。

**反向验证**：把这行 `rename_all` 删掉后，该用例立即失败并报出
`顶层键必须是 prCommits，实际是 ["comments", "issue", "pr_commits"]` —— 正是本 issue 的根因。

### 3. 前端加防御层（`app/src/utils/liveDetail.ts`，新文件）

新增纯函数 `normalizeLiveDetail(v: unknown)`，把 IPC 返回值规范化成「**形状一定安全**」的对象：

| 输入 | 输出 |
|---|---|
| 驼峰正常载荷 | 原样保留 |
| **蛇形键载荷（#496 的实际故障载荷）** | 不抛错；未被消费的键降级为空数组 |
| `issue` 缺失 | 用**空 issue** 兜底（渲染期可安全访问 `live.issue.assignees`） |
| 字段类型不对 | 逐字段降级为空值 / 0 |
| `comments` / `prCommits` 非数组 | 空数组 |
| 条目缺 `url` / 缺 `sha` | 该条目丢弃（分别是跳转目标与 React key） |
| 根本不是对象（含数组） | `null` ⇒ 调用方按「无实时数据」处理 |

配套改动：

- `api.ts` 的 `fetchTaskDetailLive` 返回类型由 `LiveTaskDetail` 改为 **`unknown`** —— `invoke<T>` 是断言不是校验，声明成 `unknown` 后**类型层面**就强制调用方走规范化；
- `DetailPanel.tsx` 在 `.then` 里先 `normalizeLiveDetail(d)` 再 `setLive`；
- 渲染期派生值一律用「**数组非空判据**」（`Array.isArray`）而不是「字段存在」：
  `livePrCommits` / `liveAssignees` / `liveLabels` / `liveComments` 全部先过 `Array.isArray`。

这一层把「后端契约」从「渲染期的隐式假设」降级为「运行期的显式兜底」：字段缺失 ⇒ 少显示一段内容，**绝不整页崩掉**。

### 4. 顺带修：命令层的阻塞问题（同一命令）

`commands.rs::fetch_task_detail_live` 原先是**同步** Tauri 命令，且在持有 `state.db` Mutex 的情况下串行做 3 次网络 I/O（issue + comments + PR commits）：

- 主线程被堵住即 macOS beachball（**#329** 定下的范式：「涉及网络 / 重活的命令一律 `async fn` + `spawn_blocking`」）；
- 若此刻别的线程正持有 DB 锁（同步 / 导入 / 扫描），主线程会**无限期**卡在 Mutex 上。

现改为 `async fn` + `spawn_blocking`，并且**网络 I/O 期间不持有 DB 锁**：锁内只做「取 PAT」这一亚毫秒级本地读，锁一释放就去联网。

配套地，`on_demand::fetch_task_detail_live` 的签名从 `(conn, issue_key, account_id, pr_number)` 改为 `(login, org, pat, issue_key, pr_number)` —— **完全不碰 SQLite**，从签名上杜绝「持锁联网」这条路（原先那个持 `conn` 的版本已删除，不留陷阱）。

## 测试

| 位置 | 内容 |
|---|---|
| `on_demand.rs` | `live_task_detail_serializes_camel_case_keys` —— 断言序列化键名为驼峰（含嵌套） |
| `app/src/utils/liveDetail.test.ts`（新） | 14 例：正常载荷 / **蛇形载荷不抛错** / 非对象 ⇒ null / issue 缺失兜底 / 逐字段类型降级 / 非数组 ⇒ 空数组 / 缺 url / 缺 sha 的条目丢弃 |
| `app/src/components/task-comments-list.test.tsx` | 「DetailPanel 的实时数据防御（#496）」4 例：不得裸访问 `live.prCommits` 的 `.length`、不得裸访问 `live.issue` 子字段、派生值必须走 `Array.isArray`、入口必须先规范化 |

**反向验证**（两处 mutation 均被捕获）：

| 变异 | 结果 |
|---|---|
| 后端删掉 `#[serde(rename_all = "camelCase")]` | Rust 用例失败，报出实际键名 `["comments", "issue", "pr_commits"]` |
| 前端改回裸访问 `live.prCommits.length` | 前端 2 条断言失败（接线断言 + 防御断言） |

## 影响面

- 后端：`on_demand.rs`（1 处属性 + 1 处签名重构 + 1 条单测）、`commands.rs`（1 个命令改 async）；
- 前端：新增 `utils/liveDetail.ts`（含单测）、`api.ts` 返回类型、`DetailPanel.tsx` 派生值；
- **零 DB schema 改动** ⇒ 无需跑 `check-mcp-columns.py`；**零 i18n 改动**（复用既有 `detail.liveError` 文案）。

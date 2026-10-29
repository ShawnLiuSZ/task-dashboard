# 打开任务详情时实时拉取 GitHub 详情与评论（不落库）— #490

> 关联 issue：[#490](https://github.com/ShawnLiuSZ/task-dashboard/issues/490)
> 需求原文：查看任务信息时，实时拉取该任务的详细信息与评论，**不写入本地数据库**，覆盖评论区（含关联 PR 的提交历史）。

## 背景 / 动机

详情面板（`DetailPanel.tsx`）当前展示的全部数据来自本地库：`task` 对象（同步时写入）+ `list_task_comments`（读 `task_comments` 表）。也就是说，**打开详情那一刻看到的是「上次同步的快照」**——若有人刚在 GitHub 上发了新评论、改了指派，本地库未同步前详情面板不会反映。

用户希望：**打开详情即实时从 GitHub 拉一次最新详情 + 评论**，且**明确不要落库**（「不需要存入数据库」）。

与现有 `on_demand::ensure_task_available` 的关键区别：

- `ensure_task_available` 也会拉单 issue，但它把结果**写入 `tasks` 表**（`InsertIfAbsent`），目的是给 MCP 写路径兜底（本地没命中时先拉来落库）。
- 本功能要的是一条**纯只读、零落库**的实时通道：数据只在单次请求里回传前端，绝不触碰 SQLite。两者定位不同，不互相替代。

## 设计 / 方案

### 后端：新增只读实时拉取命令（不落库）

在 `on_demand.rs` 新增 `fetch_task_detail_live(conn, issue_key, account_id, pr_number)`：

1. **解析** `issue_key`（`repo#number`）得到 `repo` / `number`（复用 `parse_issue_ref_parts`，不要求带 owner）。
2. **取账号 PAT**：按 `account_id` 调 `db::get_account_pat` 得到 `(login, org, pat)`；`pat` 为空直接报错（不发无意义网络请求）。
3. **推断 owner**：`org` 非空用 `org`，否则回落 `login`（与 `default_owner_of` 同口径——个人命名空间仓库 org 为空时退回 login）。
4. **构造客户端**：`GitHubClient::new(pat, login, api_owner)`。
5. **拉详情**：`client.fetch_issue(&api_owner, &repo, number)`（单 issue REST，不做 best-effort 降级）；`Ok(None)` 视为「远端没有」报错，`Err` 视为请求失败报错。
6. **拉评论**：`client.fetch_comments(&repo, number, &api_owner, raw.comments)`（最新 `COMMENTS_KEPT_MAX`=20 条，与同步一致）；失败不阻断主详情，回退空列表。
7. **拉 PR 提交历史**：仅当调用方传入 `pr_number > 0` 时，请求 `GET /repos/{owner}/{repo}/pulls/{pr_number}/commits`，解析为 `LivePrCommit` 列表；失败同样降级为空。

**全程零写库**——不调用任何 `write_task` / `write_task_comments`，只读 `accounts` 表的 PAT。返回 `LiveTaskDetail { issue, comments, pr_commits }`。

新增结构与既有 `CommentRef` 同款 `#[serde(rename_all = "camelCase")]`，字段命名一致 ⇒ 前端可直接把 `comments` 当 `TaskComment[]` 喂给 `TaskCommentsList`。PR 提交历史的解析抽成纯函数 `parse_pr_commits`（便于单测，不依赖网络）。

`GitHubClient::get` 原为私有方法，提升为 `pub(crate)` 以便 crate 内复用（PR commits 这类零散端点无需再写专门的 `fetch_*` 方法）。

### 前端：打开即自动拉取，覆盖评论区

`DetailPanel.tsx` 新增 `useEffect`（mount 时触发，依赖 `issueKey` / `accountId` / `prNumber`）：

- 调用 `api.fetchTaskDetailLive(task.issueKey, task.accountId, prNumber)`，拿到 `LiveTaskDetail`。
- **评论区覆盖**：`shownComments = live ? live.comments : comments`——实时评论优先，未加载时回退本地库评论（渐进增强，不闪烁）。
- **指派 / 标签覆盖**：实时 `assignees` / `labels` 优先展示，本地库值作回退。
- **PR 提交历史**：`live.prCommits` 非空时渲染一个独立区块（sha / message / author / date）。
- **「实时」徽标**：拉取成功后在标题下显示 `实时` 徽标 + 拉取时间；拉取中显示占位文案；失败时显示一行轻量提示，**不阻断详情面板**（保留本地库展示）。

按用户选择：**仅打开时自动拉取**（无手动刷新按钮），不另发网络请求。

### 为什么要「零落库」

数据流向 `GitHub → 本地 SQLite → UI / MCP` 是本项目铁律（AGENTS.md §1）。本功能是在该链路上**并行**开的一条「GitHub → UI」旁路：只读、即时、用完即弃。它不改变本地任何状态，因此：

- 不会污染下次同步的「手动态不被覆盖」语义；
- 不引入「实时数据 vs 本地数据」的双源冲突（实时数据只在面板打开期间存在于内存）；
- 天然符合「GitHub 只读」原则。

## 接口 / 行为变更

- **新增 Tauri 命令** `fetch_task_detail_live(issue_key: String, account_id: i64, pr_number: i64) -> LiveTaskDetail`（注册于 `lib.rs` 的 `invoke_handler`）。
- **前端 API** 新增 `api.fetchTaskDetailLive(issueKey, accountId, prNumber?)`。
- **新增类型**：`LiveTaskDetail` / `LiveIssue` / `LivePrCommit`（`LiveComment` 直接复用 `TaskComment` 形状），定义于 `app/src/types.ts`。
- **新增 i18n key**（zh-CN / en-US 一致）：`detail.liveBadge`、`detail.liveLoading`、`detail.liveError`、`detail.labels`、`detail.prCommitsTitle`。
- **新增样式**：`.live-badge`、`.link-ref.mono`（复用 `--accent` / `--font-mono` 等主题变量）。

## 数据 / Schema 变更

无。本次不改动 `tasks` / `task_comments` 任何列，故 **无需跑 `scripts/check-mcp-columns.py`**（仅 `tasks` 表 schema 变更时才需要）。

## 测试 / 验收

- **Rust 单测**（`on_demand.rs` 新增 2 例）：`parse_pr_commits_maps_shape`（sha 截断、author 回退、日期缺失记 0、空 sha 跳过）、`parse_pr_commits_tolerates_non_array`（非数组 / 空数组返回空，不 panic）。`cargo test --lib on_demand` 全部通过（18/18）。
- **Rust 静态检查**：`cargo clippy --all-targets -p taskboard -- -D warnings` 全绿。
- **前端静态断言**（`task-comments-list.test.tsx` 新增 5 例源码静态断言）：打开即调 `fetchTaskDetailLive`、调用带 `issueKey`+`accountId`、评论覆盖用 `live ? live.comments : comments`、PR 提交历史按需渲染、失败轻量提示。共 16/16 通过。
- **前端类型 / i18n**：`tsc --noEmit` 0 error；`npm run i18n:check` 中英 425 key 一致。
- **手动验收**（需求四条）：
  1. 打开任意任务详情，评论区自动展示来自 GitHub 的最新评论（与本地库上次同步结果可能不同）。
  2. 实时数据不写入 SQLite——验证 `taskboard.db` 无新增 / 变更（`fetch_task_detail_live` 路径不调用任何写函数）。
  3. 任务关联 PR 时，详情面板底部展示该 PR 的提交历史。
  4. 账号无 PAT / 不存在时，`fetchTaskDetailLive` 返回明确错误，前端显示提示且不崩溃。

## 相关链接

- issue：[#490](https://github.com/ShawnLiuSZ/task-dashboard/issues/490)
- 代码：`app/src-tauri/src/on_demand.rs`（`fetch_task_detail_live` / `parse_pr_commits`）、`app/src-tauri/src/commands.rs`、`app/src-tauri/src/lib.rs`、`app/src/components/DetailPanel.tsx`、`app/src/api.ts`、`app/src/types.ts`
- 既有相关：`on_demand::ensure_task_available`（落库版单 issue 拉取）、`github::fetch_issue` / `github::fetch_comments`（被复用的只读客户端方法）
- 更新记录：[`docs/CHANGELOG.md`](./CHANGELOG.md)

# #472 task 评论链接支持一对多，详情面板倒序列出全部评论

> 对应 issue：[#472](https://github.com/ShawnLiuSZ/task-dashboard/issues/472)
> 分支：`feature/issue-472-task-comment-links`
> 基线：`main` @ `7bbb260`（v0.7.6 之后）

## 一、背景 / 动机

一个 issue 的评论**只保留了一条链接**：

| 层 | 改造前 |
|---|---|
| 存储 | `tasks.latest_comment_url` —— **单值**列，只存最新一条评论的 `html_url` |
| 抓取 | `github.rs::fetch_comments` **拉了全部**评论（`per_page=100`），却只用 `.next_back()` 取最后一条 ⇒ 其余评论的链接**全部丢弃** |
| 同步 | `comment_budget = 12`/轮，仅在评论数增长时回源 |
| UI | 卡片一个「新评论」跳转链接 + 详情一个「最新评论」按钮 |

一个 issue 往往有多条评论（讨论、结论、@提及），**每条评论都是一个可跳转的链接**。
只暴露一条 ⇒ 用户想看第 2、3 条评论时只能自己去 GitHub 翻。

**需求**：① 评论链接支持一对多；② 在**详情**里**都列出来**；③ **倒序**排列。

## 二、方案选型

### 2.1 独立关系表，`tasks` 表零改动（沿用 #467 定案）

新建 `task_comments` 表承载一对多关系，**不给 `tasks` 加列**：

- 避开「`tasks` 新列必须写在 `migrate_tasks_v2_rebuild`（物理重建、写死列白名单）
  **之后**」的顺序硬约束；
- 避开 `mcp.rs::row_to_value` / `server.py` / `commands.rs::task_mapper` 三处
  **位置索引**绑定（漏改一处 ⇒ `Row::get(N)` 越界 ⇒ 前端空看板，#285 的真实事故）；
- `CREATE TABLE IF NOT EXISTS` 进 `SCHEMA` ⇒ 老库自动补齐，**不 bump
  `SCHEMA_VERSION`、不写迁移**（与 `task_prs` / `sessions` 同款先例）。

### 2.2 读端按需取，不随看板列表返回 ⭐

评论可达 100 条/issue，看板一次渲染几百张卡 ⇒ 若把评论列表挂进 `Task` 结构随
`list_tasks` 一起返回，**IPC 载荷与前端内存都会被撑爆**（300 卡 × 100 条 = 3 万个对象）。

故新增**按需命令** `list_task_comments(issue_key, account_id)`，详情面板打开时再取
（与 `list_active_sessions` 同款「按需子集单独取」的形状）。

> ⚠️ 这也顺带避免了 MCP 契约变更：`list_my_tasks` 的批量返回体不含评论列表，
> 两套 MCP 实现因此天然一致（见 §四「刻意不做的事」）。

### 2.3 倒序由后端保证

GitHub comments API 按 `created_at` **升序**返回 ⇒ 落库存 `created_at`（Unix 秒），
读端 `ORDER BY created_at DESC, comment_id DESC` ⇒ **最新在前**。

- 主序 `created_at DESC` ⇒ 最新在前；
- 次序 `comment_id DESC` ⇒ `created_at` 相同（同秒内多条 / 时间未知）时仍有
  **确定**次序，不依赖 SQLite 行序（避免同刻评论顺序抖动）。

**前端不再二次排序** —— 前端重排会掩盖后端排序写反的问题（前端测试断言的是
「按传入顺序渲染」，倒序的正确性由后端测试守住）。

### 2.3b 取哪一页：必须按评论总数取**最后一页**（2026-10-23 审查修复）

⚠️ **GitHub 的 issue comments 端点按 ID 升序返回，且不支持 `sort`/`direction`**
（官方文档：*"Issue comments are ordered by ascending ID."*）⇒ **不带 `page` 时
取到的是第 1 页 = 最旧的一批**。

| 评论总数 | 旧行为（只拼 `per_page=100`） | 修复后 |
|---|---|---|
| ≤ 100 | 第 1 页 = **全部** ✓ | 第 1 页 = **全部**（**零行为变化**） |
| 150 | 第 1 页 = **最旧 100 条** ⇒ 最新的 50 条**根本没拿到** | 第 2 页 = **最新 50 条** ✓ |

⇒ 修复前，评论数 > 100 的 issue：卡片「新评论」跳转、详情「最新评论」按钮都指向
**第 100 旧**那条；本功能列出的也是**最旧**的一批。

**修法**：把评论总数（`t.comments`，issue 元数据 / GraphQL `totalCount`）传进
`fetch_comments`，按 `page = ceil(count / per_page)` 取**最后一页**。
URL 拼装抽成**纯函数** `comments_url(full_repo, number, total)` / `comments_page(total, per_page)`
—— 原先的 URL 拼装在命令式代码里、HTTP 层硬编码 `api.github.com` 不可 mock ⇒
**这个 bug 才没法被单测挡住**；抽成纯函数后 `page` 参数可被断言。

⚠️ **代价**：评论数超过 `per_page` 时**只保留最新的那一页**（不是全部历史）。
这是「1 次 API 调用」的取舍（`comment_budget = 12`/轮）—— 用户意图是看
**最近**的讨论，不是考古。

### 2.4 「拉取失败保留既有值」

评论回源失败时**保留既有关联行**（不清空），与 PR 关联同款取舍 ——
一次网络抖动不该把详情面板里的评论链接全清掉。

靠 `TaskUpsert::comments_fetch_ok` 区分「拉取成功但确实没有评论」与「拉取失败」——
两者都表现为空列表，无法靠列表本身区分（与 `pr_fetch_ok` 同款）。

### 2.5 `latest_comment_url` 取 API 顺序的**末位**（2026-10-23 审查修复）

单值列「最新评论」的选取规则 = **API 返回顺序的末位**（GitHub 升序 ⇒ 末位即最新）。

⚠️ **不要改用「`created_at` 最大者」**：本仓 `common::iso8601_to_secs` 解析失败返回 0
⇒ 一旦**部分**评论的时间戳解析失败，「最大者」会选中一条**更旧**的评论
（0 永远输给正常时间戳）⇒ 与「最新」语义**相反**。
按 API 顺序取末位则**与时间戳解析无关**，且与改造前的 `.next_back()` **逐位相同**
⇒ 单值列真正做到「零行为变化」。

### 2.6 淘汰任务时**级联清理**关系表（2026-10-23 审查修复）

`db::prune_done_tasks`（30 天 done 窗口淘汰）原先只 `DELETE FROM tasks`
⇒ 被淘汰任务留下**孤儿行**（`task_comments` / `task_prs`）：

- ① 孤儿行**无界增长**（每个被淘汰的任务留下它全部的评论 / PR 关联行）；
- ② 同一 `issue_key` 之后被重新同步出来时，旧行会被**重新挂上** ——
  而评论数没涨就不会触发拉取（`t.comments > existing_comments`）
  ⇒ **陈旧的评论链接会一直显示**。

**修法**：同一事务内**先删关系行**（`EXISTS` 子查询查 `tasks` 判定淘汰条件）、
**后删 tasks 行**（顺序反了子查询就匹配不到）。
实现从 `sync::run` 内联抽出到 `db::prune_done_tasks` —— 原先内联在需要真实网络的
路径里 ⇒ **永远测不到**。

## 三、数据 / Schema 变更

### 3.1 `task_comments` 表

```sql
CREATE TABLE IF NOT EXISTS task_comments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id  INTEGER NOT NULL,
  issue_key   TEXT NOT NULL,
  comment_id  INTEGER NOT NULL DEFAULT 0,  -- GitHub 评论 id（次序兜底）
  comment_url TEXT NOT NULL,               -- 评论永久链接
  author      TEXT NOT NULL DEFAULT '',    -- 作者 login（不含 @）
  created_at  INTEGER NOT NULL DEFAULT 0,  -- 创建时间（Unix 秒）
  updated_at  INTEGER NOT NULL DEFAULT 0,
  UNIQUE(account_id, issue_key, comment_url)
);
CREATE INDEX IF NOT EXISTS idx_task_comments_issue
  ON task_comments(account_id, issue_key, created_at DESC);
```

- 唯一键含 `comment_url`（`html_url` 比 id 更稳，不依赖 API 是否返回 id）；
- `account_id` 必须在键里：issue_key 是 `repo#number`（不含 owner），多账号下会重复；
- **`tasks` 表零改动** ⇒ 无需迁移、无需 bump `SCHEMA_VERSION`；
- `delete_account` **级联清理**（否则残留行会被聚合视图 / 详情面板读到）。

### 3.2 Python MCP 侧同步建表

Python MCP 是**独立进程**、不走 Rust 的 `open_db` ⇒ 其 `ensure_schema` 必须**自建**
这张表，漏建 ⇒ 读到它的路径报 `no such table: task_comments` ⇒ 整个工具报错，
而 App 自身完全正常（Rust 侧由 SCHEMA 建表）、两侧单测都测不到（#169/#262/#278 同源盲区）。

`scripts/check-mcp-columns.py` 新增**第 8 条**检查（复用已有的 `table_columns_of`
解析器）：两侧**都**必须建出 `task_comments`、且**列名逐列一致**。

## 四、接口 / 行为变更

| 层 | 变更 |
|---|---|
| `github.rs` | `fetch_comments` 返回类型 `Option<String>` → `Option<Vec<RawComment>>`（**全部**评论）；新增 `RawComment` 结构；**新增 `total` 入参 + 纯函数 `comments_page` / `comments_url`（取最后一页，§2.3b）** |
| `common.rs` | 新增 `CommentRef`（`id` / `url` / `author` / `created_at`，serde camelCase） |
| `db.rs` | 新增 `task_comments` 表 + `write_task_comments`（全量替换）+ `load_task_comments`（倒序）；`delete_account` 级联清理；`TaskUpsert` 新增 `comments` / `comments_fetch_ok`；**新增 `prune_done_tasks`（淘汰时级联清理关系表，§2.6）** |
| `sync.rs` | 拉到的全部评论写入 `task_comments`（失败则跳过 ⇒ 保留既有）；新增纯函数 `comments_to_refs`（落库列表 + 最新一条，**取 API 末位**）；**调用点传评论总数** |
| `on_demand.rs` | `TaskUpsert` 新字段补齐（`comments: []` / `comments_fetch_ok: false`） |
| `commands.rs` | 新增命令 `list_task_comments(issue_key, account_id)` → `Vec<CommentRef>`（倒序） |
| `lib.rs` | 注册 `list_task_comments` |
| `server.py` | `ensure_schema` 建出 `task_comments` + 索引（schema 对齐） |
| `check-mcp-columns.py` | 新增第 8 条检查（`task_comments` 两侧建表 + 列名一致） |
| 前端 | 新增 `TaskComment` 类型 + `api.listTaskComments`；新增 `TaskCommentsList` 组件；`DetailPanel` 按需拉取并渲染；**effect 依赖加 `latestCommentUrl`（同步后重取）** |

### 刻意不做的事

- **MCP 工具契约不变**（`list_my_tasks` / `get_task_status` 仍只暴露
  `latest_comment_url` 单值）⇒ 避免批量返回体被评论列表撑爆；两套 MCP 实现因此
  天然一致，无需在 Python 侧实现读路径。
- **`tasks.latest_comment_url` 保留** ⇒ 卡片「新评论」跳转与 MCP 契约零变化；
  它取本轮列表的**末位**（API 升序 ⇒ 末位即最新，见 §2.5）。
- **不引入新依赖** ⇒ 无 chrono，时间换算复用既有 `common::iso8601_to_secs`。

## 五、测试 / 验收

| # | 标准 | 验证方式 |
|---|---|---|
| 1 | 一个 issue 的**多条**评论全部落库 | `task_comments_stores_all_comments_for_one_issue` |
| 2 | 读回**倒序**（最新在前） | `task_comments_are_returned_in_reverse_order` |
| 3 | 同刻评论次序**确定** | `task_comments_order_is_deterministic_for_same_timestamp` |
| 4 | 全量替换（旧评论行被清掉） | `task_comments_replaces_previous_rows` |
| 5 | 多账号**不串号** | `task_comments_isolated_by_account` + `list_task_comments_scopes_by_account_and_returns_reverse_order` |
| 6 | 老库首次打开自动建表 + 建索引 | `legacy_db_gets_task_comments_table_automatically` |
| 7 | 删账号级联清理 | `delete_account_cascades_task_comments` |
| 8 | 拉取到的**全部**评论都进落库列表 | `comments_to_refs_keeps_every_comment` |
| 9 | `latest_comment_url` 取**最新**那条 | `comments_to_refs_picks_the_newest_as_latest` / `..._falls_back_to_last_when_timestamp_unknown` |
| 10 | Python 侧建表 + 列齐全 | `test_ensure_schema_creates_task_comments_table` |
| 11 | 检查脚本能检出两侧不一致 | `RelationTableTests`（3 条） |
| 12 | 前端**倒序**渲染全部评论 | `task-comments-list.test.tsx`（渲染 8 条 + 接线 3 条） |
| 13 | **取最后一页**（评论数 > 100 时拿到的是最新的） | `comments_page_is_the_last_page_when_total_exceeds_one_page` / `comments_url_always_carries_the_page_parameter` / `comments_page_is_one_when_total_fits_in_one_page` |
| 14 | 时间戳解析失败**不得**让人选到更旧的评论 | `comments_to_refs_ignores_timestamp_parse_failures` |
| 15 | 淘汰任务**级联清理**关系表 | `prune_done_tasks_cascades_relation_tables` |
| 16 | 详情面板同步后**重取**评论 | `task-comments-list.test.tsx` 的「依赖必须含 latestCommentUrl」 |

### 反向验证（变异检查）

| 变异 | 期望 | 实测 |
|---|---|---|
| `ORDER BY created_at DESC` → `ASC` | 倒序断言失败 | ✅ **3 条** Rust 用例失败 |
| `write_task_comments` 去掉 `DELETE` | 全量替换断言失败 | ✅ **1 条** Rust 用例失败 |
| Python 侧整块删掉 `task_comments` 建表 | 检查脚本报错 + 脚本自测失败 | ✅ 脚本 exit=1 + **3 条**脚本用例失败 |
| 前端把列表反序渲染 | 前端倒序断言失败 | ✅ **1 条** vitest 用例失败 |
| `comments_page` 恒返回 1（= 取最旧的一批） | 分页断言失败 | ✅ **2 条** Rust 用例失败 |
| `comments_to_refs` 改回「`created_at` 最大者」 | 混合时间戳断言失败 | ✅ **1 条** Rust 用例失败 |
| `prune_done_tasks` 不清关系表 | 级联断言失败 | ✅ **1 条** Rust 用例失败 |
| 前端 effect 依赖去掉 `latestCommentUrl` | 接线断言失败 | ✅ **1 条** vitest 用例失败 |

### 已知边界

| 边界 | 说明 |
|---|---|
| 超过 100 条评论 | GitHub 按 ID 升序返回、端点无 `sort`/`direction` ⇒ 本仓**按评论总数取最后一页**（§2.3b）⇒ 拿到的是**最新**的一批，但**只保留这一页**（150 条 ⇒ 保留最新 50 条），不是全部历史。这是「1 次 API 调用」的取舍 |
| 评论拉取时机 | 仅在**评论数增长**时回源（`comment_budget = 12`/轮）⇒ 评论被删除但数量不变时，本地列表仍保留旧行（链接会 404） |
| 首次同步前 | `task_comments` 为空 ⇒ 详情面板不显示评论节，但「最新评论」按钮仍可用（走单值列） |
| `created_at` 未知 | 全部为 0 时按 `comment_id DESC` 排序；`latest_comment_url` 取 API 顺序末位（**与时间戳解析无关**） |
| 评论总数不准 | 页面数由 `t.comments` 算出；若元数据滞后，可能取到倒数第二页（GitHub 端限制，非本仓引入） |

## 六、相关链接

- Issue：[#472](https://github.com/ShawnLiuSZ/task-dashboard/issues/472)
- 前置设计（独立关系表定案）：[`issue-467-multi-pr.md`](./issue-467-multi-pr.md)
- 前端布局约束（详情面板样式）：见 [`issue-470-note-edit-modal.md`](./issue-470-note-edit-modal.md)
- CHANGELOG：[`CHANGELOG.md`](./CHANGELOG.md) / [`CHANGELOG.en.md`](./CHANGELOG.en.md)

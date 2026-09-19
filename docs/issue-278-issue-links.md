# issue #278 — 任务详情关联 parent / sub issue 并提供打开与复制

> 关联 issue：<https://github.com/ShawnLiuSZ/task-dashboard/issues/278>
> 关联 issue：<https://github.com/ShawnLiuSZ/task-dashboard/issues/279>（同期交付，工作分支纠正，独立 issue）

## 背景 / 动机

GitHub 的 issue 支持父子关系（子任务），但 TaskBoard 的任务详情此前完全不体现它：一个 issue 挂在
某个父任务下、或自身拆了 5 个子任务，看板里都看不出来，只能离开 App 去 GitHub 上看。

诉求（见 issue #278）：详情面板要能

1. 显示该 issue 的**父 issue** 编号；
2. 显示该 issue 的**子 issue 列表**编号；
3. 父与每个子项都能**在浏览器打开**、能**复制链接**。

`owner/repo#number` 与 URL 的映射已经存在（`tasks.url`），所以缺的只有「父子关系数据」这一层，
以及把它接到详情面板上。

## 设计 / 方案

### 存储：两个 JSON 字符串列，不建关联表

| 列 | 类型 | 内容 |
| --- | --- | --- |
| `parent_issue` | `TEXT NOT NULL DEFAULT ''` | 单个父 issue 的 JSON 对象，或空串 |
| `sub_issues` | `TEXT NOT NULL DEFAULT ''` | 子 issue 数组的 JSON，或空串 |

每条 JSON 只有三个字段：`{"number": 900, "title": "…", "url": "https://github.com/…"}`。

选 JSON 列而不是 `issue_links(parent, child)` 关联表，理由：

- **语义不对称**：父是 0..1、子是 0..N，关系表要额外表达方向；两个字符串列本身就是这个形状。
- **不参与任何本地逻辑**：父子关系只用于展示与跳转，不参与状态同步、筛选、排序、看板分组，
  没有 join 需求；建表意味着多一条迁移、多一组 CRUD、多一处与 MCP 的双实现同步。
- **MCP 天然透明**：agent 读到的就是 JSON 串，无需再解释第二张表的 join 结果。
- 代价是可查询性（不能 `SELECT … WHERE 父 = ?`）。当前产品不需要，真需要时再加表并回填。

### 同步：批量 alias GraphQL，只读

GraphQL 的 `subIssues` 字段属于特性开关，请求必须带 `GraphQL-Features: sub_issues` 头，否则该字段
可能返回 `null`。做法是把该头**统一注入到 `graphql()` 的每一个请求**（而非只给这条查询单独加），
避免为了一次请求复制一份 POST 实现、也让后续 GraphQL 查询都默认可用该特性。

查询形态是「一次请求拉 N 个 issue」——用别名 `a0` / `a1` … 逐个挂 `issue(number: N)`：

```graphql
query {
  r: repository(owner:"OWNER", name:"REPO") {
    name owner { login }
    a0: issue(number: 278) { number title url
      parent { ... on Issue { number title url } }
      subIssues(first: 50) { nodes { number title url } } }
    a1: issue(number: 279) { … 同上 … }
  }
}
```

- 按 `(owner, repo)` 分组、编号排序去重后**每 25 个合一个请求**，替代逐 issue 往返。
- 解析端遍历 `data.r`，只认 `a<数字>` 的键（跳过 `name` / `owner`），并以**节点自身的 `number`**
  作为 map 键（而非别名序号）——别名只用于一次请求装多个 issue，回包定位靠节点编号更稳。
- `parent` 为 `null`、`subIssues.nodes` 为空数组 → 该 issue 无关联，不入 map。

### 失败策略：best-effort，按仓库粒度保留既有值

整组拉取失败（网络、限流、PAT 无权限、该组里有 issue 已被删导致整 chunk 报错）**只跳过该仓库**：

- 该仓库本轮保留既有 `parent_issue` / `sub_issues` 值，不因一次网络抖动被清空；
- 失败记 `tlog` 但不中断同步——关系是展示信息，失败不能让看板状态回退。

这与既有 PR 关联（`pr_number` / `pr_url` / `branch`）的处理是同一取舍。

反向则正常覆盖：某仓库拉取成功、而某 issue 已无父/子关系时，写入空串，即「关系被移除」也能反映。

## 接口 / 行为变更

### 后端（`app/src-tauri/src`）

| 文件 | 变更 |
| --- | --- |
| `common.rs` | 新增 `IssueLink { number, title, url }`、`IssueLinks { parent, sub_issues }`（含 `is_empty()` / `to_columns()`）；新增解析器 `parse_parent_link` / `parse_sub_links`，空串与脏数据一律静默降级为 `None` / 空数组，不让单条坏数据弄坏整个列表 |
| `github.rs` | 新增 `fetch_issue_links(owner, repo, numbers)` + 纯函数 `build_links_query` / `parse_links_from_graphql`；`graphql()` 统一追加 `GraphQL-Features: sub_issues` 头 |
| `sync.rs` | 同步主循环前批量拉取并建 `links_by_key`（`"repo#number"` 为键）；写入时按上述失败策略取值 |
| `db.rs` | `SCHEMA` 加两列 + `open_db` 幂等 `ALTER` + `TaskUpsert` / `ExistingTask` / `load_existing_tasks` 贯穿 |
| `commands.rs` | `Task` 暴露 `parentIssue: Option<IssueLink>` / `subIssues: Vec<IssueLink>`（`rename_all = "camelCase"`），两条 SELECT 都追加这两列（位置索引 25/26，追加在末尾） |
| `mcp.rs` | `SELECT_COLS` 26 列、`row_to_value` 位置 24/25 原样透传 JSON 串 |
| `on_demand.rs` | 单 issue 按需拉取（REST）无法给出父子关系 → 两列写空串 |

### 前端（`app/src`）

- `types.ts`：新增 `IssueLink` 接口；`Task` 增 `parentIssue: IssueLink | null`、`subIssues: IssueLink[]`。
- `DetailPanel.tsx`：新增「关联 Issue」块，**仅在确实有关联时渲染**（避免每个详情多一个空块）。
  父项带「父 Issue」标签 + `#编号` + 标题；子项在列表下按 `#编号` + 标题排列。每项两个动作：
  「在浏览器打开」（复用 `openExternal`）与「复制链接」（复用 `copyToClipboard`，1.5s 后复位提示）。
- `i18n`：新增 3 个 key —— `detail.linksTitle` / `detail.parentIssue` / `detail.subIssues`（`{n}`）。
- `styles.css`：新增 `.link-line` / `.link-list` / `.link-tag` / `.link-ref` / `.link-title`，
  标题过长用 `ellipsis` 截断（详情面板 `overflow-y: auto`，不会裁切内容）。

### MCP 双实现

`SELECT_COLS` 由 24 列扩为 26 列（追加 `parent_issue, sub_issues`），`app/src-tauri/src/mcp.rs` 与
`mcp_server/server.py` **逐列、逐序**一致，`scripts/check-mcp-columns.py` 双向兜底。MCP 不做二次解析——
返回 JSON 串本身，两个实现语义一致，agent 自行 `JSON.parse`。

## 数据 / Schema 变更

`tasks` 表新增两列，位于 `author` 之后（新列追加而非插入中间，避免 SELECT 位置索引错位）：

```sql
parent_issue TEXT NOT NULL DEFAULT '',
sub_issues   TEXT NOT NULL DEFAULT '',
```

迁移遵循本项目反复踩过的教训（#155 / #175 / #237）：

1. 新库 → `SCHEMA` 里就有；
2. 旧库 → `open_db()` 的**热路径幂等 `ALTER TABLE ADD COLUMN`** 补上；
3. 走过 v2 物理重建（`migrate_tasks_v2_rebuild` 的 `INSERT..SELECT` 是写死列白名单）的库，
   同样由上述第 2 步的重建后 `ALTER` 补齐——**不能只放进 `migrate_legacy_alters`**（它只在
   `user_version < 1` 时执行，重建后的库不会触发），否则重建会丢列、`SELECT_COLS` 报
   `no such column`。

`db_test.rs` 各有一条回归：v2 旧库重开后列已补齐；真实重建后列仍在。

## 测试 / 验收

| 层 | 覆盖 |
| --- | --- |
| Rust `github.rs` | `build_links_query_layout`（alias 布局 / 空编号）、`parse_links_handles_parent_and_sub_issues`（父+子解析）、`parse_links_is_tolerant_of_shape_errors`（缺字段 / `parent` 为 `null` / 非 issue 节点不炸）——全为纯函数、不发网络 |
| Rust `db.rs` / `db_test.rs` | `open_db_backfills_issue_links_on_v2_db_without_it`（v2 旧库重开补齐）、`migrate_v2_rebuild_keeps_issue_link_columns`（重建后不丢列）、`write_task_roundtrips_issue_links_and_preserves_them_on_conflict`（写入回读 + 冲突清空 + 冲突更新） |
| Rust `mcp.rs` | `list_my_tasks` / `get_task_status` 断言 26 列逐列值，含 `parent_issue` / `sub_issues` 在位置 24/25 不错位 |
| Python | `test_server.py` fixture 补齐两列；`python3 -m unittest discover -s mcp_server` 29 例全绿 |
| 前端 | `tsc --noEmit`、`npm run build`、`npm test`（13 文件 136 例）、`i18n:check`、`npm run lint`、`prettier --check` 全绿 |
| 脚本 | `scripts/check-mcp-columns.py`（26 列、两侧一致）、`scripts/check-doc-links.py` |
| 真机 | 对 `ShawnLiuSZ/task-dashboard` 实测 alias 查询（带 `GraphQL-Features: sub_issues`）：`errors: null`、`parent: null`、`subIssues.nodes: []`、alias 与 `owner.login` 回包正常 |

验收对照 issue #278：详情显示父 + 子编号 ✅；父与每个子项均可打开 / 复制 ✅；同步反映 GitHub 关系
（best-effort + 失败保留既有值）✅；MCP 双实现一致 + 列校验通过 ✅。

## 相关链接

- Issue：<https://github.com/ShawnLiuSZ/task-dashboard/issues/278>
- CHANGELOG：[docs/CHANGELOG.md](./CHANGELOG.md) / [docs/CHANGELOG.en.md](./CHANGELOG.en.md) 的 Unreleased 段
- MCP 契约：[mcp_server/AGENT_INSTRUCTIONS.md](../mcp_server/AGENT_INSTRUCTIONS.md)
- 同期交付：[docs/issue-279-work-branch-not-updated.md](./issue-279-work-branch-not-updated.md)
- 迁移教训同类文档：[docs/issue-169-mcp-server-schema-sync.md](./issue-169-mcp-server-schema-sync.md)、[docs/issue-237-card-creator-row.md](./issue-237-card-creator-row.md)

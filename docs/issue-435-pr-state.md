# 卡片显示 PR 合并状态 + PR 行移到分配人下方（#435）

> 关联 issue：<https://github.com/ShawnLiuSZ/task-dashboard/issues/435>
> 分支：`feature/issue-435-pr-state`
> 影响面：`tasks` 新增 `pr_state` 列；`SCHEMA_VERSION` 5 → 6

---

## 需求

1. 任务卡片上的 PR 从底部 meta 行**移到「分配人」正下方独立一行**
2. PR 旁显示**真实合并状态**（open / merged / closed）

## 关键发现：成本远低于预期

### PR 走 REST，响应里本来就有状态字段

PR 采集走 **REST** `GET /repos/{owner}/{repo}/pulls?state=all&per_page=100&page=N`
（`github.rs` `fetch_prs_for_repo`，3 页 × 100 = 300 个上限）。

响应里**本来就带** `merged_at` / `state` / `draft`，只是被 `RawPr::from_item`
丢弃了（只取 `number` / `html_url` / `body` / `head.ref`）。

⇒ 加状态 = 多读一个字段，**零 HTTP 请求增量**。

### ⚠️ 纠正两个常见误解

**误解 1：「PR 走 GraphQL，加字段要改 query」** —— 错。项目的 GraphQL 只用于三处
（Project 条目、父子关系、Project 列表），PR 完全不走 GraphQL。

**误解 2：「GitHub 有 issue↔PR 的结构化关联 API」** —— 没有。现有实现是
**正则扫描 PR 正文的关闭关键词**反推：

```rust
// sync.rs
for pr in &prs {
    for rk in parse_issue_refs(&pr.body, &pr.repo) {
        pr_map.entry(rk).or_insert((pr.number, pr.url.clone(), pr.head_ref.clone()));
    }
}
```

即从 PR 正文的 `Closes #123` / `Fixes owner/repo#123` 反推出「这个 PR 关掉了
哪个 issue」，构造 `repo#number → (pr_number, pr_url, head_ref)` 的映射。

## 设计 / 方案

### `tasks.pr_state` 列

| 值 | 含义 |
|---|---|
| `'merged'` | 已合并（`merged_at` 非 null） |
| `'open'` | 进行中 |
| `'closed'` | 已关闭但未合并 |
| `''`（空串） | **未知** —— 常态，不是异常 |

**空串为何是常态**：

1. 存量行在 #435 之前没有该值（下次同步才填充）；
2. `state=all` 只拉 3 页 ⇒ 超 300 个 PR 的仓库老 PR 拉不到（已合并的老 PR
   恰好最容易超出）；
3. REST item 缺 `state` / `merged_at` 字段时。

⇒ 前端**必须能优雅降级**：空串只渲染链接、不渲染徽章。

### 状态判定：`merged_at` 优先

```rust
fn extract_state(v: &serde_json::Value) -> String {
    if v.get("merged_at").map(|x| !x.is_null()).unwrap_or(false) {
        return "merged".to_string();   // ← 能区分「已合并」与「已关闭未合并」
    }
    match v.get("state").and_then(|x| x.as_str()) {
        Some("open") => "open".to_string(),
        Some("closed") => "closed".to_string(),
        _ => String::new(),
    }
}
```

⚠️ **只看 `state` 会把「已合并」与「已关闭但未合并」混成 `closed`** ——
对用户是完全不同的信号。`merged_at` 是 GitHub 的权威判据。

### 网络抖动保护

`sync.rs` 里 `pr_state` 遵守与 `pr_number`/`pr_url`/`branch` 相同的既有语义：

```rust
let (pr_number, pr_url, branch, pr_state) = if pr_fetch_ok {
    match pr_map.get(&key) { Some((n, u, b, st)) => (...), None => (0, "", "", "") }
} else {
    // 拉取失败 ⇒ 保留既有值，避免把已知的「已合并」误降级成未知
    (existing_pr_number, existing_pr_url.to_string(),
     existing_branch.to_string(), existing_pr_state.to_string())
};
```

## Schema 变更

`SCHEMA_VERSION` 5 → 6。

| 位置 | 改动 | 理由 |
|---|---|---|
| `SCHEMA` 的 `CREATE TABLE tasks` | 加 `pr_state TEXT NOT NULL DEFAULT ''` | 新库直接建出 |
| `MIGRATION_DDL` | 加幂等 `ALTER TABLE` | 老库补列 |
| `REQUIRED_COLUMNS` | 加 `("tasks", "pr_state")` | 防 #175/#237/#278 三类「版本号谎报」事故下老库静默缺列 |
| `migrate_tasks_v2_rebuild` | **不改** | 其写死列白名单**故意是旧的**（`author`/`parent_issue`/`sub_issues`/`work_dir`/`created_at` 5 个更新的列都不在里面），新列由 `MIGRATION_DDL` 在其**之后**补 |
| `MIGRATE_DATA_FIXES` | **不改** | 存量行天然为空串，无数据可修 |
| `REQUIRED_INDEXES` | **不加** | 单列无查询需求 |

## 实现清单

### 采集

- `github.rs`：`RawPr` 加 `state` 字段 + `extract_state()` 辅助函数
- `sync.rs`：`pr_map` 元组扩到 **4 位**；新增 `existing_pr_state`；
  `TaskUpsert` 构造加 `pr_state`

### 写入（位置索引全部**末尾追加**）

| 位置 | 改动 |
|---|---|
| `TaskUpsert` | 加 `pr_state: String` |
| `TASK_INSERT_HEAD` | 列清单末尾加 `pr_state`，占位符 **`?27`** |
| `TASK_CONFLICT_UPDATE` | 末尾加 `pr_state = excluded.pr_state` |
| `write_task` 的 `params!` | **末尾**追加（顺序须与 INSERT 列清单严格对齐） |
| `ExistingTask` + `load_existing_tasks` | 加 `pr_state: r.get(10)` |
| `on_demand.rs` | `pr_state: String::new()`（按需拉取拿不到关联 PR） |

### 读取（位置索引**末尾追加**）

| 位置 | 索引 |
|---|---|
| `TASK_SELECT_COLUMNS` | `pr_state` 在**第 30 项**（索引 **29**） |
| `task_mapper` | `pr_state: r.get(29)?` |
| `mcp.rs::SELECT_COLS` | `pr_state` 在**第 29 项**（索引 **28**） |
| `mcp.rs::row_to_value` | `mcp.insert("pr_state", r.get::<_, String>(28)?)` |

⚠️⚠️ **两套 SELECT 列序完全不同**：

- `TASK_SELECT_COLUMNS`（`commands.rs`）：`... work_branch, work_dir, session_id, ...`
- `mcp.rs::SELECT_COLS`：`... work_branch, work_dir, session_id, ...` 但**前面**的
  `pr_number/pr_url/branch` 相对位置不同

⇒ **必须各自数自己的列序**，不能照抄另一处。

### 前端

- `types.ts`：`prState: string`
- `TaskCard.tsx`：
  - **新增**独立 PR 行（照抄 session 行 `#197` 的 `.meta-row` 范式），插在
    session 行之后（即分配人下方）
  - **移除**底部 meta 行里的旧 PR 块
  - 状态徽章：`merged` → 绿 / `open` → 蓝 / `closed` → 灰 / 空串 → 不渲染
- `styles.css`：`.pr-row` + `.pr-state-{merged,open,closed}`
- i18n：4 键**中英成对**（`i18n-check` 断言两侧 key 数严格相等）

## 测试 / 验收

### 新增测试

| 测试 | 守什么 |
|---|---|
| `github.rs::raw_pr_extracts_merge_state` | merged/open/closed/空串四态 |
| `mcp.rs::list_my_tasks_...` 的 `pr_state` 断言 | **位置映射**（脚本只比字符串，管不了这个） |
| `board.test.tsx` 位置契约 | PR 行在分配人**之后**、`card-bottom` **之前** |
| `board.test.tsx` × 3 状态徽章 | 三态 + 空串降级 |
| `board.test.tsx` 无 PR | `prNumber=0` 不渲染该行 |

lib 193 → **194**；vitest 276 → **281**。

### 反向验证

| 变异 | 结果 |
|---|---|
| 移除 `merged_at` 判定（只看 state） | ✅ 捕获（已合并被误判成 closed） |
| PR 行移到「创建人」上方（违反位置契约） | ✅ 捕获（4 例失败，含位置断言本身） |

### 迁移演练（生产库副本，非真库）

```
迁移前：user_version = 5，736 行，352 行有 PR
迁移后：user_version = 6，pr_state 列已建，736 行零丢失
```

### 全量门禁

| 项 | 结果 |
|---|---|
| `cargo test --lib` | **194 passed** |
| `cargo test --test db_test` | 27 passed |
| `cargo fmt --check` | 干净 |
| `clippy --all-targets -D warnings` | **0 警告** |
| `check-mcp-columns.py` | **29 列**通过 |
| `vitest run` | **281 passed** |
| `npm run lint` / `i18n:check` | 0 警告 / 401 key |
| `npx tsc --noEmit` / `prettier --check` | 通过 |

## 踩过的坑

1. **`server.py` 的 `SELECT_COLS` 括号内不能放注释** ——
   `check-mcp-columns.py` 用正则解析列名，会把括号内的 `#` 行当成列名 ⇒ 报
   「含 tasks 表里不存在的列」。注释必须写在括号**外**。
2. **`MIGRATION_DDL` 的 ALTER 语句必须带尾随空格 + 逗号** —— 有守卫测试
   `required_columns_and_indexes_are_covered_by_migration_ddl` 断言
   `format!("ALTER TABLE {table} ADD COLUMN {col} ")`，尾随空格是断言的一部分。
3. **插入测试时用「在 anchor 前插入」会割裂下一个已有测试的文档注释与
   `#[test]`** —— 表现为 `duplicated attribute` + `function is never used`
   两个 clippy 错误同时出现。插入后必须跑 clippy（`--all-targets`）确认。

## 遗留

1. **历史 PR 状态**：超过 300 个 PR 的仓库，老 PR 状态仍是空串。可考虑改用
   GraphQL 单独查单个 PR 状态，但需评估请求预算。
2. **PR 关联的 `or_insert` 首胜**：一个 issue 被多 PR 引用时**最新 PR 胜出**
   （列表按 GitHub 默认排序）。若最新是 draft/open 而旧的已 merged，会显示
   `open` —— 这其实是符合直觉的。
3. **卡片徽章颜色**：当前用固定色值（非 CSS 变量），未适配暗色主题。

## 相关链接

- Issue：<https://github.com/ShawnLiuSZ/task-dashboard/issues/435>
- 方法论：[`methodology-assertion-strength-audit.md`](./methodology-assertion-strength-audit.md)
- CHANGELOG：[`CHANGELOG.md`](./CHANGELOG.md) / [`CHANGELOG.en.md`](./CHANGELOG.en.md)
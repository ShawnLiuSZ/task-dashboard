# Issue #237：看板卡片结构调整（移除账号行 / 新增创建人行 / 加大 repo#编号 字号）

## 背景 / 动机

看板卡片自上而下原为：

```
@liushizhao2025          ← 归属账号徽章（.account-row-top，v0.3.17+）
fad-backend  #1198  ★    ← repo + 编号（.card-top，字号 11px）
【脱敏】users.username 电话明文处理…
分配人 @liushizhao2025    ← .meta-row
2026-09-01
```

三个问题：

| # | 问题 | 影响 |
|---|---|---|
| 1 | 第一行 `@<account label>` 是**同步该任务的账号 label**，不是任务属性 | 单账号视图下每张卡片都显示同一串，纯占位；多账号视图下才勉强有信息量 |
| 2 | issue **创建人**完全不可见 | 判断「谁提的」需要点进 GitHub |
| 3 | `fad-backend #1198` 是识别任务最关键的锚点，字号与正文同级（11px） | 扫视整列时缺少视觉落点 |

对应 issue：[#237](https://github.com/ShawnLiuSZ/task-dashboard/issues/237)

## 设计 / 方案

### 决策 1：账号徽章整行移除，而不是「改成只在多账号视图显示」

用户明确要求「去掉第一行」。若改为按视图模式条件渲染，会引入「同一组件两种结构」的分支，且违背「说重点」的取舍——账号归属在设置面板/顶栏已可查，无需在每张卡片重复。

**代价**：`accountLabel` 整条 prop 链变成死代码。按 `tsconfig` 的 `noUnusedLocals` / `noUnusedParameters`，未使用变量会直接编译失败，因此必须一并清理，否则 `tsc` 红：

- `TaskCard`：删 `accountLabel` prop + 解构 + 渲染块
- `Board`：删 `accounts` prop + 解构 + `cardProps` 里的传值 + 现在未使用的 `Account` 类型导入
- `App`：删 `<Board accounts={accountMap}>`（`accountMap` 本身保留——它还给 `boardMode` 用）

### 决策 2：创建人 = GitHub issue author，新增 `tasks.author` 列

`tasks` 表此前**没有**任何 author/creator 字段。数据来源：

| 拉取路径 | 字段 |
|---|---|
| Search API（`RawTask::from_item`） | `item.user.login` |
| GraphQL Project items（`fetch_project_items`） | `content.author { login }` |

两条路径都要取，否则「只在某个 Project 里、未被 Search 命中的 issue」会缺创建人。

取值策略：**缺失即为空串，不报错**。创建人只用于卡片展示，属装饰性信息；Search 响应偶发缺字段不应让整条任务同步失败（该函数原有字段用 `?` 严格报错，新字段刻意用 `unwrap_or("")`）。

### 决策 3：卡片布局——创建人行贴紧「分配人」行

目标结构：

```
fad-backend  #1198  ★     ← 13px
【脱敏】users.username…
创建人 @liushizhao2025     ← 新增
分配人 @liushizhao2025
```

CSS 上复用既有 `.assignee-*` 类（创建人与分配人是同一种「人 + @名」信息形态），只加 `.creator-row` 标记。间距：

- `.meta-row` 默认 `margin-top: 6px`
- `.creator-row` 与标题之间保持 6px
- 紧随其后的分配人行收紧到 2px（`.creator-row + .meta-row`），让「创建人/分配人」读作一对

### 决策 4：字号只放大 repo + 编号，不放大同行的状态徽章

`.card-top` 是一行 flex，除 repo/num 外还含 `★`（mine-badge，12px）、`closed` 状态、`project.status` 徽章。

`.repo` / `.num` 由 11px → **13px**；`.repo` 内边距 `1px 5px` → `1px 6px` 以匹配放大后的字面。

同行的 `.gh-status` 保持 10px：它在 CSS 中定义于 `.repo` 之后（同为单类选择器，靠源码顺序决定），天然覆盖 `.repo` 的 font-size。这是**期望**结果——状态徽章是补充信息，保持小字号才能让 repo#编号 成为视觉锚点。

### 决策 5：`tasks.author` 的迁移必须放在 v2 物理重建之后（关键）

这是本 issue 最容易踩的坑。`open_db()` 的执行顺序是：

```
1. execute_batch(SCHEMA)            ← 新库在此拿到 author
2. if user_version < 1 { migrate_legacy_alters() }
3. tasks_uses_legacy_key() → migrate_tasks_v2_rebuild()   ← 重建 tasks 表！
4. 热路径幂等 ALTER（work_branch / author）
```

`migrate_tasks_v2_rebuild` 的 `tasks_new` 定义 + `INSERT..SELECT` 是**写死的列白名单**，不包含后来新增的列。因此：

- ❌ 只写进 `migrate_legacy_alters` → 仅 `user_version<1` 触发，且**执行在重建之前**，重建会把列丢掉
- ❌ 写进 `tasks_new` 的定义里 → 老表根本没有 author 数据可 SELECT
- ✅ **重建之后的热路径幂等 ALTER**（`ALTER TABLE tasks ADD COLUMN author ...`，已存在则忽略）

这与 [#175](./issue-175-work-branch-migration-gap.md) 的 `work_branch` 完全同款，已在代码注释里交叉引用。

## 接口 / 行为变更

### 数据库

`tasks` 表新增列：

```sql
author TEXT NOT NULL DEFAULT ''   -- GitHub author login，不含 @；空 = 未知
```

### 后端

| 位置 | 变更 |
|---|---|
| `RawTask` | 新增 `author: String`（`#[serde(default)]`） |
| `RawTask::from_item` | 取 `item.user.login`，缺失/非字符串 → `""` |
| `fetch_project_items` GraphQL 查询 | Issue 片段新增 `author { login }`；`content["author"]["login"]` 缺失 → `""` |
| `PendingUpsert` | 新增 `author` |
| `sync_account_inner` upsert | INSERT 列 + `?23`；`ON CONFLICT DO UPDATE SET author = excluded.author` |
| `commands::Task` | 新增 `author: String` |
| `rows_to_tasks` | 两条 SELECT 末尾追加 `author`（**追加在最后**，避免打乱既有位置索引——参见 [#173](./issue-173-mcp-read-row-to-value.md) 的错位事故）；mapper 加 `r.get(24)` |

### 前端

- `types.ts`：`Task.author: string`
- `TaskCard`：删账号行；新增 `creator-row`（`creator !== ""` 才渲染）；`creator` 用 `(task.author || "").trim()` 计算
- `Board` / `App`：清理 `accounts` / `accountLabel` 死 prop 链
- `styles.css`：`.repo`/`.num` 13px、新增 `.creator-row + .meta-row` 收紧间距、**删除** `.account-row-top` / `.account-badge`（已无引用）
- i18n：新增 `card.creatorLabel`（创建人 / Created by）；**删除**已失效的 `card.accountTitle`

### 明确不做

- **不改 MCP 的 `SELECT_COLS`**。字段只服务 UI；加入 `SELECT_COLS` 需要同步改 `mcp.rs::row_to_value` 的位置映射（#173 同类风险），收益为零。`check-mcp-columns.py` 只校验「列真实存在 + 两侧一致」，不要求覆盖全部列，故仍然通过。
- 不做「创建人」的筛选/排序。

## 数据 / Schema 变更

新增 `tasks.author` 列。迁移方式见「决策 5」：**`open_db()` 热路径幂等 `ALTER TABLE`**，位于 `migrate_tasks_v2_rebuild` 之后，覆盖全部 `user_version`。老库数据该列为空串，下次同步回填。

## 测试 / 验收

### 验收标准

- [x] 卡片不再渲染账号徽章行；死 prop 链清理完毕，`tsc` 严格模式通过
- [x] 卡片展示创建人，位置在「分配人」行上方
- [x] 创建人未知（空/纯空白）时不渲染该行，不留空标签行
- [x] repo + 编号行 13px，`★` / `closed` / `project.status` 徽章横排对齐不受影响
- [x] `tasks.author` 老库可迁移（含 v2 重建路径）
- [x] i18n 中英一致

### 已跑验证

| 检查 | 结果 |
|---|---|
| `cargo check --lib` | ✅ 零 warning |
| `cargo test --lib` | ✅ **80 passed** / 0 failed / 2 ignored |
| `cargo test --test db_test` | ✅ **21 passed**（新增 2 例） |
| `npx tsc --noEmit` | ✅ 0 error |
| `npm run build` | ✅ 49 modules |
| `npm test` | ✅ **10 files / 84 tests**（新增 5 例） |
| `npm run i18n:check` | ✅ 中英各 302 key（删 1 加 1） |
| `python3 scripts/check-mcp-columns.py` | ✅ 24 列一致 |

### 测试有效性验证（防「空转绿灯」）

新增的两条迁移用例**已实测能在缺修复时失败**：临时把热路径 `ALTER` 的列名改成不存在的列后，

```
migrate_v2_rebuild_keeps_author_column      → FAILED（v2 重建后 author 列必须仍存在）
open_db_backfills_author_on_v2_db_without_it → FAILED（author 列应被热路径补齐）
```

确认不是恒真断言，随后已还原。

### 边界场景

- `author` 缺失 / `null` / 非字符串 → `""`，不阻断同步（有单测）
- `author` 为纯空白 → 前端 `trim()` 后不渲染该行（有单测）
- 旧后端 + 新前端（字段缺失）→ `(task.author || "")` 兜底，不会整板崩（有单测覆盖 `""` 分支）
- 同账号 upsert 时 author 随 `excluded` 更新，不会保留陈旧值

## 相关链接

- Issue：[#237](https://github.com/ShawnLiuSZ/task-dashboard/issues/237)
- 同类迁移教训：[docs/issue-175-work-branch-migration-gap.md](./issue-175-work-branch-migration-gap.md)、[docs/issue-173-mcp-read-row-to-value.md](./issue-173-mcp-read-row-to-value.md)
- 分支：`feature/issue-237-card-creator-row`
- CHANGELOG：[docs/CHANGELOG.md](./CHANGELOG.md)

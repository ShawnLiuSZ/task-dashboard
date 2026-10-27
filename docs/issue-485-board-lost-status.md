# #485 看板「按项目」视图丢失表外状态任务

> 对应 issue：[#485](https://github.com/ShawnLiuSZ/task-dashboard/issues/485)
>
> 分支：`fix/issue-485-board-lost-status`
>
> 类别：前端 / 看板渲染（数据丢失类缺陷）

## 背景 / 动机

「按项目」视图下，列头数字之和**小于**任务总数 —— 有任务同时不在任何列、也不在「未标注」列，属于**静默丢数据**（用户根本看不到这些 issue）。

实测本机激活账号（id=5）：

| 口径 | 数值 |
|---|---|
| 库内该账号任务 | **567** |
| 按项目视图实际渲染进列 | **558** |
| 差 | **9 条**：`project_status = "Planned"` 且未关闭 |

`Planned` 出现在任务的 `project_status` 里，但**不在 `project_statuses` 表任何项目下**（该项目当前选项是 `Planing`，疑为历史拼写遗留 ⇒ 选项改名后任务行未刷新）。

## 设计 / 方案

根因是两处叠加，本次只改第二处（理由见「取舍」）：

1. `app/src/App.tsx:242-256`（单账号视图）：列集合取自**状态数最多的那一个项目**；
2. `app/src/components/Board.tsx::projectKeys`：列键**只**来自该集合（+ 合成列 `done` / `unclassified`），而 `groupByProjectStatus` 按 `task.projectStatus` **原文**分组 ⇒ 表外状态值落入永不渲染的分组。

### 修法（Board 兜底成列）

`projectKeys` 在表内列之后追加「**有任务、但表里没有**」的 key：

- 按名称 `localeCompare` 排序 ⇒ 渲染稳定，不随任务传入顺序跳动；
- 只收 `length > 0` 的 key ⇒ 无任务的表外值不建列，避免空列噪音（表内列仍按原契约「即使无任务也展示」）；
- `statusIndexMap` 为兜底列分配 `projectStatuses.length + i` 的配色索引，避免所有表外列挤在同一个颜色上。

⚠️ 实现细节（单测守住）：`known` 集合必须在合成列 `done` / `unclassified` push **之后**构建，否则 `done` 会被当成「表外状态」再兜底一次 ⇒ 出现重复的「已完成」列。首版实现踩过，测试第 4 条即为此而写。

### 取舍：为什么不动 App 的「主项目」选取

`App.tsx` 只取状态数最多的项目，是为了**列数可控**（账号 5 有 6 个项目、状态名大量重复：`Done` ×6、`Todo` ×4、`In Progress`/`In progress` 大小写并存）。若改为合并所有项目状态：

- 会新增大量**永远为空**的列（其它项目的 `Backlog` / `Ready` / `Testing`…）；
- 跨项目 `order_index` 不可比，列顺序只能退化成语义较弱的字典序。

Board 兜底已能保证「有任务必有列」，且只增加**确实有任务**的列 ⇒ 改动面最小、无噪音。App 侧「合并去重」留作后续可选优化（若要改，须同时处理空列过滤与跨项目排序）。

## 接口 / 行为变更

- 「按项目」视图：表外状态值现在会渲染成兜底列（排在表内列与 `done` / `unclassified` 之后，按名称排序）。
- 列头数字之和不变量：等于当前视图任务总数（此前可小于）。
- Props / Tauri command / MCP / DB schema：**无变更**。

## 数据 / Schema 变更

无。根因里的「任务 `project_status` 是历史值（`Planned`）而选项表已改名（`Planing`）」属**数据陈旧**，本次不修正数据（下一次同步会按 GitHub 现值刷新）；兜底列保证陈旧期间也不丢任务。

## 测试 / 验收

`app/src/components/board.test.tsx` 新增 describe「Board 表外状态值兜底成列（#485）」共 4 条：

1. `project_status` 不在表里的任务必须成列 —— 断言列头出现 `Planned`、任务卡片真的渲染、**列头之和 == 任务总数（2）**；
2. 表外状态无任务时不建空列；
3. 多个表外状态按名称排序且不随任务顺序变化；
4. 已关闭任务仍归 `done` 列、不因兜底逻辑重复成列（`known` 构建顺序的回归守卫）。

**反向验证**（只用一个变异方向不够，两处都要验）：

| 变异 | 结果 |
|---|---|
| 移除 `keys.push(...extra)`（不兜底） | 2 条失败 ✅ |
| 保留兜底但去掉 `.sort(...)` | 1 条失败（排序/稳定性断言）✅ |

已执行：`vitest` **380 passed**（27 files）/ `tsc --noEmit` / `eslint --max-warnings 0` / `prettier --check` / `build` / `check-doc-links.py` 全绿。

手工验收（修复后）：账号 5 的「按项目」视图应出现 `Planned` 列（9 条），列头合计 = 567。

## 相关链接

- Issue：[#485](https://github.com/ShawnLiuSZ/task-dashboard/issues/485)
- 源码：[`app/src/components/Board.tsx`](../app/src/components/Board.tsx)（`projectKeys` / `groupByProjectStatus`）
- 关联：#159（看板列模式）、#405（列顺序回落）、#438（自定义列按 `projectStatus` 匹配）、#484（顶栏计数口径）
- CHANGELOG：[`docs/CHANGELOG.md`](./CHANGELOG.md)

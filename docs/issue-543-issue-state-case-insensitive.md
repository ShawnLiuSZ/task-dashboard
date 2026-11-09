# 前端 issue_state 判 closed 统一为大小写不敏感（#543）

## 背景 / 动机

AGENTS.md §2.2 明确硬约束：「`issue_state` 判 closed 的**读判定不得写死小写**」。该列历史上由**两套来源**写入两套大小写 —— REST 给 `open`/`closed`（小写），GraphQL（ProjectV2 条目查询）给 `OPEN`/`CLOSED`（大写）。#335 曾因此让「closed → done」分支对 Project 来源的 issue 完全失效，**实测 29 行已关闭 issue 滞留看板**。

后端因此专门保留 `common::is_closed_state`（`trim` + `eq_ignore_ascii_case`），所有后端读判定一律走它；但**前端没有等价物**，#541 的 code review 发现前端存在 5 处裸写 `task.issueState === 'closed'` 的大小写敏感判定：

- `utils/openCount.ts`（顶栏计数口径）
- `components/TaskCard.tsx`（GitHub 已关闭徽章）
- `components/DetailPanel.tsx`（详情状态分组键）
- `components/SessionsPanel.tsx`（#541「清除已关闭会话」过滤）
- `components/Board.tsx`（`groupByProjectStatus`）

**现状不出错的原因（潜在脆弱点，非现行 bug）**：所有生产写路径都经 `common::normalize_issue_state` 归一化小写（`sync.rs:1054`、`on_demand.rs:312`），`SCHEMA_VERSION >= 4` 迁移（`db.rs:541`）又洗掉存量大写值 ⇒ 真实库里恒为小写。**但它依赖「写路径恰好归一化 + 迁移洗数据」这层隐式保障**，一旦未来某写路径漏归一化（正是 #335 类回归），前端会**静默误判**（计数多计 / 徽章不显示 / 按钮置灰漏清），无报错、无崩溃，人工很难发现。

## 设计 / 方案

抽一个前端共享纯函数，与后端 `common::is_closed_state` **同口径**：

```ts
// app/src/utils/issueState.ts
export function isClosedIssueState(state: string): boolean {
  return state.trim().toLowerCase() === 'closed';
}
```

- **同口径**：`trim` + 大小写不敏感（`eq_ignore_ascii_case` 的 TS 等价）。对真实库里恒为小写的 `'closed'` 行为与旧的 `=== 'closed'` **严格等价**，替换是纯防御、无语义变化。
- **防御边界**：`'CLOSED'` / `' Closed '` 也命中 —— 这正是裸 `=== 'closed'` 会漏掉的大写 / 空白场景。
- **为何放 `utils/` 而非组件内**：与 `taskIdentity` / `matchRules` / `countOpenIssues` 同一处理方式 —— 它是产品语义（「issue 已关闭」），必须有独立单测守着，内联进 JSX 只能靠端到端测试，而组件层没有测试基建（§2.5 不引入 jsdom）。

替换点（5 处，全部改为 `isClosedIssueState(...)`，并补 import）：

| 文件 | 位置 | 语义 |
|---|---|---|
| `utils/openCount.ts` | `countOpenIssues` | 顶栏「未完成 N 条」排除 GitHub 已关闭 |
| `components/TaskCard.tsx` | GitHub 状态徽章 | 仅已关闭显示徽章 |
| `components/DetailPanel.tsx` | `currentProjectStatus` | 已关闭 → `done` 分组键 |
| `components/SessionsPanel.tsx` | `closedSessions` | #541 一键清除已关闭会话过滤 |
| `components/Board.tsx` | `groupByProjectStatus` | 已关闭 → `done` 列分组 |

## 接口 / 行为变更

- 新增 `utils/issueState.ts` 导出 `isClosedIssueState(state: string): boolean`。
- 无 Tauri command / API / UI 结构变更。5 处替换点**行为等价**（真实库恒为小写），仅对历史残留的大写 / 空白值额外正确。
- 无 i18n 词条变更（459 key 不变）。

## 数据 / Schema 变更

无（未触及 SQLite schema / 后端）。

## 测试 / 验收

- 新增 `utils/issueState.test.ts`（5 例）：小写 `closed` / 大写 `CLOSED` / `' Closed '` / `'ClOsEd'` → `true`；`open` / `OPEN` / `draft` / `''` / `' '` → `false`（覆盖大小写与空白边界，即裸 `=== 'closed'` 会漏掉的场景）。
- 更新 `sessions-panel.test.ts` 的 `#541` 静态断言：过滤判据正则从 `s.issueState === 'closed'` 改为 `isClosedIssueState(s.issueState)`。
- `npx vitest run`：**37 文件 / 590 例全部通过**（585 → 590，+5）。
- `npx tsc --noEmit`：exit 0。
- `npm run lint`：exit 0。
- `npm run i18n:check`：459 key 一致。

## 相关链接

- Issue：`#543`
- 分支：`fix/issue-543-issue-state-case-insensitive`
- 审查来源：#541 的 code review 发现（前端 5 处 `=== 'closed'` 大小写敏感）。
- 背景：#335（同列两套大小写导致 29 行滞留看板，后端已修 `is_closed_state`，前端此前未跟上）。
- 涉及文件：`app/src/utils/issueState.ts`（新）、`app/src/utils/issueState.test.ts`（新）、`app/src/utils/openCount.ts`、`app/src/components/{TaskCard,DetailPanel,SessionsPanel,Board}.tsx`、`app/src/sessions-panel.test.ts`。

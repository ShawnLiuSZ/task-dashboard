# 会话面板一键清除扩展到看板 done（#612）

> #541 的「清除已关闭会话」只覆盖 `issueState === 'closed'`。用户反馈：已拖到看板 **done（已完成）** 列、但 issue 尚未关闭的任务，会话也应一并清除。本期按用户确认**扩展现有按钮**（不新增按钮），一次清除两类。零后端 / 零 DB / 零 API 变更。

## 背景 / 动机

`issueState`（GitHub issue 是否关闭）与 `status`（本地看板四态）是**两个正交维度**：

| issueState | status | #541 行为 | #612 期望 |
|---|---|---|---|
| open | done | 保留（漏掉） | **清除** |
| closed | todo/doing/processed | 清除 | 清除 |
| closed | done | 清除 | 清除 |
| open | todo/doing/processed | 保留 | 保留 |

典型场景：任务做完了、agent 已收工，但因为未提 PR / 未关 issue，`issueState` 仍是 `open` ⇒ 会话堆积在面板里清不掉。

## 设计 / 方案

### 判定抽纯函数（防变异盲点）

新文件 `app/src/utils/sessionCleanup.ts`：

```ts
export function isClearableSession(issueState: string, status: StatusKey): boolean {
  return isClosedIssueState(issueState) || status === 'done';
}
```

- `issueState` 走 `isClosedIssueState`（#543 口径：trim + 大小写不敏感，覆盖 GraphQL 大写 `CLOSED` 与空白历史值）。
- `status` 是本地四态枚举，**精确匹配 `'done'`**，不做大小写/空白放宽。
- 抽纯函数而非在组件里写 `a || b`：静态源码断言对「漏掉一个分支」无感，纯函数让四种组合进入真实数据流单测。

### 组件改动（`SessionsPanel.tsx`）

- `closedSessions` → `clearableSessions`（`sessions.filter(s => isClearableSession(s.issueState, s.status))`，仍 `useMemo`）。
- `closedCount` → `clearableCount`；`handleClearClosed` → `handleClearClearable`；`confirmClosed` → `confirmClearable`。
- 按钮文案「清除已关闭会话」→「清除已关闭/已完成会话」；确认文案与禁用 tooltip 同步。
- 清除仍走 `api.clearSessions(keys)`，聚合视图下同一 `issueKey` 来自多账号时 `new Set` 去重（同 #438/#391 口径）。**保留任务行**，只清空 session 三列。
- i18n **key 名不变**（`sessions.clearClosed` / `clearClosedConfirm` / `clearClosedDisabled`），只改中英文案 —— 减少迁移面，不改调用侧。

## 接口 / 行为变更

- 按钮点击范围扩大：已关闭 **或** 看板 done 的会话一并清除；两类都不满足的会话保留。
- i18n 三词条文案更新（zh-CN / en-US），key 名与占位符 `{n}` 不变，`i18n:check` 通过。
- 无新 i18n key / 无后端 / 无 Rust / 无 SQLite schema 变更。

## 数据 / Schema 变更

无（复用 `clear_sessions` 清空 `session_id` / `session_agent` / `session_at`，任务行不动）。

## 测试 / 验收

| 文件 | 覆盖 |
|---|---|
| `utils/sessionCleanup.test.ts`（新 11 例） | closed/done 四种组合 + GraphQL 大写 `CLOSED` + 带空白历史值 + `issueState` 空但 done + `status` 精确匹配（`'DONE'` / `' done '` 不命中） |
| `sessions-panel.test.ts`（#541 describe 迁移） | `clearableSessions` 用 `isClearableSession` 且不得退回只判 closed；按钮禁用态 + `setConfirmClearable`；handler 去重 + `clearSessions` 接线；确认弹窗 `clearableCount` 接线 |

**反向变异验证**（4 组全部变红，还原基线全绿）：

1. 纯函数漏掉 `|| status === 'done'` → 纯函数测试红
2. 组件过滤退回 `isClosedIssueState(s.issueState)` → 静态断言红
3. handler 去掉 `new Set` 去重 → 静态断言红（首轮暴露盲点，补断言后再验红）
4. 还原 → 基线绿

验收标准：

- [x] 已关闭 OR 看板 done 的会话都被清除；两维度都不满足的保留
- [x] 聚合视图同一 issueKey 去重
- [x] 确认弹窗与禁用提示反映新语义
- [x] 零后端 / DB / API 变更
- [x] 全套校验绿 + 变异验证

## 相关链接

- Issue：[#612](https://github.com/ShawnLiuSZ/task-dashboard/issues/612)
- 前序：[`issue-541-sessions-clear-closed.md`](./issue-541-sessions-clear-closed.md)（#541 原始功能）· [`issue-543-issue-state-case-insensitive.md`](./issue-543-issue-state-case-insensitive.md)（大小写口径）
- 代码：`app/src/utils/sessionCleanup.ts`（新）· `app/src/components/SessionsPanel.tsx` · `app/src/i18n/locales/{zh-CN,en-US}.json`
- 测试：`app/src/utils/sessionCleanup.test.ts`（新）· `app/src/sessions-panel.test.ts`
- CHANGELOG：`docs/CHANGELOG.md` / `docs/CHANGELOG.en.md`（未发布条目）

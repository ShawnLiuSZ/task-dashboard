# DetailPanel 切换任务时会话状态不重置（#66）

> 关联：[Issue #66](https://github.com/ShawnLiuSZ/task-dashboard/issues/66)、[docs/CHANGELOG.md](./CHANGELOG.md)

## 背景 / 动机

二次 bug 审计发现：`DetailPanel` 的 `sessionInput` / `agent` / `handoff` 等状态通过 `useState(task.sessionId ?? "")` 初始化，但 `useState` 只在**首次挂载**时取值。当用户在面板未关闭的情况下切换选中的任务（`selectedTask` 变化），组件没有卸载，state 不会跟随新任务重置，会残留上一个任务的 session id / handoff。

**后果**：在任务 B 的面板里继续编辑时，输入框仍显示任务 A 的 session/handoff，点击「记录」等操作会把 A 的会话写入 B 的看板记录，造成任务间状态污染。

## 设计 / 方案

给 `DetailPanel` 加 `key={selectedTask.key}`：

- `key`（`repo#number`）在任务间唯一；任务切换时 React 会卸载旧实例、挂载新实例。
- 挂载时 `useState(task.sessionId ?? "")` 重新取值，session / agent / handoff 全部随新任务初始化，`busy` / `err` / `copiedKey` 一并重置。
- 切回同一任务时 `key` 相同，不会触发重挂载，不会丢失用户尚未保存的编辑。

这是对这类「组件状态来自 prop 但需随 prop 重置」最轻量的通用解法，无需在组件内加 effect 手动同步。

## 接口 / 行为变更

- 无 Tauri command / MCP 工具 / Schema 变更。
- 行为变化：切换任务时 DetailPanel 重新挂载，状态随任务重置。

## 数据 / Schema 变更

无。

## 测试 / 验收

- `npx tsc --noEmit` 通过。
- `npm run i18n:check` 通过（184 key 双语一致）。
- 手工验收点：
  - 打开任务 A，在会话输入框填值 → 不关闭面板直接点任务 B：
    - 会话输入框 / 交接文本应按任务 B 的既有值展示，不残留 A 的内容
    - 点击「记录」不会把 A 的 session 写入 B
  - 切回任务 A，若本地有未保存编辑，不应意外丢失（key 相同不重挂载）。

## 相关链接

- [Issue #66](https://github.com/ShawnLiuSZ/task-dashboard/issues/66)
- [docs/CHANGELOG.md](./CHANGELOG.md) v0.3.31
# #374 修改看板列模式失败时无提示且不回滚，UI 与后端不一致

> 对应 issue：[#374](https://github.com/ShawnLiuSZ/task-dashboard/issues/374)
>
> 分支：`fix/issue-374-boardmode-change-no-error-handling`
>
> 类别：前端 / 错误处理（乐观更新缺回滚）

## 背景 / 动机

复核 `docs/bug-audit-2026-09.md` 遗留条目时发现的第三处「错误被静默吞掉」。与 #370 / #372 同源，但**后果更重**：前两者是「界面静默降级」，本项是「界面显示的状态与后端实际不一致」。

## 设计 / 方案

### 现象

设置面板切换某账号的「看板列展示方式」（项目列 / 自定义列）时若保存失败：

- **无任何错误提示**；
- **`<select>` 仍显示刚选的新值**（看起来保存成功）；
- 刷新面板后**跳回旧值** —— 用户以为没保存，往往重复操作。

### 根因：乐观更新既无出口也不回滚

`app/src/components/SettingsPanel.tsx` 的 `AccountCard`：

```tsx
const handleBoardModeChange = async (mode: BoardMode) => {
  setBoardMode(mode);                    // ① 乐观更新，UI 立即变
  await onBoardModeChange(mode);          // ② 可能 reject —— 无 try/catch
};
// 调用处：onChange={(e) => void handleBoardModeChange(e.target.value as BoardMode)}
```

`onBoardModeChange` 最终是 `await api.setAccountBoardMode(acct.id, mode)`，这是一个会 reject 的 Tauri `invoke`。失败时：UI 停在乐观值、后端未改 ⇒ **两端状态分叉**。

### 为什么组件里找不到错误出口

`AccountCard`（`:605` 起）**自己没有 `err` 状态**。`SettingsPanel` 外层的 `const [err, setErr] = useState(...)`（`:80`）属于**另一个组件**，`AccountCard` 取不到 —— 所以既没有 `reportError` 也没有 `setErr` 可用。

对比同一文件内其他写路径**都有**可见出口：

| 路径 | 错误出口 |
|---|---|
| `saveSettings`（`:165-167`） | `catch → setErr(...)` |
| `startAddCol` / `saveColumns` 等 | `state.msg` 显示成功/失败 |
| **`handleBoardModeChange`** | **无** |

**只有这一条漏了** —— 这正是「只改了一半」在错误处理上的表现：文件里已有成熟范式，只是没被应用到这条路径。

### 修法

```tsx
const handleBoardModeChange = async (mode: BoardMode) => {
  const prev = account.boardMode ?? 'project';
  setBoardMode(mode);              // 乐观更新
  try {
    await onBoardModeChange(mode);
  } catch (e) {
    setBoardMode(prev);            // 失败回滚，使 UI 与后端重新一致
    reportError(String(e));        // 可见提示，不静默吞掉
  }
};
```

## 接口 / 行为变更

- **UI 行为修复**：切换看板列模式失败时，`<select>` 回滚到原值并显示错误提示（此前：留在乐观值 + 无提示）。
- 成功路径行为不变（仍乐观更新）。
- **无 schema / MCP 工具签名 / i18n key 变更**。

## 数据 / Schema 变更

无。

## 测试 / 验收

`app/src/panel-wiring.test.ts` 新增 `describe('写路径的乐观更新必须可回滚且有错误出口（#374）')`，2 例：

1. **`handleBoardModeChange` 必须同时具备 `try/catch` + `reportError` + 回滚** —— 逐项断言 `try {` / `catch (e)` / `reportError\(/` / `setBoardMode\(prev\)/`，并确认成功路径仍是 `setBoardMode(mode)`。缺任何一项都失败。
2. **错误出口至少存在其一** —— 断言函数体内含 `reportError(` 或 `setErr(`。这条留了余地：若将来给 `AccountCard` 加自己的 `err` 状态，改用 `setErr` 也应被接受。

**反向验证（两个状态各自失败）**：

| 注入 | 结果 |
|---|---|
| 完全去掉 `try/catch`（还原缺陷形态） | FAILED ✓ |
| **半修**：保留 `try/catch` 但删掉 `reportError` 与回滚 | FAILED（`expected … to match /reportError\(/`）✓ |

第二行是我特意加的 —— 「加了 try/catch 就以为修好了」是最常见的半修状态，断言必须能识别它。

恢复后 `npm test` 227 passed（225 → +2）。

已跑：`npm test`、`npx tsc --noEmit`、`npm run lint`（`--max-warnings 0`）、`prettier --check`。

## 相关链接

- Issue：[#374](https://github.com/ShawnLiuSZ/task-dashboard/issues/374)
- 源文件：[`app/src/components/SettingsPanel.tsx`](../app/src/components/SettingsPanel.tsx)
- 同源问题：[#370](./issue-370-sessions-panel-open-browser.md)（外链打开失败静默）、[#372](./issue-372-aggregate-load-silent-failure.md)（聚合加载失败静默降级）
- 历史审计：[`docs/bug-audit-2026-09.md`](./bug-audit-2026-09.md)
- CHANGELOG：[`docs/CHANGELOG.md`](./CHANGELOG.md)
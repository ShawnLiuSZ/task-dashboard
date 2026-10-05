# #372 聚合视图加载失败仅 `console.warn`：看板列静默错序 / 静默退回 project 模式

> 对应 issue：[#372](https://github.com/ShawnLiuSZ/task-dashboard/issues/372)
>
> 分支：`fix/issue-371-project-statuses-silent-failure`
>
> 类别：前端 / 错误处理（错误被吞导致 UI 静默降级）

## 背景 / 动机

按 `docs/bug-audit-2026-09.md` 逐条复核历史审计清单时发现的**仍成立**缺陷。该审计的 P2-#7 只提到「项目状态选项加载失败只 `console.warn`」，实际核查发现**有两处**、且其中一处后果比审计描述的更严重。

## 设计 / 方案

### 缺陷一：`projectStatuses` 失败 ⇒ 看板列静默改用字母序

`App.tsx`「全部账号视图」的聚合加载：

```ts
api.listProjectStatuses(a.id).catch((e) => {
  console.warn(`加载账号 @${a.login} 的项目状态失败:`, e);   // ← 只落 console
  return [] as ProjectStatus[];
});
```

失败被吞成空数组 ⇒ `Board.tsx::sortProjectStatusKeys` 走降级分支：

```ts
if (!projectStatuses || projectStatuses.length === 0) {
  return [...keys].sort((a, b) => a.localeCompare(b));   // ← 字母序
}
```

用户配好的列顺序被**静默替换**，无错误横幅、无提示。

### 缺陷二：`accountColumns` 失败 ⇒ 看板静默从 custom 退回 project（更严重）

审计**漏掉了这一处**（同文件 `:266`，与缺陷一完全同形）。后果更重：

```ts
// Board.tsx:91
return accountColumns && accountColumns.length > 0 ? 'custom' : 'project';
```

`accountColumns` 为空 ⇒ 看板**从「自定义列」整体切成「项目列」**。用户看到的是列全变了却不知原因 —— 这已经不是"顺序错乱"，而是"模式被换掉"。

### 为什么这次连 `console` 都不是合理出口

仓库自己在 `App.tsx` 早就写下过这条经验：

```ts
// v0.3.28+：监听全局错误上报（如 openExternal 失败），统一在错误 banner 显示，
// 避免无 UI 上下文的异步失败只落在 console 里造成「点了没反应」。
```

`openExternal`（#370）用的正是 `reportError` 上抛。这里是**同源同解**，不必新造机制。

单账号视图（`listProjectStatuses(activeId)` / `listAccountColumns(activeId)`）本就带 `try/catch` 且调用了 `setError(...)`，可见性没问题 —— **只有聚合视图的两处被漏掉**。

## 接口 / 行为变更

- **UI 行为修复**：聚合视图下列表加载失败会出现错误提示，用户可知「有账号的状态/列配置加载失败」。
- **保留原有隔离语义**：`#145` 的「单账号失败不断整板」不变 —— 仍返回空数组继续聚合其他账号，只是不再静默。
- **无 schema / MCP 工具签名 / i18n key 变更**。

## 数据 / Schema 变更

无。

## 测试 / 验收

`app/src/panel-wiring.test.ts` 新增 `describe('聚合视图加载失败必须可见（#372）')`，2 例：

1. **聚合分支不得以 `console.warn` 为唯一错误出口** —— 用 `matchAll` 断言**恰好匹配到 2 个** `if (s.viewMode === 'all')` 块（`projectStatuses` 与 `accountColumns` 分属两个不同函数，只取第一个会漏），逐块断言不含 `console.warn`；再对两个函数各自定位 `fn(a.id)` → `.catch(` → 断言其后 800 字符内有 `reportError(`。
2. **单账号路径已走 `setError`，不得回退** —— 防将来把可见路径也改回 console-only。

**反向验证（两处各自独立）**：

| 注入 | 结果 |
|---|---|
| `listProjectStatuses` 改回 `console.warn` | FAILED（`聚合分支不得用 console.warn 作为唯一错误出口`）✓ |
| `listAccountColumns` 改回 `console.warn` | FAILED（`listAccountColumns` 匹配到并报错）✓ |

恢复后 `npm test` 225 passed（223 → +2）。

> 写这条断言时我先后踩了两次自己的坑：① 用 `[\s\S]*?` 从 `listProjectStatuses` 一路匹配到 `listAccountColumns`，跨到了错误的 catch；② 改用固定长度 `{0,600}` + 假定缩进，而那个 catch 里塞了 4 行注释导致长度超限。最终改为「定位调用 → 定位紧随的 `.catch(` → 限定其后窗口」，不再依赖跨块匹配与缩进假设。**静态断言越复杂越脆，能定位就不要用长距离通配。**

已跑：`npm test`、`npx tsc --noEmit`、`npm run lint`、`prettier --check`、`i18n:check`、`check-doc-links.py`。

## 附：本次对 `bug-audit-2026-09.md` 的复核结论

顺手把该审计的 P0/P2 条目对照当前代码过了一遍：

| 审计条目 | 现状 |
|---|---|
| P0-#5 `tasks` 表 `branch`/`handoff` 未写入 `SCHEMA` | ✅ **已修**（两列现均在 `SCHEMA` 的 `CREATE TABLE tasks` 内）—— 审计文档已过期 |
| P0-#6 `setBoardMode` 与 `loadSettings` 并发竞争 | ✅ 已不成立（那段代码已重构为 `await api.setAccountBoardMode(...)`，`App.tsx` 侧不再有竞争） |
| P0-#7 项目状态加载失败仅 `console.warn` | ❌ **仍成立**（本 issue，且范围比审计所述更大） |
| P0-#11 裸 `api.openInBrowser` 无 `.catch` | ❌ 当时成立 → [#370](https://github.com/ShawnLiuSZ/task-dashboard/pull/371) 已修 |
| P0-#13 测试覆盖不足 | ✅ 大幅改善（当前前端 20 文件 225 例、Rust 186 例、Python 170 例） |

> 该审计文档基于 2026-09 的旧代码，部分条目已过期。本次未改动它（属历史记录，`AGENTS.md §5.5` 口径），仅在此记录复核结论。

## 相关链接

- Issue：[#372](https://github.com/ShawnLiuSZ/task-dashboard/issues/372)
- 源文件：[`app/src/App.tsx`](../app/src/App.tsx)、[`app/src/components/Board.tsx`](../app/src/components/Board.tsx)
- 历史审计：[`docs/bug-audit-2026-09.md`](./bug-audit-2026-09.md) 的 P2-#7
- 同类问题（错误只落 console）：[#370](./issue-370-sessions-panel-open-browser.md)
- CHANGELOG：[`docs/CHANGELOG.md`](./CHANGELOG.md)
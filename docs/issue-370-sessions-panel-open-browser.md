# #370 SessionsPanel 是唯一仍用裸 `api.openInBrowser` 的地方：rejection 被静默吞掉

> 对应 issue：[#370](https://github.com/ShawnLiuSZ/task-dashboard/issues/370)
>
> 分支：`fix/issue-368-sessions-panel-open-browser`
>
> 类别：前端 / 错误处理（`只改了一半` 模式的第四次实例）

## 背景 / 动机

在「任务会话」面板点击任务链接打开 GitHub 时，若打开失败，**界面毫无反应、也不显示任何错误**。其余 5 个组件都正确显示错误横幅。

## 设计 / 方案

### 根因：`void` 不吞 rejection，而封装被绕过

`app/src/api.ts` 早有收口后的正确封装：

```ts
export function openExternal(url: string): void {
  api.openInBrowser(url).catch(reportError);   // rejection 上抛到全局错误提示
}
```

但 `SessionsPanel` 是**全仓唯一**绕过它的地方：

```tsx
// SessionsPanel.tsx（修复前）
const handleOpenTask = useCallback((task: Task) => {
  void api.openInBrowser(task.url);           // 无 .catch
}, []);
```

`void` 只丢弃 Promise 本身，**不会**为 rejection 提供处理器 ⇒ `invoke` 被 reject 时成为未处理拒绝，UI 毫无反馈。

全仓核对（`rg -c "api\.openInBrowser"`）：

| 文件 | 形态 |
|---|---|
| `TaskCard` / `DetailPanel` / `AboutPanel` / `AccountsPanel` / `App` | ✅ 走 `openExternal` |
| **`SessionsPanel`** | ❌ 裸 `void api.openInBrowser` |

### 可达性（非理论）

`open_in_browser`（`commands.rs`）有多条**现实**失败路径，每条都返回 `Err`：

1. **`validate_browser_url` 拒绝**（`common.rs`）—— 仅允许 `https://github.com` 与 `*.ghe.com`。历史数据里混入任何其他 host（企业迁移前的旧链接、手工同步进来的第三方工单系统）都会走到这里。
2. **`spawn()` 失败** —— macOS 的 `open` / Windows 的 `cmd /C start` / Linux 的 `xdg-open`：无默认浏览器、进程数上限、沙箱限制等。

用户点击 → 命令 reject → 无处理器 → **界面静默**。

### 又一次「只改了一半」

`docs/bug-audit-2026-09.md` 的 **P0-#11** 早已记录该模式（「多处 `void api.openInBrowser(...)` 无 `.catch`，命令失败被静默吞掉」），并建议「封装统一 `openExternal` 内部 catch + 错误提示，替换各处裸调用」。

#329 完成了封装并替换了 5 处，**唯独漏了 `SessionsPanel`**。这是同源模式的第四次出现：

| 批次 | 现象 |
|---|---|
| #339 | `TaskCard` 未跟进 `taskIdentity`（消费端全改、生产端漏改） |
| #345 | MCP 分帧健壮性只做 Rust 侧、Python 兜底未同步 |
| #357 | `get_req` 加了类型校验、`get_opt` 仍静默丢弃 |
| **#370** | **`openExternal` 封装完成、6 处调用替换漏了 1 处** |

### 修法

一行（改调用点 + 补 import）：

```tsx
import { api, openExternal } from '../api';
// ...
openExternal(task.url);
```

`api` 仍被该文件其他 3 处使用，故 import 不产生 unused。

## 接口 / 行为变更

- **UI 行为修复**：打开失败时经 `reportError` 显示错误提示，不再静默。
- **无 schema / MCP 工具签名 / i18n key 变更**；`handleOpenTask` 签名不变。

## 数据 / Schema 变更

无。

## 测试 / 验收

`app/src/panel-wiring.test.ts` 新增 `describe('外链打开统一走 openExternal（#370）')`，2 例：

1. **六个组件都不再裸调 `api.openInBrowser`** —— 逐一断言 `App` / `TaskCard` / `DetailPanel` / `AboutPanel` / `AccountsPanel` / `SessionsPanel` 均不匹配 `api\.openInBrowser\s*\(`。这把「封装 + 全部替换」变成一条可机械校验的不变量，防再次漏网。
2. **`openExternal` 自身必须带 `.catch`** —— 断言其函数体含 `api.openInBrowser(url).catch(reportError)`。**必要性**：若封装自身丢了 `.catch`，第 1 条断言仍会全绿（因为大家确实都在调 `openExternal`），收口形同虚设而无人察觉 —— 这是 #369 那条失效守卫的教训的直接应用。

**反向验证（两个方向各自独立）**：

| 注入 | 结果 |
|---|---|
| `SessionsPanel` 改回 `void api.openInBrowser(...)` | 第 1 条 FAILED（`SessionsPanel 不得裸调 api.openInBrowser`）✓ |
| `openExternal` 去掉 `.catch(reportError)` | 第 2 条 FAILED ✓ |

恢复后 `npm test` 223 passed（221 → +2）。

已跑：`npm test`、`npx tsc --noEmit`、`npm run lint`、`prettier --check`、`check-doc-links.py`。

## 相关链接

- Issue：[#370](https://github.com/ShawnLiuSZ/task-dashboard/issues/370)
- 源文件：[`app/src/components/SessionsPanel.tsx`](../app/src/components/SessionsPanel.tsx)、[`app/src/api.ts`](../app/src/api.ts)
- 历史审计：[`docs/bug-audit-2026-09.md`](./bug-audit-2026-09.md) 的 P0-#11
- 补上最后一块的 #329 批次：[`docs/issue-329-p2-quality.md`](./issue-329-p2-quality.md)
- 同源模式：[#369 的失效守卫](./issue-367-static-guard-self-diagnosis.md)（收口自身失效而无人察觉）
- CHANGELOG：[`docs/CHANGELOG.md`](./CHANGELOG.md)
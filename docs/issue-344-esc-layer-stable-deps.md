# #344 Esc 层注册放在不稳定 deps，父重渲染会颠倒层级

> 对应 issue：[#344](https://github.com/ShawnLiuSZ/task-dashboard/issues/344)
>
> 分支：`fix/issue-344-esc-layer-stable-deps`
>
> 类别：前端 / Esc 分层（#329 的防叠加机制自身存在缺陷）

## 背景 / 动机

一次跨模块深度 code review 发现：在「同步日志」面板里点「清空全部」弹出确认框后，若此时 App 发生一次重渲染，按下 Esc **不会取消对话框，而是直接把整个同步日志面板关掉** —— 用户的确认操作被跳过，误触发了面板关闭。

这是本批唯一一项「**正确机制因实现细节而失效**」的缺陷：#329 引入的 Esc 分层栈本身是对的，但 `SyncLogsPanel` 与 `ConfirmDialog` 的注册方式让层级可以被外力打乱。

## 设计 / 方案

### 根因：层注册放进了不稳定的 `useEffect` 依赖

`utils/escLayer.ts` 用模块级栈实现「Esc 只由最上层消费」。设计上**子层必须晚于父层注册、早于父层释放**，否则层级即被破坏。

但两个组件把**层注册**放进了带不稳定依赖的 effect：

```tsx
// SyncLogsPanel.tsx
useEffect(() => {
  const layer = registerEscLayer();
  ...
  return () => { ...; layer.release(); ... };
}, [onClose]);      // onClose = () => setNav('board') → 每次 App 渲染都是新函数

// ConfirmDialog.tsx
}, [onCancel]);     // onCancel = () => setConfirming(false) → 每次渲染都是新函数
```

对话框打开期间发生父重渲染时，**两个 effect 在同一次 commit 里一起重跑**。React 的 passive effect 顺序是「destroy 自底向上 → create 自底向上（子先于父）」：

```text
1. destroy：对话框 release() → 面板 release() → 栈空
2. create ：对话框注册      → [对话框]
3. create ：面板注册        → [对话框, 面板]   ← 面板压过了自己的子层
```

`isTop()` 于是对对话框变成 **false**、对面板变成 **true** —— 面板反过来压过自己的子层，**正是 #329 要防的层级颠倒**。

### 触发路径（均已在代码树中）

- `onSynced` → `loadSettings()` → `setSettings(新对象)`（`App.tsx:296-299`；`settings.scheduleMinutes` 默认 15/30 分钟自动同步）
- 手动同步后 4 秒横幅自动清除计时器（`App.tsx:104-111`）
- 20 秒轮询 + `focus` 处理器（`App.tsx:334-347`），任务签名变化时

其余四个面板免疫，因为它们的 `useEscLayer` 用的是 `[]` 依赖。

### 修法：把「层注册」与「业务回调」解耦

新增 `useWindowEscLayer(onEsc)`（`utils/useEscLayer.ts`）：

- **层注册**放在 `[]` 依赖的 effect 里，整个生命周期只注册一次；
- **业务回调**放进 ref，回调引用变化时 ref 自动更新，**不影响监听器与层级**；
- `window.addEventListener` 仍只挂一次，不产生重复监听。

`SyncLogsPanel` 与 `ConfirmDialog` 改用它，与其余面板的 `useEscLayer` 口径统一。

### 权衡：为什么不做「每次重渲染都重排」的自愈式修正

另一种思路是每次重渲染主动重新注册以「刷新」层级 —— 但那正是缺陷本身（层级会因重排而改变）。层级应当只反映**挂载关系**，与重渲染次数无关。故选择让注册不可重入。

同时在 `escLayer.ts` 的 `registerEscLayer` 文档里显式写明「每个实例整个生命周期只应调用一次」及原因，让后续维护者不必重新推导 React effect 时序。

## 接口 / 行为变更

- **新增 hook** `useWindowEscLayer(onEsc: () => void): void`（`app/src/utils/useEscLayer.ts`）。
- `SyncLogsPanel` / `ConfirmDialog` 的 Esc 处理改走该 hook；两者的 Props 接口与对外行为不变。
- **UI 行为修复**：确认框打开期间按 Esc 只取消对话框，不再连带关闭父面板。
- **无 schema / MCP 工具签名 / i18n key 变更**。

## 数据 / Schema 变更

无。

## 测试 / 验收

**1. `utils/escLayer.test.ts` 新增 `describe('Esc 层级在父重渲染后不得颠倒（#344）')`（2 例）** —— 直接把不变式钉在栈原语上，不依赖源码正则：

- `模拟 effect 依赖不稳定时的重排：子层会被父层压过（缺陷形态）` —— 显式复现「destroy 子→父，create 子→父」的时序，并断言 `panel2.isTop() === true` / `dialog2.isTop() === false`（**把缺陷形态写成期望值**，作为反面对照）
- `层注册只做一次时，父重渲染后层级原样保持（修复形态）` —— 注册各一次后模拟 3 次重渲染，断言子层始终在栈顶；并模拟 Esc 分派验证 `handledBy === ['dialog']`

**2. `panel-wiring.test.ts` 新增 `#344 层级注册只发生一次`（1 例）** —— 静态接线守卫：

- `ConfirmDialog` / `SyncLogsPanel` 源码中**不得**出现 `registerEscLayer(`（层注册已下沉到 hook）
- 两者**不得**出现 `}, [onClose])` / `}, [onCancel])`（不得把不稳定回调放进 Esc effect 依赖）
- hook 源码须满足：导出 `useWindowEscLayer`、有 `handler.current = onEsc`、且层注册所在 effect 的依赖恒为 `[]`（正则取出该 effect 并要求非空）

**3. 调整 2 条既有断言以跟随抽象**：#329 那两条用源码正则找 `registerEscLayer()` / `isTop()`，逻辑下沉到 hook 后必然失效，故改为断言「用了分层 hook」（`useWindowEscLayer(`）与「走分层（`isEscTop()` / `isTop()` / `useWindowEscLayer(`）」。这是**跟随重构**，不是削弱 —— 真正的不变式由上述新增用例覆盖。

**反向验证**：把 `SyncLogsPanel` 还原成 #329 缺陷形态（`[onClose]` 依赖里自己 `registerEscLayer`）后，新守卫失败：

```
× #344 层级注册只发生一次：不在带不稳定回调依赖的 effect 里注册 Esc 层
AssertionError: SyncLogsPanel 不应自己注册 Esc 层: expected '…' not to match /registerEscLayer\(/
Tests  1 failed | 21 passed (22)
```

恢复后 `npm test` 215 passed（212 → +3）。

已跑：`npm test` 215 passed、`npx tsc --noEmit`、`npm run lint`（`--max-warnings 0`）、`npm run i18n:check`。

## 相关链接

- Issue：[#344](https://github.com/ShawnLiuSZ/task-dashboard/issues/344)
- 前序批次（机制来源）：[`docs/issue-329-p2-quality.md`](./issue-329-p2-quality.md)
- 源文件：[`app/src/utils/useEscLayer.ts`](../app/src/utils/useEscLayer.ts)、[`app/src/utils/escLayer.ts`](../app/src/utils/escLayer.ts)、[`app/src/components/SyncLogsPanel.tsx`](../app/src/components/SyncLogsPanel.tsx)、[`app/src/components/ConfirmDialog.tsx`](../app/src/components/ConfirmDialog.tsx)
- 深度 review 中发现的其余 7 个缺陷：#339 / #340 / #341 / #342 / #343 / #345 / #346
- CHANGELOG：[`docs/CHANGELOG.md`](./CHANGELOG.md)
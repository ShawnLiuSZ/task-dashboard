# #343 `theme.ts` 用新 `matchMedia` 对象解绑导致 no-op，显式选择仍被系统主题覆盖

> 对应 issue：[#343](https://github.com/ShawnLiuSZ/task-dashboard/issues/343)
>
> 分支：`fix/issue-343-theme-mql-identity`
>
> 类别：前端 / 主题系统（#329 修复未生效）

## 背景 / 动机

一次跨模块深度 code review 发现：用户在设置里**明确选了「浅色」**（而非「跟随系统」），随后切换操作系统深浅色，App 主题**仍然跟着系统变** —— #329 的修复**没有生效**。

#329 的 commit 明确声称修好了这一点（「切到显式 light/dark 时解绑，系统主题变化不再覆盖用户选择」），故这是**一次修复未达成目标**，而非新引入的缺陷。

## 设计 / 方案

### 根因：`matchMedia()` 每次返回新对象

CSSOM View 规范对 `Window.matchMedia(query)` 的定义是：

> Return a **new** MediaQueryList object M …

每次调用返回**新对象**，各自持有独立的 EventTarget 监听列表 ⇒ 在**新对象**上 `removeEventListener` 触碰不到挂在**旧对象**上的监听器。

#329 的实现（`app/src/theme.ts`）只记了**函数引用**，解绑时重新取对象：

```ts
// 绑定（:25）
window.matchMedia(DARK_QUERY).addEventListener('change', onSystemThemeChange);

// 解绑（:36，本次修复对象）
window.matchMedia(DARK_QUERY).removeEventListener('change', systemThemeListener);
//                 ^^^^^^^^^^^^^^^^^^^^ 新对象 ⇒ 对旧对象的监听器无效
```

真实引擎实测（Chrome）：

```js
const a = matchMedia(Q), b = matchMedia(Q);
a.addEventListener('change', probe); a.dispatchEvent(new Event('change')); // → 1
b.removeEventListener('change', probe); a.dispatchEvent(…);                   // → 1  跨对象删除：无效
a.removeEventListener('change', probe); a.dispatchEvent(…);                   // → 0  同对象删除：有效
matchMedia(Q) === matchMedia(Q);                                             // → false
```

**后果**：

1. **#329 想修的缺陷仍在**：模块加载时绑在 `mq₁` → 用户选 `light` 后解绑无效 → 切系统主题时 `mq₁` 仍触发 `onSystemThemeChange` → `applyTheme('auto')` ⇒ 显式选择被系统覆盖。
2. **监听器泄漏**：每次 `setMode('auto')` 都在新对象上加一个，N 次切换 ⇒ 每次系统主题变更触发 N 次 `applyTheme('auto')`（幂等，故无额外视觉症状）。

### 为什么 #329 的测试发现不了

`theme.test.ts:19` 的打桩是 `matchMedia: () => media` —— **每次调用返回同一个对象，与平台行为正好相反**。

而 `theme.test.ts:81-90` 那条名为「解绑用同一函数引用（否则 removeEventListener 静默失效）」的用例，**只比较函数身份、从不比较 MediaQueryList 身份** —— 它精确地记录了自己无法观测的失败模式。

此外 `systemThemeListenerBound()` 是模块内标志位，无论 DOM 移除成功与否都置 `null`，因此所有断言在一个完全泄漏的构建上照样通过。

### 修法：持有 MediaQueryList 实例本身

```ts
let systemMql: MediaQueryList | null = null;

function bindSystemThemeListener() {
  unbindSystemThemeListener();
  try {
    systemMql = window.matchMedia(DARK_QUERY);
    systemMql.addEventListener('change', onSystemThemeChange);
  } catch { systemMql = null; }
}

function unbindSystemThemeListener() {
  if (!systemMql) return;
  try { systemMql.removeEventListener('change', onSystemThemeChange); } catch { }
  systemMql = null;
}
```

**权衡**：另一种思路是缓存「按查询串索引的实例表」，但 App 只有单一查询串，模块级单变量已足够，且不必引入 Map。

## 接口 / 行为变更

- `theme.ts` 内部实现变更（`systemThemeListener` → `systemMql`），模块对外 API（`themeManager` / `resolveTheme` / `applyTheme` / `systemThemeListenerBound`）**签名与语义均不变**。
- **UI 行为修复**：显式选择 light/dark 后，系统主题变化不再覆盖用户选择；监听器不再随 `setMode('auto')` 累积。
- **无 schema / MCP 工具签名 / i18n key 变更**。

## 数据 / Schema 变更

无。

## 测试 / 验收

**关键前提：先把打桩改成平台语义。** 旧打桩「永远返回同一对象」本身就是缺陷得以藏身的前提，不改它则任何断言都无意义。

`app/src/theme.test.ts`：

- 重写 `stubEnv()`：`matchMedia` 每次产出**新对象**，监听集合挂在**该实例**的 `Set` 上；`addEventListener` / `removeEventListener` 用 `function` 表达式保留 `this`，故**跨实例移除天然无效**（与浏览器一致）。
- 新增度量 `liveListeners()`：统计**所有实例上仍挂着的监听器总数** —— 这才是浏览器上的真实状态，调用次数口径看不出问题（旧实现在此也「是 1」）。
- 新增 3 例（均以 `#343` 前缀标记）：
  1. `跨实例解绑无效：真正活着的监听器不随 setMode(auto) 增长` — 3 次 `setMode('auto')` 后 `liveListeners()` 必须是 1
  2. `切到 light 后，先前实例上的监听器确实被摘掉` — 断言原实例 `listeners` 已不含该 handler，且 `removeEventListener` 是**在绑定期那个实例**上调用的（`mock.instances` 含之）
  3. `反复切 light/auto 不累积实例上的监听器` — 5 轮后 `liveListeners()` 必须为 0
- 保留全部 4 条 #329 既有用例（含「解绑用同一函数引用」），未削弱。

**反向验证**：把 `theme.ts` 还原为 #329 的缺陷实现后，**新增 3 例全部失败、既有 4 例仍通过**，且失败数值精确对应泄漏模型：

```
× #343 跨实例解绑无效…      expected 3 to be 1     ← 3 次 setMode(auto) ⇒ 3 个活监听器
× #343 切到 light 后…        原实例的监听器必须被摘掉（未摘掉）
× #343 反复切 light/auto…    expected 5 to be 0     ← 5 轮切换 ⇒ 5 个活监听器
Tests  3 failed | 4 passed (7)
```

这同时**实证了旧测试为何无效**：4 条 #329 用例在完全泄漏的实现上全部通过。

恢复修复后 `npm test` 215 passed。

已跑：`npm test` 215 passed、`npx tsc --noEmit`、`npm run lint`（`--max-warnings 0`）、`npm run i18n:check`。

## 相关链接

- Issue：[#343](https://github.com/ShawnLiuSZ/task-dashboard/issues/343)
- 前序批次（缺陷来源批次）：[`docs/issue-329-p2-quality.md`](./issue-329-p2-quality.md)
- 源文件：[`app/src/theme.ts`](../app/src/theme.ts)、[`app/src/theme.test.ts`](../app/src/theme.test.ts)
- 深度 review 中发现的其余 7 个缺陷：#339 / #340 / #341 / #342 / #344 / #345 / #346
- CHANGELOG：[`docs/CHANGELOG.md`](./CHANGELOG.md)
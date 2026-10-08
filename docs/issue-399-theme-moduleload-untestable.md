# #399：theme 模块加载期的绑定/应用逻辑结构上不可测

> 断言强度审计续篇 —— 前端 `theme.ts`。
> 所属版本：v0.3.22（待发版）· 关联 issue [#399](https://github.com/ShawnLiuSZ/task-dashboard/issues/399)
> 方法论见 [`methodology-assertion-strength-audit.md`](./methodology-assertion-strength-audit.md)

## 背景 / 动机

按方法论文档 §5.1 的目标选择优先级，选 `theme.ts` 的理由：

| 优先级 | 特征 | 本项是否满足 |
|---|---|---|
| 1 | 被 3+ 生产模块调用却零测试 | ❌ 有 7 例测试 |
| 1 | 注释里有显式契约，只守了一半 | 待查 |
| 1 | 「自称对齐、实际不一致」的孪生实现 | ❌ 无孪生 |
| 2 | 手写枚举 / 精确计数 / 正则守卫 | 待查 |

真正的选择理由是**缺陷史**：#343 在这里找到过真实 bug（`matchMedia` 每次返回新对象 ⇒ 解绑恒 no-op）。**有缺陷史的模块值得复查。**

## 审计结果：8 个目标，2 个存活

| 变异 | 修复前 | 修复后 |
|---|---|---|
| ① **#343 本体**：解绑时重新 `matchMedia` 取新对象 | 捕获 ✅ | 捕获 ✅ |
| ② `unbind` 不置 null | 注入失败（未测） | — |
| ③ `bind` 不先解绑（监听器累积） | 捕获 ✅ | 捕获 ✅ |
| ④ **#329 本体**：显式模式不解绑 | 捕获 ✅ | 捕获 ✅ |
| ⑤ `resolveTheme` 显式 light 被系统覆盖 | 捕获 ✅ | 捕获 ✅ |
| ⑥ `applyTheme` 不写 `data-theme` | 捕获 ✅ | 捕获 ✅ |
| ⑦ `getMode` 回落值改错 | **存活** | 捕获 ✅ |
| ⑧ **模块加载期不绑定监听** | **存活** | 捕获 ✅ |

## 发现：模块加载期的逻辑**结构上不可测**

`theme.test.ts` 顶层是：

```ts
import { systemThemeListenerBound, themeManager } from './theme';
```

模块体在**第一次 import 时就执行一次** —— 而那一刻 `beforeEach` 的 `stubEnv()` 还没跑，`window` / `localStorage` 都不存在 ⇒ 模块尾部这两段被 `try/catch` **静默吞掉**：

```ts
applyTheme(storedTheme);                                   // 防 FOUC 的核心动作
if (storedTheme === 'auto') bindSystemThemeListener();     // 首屏跟随系统
```

### 后果实测

把 `if (storedTheme === 'auto') { bindSystemThemeListener(); }` **整段删掉**，`theme.test.ts` **全绿**。

即：**「首屏 auto 模式下系统主题变化不再跟随应用」这个用户可见缺陷，当前无任何测试能发现。**

而它正落在 **#329 / #343 这条反复出问题的时间线上** —— 同一个文件、同一个子系统，第三次出问题。

### 为什么「有测试」不等于「测到了」

`theme.test.ts` 有 7 例、29 行断言，覆盖 `setMode` / `bind` / `unbind` / `resolveTheme` 都很好。**但模块加载期那段代码在测试环境里从未执行过** —— 测试量与覆盖范围是两回事。

## 设计 / 方案

用 `vi.resetModules()` + **动态 `import()`**，让打桩**先于**模块体建立。

这是 vitest 内置能力，**不需要新依赖**（§2.5）。

补 4 例：

| 测试 | 锁定 |
|---|---|
| `stored=auto ⇒ 模块加载即绑定监听` | 恰好注册 **1** 个 change 监听（**不多不少**） |
| `stored=light/dark ⇒ 不绑定监听` | **#329 核心不变量**：显式选择必须赢过系统主题 |
| `stored 缺失 / localStorage 抛错 ⇒ 回落 auto` | **回落值本身**就是契约 |
| `模块加载期把 stored 写进 data-theme` | 防 FOUC 的核心动作 |

配套加了 `stubEnvWithStored(stored)` —— 原 `stubEnv` 恒返回 `'auto'`，只适合测 `setMode` 路径。

## 反向验证

| 注入 | 结果 |
|---|---|
| 模块加载期不绑定监听 | **捕获 ✅**（修复前存活） |
| 模块加载期**恒**绑定（显式 light/dark 也绑 ⇒ #329 被改坏） | 捕获 ✅ |
| 模块加载期不 `applyTheme` | 捕获 ✅ |
| `getMode` 回落值改错 | **捕获 ✅**（修复前存活） |
| #343 本体（回归确认） | 捕获 ✅ |

第 2 行是**反向对照**：与第 1 行方向**相反**，两者都被捕获 —— 说明断言没写歪（这是纪律 2 的实践：双向都验，才知道断言方向没反）。

## 方法论定位

属方法论文档**纪律 4「信号覆盖被测对象」**的一个变体：

> 不是过滤条件写错，而是**顶层 import 让目标代码路径在测试环境里根本没执行**。

**检测手段与纪律 1 相同**：删掉整段，看是否全绿。

这补充了纪律 4 的一种形态 —— 之前记录的 #384 是「`vitest run <file>` 的过滤条件不含用例名」，本项是「**模块根本没在测试环境里跑**」。两者的共同点是：**信号（测试通过）覆盖了对象，但没有覆盖对象在该环境下的实际行为。**

## 接口 / 行为变更

无。纯测试补充。

## 数据 / Schema 变更

无。

## 测试 / 验收

- [x] `theme.test.ts` 7 → **11**（全量前端 231 → **235**）
- [x] 2 个存活变异全部捕获
- [x] #343 / #329 本体回归仍被捕获
- [x] 反向对照（恒绑定）亦被捕获
- [x] `tsc --noEmit` 干净
- [x] `prettier --check` 干净
- [x] `eslint --max-warnings 0` 干净

## 遗留局限（如实记录）

| 项 | 说明 |
|---|---|
| ② `unbind` 不置 null | 本轮注入失败（模式不匹配），**未测**。其效果是「重复 setMode('auto') 时多注册一次」，行为差异较小 |
| `matchMedia` 的 `matches` 恒 `false` | 打桩里 `matches: false` 固定，故 `resolveTheme` 的 dark 分支只在 `themeManager` 路径外被间接覆盖。若要覆盖「系统当前为 dark」，需让打桩可配 `matches` |
| ② 与上项都属**低价值** | 按方法论文档 §7「发现缺口先问这条保护有多重要」，未为它们开 PR |

## 相关链接

- issue [#399](https://github.com/ShawnLiuSZ/task-dashboard/issues/399)
- PR #400
- 方法论：[`methodology-assertion-strength-audit.md`](./methodology-assertion-strength-audit.md)
- 同文件历史缺陷：#343（`matchMedia` 对象身份）、#329（显式选择被系统覆盖）
- 源文件：`app/src/theme.ts`、`app/src/theme.test.ts`
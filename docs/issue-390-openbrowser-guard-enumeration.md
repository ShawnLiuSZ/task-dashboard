# #390：openExternal 守卫只覆盖手写 6 项枚举

> 断言强度审计（mutation testing）第四轮 —— 前端组件测试。
> 所属版本：v0.3.22（待发版）· 关联 issue [#390](https://github.com/ShawnLiuSZ/task-dashboard/issues/390)

## 背景 / 动机

审前端组件测试。先确立一个**结构性事实**，它决定了本项的严重性：

| 事实 | 影响 |
|---|---|
| 3 个组件测试文件（`board` / `settings-groups` / `confirm-dialog`）**全部**用 `renderToStaticMarkup`（19 处） | 服务端渲染**完全丢弃事件处理器** ⇒ 任何组件测试都**不可能**抓到事件绑定缺陷 |
| 全仓**零交互模拟**（无 `fireEvent` / `userEvent` / `dispatchEvent` / `.simulate()`） | 同上 |

在 §2.5「不引入新依赖」（jsdom / testing-library）的约束下，静态正则守卫是合理选择。

**但守卫本身必须无盲区** —— 它是唯一防线。

## 实测：守卫的「所有组件」其实是手写 6 项枚举

```ts
const panels: [string, string][] = [
  ['TaskCard', taskCardRaw],
  ['DetailPanel', detailRaw],
  ['AboutPanel', aboutRaw],
  ['AccountsPanel', accountsRaw],
  ['SessionsPanel', sessionsRaw],
  ['App', appRaw],
];
```

该文件已 import 12 个组件的 `?raw`，但**只有 6 个进了这份清单**。清单外 6 个：**AgentPanel、Board、ConfirmDialog、NotesPanel、SettingsPanel、SyncLogsPanel**。

`components/` 下共 **16 个** `.tsx`，守卫只覆盖 6 个。

### 注入验证

| 注入位置 | 在清单？ | `panel-wiring` 结果 |
|---|---|---|
| `AgentPanel` | ❌ | **1 passed（漏网）** |
| `SettingsPanel` | ❌ | **1 passed（漏网）** |
| `SessionsPanel`（对照） | ✅ | 1 failed（抓到） |

## 这是「只改了一半」模式的第 5 次实例

#370 修的正是 `SessionsPanel` 裸调 `api.openInBrowser`（打开失败界面静默无提示），**并加了这条守卫**。

但守卫只覆盖当时已知的 6 个组件 —— **新增组件引入同类缺陷时完全无声**。

| 次 | 实例 |
|---|---|
| 1 | #339 `TaskCard` 身份不一致 |
| 2 | #345 MCP 分帧 |
| 3 | #357 `get_opt` |
| 4 | #370 `openExternal` |
| **5** | **本项：守卫自身的枚举盲区** |

共同形态：**「修复处有守卫，守卫本身有盲区」**。

第 5 次与前 4 次的区别：前 4 次是「只改了一半的代码」，这次是「**只覆盖了一半的守卫**」—— 递归了一层。

## 设计 / 方案

### 手写枚举 → 自动枚举

与 #376（`taskSig` 字段契约）、#380（状态映射表）同源：**把「手写枚举」换成从目录自动枚举**，让新增组件天然落在范围内，无需记得同步维护清单。

```ts
const allComponents = {
  ...import.meta.glob('./components/*.tsx', { query: '?raw', import: 'default', eager: true }),
  ...import.meta.glob('./App.tsx',        { query: '?raw', import: 'default', eager: true }),
};
```

### 两条防恒真守卫（#367 的教训）

`import.meta.glob` 路径写错时**静默匹配 0 个文件、不报错**（实测 `BAD=0`），守卫会变成恒真断言。故加：

1. `expect(names.length).toBeGreaterThan(10)` —— 匹配数下限
2. **反向契约**：自动枚举范围必须是手写清单的**超集**，且范围严格大于清单

第 2 条让「手写清单与自动枚举脱节」立刻暴露。

## 反向验证

| 注入 | 结果 |
|---|---|
| `AgentPanel` 注入裸调用 | **捕获 ✅** |
| `SettingsPanel` 注入裸调用 | **捕获 ✅** |
| `Board` 注入裸调用 | **捕获 ✅** |
| `NotesPanel` 注入裸调用 | **捕获 ✅** |
| `SyncLogsPanel` 注入裸调用 | **捕获 ✅** |
| `ConfirmDialog` 注入裸调用 | **捕获 ✅** |
| `App.tsx` 注入裸调用 | **捕获 ✅** |
| 破坏 glob 路径（模拟静默匹配 0 文件） | **捕获 ✅**（`expected 1 to be greater than 10`） |

修复前：前 6 个中至少 2 个实测漏网。

## 过程中我自己犯了两次同类错误

### ① 第一版漏了 `./App.tsx` —— 由我自己的反向契约当场抓出

`App.tsx` 在 `src/` 根目录、不在 `components/`，而手写清单里一直有它。第一版只写了 `'./components/*.tsx'`，测试立刻报：

```
手写清单里有自动枚举未覆盖的文件：App.tsx
```

**若无那条反向契约，这个盲区会随修复一起合入 main** —— 与本 issue 修的正是同一类问题。这是「先写反向契约」这笔投入当场回本。

### ② 一次误判「守卫存活」—— vitest 变换缓存

验证路径写错时跑 vitest 得到 `33 passed`，看起来守卫失效。实际是 **vitest 变换缓存**返回了旧结果；加 `sleep` + `--no-file-parallelism` 后两条守卫正常触发。

这是本轮系列**第六次**「测量手段本身出错」：

| # | 错误 | 场合 |
|---|---|---|
| 1 | shell 吞 `${}`，注入失败被当成断言失效 | #367、#382 |
| 2 | 变异方向反了（无限循环 / `@` 后段） | #380、#382 |
| 3 | 期望值手算错误 | #378、#388 |
| 4 | 过滤条件不含被测用例 | #384 |
| 5 | grep 只匹配 `failures=` 漏 `errors=` | #386 |
| **6** | **vitest 变换缓存返回旧结果** | **本项** |

共同点：**先验证测量手段本身，再采信结论**。

## 接口 / 行为变更

无。纯测试变更。

## 数据 / Schema 变更

无。

## 测试 / 验收

- [x] 2 个新用例全绿，前端 229 → **231**
- [x] 6 个原漏网组件全部捕获
- [x] `App.tsx` 捕获
- [x] 两条防恒真守卫在路径写错时均触发
- [x] `tsc --noEmit` 干净
- [x] `prettier --check` 干净
- [x] `eslint --max-warnings 0` 干净

## 遗留的结构性局限（如实记录，未修）

**组件测试无法验证事件绑定** —— 这是 `renderToStaticMarkup` 的固有限制，不是本 issue 能修的（修它需要引入 jsdom / testing-library，违反 §2.5）。

因此以下两类缺陷**当前无法被任何测试发现**，需靠 code review：

1. `onClick` 绑错了函数
2. 事件回调内部逻辑错误

本 issue 只把「静态可查」的那部分（是否绕过 `openExternal`）的覆盖从 6 个组件扩到全部 16 个 + `App.tsx`。

若将来要解除这个限制，应作为独立提案评估依赖成本（§2.5 的例外需 owner 决定）。

## 相关链接

- issue [#390](https://github.com/ShawnLiuSZ/task-dashboard/issues/390)
- PR #391
- 前置：#376 / #380（手写枚举 → 表驱动/自动化的同源方法）、#367（防恒真守卫）
- 同模式：#339 / #345 / #357 / #370（只改了一半）
- 源文件：`app/src/panel-wiring.test.ts`
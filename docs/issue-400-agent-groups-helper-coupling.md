# #400：测试辅助函数耦合字段，使守卫分支不可构造

> 断言强度审计续篇 —— 前端 `agent-groups.ts`。
> 所属版本：v0.3.22（待发版）· 关联 issue [#401](https://github.com/ShawnLiuSZ/task-dashboard/issues/401)
> 方法论见 [`methodology-assertion-strength-audit.md`](./methodology-assertion-strength-audit.md)

## 背景 / 动机

按方法论文档 §5.1 的目标优先级续审 `agent-groups.ts`。它**不满足**任何优先级特征（不是零测试、无孪生实现、无枚举守卫），纯粹是剩余待审文件之一。

**结果证明「剩余文件」里也有货** —— 见下。

## 审计结果：14 个变异，13 个捕获，1 个存活

### 捕获良好的 13 个（这部分测试质量很高）

| # | 变异 | 结果 |
|---|---|---|
| ① | `groupOf` 去掉 `!supported` 早返回 | 捕获 ✅ |
| ② | `groupOf` 把 `suspected-removed` 优先级降到 `installed` 之后 | 捕获 ✅ |
| ③ | `groupOf` `config-only` 时报 `installed` | 捕获 ✅ |
| ④ | `groupOf` `status` 缺失时不报可接入 | 捕获 ✅ |
| ⑤ | `groupOf` `hostPresent` 不算接入证据 | 捕获 ✅ |
| ⑥ | `groupOf` 末行 `config-only` 判定反转 | 捕获 ✅ |
| ⑦ | `deviceStateOf` 去掉 `newlyRemoved` 优先级 | 捕获 ✅ |
| ⑧ | `scan` 为 null 返回 `cli` 而非 `none` | 捕获 ✅ |
| ⑩ | `summarize.installed` 忽略 `present` | 捕获 ✅ |
| ⑪ | `summarize.configOnly` 认错 `kind` | 捕获 ✅ |
| ⑫ | `previousScannedAt` 丢失 | 捕获 ✅ |
| ⑬ | `GROUP_ORDER` 顺序调整 | 捕获 ✅ |
| ⑭ | `deviceDetail` 路径拼接顺序 | 捕获 ✅ |

### 存活的 ⑨ 暴露了一个测试设计缺陷

**变异**：`deviceStateOf` 里 `if (!info || !info.present) return 'none';` → `if (!info) return 'none';`

**存活。**

## 根因：测试辅助函数把两个独立字段强行耦合

```ts
const host = (agent: string, kind: string, extra: Partial<AgentHostInfo> = {}): AgentHostInfo => ({
  agent,
  present: kind !== 'none',   // ← 把 present 由 kind 推导
  kind: kind as AgentHostInfo['kind'],
  ...
});
```

于是 **`present === false` 必然蕴含 `kind === 'none'`** —— 删掉 `!info.present` 后行为完全一致 ⇒ mutation 存活。

### 但生产代码里它们是两个独立字段

`types.ts:315-316`：

```ts
present: boolean;
kind: AgentHostKind;   // 'cli' | 'app' | 'config-only' | 'none'
```

类型系统**不强制**二者一致。「`present === false` 但 `kind` 非 none」是**类型允许的输入**。

而守卫存在的意义正是处理它 —— 类型注释说「`kind` 为**最强信号**」，但守卫代码明确把 `present` 当**权威判据**：

> 扫描端一旦报出这种组合，界面会把一个**并未安装**的 agent 显示成「已安装 cli / app / config-only」。

**契约在代码里，不在类型里；而测试辅助函数替生产代码把这个不变量补上了**，于是守卫失去了被测机会。

## 这是一个新的盲区类型（E 类）

方法论文档原有四类盲区都不覆盖这一项：

| 类 | 描述 |
|---|---|
| A | 枚举覆盖不全 |
| B | 匹配形式单一 |
| C | 解析语法子集太窄 |
| D | 只守正向不守反向 |
| **E** | **测试辅助函数补上了生产代码没有的不变量** |

> **E 类：测试辅助函数让某个分支在测试数据里不可构造。**

与 #399（模块根本没在测试环境跑）同属「代码路径没被走到」，但**根因不同**：

| # | 根因 |
|---|---|
| #399 | **环境**缺打桩 —— 顶层 import 早于 `beforeEach` |
| **#400** | **测试数据的构造方式**把分支排除掉了 |

## 设计 / 方案

补 1 例 `present=false 但 kind 非 none 时必须判 none`：

- **显式构造该组合**（绕开 `host()` 辅助函数，手工构造对象）
- 断言 `deviceStateOf` 返回 `'none'`，消息点明「`present=false` 是权威判据，不得因为 kind 非 none 就报成已安装」
- 加一条**前置不变式**（`host('x','cli').present === true`、`host('x','none').present === false`），防止日后有人「修正」辅助函数时无声破坏本例的构造前提

## 反向验证

| 注入 | 结果 |
|---|---|
| 去掉 `!info.present` 守卫 | **捕获 ✅**（修复前存活） |
| `groupOf` 去掉 `!supported`（回归） | 捕获 ✅ |
| `deviceStateOf` 去掉 `newlyRemoved`（回归） | 捕获 ✅ |
| `deviceDetail` 拼接顺序（回归） | 捕获 ✅ |

## 过程中又一次测量手段出错（管道掩盖退出码）

```sh
npx tsc --noEmit 2>&1 | tail -1 && echo "tsc 干净"
```

**`tail` 的退出码覆盖了 `tsc` 的退出码** —— 我在 tsc 实际报 `TS2739`（缺 `scannedAt` / `hasPrevious`）时**输出了「tsc 干净」**。

改用 `(npx tsc --noEmit >/dev/null 2>&1); echo $?` 后暴露，连带修掉两处类型错误（`scannedAt` 是 `number` 不是 `string`）。

> **这是「判结果只用退出码」纪律的新变体**：不仅「测试是否失败」要看退出码，
> **「检查是否通过」本身也必须看退出码** —— 中间插一个管道或 `tail`，信号就丢了。

## 接口 / 行为变更

无。纯测试补充。

## 数据 / Schema 变更

无。

## 测试 / 验收

- [x] `agent-groups.test.ts` 16 → **17**（全量前端 235 → **236**）
- [x] 存活变异转为捕获
- [x] 13 个原捕获项回归无恙
- [x] `tsc --noEmit` 退出码 0
- [x] `prettier --check` / `eslint --max-warnings 0` 干净

## 遗留局限（如实记录）

`present` 与 `kind` 一致性目前是**运行期约定**，类型系统不保证。若要根治，可给 `AgentHostInfo` 加判别联合（`present: true` 时 `kind` 不为 `'none'`），但那会牵动 Rust 侧的序列化与前端多处构造点，**超出本 issue 范围**，应作独立提案评估。

本 issue 只锁定行为契约，不改类型。

## 相关链接

- issue [#401](https://github.com/ShawnLiuSZ/task-dashboard/issues/401)
- PR #402
- 方法论（已扩为五类盲区）：[`methodology-assertion-strength-audit.md`](./methodology-assertion-strength-audit.md)
- 同属「代码路径没走到」：#399（`theme.ts` 模块加载期）
- 源文件：`app/src/agent-groups.ts`、`app/src/agent-groups.test.ts`、`app/src/types.ts`
# #405：Board 列顺序零覆盖，回落分支 `orderMap` 是死代码

> 断言强度审计续篇 —— 前端 `Board.tsx` 的 `projectKeys`。
> 所属版本：v0.3.22（待发版）· 关联 issue [#405](https://github.com/ShawnLiuSZ/task-dashboard/issues/405)
> 方法论见 [`methodology-assertion-strength-audit.md`](./methodology-assertion-strength-audit.md)

## 背景 / 动机

选 `projectKeys` 的理由：它决定**看板列顺序**，且其回落路径正是 [#372](./issue-372-aggregate-load-silent-failure.md) 记录的「看板列静默错序」点。

## 审计结果：5 个变异全部存活

| 变异 | 结果 |
|---|---|
| 排序方向反转（`orderIndex` 降序） | 存活 |
| 表内列排到末尾 | 存活 |
| **回落字母序改成不排序**（#372 静默错序点） | 存活 |
| `orderMap` 键用 `id` 而非 `name` | 存活 |
| 空表判定反转 | 存活 |

## 两个原因（都必须记录）

### 原因一：测试输入不足

`describe('Board 渲染（#159）')` 只传 **1 个** projectStatus 且 `tasks={[]}`
⇒ 没有任何「两列以上 + 需要重排」的输入。

### 原因二（更根本）：`orderMap` 分支是**死代码**

```ts
// Board.tsx:145 —— 全仓唯一调用点
return sortProjectStatusKeys(
  Array.from(grouped.keys()).filter((k) => (grouped.get(k) ?? []).length > 0),
);   // ← 第二个参数 projectStatuses 从未传入
```

`sortProjectStatusKeys(keys, projectStatuses?)` 的 `orderMap` 分支（54–66 行）
**只在传了 `projectStatuses` 时才可达**。

而主路径（有 `projectStatuses`）压根不经过这个函数：

```ts
if (projectStatuses && projectStatuses.length > 0) {
  const keys = projectStatuses.map((ps) => ps.name);   // 直接取表顺序
  ...
}
```

⇒ **对 `orderIndex` 的 4 个变异天然无效**，那段代码永不执行。

### 「存活」的归类

这是**盲区 E 类的近亲** —— 不是测试辅助函数耦合，而是**被测代码里有一段不可达**。

区别很重要：

| | E 类（#400） | 本项 |
|---|---|---|
| 不可达的原因 | 测试**数据**构造不出 | 生产代码里那段**本来就不执行** |

判别方法相同（删掉看是否全绿），但结论不同：本项的**被测代码本身**有死代码，需要的是「记录 + 产品判断」，不是补断言。

## 一个签名与现实不符的问题（未改代码）

`sortProjectStatusKeys` 的签名承诺「可按 `projectStatuses` 的 `orderIndex` 排序」，
但**唯一调用点从不传该参数** ⇒ 该能力实际不可用。

这是「**签名承诺了、调用点用不上**」的 API 表面。可能是有意（备用路径），
也可能是重构残留 —— **属产品判断，本次不改代码**。两个选项：

- **保留**：建议注释写明「第二参数当前无调用点传值，`orderMap` 分支为备用路径」
- **清理**：删掉第二参数与 `orderMap` 分支即可，**回落行为不变**

## 修复

补 5 例，锁住**真实可达行为**：

| 测试 | 锁定 |
|---|---|
| 回落路径下列按**字母序** | **反向契约**：必须真的渲染出 3 列，否则退化为「什么都没断言」 |
| 回落列序**不依赖 tasks 传入顺序** | 否则刷新一次顺序就跳变 |
| 主路径列序取自**表顺序** | 与回落的字母序**方向相反**，两条路径必须显式区分 |
| `done` / `unclassified` **合成列存在性** | 列头走 i18n（`已完成` / `未标注`），按渲染文案断言 |
| 回落路径**过滤空列** | `groupByProjectStatus` 为所有出现过的 key 建桶，回落须再过滤 `length > 0` |

### 列存在性断言的一个坑

合成列的列头走 **i18n**（zh-CN 下 `done` → `已完成`、`unclassified` → `未标注`），
**不是内部 key**。我第一版按 `/done/i` 匹配失败，被断言消息里的实际列序
`["Alpha","已完成","未标注"]` 点出来才发现。

⇒ 断言组件渲染结果必须按**渲染出来的文案**写，不能想当然用内部标识。

## 过程中：新测试暴露了两个我自己也没覆盖的点

补完 3 例后重验 mutation，发现**两个新的存活变异**：

| 新存活变异 | 原因 |
|---|---|
| 主路径漏 `done` 列 | 我的用例里没有 `issueState: 'closed'` 的任务 |
| 回落分支不过滤空列 | 我没构造「桶存在但为空」的情形 |

⇒ 补了合成列存在性与空列过滤两例。

> **这是「补测试 → 再 mutation → 发现新缺口」的良性循环，两次迭代才收敛。**
> 呼应 #376 的教训：断言写完不等于有效，**仍要用 mutation 验收新测试本身**。

## 反向验证

| 变异 | 结果 |
|---|---|
| 回落不排序 | 捕获 ✅ |
| 回落方向反转 | 捕获 ✅ |
| 回落按长度排（非字母序） | 捕获 ✅ |
| 主路径不取表序（改字母序） | 捕获 ✅ |
| 主路径漏 `done` 列 | 捕获 ✅ |
| 主路径漏 `unclassified` 列 | 捕获 ✅ |
| 回落不过滤空列 | 捕获 ✅ |

## 接口 / 行为变更

无。纯测试补充。

## 测试 / 验收

- [x] `board.test.tsx` 20 → **25**（全量前端 236 → **241**）
- [x] 5 个原存活变异全部捕获
- [x] 迭代中新发现的 2 个存活变异亦捕获
- [x] `tsc --noEmit` / `prettier` / `eslint` 退出码均为 **0**

## 相关链接

- issue [#405](https://github.com/ShawnLiuSZ/task-dashboard/issues/405)
- 方法论：[`methodology-assertion-strength-audit.md`](./methodology-assertion-strength-audit.md)
- 问题背景：#372（聚合加载失败 → 列静默错序）
- 盲区 E 类：#400（测试辅助函数耦合）
- 源文件：`app/src/components/Board.tsx`、`app/src/components/board.test.tsx`

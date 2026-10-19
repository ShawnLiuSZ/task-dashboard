# #452 修复过期请求参数消费 / 复制高亮键串号

> 关联 issue：[#452](https://github.com/ShawnLiuSZ/task-dashboard/issues/452)
> 来源：`CODE-REVIEW-2026-10-19.md`（2026-10-19 全量代码 Bug 审查）低危-3、低危-4
> 基线：`main` @ 含 #450、#451 修复
> 分支：`fix/issue-452-frontend-state`

## 一、背景 / 动机

两项缺陷同源于 **#422 账号维度**与**并发请求合并**这两个本仓反复出现的易错面。

| 编号 | 严重度 | 一句话 |
|---|---|---|
| 低危-3 | 低 | `coalescedLoad` 在 `exec` 抛错后会把**更早一次**的请求参数重放给下一次调用 |
| 低危-4 | 低 | `SessionsPanel` 的「已复制」勾用裸 `issueKey`，聚合视图下跨账号串号 |

## 二、设计 / 方案

### 2.1 低危-3：失败即丢弃积压

`coalescedLoad`（`app/src/utils/coalescedLoad.ts`）用于合并并发列表查询 ——
忙时不丢弃，记下最新参数、当前完成后重跑一次（#221）。

原实现的注释写着「`exec` 抛错会向上传播，但锁一定复位；**残留的 pending 由下次调用消费**」。
后半句就是缺陷本身。时序：

```
t0: loadWith(A) 开始 → exec(A) 挂起
t1: loadWith(B) 到达 → 占锁，记 pending = B
t2: exec(A) 抛错 → 跳出循环，pending = B 残留，loading = false
t3: loadWith(C) 到达 → 不忙 → cur = C，执行 exec(C)
    循环末尾 next = s.pending = B   ← 更早的参数被重放
    于是又执行 exec(B)
```

最终 state 可能被 **B**（更早的筛选）覆盖 —— 表现为「切到 C 账号却显示 B 账号的数据」。

**方案**：新增 `catch` 分支清 `s.pending = null` 后重新抛出。语义即
「本次失败即丢弃积压」：调用方通常会在下一次轮询 / 聚焦时自然重试，
不需要合并器替它重放一个过期参数。`finally` 里的锁复位保持不变。

> 关键点：**只改失败路径**。成功路径必须保持 #221 的「合并后重跑最新」语义 ——
> 已有测试 `并发请求合并：先到的跑完后用最新参数重跑一次` 守着这条不变量，
> 新增用例 `成功路径的合并语义不受影响` 再钉一次。

### 2.2 低危-4：copiedKey 改用 taskIdentity

`SessionsPanel` 有三处复制入口（分支 / 目录 / 会话 id），每处都有一个「已复制」勾，
由 `copiedKey` state驱动。#438 把**选中态与卡片 key**统一为
`taskIdentity`（`issueKey@accountId`），但 `copiedKey` 漏改了 —— 仍用裸 `issueKey`。

聚合视图（`viewMode === 'all'`）下同一 `issueKey` 可来自两个账号，两者共享同一个
`copiedKey` ⇒ 复制其中一条，另一条也错误亮起「已复制」。

**方案**：六处（3 个写入点 + 3 个读取点）全部改用 `taskIdentity(task)`，
并加注释说明与选中态同口径的理由。

#### 写入点与读取点必须**同时**改

只改写入点或只改读取点，都会让勾**永远亮不起来** —— 这是另一种形态的 bug，
且比串号更难被用户察觉（用户只会认为「点击没反应」）。故测试对两者分别断言，
并额外加一条「不得回退到裸 `issueKey`」堵住「改了一半」的中间态。

## 三、接口 / 行为变更

| 对象 | 变更 |
|---|---|
| `coalescedLoad` | `exec` 抛错时清空残留 `pending`（失败即丢弃积压）。成功路径语义不变 |
| `SessionsPanel` | `copiedKey` 的 6 处增删改用 `taskIdentity(task)` |

Tauri command、DB schema、MCP 工具集、i18n、后端 Rust 全部零改动。

## 四、数据 / Schema 变更

无。

## 五、测试 / 验收

| 测试 | 作用 |
|---|---|
| `coalescedLoad.test.ts::抛错后残留的 pending 不得被下一次调用消费` | 新增。完整复现 t0~t3 时序，断言下一次调用只执行 C、不重放 B |
| `coalescedLoad.test.ts::抛错后仍能正常继续加载` | 新增。丢弃积压 ≠ 锁死 |
| `coalescedLoad.test.ts::成功路径的合并语义不受影响` | 新增。守住 #221 的既有不变量 |
| `sessions-panel.test.ts::copiedKey 的写入点与读取点都用 taskIdentity` | 新增。3 个前缀 × 写入/读取双向断言 |
| `sessions-panel.test.ts::copiedKey 不得回退到裸 issueKey` | 新增。堵住「改了一半」的中间态 |
| `sessions-panel.test.ts::与选中态同口径` | 新增。卡片 key / 复选框 / 选中判定 |

### 反向验证：2 处变异，3 个测试失败，2/2 捕获

| 变异 | 捕获 |
|---|---|
| `coalescedLoad` 去掉 `catch` 清理 | `抛错后残留的 pending 不得被下一次调用消费` 失败 |
| `copiedKey` 读取点回退裸 `issueKey` | `写入点与读取点都用 taskIdentity` + `不得回退到裸 issueKey` 两条失败 |

### 已跑校验

```
npx vitest run                ✅（324 passed，原 318）
npx tsc --noEmit              ✅
npm run lint                  ✅（--max-warnings 0）
npx prettier --check          ✅
npm run i18n:check            ✅
```

## 六、相关链接

- Issue：[#452](https://github.com/ShawnLiuSZ/task-dashboard/issues/452)
- 审查报告：`CODE-REVIEW-2026-10-19.md`
- CHANGELOG：[`docs/CHANGELOG.md`](./CHANGELOG.md)
- 相关历史：[#221](https://github.com/ShawnLiuSZ/task-dashboard/issues/221)（`coalescedLoad` 引入）、[#438](https://github.com/ShawnLiuSZ/task-dashboard/issues/438)（选中态改 `taskIdentity`，`copiedKey` 漏改）、[#422](https://github.com/ShawnLiuSZ/task-dashboard/issues/422)（账号维度编码硬规则）
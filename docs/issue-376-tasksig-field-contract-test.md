# #376 `taskSig` 测试只按「字段组」断言：15 个字段中 8 个可被单独删除而无任何测试失败

> 对应 issue：[#376](https://github.com/ShawnLiuSZ/task-dashboard/issues/376)
>
> 分支：`fix/issue-375-tasksig-field-contract-test`
>
> 类别：前端 / 测试断言强度（契约未被守护）

## 背景 / 动机

「断言强度审计」的第一项：对 `app/src/utils/taskSig.ts` 做**逐字段 mutation 测试**（每次删掉一个字段再跑测试，看是否有测试失败）。

结果：**15 个字段中有 8 个被删掉后没有任何测试失败**。

## 设计 / 方案

### 现象

| 字段 | 删掉后 | 性质 |
|---|---|---|
| `accountId` / `status` / `handoff` / `workBranch` / `projectStatus` / `branch` | 测试失败 | —（已被覆盖） |
| **`updatedAt`** | **测试通过** | ✅ **真实 bug** |
| **`workDir`** | **测试通过** | ✅ **真实 bug** |
| `issueKey` / `ownership` / `title` / `sessionId` / `sessionAgent` / `sessionAt` | 测试通过 | 冗余为主，但契约未锁 |

### 根因：按「字段组」断言，而非逐字段

现有用例一次改了三个字段：

```ts
// taskSig.test.ts:51-54（修复前）
expect(
  taskListSignature([{ ...base[0], sessionId: 's1', sessionAgent: 'opencode', sessionAt: 7 }]),
).not.toBe(sig);
```

只要三者中**任意一个**仍在签名里，指纹就会变 ⇒ 断言通过。于是**单独**删掉 `sessionId`（或 `sessionAt`）测不出来。`workDir` / `updatedAt` 则从未被任何用例单独触及。

### 两处确认的真实 bug

`App.tsx::applyTasks` 用签名跳过 `setTasks`：

```ts
const sig = taskListSignature(fresh);
if (sig === tasksSig.current) return;   // ← 指纹不变 ⇒ UI 不刷新
```

**① 漏 `updatedAt`** —— issue 被评论时，同步只更新 `updated_at`（及 comments_count / labels），而 `status` / `ownership` / `title` / `projectStatus` / `branch` / `candidateDone` **全都不变**。漏掉 `updatedAt` ⇒ `applyTasks` 直接 return ⇒ **TaskCard 上的日期不刷新**（`TaskCard.tsx:175` 确实渲染它）。

**② 漏 `workDir`** —— `workDir` 由 agent 经 MCP `record_session` 写入（`commands.rs:332`），且 SessionsPanel 会展示它（`SessionsPanel.tsx:225-228`）。漏掉则 agent 设了工作目录后**界面不更新** —— 这正是 #287 引入该字段要解决的问题。

### 为什么比「看起来是冗余」严重

`taskSig.ts` 的文档注释**逐个点名了必须纳入的字段**：

> #181：本地写入（`set_task_status` / `touch_session` / `clear_task_session` / `record_task_handoff`）都不更新 `updated_at`，所以指纹必须覆盖这些写入会碰的字段：status / session 三件套 / handoff / work_branch……
> #220：同步镜像字段 projectStatus / branch 也可能在 updated_at 不变时变化，一并纳入。

也就是说「必须纳入哪些字段」是一份**显式契约**，但没有任何测试在守它 —— 下一次重构删掉某个字段，不会有人收到任何信号。**这与 #367 / #369 的「静默通过的失效断言」同源，但更隐蔽**：那些是断言写错了，这个是断言写得不够细。

### 修法：把契约变成表驱动测试

```ts
const CONTRACT_FIELDS: [string, Partial<Task>][] = [
  ['issueKey', { issueKey: 'other#9' }],
  ['accountId', { accountId: 99 }],
  // … 共 15 项
];

it('#376：契约字段逐个变化时指纹都必须变化（表驱动）', () => {
  const base = mkTask({ issueKey: 'a#1' });
  const sig = taskListSignature([base]);
  for (const [field, patch] of CONTRACT_FIELDS) {
    expect(
      taskListSignature([{ ...base, ...patch }]),
      `字段 ${field} 变化时指纹必须变化（漏掉它 ⇒ applyTasks 会跳过 setTasks ⇒ UI 不刷新）`,
    ).not.toBe(sig);
  }
});
```

比逐字段写用例更紧凑，且**恰好覆盖「部分删除」这一当前盲区的形态**。

另加一条**反向契约**用例：抽样若干**不应**在签名里的字段（`owner` / `repo` / `assignees` / `author`），断言它们单独变化**不会**改变指纹 —— 防止「契约」与实现漂移（将来有人往签名里加字段却没登记）。

## 接口 / 行为变更

无（**只改测试**，不动 `taskSig.ts` 实现）。这正是本项的意义：两处真实 bug 是「未来重构可能引入」的隐患，而非当前已存在的缺陷。

## 数据 / Schema 变更

无。

## 测试 / 验收

**反向验证：逐个删除 14 个字段，每个都必须让测试失败**（注入均已确认生效 —— 源码中残留 0 处）：

| 字段 | 结果 |
|---|---|
| `issueKey` / `ownership` / `title` / `sessionId` / `sessionAgent` / `sessionAt` / `workDir` / `updatedAt` | **1 failed**（此前全部 0 failed）✓ |
| `accountId` / `status` / `handoff` / `workBranch` / `projectStatus` / `branch` | 2 failed ✓ |

修复前 8 个「存活」，修复后 **14/14 全部被捕获**。

已跑：`npm test` 229 passed（227 → +2）、`npx tsc --noEmit`、`npm run lint`（`--max-warnings 0`）、`prettier --check`。

## 方法论：为什么用 mutation 而不是「读测试猜强度」

「断言看起来够不够」靠读代码判断极易出错 —— 本项的表驱动用例**读起来完全合理**，但逐字段试一遍才发现 8 个字段无人看守。判定标准应是**「注入缺陷后能否失败」**，这也与 #367 审计得出的结论一致。

> 审计时我一度把 mutation 失败误判为「注入没生效」（`notes-layout` 那次正则未匹配 `<aside>`）。本轮因此对每次注入都**附带打印源码残留计数**，确认注入生效后才采信结果。

## 相关链接

- Issue：[#376](https://github.com/ShawnLiuSZ/task-dashboard/issues/376)
- 源文件与测试：[`app/src/utils/taskSig.ts`](../app/src/utils/taskSig.ts)、[`app/src/utils/taskSig.test.ts`](../app/src/utils/taskSig.test.ts)
- 消费方：[`app/src/App.tsx`](../app/src/App.tsx)（`applyTasks` 跳过 `setTasks`）
- 同源问题：[`docs/issue-367-static-guard-self-diagnosis.md`](./issue-367-static-guard-self-diagnosis.md)（静默通过的失效断言）
- 前序修复：[#356](./issue-356-project-issue-updated-at.md)（同一签名体系下的数据缺陷）
- CHANGELOG：[`docs/CHANGELOG.md`](./CHANGELOG.md)
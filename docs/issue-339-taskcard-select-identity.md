# #339 点击任务卡片无响应：TaskCard 未跟进 #329 的 `taskIdentity`

> 对应 issue：[#339](https://github.com/ShawnLiuSZ/task-dashboard/issues/339)
>
> 分支：`fix/issue-339-taskcard-select-identity`
>
> 类别：前端 / 功能性缺陷（P0）

## 背景 / 动机

一次跨模块深度 code review（覆盖 `v0.6.5 → HEAD`）发现：**点击任意任务卡片完全无响应** —— 详情面板打不开、卡片无高亮选中态，四个看板视图 100% 复现。卡片上唯一还能用的交互是「未认领卡片」的认领按钮。

缺陷本身不是新引入的逻辑错误，而是**一次正确重构漏改了生产端**。

## 设计 / 方案

### 根因：前端任务身份的生产端与消费端口径不一致

#329 引入 `app/src/utils/taskIdentity.ts`，把前端任务身份从 `issueKey` 升级为复合身份：

```
taskIdentity(task) === `${task.issueKey}@${task.accountId}`
```

动机见 `taskIdentity.ts` 头注释：后端唯一键是 `UNIQUE(repo, number, account_id)`，在「全部账号聚合视图」下同一个 issue 被两个账号关联时会返回两条 `issueKey` 完全相同的记录。直接拿 `issueKey` 做 React key 会触发重复 key（React 复用错误 DOM、卡片错位），做选中态判定则会「点 A 打开 B」。

#329 把**消费端**全部改成了 `taskIdentity`，但 **生产端 `TaskCard.tsx` 根本没进那次 diff**：

```
$ git diff f66f83f 81998f0 --stat -- app/src/components/TaskCard.tsx
(空)
```

于是链路两端口径错配：

```tsx
// TaskCard.tsx:51,59 —— 生产端，未被 #329 修改
onClick={() => onSelectKey(task.issueKey)}          // 发出 "o/r#329"
onSelectKey(task.issueKey);                          // 键盘 Enter/Space 同

// Board.tsx:214 等 4 处渲染点 —— 消费端，已改
active={taskIdentity(task) === selected}             // 期望 "o/r#329@1"

// App.tsx:487 —— 消费端，已改
() => tasks.find((t) => taskIdentity(t) === selected) ?? null,
```

`issueKey` 不含 `@`（GitHub 的 `owner/repo` 不可能出现 `@`），永不可能等于 `issueKey@accountId`。故：

```
selected          = "ShawnLiuSZ/task-dashboard#329"
taskIdentity(task)= "ShawnLiuSZ/task-dashboard#329@1"
find(...)         = null
```

⇒ `App.tsx:684` 的 `{selectedTask && ...}` 永不渲染 ⇒ **详情面板不可达**。

### 为什么既有测试给了虚假的安全感

- `app/src/panel-wiring.test.ts:52-57`（#329 新增）用正则断言 `Board.tsx` 中 `taskIdentity(task)` 出现 8 次、且不含 `task.issueKey === selected` —— **只检查消费端，从不检查生产者**。
- `app/src/components/board.test.tsx` 渲染时固定传 `selected={null}` + `onSelect={noop}`，结构上无法观测该不匹配。
- `docs/issue-329-p2-quality.md:206-208` 记录的计划只列了消费端（「`Board.tsx` 4 处 / `App.tsx` 的 `selectedTask` 查找 / `DetailPanel`、`SessionsPanel` 的 key」），生产端是**遗漏**而非有意决策。

根因是**「改了引用它的所有地方，唯独没改它本身」**——静态正则断言天然只覆盖被写进断言的那几个文件。

### 权衡：为什么不干脆把消费端改回 `issueKey`

消费端改回会重新引入 #329 要修的两个缺陷：重复 React key、跨账号「点 A 打开 B」。而生产端改正是**唯一正确方向** —— 身份是卡片这个实体自身的属性，由生产端提供比让每个消费端各自拼装更不易错（未来新增消费端不会再漏）。

同时**保持既有边界不变**：写操作（`claimIssue` 等）**仍用 `task.issueKey`**，因为后端按 `issue_key` 列定位任务，换成身份值会查不到。`taskIdentity.ts` 头注释已明确「本函数只用于前端身份，不用于后端定位」，本次修复不触碰该边界，并在测试中显式锁住（断言 `claimIssue(task.issueKey)` 仍在）。

## 接口 / 行为变更

- **`TaskCard` 的 `onSelectKey` prop 语义变更**：实参由裸 `issueKey` 改为前端身份 `issueKey@accountId`。已同步更新该 prop 的 JSDoc 说明，避免后续维护者再次误解。
- **UI 行为修复**：点击卡片 / 键盘 Enter/Space 打开详情面板；选中卡片出现 `active` 高亮。
- **无 schema / MCP 工具 / i18n key 变更**（无增删改列；`SELECT_COLS` 未动；无新增用户可见文案）。

## 数据 / Schema 变更

无。

## 测试 / 验收

`app/src/panel-wiring.test.ts` 新增 `describe('任务身份生产端与消费端同口径（#339）')`，3 个用例：

1. **静态锁生产端**：断言 `TaskCard.tsx` 中不存在 `onSelectKey(task.issueKey)`，且 `onSelectKey(taskIdentity(task))` 恰好出现 2 次（`onClick` + 键盘路径各一处）。
2. **锁写操作边界**：断言 `claimIssue(task.issueKey)` 仍用裸键，防止「为了让测试 1 通过」而误改写路径。
3. **端到端契约**：复刻 `App.tsx:487` 的查找式，断言身份实参能命中任务，**同时断言旧的裸键查不回**（把缺陷本体固化为断言）。

**反向验证**：把 `TaskCard.tsx` 还原为缺陷版本（`git stash push -- app/src/components/TaskCard.tsx`）后重跑，用例 1 失败（`Tests 1 failed | 23 passed`）；恢复修复后 24 passed。

已跑：`npm test`（212 → **215** passed）、`npx tsc --noEmit`、`npm run i18n:check`、`npm run lint`。

## 相关链接

- Issue：[#339](https://github.com/ShawnLiuSZ/task-dashboard/issues/339)
- 前序重构与计划文档：[`docs/issue-329-p2-quality.md`](./issue-329-p2-quality.md)（#329 批次，本缺陷的来源批次）
- 身份函数：[`app/src/utils/taskIdentity.ts`](../app/src/utils/taskIdentity.ts)
- 接线守卫：[`app/src/panel-wiring.test.ts`](../app/src/panel-wiring.test.ts)
- 深度 review 中发现的其余 7 个缺陷：#340 / #341 / #342 / #343 / #344 / #345 / #346
- CHANGELOG：[`docs/CHANGELOG.md`](./CHANGELOG.md)

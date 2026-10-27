# #484 顶栏计数改为「我的未完成 issue 数」

> 对应 issue：[#484](https://github.com/ShawnLiuSZ/task-dashboard/issues/484)
>
> 分支：`feature/issue-484-topbar-open-count`
>
> 类别：前端 / 信息口径（顶栏）

## 背景 / 动机

顶栏计数字段此前取 `visible.length`，即**当前视图全部任务**（含已关闭）。实测本机激活账号（id=5）：

- 顶栏显示「共 567 条」；
- 看板各列之和为 **558**（差 9 条：`project_status = "Planned"` 且未关闭的任务落入表外分组，见 #485 待办）；
- 其中 **386 条是已关闭**任务。

于是这个数字既混入了已完成项，又与看板实际渲染条数不一致，**无法回答「我还有多少 issue 没做完」**——而这正是用户看这一栏的动机。

## 设计 / 方案

计数口径改为**我的未完成 issue 数**，两条排除规则：

| 条件 | 语义 | 来源 |
|---|---|---|
| `issueState === 'closed'` | GitHub 权威关闭（同步路径同时会把本地状态置 `done`） | REST / GraphQL 同步 |
| `status === 'done'` | 看板手动标记「已完成」，issue 可能尚未关闭 | 本地看板操作 |

保留的语义：

- **归属**：入参是 `list_tasks` 的结果，后端已按账号 `ownership` 规则筛过 ⇒ 天然是「我的」。
- **筛选**：仍从 `visible` 取数 ⇒ 仓库筛选、关键词搜索照旧生效，与看板同源，避免两处口径打架。
- **已关闭任务仍显示**：看板「已完成」列不变，因此该数字**本就不等于各列之和**；文案改为显式口径（zh「未完成 {n} 条」/ en「{n} open」），不再用「共 N 条」误导。

实现要点：

1. 口径抽成纯函数 `app/src/utils/openCount.ts::countOpenIssues(tasks)` —— App 层没有组件测试基建，内联在 JSX 里的过滤只能靠端到端测试守（与 `taskIdentity` / `matchRules` 同一处理方式）。
2. `App.tsx` 用 `useMemo(() => countOpenIssues(visible), [visible])`，替换 `visible.length`。
3. i18n key `topbar.totalCount` → `topbar.openCount`（中英同步改，key 集合保持一致）。

## 接口 / 行为变更

- 顶栏文案：`共 {n} 条` → `未完成 {n} 条`；en `{n} tasks` → `{n} open`。
- 顶栏数字：全部任务 → 未完成任务（本机 567 → **181**）。
- Tauri command / MCP 工具 / 后端行为：**无变更**。
- i18n key 重命名：`topbar.totalCount` 删除，新增 `topbar.openCount`（两语种 key 集合仍完全一致）。

## 数据 / Schema 变更

无。

## 测试 / 验收

单测 `app/src/utils/openCount.test.ts`（6 条）：

- 空列表 → 0
- `todo` / `doing` / `processed` 均计入
- `issueState=closed` 不计入
- `status=done` 不计入（issue 未关也不计入）
- closed + done 同时命中只扣一次
- 混合列表只数未完成项（3/6）

已执行：`vitest` / `tsc --noEmit` / `eslint --max-warnings 0` / `prettier --check` / `i18n:check` / `build` / `check-doc-links.py` 全绿。

手工验收：激活账号 5 时顶栏应显示「未完成 181 条」（567 − 386 closed）；搜索框输入关键词后数字随筛选变化。

## 相关链接

- Issue：[#484](https://github.com/ShawnLiuSZ/task-dashboard/issues/484)
- 源码：[`app/src/utils/openCount.ts`](../app/src/utils/openCount.ts)、[`app/src/App.tsx`](../app/src/App.tsx)
- 关联：#259（顶栏计数初版）、#485（按项目视图丢失表外状态任务，另行处理）
- CHANGELOG：[`docs/CHANGELOG.md`](./CHANGELOG.md)

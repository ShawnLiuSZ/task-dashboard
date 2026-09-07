# TaskCard 颜色与全部账号视图下拉修复（#77 #78）

> 关联：[Issue #77](https://github.com/ShawnLiuSZ/task-dashboard/issues/77)、[Issue #78](https://github.com/ShawnLiuSZ/task-dashboard/issues/78)、[docs/CHANGELOG.md](./CHANGELOG.md)

## 背景 / 动机

- **#77 TaskCard 仓库颜色**：四态列视图的 `<TaskCard>` 未传 `repoIndex`，`TaskCard` 内 `(repoIndex ?? 0) % 20` 恒取索引 0 → 所有仓库标签同色。project / custom 视图均已传，唯独四态视图漏掉，导致四个默认列内仓库颜色不区分。
- **#78 全部账号视图下拉**：`viewMode === "all"` 时 `listTasks` 用 `accountId=0` 聚合全部账号，但顶栏账号下拉仍可切换 `activeAccountId`——切换对列表无任何影响，交互语义含混。

## 设计 / 方案

### #77 Board.tsx（四态视图）

在四态视图的返回分支内构建 `repoIndexMap`（与 project 视图同逻辑：`[[...new Set(repos)].sorted()]` → 索引），并给该视图的 `<TaskCard>` 传 `repoIndex={repoIndexMap.get(task.repo) ?? 0}`。各视图独立构建，互不影响。

### #78 App.tsx（账号下拉）

当 `settings.viewMode === "all"` 时给账号 `<select>` 加 `disabled`，`title` 切换为提示文案（新增 i18n key `topbar.switchAccountAll`），说明「全部账号视图下禁用切换，聚合展示所有账号任务」。

## 接口 / 行为变更

- 无 RPC / Command / Schema 变更。
- 新增 i18n key：`topbar.switchAccountAll`（zh/en）。
- `viewMode="all"` 时账号下拉禁用（若未来恢复 all 模式入口即生效；当前 all 恒不可达时此改动为无害防御）。

## 数据 / Schema 变更

无。

## 测试 / 验收

- `npx tsc --noEmit` 通过。
- `npm run i18n:check` 通过：zh-CN / en-US 各 193 个 key。
- 手工验收：
  - 四态视图下不同仓库的卡片标签颜色不同。
  - `viewMode=all` 时账号下拉禁用且 tooltip 提示聚合语义。

## 相关链接

- [Issue #77](https://github.com/ShawnLiuSZ/task-dashboard/issues/77)、[Issue #78](https://github.com/ShawnLiuSZ/task-dashboard/issues/78)
- [docs/CHANGELOG.md](./CHANGELOG.md) v0.3.38
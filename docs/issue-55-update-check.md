# 关于页「检查更新」按钮始终可点击（#55）

> 关联：[Issue #55](https://github.com/ShawnLiuSZ/task-dashboard/issues/55)、[docs/CHANGELOG.md](./CHANGELOG.md)（v0.3.25）

## 背景 / 动机

关于页打开后「检查更新」按钮始终处于 `disabled`，用户无法主动触发版本检查。

根因：`AboutPanel` 的 `state` 初始值设为 `{ phase: "loading" }`，把「尚未检查」与「正在检查」复用了同一状态；按钮的 `disabled` 判断是 `state.phase === "loading"`，导致一打开就被禁用。

## 设计 / 方案

- `State` 新增 `idle` 初始态（未检查、按钮可点击），`loading` 仅表示检查进行中。
- 移除冗余的 `checkedOnce` 标志；检查中显示「检查中…」并短暂禁用（防重复点击），检查完成（成功/报错）后一律恢复可点击。
- 已是最新时展示具体版本号（`about.upToDate` 增加 `{version}` 占位符）。

状态机：`idle` → `loading` → `idle`（成功/失败均回归可点击）。

## 接口 / 行为变更

无 RPC / Command / Schema 变更。行为：按钮打开即可点击；检查完成后恢复可点击，不再卡死。

## 数据 / Schema 变更

无。

## 测试 / 验收

- 按钮打开即可点击。
- 点击后正确展示「当前已是最新版本 vX.Y.Z」或「发现新版本 X，当前为 Y + 下载跳转」。
- 检查完成后按钮恢复可点击（成功 / 报错 / 已最新三种路径均验证）。
- `npm run i18n:check` 通过（`about.upToDate` 占位符 `{version}` 双语一致）。

## 相关链接

- [Issue #55](https://github.com/ShawnLiuSZ/task-dashboard/issues/55)
- [docs/CHANGELOG.md](./CHANGELOG.md) v0.3.25
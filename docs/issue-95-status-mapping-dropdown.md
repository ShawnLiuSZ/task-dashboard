# 自定义列 ↔ project.status 映射：下拉配置增强

> Issue 关联：[#95](https://github.com/ShawnLiuSZ/task-dashboard/issues/95)
> 版本：v0.3.40（2026-09-07）

## 背景 / 动机

Issue #52 实现了每账号独立的自定义看板列（`boardMode=custom`，存于 `account_columns`）。用户可在「匹配规则」录入某些值，后端在 sync 时用 `resolve_column_from_gh_status` 将任务按 Project V2 的 `status` 字段值（`gh_status`）等值匹配进对应自定义列。

Feedback：**没有「project.status 自定义列配置」的专门界面**——「匹配规则」只有手填文本框，用户需自行猜测准确的 status 值（如 `In progress`），大小写/空格偏差即匹配失败，表现为「配了不生效」。

## 设计 / 方案

关键事实：**读取该账号 Project V2 的 status 可选项的能力早已存在**——后端 `list_project_statuses(account_id)`（[commands.rs](app/src-tauri/src/commands.rs#L953-L958)）与前端 `api.listProjectStatuses`（[api.ts](app/src/api.ts#L96-L98)）、`ProjectStatus` 类型均已具备，只是没接入自定义列配置 UI。

因此本功能为**纯前端交互增强，后端匹配逻辑与存储零改动**：

- 「匹配规则」文本框替换为 **chips 多选 + 自由输入追加**：
  - 可选项来自该账号 Project V2 的实际 status 名（`listProjectStatuses` → 去重）。
  - 点击 chips 切换选中（对应列的 matchRules 值）；已选项以 chips 显示、可点击移除。
  - 保留一个自由输入框（Enter / 添加）追加非标准自定义值（兼容册、未同步到的值）。
- 保存仍写 `matchRules`（JSON 数组），`confirmEditCol` 由「解析逗号串」改为「对 `ruleChips` 去重后 `JSON.stringify`」——**向后兼容**已有手填配置（打开编辑时会回显为 chips）。

前端 state：新增 `availableStatuses` / `ruleChips` / `ruleInput`，新增 `toggleRule` / `addCustomRule` 辅助，编辑表单重写匹配规则区块。

## 接口 / 行为变更

| 项 | 变更 |
|---|---|
| 前端 UI | SettingsPanel 自定义列编辑：匹配规则从「文本框」改为「Project status chips 多选 + 自由输入」 |
| i18n | 新增 5 个 key（`noStatus` / `otherValue` / `addRule` / `selected` / `remove`），zh/en 各 177 key |
| 后端 | **无改动**（`list_project_statuses` / `resolve_column_from_gh_status` / `matchRules` 存储均复用） |
| 数据 | 无 schema 变更；`matchRules` 语义不变 |

## 数据 / Schema 变更

无。`account_columns` 表结构不变。

## 测试 / 验收

- [x] 选中账号后，可用 chips 来自该账号 Project V2 的 status 名称（`api.listProjectStatuses`）
- [x] 每列可多选多个 status；打开既有列时已配置值回显为 chips
- [x] 自由输入追加非标准值，保存写入 `matchRules` JSON 数组
- [x] `npx tsc --noEmit` 通过
- [x] `npm run i18n:check` 通过（zh-CN / en-US 各 177 key）

## 相关链接

- Issue #52（自定义列）：[https://github.com/ShawnLiuSZ/task-dashboard/issues/52](https://github.com/ShawnLiuSZ/task-dashboard/issues/52)
- Issue #95（本增强）：[https://github.com/ShawnLiuSZ/task-dashboard/issues/95](https://github.com/ShawnLiuSZ/task-dashboard/issues/95)
- 涉及代码：`app/src/components/SettingsPanel.tsx`、`app/src/i18n/locales/*.json`、`app/src/api.ts`、`app/src-tauri/src/commands.rs`
- [docs/CHANGELOG.md](./CHANGELOG.md) v0.3.40
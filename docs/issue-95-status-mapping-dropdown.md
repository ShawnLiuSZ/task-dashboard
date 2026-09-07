# 自定义列 ↔ project.status 映射：下拉配置 + 设置面板 tab 化

> Issue 关联：[#95](https://github.com/ShawnLiuSZ/task-dashboard/issues/95)
> 版本：v0.3.40（2026-09-07）

## 背景 / 动机

Issue #52 实现了每账号独立的自定义看板列（`boardMode=custom`，存于 `account_columns`）。用户可在「匹配规则」录入某些值，后端在 sync 时用 `resolve_column_from_gh_status` 将任务按 Project V2 的 `status` 字段值（`gh_status`）等值匹配进对应自定义列。

Feedback（两轮）：
1. **没有「project.status 自定义列配置」的专门界面、匹配规则只能手填猜值**——大小写/空格偏差即匹配失败，表现为「配了不生效」。
2. **设置项都挤在一个面板里**，无法单独进入；且 **colKey（列标识）概念困惑**——用户只需「填列名 + 选 project.status 保存」。

## 设计 / 方案

关键事实：**读取该账号 Project V2 的 status 可选项的能力早已存在**——后端 `list_project_statuses(account_id)`（[commands.rs](app/src-tauri/src/commands.rs#L953-L958)）与前端 `api.listProjectStatuses`（[api.ts](app/src/api.ts#L96-L98)）、`ProjectStatus` 类型均已具备，只是没接入自定义列配置 UI。

本功能为**纯前端增强，后端匹配逻辑与存储零改动**：

### 1) 设置面板 tab 化
`SettingsPanel` 顶部新增三段 tab：**基础设置 / 自定义列映射 / 诊断**（`activeTab` state，条件 display 控制；标题栏加关闭 ✕）。自定义列配置独立成页。

### 2) 自定义列编辑简化（去掉 colKey 概念）
- **列标识 col_key 由系统自动生成**（`genColKey()` → `col_<ts36>_<rand>`），页面不再展示/要求输入 col_key。
  - col_key 语义：`sync.rs` 在 custom 模式下把任务 status 写成 `resolve_column_from_gh_status` 返回的 `col_key`（[db.rs:1317](app/src-tauri/src/db.rs#L1317)），Board 用 `col.colKey` 分组渲染（[Board.tsx:143-160](app/src/components/Board.tsx#L143-L160)）。它必须唯一且稳定——**编辑沿用原 key（`startEditCol` 保留 `col.colKey`），仅新增时生成新 key**，保证已落库任务不漂移。
- 用户只需：填**列显示名称** + **下选匹配的 Project status**。
- **匹配的下拉多选（chips）+ 自由输入**：可选项来自该账号 `list_project_statuses`（去重）；点击 chips 选中/移除；自由输入透传非标准值（兼容未同步/自定义值）；打开既有列回显已配置值为 chips。
- 保存仍写 `matchRules`（JSON 数组），`confirmEditCol` 对 `ruleChips` 去重 `JSON.stringify`——**向后兼容**既有手填配置（打开编辑回显为 chips）。

前端 state：新增 `availableStatuses` / `ruleChips` / `ruleInput` / `tab`；新增 `toggleRule` / `addCustomRule` / `genColKey`。

## 接口 / 行为变更

| 项 | 变更 |
|---|---|
| 前端 UI | 设置面板 tab 化（基础 / 自定义列 / 诊断）；标题栏关闭按钮 |
| 前端 UI | 自定义列编辑移除 colKey 录入，仅列名 + Project status 下拉多选（chips）+ 自由输入 |
| i18n | 新增 `settings.tab.base/columns/diagnose`；重写 `customColumnsDesc`、`customColumns.matchRules`；移除死 key `customColumns.colKey/selectAccount/matchRulesHint`（zh/en 各 177 key） |
| 后端 | **无改动**（`list_project_statuses` / `resolve_column_from_gh_status` / `matchRules` 存储均复用） |
| 数据 | 无 schema 变更；`matchRules` 语义不变；col_key 自动生成但存储格式不变 |

## 数据 / Schema 变更

无。`account_columns` 表结构不变；col_key 仍非空唯一（前端自动生成）。

## 测试 / 验收

- [x] 选中账号后，可用 chips 来自该账号 Project V2 的 status 名称（`api.listProjectStatuses`）
- [x] 每列可多选多个 status；打开既有列时已配置值回显为 chips；手填旧配置兼容
- [x] 新增列无需填 colKey（自动生成 `col_*`）；编辑列沿用原 key
- [x] 设置面板 tab 三栏可切换，自定义列独立成页、标题栏可关闭
- [x] `npx tsc --noEmit` 通过
- [x] `npm run i18n:check` 通过（zh-CN / en-US 各 177 key）

## 相关链接

- Issue #52（自定义列）：[https://github.com/ShawnLiuSZ/task-dashboard/issues/52](https://github.com/ShawnLiuSZ/task-dashboard/issues/52)
- Issue #95（本增强）：[https://github.com/ShawnLiuSZ/task-dashboard/issues/95](https://github.com/ShawnLiuSZ/task-dashboard/issues/95)
- 涉及代码：`app/src/components/SettingsPanel.tsx`、`app/src/i18n/locales/*.json`、`app/src/api.ts`、`app/src-tauri/src/commands.rs`
- [docs/CHANGELOG.md](./CHANGELOG.md) v0.3.40
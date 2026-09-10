# issue-108：设置页看板列模式精简为 Project 状态列 / 自定义列两项

> 关联 [Issue #108](https://github.com/ShawnLiuSZ/task-dashboard/issues/108)

## 背景 / 动机

设置面板（SettingsPanel.tsx）「看板列模式」下拉有 3 个选项：`project`、`status`、`custom`。用户要求：

1. 将 `project` 文案精简为「Project 状态列」（去掉「按 GitHub Project Status 分列」后缀）。
2. 去掉「四态列」（`status`）选项，只保留「Project 状态列」和「自定义列」两项。
3. 顺带调整设置页 modal 宽度（当前 460px 偏窄）。

## 设计 / 方案

### 历史 `status` 数据降级：方案 A（零 schema 变更）

看板列模式是每账号配置（v0.3.43+ 存于账号维度）。已配置为 `status` 的账号，去掉选项后需确定行为。采用方案 A：

- **Board.tsx** 渲染层把 `boardMode === "status"` 视为 `boardMode === "project"`。
- `BoardMode` 类型保留 `"status"` 值（向后兼容 SQLite 中的历史数据），但 UI 不再暴露该选项。
- 零 schema 变更、不迁移数据库。

### 具体改动

| 文件 | 改动 |
|---|---|
| `app/src/components/SettingsPanel.tsx` | 移除 `<option value="status">` |
| `app/src/components/Board.tsx` | `if (boardMode === "project")` → `if (boardMode === "project" \|\| boardMode === "status")` |
| `app/src/i18n/locales/zh-CN.json` | 删除 `settings.boardModeStatus` key；`boardModeProject` 文案缩短为「Project 状态列」 |
| `app/src/i18n/locales/en-US.json` | 同步清理；`boardModeProject` → "Project Status Columns" |
| `app/src/styles.css` | `.modal` 宽度从 460px 调整为 520px |

### 类型兼容

`types.ts` 的 `BoardMode` 保持 `"status" | "project" | "custom"`，不做收敛。原因：

- SQLite 中已存在 `boardMode = "status"` 的账号记录。
- 前端类型保留 `"status"` 使 TS 编译不报警，同时 Board.tsx 的降级逻辑确保渲染正确。
- 下次 schema 迁移时可一并清理历史值。

## 接口 / 行为变更

- 设置面板下拉仅剩「Project 状态列 / 自定义列」两项。
- 历史 `boardMode = "status"` 的账号打开看板：降级为 Project 状态列展示，不报错、不白屏。
- 设置页各 tab 布局在加宽后不溢出、对齐正常。

## 测试 / 验收

1. 设置面板下拉仅剩两项，无四态列。
2. `project` 文案显示为「Project 状态列」。
3. 历史 boardMode=`status` 的账号正常展示（降级为 Project 状态列）。
4. `npx tsc --noEmit` 通过。
5. `npm run i18n:check` 通过（无死 key）。

## 相关链接

- [Issue #108](https://github.com/ShawnLiuSZ/task-dashboard/issues/108)
- [PR #110](https://github.com/ShawnLiuSZ/task-dashboard/pull/110)
- `app/src/components/SettingsPanel.tsx`
- `app/src/components/Board.tsx`

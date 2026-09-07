# 看板列模式持久化与一致性修复（#64 #72 #74）

> 关联：[Issue #64](https://github.com/ShawnLiuSZ/task-dashboard/issues/64)、[Issue #72](https://github.com/ShawnLiuSZ/task-dashboard/issues/72)、[Issue #74](https://github.com/ShawnLiuSZ/task-dashboard/issues/74)、[docs/CHANGELOG.md](./CHANGELOG.md)

## 背景 / 动机

2026-09-06 二次全量 bug 审计发现看板列模式（boardMode）体系存在三处关联缺陷，共同导致 issue #52 自定义列功能实际不可用、四态视图任务消失、模式切换不持久：

- **#64 boardMode 无法持久化**：后端 `Settings` 结构体缺 `board_mode` 字段，`get_settings` 不读回。前端 `settings.boardMode` 恒为 `undefined`，永远回退到 `project`。用户切到 custom 后 `loadSettings()` 读回旧值，下拉跳回 project，自定义列视图无法激活。
- **#72 四态选项缺失**：看板模式下拉只有 project / custom 两个 option，旧数据 `boardMode="status"` 时无法切回四态视图；且 `Board.tsx` 默认 `status` 与 `db.rs` 默认 `project` 不一致。
- **#74 自定义列在非 custom 视图下静默生效**：`sync.rs` 不区分 boardMode，只要账号配了自定义列且 gh_status 命中 match_rules，就把 status 写成 col_key，导致四态 / Project 视图下任务「消失」。

## 设计 / 方案

### #64 boardMode 持久化

- `commands.rs::Settings` 新增 `pub board_mode: String` 字段（`#[serde(rename_all = "camelCase")]` 自动序列化为 `boardMode`）。
- `get_settings` 中从 `meta.board_mode` 读取，空值时回退 `"project"`，与 `view_mode` 处理方式对称。
- 前端 `App.tsx` 的 `onChange` 改为串行 `await setBoardMode(mode)` → `await loadSettings()`，加 try/catch，避免 `get_settings` 返回旧值覆盖用户选择。

### #72 四态选项恢复 + 默认值对齐

- `App.tsx` 下拉补 `<option value="status">`，复用已有 i18n key `settings.boardModeStatus`（此前是死 key）。
- `Board.tsx` 默认 `boardMode` 由 `"status"` 改为 `"project"`，与 `db.rs` 默认值及 `App.tsx` 回退值一致。

### #74 自定义列映射门控

- `sync.rs::run()` 读取 `board_mode` 设置（空值回退 `"project"`）。
- `sync_account` 签名新增 `board_mode: &str` 参数。
- 自定义列映射仅在 `board_mode == "custom"` 时调用 `resolve_column_from_gh_status`，否则返回 `None`，回落到 label 映射 / Project Status 映射 / 本地手动态。

## 接口 / 行为变更

- **Tauri command `get_settings`**：返回的 `Settings` 新增 `boardMode: string` 字段（JSON 键名）。前端 `Settings` 类型已有此字段，无需改动。
- **`sync_account`**：新增 `board_mode` 参数，自定义列映射行为受其门控。
- **前端看板模式下拉**：新增 `status`（四态）选项。
- 无新表 / 新列 / 新 MCP 工具。

## 数据 / Schema 变更

无。`meta.board_mode` 键自 v0.3.21 起已存在于默认设置表（`db.rs` DEFAULT_SETTINGS），仅此前未被 `get_settings` 读回。

## 测试 / 验收

- `npx tsc --noEmit` 通过。
- `npm run i18n:check` 通过（184 key 双语一致）。
- `cargo check` 通过。
- `cargo test`：13 passed，2 failed（`insert_account_validates_required_fields`、`delete_account_blocks_default_and_orphan_task_id_kept` 为基线已有失败，与本次改动无关）。
- 手工验收点：
  - 切换到「自定义列」后下拉保持选中，重启应用后仍为自定义列。
  - 切换到「四态列」后看板按 todo / doing / processed / done 渲染。
  - 配了自定义列但当前是四态 / Project 视图时，同步后任务仍出现在对应四态列中，不消失。

## 相关链接

- [Issue #64](https://github.com/ShawnLiuSZ/task-dashboard/issues/64)、[#72](https://github.com/ShawnLiuSZ/task-dashboard/issues/72)、[#74](https://github.com/ShawnLiuSZ/task-dashboard/issues/74)
- [docs/CHANGELOG.md](./CHANGELOG.md) v0.3.29
- [docs/issue-52-custom-column-mapping.md](./issue-52-custom-column-mapping.md)（自定义列功能原始设计）

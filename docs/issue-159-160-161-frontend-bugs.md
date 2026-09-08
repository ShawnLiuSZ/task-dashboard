# 前端修复三连：自定义列回退、confirm 失效、日志错误截断（#159 #160 #161）

> 关联分支：`fix/issue-159-160-161-frontend-bugs`

## 背景 / 动机

用户使用中暴露三个前端缺陷：

1. **#159 自定义列模式空配置回退到四态列**：账号未配置任何自定义列时，把看板列展示方式切到「自定义列」，看板却渲染四态列（todo/doing/processed/done），与用户预期（应回退到 project.status 列）不符。
2. **#160 「清理全部日志」无任何效果**：同步日志面板点击「清理全部日志」无确认框、日志不清空。定位为 `window.confirm()` 在 Tauri v2 WebView 中不被原生支持（macOS WKWebView 静默返回 `false`），确认逻辑从未执行。账号面板「删除账号」的 `confirm()` 存在相同隐患。
3. **#161 同步日志错误信息无法看全**：`.error-cell` 被 `max-width:200px + text-overflow:ellipsis` 截断，失败源/错误详情只能看到开头。

## 设计 / 方案

### #159：custom 模式无列 → 回退 project 列

`app/src/components/Board.tsx` 渲染分支调整：

```
boardMode = project / status               → project 列视图
boardMode = custom 且 accountColumns 非空  → 自定义列视图
boardMode = custom 且 accountColumns 为空  → project 列视图（本次修复）
其余（理论不可达）                          → 四态列（保留作终极兜底）
```

用 `hasCustomColumns` 常量统一判定，避免「custom 空配置静默落到四态列」的误导路径。零后端改动。

### #160：应用内确认弹窗替代 window.confirm

新增可复用组件 `app/src/components/ConfirmDialog.tsx`（`role="alertdialog"`，Esc 关闭=取消，遮罩点击=取消，确认按钮红色 danger 强调不可恢复操作）。替换两处调用：

- `SyncLogsPanel.tsx`：「清理全部日志」→ 先弹确认框，确认后执行 `clear_sync_logs` 并刷新列表。
- `AccountsPanel.tsx`：「删除账号」→ 弹确认框（文案沿用 `settings.deleteConfirm`，确认按钮文案用 `btn.delete`）。

后端 `clear_sync_logs` / `delete_account` 命令本身正常，未改动。

### #161：错误信息点击展开

错误单元格改为内部 `<button class="error-toggle">`：默认单行截断（保留 ellipsis），`title` 原生悬浮提示显示全文；点击切换 `.expanded` 类，展开为多行全文（`word-break: break-all`）。点击另一行时仅展开当前行（单展开状态）。

## 接口 / 行为变更

| 位置 | 变更 |
|---|---|
| `app/src/components/Board.tsx` | custom 模式无列时渲染 project 列视图，不再回退四态列 |
| `app/src/components/ConfirmDialog.tsx` | 新增应用内确认弹窗组件 |
| `app/src/components/SyncLogsPanel.tsx` | 清理全部日志走确认弹窗；错误单元格可点击展开 |
| `app/src/components/AccountsPanel.tsx` | 删除账号走确认弹窗 |
| `app/src/styles.css` | 新增 `.confirm-modal` / `.btn.primary.danger` / `.error-toggle(.expanded)` |
| i18n | 新增 `btn.confirm`、`syncLogs.errorExpandHint`（zh-CN / en-US） |

## 数据 / Schema 变更

无。纯前端改动，不涉及 SQLite。

## 测试 / 验收

- [x] `npx tsc --noEmit` 通过
- [x] `npm run i18n:check` 通过（zh-CN / en-US 各 243 key 一致）
- [x] `npm test` 通过（3/3）
- 手工验收：
  1. 无自定义列账号选「自定义列」展示 → 看板显示 project.status 列（非四态列）
  2. 同步日志面板点「清理全部日志」→ 出现确认框 → 确认后列表清空
  3. 错误信息单元格 hover 见全文 tooltip；点击展开/收起全文
  4. 账号面板删除非默认账号 → 出现确认框 → 确认后删除

## 相关链接

- Issues：[#159](https://github.com/ShawnLiuSZ/task-dashboard/issues/159)、[#160](https://github.com/ShawnLiuSZ/task-dashboard/issues/160)、[#161](https://github.com/ShawnLiuSZ/task-dashboard/issues/161)
- 分支：`fix/issue-159-160-161-frontend-bugs`
- 根因参考：Tauri 官方确认 `window.confirm` 需 polyfill（[tauri-apps/tauri#14051](https://github.com/tauri-apps/tauri/issues/14051)）
- CHANGELOG：[docs/CHANGELOG.md](./CHANGELOG.md) v0.3.51

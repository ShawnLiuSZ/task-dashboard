# Issue #258 — 自动同步部分失败仍显示绿色成功 banner

## 背景 / 动机

自动同步时，若部分账号或数据源失败（`warning` 非空），当前仍显示绿色成功 banner，用户无法区分「全量成功」与「部分失败」。需要将部分失败的结果改为琥珀色警告 banner，与成功 banner 互斥展示。

关联 issue：[#258](https://github.com/ShawnLiuSZ/task-dashboard/issues/258)

## 设计 / 方案

引入 `lastWarning` state 与 `showSyncResult` 辅助函数，将同步结果分为三路：

| 条件 | 展示 | 样式 |
|---|---|---|
| `error` 存在 | 红色错误 banner | `banner error` |
| `lastWarning` 存在（warning 非空） | 琥珀色警告 banner | `banner warn` |
| `lastResult` 存在（无 error/warning） | 绿色成功 banner | `banner ok` |

三者互斥：`showSyncResult(base, warning)` 在 warning 非空时清空 `lastResult` 并写入 `lastWarning`，否则清空 `lastWarning` 并写入 `lastResult`。4 秒自动消失逻辑同步覆盖两个 state。

## 接口 / 行为变更

- `app/src/App.tsx`：
  - 新增 `lastWarning` state（line 45）
  - 新增 `showSyncResult(base, warning)` 辅助函数（line 72-79）
  - 自动消失 `useEffect` 同时监听 `lastResult` 和 `lastWarning`（line 61-68）
  - 两处同步调用（`onSynced` 回调 + `doSync` try 分支）改用 `showSyncResult`，不再手动拼接 warning 字符串
  - Banner 渲染改为三路判断（line 600-605）

## 测试 / 验收

- [x] `npx tsc --noEmit` 通过
- [x] `npm test` — 12 files, 99 tests 全部通过
- [x] `npm run i18n:check` 通过（305 keys × 2 语言）

验收标准：
- 同步全量成功 → 绿色 banner
- 同步部分失败（warning 非空） → 琥珀色 banner，文案含 `⚠️` 前缀
- 同步出错（error） → 红色 banner
- 三种 banner 互斥，不同时出现
- 4 秒后自动消失

## 相关链接

- Issue: [#258](https://github.com/ShawnLiuSZ/task-dashboard/issues/258)
- Branch: `fix/issue-258-sync-warn-banner`
- Commit: `fix(sync): 部分失败 banner 走琥珀色 warn（#258）`
- 改动文件: `app/src/App.tsx`

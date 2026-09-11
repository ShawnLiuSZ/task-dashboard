# Issue #202：记事本宽度可调（百分比，最大 50%）

## 背景 / 动机

记事本面板写死 320px。owner 要求宽度可设置：按 app 窗口百分比，最大 50%。对应 issue：[#202](https://github.com/ShawnLiuSZ/task-dashboard/issues/202)。

## 设计 / 方案

- 面板右缘拖拽条（`ew-resize`）：按占主区宽度百分比实时调宽，范围 15%–50%，松手值写入 `localStorage["notes.widthPct"]`（与 `notes.collapsed` 同类本地偏好，不入 DB）；键盘左右箭头 ±1%，`role=separator` + `aria-valuemin/max/now`
- 默认 25%（1280 宽窗口 ≈ 现状 320px，老用户无感）；收起态（36px）逻辑不变
- 丝滑：拖动中只做 DOM 直写 + rAF 合并，不进 React state，松手提交一次（单次渲染 + 单次持久化）
- 抓手：右缘垂直居中常显 pill（hover/聚焦变蓝）
- `main-layout` 由 grid（`auto 1fr`）改为 flex row：百分比宽在 content-sized track 下解析不可靠，flex 下以容器为基准确定；`.board-wrap` 加 `flex: 1`，`.notes-panel` 加 `max-width: 50%` 兜底
- 新增 `notes.resizeTitle` 中英 key；`clampNotesWidthPct`/`readNotesWidthPct` 导出可测

## 接口 / 行为变更

- 纯前端；无后端/MCP/类型变更（`Task` 未动）

## 数据 / Schema 变更

无（localStorage 本地偏好）。

## 测试 / 验收

- `notes-width.test.tsx` 6 用例：钳制/读取/SSR 默认 25% 与存档 40%
- `tsc`、`vitest` 44 passed、`i18n:check` 276 key 双语一致

## 相关链接

- Issue：[#202](https://github.com/ShawnLiuSZ/task-dashboard/issues/202)
- 分支：`feature/issue-202-notes-width`
- `CHANGELOG.md`：待发版时追加

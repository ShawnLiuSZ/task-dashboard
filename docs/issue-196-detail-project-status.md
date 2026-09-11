# Issue #196：详情状态区按 project.status 展示与默认选中

## 背景 / 动机

看板 project 视图按 `task.projectStatus`（GitHub 原文）分组、custom 视图按 `task.status`（col_key）分组，但详情页状态选择器永远只渲染四态按钮且按 `task.status` 选中：project 视图下高亮与卡片所在列对不上，custom 下直接无选中。owner 确认：**详情状态区永远按 `project.status`，不区分 custom 列模式**。对应 issue：[#196](https://github.com/ShawnLiuSZ/task-dashboard/issues/196)。

## 设计 / 方案

- `App.tsx` 把已加载的 `projectStatuses` 透传给 `DetailPanel`（新增可选 prop）。
- 状态区新增"GitHub 状态"行：选项 = `projectStatuses` 名称；选中键 = `closed→done` / `projectStatus` 原文 / 空→`unclassified`（与 `Board.groupByProjectStatus` 同规则）；当前值不在选项中时前置，保证永远可见且默认选中。
- project 状态是同步只读镜像（`update_task_status` 校验写不进去），该行 `disabled` 只做展示；四态按钮保留为手动覆盖入口（现有行为不变）。
- 新增 `detail.projectStatus` 中英 key（"GitHub 状态（同步只读）"）。

## 接口 / 行为变更

- `DetailPanel` props 新增可选 `projectStatuses`；缺省时只展示当前值单 chip。
- UI：状态区多一行 GitHub 状态行；其余交互不变。

## 数据 / Schema 变更

无。

## 测试 / 验收

- `tsc`、`vitest` 36 passed、`i18n:check` 274 key 双语一致
- 验收标准见 issue #196（三种视图下选中的都是 `projectStatus`；`projectStatuses` 为空仍展示当前值）
- 注意：与未合并的 PR #195（`DetailPanel` 分支行 + `workBranch`）改动区域不同，合并时应可自动合入，需复核

## 相关链接

- Issue：[#196](https://github.com/ShawnLiuSZ/task-dashboard/issues/196)
- 分支：`fix/issue-196-detail-project-status`
- `CHANGELOG.md`：待发版时追加

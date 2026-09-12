# Issue #220：指纹缺 projectStatus 致写回后不刷新

## 背景 / 动机

#215 写回成功但页面不刷新。根因：`taskListSignature`（#181 无变化跳过 setState）未覆盖 `projectStatus`，且本次 `status` 本就为 todo 无变化 → 指纹相同 → 跳过渲染。对应 issue：[#220](https://github.com/ShawnLiuSZ/task-dashboard/issues/220)。

## 设计 / 方案

- `taskSig.ts` 指纹追加 `projectStatus` + `branch`（同类同步镜像字段，`updated_at` 不变时也可能变化）
- 单测追加对应断言；注释同步字段清单

## 接口 / 行为变更

无（指纹内部逻辑）。

## 数据 / Schema 变更

无。

## 测试 / 验收

- 写回后详情选中与看板列即时跟进（dev 实测）
- `vitest` / `tsc` 通过

## 相关链接

- Issue：[#220](https://github.com/ShawnLiuSZ/task-dashboard/issues/220)
- 分支：`fix/issue-220-sig-project-status`
- 前序：#181（指纹机制）、#215（写回）

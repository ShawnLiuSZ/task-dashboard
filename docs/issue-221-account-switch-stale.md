# Issue #221：切换账号请求被吞，看板滞留旧账号

## 背景 / 动机

切换账号后看板长期展示旧账号任务（完成列尤为明显），最多延迟到下轮 20s 轮询。根因：`App.load()` 防重入在忙时直接丢弃——旧筛选请求占锁时，settings 更新后的新筛选请求被吞，无重试。对应 issue：[#221](https://github.com/ShawnLiuSZ/task-dashboard/issues/221)。

## 设计 / 方案

- 新增 `utils/coalescedLoad.ts`：忙时记下最新参数（`{ownership, accountId}`），当前完成后重跑一次；多次并发合并为一次重跑
- `App.loadWith(ow, af)` 走合并器；`load()` 读最新快照 `filterRef`（render 后经 effect 同步）；`handleSwitchAccount` 显式传新账号 id（闭包旧值不可信）；归属下拉 onChange 显式重查（此前靠 load 身份变化间接触发，稳定化后需显式）
- 副作用收益：`load` 稳定后挂载/聚焦订阅不再因筛选变化反复重建

## 接口 / 行为变更

- 交互无变化；并发语义：最新请求必执行（旧逻辑可能吞）

## 数据 / Schema 变更

无。

## 测试 / 验收

- `coalescedLoad.test.ts` 3 用例：空闲直跑、并发合并（3 并发→2 执行，第二次为最新参数）、抛错复位不死锁
- `tsc`、`vitest` 51 passed
- dev 实测：切换账号即时正确；归属筛选即时生效

## 相关链接

- Issue：[#221](https://github.com/ShawnLiuSZ/task-dashboard/issues/221)
- 分支：`fix/issue-221-account-switch-stale`
- 前序：#181（防重入/指纹）

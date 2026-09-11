# Issue #33: 删除账号时级联清理该账号下所有本地数据

## 背景 / 动机

设置页删除 GitHub 账号后，仅移除了账号本身；该账号同步下来的 tasks、sync 日志、session 记录、handoff 记录等仍残留在本地 SQLite。长期运行会累积垃圾数据、混淆统计/查询。

## 设计 / 方案

在 `delete_account` 函数中使用事务实现原子级联删除：
1. 删除 tasks（关联 account_id）
2. 删除 projects（关联 account_id）
3. 删除 project_statuses（关联 account_id）
4. 删除 sync_logs（关联 account_id）
5. 删除账号本身

所有操作在同一事务中执行，中途任一失败则整体回滚。

## 接口 / 行为变更

- `delete_account` 函数现在会级联删除该账号下的所有本地数据
- 事务保证原子性：要么全部删除成功，要么全部回滚
- 默认账号仍不可删除

## 测试 / 验收

- [x] `cargo check` 通过
- [x] 删除账号后，tasks、sync_logs、projects、project_statuses 不再出现该账号数据
- [x] 其他账号数据不受影响
- [x] 事务失败时正确回滚

## 相关链接

- Issue: https://github.com/ShawnLiuSZ/task-dashboard/issues/33

# Issue #216：仅剩一个账号时允许删除

## 背景 / 动机

`db::delete_account` 禁止删除默认账号；只剩一个账号时它必是默认，导致删不掉（想清掉重配 token 都不行）。对应 issue：[#216](https://github.com/ShawnLiuSZ/task-dashboard/issues/216)。

## 设计 / 方案

- `COUNT(*)==1` 时允许删除默认账号；多账号时原规则不变（删默认仍拒绝）
- 删后无账号无默认：`commands::delete_account` 已有回退（`default_account_id` 失败 → `active_account_id=0`）；零账号态同步/UI 均有兜底，无需其他改动

## 接口 / 行为变更

无（同一命令，少一种拒绝）。

## 数据 / Schema 变更

无。

## 测试 / 验收

- `db::delete_last_account_allowed`：单账号可删且删空、不存在的 id 报错、双账号删默认拒绝
- `cargo test` 68 passed、`cargo check` 零 warning

## 相关链接

- Issue：[#216](https://github.com/ShawnLiuSZ/task-dashboard/issues/216)
- 分支：`fix/issue-216-del-last-account`

# Issue #224：同步日志展示所属账号

## 背景 / 动机

同步范围跟视图走（single 只同步当前激活账号，all 才全同步），但同步日志面板不展示账号，多账号下分不清。对应 issue：[#224](https://github.com/ShawnLiuSZ/task-dashboard/issues/224)。

## 设计 / 方案

- 表格新增"账号"列（时间列之后）：`getSettings()` 取账号列表，`accountId → @login`，账号已删回退 `#id`（后端 `account_id` 早已存储，无需动后端）
- 纯函数 `accountLabelForLog` 可单测；新增 `syncLogs.headers.account` 双语 key

## 接口 / 行为变更

- 面板多一列；无后端变更

## 数据 / Schema 变更

无。

## 测试 / 验收

- `sync-logs.test.ts` 追加 2 用例（命中/回退）
- `tsc`、`vitest` 53 passed、`i18n:check` 279 key 通过

## 相关链接

- Issue：[#224](https://github.com/ShawnLiuSZ/task-dashboard/issues/224)
- 分支：`feature/issue-224-log-account`

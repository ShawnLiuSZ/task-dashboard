# Issue #315: 接入指引文案更新

## 背景

Agent 接入面板的「接入指引」有两处缺失：

1. 缺少 `set_work_branch` 的**触发时机**说明（切到 issue 分支后应纠正工作分支）。
2. `record_session` 动作缺少 `work_dir` 参数说明（用于记录当前工作目录）。

## 实现

### 触发时机补全

`app/src/components/AgentPanel.tsx` 的 `TRIGGERS` 数组新增 `setBranch` 项，对应「切到 issue 分支之后」的触发说明。

### i18n

新增 2 个 key（中文 + 英文各 2 处）：

- `agent.guide.setBranch.when` — 切到 issue 分支之后
- `agent.guide.setBranch.action` — `set_work_branch(issue, branch=<当前 issue 分支>)`

### 参数说明补全

`agent.guide.start.action` 文案补上 `work_dir=<目录>` 参数，与 `record_session(issue, <会话id>, "<agent名>", branch=<分支>, work_dir=<目录>)` 实际签名对齐。

## 接口 / 行为变更

- 接入指引的「开始处理」动作展示完整参数（含 `work_dir`）；「触发时机」列表新增 set_work_branch 时机。
- **无 schema / 无后端 / 无 MCP 协议变更**：纯前端 UI + i18n 改动。

## 验收

- [x] `TRIGGERS` 含 `setBranch` 项
- [x] `agent.guide.setBranch.when` / `.action` 中英文齐全
- [x] `agent.guide.start.action` 含 `work_dir=<目录>`
- [x] `npx tsc --noEmit` 0 error
- [x] `npm test` 141 passed
- [x] `npm run build` 通过
- [x] `npm run i18n:check` 385 keys 一致
- [x] `npx prettier --check` 通过

## 关联

- Issue: #315
- PR: #315 合并提交（`d4958c1`）

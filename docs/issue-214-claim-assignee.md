# Issue #214：卡片认领写回 GitHub

## 背景 / 动机

owner 确认反转"只读 GitHub"约束：首批写回之首——卡片点"无人认领"→ 确认框 → 调 GitHub API 把自己设为 assignee。此前详情四态按钮（#200）仅改本地；本次是首个真实写 GitHub 的操作。对应 issue：[#214](https://github.com/ShawnLiuSZ/task-dashboard/issues/214)。

## 设计 / 方案

- `github.rs`：新增 `post` 能力的 `add_assignee`（单次请求，写操作不盲目重试；assignees 添加幂等）+ 纯函数 `assignees_url` / `write_error`（401/403/404 重配指引）
- `commands.rs`：新命令 `claim_issue(key)`（async + spawn_blocking）：按任务 `account_id` 取 PAT/login → POST → 本地 `ownership='assigned'` + assignees 合并去重 → 发 `TASKS_CHANGED_EVENT`（App 现有订阅即时重查）。失败本地不动
- `TaskCard.tsx`：`unassigned-tag` 改为 button → `ConfirmDialog`（#160：webview 无原生 confirm）→ `api.claimIssue`，失败走全局错误横幅；成功靠后端事件。dialog 包一层 `stopPropagation`，避免点穿选中卡片
- 确认文案精简为一句（`card.claimConfirm`）；`owner` 列为空时从 issue URL 反推（老库存的是账号 org，个人账号为空）；写回全链路 `eprintln!` 日志（方法/地址/账号/状态/耗时，绝不记 PAT）
- PAT 权限升级：classic 需 `repo`，fine-grained 需 Issues 读写（403 时横幅指引）

## 接口 / 行为变更

- 新增 Tauri command `claim_issue`；`api.claimIssue`
- 卡片"无人认领"可点；新增 `card.claimTitle` / `card.claimConfirm` 中英 key（替换已无用的 `card.unassignedTitle`，key 总数不变）
- MCP 工具保持只写本地（本次不动）

## 数据 / Schema 变更

无（复用 `ownership`/`assignees` 列）。

## 测试 / 验收

- `github.rs::claim_url_and_write_errors`：URL 组装 + 401/403/404/500 映射
- `board.test.tsx` 新增 2 用例：未认领渲染 claim 按钮（含确认框 SSR 不存在）、已分配无按钮
- `cargo test` / `tsc` / `vitest` 48 passed / `i18n:check` 277 key 通过

## 相关链接

- Issue：[#214](https://github.com/ShawnLiuSZ/task-dashboard/issues/214)
- 分支：`feature/issue-214-claim-assignee`
- 母规划：#213 讨论；姊妹：#215（Project 状态回写，另做）
- 约束修订：`AGENTS.md §2.1`（默认读 + 显式写回通道）、§8.2
- `CHANGELOG.md`：待发版时追加

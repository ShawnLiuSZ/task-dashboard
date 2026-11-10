# `list_my_tasks` 仓库维度过滤（#546）

## 背景 / 动机

`taskboard` MCP 工具 `list_my_tasks` 没有**仓库维度**的过滤。任务库同步自 `org:FoodsUp-Inc` 的全部仓库 open issue（`fad-backend` / `foodsup-client` / `flutter-driver` / `pq-backend` / `task-dashboard` …），因此 agent 在**某一个仓库**的会话里调 `list_my_tasks`，拿回的是**跨所有仓库**的任务。

实际后果：agent 想看「当前仓有什么任务」，会把别的仓库（甚至无关仓库）的事务误当成当前工作对象——在一次真实会话里，agent 因此把 fad-backend 的在途事务误判成了 TaskBoard 本仓的核查目标。UI 侧（`App.tsx`）早已有 `repo` 过滤，但 MCP 工具没暴露这个维度。

## 设计 / 方案

**采纳「显式入参」**：给 `list_my_tasks` 增加可选 `repo` 入参，按 `tasks.repo` 列精确过滤。agent 显式传当前仓库名（它本就知道自己在哪个仓），与既有 `status` / `ownership` 同风格，**无魔法、不读 cwd**。

- **不传 `repo`（`None`）** → 不过滤，返回全部仓库，**向后兼容**（现行为不变）。
- **传具体名** → `WHERE repo = ?`。
- **传空串** → 报错（Python `ValueError` / Rust `Err`），**不静默退化成全量**——对齐 #357 的教训（`list_my_tasks({status:123})` 曾静默丢弃过滤器返回整块看板，正式路径给错数据）。
- `repo` 与 `status` / `ownership` 用 `WHERE ... AND ...` **叠加**。

否决的方案：自动探测进程 cwd 的 git remote——stdio MCP server 的 cwd 不一定等于 agent 的工作目录，不可靠且有魔法。

`get_task_status` 是单 issue 精确查询，无需改。

## 接口 / 行为变更

- `list_my_tasks` 新增可选入参 `repo?: string`：
  - 缺省 / `null` = 全部仓库（现行为，向后兼容）。
  - 具体仓库名 = 只返回该 repo 任务。
  - 空串 = 报错。
  - 可与 `status` / `ownership` 叠加。
- 两侧 `tools/list` 的 `inputSchema` 同步声明 `repo`（描述一致），`description` 补「repo(仓库名)」。
- **零 DB schema 变更**（`repo` 列早已存在于 `tasks` 表与 `SELECT_COLS`）、**零新依赖**、**只读路径**（不碰 GitHub）。

## 数据 / Schema 变更

无。`tasks.repo` 列与两侧 `SELECT_COLS` 均未改动（`scripts/check-mcp-columns.py` 退出码 0 确认）。

## 测试 / 验收

按 ac-test 流程：先由两个隔离子代理按 AC 写测试（先测后写），锁定测试文件后实现，再全绿。测试**落在两侧既有测试文件**（随 PR 正常提交，非临时目录）。

| AC | 内容 | 结果 |
|----|------|------|
| AC-1 | `list_my_tasks({repo:"A"})` 只返回 A 仓，不含其他仓库 | ✅ 2026-11-10 |
| AC-2 | 不传 `repo` → 全部仓库（向后兼容） | ✅ 2026-11-10 |
| AC-3 | `repo:""` 空串 → 报错，不静默返回全量 | ✅ 2026-11-10 |
| AC-4 | `repo` + `status` + `ownership` 三条件叠加 | ✅ 2026-11-10 |
| AC-5 | `scripts/check-mcp-columns.py` 退出码 0 | ✅ 2026-11-10 |
| AC-6 | 两侧 `inputSchema` 均声明 `repo`，描述一致 | ✅ 2026-11-10 |

- Python：`mcp_server/test_server.py::RepoFilterAC`（`test_ac1_repo_filter` / `test_ac2_no_repo_returns_all` / `test_ac3_empty_repo_errors` / `test_ac4_repo_stacks_with_status_ownership`）—— 72 passed。
- Rust：`app/src-tauri/src/mcp.rs::tests`（`list_repo_filter_ac1` / `list_repo_no_filter_returns_all_ac2` / `list_repo_empty_string_errors_ac3` / `list_repo_stacks_with_status_ownership_ac4`）—— 27 passed。
- 门禁：`cargo clippy --lib -p taskboard --all-targets -- -D warnings` ✓ · `scripts/check-mcp-columns.py` ✓ · `npx tsc --noEmit` ✓ · `npm run i18n:check` ✓。
- **既有测试调用点适配**：`tool_list` 签名加 `repo` 后，`mod tests` 里 6 处既有调用由 3 参补成 4 参（加 `None`）——**只改调用参数，断言一字未动**（追溯审计逐 hunk 核实）。

## 相关链接

- Issue: [#546](https://github.com/ShawnLiuSZ/task-dashboard/issues/546)
- 回归防线：#357（非法入参不得静默丢弃过滤器）、#467（`task_prs` 关系表）
- 文档索引：[`CONTRIBUTING.md`](../CONTRIBUTING.md)「文档索引」

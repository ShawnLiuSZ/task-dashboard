# Issue #215：详情 Project 状态写回 GitHub

## 背景 / 动机

#200 拿掉四态后详情无处切换状态；owner 确认反转只读约束时指定首批写回之二——详情点 Project 状态 → 确认框 → GraphQL 写回。对应 issue：[#215](https://github.com/ShawnLiuSZ/task-dashboard/issues/215)。

## 设计 / 方案

写回需 item/field/option 三件套，本地全缺，故同步先补 ID 再写命令：

- `github.rs`：`status_field()`（字段 id + 选项 id；`fetch_project_status_options` 删 wrapper 冗余，调用方直用）、`fetch_project_issues` 附带 `item_ids`、`project_status_mutation`（纯）+ `set_project_item_status`（eprintln 日志，403 按 FORBIDDEN 特征给写权限指引）
- `db.rs`：`projects.status_field_id`、`project_statuses.option_id`、`project_items` 新表（SCHEMA + 迁移双写，遵 #155 教训）；`set_project_status_field` / `replace_project_items`（每轮全量替换）/ `resolve_project_write_target`（多项目选条目数最多者）/ `project_option_id`（未知名报错并列可选）；`delete_account`/`prune_projects` 级联清 items
- `sync.rs`：并行结果携带 field + item 落库；`resolve_final_status` 升 `pub(crate)` 供命令复用（乐观更新与同步同一语义）
- `commands.rs`：`set_project_status`（async + 独立连接，不持共享锁跨网络；closed 拒绝；**本地无 ID 即时补拉后重试**，主项目优先、单项目失败跳过下一个；本地 `project_status` + 决策重算 `status`）
- `db.rs`：`resolve_project_write_target` 返回含项目名（报错可定位多项目）；名字命中但 id 为空与未知名字区分报错
- `DetailPanel.tsx`：GitHub 状态行可点（当前项 disabled）→ `ConfirmDialog` → `run(api.setProjectStatus)`，失败详情横幅；`detail.projectStatus` 文案去"只读"，新增 `detail.projectStatusConfirm`

## 接口 / 行为变更

- 新增 Tauri command `set_project_status`；`api.setProjectStatus`
- PAT 需 Project 写权限（classic `project`；fine-grained Projects 读写），403 时指引
- MCP 工具保持只写本地（本次不动）

## 数据 / Schema 变更

- `projects.status_field_id`、`project_statuses.option_id`、`project_items` 表；老库 ALTER/建表迁移（`open_db` 内，与 SCHEMA 双写）；`check-mcp-columns.py` 不涉及（tasks 未动）

## 测试 / 验收

- `db::project_write_target_resolves_main_project`：双项目选主、选项查 id、未知报错、replace 覆盖
- `github::project_status_mutation_shape`：mutation 文本组装
- `cargo test` 70 + 19 / `tsc` / `vitest` 48 / `i18n:check` 278 key 通过
- 真机验收（需写权限 PAT）：点状态→确认→GitHub Project 变化→详情跟进；三件套缺失/403 给可读错误

## 相关链接

- Issue：[#215](https://github.com/ShawnLiuSZ/task-dashboard/issues/215)
- 分支：`feature/issue-215-proj-status`（基于 #214 commit 层叠）
- 母规划：#213 讨论；姊妹：#214（认领，先合）
- 约束修订：`AGENTS.md §2.1`（"规划中"转正）、`PRD.md` D2 注记
- `CHANGELOG.md`：待发版时追加

# Issue #192：显式 label→todo 优先于 gh_status

## 背景 / 动机

`docs/bug-audit-2026-09.md` P2-#4 遗留：`sync.rs` 用 `mapped_status != "todo"` 把"显式 label 映射到 todo"与"state 兜底的 todo"混为一谈，一律让位给 Project Status，违反 `AGENTS.md §2.2` 优先级（Label #2 > gh_status #3）。owner 已确认语义：**显式 label 映射（含 todo）优先**。对应 issue：[#192](https://github.com/ShawnLiuSZ/task-dashboard/issues/192)。

## 设计 / 方案

- `db.rs`：`resolve_status_from_rules` 拆为 wrapper + 新函数 `resolve_status_from_rules_explicit`（仅显式命中返回 `Some`，无命中/空 labels 返回 `None`，兜底不在此产生）。旧 wrapper 语义不变。
- `sync.rs`：新增纯函数 `resolve_final_status(closed, column_status, explicit_label, gh_status_raw, existing_status)` 承载完整优先级链，循环内只做数据准备后调用。唯一行为变化：显式 label→todo 不再被 gh_status 覆盖；其余路径与原来逐字等价（含"映射不到保持本地、绝不回落原文"约束）。

## 接口 / 行为变更

- 无 Tauri command / MCP / UI 变更。
- 行为变更（owner 已确认）：显式 label→todo 与 gh_status 映射冲突时，前者胜出。

## 数据 / Schema 变更

无。

## 测试 / 验收

- `db::tests::resolve_status_explicit_distinguishes_todo_hit_from_fallback`：显式 todo→Some、无命中→None、wrapper 兜底不变
- `sync` `resolve_final_status_follows_priority`：7 条优先级断言（含 #192 主场景、closed 覆盖、custom 列优先、未知 gh_status 保持本地）
- 全量 `cargo test`：66 + 19 passed

## 相关链接

- Issue：[#192](https://github.com/ShawnLiuSZ/task-dashboard/issues/192)
- 分支：`fix/issue-192-193-label-priority-polish`
- 前序：`docs/bug-audit-2026-09.md` §3-#4
- `CHANGELOG.md`：待发版时追加

# #359 工程卫生三项：版本号硬编码漂移 / CI clippy 覆盖不全 / MCP 列清单门禁漏写列

> 对应 issue：[#359](https://github.com/ShawnLiuSZ/task-dashboard/issues/359)
>
> 分支：`fix/issue-359-tooling-hygiene`
>
> 类别：工具链 / CI 门禁 / 版本一致性

## 背景 / 动机

深度 review（#339–#346 批次）的最后一组遗留项。三项互相独立，但都属「**门禁有盲区**」—— 共性是 CI 全绿而问题确实存在。

## 设计 / 方案

### ① `serverInfo.version` 硬编码且已漂移 4 个版本

`mcp_server/server.py` 写死 `"0.6.1"`，而实际版本 `0.6.5`（Rust 侧用 `env!("CARGO_PKG_VERSION")` 自动取值）。`scripts/check-versions.py` 不覆盖该文件 ⇒ 漂移无门禁，agent 通过 `initialize` 拿到的是过期版本。

**修法**：新增 `_app_version()` 从 `app/src-tauri/Cargo.toml` 的 `[package] version` 解析（**单一来源**）。解析失败（源码树不完整 / 便携分发缺 Cargo.toml）回落 `"0.0.0"` —— MCP 是兜底路径，不应因读不到版本号就拒绝启动。

同时给 `check-versions.py` 加 `mcp_server_version()` 反向校验：一旦有人改回硬编码，CI 立刻报错。

### ② CI 的 Rust lint 只覆盖 `--lib`

`quality-check.yml` 的 clippy 步骤是 `cargo clippy --lib`，而 `--lib` **不编译也不 lint 测试目标** ⇒ `tests/db_test.rs` 与各文件的 `mod tests` 里的问题永远挡不住 CI。

实测 `main` 上 `cargo clippy --all-targets -- -D warnings` 有 **5 处存量 error**：

| 位置 | 问题 |
|---|---|
| `tests/db_test.rs:43` | `*v_default == ""` ⇒ clippy `comparison_to_empty`（应 `.is_empty()`） |
| `src/lib.rs:262` | `mod tests` 之后还有 `open_sync_conn` / `run_sync` / `run_mcp` 等 ⇒ `items_after_test_module`，测试模块被放在文件中间 |
| `src/commands.rs:2158` | `let conn = …; conn` ⇒ clippy `let_and_return` |

**修法**：三处修掉，并把 CI 步骤改为 `cargo clippy --all-targets -p taskboard -- -D warnings`。本次之后该门禁首次真正覆盖测试代码。

### ③ `check-mcp-columns.py` 只校验 `ENSURE_COLUMNS ⊇ SELECT_COLS`

写列清单 `TASK_INSERT_COLS` 未被覆盖。当前差集为 `{synced_at}` —— 但**这是防御性冗余，不是修 bug**：

`#346` 已复核并据实关闭该差集：`_write_task_if_absent` 的 INSERT 列清单是按实际表结构过滤的（列存在必被插入、列不存在则表上无该列、无约束可违），且 `synced_at` 自 Initial commit 起就在 `SCHEMA` 内，真正「老到缺列」的库会先被 `LEGACY_TASKS_COLUMNS` 判定拒绝服务。

因此本次做两件事：

1. `ENSURE_COLUMNS` 补 `("synced_at", "INTEGER NOT NULL DEFAULT 0")` —— **不修复任何可达故障**，只是让新门禁能常绿。
2. `check-mcp-columns.py` 新增 `ENSURE_COLUMNS ⊇ TASK_INSERT_COLS` 断言 —— 目的���让「往 `TASK_INSERT_COLS` 加列 ⇒ 必须同步补 ALTER」成为**可机械校验的不变量**，杜绝将来新增列时的静默漂移。

> 断言与 #346 的结论不冲突：#346 说「这条路径不可达」，本条说「但仍应把它锁住」。

## 接口 / 行为变更

- **MCP 行为变更（对外可见）**：`initialize` 返回的 `serverInfo.version` 由 `0.6.1` → `0.6.5`（自动取值，此后随发版自动同步）。
- **CI 行为变更**：clippy 步骤覆盖到测试目标（更慢但更严）。
- **无 schema / MCP 工具签名（工具清单与参数不变）/ i18n key 变更**。

## 数据 / Schema 变更

- **无 `tasks` 表列变更**（`db.rs` 未动，`tasks` 仍是 34 列）。
- `ENSURE_COLUMNS` 是**Python MCP 侧的建表补列清单**，非 SQLite schema 定义 —— 仅在 Python MCP 打开一个缺该列的库时补一条 `ALTER TABLE ... ADD COLUMN`（该场景当前不可达，见上文）。

## 测试 / 验收

- **`scripts/test_check_versions.py` 新增 3 例**（114 → 117）：
  - `test_mcp_server_version_is_not_hardcoded` — 真实仓库的 `server.py` 不得硬编码
  - `test_mcp_server_hardcoded_version_is_detected` — 构造硬编码源码，`mcp_server_version()` 必须识别出来
  - `test_python_mcp_reports_the_current_version` — `_app_version()` 必须等于 `Cargo.toml` 版本（真正跨语言对齐）
- **反向验证**：
  | 回退 | 结果 |
  |---|---|
  | `ENSURE_COLUMNS` 去掉 `synced_at` | `check-mcp-columns.py` 报「未覆盖 TASK_INSERT_COLS 的列: synced_at」✗ |
  | `server.py` 改回硬编码 `0.6.1` | `check-versions.py` 报「又把 serverInfo 版本硬编码成 0.6.1」✗ |
  | clippy 改回 `--lib` | 由 `check-workflow-yaml.py` 的 workflow 校验 + 本地 `--all-targets` 双保障 |

已跑：`cargo clippy --all-targets -p taskboard -- -D warnings`（0 error，此前 5）、`cargo fmt --check`、`cargo test` 150 + 26、Python MCP 53、scripts 117（114 → +3）、`check-versions.py`、`check-mcp-columns.py`、`check-workflow-yaml.py`。

## 遗留说明

`--all-targets` 比 `--lib` 慢（会编译并 lint 测试目标）。CI 的 `rust-clippy` job 耗时因此上升，本次实测在可接受范围内；若后续成为瓶颈，可考虑加 `cargo clippy --all-targets --no-deps` 或拆分 job。

## 相关链接

- Issue：[#359](https://github.com/ShawnLiuSZ/task-dashboard/issues/359)
- 被本 PR 引用为「防御性冗余」依据：[#346](https://github.com/ShawnLiuSZ/task-dashboard/issues/346)
- 源文件：[`mcp_server/server.py`](../mcp_server/server.py)、[`scripts/check-versions.py`](../scripts/check-versions.py)、[`scripts/check-mcp-columns.py`](../scripts/check-mcp-columns.py)、[`.github/workflows/quality-check.yml`](../.github/workflows/quality-check.yml)
- 本批其余项见 [`docs/CHANGELOG.md`](./CHANGELOG.md) 的「深度 code review 批次（第二批）」块（#355 / #356 / #357 / #358）
- CHANGELOG：[`docs/CHANGELOG.md`](./CHANGELOG.md)
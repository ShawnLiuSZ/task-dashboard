# #169 Python MCP 未跟进 #155 列名重构（读路径失效 + 写入未提交）

> 版本：v0.3.53 ｜ 状态：已实现 ｜ 分支：`fix/issue-169-mcp-server-schema-sync`

## 背景 / 动机

TaskBoard 有两套 MCP 实现，读写同一张 SQLite 表：

| 实现 | 文件 | 定位 |
|---|---|---|
| 主实现 | `app/src-tauri/src/mcp.rs` | 随 App 二进制打包（`taskboard mcp`） |
| 兜底 | `mcp_server/server.py` | 便携 / 开发用，Python 标准库零依赖 |

#155 把 `tasks.key` 改名为 `tasks.issue_key` 后，**Python 侧一行没改**：

- `SELECT_COLS` 仍写 `key`，`tool_get_task_status` 仍用 `WHERE key=?` → `list_my_tasks` /
  `get_task_status` 必然抛 `no such column: key`，**读路径整体失效**；
- 四个写任务工具没有任何 `conn().commit()`，python sqlite3 默认事务模式下
  DML 不提交，长连接看着成功、进程一退出就回滚 → **写入全丢**。

**为什么 CI 一直没发现**：Python MCP 不参与 Tauri 构建，现有 CI 只有 i18n 检查，
既没有类型系统也没有测试碰到它。这类「双实现脱节」在本仓库已第三次发生（#68/#79、#155、本次），
因此本 issue 除了修 bug，还补了一层**能拦住它的检查**。

问题发现于 #114 的实现过程。

## 设计 / 方案

### 1. 列名对齐（唯一事实来源 = `db.rs::SCHEMA`）

两侧 `SELECT_COLS` 统一改为同一份清单（23 列），补齐 #155 之后新增的字段：

```
issue_key, owner, repo, number, title, url, issue_state, ownership,
status, project_status, assignees, mentioned, latest_comment_url,
pr_number, pr_url, branch, session_id, session_agent, session_at,
handoff, candidate_done, account_id, updated_at
```

取舍：

- **为什么不沿用「最小子集」**：原 Rust 侧只返回 11 列且在 #155 后未扩展，
  Python 侧则彻底坏掉。两边各自演化是根因，统一清单 + CI 比对才是解法；
  纯增量加列对调用方是向后兼容的（原有字段名一个没删）。
- **未纳入的列**：`id`（内部主键）、`labels`/`done_at`/`comments_count`/`stale`/`synced_at`
  （当前 agent 侧无用），保持 payload 精简。
- `get_task_status` / `record_handoff` 的返回字段 `key` → `issue_key`，与 Rust 侧一致
  （这两个函数之前本就是坏的，无兼容负担）。

### 2. 写入提交

`sqlite3.connect(..., isolation_level=None)` → 自动提交。

取舍：比在 11 个工具出口各写一次 `commit()` 更不容易漏——本次事故正是「每处自己记得提交」
这种策略失效的结果。notes 工具原有的显式 `commit()` 保留（自动提交模式下无副作用），
后续可清理。

### 3. 防回归检查（本次的真正交付）

新增 `scripts/check-mcp-columns.py`（零依赖，仅标准库）：

1. 从 `db.rs::SCHEMA` 解析 `tasks` 表真实列名作为基准；
2. 校验 Python / Rust 两侧 `SELECT_COLS` 的每一列都真实存在；
3. 校验两侧列集合**逐列相同（含顺序）**——否则同一工具在两个实现里返回不同字段；
4. 兜底扫描 Python 侧残留的旧列名写法 `WHERE key=?`（跳过注释行）。

配套 `.github/workflows/mcp-schema-check.yml`，PR 与 push 到 `main`/`develop` 时运行。
`AGENTS.md` §4.2 与 §8.6 已写入「改 tasks 表 schema 后必跑」的硬约束。

> 实现坑：Python 的 `SELECT_COLS` 是多行字符串隐式拼接，按逗号切分时
> 跨行片段会同时含上一行的收尾引号与下一行的起始引号，`strip('"')` 只吃掉两端各一个，
> 中间那个会粘在列名上（`'"status'`）。必须先全局剥引号再切分。

## 接口 / 行为变更

| 位置 | 变更 | 兼容性 |
|---|---|---|
| `mcp_server/server.py` | `SELECT_COLS` 改 `issue_key` 并补 12 个新列 | 增量加列，向前兼容 |
| `mcp_server/server.py` | `get_task_status` / `record_handoff` 返回 `issue_key`（原 `key`） | 破坏性，但这两处原本报错不可用 |
| `mcp_server/server.py` | 连接改自动提交 | 行为修正 |
| `app/src-tauri/src/mcp.rs` | `SELECT_COLS` 扩容至与 Python 侧完全一致（23 列） | 增量加列，向前兼容 |
| `scripts/check-mcp-columns.py` | 新增 | — |
| `.github/workflows/mcp-schema-check.yml` | 新增 | — |

## 数据 / Schema 变更

无。仅让代码回到与既有 schema 一致。

## 测试 / 验收

已跑：

- `scripts/check-mcp-columns.py` ✅（23 列，两侧一致且均存在于 tasks 表）
- 负例验证 ✅：`key`、`bogus_col`、两侧不一致三种情况都能被识别
- 真实数据冒烟 ✅：把本机 `taskboard.db` 备份到临时副本后直连调用，
  `list_my_tasks` 返回 493 条、六个任务工具全部通过；**另起一个独立连接复读**，
  确认 `update_task_status` / `record_session` / `record_handoff` / `clear_session` 的写入已落盘
- `cargo check` / `cargo test` ✅

> 冒烟脚本未入库（一次性验证），操作对象是 `/tmp` 里的 DB 副本，未触碰用户真实数据库。

验收清单：

1. `python3 mcp_server/server.py` 以 stdio 方式调用六工具全部正常；
2. 写入后重启 GUI / 另起进程再读，数据仍在；
3. 与 Rust MCP 同参数调用的返回结构一致；
4. CI 的 mcp-schema-check 通过。

## 相关链接

- Issue：[ShawnLiuSZ/task-dashboard#169](https://github.com/ShawnLiuSZ/task-dashboard/issues/169)
- CHANGELOG：[v0.3.53 条目](./CHANGELOG.md)
- 关联：#155（tasks 表物理重建，根因）、#114（发现处）、#68/#79（MCP 一致性，历史同类）
- AGENTS.md §4.2 检查清单、§8.6 跨文件一致性

## 遗留（本次未做）

- `server.py` 的 notes 工具保留了自动提交模式下的冗余 `commit()` 调用，可统一清理。
- Rust 侧 `mcp.rs` 的任务工具返回体仍是手写的 `json!` 结构，未与 `commands.rs::Task` 复用；
  若后续字段继续膨胀，建议抽出公共序列化。

# #329 P2 批次：校验脚本 / MCP 一致性 / 异步化 / 前端健壮性 18 项

> code review 的 **P2 批次**，来源 [`CODE-REVIEW-2026-09-30.md`](../CODE-REVIEW-2026-09-30.md)
> （基线 `main @ f66f83f` / v0.6.5）。
> 本批是**逻辑一致性、校验工具缺陷与前端健壮性**：多数不影响主流程，但会导致
> 「检查器误报 / 漏报」「两个 MCP 实现给 agent 相反结论」「界面静默劣化」，
> 以及一处会引发 **UI 最长 5 秒 beachball** 的写锁争用。

## 背景 / 动机

前两批处理用户可感知缺陷（[#327](./issue-327-p0-functional-defects.md)）与
数据安全 / 静默失败（[#328](./issue-328-p1-data-safety.md)）。本批把注意力转到
**「守门工具本身不可靠」**与**「一致性」**上——两类问题典型特征是**没有报错**：

- 校验脚本**误报**（合法写法被判错）会逼人绕过门禁，**漏报**会让 CI 给虚假安全感；
- 两个 MCP 实现字段语义不一致时，agent 按长度校验会得到互相矛盾的结论；
- 前端「消失的样式」「跳变的列表」「选错的任务卡」都不会抛异常。

18 项按域归类：

| 组 | # | 问题 | 类型 |
|---|---|---|---|
| A 校验脚本 | 1 | `merge-cleanup.py::CLOSE_RE` 丢中间 issue 编号 | **漏报** |
| | 2 | `merge-cleanup.py::SKIP_DELETE_MARKERS` 子串匹配误伤 | **误报** |
| | 3 | `check-workflow-yaml.py` 误判 `read-all` / `on: [a,b]` | **误报** |
| | 4 | `check-workflow-yaml.py` 漏报面（4 类） | **漏报** |
| B MCP 一致性 | 5 | `server.py::ensure_schema` 缺列 → 老库 `no such column` | 可用性 |
| | 6 | `handoff_len` 字节数 vs 字符数 | 契约不一致 |
| C Rust 性能 | 7 | `open_db` 每次建连写库，与同步长事务叠加卡 UI | **性能 / 卡顿** |
| | 8 | 重活跑在 Tauri 主线程 | **性能 / 卡顿** |
| D 前端 | 9 | 任务唯一键 `issueKey` 跨账号不唯一 | React key 重复 / 选错 |
| | 10 | Esc 冒泡：确认框与整块面板同时关闭 | 交互 |
| | 11 | `SessionsPanel.handleCopy` 无 catch + 定时器泄漏 | 未处理拒绝 |
| | 12 | 启动 quarantine 提示无 catch | 未处理拒绝 |
| | 13 | AgentPanel 项目目录输入每键 2 次 IPC | 性能 |
| | 14 | NotesPanel 每次增删改整块替换为「加载中」 | 界面跳变 |
| | 15 | SettingsPanel `[accounts]` effect 重置未保存草稿 | 数据丢失 |
| | 16 | `clearAllFilters` 绕过查询合并器 | 竞态 |
| | 17 | CSS 引用未定义变量 → 样式静默失效 | 静默劣化 |
| | 18 | 主题切回「跟随系统」重复注册监听 | 泄漏 |

## 设计 / 方案

### A1. `merge-cleanup.py`：编号串整体捕获（`merge-cleanup.py`）

原正则用**可重复捕获组** `(?:\s*#\s*(\d+)(?!\d))*` 收集多编号：

```python
r"\s*[:：]?\s*#\s*([1-9]\d{0,5})(?!\d)"
r"(?:\s*#\s*([1-9]\d{0,5})(?!\d))*"
```

`(?:...)*` 是外层**非**捕获组，内层 `(\d+)` 每轮迭代**覆盖**前一轮的值，`m.groups()`
只剩「第一个 + 最后一个」。实测 `extract_issue_refs('t', 'Closes #1 #2 #3')` →
`[1, 3]`，**中间的 `#2` 静默丢失**（该 issue 永不被自动关闭）。
现有单测 `test_merge_cleanup.py:84` 只测 2 个编号，恰好落在「第一个 + 最后一个 = 全部」
的巧合区间，因此一直没暴露。

修复：把编号串**整体**捕获，再用独立正则逐个取出：

```python
r"(#\s*[1-9]\d{0,5}(?!\d)(?:\s*#\s*[1-9]\d{0,5}(?!\d))*)"
# ...
ISSUE_NUM_RE = re.compile(r"#\s*([1-9]\d{0,5})")
for n in ISSUE_NUM_RE.findall(m.group(1)):
    ...
```

### A2. `merge-cleanup.py`：跳过删分支改按词边界匹配

`SKIP_DELETE_MARKERS = ('test', 'draft')` 原用 `m in title.lower()` 子串判断，
于是 `chore: bump to latest deps` 里的 `latest` 命中 `test`，`contest` / `protest` /
`attest` 同理——这类 PR 全被判成「验证用 PR」而**静默跳过删分支**，分支越堆越多。

修复：边界定义为「前后不得是字母或数字」，保留原意（`test_workflow` / `test-PR`
前面是行首或非字母数字 ⇒ 仍匹配）：

```python
SKIP_DELETE_RE = re.compile(
    r"(?<![a-z0-9])(" + "|".join(SKIP_DELETE_MARKERS) + r")(?![a-z0-9])",
    re.IGNORECASE,
)
```

### A3 / A4. `check-workflow-yaml.py`：双向修正

检查器的**误报比漏报更致命**（误报会逼人绕过门禁），故本轮同时收窄误报面与扩大漏报面。

**修误报（3 类合法写法此前被判错）**：

| 写法 | 原判定 | 修复 |
|---|---|---|
| `permissions: read-all`（官方简写） | 报「没有任何 scope 声明」 | 识别 `read-all` / `write-all` |
| `permissions: {contents: read}`（内联映射） | 报「没有任何 scope 声明」 | 以 `{` 开头视为已声明 |
| `on: [push, pull_request]`（内联数组） | 报「没有任何触发事件」 | `on:` 行非空即计入触发器 |

**补漏报（新增 4 类判定）**：

| # | 新判定 | 为什么本地看不出 |
|---|---|---|
| 10 | 第三方 action 用 `@main` / `@master` 等**浮动分支** | 上游一次 push 就换掉你 CI 里执行的全部代码，本仓库**零 diff 痕迹** |
| 11 | job 有 `runs-on:` 却**无 `steps:`** | GitHub 直接解析失败，只有推送后才暴露 |
| 12 | **顶层 key 重复**（原只查 `jobs`） | YAML 后者**静默覆盖**前者，如两个 `on:` 让第一段触发条件整段失效 |
| 13 | `needs:` 指向**不存在的 job** | 该 job 永远停在 pending，workflow 卡死 |

**关键设计约束**：浮动分支检测用**明确 denylist**（`main`/`master`/`head`/`latest`/
`develop`/`trunk`/`default`），**不能**一刀切禁止「所有非版本号引用」——
`dtolnay/rust-toolchain@stable` 是该 action 的官方推荐写法（`@stable`/`@beta`/`@nightly`
是它受支持的「工具链通道」），本仓库多个 workflow 正用着它。

`needs:` 只收集**内联**写法（`needs: x` / `needs: [a, b]`），块列表写法
（`needs:` 换行 + `- x`）在逐行解析器里不易区分，且含 `${{ }}` 表达式的取值一律跳过
——**宁漏不误报**。

### B5. `server.py::ensure_schema` 清单完备 + 旧布局显式拒绝

`SELECT_COLS`（`server.py:72-78`）要读 28 列，而 `ensure_schema` 的 ALTER 清单**只有
10 条**，缺 `assignees` / `mentioned` / `latest_comment_url` / `pr_number` / `pr_url` /
`work_dir` / `created_at` 等 7 列。症状只出现在**「Python MCP 首次打开一个尚未被 App
迁移过的旧库」**这一条路径上：`no such column: xxx`——App 自身完全正常，
两侧测试也都测不到（`check-mcp-columns.py` 当时只比对 `SELECT_COLS` 字符串，
管不到 ALTER 清单）。这是 **#169 → #262 → #278 同源**的老坑。

两项修改：

1. 用 `ENSURE_COLUMNS`（列名, DDL）元组替换裸 SQL 列表，覆盖**全部** 28 列 +
   按需拉取 / 写入路径会碰的 `author`/`labels`/`done_at`/`comments_count`/`stale`；
2. `check-mcp-columns.py` 新增第 5 条断言：**`ENSURE_COLUMNS ⊇ SELECT_COLS`**。
   以后再往 `SELECT_COLS` 加列而漏改这里，PR 阶段就会红。

**旧布局显式拒绝**：`ensure_schema` 开头先探测 `LEGACY_TASKS_COLUMNS = ("key",
"gh_state", "gh_status")`。命中即 `RuntimeError` 并给可操作提示「请先启动一次
TaskBoard App 完成迁移」——Python MCP **不做**表重建。原行为是「先补一堆列，再以
`no such column: issue_key` 报错」，把「schema 太旧」误报成「列名不存在」。
`tasks` 表不存在时同样给出「请先运行一次 App」的明确提示。

### B6. `handoff_len` 统一为字符数

`mcp.rs::tool_record_handoff` 返回 `text.len()`（UTF-8 **字节**数），而
`server.py::tool_record_handoff` 返回 `len(text)`（码点）。同一份中文 handoff，
Rust 侧报 `6`、Python 侧报 `2`——agent 按长度做校验 / 截断会得到互相矛盾的结论。

修复：Rust 改 `text.chars().count()`，与 Python 侧一致。

### C7. `open_db` 稳态零写：`user_version` 门控 + 只读自愈探测

`open_db` 被 `lib.rs` / `commands.rs`（2 处）/ `mcp.rs` 反复调用，**每次建连都执行
写语句**：`DELETE FROM notes`（去重）、6 条 `INSERT meta`、十余条 `ALTER TABLE`。
同步侧 `sync.rs` 把 stale 标记 + 全量 upsert 包成**一个**事务并持锁，期间跑在 Tauri
主线程的命令会在 `busy_timeout=5000` 上等待 ⇒ **最长 5 秒 beachball**。

改为三层门控（`SCHEMA_VERSION: i64 = 3`）：

```
fresh            = !table_exists(conn, "tasks")
needs_migration  = !fresh && !schema_is_current(conn)
if fresh || needs_migration { run_migrations(...) }
```

`schema_is_current` 是一项**只读自愈探测**：`PRAGMA table_info` 缓存后比对
`REQUIRED_COLUMNS` / `REQUIRED_INDEXES`，并检查 `tasks` 是否仍用 legacy key。
只读语句（`PRAGMA` / `sqlite_master` / `SELECT`）**永不阻塞**（已实测），因此
**稳态下 `open_db` 不取写锁**。

三项配套：

- **`notes` 去重挪进一次性迁移**（原先每次建连都跑 `DELETE`）；
- **`ensure_default_settings`** 改只读比对（只补缺失 key，不覆盖用户值）；
- **`user_version` 门控 + 只读探测并存**：既走 `user_version` 快路径，又用探测兜底
  「版本号已推进但列 / 索引被删」的自愈场景——只靠版本号会漏掉人工损坏的库。

> **踩坑记录**：`idx_tasks_issue_key` **不在 `SCHEMA` 里**（legacy-safe：旧库无
> `issue_key` 列，顶层 `CREATE INDEX` 会让整批 DDL 中止），只能由迁移路径创建。
> 因此首版实现里 **fresh 库永不建该索引** ⇒ `schema_is_current` 恒 `false` ⇒
> **每次建连都重跑迁移**，单测耗时 10.7s（≈2×`busy_timeout`）。修法是
> `if fresh || needs_migration`——**fresh 库也必须跑一次 `MIGRATION_DDL`**。
> 修复后该套件 0.07s。

### C8. 重活移出 Tauri 主线程

`list_tasks` / `scan_agent_hosts` / `export_notes` / `import_notes`
（`commands.rs`）与 `get_agent_hooks_status`（`hooks.rs`）都是**同步** `fn`，
Tauri 2 **在主线程执行**。其中：

- `rows_to_tasks` 全表扫描并逐行反序列化 JSON 父子关系（无 `LIMIT`）；
- `probe_agent_hosts` 遍历 `/Applications` / `~/Applications` 与 PATH 全部目录做
  `is_file()`，冷 FS 上可达数百毫秒。

5 个命令统一改 `async fn` + `tauri::async_runtime::spawn_blocking`（与 `sync_now`
同款），DB 句柄与参数 `move` 进闭包。`get_agent_hooks_status` 抽出同步实现
`agent_hooks_status_blocking`，`async` 包装仅负责调度。

### D9. 任务唯一键跨账号唯一（`taskIdentity`）

后端唯一键是 `UNIQUE(repo, number, account_id)`，而前端用 `issueKey` 做 React key /
选中标识。**聚合视图**（`ownership="all"`）下同一 issue 来自两个账号会渲染成两行，
`issueKey` 相同 ⇒ React key 重复（渲染错乱）、`selected` 命中**第一个**（详情选错）、
指纹 `taskSig` 相同（diff 失真）。

新增纯函数与集中接线：

```ts
export const taskIdentity = (task: Task) => `${task.issueKey}@${task.accountId}`;
```

`Board.tsx` 4 处 `TaskCard` 的 `key` + `active`、`App.tsx` 的 `selectedTask`
查找 + `DetailPanel` 的 `key`、`SessionsPanel` 的 key 全部改用 `taskIdentity`；
`taskSig.ts` 指纹行在 `issueKey` 之后补 `accountId`。

### D10. Esc 分层仲裁（`escLayer`）

`ConfirmDialog` 与 `DetailPanel` / `SyncLogsPanel` 各自监听 Esc，一次按键**同时**
关闭确认框与整块面板。新增「后注册者为栈顶」的仲裁层：

```ts
// utils/escLayer.ts —— token 用 Symbol，isTop 比较栈顶身份而非计数
export function registerEscLayer(): EscLayer; // { isTop(), release() }
// utils/useEscLayer.ts —— 组件挂载即注册，卸载即释放
export const useEscLayer = () => () => layer.current?.isTop() ?? true;
```

各面板的 `onKeyDown` 一律先判 `isEscTop()` / `isTop()` 再响应。`SettingsPanel` /
`AccountsPanel` / `AboutPanel` / `App`（更新提示弹窗抽成独立 `UpdatePrompt`，
仅挂载时注册）全部纳入。用 `Symbol` 而非计数器，使 React StrictMode 的双调用
与乱序卸载都安全。

### D11–D18. 前端杂项

| # | 修复 |
|---|---|
| 11 | `SessionsPanel.handleCopy` 改 `await` + `try/catch`；定时器提到 `useRef`，卸载时 `clearTimeout`（照抄 `DetailPanel.copiedTimer`） |
| 12 | `App.tsx` 启动拉取 quarantine 提示补 `.catch(reportError)`（消除未处理拒绝 + 静默） |
| 13 | `AgentPanel` 把实时 `targetDir` 与已提交 `committedTargetDir` 分离：输入框不再进查询依赖，改失焦 / 回车提交；`refreshHooksStatus` 只读已提交值 |
| 14 | `NotesPanel` 用 `loadedOnce` ref 区分首屏 `loading` 与后台 `refreshing`；右栏四列用 `aria-busy` 降透明而非整块替换成占位 |
| 15 | `SettingsPanel` 的 effect 依赖由 `[settings.accounts]` 改稳定指纹 `accounts.map(a=>a.id).join(',')`，避免每次 `setSettings` 重置未保存的列编辑草稿 |
| 16 | `App.clearAllFilters` 改 `await loadWith('', accountFilter)`，让清筛选走同一个查询合并器（消除与并发 load 的竞态，最长 20s 自愈） |
| 17 | `styles.css`：`--text-secondary`（未定义）→ `--text-2`；`:root` 补 `--font-mono` 定义 |
| 18 | `theme.ts` 监听句柄提到模块级；`setMode('auto')` 先 `unbindSystemThemeListener` 再 `bindSystemThemeListener`（防重复注册 / 泄漏） |

## 接口 / 行为变更

| 项 | 变更 | 影响面 |
|---|---|---|
| A1 | `Closes #1 #2 #3` 现提取 `[1, 2, 3]` | merge-cleanup workflow 会关掉此前被漏掉的中间 issue |
| A2 | 含 `latest` 等子串的标题不再误判为验证 PR | 分支不再堆积 |
| A3 | `read-all` / `on: [a,b]` 等 3 类合法写法不再误报 | 不影响真实 workflow |
| A4 | 新增 4 类漏报检查 | 本仓库现有 workflow 全部通过（正向回归） |
| B5 | `ENSURE_COLUMNS ⊇ SELECT_COLS` 成为门禁；旧布局显式拒绝 | Python MCP 首次打开旧库不再 `no such column` |
| B6 | **`handoff_len` 语义由字节改为字符** | agent 侧长度结论一致（**对外可见契约变更**） |
| C7 | `open_db` 稳态零写；`notes` 去重进一次性迁移 | 消除 UI 最长 5s 卡顿 |
| C8 | 5 个 GUI 命令改 `async` | 前端调用方式不变（命令名 / 参数 / 返回体不变） |
| D9 | 前端任务标识由 `issueKey` 改为 `issueKey@accountId` | 仅前端内部；聚合视图渲染 / 详情选中修正 |
| D10 | Esc 一次只关最上层 | 交互修正 |
| D17 | 会话卡片样式由「未定义变量」变为生效 | 视觉修正（此前静默失效） |

- **无 Tauri command 签名变更**（仅内部执行线程从主线程改为 `spawn_blocking` 池）。
- **无 MCP 工具增删**；`handoff_len` 数值语义变更是本批唯一对外契约变动。
- **无 i18n key 变更**（389 keys 不变）。
- **无 SQLite 列 / 表结构变更**（见下）。

## 数据 / Schema 变更

**无列 / 表结构变更。** 与 schema 相关的改动全部是「**何时 / 如何**跑迁移」：

- 新增 `PRAGMA user_version` 门控（`SCHEMA_VERSION = 3`）与只读自愈探测；
- `notes` 去重 `DELETE` 从事务外（每次建连）移进一次性迁移；
- `PROJECT_ITEMS_DDL` 从 `SCHEMA` 拆到迁移路径（与 `idx_tasks_issue_key` 同理，
  避免对 legacy 库执行会失败的 DDL）。

`tasks` 列仍是 28 列，`scripts/check-mcp-columns.py` 校验不受影响（且本批为其新增了
第 5 条 `ENSURE_COLUMNS` 断言）。

## 测试 / 验收

新增 / 变更测试：前端 **+39**（155 → 194）覆盖 18 个文件；Rust `+12`（129 → 141）；
`scripts` Python 单测新增 6 例；`mcp_server/test_server.py` 新增 4 例。

逐项通过**反向验证**（把修复改回缺陷写法，测试必然失败）：

| 反向操作 | 结果 |
|---|---|
| `CLOSE_RE` 改回可重复捕获组 | ✅ `test_three_refs_after_one_keyword_keeps_the_middle_one` 失败 |
| `SKIP_DELETE_MARKERS` 改回子串 `in` | ✅ `test_skip_delete_markers_use_word_boundary` 失败 |
| `permissions: read-all` 改回不识别 | ✅ `test_permissions_read_all_shorthand_is_legal` 失败 |
| `on:` 内联数组改回不识别 | ✅ `test_on_inline_array_is_legal` 失败 |
| 去掉浮动分支判定 | ✅ `test_floating_branch_ref_is_flagged` 失败 |
| 去掉「有 runs-on 无 steps」判定 | ✅ `test_runs_on_without_steps_is_flagged` 失败 |
| 重复 key 判定只查 `jobs` | ✅ `test_duplicate_top_level_key_is_flagged` 失败 |
| 去掉 `needs` 指向校验 | ✅ `test_needs_unknown_job_is_flagged` 失败 |
| `ensure_schema` 改回 10 列清单 | ✅ `test_completes_every_select_col` 失败 |
| 旧布局不探测 | ✅ `test_legacy_layout_is_rejected_with_actionable_message` 失败 |
| `handoff_len` 改回 `text.len()` | ✅ `handoff_len_counts_characters_not_bytes` 失败（「交接」报 6 而非 2） |
| 强制 `needs_migration = !fresh` | ✅ `open_db_steady_state_does_not_take_write_lock` 失败（5.35s 超时） |
| 去掉 `missing_columns` 探测 | ✅ `open_db_self_heals_missing_column_despite_newer_version` 失败（列出 5 个缺列） |
| 去掉 `missing_indexes` 探测 | ✅ `open_db_self_heals_missing_index_despite_newer_version` 失败 |
| `escLayer.isTop` 恒 `true` | ✅ `escLayer.test.ts` 5 例 + `panel-wiring` 断言失败 |
| `theme.ts` 去掉 `unbind` | ✅ `theme.test.ts` 失败 |
| `styles.css` 改回 `--text-secondary` | ✅ `styles.test.ts` 变量完备性断言失败 |
| `Board.tsx` key 改回 `task.issueKey` | ✅ `panel-wiring` / `taskIdentity` 断言失败 |

前端反向验证：同时改回上述 4 处（`escLayer` / `theme` / `styles` / `Board`），
**8 个测试失败**；还原后 194 全绿。

全量校验：

```
npx tsc --noEmit                                 0 error ✅
npm run build                                    ✅
npm test                                         194 passed（+39）✅
npm run i18n:check                               389 keys ✅
npm run lint                                     16 warnings（0 error）✅
npx prettier --check "src/**/*.{ts,tsx,css}"     ✅
cargo clippy --lib -p taskboard -- -D warnings   ✅
cargo test --lib -p taskboard                    141 passed（+12）✅
python3 scripts/check-doc-links.py               162 文件 ✅
python3 scripts/check-mcp-columns.py             28 列 + ensure 覆盖 33 列 ✅
python3 scripts/check-workflow-yaml.py           6 文件 ✅
python3 -m unittest discover -s scripts -p 'test_*.py'   86 tests OK ✅
```

> 注：仓库整体**尚未** `cargo fmt` 化（`cargo fmt --check` 在 `main` 上本就有大量差异），
> 故本批不做全量格式化——那是 P3 批次（#330）的独立事项，混入会淹没本次 diff。

## 相关链接

- 来源审计：[`CODE-REVIEW-2026-09-30.md`](../CODE-REVIEW-2026-09-30.md)
- 上游批次：[`docs/issue-327-p0-functional-defects.md`](./issue-327-p0-functional-defects.md)（#327 / PR #331）、
  [`docs/issue-328-p1-data-safety.md`](./issue-328-p1-data-safety.md)（#328 / PR #332）
- GitHub issue：[#329](https://github.com/ShawnLiuSZ/task-dashboard/issues/329)（本批 PR [#333](https://github.com/ShawnLiuSZ/task-dashboard/pull/333)）
- 关联历史教训：
  [#155 表重建](https://github.com/ShawnLiuSZ/task-dashboard/issues/155)、
  [#169 MCP 列同步](./issue-169-mcp-server-schema-sync.md)、
  [#175 重建丢列](./issue-175-work-branch-migration-gap.md)、
  [#262 多账号同步](./issue-262-multi-account-sync.md)、
  [#278 父子关系同步](./issue-278-issue-links.md)
- CHANGELOG：[`docs/CHANGELOG.md`](./CHANGELOG.md) / [`docs/CHANGELOG.en.md`](./CHANGELOG.en.md)

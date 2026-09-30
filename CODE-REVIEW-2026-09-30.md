# TaskBoard 深度代码审查报告

> 日期：2026-09-30 · 基线：`main` @ `f66f83f`（v0.6.5）
> 范围：Rust 后端（`app/src-tauri/src`，11 文件 ~1.37 万行）、React 前端（`app/src`）、Python MCP（`mcp_server`）、校验脚本与 CI（`scripts`、`.github/workflows`）
> 方法：全量通读 + 合成用例实测校验脚本 + 逐项独立复核关键结论（下表「复核」列标注是否已本地实测）

---

## 0. 结论速览

| 级别 | 数量 | 说明 |
| --- | --- | --- |
| 🔴 P0 功能缺陷 | 3 | 已发布版本中用户可感知的功能失效/不可用 |
| 🟠 P1 数据与健壮性 | 9 | 可能丢数据、卡死进程、静默失败或误判 |
| 🟡 P2 一致性与工程质量 | 8 | 逻辑不一致、脚本漏报误报、性能退化 |
| 🔵 P3 规范与文档 | 7 | 版本/文档漂移、CI 配置、阈值余量 |

**最该先处理的三件事**：P0-1（About 按钮失效，v0.6.5 刚发的功能actually坏的）、P0-2（语言切换器丢失）、P0-3（记事内容重复必报错）。

---

## 1. 🔴 P0 — 功能缺陷（用户可直接感知）

### P0-1 About 小窗「确定」按钮点不动（#325 功能实际失效）

- **位置**：`app/src-tauri/capabilities/default.json:5` · `app/src/components/AboutWindow.tsx:56`
- **现象**：点击「确定」无任何反应，只能用窗口红叉关闭。
- **根因（双重）**：
  1. 唯一 capability 的 `windows` 为 `["main"]`，而 #325 新增的 `about` 是独立 webview（`tauri.conf.json` label=`about`）→ **不匹配任何 capability，零 IPC 权限**；
  2. 即便补上 `core:default`，其展开的 `core:window:default`（实测 28 项）**不含 `allow-close`**（已解析 `gen/schemas/acl-manifests.json` 确认）。
- **复核**：✅ 已实测。`gen/schemas/capabilities.json` 内容为 `{"windows":["main"],"permissions":["core:default","core:window:allow-show","core:window:allow-hide"]}`；`core:window` default 全集 28 项无 `allow-close`。
- **附加问题**：同一 capability 里给 `main` 授的 `allow-show`/`allow-hide` **前端从未调用**（全仓只有 `.label` 与 `.close()` 两处）→「该授的没授、授了的没用」。
- **现有测试为何漏过**：`about-window.test.ts:55` 只做源码字符串断言 `toContain('getCurrentWindow().close()')`，不校验权限。
- **修复建议**：新增 `capabilities/about.json`（`windows:["about"]`，权限加 `core:window:allow-close`），删除 main 上无用的 show/hide；补一条「权限文件 ↔ 前端 window API 调用」一致性测试。

### P0-2 设置面板「界面语言」切换器丢失，主题选择器被渲染两遍

- **位置**：`app/src/components/SettingsPanel.tsx:371-397`
- **现象**：基础设置里连续出现**两个完全相同**的「外观主题」下拉框（同 value、同 onChange、同选项）；语言切换入口消失，用户无法切换中英文。
- **证据链**：
  - `SettingsPanel.tsx:373-384` 与 `386-397` 两块 JSX 逐字符相同；
  - `i18n/index.tsx` 导出的 `mode` / `setMode`（第 44、56、85 行）在**全 `app/src` 无任何引用**（已 grep 确认，`useI18n()` 消费方从不取这两个字段）；
  - locale 中紧邻主题键的 `settings.language` / `settings.langAuto` / `settings.langZh` / `settings.langEn` 四个 key 在两个 locale 都存在但**零引用**。
- **复核**：✅ 已实测源码与 grep。
- **推断**：这里原本应是语言选择器，被误复制成第二个主题选择器。
- **修复建议**：第二块改为语言选择器 `value={mode}` / `onChange={(e) => setMode(e.target.value as LangMode)}`，选项用上述 4 个 key。

### P0-3 记事内容重复时新增/编辑直接报原始 SQLite 错误

- **位置**：`app/src-tauri/src/db.rs:201`（索引）、`2110-2126`（`add_note`）、`2129-2153`（`update_note`）
- **现象**：新增一条与已有记事**内容相同**的记事，或把某条记事内容改成与另一条相同，UI 与 MCP 返回体里直接出现 `插入记事失败: UNIQUE constraint failed: notes.content`。
- **根因**：`CREATE UNIQUE INDEX IF NOT EXISTS idx_notes_content ON notes(content)` 生效中，而 `add_note`/`update_note` 直接 `INSERT`/`UPDATE`，未捕获约束冲突；对照 `db.rs:2289-2312` 的 `import_note` 是「先查重再跳过」的正确写法。
- **复核**：✅ 已实测索引存在于 `SCHEMA`（生产库生效，非仅测试）。
- **触发场景**：复制一条记事改标签、或把草稿合并进已有内容 —— 都是自然操作。
- **修复建议**：捕获 `SqliteFailure(..) extended_code == 2067`，返回「已存在相同内容的记事」；或在应用层先查重。

---

## 2. 🟠 P1 — 数据安全与健壮性

### P1-1 `migrate_tasks_v2_rebuild` 自称「单事务」实则无事务，失败可丢数据或永久卡死

- **位置**：`app/src-tauri/src/db.rs:513-580`（注释第 506 行写"单事务"）
- **问题**：`conn.execute_batch(r#"..."#)` **不自动开启事务**（rusqlite 0.31 为逐条 `step`），SQL 内无 `BEGIN`。于是 `DROP TABLE tasks` 与 `ALTER TABLE tasks_new RENAME` 是两次独立提交：
  - 两步之间进程被 kill/断电 → `tasks` 消失、数据滞留 `tasks_new`；下次启动 `CREATE TABLE IF NOT EXISTS tasks` 重建**空表**，用户本地态（`status`/`session_*`/`handoff`/`work_branch`/`work_dir`）永久丢失；
  - `CREATE TABLE tasks_new` **无 `IF NOT EXISTS`**：若 `INSERT..SELECT` 撞 `UNIQUE(repo,number,account_id)` 失败会留下 `tasks_new`，此后每次 `open_db` 首条语句即失败 → `db.rs:309-313` 的 `.is_ok()` 把 `needs_v2` 置 false → `user_version` 永不推进 → 后续所有查询 `no such column: issue_key`，且仅 `tlog!`（默认静默）可见，**无自愈路径**。
- **复核**：✅ 已读源码确认无 BEGIN/COMMIT、无 IF NOT EXISTS。
- **修复建议**：整段包 `BEGIN IMMEDIATE; ... COMMIT;`；`CREATE TABLE IF NOT EXISTS tasks_new` + 开头 `DROP TABLE IF EXISTS tasks_new` 自愈；`user_version` 写入放进同一事务。

### P1-2 MCP 解析到一行坏 JSON 就整个进程退出

- **位置**：`app/src-tauri/src/mcp.rs:759-765`（NDJSON）、`789-797`（Content-Length）、`841-846`（主循环）
- **问题**：`read_message` 用 `None` **同时表示 EOF 和「这一行畸形」**；主循环 `while let Some(..) = read_message(..)` 因此直接跳出、`run()` 返回、stdio 断开。而日志文案写的是「跳过该行」，**注释与行为不符**。Content-Length 分支同理（`content_length?` 解析失败即 `None`）。
- **触发场景**：客户端发 UTF-8 BOM、写入被截断、多发一个畸形行 → agent 侧看到随机 `connection closed`。
- **复核**：✅ 已读源码确认。
- **修复建议**：返回值改 `Option<Result<..>>`，或解析失败时 `continue` 读下一行，仅 EOF 返回 `None`。

### P1-3 MCP `Content-Length` 无上界校验 → 超大值触发进程 abort

- **位置**：`app/src-tauri/src/mcp.rs:789-794`
- **问题**：`let mut body = vec![0u8; len]`，`len` 直接来自客户端文本且无上限。`Content-Length: 99999999999` 会让 Rust 分配失败 **abort（不可捕获 panic）**，进程直接死。头部逐字节读取同样无上限。
- **修复建议**：`if len == 0 || len > 8 * 1024 * 1024 { return None; }`，头部字节数加上限。

### P1-4 同步全部失败仍返回 `Ok`，顺手清掉错误横幅

- **位置**：`app/src-tauri/src/sync.rs:897-960`、`app/src-tauri/src/lib.rs:348-359`
- **问题**：所有账号均因 PAT 失效/网络失败而 `continue` 时，`run` 仍返回 `Ok(SyncResult{..})` → `lib.rs:349-352` 把 `last_sync_error` 清空、`last_sync_at` 照常推进、`SYNCED_EVENT` 照常广播。用户看到的是「同步成功」，实际一条都没拉到。此外 `sync.rs:928-935` 之后任一 `?` 失败会让本次 `sync_logs` 行永久停留在 `status='running'`。
- **修复建议**：全部目标失败时返回 `Err`；`last_sync_at`/`last_sync_error` 的写入移到失败也能覆盖的分支。

### P1-5 `graphql()` 完全无限流处理与重试 → 项目状态/父子关系静默降级

- **位置**：`app/src-tauri/src/github.rs:1419-1493`（对比 `get_impl` 的 `1197-1335` 有完整 `Retry-After`/`X-RateLimit-*` 处理）
- **问题**：`graphql()` 只判 `!status.is_success()` 即 `Err`。GraphQL 独立配额超限时返回 403 + `Retry-After`，导致 `fetch_all_projects` / `status_field` / `fetch_project_issues` / `fetch_issue_links` 在限流窗口内全部失败；调用方是 best-effort，于是**静默降级**：Project Status 全空、父子关系不更新，用户看到「同步成功但状态一直不对」。另 `fetch_issue_links` 里单个编号失效会让整块 25 个 issue 的关系全丢（`github.rs:36-44` 注释已承认）。
- **修复建议**：抽出与 `get_impl` 共用的限流等待逻辑；`fetch_issue_links` 对 `NOT_FOUND` 做 chunk 内降级而不是整块失败。

### P1-6 GUI 写命令吞掉「0 行受影响」，不存在的任务静默成功

- **位置**：`app/src-tauri/src/commands.rs:297`（`update_task_status`）、`318-326`（`record_session`）
- **问题**：`common::set_task_status` / `common::touch_session` 返回 `usize`（0 = key 不存在），MCP 侧据此报错（`mcp.rs:247-249`），而 GUI 侧直接丢弃。前端传已不存在的 `issueKey`（如同步后已被 prune）会收到 `Ok`，UI 显示成功但什么都没改。同文件 `set_work_branch`（`354-357`）**做了**该判断 —— 属内部不一致。
- **修复建议**：两处补 `if n == 0 { return Err(..) }`。

### P1-7 查询错误被吞成「任务不在任何 Project 中」

- **位置**：`app/src-tauri/src/db.rs:1155-1166`、`1190-1198`
- **问题**：`resolve_project_write_target` / `project_option_id` 用 `.map(Some).unwrap_or(None)` 把**所有** DB 错误（含 `no such table`、类型不符）折叠成"没找到"。`set_project_status` 的排障路径会因此把真实 schema/IO 故障报告成「任务 xxx 不在任何 Project 中（或同步尚未拉取条目 id）」，把用户引向「再同步一次」的无效操作。
- **修复建议**：只把 `QueryReturnedNoRows` 映射为 `None`，其余错误带原文上抛。

### P1-8 全部 403 都当限流，权限/SSO 错误要白等最多 90 秒

- **位置**：`app/src-tauri/src/github.rs:1242-1259`（`search()` `1363-1389` 同款）
- **问题**：GitHub 的 403 既表示限流，也表示「token 无权限 / SSO 未授权 / 组织策略」。读路径不做区分，缺权限时每次请求白睡 10s，重试 3 次共 30s；若 `X-RateLimit-Reset` 指向 1 小时后，`min(30s)` 仍连睡 3 次。`fetch_prs_for_repo` 多仓库多页累计可达分钟级。另 `search()` 限流分支**漏掉** `if items.len() < 100 { break; }`，比正常路径多打一次必然为空的请求。
- **修复建议**：403 时先看 `X-RateLimit-Remaining == 0` 或存在 `Retry-After` 才当限流，否则立即返回带权限指引的错误；补分页终止条件。

### P1-9 `search()` 单条 item 解析失败拖垮整个数据源

- **位置**：`app/src-tauri/src/github.rs:1386`、`1398`
- **问题**：`for item in &items { all.push(RawTask::from_item(item)?); }` —— 一条缺字段的坏 item 让整个 `search()` 失败，该源进 `failed`，同源其它几百条正常数据一起丢。对照 `fetch_prs_for_repo`（`748-754`）是逐条 `filter_map` 跳过坏数据，两处对同类问题处理不一致。
- **修复建议**：与 `fetch_prs` 对齐，改为 `match { Ok => push, Err => tlog! }`。

---

## 3. 🟡 P2 — 一致性与工程质量

### P2-1 `merge-cleanup.py` 的 `CLOSE_RE` 丢中间 issue 编号

- **位置**：`scripts/merge-cleanup.py:46-53`
- **实测**：`extract_issue_refs('t','Closes #1 #2 #3')` → `[1, 3]`（**#2 丢失**）；`'fixes #10 #20 #30'` → `[10, 30]`。根因是可重复捕获组 `(?:\s*#\s*(\d+)(?!\d))*` 只保留最后一次迭代。现有单测 `test_merge_cleanup.py:84` 只测 2 个编号，恰好落在"碰巧正确"区间。
- **复核**：✅ 已本地实测复现。
- **修复建议**：对关键词片段用 `re.findall(r"#\s*(\d+)", m.group(0))` 收集；补三编号用例。

### P2-2 `merge-cleanup.py` 的 `SKIP_DELETE_MARKERS` 子串匹配误伤

- **位置**：`scripts/merge-cleanup.py:56`、`261`（`SKIP_DELETE_MARKERS = ('test','draft')`）
- **实测**：`'test' in 'chore: bump to latest deps'` → `True`。任何标题含 `latest`/`contest`/`protest`/`attest` 的 PR 都被判为"验证用 PR"而**跳过删分支**，分支静默堆积。
- **复核**：✅ 已本地实测复现。
- **修复建议**：改词边界匹配 `re.search(r"\b(test|draft)\b", title, re.I)`，或改用显式标记 `[skip-cleanup]`。

### P2-3 `check-workflow-yaml.py` 误报：合法的 `permissions: read-all` 被判错

- **位置**：`scripts/check-workflow-yaml.py:285-288`
- **实测**：顶层 `permissions: read-all`（GitHub 官方简写）→ 报 `permissions: 下没有任何 scope 声明（等于没配，退回仓库默认权限）`。
- **复核**：✅ 已本地实测复现。另外 `on: [push, pull_request]`（合法内联数组）也被误报为"`on:` 下没有任何触发事件"。
- **修复建议**：识别 `read-all|write-all`；`on:` 行 `rest` 以 `[` 开头时视为有触发器。

### P2-4 `check-workflow-yaml.py` 漏报面（该拦不拦）

- **位置**：`scripts/check-workflow-yaml.py:179-185`、`293`
- **实测未报**：① job 有 `runs-on` 但**无 `steps`**（GitHub 解析失败）；② `uses: actions/checkout@main`（浮动分支，供应链风险）；③ 重复顶层 key；④ `needs: [不存在的 job]`。
- **复核**：✅ 已本地实测（①④ 返回 `[]`）。
- **修复建议**：增加「job 至少含 steps」「禁止 action 版本为分支名」「顶层 key 去重」「needs 指向已定义 job」四类检查。

### P2-5 `server.py::ensure_schema` 与 `db.rs` 迁移不同步 → 老库上 MCP 读路径 `no such column`

- **位置**：`mcp_server/server.py:143-162`（ALTER 清单仅 10 条）vs `app/src-tauri/src/db.rs:397-450`、`466-495`
- **问题**：`SELECT_COLS`（`server.py:72-78`）要读 `url, issue_state, assignees, mentioned, latest_comment_url, pr_number, pr_url, work_dir, created_at`，但 `ensure_schema` **缺** `work_dir`、`created_at`、`assignees`、`mentioned`、`latest_comment_url`、`pr_number`、`pr_url`。且 Python 侧**完全没有** `migrate_tasks_v2_rebuild` 的等价实现（`key→issue_key`、`gh_state→issue_state` 等）。docstring 却声称「即使 App 尚未启动过也能直接读写既有数据库」。对 v0.3.x 老库执行 `SELECT {SELECT_COLS} FROM tasks` 会直接抛错。
- **复核**：✅ 已读两侧源码确认 ALTER 清单缺列。
- **为何 CI 兜不住**：`scripts/check-mcp-columns.py:106-127` 只比 `SELECT_COLS` 字符串，不校验 `ensure_schema` 的 ALTER 清单。
- **修复建议**：`ensure_schema` ALTER 清单与 `db.rs` 逐项对齐；探测到旧列（`key`/`gh_state`）时明确报错要求先跑一次 App；给 `check-mcp-columns.py` 增加「ALTER 集合 ⊇ SELECT_COLS 所需列」断言。

### P2-6 `handoff_len` 两侧语义不一致（字节数 vs 字符数）

- **位置**：`app/src-tauri/src/mcp.rs:359`（`text.len()` = UTF-8 字节）vs `mcp_server/server.py:625`（`len(text)` = 码点）
- **问题**：同一份中文 handoff，Rust 返回 6、Python 返回 2。agent 若按长度校验/截断会得到不一致结论。
- **复核**：✅ 已读两侧源码确认。
- **修复建议**：统一为字符数（Rust 改 `text.chars().count()`），并加读路径回归断言。

### P2-7 `open_db` 每次建连都执行写语句，与同步长事务叠加卡 UI

- **位置**：`app/src-tauri/src/db.rs:287-290`（`DELETE FROM notes`）、`318-324`（6 条 `INSERT meta`）、`397-450`（十余条 ALTER）
- **问题**：`open_db` 被 `lib.rs:312`、`commands.rs:275`、`commands.rs:520`、`mcp.rs:824` 反复调用，每次都要拿写锁。同步侧 `sync.rs:776-796` 把 stale 标记 + 全量 upsert 包成**一个**事务并持锁，期间跑在 Tauri 主线程的同步命令会在 `busy_timeout=5000`（`db.rs:283`）上等待 → 最长 5 秒 beachball。
- **修复建议**：schema/迁移由 `user_version` 门控（同进程只跑一次）；`notes` 去重挪进一次性迁移；同步事务分片提交（如每 200 行 commit）。

### P2-8 重活跑在 Tauri 主线程

- **位置**：`commands.rs:249-259`（`list_tasks`）、`2010`（`scan_agent_hosts`）、`1846`/`1914`（`export_notes`/`import_notes`）、`hooks.rs:1649`（`get_agent_hooks_status`）
- **问题**：这些是 sync `fn`，Tauri 2 在主线程执行。`rows_to_tasks`（`180-237`）无 `LIMIT` 全表扫描并逐行 `serde_json` 反序列化父子关系；`probe_agent_hosts` 遍历 `/Applications`、`~/Applications` 与 PATH 全部目录做 `is_file()`，冷 FS 上可达数百毫秒。
- **修复建议**：改 `async fn` + `spawn_blocking`（与 `sync_now` 同款）；`list_tasks` 加 `LIMIT` 或父子关系懒加载。

---

## 4. 🔵 P3 — 规范、文档与 CI

| # | 问题 | 位置 | 复核 |
| --- | --- | --- | --- |
| P3-1 | **`package-lock.json` 版本漂到 `0.4.0`**（落后 2 个大版本）；且**无任何版本一致性校验脚本/CI**，纯人工同步已漂移 | `app/package-lock.json:3,9`（实际 4 处源码 version 均为 `0.6.5`：`package.json`/`Cargo.toml`/`tauri.conf.json`/`Cargo.lock`） | ✅ 已实测 |
| P3-2 | **README 版本号过期**：中文尾注 `v0.6.4`、英文尾注 `v0.6.0`，两处 CHANGELOG 描述还写「最新 v0.6.0」 | `README.md:177,235` · `README.en.md:171,186` | ✅ 已实测 |
| P3-3 | **15 篇孤岛文档**：既不在 README 也不在 CHANGELOG，违反 `AGENTS.md §5.5`，且无反链校验（`check-doc-links.py` 只查正向链接有效性） | `docs/issue-191-*.md`、`issue-193-*.md`、`issue-197-*.md`、`issue-204-*.md`、`issue-207-*.md`、`issue-212-*.md`、`issue-216-*.md`、`issue-220-*.md`、`issue-221-*.md`、`issue-224-*.md`、`issue-226-*.md`、`issue-258-*.md`、`issue-276-*.md`、`issue-62-*.md`、`v0.3.16-multi-account.md` | 代理统计 |
| P3-4 | **ESLint `--max-warnings 20` 仅剩 2 条余量**（现 18 条），任何合理新增都会让 CI 红且与真实缺陷无关 | `app/package.json:14` | 代理实测 18 |
| P3-5 | **CI 不跑 `vite build` 与 `cargo fmt --check`**；action 版本 v4/v5 混杂（`quality-check.yml` 仍 `checkout@v4`/`setup-node@v4`，其余已 v5） | `.github/workflows/quality-check.yml:14,40,43,65,91,94,104-110` | 已读配置 |
| P3-6 | **6 个 workflow 无 `timeout-minutes`/`concurrency`**；4 个只读 workflow 未声明 `permissions`（沿用仓库默认权限） | `release.yml:19-50` 等 | 已读配置 |
| P3-7 | **`check-i18n.mjs` 硬编码两语种**，README 却宣传可加新语言 → 新增语种漏检且脚本"通过" | `app/scripts/check-i18n.mjs:15` | 已读源码 |

### 附：CSP 硬化与已知技术债现状

- `tauri.conf.json` CSP 的 `connect-src` 用了 `https://*.github.com`，**不匹配裸域名 `https://github.com`**（当前前端未直连该域名，属潜伏项）；还缺 `object-src 'none'` / `base-uri 'self'`。
- `commands.rs::mem_conn()` 的并行互删问题已按 #266 修复（pid + 递增序号、不删文件），但**残留两点**：① 临时文件永不回收（macOS 不自动清 `/var/folders`），每跑一次 `cargo test` 泄漏 N 个 db/wal/shm；② pid 复用 + 进程内 `SEQ` 归零 → 极小概率打开上一轮残留库读到脏数据。`sync.rs:1083` 在连接仍存活时 `remove_file` 留下孤儿 `-wal`/`-shm`。
- `lib.rs:450` 的 `mins * 60` 对超大 `schedule_minutes`（`commands.rs:831` 只做 `.max(5)` 无上限，前端数字框可传 `4e17`）会 u64 溢出（debug 静默杀死自动同步线程 / release 环绕成随机时长）。

---

## 5. 建议处理顺序

1. **立即修（P0，发布级缺陷）**：P0-1 About 按钮 → 新增 `capabilities/about.json`；P0-2 语言选择器；P0-3 记事去重提示。
2. **本迭代修（P1）**：P1-1 迁移加事务（数据安全最高优先）、P1-2/P1-3 MCP 分帧健壮性、P1-4 同步失败上报。
3. **随功能修（P2）**：脚本误报/漏报（P2-1~P2-4，各含实测用例，适合直接转测试）、P1-5/P1-8 限流、P2-5 MCP 列对齐。
4. **排期清理（P3）**：加 `scripts/check-versions.py` 并接入 CI（一并覆盖 P3-1/P3-2）；CI 补 `vite build`/`cargo fmt`/`timeout`；文档反链与 ESLint 阈值收敛。

> 每项修复建议均配套「可执行的回归测试」：脚本类缺陷（P2-1~P2-4）已有实测用例可直接转成 `test_*.py`；权限类（P0-1）适合加「权限文件 ↔ 前端 API 调用」一致性测试；SQL 约束类（P0-3）适合加内存库单测。

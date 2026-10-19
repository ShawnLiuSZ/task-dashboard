# TaskBoard 全量代码 Bug 审查报告

> 审查日期：2026-10-19
> 审查范围：全部源码（Rust 后端 11 文件 / React 前端 58 文件 / Python MCP + scripts）
> 审查方式：三模块并行 agent 逐文件实际读取 + 交叉核对；结论先核实上次（2026-10-12）报告待核项，再做新一轮缺陷挖掘。
> 基线：`main` @ `v0.7.3`（842a129）。

## 一、结论概览

| 类别 | 数量 | 说明 |
|---|---|---|
| 高危 | 0 | 未发现数据损坏 / 安全类硬伤 |
| 中危（新发现） | 4 | 会话面板账号契约、中文状态子串匹配、workflow 检查误报、MCP 缺 Content-Length 语义分歧 |
| 低危（新发现） | 7 | 见第四节 |
| 信息项（非缺陷） | 2 | 死参数 / 多余 IPC，供决策 |
| 上次遗留待核项 | 10 → **全部已修复** | 中危-1/2/3/4、低危-1~6 经核实均已在 main 落实 |

> 历史易错面（账号维度编码、DB 列顺序/迁移、大小写判据、MCP 双实现一致性、刷新接线、字体白名单、i18n）经核查**全部已收敛并有测试守卫，无回归**。

## 二、上次审查（2026-10-12）遗留项核实 —— 全部已修复

| 原编号 | 位置 | 上次结论 | 当前核实 |
|---|---|---|---|
| 中危-1 | App.tsx 首屏聚合视图范围 | 首屏伪装成聚合 | ✅ settings effect 已补 `void load()`（App.tsx:376-385） |
| 中危-2 | Board.tsx 自定义列分组 | status 与 colKey 恒不匹配 | ✅ 改按 `task.projectStatus` 匹配 `parseMatchRules`（Board.tsx:103-123） |
| 中危-3 | sync.rs stale 并发竞态 | 全账号标脏误标 closed | ✅ 已收窄为仅遍历 `existing_map.keys()` 快照（sync.rs:902-908，#438 两阶段回源） |
| 中危-4 | server.py `created_at` 漂移 | TASK_INSERT_COLS 缺列 | ✅ 已补 `created_at` 且 `_row_from_issue` 写真实时间戳（server.py:393,620） |
| 低危-1 | syncHint.ts diff 键 | issueKey 跨账号误算 | ✅ 改用 `taskIdentity(t)` |
| 低危-2 | SessionsPanel 选中键 | issueKey 不一致 | ✅ 选中/批量删除统一 `taskIdentity` |
| 低危-3 | handleSwitchAccount 非原子 | setViewMode 失败跳过刷新 | ✅ 已 `.catch` 解耦（App.tsx:486-506） |
| 低危-4 | App.tsx 注释误导 | 空列表 vs 全量 | ✅ 注释已纠正为「后端返回全部账号任务」 |
| 低危-5 | mcp.rs/db.rs 陈旧注释 | 列数/占位符注释错 | ✅ mcp.rs 现记 29 列；db.rs 补 ?26/?27 |
| 低危-6 | sync.rs 强制 closed 启发式 | assignee 移出仍标 done | ✅ 已被 #438 回源确认取代，仅 `RemoteState::Closed` 写 closed |

## 三、本次新发现 —— 中危（按优先级）

### 中危-1：会话面板违反 #422 账号编码契约
- **位置**：`app/src-tauri/src/commands.rs:430-453`（`list_active_sessions` 的 `account_filter` 解析与 `keep` 判定）。
- **根因**：`account_id: Option<i64>` 的 `None` 与 `Some(0)` 都被归一成 `None` 并 `keep = true`（不过滤）。而 #422 硬规则要求 `None ⇒ 读 meta.active_account_id`。同文件 `rows_to_tasks`（:199-209）已正确实现该回落，注释（:429）却称「与 `rows_to_tasks` 同口径」——实际并不一致。
- **触发**：多账号 + 前端以 `null` 调会话面板（单账号视图）时，会展示**全部账号**的活跃会话而非活动账号的会话。
- **修复**：`None` 时读 `read_active_account_id`，`>0` 才按该账号过滤；或明确前端恒传显式 `account_id` 并消除注释误导。

### 中危-2：`map_project_status` 中文分支用子串匹配，与「整值全等」契约冲突
- **位置**：`app/src-tauri/src/sync.rs:47-59`（中文分支全部 `raw.contains(...)`）。
- **根因**：硬约束要求「整值全等匹配，中文+英文都要覆盖」。中文分支 `"完成"→done`、`"上线"→done`、`"测试"→processed` 均为**子串命中**；英文分支（:66-93）已正确用归一化整值全等（注释专门解释 `Ready for release` 不能误判 done）。两分支口径不一致。
- **触发**：出现嵌入关键字的自定义中文状态，如 `"等待完成"`/`"未完成评审"` 误判 done、`"测试中"` 恒判 processed。OMS 标准值因判断次序侥幸正确，但属脆弱实现。
- **修复**：中文分支改为与英文一致的归一化整值查表；补「`未完成`/`等待完成` 不得判 done」反向测试。

### 中危-3：`check-workflow-yaml.py` 将 `- run: |` 误判为非法行（潜伏 CI 雷）
- **位置**：`scripts/check-workflow-yaml.py:238-252`（列表项分支 `continue` 早于块标量检测 :263）。
- **根因**：`- run: |` 同时满足 `s.startswith("- ")` 在 :252 提前 `continue`，从未触发 :263 的块标量判定，其后脚本体每行被报「不是合法的 key: value 行」。`.github/workflows/` 当前 6 个文件均不用该写法故未触发，属潜伏雷。
- **触发**：任一 workflow 步骤写成列表项块标量（`- run: |`）形式，合规 PR 的 CI 会误红。
- **修复**：列表项分支内，若 `key in ("run","if")` 且 `rest` 为块指示符，在 `continue` 前置 `in_block/block_indent/block_owner`；并补 `test_workflow_yaml.py` 用例（当前 `test_block_scalar_run_is_not_empty_step` 只覆盖分隔行形式，未覆盖列表项形式）。

### 中危-4：`server.py` 缺 Content-Length 返回 MALFORMED，与 Rust 权威实现（FATAL）不一致
- **位置**：`mcp_server/server.py:1253-1260`；对照 `app/src-tauri/src/mcp.rs:889-897`。
- **根因**：Python 对「头部正常收尾但缺/不可解析 Content-Length」返回 `malformed`（主循环继续读）。Rust 已将此**修正为 FATAL**——理由是缺 Content-Length 时正文首字节位置未知，继续读会把正文字节当后续帧头解析出垃圾。Python 注释「帧边界已知⇒丢弃继续读安全」正是 Rust 明确指出的错误推理。两实现仅在「缺失」这一支分歧（越界/为 0 已一致判 FATAL）。
- **触发**：非 NDJSON 客户端发送无 Content-Length 头部块，Python 主循环会把后续字节当新帧解析（Rust 直接终止避免错位）。
- **修复**：改为 `ReadOutcome.fatal(...)` 对齐 Rust，并同步改 `test_server.py:803` 断言（该测试当前把偏离行为钉死为「正确」）。违反 AGENTS.md §8.6 双实现一致性。

## 四、本次新发现 —— 低危

### 低危-1：`migrate_tasks_v2_rebuild` 重建白名单漏 4 列（db.rs:872-884）
- 根因：`CREATE TABLE tasks_new`（:838-871）含 `author`/`parent_issue`/`sub_issues`/`work_dir`，但 `INSERT..SELECT` 写死白名单漏这 4 列。`work_dir` 风险真实：`migrate_legacy_alters`（:784）在重建**前**加 `work_dir`，重建 SELECT 不带走 → 迁移后 `work_dir` 被清空。仅 `user_version<1` 极旧库触发，但数据不可逆。
- 修复：把 4 列补进重建 SELECT/插入清单，与 `tasks_new` 完全对齐（遵循项目「重建后补列须进白名单」自身规则）。

### 低危-2：按需拉取竞态下误报 `Pulled`（on_demand.rs:406-407）
- 根因：`ensure_task_available` 在 `write_task(InsertIfAbsent)` 后**无条件**返回 `Pulled`；若同步并发写入该行 `InsertIfAbsent` 返回 0，仍报 `Pulled`。仅 `pulled` 标志语义失真（DO NOTHING 不覆盖数据），无数据错误。
- 修复：用 `write_task` 返回值区分（`0⇒AlreadyLocal`，`>0⇒Pulled`）。

### 低危-3：`coalescedLoad` 在 `exec` 抛错后可能消费过期 pending 参数（utils/coalescedLoad.ts:27-49）
- 根因：`exec(cur)` 抛错直接跳出循环，`finally` 仅复位 `loading=false`，残留 `s.pending` 未被清理；下次 `loadWith` 进入新循环时 `next = s.pending` 取出**更早一次**的请求参数并执行，最终 state 可能被旧 accountId 覆盖。
- 触发：某次 `listTasks` 抛错**且**期间有并发调用，呈现过期账号数据。
- 修复：`catch` 分支清 `s.pending = null`，或仅成功路径累积 pending。

### 低危-4：`SessionsPanel` 复制高亮键用 `issueKey` 而非 `taskIdentity`（components/SessionsPanel.tsx:377,398,419）
- 根因：选中态/卡片 key 已统一 `taskIdentity`（上次低危-2 已修），但 `copiedKey`（已复制勾选状态）仍用裸 `issueKey`。聚合视图下同一 issue 被两账号关联时，复制一条另一条也错误亮起「已复制」。
- 修复：`copiedKey` 派生改为 `taskIdentity(task)`（如 `branch-${taskIdentity(task)}`），与选中态同口径。

### 低危-5：NDJSON 分帧 DoS 上限形同虚设（server.py:1211-1231）
- 根因：NDJSON 分支 `stream.readline()` 一次性把整行读进内存**之后**才判断 `len(line) > MAX_FRAME_BODY`，对超长无换行行会先 OOM。Rust（mcp.rs:839-854）逐字节累加超限即 FATAL，内存不膨胀。本地可信客户端风险小，但属健壮性缺口。`test_oversized_ndjson_line_is_fatal` 只发约 8MB，未守真实量级。
- 修复（可选）：改为逐字节读取对齐 Rust，或放大测试量级以暴露语义。

### 低危-6：已知 CI 盲区 —— `check-mcp-columns.py` 不交叉比对 `TASK_INSERT_COLS` 与 Rust `TASK_INSERT_HEAD`
- 根因：脚本只校验 `SELECT_COLS` 两实现一致 + `ENSURE_COLUMNS ⊇ SELECT_COLS/⊇ TASK_INSERT_COLS`，**没有**把 Python `TASK_INSERT_COLS` 与 Rust `db.rs::TASK_INSERT_HEAD`（29 列）比对。
- 现状：`TASK_INSERT_COLS` 仅 26 列，比 Rust 少 `parent_issue`/`sub_issues`/`pr_state`（3 列），当前**恰好一致**（Rust 对这 3 列显式写 `""`，Python 落默认值 `''` 语义同）。隐患：Rust 增/改写入列时 Python 静默漂移；且 `server.py:384` 注释「与 Rust 一致」已失真。
- 修复：脚本增加解析 `TASK_INSERT_HEAD` 并断言一致；校正 server.py:384 注释。

### 低危-7：最关键的 CI 检查脚本 `check-mcp-columns.py` 无单测
- 根因：其余 4 个 scripts 均有 `test_*.py` 守护，唯独负责 MCP 列一致性的脚本无回归测试。解析函数若因 `db.rs` 格式微调而失效，无测试报警。
- 修复：补 `test_check_mcp_columns.py`，至少快照断言三清单通过 + 一个「故意删 SELECT_COLS 一列应失败」反向用例。

## 五、信息项（非缺陷，供决策）

- **I-1**：`Board.sortProjectStatusKeys(keys, projectStatuses?)` 第二参数在唯一调用点未传入，按 `orderIndex` 排序分支永不执行，回落字母序（`board.test.tsx:118-141` 已记录「不改代码」）。API 表面承诺但调用点用不上，是否清理属产品判断。
- **I-2**：App.tsx:376-385 的 settings effect 依赖 `[settings, ...]`，`loadProjectStatuses`/`loadAccountColumns` 又依赖 `[settings]`；即便只改 `scheduleMinutes`/`ghPath` 也会触发列配置重查，仅多余一次 IPC，功能无害。

## 六、优先处理建议

1. **中危-1（会话面板账号契约）**：直接影响多账号会话面板正确性，改动小，建议优先。
2. **中危-3（workflow 误报）**：加 1 行 `in_block` 设置 + 补测试，最低成本消除潜伏 CI 雷。
3. **中危-4（Content-Length 语义）**：改 MALFORMED→FATAL 对齐 Rust + 修测试，消除双实现一致性违规。
4. **中危-2（中文状态整值匹配）**：避免自定义中文状态误分类，建议与英文分支统一查表。
5. 低危项随相关改动一并清理；低危-5/6/7 关闭 CI 盲区与注释失真；低危-3 视本地客户端 DoS 容忍度决定。

---

*本报告仅做静态审查，未修改任何源代码。如需针对某项生成修复方案或 PR，请指定。*

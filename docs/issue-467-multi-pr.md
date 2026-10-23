# #467 同一个 issue 支持关联多个 PR

> 关联 issue：[#467](https://github.com/ShawnLiuSZ/task-dashboard/issues/467)
> 分支：`feature/issue-467-multi-pr`

## 一、背景 / 动机

用户需求原文：「同一个 isseu ID 支持 多个PR ID」。

现实场景里一个 issue 被多个 PR 引用是常见的：

- `feat: 加支付回调`（PR #101）关联 issue #10
- `fix: 修支付回调空指针`（PR #102）也关联同一个 issue #10
- `refactor: 抽支付模块`（PR #103）同样关联 issue #10

改造前这些 PR **只有第一个能被看到**，其余两个被静默丢弃 —— 用户看到的关联信息不完整，
无法判断「这个 issue 到底由哪几个 PR 在推进」。

## 二、根因：`or_insert` 只保留第一个 PR

`sync.rs` 构建 PR↔issue 映射时用的是**单值** `HashMap`：

```rust
// 改造前
let mut pr_map: HashMap<String, (i64, String, String, String)> = HashMap::new();
for pr in &prs {
    for rk in parse_issue_refs(&pr.body, &pr.repo) {
        pr_map.entry(rk).or_insert((pr.number, pr.url.clone(), pr.head_ref.clone(), pr.state.clone()));
        //          ^^^^^^^^^ 只在 key 不存在时写入 ⇒ 后续命中的 PR 全部被丢弃
    }
}
```

`or_insert` 的语义是「key 不存在才插入」⇒ 同一个 issue_key 被多个 PR 命中时，
**只有第一个 PR 入表**，其余静默丢失（无日志、无报错）。

数据层同样是单值：`tasks.pr_number INTEGER` + `tasks.pr_url TEXT` + `tasks.pr_state TEXT`
—— 一个 issue 只能存一个 PR。

## 三、方案选型：独立关系表，`tasks` 零改动

三个候选方案：

| | 方案 A：独立关系表 `task_prs` | 方案 B：`tasks` 加 JSON 列 | 方案 C：保留单值列 + 另加多值列 |
|---|---|---|---|
| `tasks` 表改动 | **零** | 加 1 列 | 加 1 列 |
| 迁移链风险 | **无** | 触发「新列顺序硬约束」 | 同 B |
| 三处位置绑定风险 | **无** | `mcp.rs`/`server.py`/`commands.rs` 各 +1 索引 | 同 B |
| 存量兼容 | 100% | 需回填 | 需回填 |
| 一对多表达 | 天然 | JSON 解析 | 天然 |

**选定方案 A**，理由：

1. **避开本仓反复踩坑的「tasks 新列顺序硬约束」**。`tasks` 新列必须写在
   `migrate_tasks_v2_rebuild`（物理重建，写死列白名单）之后，否则被丢；
   且 `mcp.rs::row_to_value` / `server.py` / `commands.rs::task_mapper` 三处
   **位置索引**绑定任一处漏改 ⇒ `Row::get(N)` 越界 ⇒ 整个 `list_tasks` 报错 ⇒
   前端空看板（#285 的真实事故）。独立表让 `tasks` 零改动 ⇒ 这两个坑一个都不碰。

2. **存量 100% 兼容**。`tasks.pr_number` / `pr_url` / `pr_state` / `branch` 四列
   保留为「**主 PR**」，取值与改造前 `or_insert` 的结果**逐位相同**
   （主 PR = 第一个命中者）⇒ 旧 UI、旧 MCP 契约、存量数据全部不变。

3. **不需要 bump `SCHEMA_VERSION`、不需要写迁移**。新表用
   `CREATE TABLE IF NOT EXISTS` 放进 `SCHEMA`，而 `open_db` 每次都无条件执行
   `execute_batch(SCHEMA)` ⇒ **老库自动补齐**（与 `sessions` 表同款先例）。
   单测 `legacy_db_gets_task_prs_table_automatically` 守住这条不变量。

## 四、数据模型

```sql
CREATE TABLE IF NOT EXISTS task_prs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id  INTEGER NOT NULL,
  issue_key   TEXT NOT NULL,
  pr_number   INTEGER NOT NULL,
  pr_url      TEXT NOT NULL DEFAULT '',
  pr_state    TEXT NOT NULL DEFAULT '',
  updated_at  INTEGER NOT NULL DEFAULT 0,
  UNIQUE(account_id, issue_key, pr_number, pr_url)
);
CREATE INDEX IF NOT EXISTS idx_task_prs_issue ON task_prs(account_id, issue_key);
```

唯一键的设计取舍：

- **必须含 `account_id`**：issue_key 的值是 `repo#number`（**不含 owner**），
  多账号下会重复（与 tasks 表表现一致）⇒ 只按 issue_key 分组会把 A 账号的 PR 关联
  错误地挂到 B 账号的同号 issue 上。
- **必须含 `pr_url`**：跨仓库 PR 的编号可能与本仓库 PR 撞号 ——
  `parse_issue_refs` 把 `owner/repo#N` 归一化为 `repo#N`（只取路径最后一段，不带 owner），
  只用 `pr_number` 会误判冲突。

## 五、全链路改动

### 5.1 数据层（`db.rs`）

| 函数 | 作用 |
|---|---|
| `write_task_prs(conn, account_id, issue_key, prs, now)` | **全量替换**语义：先删该 issue 的旧行，再写新行 |
| `load_task_prs(conn, account_id, issue_key)` | 读单个 issue 的全部关联 PR（按编号升序） |
| `load_all_task_prs(conn, account_id)` | 一次性读整账号的关联行，返回 `(account_id, issue_key) → PR 列表` |

`write_task_prs` 用 `INSERT ... ON CONFLICT DO UPDATE`：同一 PR 在一次同步里可能被
`parse_issue_refs` 命中多次（正文里写了 `Fixes #1` 又在结尾重复 `#1`），冲突时更新状态而非报错。

`delete_account` 的事务内补 `DELETE FROM task_prs WHERE account_id = ?` ——
否则删账号后残留行会被「聚合全部账号」视图读到，表现为「已删除账号的 PR 关联
仍显示在别人的卡片上」。

### 5.2 同步层（`sync.rs`）

`pr_map` 的值由单值改为 `Vec<PrEntry>`，`or_insert` 改为 `or_default().push(...)`：

```rust
// #467：值由单值改为列表 —— 同一 issue 可被多个 PR 引用。
let list = pr_map.entry(rk).or_default();
// 去重：同一 PR 可能被正文多次命中
if list.iter().any(|e| e.number == pr.number && e.url == pr.url) {
    continue;
}
list.push(PrEntry { number, url, head_ref, state });
```

**主 PR 规则**：列表**首元素**。因为列表顺序 = PR 出现顺序（`prs` 遍历顺序：
仓库名升序，仓库内 GitHub pulls API 默认 created desc），
这与改造前 `or_insert` 保留的第一个 PR **完全相同** ⇒ 存量行为零变化。

**「拉取失败保留既有值」语义**同样适用于新表：`pr_fetch_ok == false` 时
**跳过** `write_task_prs` ⇒ 一次网络抖动不会把看板上的 PR 徽章全清掉。
这靠 `TaskUpsert::pr_fetch_ok` 区分，**不能靠列表是否为空** ——
「拉取成功且确实无关联 PR」与「拉取失败」都表现为空列表。

### 5.3 读路径（`commands.rs` / `mcp.rs` / `server.py`）

三处读路径都**不改 `tasks` 的 SELECT 列**（位置索引零风险），
而是在行读出后按 `(account_id, issue_key)` **批量回填** `prs` 数组：

- `commands.rs::attach_task_prs` —— 看板 / 会话面板
- `mcp.rs::attach_prs` —— Rust MCP（`list_my_tasks` / `get_task_status`）
- `server.py::_attach_prs` —— Python MCP（独立进程，自建 `task_prs` 表）

**回退语义**：`task_prs` 无该 issue 的行时，若 `tasks.pr_number > 0` 则用主 PR
组成一条 ⇒ `prs` 数组语义统一为「该 issue 关联的**全部** PR（含主 PR）」，
且存量库（首次同步前 `task_prs` 为空）PR 徽章不会消失。

**无 N+1**：一次性取回整批关联行后在内存里匹配。

**顺序语义（2026-10-22 代码审查后修复）**：`prs[0]` **恒为主 PR**。

- **缺陷形态**：`task_prs` 的读取顺序是 `pr_number ASC`（`ORDER BY pr_number ASC`），
  而主 PR 的口径是「本轮同步中**第一个**命中的 PR」（`sync.rs::build_pr_map` 的
  `list[0]`）⇒ 两者顺序**可能不同** ⇒ `prs[0]` 未必是主 PR。
  于是 `tasks.pr_number`（主 PR）与 `prs[0].number` 会**打架** ——
  UI / agent 若取 `prs[0]` 当主 PR 用就会取错。
- **修法**：在**读取端**（组装 `prs` 数组时）把主 PR 提到首位 ——
  **不改表结构、不改 SQL 顺序语义、零额外查询**。
  Rust 两侧（`commands.rs::attach_task_prs` / `mcp.rs::attach_prs`）共用
  `common.rs::sort_prs_primary_first`，Python 侧（`server.py::_attach_prs`）
  对应 `_sort_prs_primary_first`，**三处同一口径**。
- **匹配键是 `(number, url)` 组合**而非单独的 number：跨仓库 PR 会撞号
  （`parse_issue_refs` 把 `owner/repo#N` 归一化为 `repo#N`，不带 owner），
  `task_prs` 的唯一键也是 `(account_id, issue_key, pr_number, pr_url)`
  ⇒ 同号不同 URL 的两条是**合法共存**的两条关联，只有组合键能唯一确定「主 PR」。
  只按 number 匹配会把**另一仓库**的同号 PR 提到首位。
- **找不到主 PR 时保持原顺序不变**（存量行 / `task_prs` 为空 ⇒ 走回退分支，
  此时数组本来就只有主 PR 一条，排序是空操作）。

### 5.4 前端

| 文件 | 改动 |
|---|---|
| `types.ts` | 新增 `PrRef` 接口 + `Task.prs: PrRef[]` |
| `TaskCard.tsx` | PR 行改为遍历 `task.prs` 渲染（`.pr-item` 包裹） |
| `DetailPanel.tsx` | 每个 PR 一组「打开 / 复制」按钮（`.pr-btn-group`） |
| `styles.css` | `.pr-row` 改 `flex-wrap: wrap`；新增 `.pr-item` / `.pr-btn-group` |

**判据用「`prs` 非空」而非「`prs` 字段存在」**：后者在 `prs: []` 且
`prNumber > 0`（存量行）时会渲染出**空**的 PR 行，把原本可见的 PR 链接弄丢。
这条在实现过程中被既有 #435 测试当场抓出并修正。

## 六、验收标准

| # | 标准 | 验证方式 |
|---|---|---|
| 1 | 同一 issue 的多个 PR **全部**落库 | `db.rs` 单测 + 真实同步端到端 |
| 2 | 主 PR 与改造前 `or_insert` 结果一致 | `build_pr_map_primary_pr_matches_legacy_or_insert` |
| 3 | 同一 PR 重复命中只落一行 | `build_pr_map_dedups_repeated_refs_in_same_pr` |
| 4 | 关联解除后旧行被清掉 | `task_prs_replaces_previous_rows` |
| 5 | 多账号下 PR 关联**不串号** | `task_prs_isolated_by_account` / `prs_are_isolated_by_account` |
| 6 | 老库首次打开自动建表 + 建索引 | `legacy_db_gets_task_prs_table_automatically` |
| 7 | 删账号级联清理关联行 | `delete_account_cascades_task_prs` |
| 8 | PR 拉取失败**保留**既有关联 | `TaskUpsert::pr_fetch_ok` 语义 + 代码路径审查 |
| 9 | 前端渲染多个 PR 且链接不串 | `board.test.tsx` 5 条新用例 |
| 10 | MCP 两侧返回一致 | `mcp.rs` 4 条新用例 + `check-mcp-columns.py` 第 7 条 |
| 11 | `prs[0]` **恒为主 PR** | `sort_prs_primary_first_promotes_primary_to_head` / `attach_task_prs_promotes_primary_pr_to_head` / `prs_head_is_the_primary_pr` / `test_primary_pr_is_promoted_to_head` |
| 12 | 同号不同 URL 不得误匹配主 PR | `sort_prs_primary_first_does_not_match_same_number_different_url` / `prs_head_does_not_pick_same_number_from_another_repo` / `test_same_number_different_url_is_not_matched` |
| 13 | 主 PR 必在关联列表内（口径不漂） | `primary_pr_is_always_present_in_the_association_list`（本地版，CI 可跑） |

## 七、回归防线

### 7.1 `scripts/check-mcp-columns.py` 新增第 7 条检查

Python MCP 是**独立进程**、不走 Rust 的 `db::open_db` ⇒ 它的 `ensure_schema`
必须自建 `task_prs`。漏建 ⇒ Python MCP 读路径 `no such table: task_prs`
⇒ 整个工具报错，而 App 自身完全正常（Rust 侧由 SCHEMA 建表）、两侧单测都测不到 ——
与 #169/#262/#278 同源的盲区。

检查内容：

1. Rust `db.rs::SCHEMA` 与 Python `ensure_schema` **都**建出 `task_prs`；
2. 两侧**列名集合一致**（列名拼错 ⇒ 建表成功但查列报 `no such column`）。

**反向验证**（变异测试，2/2 精准捕获）：

| 变异 | 期望报错 | 结果 |
|---|---|---|
| 删掉 Python 侧建表语句 | `server.py::ensure_schema 里找不到 task_prs 的建表语句` | ✅ |
| Python 侧列名改成 `number/url/state` | `task_prs 表的列名两侧不一致` | ✅ |

⚠️ 解析器必须**逐行扫描**到「以 `)` 开头的行」为止，不能用 `find("\n)")` ——
Rust 侧收尾是 `);`、Python 侧是 `)`，字面量查找会在 Python 侧一路匹配到
文件后面的无关代码 ⇒ 把几百行源码当成「列名」。

### 7.2 端到端测试 `test_headless_multi_pr`

真实 PAT + 生产库**快照**（`VACUUM INTO`，绝不改写生产库）跑一次同步后断言：

1. `task_prs` 行数 ≥ 已覆盖且有主 PR 的 issue 数；
2. 存在**同一个 issue 关联 ≥2 个 PR** 的行（多 PR 真的落库了）；
3. 凡是 `task_prs` 里有行的 issue，其主 PR 必须也在关联列表里（口径不漂）。

⚠️ 断言 1/3 的范围必须是「**本轮同步覆盖到的** issue」：陈旧任务（已关闭 /
不再与我相关，本轮不在 pending 里）的 `tasks.pr_number` 是存量值，
它们的 `task_prs` 行要么保留上一轮的、要么从未有过 —— 直接比全表会误报。
（实现过程中第一版断言写成全表比较，端到端立刻报出 25 个「不匹配」，
经查全是未覆盖的陈旧任务 ⇒ 收窄断言范围后通过。）

⚠️ **端到端测试是 `#[ignore]` 的**（需真实 PAT + 生产库快照）⇒ **CI 跑不到**，
断言 3（主 PR 口径不漂）这条最关键的不变量在 CI 里原本**无人守**。
2026-10-22 代码审查后补了**本地等价版**：
`commands.rs::primary_pr_is_always_present_in_the_association_list`
用构造数据覆盖同一件事（写入端传进来的列表必然含主 PR ⇒ 读回来时必在其中），
**不需要网络、不需要 PAT ⇒ CI 每次都跑**。

### 7.3 读路径测试覆盖补齐（2026-10-22 代码审查后）

审查发现 `attach_prs` 的三处实现里，**只有 MCP 侧（`mcp.rs`）有单测**：

| 读路径 | 修复前覆盖 | 修复后 |
|---|---|---|
| `commands.rs::attach_task_prs`（GUI 看板 / 会话面板） | ❌ **零覆盖** | 4 条新用例 |
| `mcp.rs::attach_prs`（Rust MCP） | ✅ 4 条 | +2 条（主 PR 置首 / 同号不同 URL） |
| `server.py::_attach_prs`（Python MCP） | ❌ **零覆盖** | 6 条新用例（`AttachPrsTest`） |

Python 侧零覆盖尤其危险：AGENTS.md §8.6 要求两实现一致，
而 Python MCP 是**独立进程**、两侧单测互不覆盖 ⇒ 口径漂移无人发现
（与 #169/#262/#278 同源的盲区）。

⚠️ Python 侧用例**必须用独立的临时库**：`_attach_prs` 走 `conn()`，而 `conn()`
会调 `ensure_schema`（建 `accounts` / `task_prs` 等表）⇒ 若共用 `mcp_server`
单测的 `_DB`，本类先跑（unittest 按类名字母序）就会把 `accounts` 建出来，
随后 `OnDemandTest.setUpClass` 的 `executescript(SCHEMA)`（**无** `IF NOT EXISTS`）
必然报「table accounts already exists」⇒ 改为每个用例一份独立库 + 临时改写
`S.DB_PATH`（`conn()` 运行时才读模块全局 ⇒ 改写有效）。

## 八、已知边界

| 边界 | 说明 |
|---|---|
| 陈旧任务的多 PR 关联 | 本轮未覆盖 ⇒ `task_prs` 无行，读路径回退到主 PR。下次同步覆盖后自动补齐 |
| 跨仓库 PR 撞号 | 唯一键含 `pr_url` 规避；显示的 PR 编号不含仓库名（沿用既有单值列口径） |
| `prs` 数组排序 | **主 PR 恒在首位**（2026-10-22 审查后修复，见 §5.3「顺序语义」）；其余元素按 PR 编号升序。修复前是纯 `pr_number ASC` ⇒ 主 PR（口径为「第一个命中者」）未必是首元素 |
| PR 拉取失败 | 保留既有 `tasks.pr_*` 与 `task_prs` 行，不清空 |
| 任务被淘汰后的孤儿行 | 30 天 done 窗口淘汰原先只删 `tasks` 行 ⇒ `task_prs` 残留（无界增长 + 同 `issue_key` 重新同步时旧行被重新挂上）。**2026-10-23 审查修复**：`db::prune_done_tasks` 同一事务内先删关系行（`task_prs` / `task_comments`）后删 `tasks` 行 |

## 九、影响面清单

| 层 | 文件 | 改动 |
|---|---|---|
| 数据 | `app/src-tauri/src/db.rs` | `task_prs` 表 DDL + 3 个读写函数 + `delete_account` 级联 + 6 条单测 |
| 公共类型 | `app/src-tauri/src/common.rs` | 新增 `PrRef`；**新增 `sort_prs_primary_first`（主 PR 置首）+ 5 条单测** |
| 同步 | `app/src-tauri/src/sync.rs` | `build_pr_map`（多值聚合）+ `PrEntry` + `TaskUpsert` 填充 + 写入 `task_prs` + 4 条单测 + 端到端测试 |
| 按需拉取 | `app/src-tauri/src/on_demand.rs` | `TaskUpsert` 新字段补齐（`pr_fetch_ok: false`） |
| 读路径 | `app/src-tauri/src/commands.rs` | `Task.prs` 字段 + `attach_task_prs` + 两处读路径调用；**+ 4 条新用例（含 GUI 路径零覆盖的补齐）** |
| MCP | `app/src-tauri/src/mcp.rs` | `attach_prs` + 两处读路径调用 + 4 条单测；**+ 2 条新用例** |
| MCP | `mcp_server/server.py` | `ensure_schema` 自建表 + `_attach_prs` + 三处读路径调用；**+ `_sort_prs_primary_first` + 列表复制（防共享对象被就地排序污染）** |
| 前端 | `app/src/types.ts` | `PrRef` + `Task.prs` |
| 前端 | `app/src/components/TaskCard.tsx` | 多 PR 渲染 |
| 前端 | `app/src/components/DetailPanel.tsx` | 多 PR 按钮组 |
| 前端 | `app/src/styles.css` | `.pr-item` / `.pr-btn-group` / `.pr-row` 换行 |
| 校验 | `scripts/check-mcp-columns.py` | 第 7 条检查（`task_prs` 两侧一致） |
| 测试 | `app/src/components/board.test.tsx` | 5 条多 PR 用例 + 3 处 fixture 补 `prs` |
| 测试 | `mcp_server/test_server.py` | **新增 `AttachPrsTest` 6 条用例**（Python 侧读路径此前零覆盖） |
| 测试 | `app/src/components/notes-layout.test.ts` | **+1 条用例**（锁住 `useAutoSize` 注释不被再次抄坏） |

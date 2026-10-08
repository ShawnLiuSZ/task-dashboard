# #380：Project Status 映射表条目无测试守护

> 断言强度审计（mutation testing）第二轮，Rust 侧第二批。
> 所属版本：v0.3.22（待发版）· 关联 issue [#380](https://github.com/ShawnLiuSZ/task-dashboard/issues/380)

## 背景 / 动机

继 #378（`iso8601_to_secs`）后审 `sync.rs::map_project_status` / `map_project_status_en`。

这两张表是 **#335 修复的核心产出**，合计**约 45 个条目**：

| 表 | 匹配方式 | 条目数 |
|---|---|---|
| 中文表 | `contains` 子串 | 6 个判据词（测试 / 开发中 / 待开发·需求·规划 / 取消·完成·上线） |
| 英文表 | 归一化后**整值精确匹配** | 39 个选项（done / processed / doing / todo 四组） |

函数注释**逐字点名了这份契约**：

> **按整值精确匹配，不做子串匹配** —— `Ready for release` 含 `release` 却并非已完成…
> 不认识的选项仍返回 `None`（保持本地手动态，绝不臆造）。

一份显式契约，却只有 7 个条目有断言守着。

## 实测：约 38/45 条目删掉后无任何测试失败

逐条 mutation（删掉单个条目 → 跑全部 lib 测试），**只有 7 个被现有用例点名**：
`done` `completed` `closed` `released` `ready for release` `in review` `in testing`

**存活 33 个（实测逐一确认）**：

| 组 | 存活条目 |
|---|---|
| 英文 · done | `complete` `shipped` `cancelled` `canceled` `won t do` |
| 英文 · processed | `review` `reviewing` `test` `qa` `verify` `verifying` `staging` `verified` |
| 英文 · doing | `in progress` `in development` `developing` `active` `wip` `in dev` |
| 英文 · todo | `todo` `to do` `planned` `planning` `triage` `new` `not started` `icebox` `no status` |
| 中文判据词 | **`完成`** **`上线`** `取消` `需求` `规划` `待开发` |

> `testing` / `backlog` 两条原本也存活，因用例词面巧合被捕获 —— 属**侥幸**，不计入守护。

## 设计 / 方案

### 缺陷形态：静默降级，不是报错

这是本项与 #378 最大的差别，也是它更危险的地方：

| 删掉什么 | 后果 | 是否可见 |
|---|---|---|
| 英文条目 | 落 `_ => None` → **保持本地手动态** | ❌ 不报错，UI 完全正常 |
| 中文判据词 | 落下一个 `contains` 或英文表 | ❌ 同上 |

`None` 是 #335 注释**明确要求的行为**（「绝不臆造」），所以删掉一个条目后的表现是「这个 Status 不再影响看板状态」—— 而这**本来就是许多 Status 的正确表现**。因此没有任何异常信号。

### 为什么中文表特别脆弱

现有中文用例：

```rust
assert_eq!(map_project_status("🎉完成/上线"), Some("done"));
```

**一个字符串同时含「完成」和「上线」**。删掉其中任一个判据词，另一个仍会命中 ⇒ 断言通过。这就是这两个词长期无守护的确切原因 —— 与 #376 `taskSig` 的「字段组断言」**完全同型**：一次覆盖多个判据 ⇒ 单独删除测不出来。

### 方案：把表搬进测试

不用逐条写 `assert_eq!`，而是把表本身作为测试数据：

1. `map_project_status_en_table_is_fully_guarded` — 39 个英文条目逐条断言
2. `map_project_status_cn_table_is_fully_guarded` — 9 个中文判据词，**每个用例只命中一个判据词**，消除「一词覆盖两词」
3. `map_project_status_returns_none_for_unlisted_values` — 反向契约：表外值须 `None`，含危险区样本

**为什么表驱动而非逐条断言**：

- 表本身就是数据 —— 把数据搬到测试里最直接
- **增删条目时强迫同步更新测试**（漏更新即编译失败）⇒ 从根上消除「改了表没改测试」这个盲区本身
- 比 45 条 `assert_eq!` 紧凑得多

第 3 例的样本选择针对注释里点名的那个陷阱：

```rust
"release notes",        // 含 `release` 但 ≠ `ready for release`
"released for testing", // 混合词，不在表内
"in review needed",     // 多余后缀 ⇒ 不是整值 `in review`
```

子串匹配会把这三个全部误判成 `done`；整值匹配正确返回 `None`。这三条**锁定注释承诺的「不做子串匹配」**。

## 接口 / 行为变更

无。纯测试补充。

## 数据 / Schema 变更

无。

## 边界：中文表的 `contains` 是词级而非语义级

`取消键位置调整`（一个 UI 文案）含「取消」⇒ 判为 `done`。

这是 `contains` 模糊匹配的**固有代价**，不是 bug：中文 Project Status 是自由文案，作者本就是在用词表达状态。测试**显式记录这一真实行为并注明它不是缺陷**，避免后人看到 `assert_eq!(..., Some("done"))` 误判为写错。

若将来要收敛，只能靠「让用户在本地自定义映射」（#215 已有此通道），不能在同步路径上臆造语义 —— 这正是 #335 注释「绝不臆造」的由来。

## 测试 / 验收

### 反向验证（mutation testing）

| 类别 | 修复前 | 修复后 |
|---|---|---|
| 英文单词条目（19 个） | **0 / 19** | **19 / 19** ✅ |
| 中文判据词（6 个） | **0 / 6** | **6 / 6** ✅ |
| 英文多词条目（8 个） | **0 / 8** | **8 / 8** ✅ |
| **合计** | **0 / 33** | **33 / 33** ✅ |

另在审计过程中确认（非本次修复对象，已被现有测试守护）：
子串匹配退化、闰年式大小写、归一化保留 emoji / 漏小写、删掉 `ready for release` —— 均被捕获。

### 验收标准

- [x] 3 个新用例全绿
- [x] 33/33 变异被捕获
- [x] lib 测试无回归：163 → **166**
- [x] `cargo clippy --all-targets -D warnings` 干净
- [x] `cargo fmt --check` 干净

## 本轮的一个失误

用 `python3` 做**字符串插入点替换**时，anchor 只取了 `fn xxx() {` 一行，而该函数上方的 `#[test]` 与 doc 注释留在原地 ⇒ 新的 `#[test]` 与旧的叠加成 `duplicated attribute`，同时原函数**丢失了 `#[test]`** 变成 dead code。

值得记录的是：**`cargo test` 当时仍然通过（166 passed）**，只有 `clippy --all-targets` 才暴露（`duplicated attribute` + `never used`）。若只跑 `cargo test` 就提交，会把一个「原测试静默失效」的状态合进 `main` —— **与本 issue 修的正是同一类问题**。

这条已并入 clippy 门禁（#366）的作用范围：它不只是 lint 洁癖。

## 相关链接

- issue [#380](https://github.com/ShawnLiuSZ/task-dashboard/issues/380)
- PR #381
- 前置：#378（`iso8601_to_secs` 零测试覆盖）、#376（前端 `taskSig` 字段契约）
- 同型缺陷：#335（这张表本身的产生背景 —— 远程权威失效）
- 源文件：`app/src-tauri/src/sync.rs::map_project_status` / `map_project_status_en`
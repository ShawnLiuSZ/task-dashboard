# #413：match_close_keyword 后词边界与文本末尾两条分支无断言

> 断言强度审计续篇 —— 手写扫描器 `match_close_keyword`（PR 正文解析）。
> 关联 issue [#413](https://github.com/ShawnLiuSZ/task-dashboard/issues/413) · PR [#414](https://github.com/ShawnLiuSZ/task-dashboard/pull/414)
> 方法论见 [`methodology-assertion-strength-audit.md`](./methodology-assertion-strength-audit.md)

## 背景 / 动机

`match_close_keyword` 是 `parse_issue_refs` 的核心 —— 一个**手写扫描器**
（逐字节走 `text.as_bytes()`），从 **PR 正文**里提取关闭关键词。

按方法论的目标优先级，它同时满足**手写解析器** + **用户文本输入**两条，
是最值得审的剩余目标。

## 实测 7 个变异，2 个真实缺口存活

| 变异 | 结果 | 后果 |
|---|---|---|
| 后词边界检查被删 | **存活 ❌** | `fixedX` / `closed_foo` 这类**并非该关键词**的词也被当成关闭标记 |
| 文本末尾 `return Some(end)` 改成 `None` | **存活 ❌** | 关键词**位于正文最末**时匹配不到（末行就是「Fixed」是极常见的正文形态） |
| 前词边界检查被删 | 捕获 ✅ | — |
| char boundary 守卫被删 | 捕获 ✅ | — |
| 大小写不敏感被删 | 捕获 ✅ | — |
| 中文分支 `==` 改成 `eq_ignore_ascii_case` | 存活 ❌（**等价变异**） | 无影响 |
| repo 名允许 `-` / `_` 被删 | 捕获 ✅ | — |

## 严重性

**中等**：`fixedX` 被当成关闭标记 ⇒ 可能**误关闭**无关 issue；
关键词在正文末尾漏匹配 ⇒ **本该关闭的没关闭**。

都影响**用户可见行为**（GitHub 自动关闭机制），但不会造成静默数据损坏
（GitHub 侧会二次校验 issue 引用是否真实）。

## 修复：1 例三层

| 层 | 锁定 |
|---|---|
| 1 | 后词边界：`fixedX` / `fixed_more` / `fixed2` **不得**匹配；`fixed.` / `fixed：` **必须**匹配；前缀粘连 `prefixfixed` 也 **不得**匹配 |
| 2 | 文本末尾：关键词独占文本、中文关键词独占、前置上下文 + 关键词收尾，**全部必须匹配** |
| 3 | 反向契约：截断的关键词（`Fi` / `fixe`）**不得**匹配 |

> ⚠️ **反向契约的陷阱**：`Fix` 本身**就是**完整关键词（大小写不敏感），
> 不是截断。反向契约必须用**真正的截断输入**（`Fi` / `fixe`）。
> 我第一版误用 `Fix` 当截断输入，测试失败后才意识到 ——
> **写反向契约前，先确认「什么算截断」在语义上确实是截断**。

## 方法论第二次命中：等价变异

中文分支 `candidate == kw` 改成 `candidate.eq_ignore_ascii_case(kw)` **存活**，
但后者只影响 ASCII 大小写，对非 ASCII 字符串等价 ⇒ 两种写法**同值**。

这是**等价变异判别清单**的第二次命中（第一次是 `sort_keys`）。
正确结论是「存活但**不计数**」—— 等价变异不是缺口。

## 测试 / 验收

- [x] 2 个真实缺口全部捕获
- [x] 前词边界 / char boundary / 大小写不敏感三项**回归无恙**（仍捕获）
- [x] lib 176 → **177**
- [x] `cargo clippy --all-targets -D warnings` 0 error
- [x] `cargo fmt --check` 干净

## 相关链接

- issue [#413](https://github.com/ShawnLiuSZ/task-dashboard/issues/413)
- PR [#414](https://github.com/ShawnLiuSZ/task-dashboard/pull/414)
- 方法论：[`methodology-assertion-strength-audit.md`](./methodology-assertion-strength-audit.md)
- 同系列：[#411](./issue-411-write-path-mutation-shape.md)（写回 mutation 形状）、#409（分页截断）
- 源文件：`app/src-tauri/src/sync.rs::match_close_keyword`

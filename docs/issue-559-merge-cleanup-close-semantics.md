# merge-cleanup 关闭语义收窄：标题只认 `(#N)` + docstring 去掉 `Refs`（#559）

## 背景 / 动机

`scripts/merge-cleanup.py` 在 PR 合并到 `main` / `develop` 后自动删源分支、关关联 issue。「关闭」是**不可逆**动作（关掉的 issue 要人工重开），所以提取规则必须与 GitHub 原生语义一致。

#539 把正文关闭词对齐了 GitHub 原生（移除 `Refs` / `References`），但留下两处不一致，本 issue 由 find-bugs 审查发现：

1. **docstring 自相矛盾**：模块 docstring 仍写正文关闭词含 `Refs`，而同文件下方注释与实际 `CLOSE_RE` 正则都已排除它 —— 代码是对的，文档是错的。
2. **标题正则过宽**：`TITLE_REF_RE` 匹配标题里**任意** `#N`。`Revert workaround for #123 (#456)` 合并后会**同时关掉 #123 与 #456**，而 #123 往往并未完成。

GitHub 原生**不会**因标题里的裸 `#N` 关 issue（只认 body 的 `Closes` / `Fixes` / `Resolves`）。误关比漏关严重得多 —— 漏关可人工补，误关会让 issue 看起来「已完成」而实际无人处理。

## 设计 / 方案

**两处独立修复，同一 PR 落地：**

1. **docstring 对齐实际行为**：第 8 行删掉 `Refs`，并显式写明「`Refs / References` 只是引用，不关闭」，与下方 VULN-05 注释、`CLOSE_RE` 正则三方一致。
2. **标题正则收窄为括号形态**：

   ```python
   TITLE_REF_RE = re.compile(r"\(#([1-9]\d{0,5})\)")
   ```

   只认本仓库标题惯例的 `... (#284)` 括号主旨引用。

**取舍**：收窄意味着 `Fix crash #123` 这类标题不再关 #123 —— 这是**有意**的。GitHub 原生也不关；需要关闭时在 body 写 `Closes #123` 即可，规则单一、可预期。

**与 #539 的关系**：#539 修正文侧（关键词集），本 issue 修标题侧（引用形态）+ 文档。不改 `CLOSE_RE` 关键词集，不动 fork 删分支判据与其它安全护栏。

## 接口 / 行为变更

| 输入 | 改前 | 改后 |
|---|---|---|
| 标题 `Revert workaround for #123 (#456)` | 关 #123 + #456 ❌ | 只关 #456 ✅ |
| 标题 `Fix crash #123` | 关 #123 ❌ | 不关 ✅（与 GitHub 原生一致） |
| 标题 `update #1 and #2 (#3)` | 关 #1 + #2 + #3 ❌ | 只关 #3 ✅ |
| 标题 `feat(ci): 合并后自动收尾 (#284)` | 关 #284 | 关 #284（**不变**） |
| 正文 `Closes #284` | 关 #284 | 关 #284（**不变**） |
| 正文 `Refs #284` | 不关（代码已对） | 不关（docstring 改为一致） |

**纯脚本行为变更**：无 Tauri command / MCP 工具 / API 签名变化；workflow 调用方式（`--repo` / `--head-repo` / `--dry-run`）不变。

## 数据 / Schema 变更

**无**。不涉及 SQLite / `tasks` 表 / MCP `SELECT_COLS`，`scripts/check-mcp-columns.py` 不受影响。

## 测试 / 验收

`scripts/test_merge_cleanup.py` 的 `ExtractIssueRefsTest` 新增 3 个用例：

- `test_title_bare_hash_ref_not_closed` — 裸 `#N` 标题不触发关闭
- `test_title_revert_keeps_only_parenthetical_ref` — **核心回归**：Revert 类标题只关括号里的那个
- `test_title_multiple_bare_refs_not_closed` — 多处裸 `#N` 一律不关

**已跑**：

```
python3 -m unittest discover -s scripts -p 'test_*.py'   # EXIT=0
```

**反向验证（三步，缺一不可）**：备份 → 把正则注入回旧版宽松写法 → 确认 3 个新用例**全部变红**（EXIT=1，`failures=3`）→ 还原 → 确认全绿（EXIT=0）。证明断言真的在守这个行为，不是恒真断言。

## 相关链接

- [#559](https://github.com/ShawnLiuSZ/task-dashboard/issues/559) —— 本修复的任务追踪
- #539 —— 前序：CI 供应链加固 + 关闭语义对齐 GitHub 原生（PR #549），本次修其遗留的标题侧与文档不一致
- `scripts/merge-cleanup.py` —— `TITLE_REF_RE` / `CLOSE_RE` 与模块 docstring
- `scripts/test_merge_cleanup.py` —— `ExtractIssueRefsTest`
- `docs/issue-539-ci-supply-chain-hardening.md` —— 前序安全加固的完整背景

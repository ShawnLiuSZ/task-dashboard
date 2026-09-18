# PR 合并后自动收尾：删分支 + 关 Issue（#284）

> **状态**：已实现（`.github/workflows/merge-cleanup.yml` + `scripts/merge-cleanup.py`）
>
> **关联**：[#284](https://github.com/ShawnLiuSZ/task-dashboard/issues/284)

---

## 1. 背景 / 动机

PR 合入 `develop` / `main` 之后有两件必做的收尾动作：

1. 删掉 `feature/issue-N-xxx` 源分支；
2. 关闭 PR 标题 / 正文里声明的关联 issue。

这两件事此前全靠人工，每合并一个 PR 都要重复一遍。它们有两个共同特征：**没有判断成分**（分支名与 issue 号都在 PR 元数据里）、**做完就完了**（失败也不需要回滚任何东西）。适合交给自动化。

一个常被忽略的事实：GitHub 的「Closing keywords」（`Closes #N`）只在 PR 合入**默认分支**时自动生效。本仓库默认分支是 `main`，而日常开发合入的是 `develop`，所以绝大多数 PR 的 `Refs #N` 从来不触发自动关闭 —— 手动关是常态而非例外。

## 2. 设计 / 方案

### 2.1 触发时机

`pull_request` 的 `closed` 事件同时覆盖「合并后关闭」与「未合并直接关闭」两种情形，所以 job 用 `if` 额外过滤：

```yaml
if: >-
  ${{ github.event.pull_request.merged &&
      (github.event.pull_request.base.ref == 'develop' ||
       github.event.pull_request.base.ref == 'main') }}
```

未合并的 PR 不做任何清理；合入其它分支（如 `release/x`）也不清理，避免误删仍在用的发布分支。

### 2.2 关联 issue 的提取：刻意保守

提取规则抽在 `scripts/merge-cleanup.py::extract_issue_refs`，一个纯函数，有 26 例单测兜住。核心取舍是**宁可漏关，不可误关**：

| 位置 | 规则 | 理由 |
|---|---|---|
| PR **标题** | 全量匹配 `#N` | 标题通常只有 `... (#284)` 这一处主旨引用 |
| PR **正文** | 只认**带关闭关键词**的引用（`Closes` / `Fixes` / `Resolves` / `Refs` / `关闭` / `解决` / `修复`） | 本仓库 PR 正文习惯引用历史 issue（CHANGELOG 里的「沿用 #155 / #175 / #237 的教训」），裸匹配会往早已关闭的无关 issue 里留言 |
| 正文裸 `#N` | 一律不关 | 误关的后果（污染无关 issue 的讨论串）比漏关一个 issue 严重 |
| 关键词后无 `#` | 不关 | 否则「修复 3 个 bug」「2026 年的崩溃」会被当成 issue 编号 |
| 关键词与 `#N` 之间隔了助词（「修复**了** #N」「解决**过** #N」） | 不关 | 与 GitHub 自身一致（只识别行首固定关键词）。「本次修复了 #284 的问题」通常是回顾性叙述而非关闭声明，宁可漏关（人工补），不猜语义去关 |
| 关键词被当成单词碎片（`prefixfixed #5`） | 不关 | 靠词边界挡掉；见下方「词边界」说明 |
| 编号 > 6 位 / 前导零 / `#0` | 忽略 | 避免吃到 commit sha 片段或时间戳 |
| 结果 | 去重 + 保持**首次出现顺序** | 正文一般按主张顺序写，数字排序反而不符合阅读预期 |

**词边界的坑**：不能直接用 `\b`。Python 里汉字也属于 `\w`，所以两个汉字之间不存在词边界 —— 「已关闭 #284」用 `\b` 写**永远匹配不上**（`已` 和 `关` 都是 `\w`）。这里改成 `(?<!\w) | 前面是汉字` 的或条件，两种情况都放行。

### 2.3 安全护栏

清理是收尾动作，失败不应反过来挡住已合并的 PR，所以策略偏「保守跳过」而非「报错中断」：

| 情形 | 行为 |
|---|---|
| 源分支属于 fork（`head.repo.full_name != repository.full_name`） | 跳过删分支（权限不在本仓库范围内） |
| PR 标题含 `test` / `draft`（大小写不敏感） | 跳过删分支 —— 验证本 workflow 时开一个标题带 `test` 的 PR，合并后仍保留现场 |
| 远端分支 sha ≠ PR head sha | 跳过删分支 —— 别人在合并后又往该分支推了提交，误删会丢工作 |
| 分支已不存在 | 跳过 |
| issue 已关闭 | 跳过，**不重复留言** |
| issue 编号不存在（404） | `::warning::` 告警，不计入失败中断 |
| 单项失败 | 只告警不中断；有失败时退出码为 1，但 job 不阻塞后续（收尾动作无下游依赖） |

### 2.4 数据传递：走事件负载文件，不走 shell 变量

PR 正文可能含单引号、反引号、多行代码块，经 shell 变量转义风险大。因此 workflow 只传 `--repo`，标题与正文由脚本直接读 `GITHUB_EVENT_PATH` 指向的 JSON 事件负载文件。

### 2.5 步骤顺序：先校验配置，再动数据

```
actions/checkout  →  setup-python  →  check-workflow-yaml.py  →  merge-cleanup.py
```

校验放在写操作**之前**：配置没验证，就不执行任何写操作。此前仓库里没有任何 CI 会碰 `.github/workflows/`，一个缩进错误会让 job 在静默状态里失败 —— 所以本次顺带补了那个检查器（见下）。

## 3. 接口 / 行为变更

### 3.1 新增：`.github/workflows/merge-cleanup.yml`

- 触发：`pull_request` / `closed`，且 `merged == true`，且 base ∈ {`develop`, `main`}。
- 权限：`contents: write`（删 `git/ref`）、`issues: write`（关 issue + 留言）。
- **不需要 `pull-requests: read`**：PR 元数据全部来自事件负载，不额外请求 pull-requests API —— 权限按最小化配。
- 依赖 `actions/checkout@v5`：runner 的 workspace 默认是空的，不 checkout 就会以「file not found」在静默状态失败。

### 3.2 新增：`scripts/merge-cleanup.py`

零第三方依赖（标准库 `urllib`），不依赖 `gh` CLI 是否在 runner 的 PATH 上。

```
python3 scripts/merge-cleanup.py --repo <owner/name>
```

| 参数 | 说明 |
|---|---|
| `--repo` | 必填，仓库全名 |
| `--pr-number` / `--pr-title` / `--body-text` / `--body-file` / `--base-ref` / `--head-ref` / `--head-sha` / `--head-repo` | 均可选，留空则从事件负载读取；便于本地验证 |
| `--dry-run` | 只打印计划，不执行任何写操作、**也不打网络** |

退出码：`0` 成功 / `1` 有单项失败（已告警）/ `2` 缺少 token。

### 3.3 新增：`scripts/check-workflow-yaml.py`

此前 CI 只跑 i18n / MCP 列名 / 文档链接，**没有任何检查会碰 workflow 文件**。本脚本做逐行结构校验，拦下 9 类历史缺陷：

tab 缩进 / 结构行缩进不是偶数 / 同作用域重复 key / 缺 `name` `on` `jobs` / `on:` 下无触发事件 / job 缺 `runs-on` 与 `uses` / step 缺 `uses` 与 `run` / 第三方 action 未固定版本 / `${{ "..." }}` 引号冲突 / `if:` 含 `: ` 裸标量 / `permissions:` 空或 scope 非法 / 引用 `scripts/` 却没有 checkout。

**刻意不用 PyYAML**：workflow 语法里有一批 GitHub 专有写法（`${{ }}` 表达式、`on:` 被 YAML 1.1 解析成布尔值、多行 `run: |` 块），通用解析器更容易误报。这个检查器自己也会被 CI 跑，所以它有**双向**要求 —— 不能误报（一个误报就让每个 PR 的 CI 都红，最后的结果只能是把它删掉），也不能漏报。两类都有测试兜住。

### 3.4 CI：`quality-check.yml` 新增 `scripts-checks` job

`python3 scripts/check-workflow-yaml.py` + `python3 -m unittest discover -s scripts -p 'test_*.py' -v`，随每个 PR 运行。

### 3.5 无 schema / 无前端变更

本项不碰 SQLite、不碰 Rust、不碰前端、不碰 MCP 双实现 —— 纯仓库工程自动化。

## 4. 数据 / Schema 变更

无。

## 5. 测试 / 验收

### 5.1 单测（70 例，`python3 -m unittest discover -s scripts -p 'test_*.py'`）

| 文件 | 例数 | 覆盖 |
|---|---|---|
| `test_merge_cleanup.py` | 37 | `extract_issue_refs` 21 例（关键词、多引用、去重保序、中文关键词、**汉字前缀的中文关键词**、助词隔断不匹配、关键词不得按子串匹配、sha/ref 路径碎片、超大编号、前导零、真实 PR 正文回放）+ dry-run 走完整 `main()` 8 例（argparse 属性名、事件负载读取、fork 跳过、`test`/`draft` 标记跳过、无引用跳过、含斜杠分支名）+ **`ref_head_path()` 4 例与打桩后的非 dry-run 删分支路径 4 例**（#289 追加） |
| `test_workflow_yaml.py` | 33 | 正向回归（仓库现存 6 个 workflow 必须全部通过）+ 反向验证（每类声称能拦的缺陷都断言「一定会被标记」）+ 解析器单测 |

### 5.2 开发过程中被拦下的真实缺陷

这些不是演练 —— 全是本次真写出来的 bug，靠上面两层测试与提交前 review 才没进 CI。
**唯一例外是最后一行**：它带着 62 个全绿的单测合进了 `develop`，直到 PR #287 真实合并后才暴露，见
[#289](https://github.com/ShawnLiuSZ/task-dashboard/issues/289)。

| 缺陷 | 如何被拦下 |
|---|---|
| `args.dry-run`（应为 `args.dry_run`） | Python 把它解析成 `args.dry - run` → `AttributeError`。纯逻辑单测覆盖不到 `main()`，只有 dry-run 集成测试才触发 |
| `check-workflow-yaml.py` 的 `rest = s[len(key):]` 把冒号留在 value 里 | `if: >-` 的 value 变成 `": >-"`，块标量 / 空值 / 步骤检测全失效 → 初版对全部 6 个 workflow 报 30 处误报 |
| `on_block` / `jobs` 在每个顶层 key 处被重置 | 循环结束后恒为空 → 每个文件都报「没有触发事件」「没有 job」 |
| step 子键（ind 8）被记到 `job.keys` | `- name: X` + `uses:` 两步式写法全部误判「空步骤」+「重复 key」 |
| `run: |` 在标记 `has_run` 之前被 flush | `release.yml` 里 `- name:` / `if:` / `env:` / `run: \|` 的步骤被误判空步骤 |
| 块标量内强制偶数缩进 | `if: >-` 的续行常故意用非偶数缩进做视觉对齐，属合法格式 |
| `USE_RE` 不匹配 `- uses:` 列表项形式 | 本仓库最常用的内联写法从未被校验过版本固定 |
| `strip_comment` 用 `line[i:i+3] == "}}"` | `}}` 只有 2 字符，3 字符切片永不相等 → 只有 `}}` 恰好落在行尾时表达式深度才复位，「表达式内的 `#` 不当注释」只在行尾成立 |
| `merge-cleanup.yml` 缺 `actions/checkout` | runner workspace 默认是空的，会以 file not found 静默失败 |
| `CLOSE_RE` 用 `\b` 做词边界 | 汉字都是 `\w`，「已关闭 #284」永远匹配不上 —— 新增 `test_chinese_keyword_after_cjk_prefix` |
| 删分支对同一端点发两次 GET（`ref_exists` + `head_ref_at`） | 代码 review 时发现，合并为单次请求的 `head_branch()`，同时省一次网络往返 |
| **DELETE 用了单数 `/git/ref/` 端点**（#289，**唯一漏网**） | **没被拦下**：单数路径只有 GET 路由、没有 DELETE 路由，DELETE 恒 404；而 GET 对单复数都能路由，于是「分支存在 + sha 比对」全部照常有通过、走完所有护栏后才在 DELETE 那一步 404 —— **读路径把写路径的缺陷完全掩盖**。dry-run 全程不打网络，所以 62 个单测全绿也拦不住。修复见 §5.5 |

### 5.3 本地验证

```bash
python3 -m unittest discover -s scripts -p 'test_*.py'     # 70 例 OK（#289 追加 8 例后）
python3 scripts/check-workflow-yaml.py                       # 6 个 workflow 全绿
python3 scripts/check-mcp-columns.py                         # 26 列两侧一致
python3 scripts/check-doc-links.py                           # 135 个 markdown 无断链
```

dry-run 四场景实测（`GITHUB_EVENT_PATH` 指向构造的 PR 事件负载）：正常路径删分支 + 关 `#284`；fork 源分支跳过删分支但仍关 issue；标题含 `test` 跳过删分支；正文仅裸引用 `#155` 时不关任何 issue。退出码均为 0，全程无网络调用。

### 5.4 反向验证要求

改 `CLOSE_RE` 放宽成裸 `#N` 匹配时，`test_body_bare_ref_ignored` 与
`test_realistic_pr_body_only_closes_declared_issue` 必须失败。这是「误关 issue」防线的唯一保障，不得删除或放松。

把 `ref_head_path()` 退回单数 `/git/ref/` 端点时，`RefPathTest` 的 3 个用例与
`BranchDeleteFlowTest.test_deletes_via_plural_refs_endpoint` 必须失败（实测 5 例失败）。
这是「删分支真的能删掉」的唯一保障，不得删除或放松。

### 5.5 首个真实合并暴露的删分支 404（#289 已修）

PR #287 合并后 workflow 首次真实运行：issue 关闭成功（#284 已 CLOSED），**但删分支失败**——
runner 日志报 `::warning::删除分支 feature/issue-284-merge-cleanup 失败（HTTP 404）`，远端分支仍在。

根因见 §5.2 最后一行。删 ref 的正确端点是**复数** `/git/refs/heads/{branch}`。
对真实分支逐一实测的结论：

| 请求 | 结果 |
|---|---|
| `GET /git/ref/heads/a/b`（未编码） | ✅ 200，返回 sha |
| `GET /git/ref/heads/a%2Fb`（编码） | ✅ 200，返回 sha |
| `DELETE /git/ref/heads/a/b`（**原代码**） | ❌ 404，分支仍在 |
| `DELETE /git/ref/heads/a%2Fb`（原代码 + 编码） | ❌ 404，分支仍在 |
| `DELETE /git/refs/heads/a%2Fb` | ✅ 204，分支已删 |
| `DELETE /git/refs/heads/a/b` | ✅ 204，分支已删 |
| `DELETE /git/refs/heads/<已删分支>` | 422 Unprocessable Entity（**非 404**） |

修法：抽出 `ref_head_path()` 纯函数，GET 与 DELETE **共用同一路径**（复数 `/git/refs/heads/`，
保留 `/` 不编码——该端点实测对编码与未编码的 `/` 都接受，保留字面 `/` 便于日志直接读出分支名）。
另注意复数端点对「已不存在的 ref」返回 **422 而非 404**，代码里 `status in (200, 204)` 的判断
已能把它正确归入失败分支。

新增测试：`RefPathTest` 4 例（含显式反向断言路径里不得出现 `/git/ref/`）+
`BranchDeleteFlowTest` 4 例（`mock.patch.object` 打桩 `api`，零真实网络，跑**非 dry-run** 的删分支
五条路径：端点正确 / sha 不匹配保留分支 / 分支已不存在 / DELETE 失败只告警且不影响关 issue）。

真机端到端复验：建临时分支 `probe/merge-cleanup-verify`（指向 `develop` tip），用修复后的脚本以
非 dry-run 跑，输出 `已删除源分支 probe/merge-cleanup-verify`，`git ls-remote` 确认远端已清空，退出码 0。
用于实测的探针分支 `tmp/ref-delete-probe`、`tmp/ref-delete-probe2` 测完已删除。

## 6. 相关链接

- Issue：[#284](https://github.com/ShawnLiuSZ/task-dashboard/issues/284)
- 实现：[`.github/workflows/merge-cleanup.yml`](../.github/workflows/merge-cleanup.yml)、[`scripts/merge-cleanup.py`](../scripts/merge-cleanup.py)
- 配套检查器：[`scripts/check-workflow-yaml.py`](../scripts/check-workflow-yaml.py)
- 单测：[`scripts/test_merge_cleanup.py`](../scripts/test_merge_cleanup.py)、[`scripts/test_workflow_yaml.py`](../scripts/test_workflow_yaml.py)
- CI：[`.github/workflows/quality-check.yml`](../.github/workflows/quality-check.yml) 的 `scripts-checks` job
- 更新记录：[docs/CHANGELOG.md](./CHANGELOG.md)

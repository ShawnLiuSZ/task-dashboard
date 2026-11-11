# CI 供应链安全加固：SHA 固定 / persist-credentials / 脚本注入 / 关闭词收紧（#539）

## 背景 / 动机

2026-11-09 一次全仓安全审计发现 5 项问题，集中在 **CI/发布供应链**与 `merge-cleanup` 脚本。最严重的一项（VULN-01）：`release.yml` 构建过程持有 `TAURI_SIGNING_PRIVATE_KEY` + `contents:write`，而它依赖的全部第三方 action（`actions/checkout`、`dtolnay/rust-toolchain`、`tauri-apps/tauri-action` …）都引用**可变 tag / 分支**（`@v5` / `@stable` / `@v1`）。上游一次 push / 移动 tag 就能换掉我们 CI 里执行的代码 —— **投毒可致恶意签名安装包通过 updater 验签**，且不会在本仓库留下任何 diff 痕迹。

详见 issue #539 的发现清单（VULN-01 ~ VULN-05）。

> 本仓 CI 此前**只有一个**会碰 `.github/workflows/` 的检查 `scripts/check-workflow-yaml.py`（#284/#329 建），但它对「版本固定」只 denylist 了 `main`/`master` 这类**浮动分支名**，拦不住 `@v5` / `@stable` —— 等于 VULN-01/02/04 既没修、也没有 CI 防回归。本次一并补上这层门禁。

## 设计 / 方案

四类改动，逐项对应审计发现：

### 1. 全部第三方 action 固定到完整 40 位 commit SHA（VULN-01）

把 6 个 workflow 里 27 处第三方 `uses:` 全部从 tag / 通道改成 SHA。用 GitHub API `GET /repos/{repo}/commits/{ref}` 解析出每个 tag 当前的 commit：

| action | 旧 ref | 固定到的 SHA |
|---|---|---|
| `actions/checkout` | `@v5` | `fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09` |
| `actions/setup-node` | `@v5` | `a0853c24544627f65ddf259abe73b1d18a591444` |
| `actions/setup-python` | `@v6` | `ece7cb06caefa5fff74198d8649806c4678c61a1` |
| `dtolnay/rust-toolchain` | `@stable` | `b725eda525362e7cf34af9a7243cac1e3f01a7ec` |
| `swatinem/rust-cache` | `@v2` | `d1527c8f67ef9af357290475d4af4b0fab8f12e0` |
| `tauri-apps/tauri-action` | `@v1` | `1deb371b0cd8bd54025b384f1cd735e725c4060f` |

本地 action（`./.github/actions/install-linux-deps`）随本仓代码走，**豁免**。`dtolnay/rust-toolchain@stable` 虽是该 action 官方推荐的「通道」写法，但仍属可变引用 —— 一并固定（`@stable` 现会被 linter 打红，见下方门禁）。

### 2. `actions/checkout` 在 `with:` 内显式 `persist-credentials: false`（VULN-02）

`actions/checkout` 默认把 `GITHUB_TOKEN` 持久化进 runner 的 `.git/config`，任何后续构建脚本都能读到。给全部 **11 处** checkout step 加 `persist-credentials: false`，写权限 token 不再落盘。

> ⚠️ **关键坑（本次实测踩到）**：`persist-credentials` 是 `actions/checkout` 的**输入**，必须写在 step 的 `with:` 块内 ——
>
> ```yaml
> - uses: actions/checkout@<sha>
>   with:
>     persist-credentials: false   # ✅ 正确：with: 块内的输入
> ```
>
> 误写成 **step 层级**（与 `uses:` 同级、没有 `with:` 包裹）是**无效字段**：
>
> ```yaml
> - uses: actions/checkout@<sha>
>   persist-credentials: false      # ❌ 错误：GitHub 会拒绝解析整个 workflow
> ```
>
> 这种写法**本地 YAML 解析器不报错**（Ruby / Node yaml 都当普通映射解析通过），但 GitHub Actions 会**解析失败**：run name 退化为文件路径（`.github/workflows/x.yml`）、`on:` 失效、所有 event 都触发、0 jobs 直接 failure。只有真推送才暴露。首版实现踩了此坑，已修正为 `with:` 形式，并在 linter + 单测双向锁死。

### 3. `tag_name` 经 `env:` 中转，不内插进 `run:`（VULN-04）

`release.yml` 的 `updater-check` job 原先把 `${{ github.event.release.tag_name || github.ref_name }}` 直接内插进 `run:` shell。改为先落到 `env:`，shell 里只引用 `$RELEASE_TAG`：

```yaml
env:
  RELEASE_TAG: ${{ github.event.release.tag_name || github.ref_name }}
run: >-
  python3 scripts/check-updater-manifest.py
  --tag "$RELEASE_TAG"
```

（exploitability 本身低 —— release tag 名由维护者发布、GitHub 还会对 tag 名做 `git check-ref-format` 校验拒绝 shell 元字符 —— 但作为纵深防御 + 门禁一致性仍应修。）

### 4. 关闭关键词收紧：`Refs` / `References` 不再关闭 issue（VULN-05）

`scripts/merge-cleanup.py` 的 `CLOSE_RE` 原先把 `refs?|references?` 也算进**关闭**词。但 GitHub 原生语义里 `Refs #N` 只是「引用」，**不触发关闭**。关闭比引用强得多且**误关无法撤销**，故从关闭词交替里移除 `refs?|references?`，只保留 `closes?/closed/fixes?/fixed/resolves?/resolved` + 中文「关闭 / 解决 / 修复」。

> ⚠️ **行为变更**：此前 `Refs #284` 的 PR 正文会在合并后关掉 #284；现在不会。这**放松**了关闭判定（更贴合 GitHub 原生），3 处既有单测锁的是旧行为，已随本次一并更新（见「测试 / 验收」）。经需求方确认（`确认`）后执行。

### 5. VULN-03 回归守护：显式传 `--head-repo`

审计的 VULN-03（fork 分支跳过是死代码）**在本次之前已修**：`merge-cleanup.py` 会从事件负载读 `head.repo.full_name`，fork PR 据此跳过删分支。但 workflow 此前**未显式**传 `--head-repo`，靠脚本内部兜底。本次在 `merge-cleanup.yml` 显式接上 `HEAD_REPO: ${{ github.event.pull_request.head.repo.full_name }}` → `--head-repo "$HEAD_REPO"`，让这条防回归路径**在 workflow 层可见**。

### 6. 扩展 `check-workflow-yaml.py` 防回归（VULN-01/02/04 的门禁）

给既有 linter 加三类判定，把上面 1/2/3 变成 **CI 强制**（否则修完还会悄悄回退）：

| 判定 | 规则 | 取代 / 新增 |
|---|---|---|
| **SHA 固定** | 第三方 `uses: owner/repo@ref` 的 `ref` 必须 `^[0-9a-fA-F]{40}$` | **取代**旧 `FLOATING_REF_RE` denylist（只拦 `main`/`master`，拦不住 `@v5`）—— 已删该死代码 |
| **persist-credentials** | 每个 `actions/checkout@*` step 必须在 `with:` 块内显式 `persist-credentials: false`（写在 step 层级是无效字段，不计；`true` 与缺省都报） | 新增 |
| **run 内插** | `run:`（内联值 + 块标量体）里出现 `github.event.*` / `github.ref_name` / `github.head_ref` 即报，提示经 `env:` 中转 | 新增 |

**反误报边界（#329「双向要求」惯例）**：`secrets.*` / `env.*` / `matrix.*` / `runner.*` / `github.token` / `github.sha` 等运营方或 GitHub 控制的 context **不**禁止；`with:` 里的内插不在 `run:` 范围内、不报；本地 action 豁免 SHA。每一类都同时有「正向不报」与「反向必报」两组用例。

## 接口 / 行为变更

- **CI 行为**：`check-workflow-yaml.py` 新增 3 类报错。今后任何 PR 引入可变 tag / 缺 persist-credentials / `run:` 内插攻击者 context 都会**让 CI 变红**。
- **merge-cleanup 行为**（⚠️ 用户可见）：`Refs #N` / `References #N` 的 PR 正文**不再关闭** #N。只认 `Closes/Fixes/Resolves`（+中文关闭/解决/修复）。标题里的 `#N`（`TITLE_REF_RE`）仍照旧提取。
- **无** Tauri command / MCP 工具 / DB schema 变更。纯 CI + Python 脚本层。

## 数据 / Schema 变更

无。

## 测试 / 验收

模式：**先测后写**（AC 测试 `scripts/test_ac539.py` 先红后绿，隔离子代理编写，`ac_lock.py` 锁测试文件）。运行器 `python3 -m unittest discover -s scripts -p 'test_*.py'`。

| AC | 内容 | 结果 |
|---|---|---|
| AC1 | 第三方 action 全 SHA 固定；`@v5`/`@stable`/`@v2`/`@main` 被标记；本地 action 豁免 | ✅ 2026-11-11 |
| AC2 | 每个 checkout 在 `with:` 内显式 `persist-credentials: false`（11/11）；`true`/缺省/**误写在 step 层级**都被标记 | ✅ 2026-11-11 |
| AC3 | `run:` 内插 `github.event.*`/`ref_name`/`head_ref` 被标记；`secrets.*`/`env.*` 不误报 | ✅ 2026-11-11 |
| AC4 | linter 对真实 7 个 workflow 退出 0（防误报） | ✅ 2026-11-11 |
| AC5 | 3 类判定的正向不报（`env:`/`secrets:`/`with:`/本地 action） | ✅ 2026-11-11 |
| AC6 | `Refs`/`References` 不再关闭；`Closes/Fixes/Resolves` 仍关闭 | ✅ 2026-11-11 |
| AC7 | 3 类各自反向必报（合成坏 workflow） | ✅ 2026-11-11 |
| VULN-03 guard | `merge-cleanup.yml` 显式传 `--head-repo` | ✅ 2026-11-11 |

- `scripts/test_ac539.py`：23 条 AC 用例全绿。
- 全 Python 套件：**174 条，OK（跳过 1）**。
- `check-workflow-yaml.py` 对真实 7 个 workflow：退出 0。
- 其余门禁 `check-mcp-columns` / `check-doc-links` / `check-versions` / `check-capabilities`：全 PASS。

**既有测试的更新（非 weakening）**：
- `test_merge_cleanup.py::test_case_insensitive_and_extra_whitespace` — `REFS #42` 断言从 `[42]` 改为 `[]`（AC6 行为变更的本意）。
- `test_workflow_yaml.py` — `VALID` 骨架的 checkout 改为 SHA + persist-credentials（满足新增门禁）；`test_toolchain_channel_ref_is_legal` → `_is_flagged`（`@stable` 现必报）；`test_pinned_ref_is_not_flagged_as_floating` → `test_full_sha_ref_is_not_flagged`（只有 40 位 SHA 豁免，`v5`/`v4.2.2` 现必报）。这些是**加强**断言以匹配更严的 AC1，不是放松。

## 相关链接

- Issue：#539（含 VULN-01 ~ VULN-05 完整发现清单）
- 关联：#284 / #329（`check-workflow-yaml.py` 的建立与「双向要求」惯例）、#120 / #119（CI action 升级史）
- 改动面：`.github/workflows/{release,quality-check,docs-check,i18n-check,mcp-schema-check,merge-cleanup}.yml`、`scripts/check-workflow-yaml.py`、`scripts/merge-cleanup.py` + 两个既有测试文件

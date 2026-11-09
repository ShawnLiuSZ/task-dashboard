# 全仓安全审计修复（#539）

## 背景 / 动机

2026-11-09 对全仓做了一次安全审计（security review），覆盖 `app/src-tauri/src`（Rust 后端）、
`app/src`（React webview）、`mcp_server/server.py`、`scripts/`、全部 7 个 GitHub Actions workflow、
`tauri.conf.json`/capabilities。结论：**核心攻击面（SQL 注入、前端 XSS、浏览器 URL 白名单、
SSRF、令牌泄露路径、MCP 输入）均已正确防护**；问题集中在 **CI / 发布供应链** 与
merge-cleanup 脚本，共 5 项（VULN-01 ~ VULN-05）。

| 编号 | 严重度 | 问题 | 位置 |
|---|---|---|---|
| VULN-01 | High | 第三方 action 未固定到 commit SHA（`dtolnay/rust-toolchain@stable` 实测是**未保护分支**而非 tag） | 全部 workflow |
| VULN-02 | Medium | `actions/checkout` 未设 `persist-credentials: false`，写权限 token 持久化进 `.git/config` | release.yml / merge-cleanup.yml |
| VULN-03 | Medium | merge-cleanup 的 fork 分支跳过是死代码（`head_repo` 从不读事件负载） | merge-cleanup.py / merge-cleanup.yml |
| VULN-04 | Low | release.yml:183 把 `tag_name` 直接内插进 `run:` shell（未走 env 中转） | release.yml |
| VULN-05 | Low | merge-cleanup 关闭 issue 语义强于 GitHub 原生（裸 `#N` 与 `Refs #N` 也关闭） | merge-cleanup.py |

## 设计 / 方案

**VULN-01**：全部第三方 `uses:` 固定到 40 位 commit SHA（`git ls-remote` 实测解析各自 ref 的
当前 commit）：

| action | 原引用 | 固定到 |
|---|---|---|
| `actions/checkout` | `@v5` | `fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09` |
| `actions/setup-node` | `@v5` | `a0853c24544627f65ddf259abe73b1d18a591444` |
| `actions/setup-python` | `@v6` | `ece7cb06caefa5fff74198d8649806c4678c61a1` |
| `dtolnay/rust-toolchain` | `@stable` | `b725eda525362e7cf34af9a7243cac1e3f01a7ec` |
| `swatinem/rust-cache` | `@v2` | `d1527c8f67ef9af357290475d4af4b0fab8f12e0` |
| `tauri-apps/tauri-action` | `@v1` | `1deb371b0cd8bd54025b384f1cd735e725c4060f` |

本地 action（`./.github/actions/install-linux-deps`、`./.github/workflows/*`）与 `docker://` 不适用。

**VULN-02**：`release.yml`（构建 job + updater-check job）与 `merge-cleanup.yml` 的
`actions/checkout` 加 `with: persist-credentials: false`。已核实本仓无 `git+https` 依赖
（`package-lock.json` / `Cargo.toml`），tauri-action 走 env `GITHUB_TOKEN`、merge-cleanup.py
走 `GH_TOKEN` env，均不依赖 git credential helper ⇒ 改 `false` 不破坏构建。

**VULN-03**：`merge-cleanup.py` 的 `head_repo` 改为**从事件负载读取**
`pull_request.head.repo.full_name`（此前 `or args.repo` 恒为同仓库 ⇒ fork 跳过是死代码）；
workflow 增加 `HEAD_REPO` env 并传 `--head-repo "$HEAD_REPO"`。

**VULN-04**：`release.yml:183` 改为 `env: RELEASE_TAG: ${{ ... }}` + `--tag "$RELEASE_TAG"`
（与本仓其它 workflow 的既有 env 中转做法一致）。

**VULN-05**：`merge-cleanup.py` 收紧 `extract_issue_refs`：
- 标题只认**括号主旨引用** `(#N)`（本仓库标题惯例 `... (#284)`）；标题里其它裸 `#N`
  （如 `Revert workaround for #123 (#456)` 的 #123）不再触发关闭。
- 正文 `CLOSE_RE` 去掉 `refs?` / `references?` —— GitHub 原生 `Refs` 只交叉引用、不关闭，
  此前比平台更激进。

**防回归守卫**（`scripts/check-workflow-yaml.py` 新增 3 项，随本次修复一起生效）：
- 第三方 action 必须 `@<40位sha>`（`FULL_SHA_RE`），取代原「少数浮动分支名 denylist」。
- `run:`（含块标量）里直接内插 `${{ }}` 报错（应走 `env:` 中转）。
- 声明了任一 write scope 的 workflow，其 `actions/checkout` 必须 `persist-credentials: false`。

## 接口 / 行为变更

- `.github/workflows/*.yml`：`uses:` 引用全部改为固定 SHA（注释保留原 tag 名便于追溯）；
  无 schema / 权限变更。
- `merge-cleanup.py`：新增 `--head-repo` 从事件负载读取的兜底；`extract_issue_refs` 收紧后，
  `Refs #N` 与标题裸 `#N` 不再关闭 issue（**行为收紧**，需在 PR 描述与 CHANGELOG 说明）。
- `check-workflow-yaml.py`：更严格 —— 现有 7 个 workflow 全部通过（已实测）。

## 数据 / Schema 变更

无（未触及 SQLite schema）。

## 测试 / 验收

- `python3 -m unittest discover -s scripts -p 'test_*.py'`：全部通过（含 43 项 merge-cleanup、
  56 项 workflow 检查器）。
- `python3 scripts/check-workflow-yaml.py`：7 个真实 workflow 全部通过。
- 新增/更新用例：
  - `test_merge_cleanup.py`：`test_refs_is_not_a_closing_keyword`、`test_title_bare_ref_not_closed`、
    `test_title_requires_parenthesis`、`test_dry_run_fork_skips_delete_from_payload`；
    更新 `test_realistic_pr_body_only_closes_declared_issue`。
  - `test_workflow_yaml.py`：`SecurityGuardTest`（persist-credentials 正反向、run 内插正反向、
    env 中转零误报）、`test_movable_tag_ref_is_flagged`、`test_full_sha_ref_passes`、
    `test_toolchain_channel_ref_is_flagged`；更新 `VALID` 夹具与 `test_unpinned_*` /
    `test_local_action_not_flagged` / `test_missing_checkout_*`。

## 相关链接

- 审计报告：2026-11-09 全仓安全审计（VULN-01 ~ VULN-05）
- Issue：`#539`
- 分支：`fix/issue-539-security-review`
- 涉及文件：`.github/workflows/{release,merge-cleanup,docs-check,i18n-check,mcp-schema-check,quality-check}.yml`、
  `scripts/{merge-cleanup.py,check-workflow-yaml.py}`、`scripts/test_{merge_cleanup,workflow_yaml}.py`

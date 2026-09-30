# issue #336 — CI 门禁盲区 + 操作类文档 `develop` 漂移 + 旧仓库名拼写残留

> 关联：[GitHub Issue #336](https://github.com/ShawnLiuSZ/task-dashboard/issues/336)、[CHANGELOG.md](./CHANGELOG.md)
> 分支：`chore/issue-336-docs-ci-reality-alignment` → PR 到 `main`

## 背景 / 动机

三处独立但与同一件事（**仓库现状与文档 / CI 不一致**）同源的遗留，合并处理。共同前提：`develop` 集成分支**已废弃并从远端删除**（2026-09-30 核实，`git fetch origin develop` 报 `couldn't find remote ref develop`；远端仅剩 `main` + 若干历史 `release/*`）。

### ① `quality-check.yml` 门禁盲区

```yaml
on:
  pull_request:
    branches: [develop, main]
  push:
    branches: [develop]     # ← develop 已不存在
```

`push` 只挂 `develop` ⇒ **直接 push 到 `main` 完全跳过重型门禁**（clippy / `cargo fmt --check` / `vite build` / `check-versions.py` / `scripts` 单测），只有 base = `main` 的 PR 才跑。这是 #330 刚加固完门禁后留下的缺口。

### ② 操作类文档按「集成分支 = `develop`」描述

| 文件 | 处数 | 内容 |
|---|---|---|
| `AGENTS.md` | 8 | §2.3 标题与正文、§6.1 分支表（含 `@develop260905` 示例）、§6.2 硬规则 1、§6.3 PR 流向表（3 行）与常规流程段、§8 第 1 条 |
| `CONTRIBUTING.md` | 2 | 分支清单、禁止直接推送 |
| `mcp_server/AGENT_INSTRUCTIONS.md` | 5 | 「开始处理」表格、切分支纠正表格、#279 根因段、示例代码 2 处 |
| `mcp_server/AGENT_INSTRUCTIONS.en.md` | 5 | 同上（英文） |
| `.claude/commands/task-start.md` | 4 | 分支创建命令与三条说明 |
| `.opencode/commands/task-start.md` | 2 | 分支创建说明与兜底段 |
| `README.md` | 1 | `release-backmerge-policy` 索引 bullet 的描述文案 |
| `app/src-tauri/src/{mcp,commands,common}.rs`、`mcp_server/server.py` | 6 | `set_work_branch` 的文档注释与**工具 description**（对 agent 可见）里以 `develop/master` 举例基线分支 |

**为什么必须改**：这些不是历史叙述，而是**指导下一步动作的指令**。照错做会直接产生错误分支（例如从已不存在的 `develop` 开分支），且 `mcp.rs` / `server.py` 的 tool description 会把错误基线喂给每一个调用 MCP 的 agent。

`docs/release-backmerge-policy.md` 全文建立在「release 后把 `main` 回合 `develop`」之上，该约定随之失效。按 `AGENTS.md §5.5`「旧文档被取代需在顶部标注」，加**失效横幅**并保留正文作历史记录，不做内容重写。

### ③ 旧仓库名 `task-dashborad` 拼写残留

仓库 2026-09-06 由 `task-dashborad` 改名为 `task-dashboard`，两篇知识库文档的关联链接仍是旧名：`docs/issue-52-custom-column-mapping.md`（2 处）、`docs/issue-62-bug-audit-fixes.md`（2 处）。GitHub 对改名仓库保留重定向，链接目前可用，属**陈旧**而非断链。

顺带修掉 `docs/issue-279-work-branch-not-updated.md` 两条 `blob/develop/…` 绝对外链 —— 它们随 `develop` 删除已成 404（属**真断链**，`check-doc-links.py` 只校验相对链接，覆盖不到）。

## 设计 / 方案

### 边界：改什么、不改什么

判断标准是**「这段文字是否指导未来的动作」**：

| 类别 | 处理 | 例子 |
|---|---|---|
| 操作类指令（agent / 协作者据此执行） | **必须改** | `AGENTS.md` §6.3 PR 流向表、`AGENT_INSTRUCTIONS` 的分支创建示例、MCP tool description |
| 历史知识库文档 | **保持原样** | `docs/issue-*.md` 中「2026-09-06 对 develop 做三路排查」——描述的是当时的实况，是**正确**的历史记录 |
| 工具的能力描述 | **保持原样** | `scripts/merge-cleanup.py` 的 `base ∈ {develop, main}`、`check-workflow-yaml.py` 的浮动分支名单——工具本就该同时支持两种 base |

`docs/release-backmerge-policy.md` 介于前两类之间：它是**策略文档**（指导动作）但记录的是已发生的事。故加失效横幅 + 保留正文，而非删除或重写。

### 具体改动

1. `.github/workflows/quality-check.yml`：`push.branches` 补 `main`（保留 `develop` 仅为兼容可能存在的历史分支）。
2. 全部操作类文档的「从 `develop` 新开」→「从 `main` 新开」；`develop/master` 基线举例 → `main`。
3. `AGENTS.md` §6.1 分支表删除「集成分支」行，改为「唯一长驻分支」并附历史说明；§6.3 删除 `develop → main` 发版行，常规流程改为单主干。
4. `docs/release-backmerge-policy.md` 顶部加失效横幅，指向 `AGENTS.md` 的现行约定，并按 §5.5 声明保留周期。
5. 旧仓库名 4 处修正 + `blob/develop` 2 处死链改 `blob/main`。

## 接口 / 行为变更

| 项 | 变更 |
|---|---|
| CI 触发 | `quality-check.yml` 在 **push 到 `main`** 时开始运行（此前只有 base=`main` 的 PR 会跑） |
| MCP 工具 | **无签名变更**。仅 `set_work_branch` 的 description 文案把基线分支举例由 `develop/master` 改为 `main`（对 agent 可见，属纠正性文案） |
| 运行时行为 | 无。改动均为文档 / CI 配置 / 注释 |
| i18n / schema / `SELECT_COLS` | 无变更 |

## 数据 / Schema 变更

无。

## 测试 / 验收

| 检查 | 结果 |
|---|---|
| `python3 scripts/check-workflow-yaml.py` | ✅ 6 文件（含改后的 `quality-check.yml`） |
| `python3 scripts/check-doc-links.py` | ✅ 无断链 / 无 `file://` / 无行号锚点 / 无孤岛 |
| `python3 scripts/check-mcp-columns.py` | ✅ 28 列一致（本轮改了 `mcp.rs` / `server.py` 的注释与 description，列清单未动） |
| `python3 scripts/check-versions.py` | ✅ 0.6.5 |
| `python3 -m unittest discover -s scripts` | ✅ |
| `cargo fmt --check` / `cargo clippy --lib -- -D warnings` | ✅ |
| `cargo test --lib` / `--test db_test` | ✅ |
| `python3 -m unittest discover -s mcp_server` | ✅ |

### 验收口径：全仓库检索 `develop` 后允许出现的位置

剩余出现位置应**只**属于下列三类，出现其他位置即为漏改：

1. 历史知识库文档（`docs/issue-*.md`、`docs/bug-audit-*.md`）与 CHANGELOG 的历史版本条目；
2. 工具的能力描述与测试夹具（`scripts/merge-cleanup.py` 的 `base ∈ {develop, main}`、`check-workflow-yaml.py` 的浮动分支名单、`test_merge_cleanup.py` / `test_workflow_yaml.py` 的 fixture）；
3. `quality-check.yml` 中为兼容历史分支而保留的 `develop`。

## 相关链接

- 上游批次：[`docs/issue-330-p3-quality-gates.md`](./issue-330-p3-quality-gates.md)（CI 门禁加固，本轮补其遗留缺口）、[`docs/issue-279-work-branch-not-updated.md`](./issue-279-work-branch-not-updated.md)（基线分支录错的原始修复）
- 失效文档：[`docs/release-backmerge-policy.md`](./release-backmerge-policy.md)（已加失效横幅）
- 现行约定：[`AGENTS.md`](../AGENTS.md) §2.3 / §6.1 / §6.3

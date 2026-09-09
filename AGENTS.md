# AGENTS.md — TaskBoard（跨 agent 项目指令）

> **本文件是所有 AI agent 在本仓库工作时必须遵守的共享规则。**
>
> 各 agent 的入口文件：
> - **Claude Code** → [`CLAUDE.md`](./CLAUDE.md)（自动加载）
> - **GitHub Copilot** → [`.github/copilot.instruction.md`](./.github/copilot.instruction.md)（自动加载）
> - **Codex / OpenCode / Cursor / Aider / 其他** → 直接加载本文件
>
> MCP 工具契约与触发规则（所有 agent 共用）：
> [`mcp_server/AGENT_INSTRUCTIONS.md`](./mcp_server/AGENT_INSTRUCTIONS.md)

---

## 1. 项目是什么

**TaskBoard** = 纯本地跨平台桌面应用（Windows / macOS / Linux，Tauri 2）。

- 前端：`app/src/`（React + TS + Vite）
- 后端：`app/src-tauri/src/`（Rust + rusqlite）
- 数据存储：本地 SQLite，**绝不写回 GitHub**
- GitHub 角色：**只读**任务来源（issue / 分配 / @提及）

数据流向（单向，**任何反向都是 bug**）：

```
GitHub (只读)  ──>  本地 SQLite (读写)  ──>  UI / MCP
```

---

## 2. 硬约束（任何 agent 都不得违反）

### 2.1 产品约束：不写回 GitHub（指 TaskBoard 同步方向）

> 本节是对本项目（TaskBoard 应用）行为的描述，不是 agent 协作禁令。

- TaskBoard 运行时只从 GitHub 只读拉取（Search / REST / GraphQL），绝不调用写 GitHub 的 API。
- 看板状态、session id、handoff **只**写本地 SQLite `taskboard.db`，绝不映射写回 issue / label / Project / 评论。
- 数据流向单向：`GitHub (只读) ──> 本地 SQLite ──> UI / MCP`，任何反向同步都是 bug（见 `sync.rs`）。

Agent 协作默认：

- 诊断 / 排查默认用 `gh` 只读命令。
- 看板状态变更走本地 MCP 工具（`update_task_status` 等），不通过改 GitHub label / state 实现。
- 维护者明确要求起草或修改 issue 正文、PR 描述、评论等协作文字时，允许执行；仍禁止把看板状态写回 GitHub。

数据库路径（macOS）：`~/Library/Application Support/com.shawnliu.taskboard/taskboard.db`
可用环境变量 `TASKBOARD_DB` 覆盖。

### 2.2 看板状态四态（本地权威）

| 英文键 | 中文 | 说明 |
|---|---|---|
| `todo` | 待处理 | 默认 |
| `doing` | 处理中 | 有人正在做 |
| `processed` | 已处理 | 做了但未关闭 |
| `done` | 已完成 | 关闭 / 完成 |

**同步优先级**（`app/src-tauri/src/sync.rs`，仅同步路径适用）：

```
1. gh_state == "closed"      → done     # 远程权威覆盖
2. Label → Status 映射命中   → 映射结果
3. gh_status (Project Status) → 映射到四态
4. 保持既有本地状态           → 不变     # 手动态不被覆盖
5. 默认                       → todo
```

### 2.3 不在 `main` / `develop` 直接开发

所有改动必须从 `develop`（或 `main`，仅 hotfix）新开分支，通过 PR 合入。

### 2.4 每功能 / 每修复必建知识库文档

详见第 5 节。**不允许「只改代码不写文档」**。

### 2.5 不引入新依赖

能不引入就不引入；新增 crate / npm 包前先确认是否已有等价能力。

---

## 3. 仓库结构

| 路径 | 内容 |
|---|---|
| `app/src/` | 前端 React + TS + Vite |
| `app/src-tauri/src/` | 后端 Rust + rusqlite |
| `app/src-tauri/src/mcp.rs` | 内置 MCP Server（v0.3.12+，随 app 二进制打包） |
| `mcp_server/server.py` | MCP Server 便携 / 开发兜底（Python 标准库） |
| `docs/` | 设计文档 + **知识库（每功能 / 修复必建）** + CHANGELOG |
| `PRD.md` | 需求与决策演进 |
| `README.md` / `README.en.md` | 项目简介、构建、用法入口（不放版本更新、不放设计细节） |
| `CLAUDE.md` | Claude Code 入口 |
| `AGENTS.md` | **本文件**：跨 agent 共享规则 |
| `.github/copilot.instruction.md` | GitHub Copilot 入口 |
| `mcp_server/AGENT_INSTRUCTIONS.md` | MCP 工具契约与触发规则 |

---

## 4. 构建、测试、检查

### 4.1 本地开发

```bash
cd app
npm install            # 首次安装前端依赖
npm run tauri dev      # 开发模式（前端热更新）
npm run tauri build    # 产出当前平台的 release 安装包
```

产物位置：`app/src-tauri/target/release/bundle/{macos,debian,rpm,nsis}/TaskBoard*`

### 4.2 测试与检查

```bash
cd app
npm test                       # 前端 vitest
npm run i18n:check             # i18n 双语 key 一致性
npx tsc --noEmit               # TS 严格检查
cargo check --manifest-path app/src-tauri/Cargo.toml  # Rust 检查
```

CI：`/.github/workflows/i18n-check.yml` 在 PR 时自动校验 i18n 一致性。

### 4.3 发版流程

```
1. 对齐三处 version（tauri.conf.json / Cargo.toml / package.json）
2. 知识库文档补齐（见第 5 节）
3. git tag vX.Y.Z && git push origin vX.Y.Z
4. 在 GitHub 基于该 tag 创建 Release → Publish
5. .github/workflows/release.yml 自动三端打包（macOS / Windows / Linux）
```

---

## 5. 知识库文档（每功能 / 每修复必建）

> **硬规则**：每开发一个新功能或修复一个 issue，**必须在 `docs/` 下新建或更新对应的知识库文档**，与代码同步交付。

### 5.1 命名

| 场景 | 文件名格式 | 示例 |
|---|---|---|
| 通用知识条目 | `docs/<kebab-case-topic>.md` | `docs/pat-auth.md` |
| 版本内设计文档 | `docs/v<X.Y.Z>-<feature>.md` | `docs/v0.3.15-pat-auth.md` |
| Issue 关联文档 | `docs/issue-<num>-<topic>.md` | `docs/issue-27-sync-logs.md` |

`<topic>` 与第 6.1 节分支 `<scope>` 保持一致，便于「分支 ↔ 文档 ↔ CHANGELOG」三向追溯。

### 5.2 必填章节

| 章节 | 必填 | 简述 |
|---|---|---|
| 背景 / 动机 | ✅ | 为什么做、要解决什么问题、对应 issue |
| 设计 / 方案 | ✅ | 关键设计决策、权衡、与已有模块的关系 |
| 接口 / 行为变更 | ✅ | API、Tauri command、UI 行为、MCP 工具的变化 |
| 数据 / Schema 变更 | △ | 涉及 SQLite / DB schema 改动时必填，注明迁移方式 |
| 测试 / 验收 | ✅ | 验收标准、已跑的测试、边界场景 |
| 相关链接 | ✅ | 关联 issue、PR、commit、`CHANGELOG.md` 条目 |

### 5.3 时机

| 阶段 | 要求 |
|---|---|
| 开发前 | 复杂功能先在 `PRD.md` 记动机与方案评审 |
| **PR 创建时** | 知识库文档**至少要有 stub**（背景 + 章节占位），与 PR 描述互相引用 |
| **合并前** | 必填章节补齐，文档随 PR 一起合并 |
| **发版时** | 在 `docs/CHANGELOG.md` 对应版本下追加指向本文档的链接 |

### 5.4 与其他文档的关系

- **CHANGELOG** = 「做了什么」（一两行摘要 + KB 链接）
- **知识库文档** = 「为什么这么做、怎么做的」（设计 + 决策 + 接口变更）
- **PRD** = 「要做的事 + 决策演进记录」（规划阶段）
- 三者**不重复**同一段内容；互相链接。

### 5.5 一般规范

- 文件名遵循 `kebab-case.md`；**禁止中文文件名**。
- 内部链接用相对路径 `./xxx.md` 或 `../docs/xxx.md`。
- 不在 KB 文档中嵌入大段代码；只贴最小可复现片段并指向源文件。
- 新增文档后**必须**在 README.md / CHANGELOG.md / 涉及的 PRD 章节建立反向链接（避免孤岛文档）。
- 旧文档若被新文档取代，在文档顶部标注「⚠️ 已被 `<new-doc>` 取代」并保留 1 个版本周期后删除。

---

## 6. Git / 分支、PR、提交

### 6.1 分支类型与命名

| 类型 | 命名格式 | 示例 |
|---|---|---|
| 主分支（**受保护**） | `main` | — |
| 集成分支（**受保护**） | `develop` | — |
| 功能分支（有 issue） | `feature/issue-<num>-<scope>` | `feature/issue-27-sync-logs` |
| 修复分支（有 issue） | `fix/issue-<num>-<scope>` | `fix/issue-26-modal-overlap` |
| 功能分支（无 issue，需 owner） | `feature/<owner>/<scope>` | `feature/lsz/refactor-db-migrations` |
| 工作树分支（多 agent 并行） | `<type>/<owner>/<issue-num>-<scope>@<target><YYMMDD>` | `feature/lsz/25-fix-second-account-422@develop260905` |

`<scope>` kebab-case 简述改动主题；`<num>` 是 GitHub issue 编号（去 `#`）；`<owner>` 是当前负责人 / agent 代号。

### 6.2 硬规则

1. **禁止在 `main` / `develop` 上直接开发**。所有改动走新分支 + PR。
2. **有 issue → 分支名必须包含 issue 号**。
3. **没有 issue → 必须先询问用户是否创建 issue**。用户明确不开 issue 时才允许 `feature/<owner>/<scope>`，且 PR 描述里必须写明「无 issue 的原因」。
4. **owner 前缀**用于多 agent / 多人协作时区分（参考工作树 `lsz/<scope>`）；单人维护可省，但工作树分支必须带 owner。
5. **`@<target><YYMMDD>`** 后缀专用于 `git worktree`，标明「目标分支 + 起始日期」。

### 6.3 PR 流向

| 分支来源 | PR 目标 | 触发时机 |
|---|---|---|
| `feature/*` / `fix/*` | → `develop` | 功能 / 修复完成 |
| `develop` | → `main` | 发版（必须通过 Release PR，需版本号 bump） |
| 紧急 hotfix | → `main`（同时 cherry-pick 回 `develop`） | 生产事故 |
| `main` 的 tag | （触发 GitHub Actions 自动打包） | Release Publish |

常规流程：`feature/issue-N-xxx` → PR 到 `develop` → CI 通过 → merge；积攒一批 → `develop` → PR 到 `main` → tag → Release。

### 6.4 Commit 与发版

- commit message 中文即可：「动词 + 范围 + 简述」三段式（例：`feat(mcp): 新增 clear_session 工具`）。
- 单 PR 内推荐「小步 commit + 可独立 revert」的粒度。
- 发版前必对齐三处 version，再 `git tag vX.Y.Z` → push → GitHub Release。

---

## 7. MCP 看板工具（速记）

详见 [`mcp_server/AGENT_INSTRUCTIONS.md`](./mcp_server/AGENT_INSTRUCTIONS.md)。常用工具速记：

| 时机 | 动作 |
|---|---|
| 开始处理某 issue | `update_task_status(issue, "处理中")` |
| 中途停止 / 切换任务 | `record_session(issue, <id>, "<agent-name>")` |
| 用户说「生成交接任务」 | `record_handoff(issue, <详情>)` |
| 任务完成 | `update_task_status(issue, "已完成")` + `clear_session(issue)` |
| 查看现状 | `get_task_status(issue)` |
| 列清单 | `list_my_tasks(ownership="notassignee")` |

`issue` 接受 `repo#number` / `owner/repo#number` / GitHub URL 三种写法。
`<agent-name>` 必填（`claude-code` / `codex` / `opencode` / `copilot` / `cursor` / `helix` / `aider` / `zcode` 等）以区分多 agent 写入。

---

## 8. 跨 agent 通用注意事项（所有 agent 都得读）

1. **不直接 push 到 `main` / `develop`**。
2. **不擅自修改 issue / label / PR / project 状态**——看板权威在本地 SQLite（产品约束见 §2.1）。维护者明确要求编辑 issue 正文、PR 描述等协作文字时允许；未经明确要求，不得创建 / 关闭 / 改状态 / 改 label。
3. **不擅自创建新分支**——按第 6 节规则；无 issue 时**必须先询问**。
4. **完成的代码改动必须同步产出 `docs/` 知识库文档**（PR 时至少 stub）。
5. **PR 描述里必须附 KB 文档路径或 stub 链接**。
6. **跨文件改动保持一致性**——例如新增 MCP 工具必须同时改 `mcp.rs` 与 `server.py`。
7. **遇到指令冲突**：本文件 > agent 入口文件（CLAUDE.md / copilot.instruction.md） > 用户口头指示。

---

> 本文件由项目维护者维护。如发现本指令与 `CLAUDE.md` / `copilot.instruction.md` / `AGENT_INSTRUCTIONS.md` 不一致，**以本文件为准**，并提交 PR 修复其他文件。
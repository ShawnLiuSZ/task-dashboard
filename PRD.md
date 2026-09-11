# GitHub 任务看板 · 产品需求文档（PRD）

> 版本：**v0.3**　|　日期：2026-09-03　|　状态：已定稿，实施中
>
> **v0.3 核心变更（方案转向）**：
> 1. **组织不允许创建 Project**（实测确认）→ 放弃 Projects v2 方案
> 2. **明确不在 GitHub 上创建任何 Issue / Project** → GitHub 侧改为**纯只读**，仅调 Search API
> 3. **看板落地为跨平台桌面应用**（Tauri，支持 Windows / macOS / Linux；配置支持菜单栏/托盘常驻 + 完整窗口），状态与 session 全部存本地 SQLite
> 4. 支持**定时自动同步**与**手动同步**
>
> **v0.2 变更（已并入）**：
> 1. 状态权威源由 Issue label 改为 Projects v2 `Status` 字段（v0.3 起改为本地 SQLite）
> 2. **session id 只写看板字段，不写入 Issue**——Issue 除 close/reopen 外全程只读（v0.3 起 Issue 完全只读）
> 3. `closed` 不再等于「已完成」，改为「候选已完成」需显式确认

---

## 1. 产品概述

一个面向个人的 **GitHub 任务看板 + AI 执行辅助组件**，解决两件事：

1. **每天自动汇聚任务**：每天定时把 GitHub 上「分配给我 / 与我相关」的任务拉到看板，形成个人任务视图，不再靠记忆或逐仓库翻。
2. **任务状态随执行自动流转**：配套一个 MCP Server（或 Skill），当 AI Agent 开始处理某个任务时自动把状态更新为「处理中」；若中途停止，把该任务对应的 **session id** 记录到看板上（可复制），下次可据此恢复会话继续处理。

看板状态统一为四态：**待处理 · 处理中 · 已处理 · 已完成**。

---

## 2. 目标用户与任务源（实测基线）

- **用户**：liushizhao（GitHub 账号 `liushizhao2025`，邮箱 `shizhao.liu@foodsup.com`）
- **组织**：`FoodsUp-Inc`（私有组织，含 13 个私有仓库）
- **任务载体**：组织仓库内的 **GitHub Issues**；组织已有 **22 个 Projects v2**（实测），其中 `OMS Kanban`（#20，247 卡）为活跃看板
- **当前规模**（2026-09-03 实测）：
  | 口径 | 全站 | 组织内 |
  |---|---|---|
  | 分配给我的 open 任务 | 59 | 59（**58 issue + 1 PR**） |
  | 分配给我的全部任务 | 182 | — |
  | 我创建的 open 任务 | 65 | — |
  | 提到我的 open 任务 | 9 | — |
  | 我评论过的 open 任务 | 40 | — |
  | 与我相关（involves，去重） | 87 | **80** |

> **注意**：任务实际只分布在 **2 个仓库**（`fad-backend` 53、`pq-backend` 6），其余 11 个仓库当前无分配给我的任务。
> **注意**：全站口径比组织口径多 7 条，拉取逻辑**必须**带 `org:FoodsUp-Inc` 限定，否则会混入个人仓库任务。
> **注意**：`assignee` 口径含 1 条 PR（`fad-backend#975`），须加 `is:issue` 限定（见 §5.1）。
> **注意**：58 个 open issue 已 **100% 挂在组织 `OMS Kanban`（#20）上**，但其 Status 为团队七态工作流、不可占用——故仍需新建个人 Project，详见 §5.4。

---

## 3. 任务定义与「与我相关」规则

一个 Issue 视为「与我相关」，满足以下任一条件：

- **assignee** = `liushizhao2025`（直接分配给我）
- **author** = `liushizhao2025`（我创建的）
- **mentions** = `liushizhao2025`（在正文/评论中被 @）
- 我参与评论 / 回复过的 Issue（可选，建议默认开启，可配置）
- 若后续启用 GitHub Projects，Project 卡片 assignee 为我 或 在「待我处理」列

> 决策点 D1：默认拉取范围 = `involves:liushizhao2025`（= assignee OR author OR mentions OR commenter）。
> 实测：`org:FoodsUp-Inc involves:liushizhao2025 is:open is:issue` = **76 条**，其中 assignee=我 58 条，**净增仅 18 条**——「显著扩大任务集」的担忧不成立。
> 但扩进来的 18 条归属各异：13 条无人认领、5 条分配给他人，需按 §3.1 三分标注，不能一律当自己的任务。

### 3.1 归属分区（实测三分）

`involves` 口径拉进来的任务，按 assignee 归属分为三类（2026-09-03 实测，org 内 open issue 共 76 条）：

| 归属 | 判定规则 | 数量 | 看板 `Ownership` 值 |
|---|---|---|---|
| 分配给我 | assignees 含 `liushizhao2025` | 58 | `assigned` |
| **无人认领** | assignees 为空 | **13** | **`notassignee`** |
| 分配给他人 | assignees 非空且不含我 | 5 | `assigned-others` |

> **为什么需要第三类**：`involves` 必然带入「分配给别人、但我参与讨论/被 @」的任务（实测 5 条）。若只区分「有/无 assignee」，这 5 条会被误标为 `assigned`，语义错误——它们是他人的任务，我只是相关方。

---

## 4. 看板状态模型

### 4.1 四状态定义

| 状态 | 含义 | 承载位置（权威源） | GitHub 原生可见性 |
|---|---|---|---|
| 待处理 | 已拉入看板、尚未开始 | Project Status = 待处理 | Issue open |
| 处理中 | AI/我 正在处理 | Project Status = 处理中 | Issue open |
| 已处理 | 已做完、待确认收尾 | Project Status = 已处理 | Issue open |
| 已完成 | 确认完成、收尾归档 | Project Status = 已完成 | Issue **closed**（仅作候选提示） |

### 4.2 状态承载方案

**以本地 SQLite 为唯一权威源；GitHub 侧纯只读。**

背景（实测确认）：组织不允许成员创建 Project；且明确不在 GitHub 上创建任何 Issue 或 Project。因此整个方案不再依赖任何 GitHub 写权限。

| 数据 | 存储位置 | 说明 |
|---|---|---|
| 任务标题 / 仓库 / `Ownership` | 本地 SQLite | 每次同步从 GitHub 拉取并覆盖 |
| 执行状态（四态） | 本地 SQLite | **不回写 GitHub** |
| session id | 本地 SQLite | **不回写 GitHub** |
| GitHub | **只读** | 仅 Search API 与 Issue 状态查询，零写操作 |

- 唯一键 `repo#number`，同步幂等；本地已存在的任务，同步时不覆盖 `status` / `session*`
- GitHub 关闭的 Issue 标记为「候选已完成」，需本地确认才落终态（见 §4.2.1）
- 数据库路径：`~/Library/Application Support/com.liushizhao.taskboard/taskboard.db`

> **决策点 D2 已收敛**：不引入任何 `status:*` label，也不依赖 Projects v2——四态完全由本地 SQLite 承载。
> 代价：看板状态不与他人共享；收益：零权限依赖、零通知噪音、零外部副作用。
>
> **2026-09 修订（#214）**：上述"零写操作"放宽为"默认读 + 用户确认的显式写回"（首批：卡片认领 assignee；规划中：详情 Project 状态）。同步路径本身仍只读；写回成功后本地乐观更新、下次同步对账。PAT 需配套升级写权限。

### 4.2.1 closed 兜底规则（修正）

原方案「Issue closed → 视为已完成」存在误判：Issue 可能因 `duplicate` / `wontfix` / 被 PR 连带关闭而关闭，均非真正完成。

**修正后规则**：

| GitHub 状态 | 看板处理 |
|---|---|
| Issue closed | 标记为**候选已完成**，看板上以「待确认」样式提示，**不自动落终态** |
| 候选已完成 + 人工/Agent 显式确认 | Project Status = 已完成 |
| Issue reopen | 清除候选标记，Status 回到上一有效态（默认「处理中」） |

### 4.3 状态流转

```text
待处理 ──开始处理──▶ 处理中 ──处理完毕──▶ 已处理 ──确认收尾──▶ 已完成
   ▲                  │                                        │
   └──暂停/返工────────┘              重新打开（closed→open）────┘
```

- 「处理中 / 已处理」可按需退回「待处理」（暂停、返工）
- 「已完成」需显式确认并 close Issue；reopen 则 Status 回到「处理中」（见 §4.2.1）

### 4.4 归属维度：`Ownership` 字段（新增）

需求：无 assignee 的任务需显式标记为 `notassignee`。

**设计决定：`notassignee` 落在独立的 `Ownership` 字段，而非并入 `Status`。**
「有没有 assignee」是**归属维度**，「做到哪一步」是**执行状态维度**，两者正交。

| 字段 | 类型 | 取值 | 作用 |
|---|---|---|---|
| `Status` | 单选 | 待处理 / 处理中 / 已处理 / 已完成 | Board 四列分组 |
| `Ownership` | 单选 | `assigned` / `notassignee` / `assigned-others` | 筛选 + 卡片标记 |

**不并入 `Status` 的三个理由**：

1. **组合爆炸**：四态 × 三种归属 = 12 种取值，Status 选项失控
2. **信息丢失（决定性）**：「无人认领、但我正在处理」是真实场景，合并后只能在 `处理中` 与 `notassignee` 里二选一，无法同时表达
3. **职责分离**：Status 用于 Board 分列，Ownership 用于筛选，互不干扰

**维护规则**：

| 时机 | 动作 |
|---|---|
| 落卡 / 每日对账 | 按 issue 的 `assignees` 判定并写入 `Ownership` |
| GitHub 上 assignee 变动 | 下次同步自动更新（可感知「已被指派」「已认领」） |
| 我主动接手无人认领的任务 | 在 GitHub 上 assign 自己即可，无需手动改字段 |

**视图用法**：

- Board 上启筛选器 `Ownership: notassignee` → 单看 13 条无人认领任务
- `notassignee` 卡片建议加醒目标记：这类任务需要主动认领或推动指派，否则容易长期悬空
- 可另建第二个 Board 视图「待认领」，按 `Ownership` 分组

**与执行状态的初始配合**：新增的 `notassignee` 任务 Status 默认落「待处理」；接手后 Status 正常流转，二者独立。

---

## 5. 核心流程

### 5.1 每日自动拉取（晨间同步）

- **触发**：每个工作日 09:00（可配置），由本机 `launchd` / 定时任务 或 豆包定时任务 触发
- **动作**：
  1. 调用 GitHub Search API（**必须带 `org:FoodsUp-Inc` 限定**）：
     `org:FoodsUp-Inc involves:liushizhao2025 is:open is:issue`（实测 **76 条**）
     —— `involves` 已涵盖 assignee / author / mentions / commenter，单条覆盖全部口径
     —— **`is:issue` 不可省**：59 条中混有 1 条 PR（`fad-backend#975`），缺此限定落卡时会报 "Could not resolve to an Issue"
  2. API 返回已去重；再按 §3 规则过滤一遍（同 Issue 只保留一条）
  3. 与看板存量比对 → 新增 / 更新（标题·仓库）/ closed 项标为候选已完成
  4. **判定并写入 `Ownership`**（规则见 §3.1）：`assignees` 为空 → `notassignee`；含 `liushizhao2025` → `assigned`；非空且不含我 → `assigned-others`
  5. 落卡到 Projects v2（见 5.3）
- **幂等**：以 `repo + issue number` 为唯一键，重复拉取不产生重复卡片

> **避坑**：GitHub Search **不支持 `-no:assignee`**（否定 `no:` 限定符会被静默忽略，实测分区数相加对不上总数）。归属判定必须在返回结果里读 `assignees` 数组自行判断，**不能用 search 语法区分**。

### 5.2 状态同步（本地，无写回）

- 状态变更（人工或 Agent）→ **只写本地 SQLite**，不触碰 GitHub
- 同步只拉取远端标题 / 仓库 / 归属并覆盖；**不覆盖本地 `status` 与 `session*`**
- 对账：每次同步时，本次未出现的存量任务会单独查一次 GitHub 状态
  - 已 `closed` → 标记「候选已完成」
  - 仍 `open` 但不再与「我」相关 → 移出看板

### 5.3 看板载体：跨平台桌面应用（决策点 D3 已定，后续扩展为 W/M/L）

| 方案 | 结论 |
|---|---|
| A. GitHub Projects v2 | ❌ 组织不允许成员创建 Project（实测确认），放弃 |
| B. **跨平台桌面应用（Tauri 2，W / M / L）** | ✅ **选定** |
| C. 本地 HTML 看板 | 被 B 取代（B 自带窗口与菜单栏，无需自建渲染与分发） |
| D. 飞书多维表格 | 暂不引入 |

| 维度 | 设计 |
|---|---|
| 技术栈 | Tauri 2（Rust 后端 + React / TypeScript 前端） |
| 形态 | **菜单栏 / 托盘常驻**（角标显示「处理中」数量）+ 点击展开看板窗口 |
| 存储 | SQLite，`~/Library/Application Support/com.liushizhao.taskboard/taskboard.db` |
| 取数 | 调用本机 `gh` CLI（复用已登录凭据），**纯只读** |
| 定时同步 | 后台线程，间隔可配（默认 60 分钟，最小 5 分钟） |
| 手动同步 | 菜单栏「立即同步」+ 窗口内按钮 |
| 会话记录 | 详情面板记录 / 复制 / 清空 session，仅存本地 |

> **约束**：app 退出后定时同步不再触发。如需 app 未启动也能同步，可另配 `launchd`（当前未做，见 §11）。

### 5.4 为什么不复用 OMS Kanban（备查）

> v0.3 起不再依赖任何 GitHub 载体，本节结论已不直接适用，保留备查：若未来组织开放 Project 权限，仍不应复用 `OMS Kanban`。

实测发现：**58 个 open issue 已 100% 挂在组织的 `OMS Kanban`（#20，247 卡）上，零遗漏。** 看似可直接复用，但不可行——决定性理由是其 `Status` 字段已被团队工作流占用：

| 维度 | OMS Kanban（团队，247 卡） | My Tasks（个人，58 卡） |
|---|---|---|
| Status 选项 | 七态团队流程：🧠需求池 → 🤔产品规划 → 🚧待开发处理 → ✨开发中 → 🔎开发完成/测试中 → ✅测试通过/待上线 → 🎉完成/上线 / ↩️取消 | 四态个人执行：待处理 → 处理中 → 已处理 → 已完成 |
| 承载语义 | 团队交付流程 | 个人执行进度 + AI 会话 |
| 卡片规模 | 247（全团队） | 58（我一人） |
| 能否改动 | ❌ 改动会破坏团队流程 | ✅ 完全自主 |

**结论**：即便组织开放 Project 权限，也不应复用 `OMS Kanban`——其 `Status` 无法承载我们的四态，且个人 `Session` 字段对 247 卡的团队属噪音。

v0.3 起改为本地 app 方案，彻底不依赖 GitHub 载体，上述约束一并消失。

---

## 6. MCP / Skill 组件（本次新增核心）

### 6.1 目标

让 **AI Agent** 在执行任务过程中自动维护看板，无需人工改状态：

1. **任务开始** → Agent 自动将任务状态更新为「处理中」
2. **任务中途停止** → Agent 自动将任务对应的 **session id** 记录到看板（**可复制**），并定义中断后状态
3. 任务完成 → Agent 自动更新为「已处理 / 已完成」（写回 label 或关闭 issue）

### 6.2 提供的能力（工具 / 操作）

| 操作 | 入参 | 说明 |
|---|---|---|
| `list_my_tasks` | status?, ownership? | 列出任务；可按 `Status` 与 `Ownership` 过滤（例：`ownership=notassignee` 只看 13 条无人认领） |
| `update_task_status` | issue（repo+number/URL）, status | 将任务状态更新为 待处理/处理中/已处理/已完成；同步维护 label 与 open/close |
| `record_session` | issue, session_id, agent? | 将 session id 写入**看板该任务卡片**的 `Session` 字段（见 6.3）；**不触碰 Issue** |
| `get_task_status` | issue | 查询任务当前状态与看板上已记录的 session id |
| `clear_session` | issue | 任务完成后清空 `Session` 字段（保留 `Session At` 审计） |

### 6.3 session id 的「看板可复制」设计

> **硬约束：session id 只记录到看板中该任务的字段，绝不写入 Issue。**
> 不改标题、不改 label、不改正文、不发评论——对 Issue 零改动、零通知。

需求：中断后 session id 必须在看板视图上直接可见、可复制，便于下次恢复会话。

| 方案 | 看板可见 | 可复制 | 是否写入 Issue | 评价 |
|---|---|---|---|---|
| **A. Projects v2 自定义 TEXT 字段 `Session`（选定）** | 卡片/表格列直接显示 | ✅ 选中即复制 | **否** | 零污染，能力已实测验证 |
| B. 写入 Issue 标题前缀 `[sess:<id>]` | 列表可见 | ✅ | **是** | ❌ 违反硬约束；且会破坏既有 `[司机端迁移 P2-C]` 标题前缀约定；改标题向所有订阅者推通知并污染变更历史 |
| C. 写入专用 label `session:<id>` | 徽章显示 | 需选中徽章文本 | **是** | ❌ 违反硬约束，且 label 属 Issue 实体 |
| D. 追加到 Issue 评论 | 列表不可见 | 需进详情页 | **是** | ❌ 违反硬约束且不可见 |

#### 选定方案 A 的实测依据

- 组织 `OMS Kanban`（#20，247 卡）已在用 `TEXT` 类型自定义字段（`Release Version`），自定义文本字段能力确认可用
- 该字段在**表格视图**下为独立列，文本可直接选中复制；在**看板视图**下可配置为卡片面显示
- 写入走 GraphQL `updateProjectV2ItemFieldValue`，作用对象是 Project item，与 Issue 实体解耦

#### Session 相关字段（其余见 §4.4）

| 字段名 | 类型 | 用途 |
|---|---|---|
| `Session` | TEXT | session id，看板直接可复制；完成后置空 |
| `Session Agent` | TEXT | 会话来源（`claude-code` / `workbuddy` / `doubao`），便于多进程区分 |
| `Session At` | DATE | 记录时间，用于审计与陈旧会话清理 |

#### 生命周期

```text
record_session  → Session = <id>，Session Agent = <agent>，Session At = now
get_task_status → 读取 Session 字段
恢复会话        → 读取 Session → 恢复 → update_task_status(处理中)
任务完成        → clear_session：Session 置空，Session At 保留
```

> **对 Issue 的副作用：无。** 不触发任何邮件/站内通知，Issue 变更历史保持干净。

### 6.4 触发时序

```text
任务开始      Agent → update_task_status(issue, "处理中")
                      └─ 写 Project Status 字段；不动 Issue
执行中        （Agent 正常工作）
任务完成      Agent → update_task_status(issue, "已处理")
              确认收尾 → update_task_status(issue, "已完成")（close Issue）
                      → clear_session(issue)
───────────────────────────────────────────────
任务中途停止  Agent → record_session(issue, <session_id>, <agent>)
                      └─ 只写 Project 的 Session 字段；Issue 零改动
              状态    → 保持「处理中」（建议，见 D4）
下次恢复      get_task_status(issue) → 读 Session 字段
                      → 恢复该会话 → update_task_status(issue, "处理中") → 继续
```

> **Issue 写操作收敛到两处**：完成时的 `close`、返工时的 `reopen`。
> 状态流转与 session 记录 **100% 落在 Project 字段上**，Issue 除开关动作外全程只读。

> **决策点 D4**：中断时状态保持「处理中」（建议）还是置回「待处理」？
> 建议**保持「处理中」**：置回「待处理」会丢掉「该任务已有半成品」的信号，而这恰是 session id 存在的意义；两类任务混在「待处理」后，反而需要额外字段才能区分。恢复时显式转「处理中」即可，语义无损。

### 6.5 形态选择：MCP 还是 Skill（决策点 D5）

| 维度 | MCP Server | Skill |
|---|---|---|
| 通用性 | 任何 MCP 客户端（豆包、Cursor、Claude 等）可调用 | 豆包体系内，随 Agent 工作流自动触发 |
| 实现 | 独立服务 + 工具定义 | 按豆包 Skill 规范封装步骤/脚本 |
| 推荐 | **先做 MCP Server**（能力中立、可复用） | 再包一层 Skill 或直接让 Agent 在工作流里调用 MCP |

> 建议：**先实现一个轻量 MCP Server**（Python/Node 均可，内部调用 `gh` CLI 或 REST API），提供 §6.2 的 4 个工具；豆包侧再以 Skill 形式把「任务开始→update」「中断→record」嵌入 Agent 工作流。Session id 来源：**当前 AI 会话 ID**（如豆包 conversation id），由调用方传入。

### 6.6 权限与安全

- 复用本机 `gh` 已登录凭据（token scopes：`repo`、`project`、`workflow`，已具备）
- 仅对「与我相关」的 Issue 操作；写操作前校验 assignee/author 或显式入参，避免误改他人任务
- session id 属敏感会话标识，仅写入目标 Issue，不在日志明文外泄

---

## 7. 架构与数据流

```text
┌────────────────── 跨平台桌面 app（Tauri，W / M / L）──────────────────┐
│                                                            │
│  菜单栏（角标：处理中 N）──点击──▶ 看板窗口                    │
│                                        │                   │
│        四列看板 ◀─── 点击卡片 ───▶ 详情面板                   │
│           │                              │                 │
│           │                    改状态 / 记 session / 复制    │
│           ▼                              ▼                 │
│   ┌──────────────── SQLite ─────────────────┐              │
│   │ tasks: status · session · ownership     │              │
│   │ meta:  定时间隔 · gh 路径 · 账号 · 上次同步│              │
│   └──────────────────▲─────────────────────┘              │
│                      │ 写入                                │
│        同步层（定时触发 / 手动触发）                          │
└──────────────────────┼────────────────────────────────────┘
                       │ 只读：gh api search/issues
                 ┌─────▼──────┐
                 │   GitHub    │
                 │ FoodsUp-Inc │
                 └────────────┘
```

**关键约束**：GitHub 侧**零写操作**。状态流转与 session 记录全部落在本地 SQLite，不产生任何通知，不改动任何 Issue 或 Project。

---

## 8. 技术方案要点

- **API 通道**：
  - 拉取/搜索：REST Search API（**必须带 `org:FoodsUp-Inc` 限定**）
  - Project 字段读写：GraphQL API v4（`updateProjectV2ItemFieldValue`）
  - 本机 `gh` v2.97.0 已登录，scopes 含 `repo` `project` `read:org` `workflow`，无需额外授权
- **定时**：本机 `launchd`（plist），`0 9 * * 1-5`；需在 plist 中明确休眠补跑策略，否则会拿到陈旧快照
- **状态权威源**：Projects v2 `Status` 字段；**label 只读不写**
- **closed 处理**：仅标记「候选已完成」，需显式确认才落终态（见 §4.2.1）
- **唯一键**：`repo + issue number`
- **去重与对账**：每日拉取时全量比对，修正看板残留状态
- **Issue 写操作收敛**：全流程仅 `close` / `reopen` 两处，其余全部落在 Project 字段
- **MCP**：轻量 stdio Server，工具与 §6.2 对齐
- **实施范围收敛**：当前仅 `fad-backend`、`pq-backend` 两个仓库有任务，label/字段初始化无需覆盖全部 13 个仓库

---

## 9. 决策点清单（待用户确认）

| 编号 | 决策点 | 选项 | 建议 | 状态 |
|---|---|---|---|---|
| D1 | 拉取范围是否含「我评论过的」 | 是 / 否 | **是**——增量仅 21 条，且评论过通常意味着有上下文依赖 | 待确认 |
| D2 | 四态 label 命名 | 沿用现有 / 新建 `status:*` | **都不选**——不引入 label 体系，四态由 Projects v2 Status 承载 | ✅ 已收敛 |
| D3 | 看板载体 | Projects v2 / 本地 HTML / 飞书表格 | **Projects v2**——原「组织未启用」前提已被证伪 | ✅ 已收敛 |
| D4 | 中断后状态 | 保持「处理中」/ 置回「待处理」 | **保持「处理中」**——置回会丢失「已有半成品」信号 | 待确认 |
| D5 | 组件形态 | 仅 MCP / 仅 Skill / 双层 | **先 MCP，后包 Skill** | 待确认 |
| D6 | session id 来源 | 豆包 conversation id / 其他 Agent 会话 id | **由调用方传入，并带 `agent` 参数**（`claude-code` / `workbuddy` / `doubao`）——同时跑多个 Agent 进程，单一来源假设会失效 | 待确认 |
| D7 | session id 落点 | Issue 标题 / label / 评论 / **看板字段** | **仅看板字段**——Issue 零改动 | ✅ 已定 |
| D8 | 归属维度承载 | 并入 `Status` / 独立 `Ownership` 字段 | **独立 `Ownership` 字段**——并入会产生四态 × 三归属的组合爆炸，且「无人认领但处理中」无法表达 | ✅ 已定 |

---

## 10. MVP 范围（第一版）

1. 跨平台桌面 app（Windows / macOS / Linux）：四列看板，数据存本地 SQLite，GitHub 侧零写操作
2. **定时同步**（默认 60 分钟，可配）+ **手动同步**（菜单栏 / 窗口按钮）
3. 拉取 `org:FoodsUp-Inc involves:<login> is:open is:issue`，幂等落库（唯一键 `repo#number`）
4. 归属判定：无 assignee → **`notassignee`**（13 条）
5. 四态流转 + session 记录 / 复制 / 清空，全部本地完成
6. 菜单栏角标显示「处理中」数量

**暂不做**：MCP / Skill 自动流转（v2 可加本地 MCP，读写同一 SQLite）、多用户、历史报表、拖拽排序。

**暂不做**：多用户、网页端实时协作、复杂度分析、历史报表（留作 v2）。

---

## 11. 实施步骤

| 步骤 | 动作 | 依赖 | 产出 |
|---|---|---|---|
| S1 | 建 Project `My Tasks`（GraphQL `createProjectV2`）+ 四态 Status + 4 个自定义字段 | 组织 Project 创建权限（待验证） | Project ID / 字段 ID |
| S2 | `sync.py`：`org:FoodsUp-Inc involves:liushizhao2025 is:open` → 幂等落卡 | S1 | 看板数据 |
| S3 | `launchd` plist 每日 09:00 触发 S2，明确休眠补跑策略 | S2 | 定时任务 |
| S4 | MCP Server（Python stdio）实现 §6.2 五个工具 | S1 | 可调工具 |
| S5 | 挂到 `~/.workbuddy/mcp.json` 并在连接器页信任启用 | S4 | Agent 可调用 |
| S6 | 封装 Skill，把「开始→处理中 / 中断→记 Session / 完成→清空」嵌入工作流 | S5 | 自动流转 |

> S1 的组织权限尚未验证（本机 token 含 `project` scope，但组织可能限制成员创建 Project）。若受限，退到方案 B（本地 HTML 看板 + 本地 SQLite 存 session），§6.3 的「不写 Issue」约束不变。

### 11.1 看板形态

Projects v2 提供两个视图，分工如下：

| 视图 | 用途 | 关键字段可见方式 |
|---|---|---|
| **Board**（默认） | 按 `Status` 分四列，日常浏览与拖拽流转 | Session：卡片面挂件；Ownership：卡片标记 + 筛选器 |
| **Table** | 按 `Ownership` / Session / 仓库 / 更新时间排序筛选 | 二者均为独立列，批量查看与复制 |

Board 视图配置：按 `Status` 分组为四列；卡片面挂件显示 `Repository` + `Ownership` + `Session`（空值不显示）；`Ownership = notassignee` 的卡片加醒目边框，提示需认领或推动指派。

可另建第二个视图「待认领」：按 `Ownership` 分组，聚焦 13 条无人认领任务。

### 11.2 代码结构

```text
dashboard/
├── PRD.md / README.md
├── scripts/
│   ├── init_project.py      # S1：建 Project、四态 Status、4 个自定义字段，产出 config.json
│   └── sync.py              # S2：每日拉取，幂等落卡
├── config.json              # projectId / 各 fieldId / Status 与 Ownership 的 optionId（缓存，不现查）
├── mcp_server/
│   ├── server.py            # S4：五个工具的 MCP stdio 服务
│   └── gh.py                # gh GraphQL 封装
└── launchd/
    └── com.liushizhao.dashboard-sync.plist   # S3
```

### 11.3 关键 API 调用与避坑点

**坑 1 — Projects v2 无法用 Issue 反查 item，必须正向查。**
从 Issue 侧查它挂在哪几个 Project 上，再按 Project 编号筛出目标 item：

```graphql
query($owner:String!, $repo:String!, $num:Int!) {
  repository(owner:$owner, name:$repo) {
    issue(number:$num) {
      id
      projectItems(first:10) {
        nodes { id  project { id title number } }
      }
    }
  }
}
```

**坑 2 — Status 与 Session 的写入参数结构不同**（同一个 mutation，不同 `value`）：

| 字段 | value 结构 | 清空 |
|---|---|---|
| Status（单选） | `{ singleSelectOptionId: "<optionId>" }` | 不可清空 |
| Session（文本） | `{ text: "<session_id>" }` | `{ text: "" }` |

```graphql
mutation($p:ID!, $i:ID!, $f:ID!, $oid:String!) {
  updateProjectV2ItemFieldValue(input:{
    projectId:$p, itemId:$i, fieldId:$f,
    value:{ singleSelectOptionId:$oid }
  }) { projectV2Item { id } }
}
```

**坑 3 — fieldId / optionId 必须缓存到 `config.json`。**
四个 Status optionId 在字段创建后即固定，每次现查既多一次往返又易错。

**坑 4 — 自动添加规则无法通过 API 配置。**
Projects v2 的 auto-add workflow 只能在 UI 手动设置（GraphQL 无对应 mutation）。因此：
- 在 Project 设置里手动配一条规则：`is:open involves:liushizhao2025 org:FoodsUp-Inc` → 自动加卡
- **但 `sync.py` 每日同步仍是必需的兜底**，因为 auto-add 只覆盖新增，不处理状态漂移与关闭项

**坑 5 — `gh api graphql` 变量类型。**
字符串用 `-f`，数字/布尔用 `-F`。Issue number 必须用 `-F`，否则会被当成字符串导致查询失败。

---

## 12. 修订记录

| 日期 | 版本 | 变更 |
|---|---|---|
| 2026-09-03 | v0.1 | 初稿 |
| 2026-09-03 | v0.2 | 实测核验后修正：① 组织已有 22 个 Projects v2，「无看板」前提作废；② 任务仅分布在 2 个仓库；③ 拉取须带 `org:` 限定；④ 状态权威源由 label 改为 Projects v2 Status；⑤ session id 落点由 Issue 标题改为 Project 自定义 TEXT 字段（Issue 零改动）；⑥ closed 兜底改为「候选已完成」需确认 |

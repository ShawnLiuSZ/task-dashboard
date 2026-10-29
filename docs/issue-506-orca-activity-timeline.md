# 对齐 orca：issue 详情增加 Activity 时间线（评论正文 + 事件交织）+ 图片渲染 — #506

> 关联 issue：[#506](https://github.com/ShawnLiuSZ/task-dashboard/issues/506)
> 参考项目：[stablyai/orca](https://github.com/stablyai/orca)（文档：`onorca.dev/docs/review/github`）

## 背景：orca 的 GitHub 信息展示方式

orca 的 issue 详情（details dialog）核心是 **Activity 区块**：

> the details dialog has an **Activity** section that interleaves **comments with timeline events**
> —— assignments, mentions, cross-references, state changes, and project column moves
> —— so you can see the full history without leaving Orca.

配套：issue 抽屉内可浏览 / 筛选 / **编辑**；从 issue 一键开 worktree；PR 评论可**回复** + 表情回应；
描述 / 评论里的**图片**可见；Projects 看板拖拽写回。

## TaskBoard 的差距（实施前）

| orca 能力 | TaskBoard 现状 | 本次 |
|---|---|---|
| issue 详情 = **Activity 时间线** | 只有「评论链接列表」（作者 / 时间 / 跳转 URL） | ✅ 已做 |
| 评论**正文**可见 | 不显示正文 | ✅ 已做 |
| 描述 / 评论里的**图片**可见 | markdown 白名单不含 `img` | ✅ 已做 |
| issue 详情内**编辑**状态 / 指派 / 标签 | 仅 Project Status 可写回 | ⏳ 后续 |
| 评论可**回复** | 只能跳转浏览器 | ⏳ 后续 |
| 从 issue 开 worktree | MCP `/task-start` 已覆盖 | — |
| Projects 看板拖拽写回 | 看板 + Project Status 写回已覆盖 | — |

## 实现

### 1. 后端：GitHub **Timeline API**（一次请求拿全）

`GET /repos/{owner}/{repo}/issues/{n}/timeline?per_page=100` **一次请求**同时返回：

- **评论**（`event: "commented"`，带 `body` / `html_url` / `user`）；
- **时间线事件**（`event: "assigned"` / `"labeled"` / `"closed"` / `"cross-referenced"` /
  `"sub_issue_added"` / `"project_v2_item_status_changed"` …）。

⇒ 正是 orca 那个「评论 + 事件交织」的数据源。

| 文件 | 改动 |
|---|---|
| `github.rs` | `RawTimelineItem` + **纯函数** `parse_issue_timeline` + `GitHubClient::fetch_issue_timeline` |
| `on_demand.rs` | `LiveTimelineItem` + `LiveTaskDetail.timeline`；`fetch_task_detail_live` 里 best-effort 拉取（失败降级为空数组，不阻断其余内容） |
| `commands.rs` | **不新增命令** —— 随 `fetch_task_detail_live` 一并返回（沿用 #490 零落库 + #496 的 `async` + `spawn_blocking` 范式） |

### 2. 前端：「动态」区块

- `types.ts`：`LiveTimelineItem` + `LiveTaskDetail.timeline`；
- `utils/liveDetail.ts`：`normalizeLiveTimeline`（缺字段逐项降级；**没有正文的评论项整条丢弃**；
  `kind` 缺失时按 `event` 推断）；
- `components/DetailPanel.tsx`：新增「动态」区块（排在「描述」之后、「评论链接」之前），
  评论正文走已有的零依赖 markdown 渲染；事件按类型给中文短语；
- `styles.css`：`.timeline-*` 样式 + `.markdown img`（宽度不超容器）；
- i18n：新增 20 词条（中英各 449 key）。

### 3. 事件短语的白名单（关键安全/体验细节）

⚠️ `t()` 对**缺失 key 会返回 key 本身**（还会打 warning）⇒ 直接拼
`t(\`detail.ev.${item.event}\`)` 会把 `detail.ev.whatever` **显示在界面上**。

⇒ 组件里用**白名单** `TIMELINE_EVENT_KEYS`（17 个已知事件）决定是否走专用词条，
清单外一律走 `detail.ev.generic`（"更新了 issue"）；
目标为空时专用词条会留下 `{who}` / `{what}` 占位 ⇒ 也退回通用文案。

## 验证

### 后端单测用**真实抓取样本**（不是自己造数据）

样本来源：`GET /repos/FoodsUp-Inc/fad-backend/issues/1630/timeline`（2026-10-29 实抓，6 条：
项目列加入 / 项目列移动 ×2 / 子 issue / 交叉引用 / 1 条带正文的评论），
只裁掉与解析无关的字段（`avatar_url` / `node_id` …），**保留全部被解析字段的真实形状**。

⚠️ 这正是 #502 的教训所在：上一轮 markdown 的 27 条单测**全部自己造数据**，
于是「行尾是 CRLF」这种真实形状差异整整放过一轮。

| 用例 | 覆盖 |
|---|---|
| `parse_issue_timeline_handles_real_github_response` | 真实 6 条：事件项 / bot actor / 交叉引用目标 `fad-backend#1629` / 评论正文 + 永久链接 |
| `parse_issue_timeline_skips_dirty_items_without_failing` | 非数组 / 缺 `event` / 缺 `actor` / 缺字段 |
| `live_task_detail_serializes_camel_case_keys`（#496 追加） | `timeline` 顶层键 + `createdAt` / `refIssue` **驼峰**（多词字段，与 #496 同型风险点） |

### 前端单测（+20）

- `liveDetail.test.ts`（+8）：评论原样保留 / 事件保留 / 缺字段降级 / 无正文评论丢弃 /
  非数组⇒空 / 非对象跳过 / `kind` 按 `event` 推断 / `normalizeLiveDetail` 接上 timeline；
- `markdown.test.ts`（+6）：http/https 出 `<img>` / `javascript:` 与 `data:` 降级 /
  不留裸叹号 / `alt` 引号被转义 / 链接未受影响；
- `detail-panel-head.test.tsx`（+6）：白名单 ↔ zh-CN 词条**一一对应** / 无死词条 /
  en-US 与 zh-CN 事件词条一致 / **组件必须先过白名单**（结构断言）/ 时间线区块锚点。

### 反向验证（4 处 mutation 全被捕获）

| 变异 | 结果 |
|---|---|
| 白名单删掉 `assigned` | 「无死词条」失败 ✓ |
| 组件去掉白名单判断（`if (true)`） | 「必须先过白名单」失败 ✓ |
| markdown 去掉图片处理 | 「http/https 的图片生成 `<img>`」失败 ✓ |
| 后端把 `event` 字段误读成 `type`（GraphQL 字段名，REST 里没有） | **两条 Rust 用例失败** ✓（真实样本的价值就在这条） |

### 门禁

Rust `fmt` / `clippy --all-targets -D warnings` / `cargo test`（264 + 27）✓ ·
前端 `tsc` / `lint` / `prettier` / `build` / `i18n:check`（449 key）✓ ·
**vitest 475 → 495** ✓ · 四个 `check-*.py` ✓ · scripts 143 ✓ · MCP 68 ✓ ·
**零 DB schema 改动** ⇒ 无需 `check-mcp-columns.py` 的列变更。

## 影响面

- 后端：`github.rs`、`on_demand.rs`（**零 DB schema 改动**、零新命令）；
- 前端：`types.ts`、`utils/liveDetail.ts`、`utils/markdown.ts`、`components/DetailPanel.tsx`、
  `styles.css`、i18n（中英各 +20 词条）。

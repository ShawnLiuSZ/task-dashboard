# 补齐时间线事件的目标字段（里程碑 / 被请求审查者 / 被引用提交） — #510

> 承接 #508 的整体核查：#508 把 4 类「白名单里有、后端却没有数据源」的事件
> 降级成了通用文案（「更新了 issue」）—— 本 issue 把它们的**真实目标**补齐。

## 背景

#508 修好了「守卫从不触发」这个**机制**问题（目标为空 ⇒ 退回通用文案），
但**根因**（目标取错了字段 / 后端压根没解析）还在：

| 事件 | 后端字段 | #508 时的渲染 |
|---|---|---|
| `milestoned` / `demilestoned` | `RawTimelineItem` **无 milestone 字段** | 「设置了里程碑 」+ 空白 |
| `referenced` | GitHub 返回 `commit_id` 而非 `source.issue` ⇒ `ref_issue` 恒空 | 「在  中被引用」 |
| `review_requested` | `who` 取 `target \|\| actor`，`target` 为空 ⇒ **取到发起请求的人** | 「请求 &lt;发起人&gt; 审查」 |

用户看到的仍然是「更新了 issue」这种**无信息量**的描述 —— 机制修对了，信息还没到位。

## 真实字段来源（2026-10-30 实抓确认）

⚠️ **样本来源的选择过程**：用户名下所有仓库（`ShawnLiuSZ/*` + `FoodsUp-Inc/*`）
经 `GET /repos/{o}/{r}/milestones` 逐一核查 ⇒ **全部没有任何 milestone**
⇒ 无法从自己的仓库取到 `milestoned` 样本。
故样本取自**公开仓库** `rust-lang/rust` 与 `ShawnLiuSZ/task-dashboard`，
**只裁掉与解析无关的字段**（`avatar_url` / `node_id` / `followers_url` 等），
保留全部被解析字段与它们的**真实形状**。

| 事件 | 目标字段 | 真实形状 | 样本来源 |
|---|---|---|---|
| `milestoned` / `demilestoned` | `milestone.title` | **对象**，且**只有 `title`**（不是字符串） | `rust-lang/rust#149752` |
| `review_requested` | **`requested_reviewer.login`** | 与 `actor`（发起请求的人）**不是同一人** | `rust-lang/rust#164994` |
| `referenced` | **`commit_id`** | **提交**，**没有** `source.issue` | `ShawnLiuSZ/task-dashboard#508` |

> ⚠️ 这正是 **#502 的教训**：「测试数据形状必须等于真实数据形状」。
> 三个字段的真实形状都**出乎直觉** ——
> `milestone` 是对象不是字符串、`referenced` 指向提交不是 issue、
> `review_requested` 的目标与 `actor` 是**两个人**。
> 自己造数据会把这些差异整整放过一轮。

## 实现

### 1. 后端 `github.rs` —— `RawTimelineItem` 增 3 个字段

```rust
pub struct RawTimelineItem {
    // …既有字段…
    /// 里程碑事件的**里程碑标题**（`milestoned` / `demilestoned`）。
    pub milestone: String,
    /// 审查请求事件的**被请求审查者** login（`review_requested`）。
    pub requested_reviewer: String,
    /// 被引用的**提交** SHA（`referenced`）。
    pub commit_sha: String,
}
```

解析（⚠️ 三处都按真实形状取，不能想当然）：

```rust
// `milestone` 是**对象**，且只有 `title`
e.get("milestone").and_then(|m| m.get("title")).and_then(|x| x.as_str())
// 被请求审查者（**不是** `actor`）
e.get("requested_reviewer").and_then(|r| r.get("login")).and_then(|x| x.as_str())
// `referenced` 的目标是**提交**
e.get("commit_id").and_then(|x| x.as_str())
```

### 2. 后端 `on_demand.rs` —— `LiveTimelineItem` 同步增 3 个字段

`#[serde(rename_all = "camelCase")]` ⇒ 发回 `milestone` / `requestedReviewer` / `commitSha`。

⚠️ **必须同步加键名断言**：三个都是**多词字段** ⇒ 与 #496 同型风险点 ——
漏写 `rename_all` ⇒ 前端读到 `undefined` ⇒ 目标为空 ⇒ 界面又回到「残缺文案」，
而且**不报错、不崩**（最难查的一类漂移）。

### 3. 前端 `types.ts` / `utils/liveDetail.ts` —— 类型与规范化层

三个字段同步进 `LiveTimelineItem`；规范化层用 `asString()` 取值 ⇒
**缺失时降级为空串**，绝不给 `undefined`。

### 4. 前端 `utils/timelineEvent.ts`（新）—— 目标取值抽成纯函数

```ts
export function timelineEventTarget(item: LiveTimelineItem): string {
  switch (item.event) {
    case 'assigned': case 'unassigned': return item.assignee || item.actor;
    case 'labeled':   case 'unlabeled':   return item.label;
    case 'cross-referenced': case 'sub_issue_added': return item.refIssue;
    case 'referenced':      return item.commitSha.slice(0, 7);   // 短 SHA
    case 'milestoned': case 'demilestoned': return item.milestone;
    case 'review_requested': return item.requestedReviewer;
    default: return '';
  }
}
```

⚠️ **为什么要抽成纯函数**：这段取值逻辑原先埋在组件闭包里（`timelineEventText` 内部），
**不可直接调用** ⇒ 只能靠源码结构断言（弱）。抽成纯函数后可被**直接**单测 ——
这正是仓库反复强调的「断言必须落在真实数据流上 / 把转换抽成纯函数再断言」。

⚠️ `referenced` 返回**短 SHA**（7 位，与 GitHub 展示一致）；空串 ⇒ 守卫退回通用文案。

### 5. i18n —— `detail.ev.referenced` 措辞

目标是**提交**而不是 issue ⇒ 措辞改为：

- zh：`在 {what} 中被引用` → **`在提交 {what} 中被引用`**
- en：`was referenced in {what}` → **`was referenced in commit {what}`**

**零新 key**（只改措辞）⇒ 不影响 i18n key 数（仍是 449）。

### 6. `EVENTS_NEEDING_TARGET` 不变

四个事件仍在「需要目标」的集合里 —— 现在它们**真的能拿到目标**了；
拿不到时（脏数据 / 团队审查请求无个人）**仍**退回通用文案（#508 的守卫继续生效）。

## 验证

### 后端单测（+1，真实样本 5 条）

`parse_issue_timeline_reads_milestone_reviewer_and_commit_targets`：

- `milestoned` / `demilestoned` ⇒ `milestone == "1.94.0"`（**对象**里的 `title`）；
- 换里程碑 ⇒ `"1.93.0"`；
- `review_requested` ⇒ `requested_reviewer == "mu001999"`，且
  `assert_ne!(requested_reviewer, actor)`（**被请求者 ≠ 发起人**）；
- `referenced` ⇒ `commit_sha == "4529cace…"` 且 `ref_issue == ""`（**没有** `source.issue`）。

同时扩展 `live_task_detail_serializes_camel_case_keys`：
断言 `timeline[0]` 含 `milestone` / `requestedReviewer` / `commitSha`，
且**不含** `requested_reviewer` / `commit_sha`。

### 前端单测（+9）

- `utils/timelineEvent.test.ts`（新，6 例）：逐事件断言目标取值，
  全部用**真实样本形状**（`milestone: '1.94.0'` / `requestedReviewer: 'mu001999'` /
  `commitSha: '4529cace…'`）；含「目标缺失 ⇒ 空串」与「未知事件 ⇒ 空串」。
- `utils/liveDetail.test.ts`（+2）：三个新字段被**如实带过**；缺失时**降级为空串**。
- `components/detail-panel-head.test.tsx`（+1）：锁定「目标取值走纯函数」
  （防止将来被内联回组件、失去可测性）。

### 门禁

| 项 | 结果 |
|---|---|
| `cargo fmt --check` | ✓ |
| `cargo clippy --all-targets -p taskboard -- -D warnings` | ✓ |
| `cargo test` | ✓（266 + 27） |
| `npx tsc --noEmit` | ✓ |
| `npm run lint`（`--max-warnings 0`） | ✓ |
| `npx prettier --check "src/**/*.{ts,tsx,css}"` | ✓ |
| `npm run build` | ✓ |
| `npm run i18n:check` | ✓（中英各 449 key） |
| `npx vitest run` | ✓ 32 文件 / **507** 例 |
| `python3 -m unittest discover -s scripts -p 'test_*.py'` | ✓ 143 例 |
| 四个 `scripts/check-*.py` | ✓ |

## 影响面

| 文件 | 改动 |
|---|---|
| `app/src-tauri/src/github.rs` | `RawTimelineItem` +3 字段、解析 +3 处 |
| `app/src-tauri/src/on_demand.rs` | `LiveTimelineItem` +3 字段、映射、键名断言 +1 例、真实样本单测 +1 例 |
| `app/src/types.ts` | `LiveTimelineItem` +3 字段 |
| `app/src/utils/liveDetail.ts` | 规范化层 +3 字段 |
| `app/src/utils/timelineEvent.ts` | **新增**：目标取值纯函数 |
| `app/src/components/DetailPanel.tsx` | 改用纯函数 |
| `app/src/i18n/locales/{zh-CN,en-US}.json` | `detail.ev.referenced` 措辞 |
| 3 个测试文件 | +9 例 |

**零 DB schema 改动** · 零新命令 · 零新 i18n key。

# 整体核查发现的 6 处缺陷修复（时间线取末页 / 事件文案守卫 / 时间线 memo / 死词条 / 代码围栏闭合 / 时间线超时） — #508

> 对 #506（Activity 时间线）等一批已合入改动做**整体代码核查**后的修复。
> 安全面（跨进程契约、XSS、URL 白名单、凭证处理）逐项核查**通过**，未发现漏洞；
> 本次只修功能 / 一致性缺陷。

## 背景：核查范围

- PR #497 / #499 / #501 / #503 / #505 / #507 共 28 个文件、+3549 行的整体复核。
- 重点看四类高危面：**跨进程契约**（Rust ↔ 前端字段名）、**注入 / XSS**、
  **分页语义**、**渲染期健壮性**。

结论：**无安全漏洞**；发现 **1 个中、4 个低** 的功能 / 一致性缺陷 + 1 个提示项。
其中 #1 会在特定数据规模下**直接让新功能失效**。

## 缺陷与修复

### 1.【Medium】Activity 时间线只取第 1 页 ⇒ 拿到的是**最旧的 100 条**

**位置**：`app/src-tauri/src/github.rs` — `fetch_issue_timeline`

GitHub Timeline API 按**时间升序**返回（旧 → 新）。这一点由**仓库自有的真实样本**直接证实：
`parse_issue_timeline_handles_real_github_response` 里 6 条的顺序是
`2026-10-22 added_to_project_v2` → `2026-10-28 commented`。

⇒ `page` 缺省 = 第 1 页 = **最旧的 100 条**。原实现的注释却写着
「时间线以最近活动最受关注」—— 与实际行为**正好相反**。

**后果**：事件总数 > 100 的 issue（长期 Epic、反复指派）显示的永远是几个月前的陈旧历史，
**一条近期动态都看不到**。更刺眼的是，紧邻的「评论链接」区块走 `fetch_comments` 取**末页**、
显示最新评论 ⇒ 同一个面板里两块时间范围对不上。

> 这正是 **#472 已经踩过、并专门写了两条测试钉住的同一缺陷形态**
> （「URL 只拼 `per_page=100` 而不带 `page` ⇒ 取第 1 页」）。
> 评论侧修好了，时间线侧原样重犯。

**修复**：

1. `get_impl` 增加 `link_capture` 参数 → 成功时把响应头 `Link` 写回（供分页用）。
2. 新增纯函数 `last_page_from_link(&Option<String>) -> Option<u64>`：
   从 `Link` 头里取 `rel="last"` 的页码（**不是** `rel="next"`）。
3. `fetch_issue_timeline`：首次请求顺带拿 `Link` 头 ⇒
   - 无多页（无 `Link` 头）⇒ **只发 1 次请求**，直接返回；
   - 多页 ⇒ 再请求一次**末页**（`?page=<last>`），返回最近 100 条；
   - 末页请求失败 ⇒ 退回第 1 页结果（best-effort，不阻断详情）。

⚠️ **请求数不增加**：末页页码是**搭车**首次请求的响应头拿到的，不是额外探一次。

### 2.【Low】事件文案的兜底守卫对「空字符串参数」无效

**位置**：`app/src/components/DetailPanel.tsx` — `timelineEventText`

```ts
const text = t(`detail.ev.${item.event}`, params);
// 目标为空时专用词条会留下 `{who}` / `{what}` 占位 ⇒ 退回通用文案。
return text.includes('{') ? t('detail.ev.generic', params) : text;
```

`t()`（`i18n/index.tsx`）是把 `{what}` **替换成空串**，**不会保留占位符** ⇒
`text.includes('{')` 恒为 false ⇒ **守卫从不触发**，退化成悬空文案。

**实际受影响的事件**（已在白名单里，但后端无对应字段）：

| 事件 | 后端字段 | 实际渲染 |
|---|---|---|
| `milestoned` | `RawTimelineItem` **无 milestone 字段** | 「设置了里程碑 」+ 空白 |
| `demilestoned` | 同上 | 「移除了里程碑 」+ 空白 |
| `referenced` | GitHub 返回的是 `commit_id`，不是 `source.issue` ⇒ `ref_issue` 恒空 | 「在  中被引用」 |
| `review_requested` | `who` 取的是 `target \|\| actor`，而 `target` 为空 ⇒ **取到发起请求的人** | 「请求 <发起人> 审查」 |

**修复**：守卫改为判**参数本身**（目标为空即退回通用文案），不再依赖渲染结果：

```ts
if (EVENTS_NEEDING_TARGET.has(item.event) && !target) {
  return t('detail.ev.generic', { who: item.actor, what: '' });
}
```

`EVENTS_NEEDING_TARGET` 只收「**词条含占位符**」的事件；
`closed` / `locked` / `added_to_project_v2` 等**固定文案**事件不需要目标，不在此列。

> 备选方案（后端补 `milestone` / `requested_reviewer` 解析）留作后续增强。
> 本次只保证**不把残缺信息显示到界面上**。

### 3.【Low】时间线评论正文在**渲染期**逐条跑 `renderMarkdown`，没有 memo

**位置**：`app/src/components/DetailPanel.tsx`

issue 正文那条走 `useMemo`（`bodyHtml`），时间线这条**没有**。
本组件有 7 个 `useState` ⇒ **在「交接任务」文本框里每敲一个字**都会触发整树重渲染
⇒ 最多 100 条评论的 markdown 全部重解析一遍。

**修复**：

```ts
const liveTimeline = useMemo(
  () => (Array.isArray(live?.timeline) ? live.timeline : []),
  [live],
);
const timelineCommentHtml = useMemo(
  () => liveTimeline.map((it) => (it.kind === 'comment' ? renderMarkdown(it.body) : '')),
  [liveTimeline],
);
```

⚠️ **`liveTimeline` 本身也必须 `useMemo` 稳定化**：它是条件表达式派生的
（`Array.isArray(live?.timeline) ? live.timeline : []`），每次渲染都新建数组
⇒ `timelineCommentHtml` 的依赖每次都变 ⇒ memo **完全失效**，
并触发 `react-hooks/exhaustive-deps` 告警（`--max-warnings 0` ⇒ 直接失败）。

### 4.【Low】死 i18n 词条 `detail.bodyEmpty`

中英各加了一个，但**全仓无任何代码引用**（唯一另一处出现是 `docs/issue-498-*.md` 的说明文字）。

**修复**：让它有真实落点 —— 「描述」区块在 `live` 已加载但正文为空时显示「（无正文）」占位。

⚠️ 整节的渲染条件从「`liveBody.trim()`」改成「`live` 已加载」：
`live` 未到达时**整节不渲染**（既没有正文、也没有「无正文」这个结论），
避免面板刚打开就闪一个「（无正文）」。

### 5.【Low】代码围栏的闭合判定过宽

**位置**：`app/src/utils/markdown.ts`

```ts
while (i < lines.length && !lines[i].trim().startsWith(marker)) {
```

`startsWith(marker)` 允许结束标记后面跟任意内容，且**代码块内容里任何以 ``` / `~~~`
开头的行都会提前终止围栏**（例如正文里贴了一段「如何写代码块」的说明）。
后续内容会被当成普通段落解析，输出错乱（不会崩，只是排版不对）。

**修复**：闭合判定收紧为「trim 后**精确等于** marker」：

```ts
while (i < lines.length && lines[i].trim() !== marker) {
```

这与 GitHub 的行为一致（结束围栏行只能有围栏标记本身 + 空白）。

### 6.【Info】打开详情的网络请求从 3 次变 4 次，限流时最坏延迟被拉长

`get_impl` 在 429/403 时会**最多重试 3 次、每次 sleep 上限 30s**（`MAX_BACKOFF_MS = 30_000`）。

**影响**：命令已改 `async` + `spawn_blocking`，**不会卡 UI**（这点修得对），
但触发限流时「动态」区块最长可挂约 2 分钟才出内容，而它是一个 *best-effort* 的加分项。

**修复**：时间线这次调用单独降 timeout（新增 `TIMELINE_TIMEOUT_SECS = 10`），
失败就空数组，不拖累整块详情的呈现。

## 验证

### 后端单测（+3）

`last_page_from_link` 的解析是纯函数 ⇒ 可直接单测：

- `last_page_from_link_parses_last_page`：无 `Link` 头 ⇒ `None`；多页 ⇒ `Some(5)`；
- `last_page_from_link_ignores_next_and_uses_last`：`rel="next"` 的 `page=9` 不得
  把结果带偏 ⇒ 必须取 `rel="last"` 的 `page=10`；
- `last_page_from_link_handles_variants`：单引号写法 / query 顺序不同 ⇒ `Some(3)`；
  `page=last`（非数字）⇒ `None`。

### 前端单测（+3）

- **代码围栏闭合**（`markdown.test.ts`）：
  - 内容行「以 ``` 开头但带文字」**不**提前闭合围栏（断言 `<pre><code>` 内含整段、
    且**不出现** `<p>`）；
  - 真正的结束标记（单独一行 ```）仍正常闭合（断言输出**精确等于**
    `<pre><code>code</code></pre>`）。
- **事件文案守卫**（`detail-panel-head.test.tsx`）：结构断言
  `EVENTS_NEEDING_TARGET.has(item.event) && !target` ⇒ 后面跟着
  `t('detail.ev.generic')`；且**旧写法不得再出现**。

### 门禁

| 项 | 结果 |
|---|---|
| `cargo fmt --check` | ✓ |
| `cargo clippy --all-targets -p taskboard -- -D warnings` | ✓ |
| `cargo test` | ✓（含 3 条新单测） |
| `npx tsc --noEmit` | ✓ |
| `npm run lint`（`--max-warnings 0`） | ✓ |
| `npx prettier --check "src/**/*.{ts,tsx,css}"` | ✓ |
| `npm run build` | ✓ |
| `npm run i18n:check` | ✓（中英各 449 key） |
| `npx vitest run` | ✓ 31 文件 / **498** 例 |
| `python3 -m unittest discover -s scripts -p 'test_*.py'` | ✓ 143 例 |
| 四个 `scripts/check-*.py` | ✓ |

### 反向验证

- 把 `last_page_from_link` 的 `rel="last"` 判断改成 `rel="next"` ⇒
  `last_page_from_link_ignores_next_and_uses_last` 失败。
- 把围栏闭合判定改回 `startsWith(marker)` ⇒
  「内容行以 ``` 开头但带文字，不提前闭合围栏」失败。
- 把守卫改回「判渲染结果里是否残留 `{`」⇒
  「需要目标数据却取不到时退回 generic」失败。

## 影响面

| 文件 | 改动 |
|---|---|
| `app/src-tauri/src/github.rs` | `last_page_from_link`（新纯函数）+ `get_impl` 增 `link_capture` + `get_with_link`（新）+ `fetch_issue_timeline` 取末页 + `TIMELINE_TIMEOUT_SECS` + 3 条单测 |
| `app/src/components/DetailPanel.tsx` | `EVENTS_NEEDING_TARGET`（新）+ 守卫改判参数 + `liveTimeline` / `timelineCommentHtml` 双 `useMemo` + 「描述」空正文占位 |
| `app/src/utils/markdown.ts` | 代码围栏闭合判定收紧 |
| `app/src/utils/markdown.test.ts` | +2 例（围栏闭合） |
| `app/src/components/detail-panel-head.test.tsx` | +1 例（守卫结构）、更新 memo 后的源码锚点 |

**零 DB schema 改动** · 零新命令 · 零新 i18n 词条（`detail.bodyEmpty` 从死词条变为在用）。

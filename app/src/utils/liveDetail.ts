import type {
  LiveIssue,
  LivePrCommit,
  LiveTaskDetail,
  LiveTimelineItem,
  TaskComment,
} from '../types';

/**
 * #496：把后端返回的**实时详情**规范化成「形状一定安全」的对象。
 *
 * ## 为什么需要这一层
 *
 * #496 的实际故障：后端结构体 `LiveTaskDetail` 漏写
 * `#[serde(rename_all = "camelCase")]` ⇒ 发出来的键是 `pr_commits`，
 * 而前端 `types.ts` 期望 `prCommits` ⇒ `live.prCommits` 为 `undefined`
 * ⇒ 详情面板渲染 `live.prCommits.length` 时抛 `TypeError`
 * ⇒ React 卸载整棵树 ⇒ **整个窗口全屏空白**。
 *
 * 也就是说：**一处后端字段名漂移 = 整个应用白屏**，代价与影响面完全不成比例。
 * 这一层把「后端契约」从「渲染期的隐式假设」降级为「运行期的显式兜底」：
 * 字段缺失 / 类型不对 ⇒ 该字段降级为空值，详情面板照常展示本地库数据，
 * 最多少显示一段内容，**绝不整页崩掉**。
 *
 * ## 契约
 *
 * - 入参：`unknown`（IPC 返回值不做任何信任）。
 * - 出参：`LiveTaskDetail | null`。
 *   - `null` ⇒ 返回值根本不是一个对象（不是契约漂移，是完全对不上）⇒ 调用方按「无实时数据」处理。
 *   - 非 `null` ⇒ **所有字段都保证存在且类型正确**（缺失字段用空值兜底）。
 */

function asString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function asNumber(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string');
}

/** 规范化 issue 详情：缺字段 → 空值；非对象 → `null`（调用方用空 issue 兜底）。 */
export function normalizeLiveIssue(v: unknown): LiveIssue | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  return {
    number: asNumber(o.number),
    title: asString(o.title),
    url: asString(o.url),
    state: asString(o.state),
    assignees: asStringArray(o.assignees),
    labels: asStringArray(o.labels),
    author: asString(o.author),
    commentsCount: asNumber(o.commentsCount),
    body: asString(o.body),
    createdAt: asNumber(o.createdAt),
    updatedAt: asNumber(o.updatedAt),
  };
}

/** 规范化评论列表：非数组 → 空数组；逐条补齐字段（url 缺失的条目丢弃，无跳转目标）。 */
export function normalizeLiveComments(v: unknown): TaskComment[] {
  if (!Array.isArray(v)) return [];
  const out: TaskComment[] = [];
  for (const item of v) {
    if (typeof item !== 'object' || item === null) continue;
    const o = item as Record<string, unknown>;
    const url = asString(o.url);
    if (!url) continue;
    out.push({
      id: asNumber(o.id),
      url,
      author: asString(o.author),
      createdAt: asNumber(o.createdAt),
    });
  }
  return out;
}

/** 规范化 PR 提交历史：非数组 → 空数组；缺 sha 的条目丢弃（sha 是列表 key）。 */
export function normalizeLivePrCommits(v: unknown): LivePrCommit[] {
  if (!Array.isArray(v)) return [];
  const out: LivePrCommit[] = [];
  for (const item of v) {
    if (typeof item !== 'object' || item === null) continue;
    const o = item as Record<string, unknown>;
    const sha = asString(o.sha);
    if (!sha) continue;
    out.push({
      sha,
      message: asString(o.message),
      author: asString(o.author),
      date: asNumber(o.date),
    });
  }
  return out;
}

/**
 * 规范化 Activity 时间线（#506）。
 *
 * 非数组 → 空数组；逐条补齐字段。**评论项（`kind === 'comment'`）没有正文
 * 时整条丢弃** —— 时间线里一条没有正文的评论毫无意义（且会渲染成空块）。
 * 事件项没有正文是正常的（事件本身就是全部内容）。
 */
export function normalizeLiveTimeline(v: unknown): LiveTimelineItem[] {
  if (!Array.isArray(v)) return [];
  const out: LiveTimelineItem[] = [];
  for (const item of v) {
    if (typeof item !== 'object' || item === null) continue;
    const o = item as Record<string, unknown>;
    // ⚠️ `kind` 缺失时按 `event` 推断（`commented` ⇒ comment）——
    // 后端一定会给 `kind`，但契约漂移时（载荷没有该字段）不应把评论当成事件丢掉正文。
    const event = asString(o.event);
    const kind =
      asString(o.kind) === 'comment' || (asString(o.kind) === '' && event === 'commented')
        ? 'comment'
        : 'event';
    const body = asString(o.body);
    if (kind === 'comment' && !body) continue;
    out.push({
      kind,
      event,
      actor: asString(o.actor),
      createdAt: asNumber(o.createdAt),
      body,
      url: asString(o.url),
      label: asString(o.label),
      assignee: asString(o.assignee),
      refIssue: asString(o.refIssue),
      // #510：里程碑 / 审查请求 / 被引用提交的目标。
      milestone: asString(o.milestone),
      requestedReviewer: asString(o.requestedReviewer),
      commitSha: asString(o.commitSha),
    });
  }
  return out;
}

/**
 * 规范化整份实时详情。
 *
 * `issue` 缺失时用**空 issue** 兜底（而不是返回 `null`）——
 * 这样调用方的 `live.issue.assignees` 永远安全，
 * 详情面板只是少显示指派/标签，不会崩。
 */
export function normalizeLiveDetail(v: unknown): LiveTaskDetail | null {
  // ⚠️ 数组也要排除：`typeof [] === 'object'` ⇒ 只判 typeof 会把数组当对象，
  //   产出「全是空字段」的结果，掩盖真正的契约漂移。
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const emptyIssue: LiveIssue = {
    number: 0,
    title: '',
    url: '',
    state: '',
    assignees: [],
    labels: [],
    author: '',
    commentsCount: 0,
    body: '',
    createdAt: 0,
    updatedAt: 0,
  };
  return {
    issue: normalizeLiveIssue(o.issue) ?? emptyIssue,
    comments: normalizeLiveComments(o.comments),
    prCommits: normalizeLivePrCommits(o.prCommits),
    // #506：Activity 时间线（缺失 ⇒ 空数组，不影响其余字段）。
    timeline: normalizeLiveTimeline(o.timeline),
  };
}

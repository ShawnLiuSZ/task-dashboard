import type { LiveTimelineItem } from '../types';

/**
 * #510：时间线事件的**目标**（被指派者 / 标签 / 引用对象 / 里程碑 / 被请求审查者 …）。
 *
 * 抽成**纯函数**是为了让「目标从哪个字段取」这件事可被单测覆盖 ——
 * 组件里的 `timelineEventText` 是闭包、不可直接调用，而这段取值逻辑恰恰是
 * #508 复查出的**残缺文案根因**（「在  中被引用」「请求 <发起人> 审查」）：
 * 取错字段 ⇒ 目标为空 ⇒ 界面出现悬空占位。
 *
 * ⚠️ 各事件的真实字段来源（**2026-10-30 实抓 GitHub Timeline API 确认**）：
 *
 * | 事件 | 目标字段 | 真实形状 |
 * |---|---|---|
 * | `assigned` / `unassigned` | `assignee.login` | 用户对象 |
 * | `labeled` / `unlabeled` | `label.name` | 标签对象 |
 * | `cross-referenced` / `sub_issue_added` | `source.issue` | issue 对象 ⇒ `repo#number` |
 * | `referenced` | **`commit_id`** | **提交**，**没有** `source.issue` |
 * | `milestoned` / `demilestoned` | `milestone.title` | 对象，**只有 `title`** |
 * | `review_requested` | **`requested_reviewer.login`** | 与 `actor`（发起人）**不是同一人** |
 *
 * ⚠️ `referenced` 指向的是**提交**（`commit_id`）而非 issue ⇒ 旧实现取 `refIssue`
 * 恒为空。这里返回**短 SHA**（7 位，与 GitHub 展示一致）。
 */
export function timelineEventTarget(item: LiveTimelineItem): string {
  switch (item.event) {
    case 'assigned':
    case 'unassigned':
      return item.assignee || item.actor;
    case 'labeled':
    case 'unlabeled':
      return item.label;
    case 'cross-referenced':
    case 'sub_issue_added':
      return item.refIssue;
    case 'referenced':
      // 目标是**提交**（`commitId`），不是 issue ⇒ 短 SHA。
      return item.commitSha.slice(0, 7);
    case 'milestoned':
    case 'demilestoned':
      return item.milestone;
    case 'review_requested':
      // **被请求审查者**，不是 `actor`（发起请求的人）。
      return item.requestedReviewer;
    default:
      return '';
  }
}

import { describe, expect, it } from 'vitest';
import { timelineEventTarget } from './timelineEvent';
import type { LiveTimelineItem } from '../types';

/**
 * #510：时间线事件**目标取值**的单测。
 *
 * ⚠️ 为什么单独测这个纯函数：#508 复查出的残缺文案（「在  中被引用」
 * 「请求 <发起人> 审查」）根因就是「目标取错了字段」⇒ 取不到 ⇒ 目标为空。
 * 取值逻辑原先埋在组件闭包里（不可直接调用、只能靠源码结构断言）⇒
 * 抽成纯函数后可被**直接**单测。
 *
 * ⚠️ 样本形状来自 **2026-10-30 实抓的 GitHub Timeline API 真实响应**
 * （只裁掉与取值无关的字段，保留被取值字段的真实形状）——
 * #502 的教训：自己造数据会把「`milestone` 是对象」这类真实形状差异放过一轮。
 */

/** 造一条时间线项（只填与本用例相关的字段）。 */
function item(over: Partial<LiveTimelineItem>): LiveTimelineItem {
  return {
    kind: 'event',
    event: '',
    actor: '',
    createdAt: 0,
    body: '',
    url: '',
    label: '',
    assignee: '',
    refIssue: '',
    milestone: '',
    requestedReviewer: '',
    commitSha: '',
    ...over,
  };
}

describe('timelineEventTarget —— 各事件的目标字段（#510）', () => {
  it('里程碑：目标在 milestone.title（真实形状是**对象**，不是字符串）', () => {
    // 真实样本：{"event":"milestoned","milestone":{"title":"1.94.0"}}
    expect(timelineEventTarget(item({ event: 'milestoned', milestone: '1.94.0' }))).toBe('1.94.0');
    expect(timelineEventTarget(item({ event: 'demilestoned', milestone: '1.94.0' }))).toBe(
      '1.94.0',
    );
  });

  it('审查请求：取**被请求审查者**，不是发起请求的人（actor）', () => {
    // 真实样本：actor = yashaggarwal85d（发起人），requested_reviewer = mu001999
    const t = item({
      event: 'review_requested',
      actor: 'yashaggarwal85d',
      requestedReviewer: 'mu001999',
    });
    expect(timelineEventTarget(t)).toBe('mu001999');
    expect(timelineEventTarget(t)).not.toBe(t.actor);
  });

  it('被引用：目标是**提交**（短 SHA），不是 issue', () => {
    // 真实样本：referenced 事件只有 commit_id，没有 source.issue ⇒ refIssue 恒空。
    const t = item({
      event: 'referenced',
      actor: 'ShawnLiuSZ',
      refIssue: '',
      commitSha: '4529cace624aaedf5ead35dbef2783e8cc3c576c',
    });
    expect(timelineEventTarget(t)).toBe('4529cac');
    expect(timelineEventTarget(t)).not.toBe('');
  });

  it('指派 / 标签 / 交叉引用：各自原有字段不变', () => {
    expect(timelineEventTarget(item({ event: 'assigned', assignee: 'alice' }))).toBe('alice');
    expect(timelineEventTarget(item({ event: 'unassigned', assignee: 'alice' }))).toBe('alice');
    expect(timelineEventTarget(item({ event: 'labeled', label: 'bug' }))).toBe('bug');
    expect(timelineEventTarget(item({ event: 'unlabeled', label: 'bug' }))).toBe('bug');
    expect(
      timelineEventTarget(item({ event: 'cross-referenced', refIssue: 'fad-backend#1629' })),
    ).toBe('fad-backend#1629');
    expect(timelineEventTarget(item({ event: 'sub_issue_added', refIssue: '#1631' }))).toBe(
      '#1631',
    );
  });

  it('指派事件缺 assignee 时回退到 actor（历史行为不变）', () => {
    expect(timelineEventTarget(item({ event: 'assigned', actor: 'bob' }))).toBe('bob');
  });

  it('目标缺失时返回空串（⇒ 组件退回通用文案，不显示悬空占位）', () => {
    // 真实形状里 `requested_team` 为 null、无人可解析 ⇒ requestedReviewer 为空。
    expect(timelineEventTarget(item({ event: 'review_requested', actor: 'x' }))).toBe('');
    expect(timelineEventTarget(item({ event: 'referenced' }))).toBe('');
    expect(timelineEventTarget(item({ event: 'milestoned' }))).toBe('');
    expect(timelineEventTarget(item({ event: 'closed' }))).toBe('');
    // 未知事件 ⇒ 无目标。
    expect(timelineEventTarget(item({ event: 'head_ref_deleted' }))).toBe('');
  });
});

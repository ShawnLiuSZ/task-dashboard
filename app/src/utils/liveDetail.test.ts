import { describe, expect, it } from 'vitest';
import {
  normalizeLiveComments,
  normalizeLiveDetail,
  normalizeLiveIssue,
  normalizeLivePrCommits,
} from './liveDetail';

/**
 * 实时详情**规范化**的回归测试（#496）。
 *
 * #496 的实际故障载荷：后端结构体 `LiveTaskDetail` 漏写
 * `#[serde(rename_all = "camelCase")]` ⇒ 发回来的键是 `pr_commits`，
 * 前端读到 `live.prCommits === undefined` ⇒ 渲染期 `live.prCommits.length`
 * 抛 TypeError ⇒ React 卸载整棵树 ⇒ **窗口全屏空白**。
 *
 * 本文件的每个用例都在验证同一件事：**任何形状的输入都不会抛错**，
 * 且缺字段时降级为空值（少显示内容）而不是让整页崩掉。
 */

/** #496 的真实故障载荷：后端漏写 `rename_all` ⇒ 键是 snake_case。 */
const SNAKE_CASE_PAYLOAD = {
  issue: {
    number: 7,
    title: '标题',
    url: 'https://github.com/o/r/issues/7',
    state: 'open',
    assignees: ['alice'],
    labels: ['bug'],
    author: 'bob',
    comments_count: 2,
    created_at: 1760000000,
    updated_at: 1760000100,
  },
  comments: [
    {
      id: 2,
      url: 'https://github.com/o/r/issues/7#issuecomment-2',
      author: 'carol',
      created_at: 1760000200,
    },
  ],
  pr_commits: [{ sha: 'abc12345', message: 'fix: x', author: 'alice', date: 1760000300 }],
};

describe('normalizeLiveDetail（#496）', () => {
  it('正常驼峰载荷原样保留', () => {
    const d = normalizeLiveDetail({
      issue: {
        number: 7,
        title: '标题',
        url: 'u',
        state: 'open',
        assignees: ['alice'],
        labels: ['bug'],
        author: 'bob',
        commentsCount: 2,
        createdAt: 1,
        updatedAt: 2,
      },
      comments: [{ id: 1, url: 'c', author: 'carol', createdAt: 3 }],
      prCommits: [{ sha: 'abc12345', message: 'm', author: 'alice', date: 4 }],
    });
    expect(d).not.toBeNull();
    expect(d!.issue.commentsCount).toBe(2);
    expect(d!.issue.assignees).toEqual(['alice']);
    expect(d!.comments[0].createdAt).toBe(3);
    expect(d!.prCommits[0].sha).toBe('abc12345');
  });

  it('蛇形键载荷不抛错（#496 的实际故障载荷）', () => {
    // 关键：这里绝不能抛 TypeError —— 抛了就是整页白屏。
    const d = normalizeLiveDetail(SNAKE_CASE_PAYLOAD);
    expect(d).not.toBeNull();
    expect(d!.issue.title).toBe('标题');
    expect(d!.comments).toHaveLength(1);
    // 蛇形键不被当成驼峰键消费：prCommits 降级为空数组，而不是 undefined。
    expect(d!.prCommits).toEqual([]);
  });

  it('非对象输入 ⇒ null（调用方按「无实时数据」处理）', () => {
    expect(normalizeLiveDetail(null)).toBeNull();
    expect(normalizeLiveDetail(undefined)).toBeNull();
    expect(normalizeLiveDetail('x')).toBeNull();
    expect(normalizeLiveDetail(42)).toBeNull();
    expect(normalizeLiveDetail([])).toBeNull();
  });

  it('issue 缺失 ⇒ 用空 issue 兜底（渲染期可安全访问 live.issue.assignees）', () => {
    const d = normalizeLiveDetail({ comments: [], prCommits: [] });
    expect(d).not.toBeNull();
    expect(d!.issue).toBeDefined();
    expect(d!.issue.assignees).toEqual([]);
    expect(d!.issue.labels).toEqual([]);
    expect(d!.issue.title).toBe('');
  });

  it('issue 字段类型不对 ⇒ 逐字段降级为空值', () => {
    const d = normalizeLiveDetail({
      issue: { number: 'x', title: 5, assignees: 'alice', labels: null, commentsCount: '2' },
    });
    expect(d!.issue.number).toBe(0);
    expect(d!.issue.title).toBe('');
    expect(d!.issue.assignees).toEqual([]);
    expect(d!.issue.labels).toEqual([]);
    expect(d!.issue.commentsCount).toBe(0);
  });

  it('#498：body 正常保留', () => {
    const d = normalizeLiveDetail({ issue: { body: '## 描述\n\n正文' } });
    expect(d!.issue.body).toBe('## 描述\n\n正文');
  });

  it('#498：body 缺失或类型不对 ⇒ 降级为空串（不抛错）', () => {
    expect(normalizeLiveDetail({ issue: {} })!.issue.body).toBe('');
    expect(normalizeLiveDetail({ issue: { body: 123 } })!.issue.body).toBe('');
    expect(normalizeLiveDetail({ issue: { body: null } })!.issue.body).toBe('');
  });

  it('comments 非数组 ⇒ 空数组（不抛错）', () => {
    const d = normalizeLiveDetail({ comments: { a: 1 } });
    expect(d!.comments).toEqual([]);
  });

  it('prCommits 非数组 ⇒ 空数组（不抛错）', () => {
    const d = normalizeLiveDetail({ prCommits: 'nope' });
    expect(d!.prCommits).toEqual([]);
  });
});

describe('normalizeLiveIssue', () => {
  it('非对象 ⇒ null', () => {
    expect(normalizeLiveIssue(null)).toBeNull();
    expect(normalizeLiveIssue(3)).toBeNull();
  });

  it('assignees / labels 只保留字符串元素', () => {
    const i = normalizeLiveIssue({ assignees: ['a', 1, null, 'b'], labels: [true, 'x'] });
    expect(i!.assignees).toEqual(['a', 'b']);
    expect(i!.labels).toEqual(['x']);
  });
});

describe('normalizeLiveComments', () => {
  it('缺 url 的条目丢弃（url 是跳转目标，也是 React key）', () => {
    const c = normalizeLiveComments([
      { id: 1, author: 'a' },
      { id: 2, url: 'u', author: 'b' },
    ]);
    expect(c).toHaveLength(1);
    expect(c[0].url).toBe('u');
  });

  it('非数组 ⇒ 空数组', () => {
    expect(normalizeLiveComments(null)).toEqual([]);
    expect(normalizeLiveComments({})).toEqual([]);
  });
});

describe('normalizeLivePrCommits', () => {
  it('缺 sha 的条目丢弃（sha 是列表 key）', () => {
    const c = normalizeLivePrCommits([{ message: 'm' }, { sha: 'a1', message: 'm2' }]);
    expect(c).toHaveLength(1);
    expect(c[0].sha).toBe('a1');
  });

  it('非数组 ⇒ 空数组', () => {
    expect(normalizeLivePrCommits(null)).toEqual([]);
  });
});

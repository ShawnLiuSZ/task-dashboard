import { describe, expect, it } from 'vitest';
import {
  normalizeLiveComments,
  normalizeLiveDetail,
  normalizeLiveIssue,
  normalizeLivePrCommits,
  normalizeLiveTimeline,
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

/**
 * Activity 时间线（#506）的规范化。
 *
 * 对齐 orca 的 issue 详情：一次 Timeline API 请求同时带回
 * **评论（带正文）**与**时间线事件** ⇒ 前端要能安全地渲染两者。
 */
describe('normalizeLiveTimeline（#506）', () => {
  /** 后端返回的一条评论项（形状见 `on_demand.rs::LiveTimelineItem`）。 */
  const COMMENT = {
    kind: 'comment',
    event: 'commented',
    actor: 'jackywoofsup',
    createdAt: 1793212717,
    body: '10-28 定：先暂停',
    url: 'https://github.com/o/r/issues/1#issuecomment-1',
    label: '',
    assignee: '',
    refIssue: '',
  };

  it('评论项原样保留（正文 / 链接 / 作者 / 时间）', () => {
    const out = normalizeLiveTimeline([COMMENT]);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('comment');
    expect(out[0].body).toBe('10-28 定：先暂停');
    expect(out[0].url).toBe('https://github.com/o/r/issues/1#issuecomment-1');
    expect(out[0].actor).toBe('jackywoofsup');
    expect(out[0].createdAt).toBe(1793212717);
  });

  it('事件项保留（无正文是正常的）', () => {
    const out = normalizeLiveTimeline([
      {
        kind: 'event',
        event: 'cross-referenced',
        actor: 'x',
        createdAt: 1,
        body: '',
        url: '',
        label: '',
        assignee: '',
        refIssue: 'fad-backend#1629',
      },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('event');
    expect(out[0].refIssue).toBe('fad-backend#1629');
  });

  it('事件项缺字段逐项降级（不抛错）', () => {
    const out = normalizeLiveTimeline([{ kind: 'event', event: 'closed' }]);
    expect(out).toHaveLength(1);
    expect(out[0].body).toBe('');
    expect(out[0].createdAt).toBe(0);
    expect(out[0].actor).toBe('');
    expect(out[0].refIssue).toBe('');
  });

  // #510：新增的三个目标字段必须被规范化层**如实带过**，
  // 否则事件目标为空 ⇒ 界面出现「在  中被引用」这类残缺文案。
  it('里程碑 / 被请求审查者 / 被引用提交三个字段被带过（#510）', () => {
    const out = normalizeLiveTimeline([
      {
        kind: 'event',
        event: 'review_requested',
        actor: 'yashaggarwal85d',
        requestedReviewer: 'mu001999',
        milestone: '1.94.0',
        commitSha: '4529cace624aaedf5ead35dbef2783e8cc3c576c',
      },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].requestedReviewer).toBe('mu001999');
    expect(out[0].milestone).toBe('1.94.0');
    expect(out[0].commitSha).toBe('4529cace624aaedf5ead35dbef2783e8cc3c576c');
  });

  it('新增的三个字段缺失时降级为空串（不抛错、不给 undefined）', () => {
    const out = normalizeLiveTimeline([{ kind: 'event', event: 'closed' }]);
    expect(out[0].milestone).toBe('');
    expect(out[0].requestedReviewer).toBe('');
    expect(out[0].commitSha).toBe('');
  });

  it('没有正文的评论项被丢弃（渲染出来是空块）', () => {
    const out = normalizeLiveTimeline([{ ...COMMENT, body: '' }]);
    expect(out).toHaveLength(0);
  });

  it('非数组 ⇒ 空数组', () => {
    expect(normalizeLiveTimeline(null)).toEqual([]);
    expect(normalizeLiveTimeline({})).toEqual([]);
    expect(normalizeLiveTimeline('x')).toEqual([]);
  });

  it('非对象条目被跳过', () => {
    expect(normalizeLiveTimeline([null, 1, 'x', COMMENT])).toHaveLength(1);
  });

  it('kind 缺失时按 event 推断（commented ⇒ comment）', () => {
    const out = normalizeLiveTimeline([{ event: 'commented', body: '正文' }]);
    expect(out[0].kind).toBe('comment');
    const ev = normalizeLiveTimeline([{ event: 'closed' }]);
    expect(ev[0].kind).toBe('event');
  });

  it('normalizeLiveDetail 把 timeline 接上（缺失 ⇒ 空数组，不影响其余字段）', () => {
    const withTl = normalizeLiveDetail({ issue: { number: 1 }, timeline: [COMMENT] });
    expect(withTl?.timeline).toHaveLength(1);
    const without = normalizeLiveDetail({ issue: { number: 1 } });
    expect(without?.timeline).toEqual([]);
    expect(without?.issue.number).toBe(1);
  });
});

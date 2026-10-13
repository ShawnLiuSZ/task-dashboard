import { describe, expect, it } from 'vitest';
import {
  countHiddenChanged,
  diffChangedTasks,
  isHiddenByFilters,
  snapshotTasks,
  type ActiveFilters,
} from './syncHint';
import type { Task } from '../types';

function task(over: Partial<Task> & { issueKey: string }): Task {
  return {
    owner: 'o',
    repo: 'a',
    number: 1,
    title: 't',
    url: '',
    issueState: 'open',
    ownership: 'assigned',
    status: 'todo',
    projectStatus: '',
    assignees: '',
    mentioned: false,
    latestCommentUrl: '',
    prNumber: 0,
    prUrl: '',
    prState: '', // #435
    branch: '',
    workBranch: '',
    workDir: '',
    parentIssue: null,
    subIssues: [],
    sessionId: null,
    sessionAgent: null,
    sessionAt: null,
    candidateDone: false,
    handoff: '',
    updatedAt: 100,
    accountId: 1,
    ...over,
  } as Task;
}

const NO_FILTER: ActiveFilters = { repo: '', query: '', ownership: '' };

describe('isHiddenByFilters', () => {
  it('无筛选时永不藏住', () => {
    expect(isHiddenByFilters(task({ issueKey: 'a#1' }), NO_FILTER)).toBe(false);
  });
  it('仓库不匹配藏住', () => {
    expect(
      isHiddenByFilters(task({ issueKey: 'a#1', repo: 'b' }), { ...NO_FILTER, repo: 'a' }),
    ).toBe(true);
  });
  it('关键词命中 repo#number/标题则可见', () => {
    const t = task({ issueKey: 'a#1', repo: 'fad', number: 7, title: '支付回调' });
    expect(isHiddenByFilters(t, { ...NO_FILTER, query: 'fad#7' })).toBe(false);
    expect(isHiddenByFilters(t, { ...NO_FILTER, query: '支付' })).toBe(false);
    expect(isHiddenByFilters(t, { ...NO_FILTER, query: '不存在' })).toBe(true);
  });
  it('归属不匹配藏住', () => {
    expect(
      isHiddenByFilters(task({ issueKey: 'a#1', ownership: 'notassignee' }), {
        ...NO_FILTER,
        ownership: 'assigned',
      }),
    ).toBe(true);
  });
});

describe('diffChangedTasks', () => {
  it('新 key 算新增；updatedAt 变大算变更；不变不算', () => {
    // #438：before 的键改用 taskIdentity（issueKey@accountId，默认 accountId=1）。
    const before = new Map([['a#1@1', 100]]);
    const after = [
      task({ issueKey: 'a#1', updatedAt: 100 }),
      task({ issueKey: 'a#1b', updatedAt: 50 }),
      task({ issueKey: 'a#2', updatedAt: 200 }),
    ];
    // a#1 不变；注意 a#1b 是另一个 key → 新增
    expect(
      diffChangedTasks(before, after)
        .map((t) => t.issueKey)
        .sort(),
    ).toEqual(['a#1b', 'a#2']);
  });
  it('updatedAt 变大才算变更；null 按 0 计', () => {
    const before = new Map<string, number | null>([
      ['a#1@1', 100],
      ['a#2@1', null],
    ]);
    const after = [
      task({ issueKey: 'a#1', updatedAt: 200 }),
      task({ issueKey: 'a#2', updatedAt: 1 }),
    ];
    expect(diffChangedTasks(before, after).map((t) => t.issueKey)).toEqual(['a#1', 'a#2']);
  });
  it('#438：聚合视图下同 issueKey 跨账号不被覆盖（issueKey 键会漏算变更）', () => {
    // 同一 issue 被两个账号关联 ⇒ issueKey 相同、accountId 不同。
    // 旧实现按 issueKey 建键，后者覆盖前者的 updatedAt ⇒ 该账号的变更被漏判。
    const before = snapshotTasks([
      task({ issueKey: 'a#1', updatedAt: 100, accountId: 1 }),
      task({ issueKey: 'a#1', updatedAt: 500, accountId: 2 }),
    ]);
    const after = [
      task({ issueKey: 'a#1', updatedAt: 100, accountId: 1 }), // 账号 1 未变
      task({ issueKey: 'a#1', updatedAt: 999, accountId: 2 }), // 账号 2 变了
    ];
    const changed = diffChangedTasks(before, after);
    expect(changed).toHaveLength(1);
    expect(changed[0].accountId).toBe(2);
  });
});

describe('countHiddenChanged', () => {
  it('无筛选恒为 0（不清池也对）', () => {
    expect(countHiddenChanged(new Map(), [task({ issueKey: 'a#9' })], NO_FILTER)).toBe(0);
  });
  it('筛掉的新任务被计数，未筛掉的不计', () => {
    const before = snapshotTasks([task({ issueKey: 'a#1', updatedAt: 100 })]);
    const after = [
      task({ issueKey: 'a#1', updatedAt: 100, repo: 'a' }),
      task({ issueKey: 'a#2', updatedAt: 200, repo: 'b' }),
    ];
    expect(countHiddenChanged(before, after, { ...NO_FILTER, repo: 'a' })).toBe(1);
    expect(countHiddenChanged(before, after, NO_FILTER)).toBe(0);
  });
});

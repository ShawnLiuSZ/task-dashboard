import { describe, expect, it } from 'vitest';
import type { StatusKey, Task } from '../types';
import { countOpenIssues } from './openCount';

/** 最小可用 Task 工厂：只覆盖断言相关字段，其余给中性默认值。 */
function task(over: Partial<Task> = {}): Task {
  return {
    issueKey: 'o/r#1',
    owner: 'o',
    repo: 'r',
    number: 1,
    title: 't',
    url: '',
    issueState: 'open',
    ownership: 'assigned',
    status: 'todo',
    projectStatus: '',
    assignees: '',
    author: '',
    mentioned: false,
    latestCommentUrl: '',
    prNumber: 0,
    prUrl: '',
    prState: '',
    prs: [],
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
    updatedAt: null,
    createdAt: 0,
    accountId: 1,
    ...over,
  };
}

describe('countOpenIssues（#484）', () => {
  it('空列表为 0', () => {
    expect(countOpenIssues([])).toBe(0);
  });

  it('未关闭的 todo / doing / processed 都计入', () => {
    const list = (['todo', 'doing', 'processed'] as StatusKey[]).map((s, i) =>
      task({ status: s, issueKey: `o/r#${i + 1}` }),
    );
    expect(countOpenIssues(list)).toBe(3);
  });

  it('issueState=closed 不计入（GitHub 权威关闭）', () => {
    expect(countOpenIssues([task({ issueState: 'closed' })])).toBe(0);
  });

  it('status=done 不计入（看板手动标记已完成，issue 可能仍未关）', () => {
    expect(countOpenIssues([task({ status: 'done', issueState: 'open' })])).toBe(0);
  });

  it('closed 且 done 同时命中只扣一次（不重复扣）', () => {
    expect(countOpenIssues([task({ issueState: 'closed', status: 'done' })])).toBe(0);
  });

  it('混合列表只数未完成项', () => {
    const list = [
      task({ issueKey: 'o/r#1', status: 'todo' }),
      task({ issueKey: 'o/r#2', status: 'doing' }),
      task({ issueKey: 'o/r#3', status: 'processed' }),
      task({ issueKey: 'o/r#4', status: 'done' }),
      task({ issueKey: 'o/r#5', issueState: 'closed', status: 'todo' }),
      task({ issueKey: 'o/r#6', issueState: 'closed', status: 'done' }),
    ];
    expect(countOpenIssues(list)).toBe(3);
  });
});

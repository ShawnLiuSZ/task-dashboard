import { describe, expect, it } from 'vitest';
import { taskIdentity } from './taskIdentity';

describe('taskIdentity（#329）', () => {
  it('同一 issue 在两个账号下身份不同（后端唯一键含 account_id）', () => {
    const a = { issueKey: 'o/r#1', accountId: 1 };
    const b = { issueKey: 'o/r#1', accountId: 2 };
    expect(taskIdentity(a)).not.toBe(taskIdentity(b));
  });

  it('同账号同 issue 身份稳定（可作 React key / 选中态判定）', () => {
    expect(taskIdentity({ issueKey: 'o/r#1', accountId: 7 })).toBe(
      taskIdentity({ issueKey: 'o/r#1', accountId: 7 }),
    );
  });

  it('不同 issue 同账号身份不同', () => {
    expect(taskIdentity({ issueKey: 'o/r#1', accountId: 1 })).not.toBe(
      taskIdentity({ issueKey: 'o/r#2', accountId: 1 }),
    );
  });

  it('编码为 `issueKey@accountId`，便于日志中肉眼定位', () => {
    expect(taskIdentity({ issueKey: 'ShawnLiuSZ/task-dashboard#329', accountId: 3 })).toBe(
      'ShawnLiuSZ/task-dashboard#329@3',
    );
  });
});

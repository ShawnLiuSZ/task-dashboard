import { describe, expect, it } from 'vitest';
import { isClosedIssueState } from './issueState';

/**
 * #543：前端 `issue_state` 判 closed 的大小写不敏感 helper。
 *
 * 与后端 `common::is_closed_state` 同口径（trim + 大小写不敏感）。锁定三类边界：
 * ① 大小写不敏感（`CLOSED` 必须命中）；② 空白容忍（`' Closed '` 命中，`'open'` 不命中）；
 * ③ 非 closed 值不误判。**这些正是裸 `=== 'closed'` 会漏掉的大写 / 空白场景**。
 */
describe('isClosedIssueState（#543）', () => {
  it('小写 closed 命中', () => {
    expect(isClosedIssueState('closed')).toBe(true);
  });

  it('大写 CLOSED 命中（#335 的 GraphQL 大写来源）', () => {
    expect(isClosedIssueState('CLOSED')).toBe(true);
  });

  it('混合大小写 + 两侧空白命中（历史残留 / 未归一化写路径）', () => {
    expect(isClosedIssueState(' Closed ')).toBe(true);
    expect(isClosedIssueState('ClOsEd')).toBe(true);
  });

  it('open / OPEN 不命中', () => {
    expect(isClosedIssueState('open')).toBe(false);
    expect(isClosedIssueState('OPEN')).toBe(false);
  });

  it('其它状态与空串不命中', () => {
    expect(isClosedIssueState('draft')).toBe(false);
    expect(isClosedIssueState('')).toBe(false);
    expect(isClosedIssueState(' ')).toBe(false);
  });
});

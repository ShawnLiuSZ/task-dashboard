import { describe, expect, it } from 'vitest';
import type { StatusKey } from '../types';
import { isClearableSession } from './sessionCleanup';

/**
 * #612：一键清除范围从「issue 已关闭」扩展到「或看板 done」。
 *
 * 真实数据形状：Task 的 issueState（可能有 GraphQL 大写 / 空白历史值）与
 * status（四态 StatusKey）。覆盖两个维度四种组合，防止只写 `||` 的静态断言
 * 对「漏掉一个分支」无感（#541 的变异盲点）。
 */
describe('isClearableSession（#612）', () => {
  const cases: Array<[string, StatusKey, boolean, string]> = [
    ['open', 'todo', false, '两维度都不满足 → 保留'],
    ['open', 'doing', false, '处理中不清除'],
    ['open', 'processed', false, '已处理（未关闭）不清除'],
    ['open', 'done', true, '看板 done → 清除（本期新增）'],
    ['closed', 'todo', true, 'issue 已关闭 → 清除'],
    ['closed', 'done', true, '两维度都满足 → 清除'],
    ['CLOSED', 'doing', true, 'GraphQL 大写 closed 仍清除（#543 口径）'],
    [' Closed ', 'processed', true, '带空白的历史残留值仍清除'],
    ['', 'done', true, 'issueState 为空但看板 done → 清除'],
    ['', 'todo', false, '两维度都空/不满足 → 保留'],
  ];

  it.each(cases)('%s + %s → %s（%s）', (issueState, status, expected) => {
    expect(isClearableSession(issueState, status)).toBe(expected);
  });

  it('done 判定只认精确值，不做大小写/空白放宽（status 是本地四态枚举）', () => {
    expect(isClearableSession('open', 'DONE' as StatusKey)).toBe(false);
    expect(isClearableSession('open', ' done ' as StatusKey)).toBe(false);
  });
});

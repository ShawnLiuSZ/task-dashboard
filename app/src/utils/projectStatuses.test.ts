import { describe, expect, it } from 'vitest';
import { mergeProjectStatuses, pickPrimaryProjectStatuses } from './projectStatuses';
import type { ProjectStatus } from '../types';

/**
 * 项目状态选项的**共用选取逻辑**（#530）。
 *
 * ## 要守住的不变式
 *
 * 同一个任务在**主窗口的 modal** 与**任务详情独立窗**里，状态选项列表必须**完全一致**
 * —— 用户实测发现独立窗比 modal **多出一大截**（18 项 vs 8 项）。
 *
 * 根因：独立窗直接用了 `listProjectStatuses(accountId)` 的**全量**结果（该账号**所有**
 * Project 的状态），而主窗口单账号视图会**只取「主项目」**的状态。
 *
 * ⇒ 两处必须走**同一份实现**（本模块）⇒ 抽成纯函数后可用单测锁住。
 */

function ps(name: string, projectGithubId: string, orderIndex: number): ProjectStatus {
  return {
    name,
    projectGithubId,
    orderIndex,
  } as ProjectStatus;
}

describe('pickPrimaryProjectStatuses（#530）', () => {
  it('只取**状态数最多**的那个 Project 的状态', () => {
    const all = [
      ps('Todo', 'P1', 0),
      ps('In Progress', 'P1', 1),
      ps('Done', 'P1', 2),
      // P2 只有 1 个状态 ⇒ 不是主项目。
      ps('需求池', 'P2', 0),
    ];
    expect(pickPrimaryProjectStatuses(all).map((p) => p.name)).toEqual([
      'Todo',
      'In Progress',
      'Done',
    ]);
  });

  it('按 `orderIndex` 升序（过滤后顺序会丢，必须重排）', () => {
    const all = [ps('C', 'P1', 2), ps('A', 'P1', 0), ps('B', 'P1', 1), ps('X', 'P2', 0)];
    expect(pickPrimaryProjectStatuses(all).map((p) => p.name)).toEqual(['A', 'B', 'C']);
  });

  it('⚠️ **不合并**其它 Project 的状态（这正是独立窗多出一大截的原因）', () => {
    const all = [
      ps('需求池', 'P1', 0),
      ps('产品规划', 'P1', 1),
      ps('Todo', 'P2', 0),
      ps('In Progress', 'P2', 1),
      ps('Done', 'P2', 2),
    ];
    const picked = pickPrimaryProjectStatuses(all);
    // P1 有 2 个、P2 有 3 个 ⇒ 主项目是 P2 ⇒ 只剩 P2 那三个。
    expect(picked.map((p) => p.name)).toEqual(['Todo', 'In Progress', 'Done']);
    expect(picked.map((p) => p.name)).not.toContain('需求池');
  });

  it('空输入 ⇒ 空数组', () => {
    expect(pickPrimaryProjectStatuses([])).toEqual([]);
  });
});

describe('mergeProjectStatuses（#530）', () => {
  it('跨账号合并 + 按**状态名**去重 + 按名排序', () => {
    const merged = mergeProjectStatuses([
      [ps('Todo', 'P1', 0), ps('Done', 'P1', 1)],
      [ps('Todo', 'P2', 0), ps('Planning', 'P2', 1)],
    ]);
    expect(merged.map((p) => p.name)).toEqual(['Done', 'Planning', 'Todo']);
  });

  it('⚠️ 去重**区分大小写**（`In Progress` 与 `In progress` 是不同 option_id）', () => {
    const merged = mergeProjectStatuses([
      [ps('In Progress', 'P1', 0)],
      [ps('In progress', 'P2', 0)],
    ]);
    // ⚠️ 不变式是「**两个都在**」（不合并）⇒ 具体排序由 localeCompare 决定，不在此断言。
    expect(merged).toHaveLength(2);
    expect(merged.map((p) => p.name).sort()).toEqual(['In Progress', 'In progress']);
  });
});

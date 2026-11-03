import type { ProjectStatus } from '../types';

/**
 * #530：项目状态选项的**共用选取逻辑**（主窗口与任务详情独立窗必须一致）。
 *
 * ## 为什么要抽出来
 *
 * 同一个「GitHub 状态」列表在两处被用到，但两处的数据源不同：
 *
 * | 场景 | 数据源 | 需要的选项集 |
 * |---|---|---|
 * | 主窗口 · **单账号**视图 | 该账号**所有** Project 的状态 | **只取「主项目」**的状态 |
 * | 主窗口 · **聚合**视图 | **所有账号**的状态 | 全部合并（按名去重） |
 * | **任务详情独立窗**（#527） | 该**任务所属账号**的状态 | **只取「主项目」**的状态（同单账号视图） |
 *
 * ⚠️ 独立窗原先直接用了 `listProjectStatuses(accountId)` 的**全量**结果 ⇒ 状态列表
 * 比主窗口的 modal **多出一大截**（用户实测：modal 8 项 vs 独立窗 18 项）
 * ⇒ 同一个任务在两个界面显示的状态选项**不一致**。
 *
 * ⇒ 把两段逻辑抽成纯函数，两处**共用同一份实现** ⇒ 不会再分叉。
 */

/**
 * 取「主项目」的状态：**状态数最多**的那个 Project 的全部状态，按 `orderIndex` 升序。
 *
 * ⚠️ 「主项目」的判据是**状态数最多**（不是条目数最多 —— 状态表里没有条目数）。
 * 多个 Project 状态数相同时取**先遇到**的那个（`Map` 的插入序 ⇒ 与主窗口原实现一致）。
 *
 * ⚠️ `orderIndex` 排序必须在此重做：后端已按它排过序，但按 project 过滤后顺序会丢。
 */
export function pickPrimaryProjectStatuses(all: ProjectStatus[]): ProjectStatus[] {
  const byProject = new Map<string, ProjectStatus[]>();
  for (const ps of all) {
    const arr = byProject.get(ps.projectGithubId) ?? [];
    arr.push(ps);
    byProject.set(ps.projectGithubId, arr);
  }
  let best: ProjectStatus[] = [];
  for (const arr of byProject.values()) {
    if (arr.length > best.length) best = arr;
  }
  return [...best].sort((a, b) => a.orderIndex - b.orderIndex);
}

/**
 * 聚合视图：**合并**多份状态列表，按**状态名**去重（同名只留第一个），
 * 最后按状态名排序。
 *
 * ⚠️ 去重是**精确匹配**（区分大小写）：`In Progress` 与 `In progress` 是两个不同
 * Project 的不同 option（option_id 不同）⇒ 合并会写错 option_id。
 */
export function mergeProjectStatuses(lists: ProjectStatus[][]): ProjectStatus[] {
  const merged = new Map<string, ProjectStatus>();
  for (const list of lists) {
    for (const ps of list) {
      if (!merged.has(ps.name)) merged.set(ps.name, ps);
    }
  }
  return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
}

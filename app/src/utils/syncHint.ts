import type { Task } from "../types";

/** 当前生效的筛选（与 App.tsx toolbar 同构：repo/query 前端筛，ownership 后端筛）。 */
export interface ActiveFilters {
  repo: string;
  query: string;
  ownership: string;
}

function matchesQuery(t: Task, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  const hay = `${t.repo}#${t.number} ${t.title}`.toLowerCase();
  return hay.includes(needle);
}

/** 单任务是否被当前筛选藏住（任一维度命中即藏住）。 */
export function isHiddenByFilters(t: Task, f: ActiveFilters): boolean {
  if (f.ownership && t.ownership !== f.ownership) return true;
  if (f.repo && t.repo !== f.repo) return true;
  if (!matchesQuery(t, f.query)) return true;
  return false;
}

/**
 * diff 本次同步新增/变更的任务。
 * - key 不在 before 中 → 新增
 * - updatedAt 变大 → 变更（null 按 0 计）
 */
export function diffChangedTasks(
  before: ReadonlyMap<string, number | null>,
  after: Task[],
): Task[] {
  return after.filter((t) => {
    if (!before.has(t.issueKey)) return true;
    const prev = before.get(t.issueKey) ?? 0;
    return (t.updatedAt ?? 0) > prev;
  });
}

export function snapshotTasks(tasks: Task[]): Map<string, number | null> {
  return new Map(tasks.map((t) => [t.issueKey, t.updatedAt]));
}

/**
 * 本次新变任务中被当前筛选藏住的数量。
 * 无任何筛选时恒为 0（fast path，调用方可跳过拉全量）。
 */
export function countHiddenChanged(
  before: ReadonlyMap<string, number | null>,
  afterPool: Task[],
  filters: ActiveFilters,
): number {
  if (!filters.ownership && !filters.repo && !filters.query.trim()) return 0;
  return diffChangedTasks(before, afterPool).filter((t) =>
    isHiddenByFilters(t, filters),
  ).length;
}

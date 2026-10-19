/**
 * #456：备忘录按「添加日期」分组（替代原优先级四列）。
 *
 * 分组为**相对时间段**而非固定自然日/自然月：
 * - 备忘录用完即弃，绝大多数集中在最近几天 —— 固定粒度会产生大量空列
 *   （按天分列，三个月前建的一条备忘会让中间几十列全空）。
 * - 相对桶的列数恒定（4 列），横向布局稳定，无需依赖横向滚动找内容。
 *
 * **列顺序 = 从新到旧**（今天在最左），与看板的「待处理 → 已完成」方向相反 ——
 * 这是刻意的：备忘录关心的是「刚写了什么」，不是「还剩什么」。
 */

/** 相对时间段分组键。顺序即列的展示顺序（从新到旧）。 */
export type NoteDateGroup = 'today' | 'yesterday' | 'week' | 'earlier';

export interface DateGroupColumn<T> {
  key: NoteDateGroup;
  items: T[];
}

/** 列顺序：从新到旧。渲染时直接按此顺序铺开。 */
export const DATE_GROUP_ORDER: readonly NoteDateGroup[] = [
  'today',
  'yesterday',
  'week',
  'earlier',
] as const;

const DAY_SECONDS = 86400;

/**
 * 把时间戳归入相对时间段分组。
 *
 * 判据全部用**本地日历日**而非固定秒数偏移：
 * - 「今天/ 昨天」按 `Date` 的年月日零点计算 —— 用 `diff < 86400` 这类固定阈值
 *   会在「昨天 23:50 写的备忘」跨到今天之后算错（23:50 到次日 00:10 只有 20 分钟，
 *   但属于不同日历日）。
 * - 「本周」= 本周一回 00:00 起至今（周一为一周之首，符合中文语境）。
 *
 * `ts <= 0`（未知时间）归入 `earlier`，**不得丢弃** —— 备忘录可能来自旧版本导入，
 * 时间戳缺失是真实情况（DB 侧 `created_at` 默认可为 0）。
 */
export function dateGroupOf(ts: number, nowMs: number): NoteDateGroup {
  if (!ts || ts <= 0) return 'earlier';
  const now = new Date(nowMs);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const tsMs = ts * 1000;
  if (tsMs >= startOfToday) return 'today';
  if (tsMs >= startOfToday - DAY_SECONDS * 1000) return 'yesterday';
  // 本周一 00:00（本地时区）。getDay(): 周日=0 ⇒ 归一为 7，再减 1 得周一偏移。
  const dow = now.getDay() === 0 ? 7 : now.getDay();
  const startOfWeek = startOfToday - (dow - 1) * DAY_SECONDS * 1000;
  if (tsMs >= startOfWeek) return 'week';
  return 'earlier';
}

/**
 * 按相对时间段分列，列内按创建时间倒序，列序从新到旧。
 *
 * @param items   备忘录数组
 * @param nowMs   「当前时间」的毫秒时间戳，**显式传入**以便测试注入固定值
 *                （组件里传 `Date.now()`；测试传构造好的固定时刻）
 *
 * 返回**只含非空列**的结果 —— 空列不渲染，避免整列显示「暂无」的噪声。
 */
export function groupNotesByDate<T extends { createdAt: number }>(
  items: T[],
  nowMs: number,
): DateGroupColumn<T>[] {
  const buckets = new Map<NoteDateGroup, T[]>();
  for (const item of items) {
    const key = dateGroupOf(item.createdAt, nowMs);
    const arr = buckets.get(key);
    if (arr) arr.push(item);
    else buckets.set(key, [item]);
  }
  const out: DateGroupColumn<T>[] = [];
  for (const key of DATE_GROUP_ORDER) {
    const col = buckets.get(key);
    if (!col || col.length === 0) continue;
    // 列内倒序：最新的在最上（卡片区自上而下阅读）。
    col.sort((a, b) => b.createdAt - a.createdAt);
    out.push({ key, items: col });
  }
  return out;
}

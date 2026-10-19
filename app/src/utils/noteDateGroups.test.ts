import { describe, expect, it } from 'vitest';
import {
  DATE_GROUP_ORDER,
  dateGroupOf,
  groupNotesByDate,
  type NoteDateGroup,
} from './noteDateGroups';

/**
 * #456：备忘录按添加日期分组的回归测试。
 *
 * 判据用**本地日历日**而非固定秒数偏移 —— 这是本组测试的核心：
 * 用 `diff < 86400` 这类阈值判断「今天 / 昨天」在跨日边界会算错
 * （昨天 23:50 到今天 00:10 只隔 20 分钟，却属于不同日历日）。
 * 下面的 `昨天 23:50` / `今天 00:10` 两例就是这条边界的防线。
 */

/** 固定「现在」= 2026-10-19（周一）12:00 本地时间，用秒级时间戳表示。 */
const NOW = new Date(2026, 9, 19, 12, 0, 0).getTime() / 1000;

function at(y: number, m: number, d: number, hh = 0, mm = 0): number {
  return new Date(y, m - 1, d, hh, mm, 0).getTime() / 1000;
}

describe('dateGroupOf', () => {
  it('今天：当日 00:00 之后都算今天', () => {
    expect(dateGroupOf(at(2026, 10, 19, 0, 0), NOW * 1000)).toBe('today');
    expect(dateGroupOf(at(2026, 10, 19, 11, 59), NOW * 1000)).toBe('today');
  });

  it('昨天：跨日边界的 20 分钟也必须判昨天（不按固定 86400 阈值）', () => {
    // 昨天 23:50 → 今天 00:10 只隔 20 分钟，但分属不同日历日。
    expect(dateGroupOf(at(2026, 10, 18, 23, 50), NOW * 1000)).toBe('yesterday');
    // 今天 00:10 判 today，与上一行构成同一边界的两侧。
    expect(dateGroupOf(at(2026, 10, 19, 0, 10), NOW * 1000)).toBe('today');
  });

  it('本周：周一 00:00 起算（周一为一周之首）', () => {
    // 基准取周三 2026-10-21 ⇒ 本周起点为 10-19（周一）。
    const nowWed = new Date(2026, 9, 21, 12, 0, 0).getTime();
    // 周一 00:00 整 ⇒ week 的起点，含端点。
    expect(dateGroupOf(at(2026, 10, 19, 0, 0), nowWed)).toBe('week');
    // 本周日（10-18）已在周一之前 ⇒ 更早（注意不是 yesterday：昨天是 10-20）。
    expect(dateGroupOf(at(2026, 10, 18, 23, 50), nowWed)).toBe('earlier');
    // 上周及更早 ⇒ earlier。
    expect(dateGroupOf(at(2026, 10, 12, 10, 0), nowWed)).toBe('earlier');
  });

  it('周日作为一周之始的边界：周一为 week 起点，周日归更早的一侧由 week 覆盖', () => {
    // 2026-10-18 是周日、10-19 是周一 ⇒ 以「现在 = 周一中午」为基准，
    // 上周日属于「昨天」而不是 week —— 但若「现在」是周日，则上周一应属week。
    const sunday = new Date(2026, 9, 18, 12, 0, 0).getTime();
    expect(dateGroupOf(at(2026, 10, 12, 10, 0), sunday)).toBe('week'); // 上周一
    expect(dateGroupOf(at(2026, 10, 11, 10, 0), sunday)).toBe('earlier'); // 上上周
  });

  it('更早：本周一之前', () => {
    expect(dateGroupOf(at(2026, 9, 1), NOW * 1000)).toBe('earlier');
  });

  it('未知时间（ts<=0）归入更早，不丢弃也不报错', () => {
    expect(dateGroupOf(0, NOW * 1000)).toBe('earlier');
    expect(dateGroupOf(-1, NOW * 1000)).toBe('earlier');
  });
});

describe('groupNotesByDate', () => {
  const n = (id: number, createdAt: number) => ({ id, createdAt });

  it('列顺序从新到旧（今天 → 昨天 → 本周 → 更早）', () => {
    // ⚠️ 基准取**周三**而非周一：`week` 组以「本周一」为起点，
    // 若基准是周一，本周就只有「今天」一天，`week` 列永远为空、测不到它。
    // 2026-10-19 是周一（同属 10-19 那周），10-21 是周三基准日。
    const nowWed = new Date(2026, 9, 21, 12, 0, 0).getTime() / 1000;
    const cols = groupNotesByDate(
      [
        n(1, at(2026, 1, 1)), // 更早
        n(2, at(2026, 10, 21, 10, 0)), // 今天（周三）
        n(3, at(2026, 10, 19)), // 本周（周一 = 本周边界起点，含端点）
        n(4, at(2026, 10, 20, 23, 0)), // 昨天（周二）
      ],
      nowWed * 1000,
    );
    expect(cols.map((c) => c.key)).toEqual(['today', 'yesterday', 'week', 'earlier']);
  });

  it('列序固定为 DATE_GROUP_ORDER 的子序列，不受输入顺序影响', () => {
    // 打乱输入，列序必须一致 —— 否则渲染会随刷新抖动。
    const items = [
      n(1, at(2026, 1, 1)),
      n(2, at(2026, 10, 19, 10, 0)),
      n(3, at(2026, 10, 18, 23, 0)),
    ];
    const a = groupNotesByDate(items, NOW * 1000).map((c) => c.key);
    const b = groupNotesByDate([...items].reverse(), NOW * 1000).map((c) => c.key);
    expect(a).toEqual(b);
    expect(a).toEqual([...DATE_GROUP_ORDER].filter((k) => a.includes(k)));
  });

  it('列内按创建时间倒序（最新在上）', () => {
    const cols = groupNotesByDate(
      [n(1, at(2026, 10, 19, 8, 0)), n(3, at(2026, 10, 19, 11, 0)), n(2, at(2026, 10, 19, 10, 0))],
      NOW * 1000,
    );
    expect(cols).toHaveLength(1);
    expect(cols[0].items.map((i) => i.id)).toEqual([3, 2, 1]);
  });

  it('空列不返回（不渲染「暂无」占位列）', () => {
    const cols = groupNotesByDate([n(1, at(2026, 10, 19, 10, 0))], NOW * 1000);
    expect(cols).toHaveLength(1);
    expect(cols[0].key).toBe('today');
  });

  it('全部归入同一组时只返回一列', () => {
    const cols = groupNotesByDate(
      [n(1, 0), n(2, at(2026, 1, 1)), n(3, at(2025, 5, 5))],
      NOW * 1000,
    );
    expect(cols).toHaveLength(1);
    expect(cols[0].key).toBe('earlier');
    // 含 ts=0 的未知时间项，不能丢。
    expect(cols[0].items).toHaveLength(3);
  });

  it('空数组返回空结果', () => {
    expect(groupNotesByDate([], NOW * 1000)).toEqual([]);
  });
});

describe('反向验证', () => {
  /**
   * 若把判据从「本地日历日」改回「固定秒数偏移」（`diff < 86400`），
   * 「昨天 23:50」会被误判为 less 24h ⇒ 落入 today。
   * 这条断言就是该变异的防线。
   */
  it('固定 86400 偏移的实现会在跨日边界判错（本地日历日判据是必需的）', () => {
    const yest23_50 = at(2026, 10, 18, 23, 50);
    const now = new Date(NOW * 1000);
    // 模拟错误实现：按「距今不足 24 小时」判 today。
    const naiveIsToday = now.getTime() / 1000 - yest23_50 < 86400;
    // 事实：它不是今天（本实现判 yesterday）。
    expect(dateGroupOf(yest23_50, now.getTime())).toBe<NoteDateGroup>('yesterday');
    // 而朴素实现会把它当成今天 —— 说明两者判据确实不同，本测试有辨别力。
    expect(naiveIsToday).toBe(true);
  });

  it('列序若改成从旧到新（本末倒置）会被断言捕获', () => {
    const items = [
      { id: 1, createdAt: at(2026, 1, 1) }, // earlier
      { id: 2, createdAt: at(2026, 10, 19, 10, 0) }, // today
    ];
    const cols = groupNotesByDate(items, NOW * 1000);
    const keys = cols.map((c) => c.key);
    // 当前实现：today 在前。
    expect(keys[0]).toBe('today');
    // 若实现反了，这里会得到 earlier —— 断言即失败。
    expect(keys).not.toEqual(['earlier', 'today']);
  });

  it('列内倒序若被改成升序会被捕获', () => {
    const items = [
      { id: 1, createdAt: at(2026, 10, 19, 8, 0) },
      { id: 2, createdAt: at(2026, 10, 19, 11, 0) },
    ];
    const cols = groupNotesByDate(items, NOW * 1000);
    expect(cols[0].items.map((i) => i.id)).toEqual([2, 1]); // 最新在前
  });
});

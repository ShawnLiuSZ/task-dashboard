import { describe, expect, it } from 'vitest';
import { coalescedLoad, createLoadCoalescer, type ListFilter } from './coalescedLoad';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('coalescedLoad (#221)', () => {
  it('空闲时直接执行一次', async () => {
    const s = createLoadCoalescer();
    const seen: ListFilter[] = [];
    await coalescedLoad(s, { ownership: '', accountId: 1 }, async (a) => {
      seen.push(a);
    });
    expect(seen).toEqual([{ ownership: '', accountId: 1 }]);
    expect(s.loading).toBe(false);
    expect(s.pending).toBeNull();
  });

  it('并发请求合并：先到的跑完后用最新参数重跑一次', async () => {
    const s = createLoadCoalescer();
    const gate = deferred();
    const seen: ListFilter[] = [];
    const exec = async (a: ListFilter) => {
      seen.push(a);
      if (seen.length === 1) await gate.promise;
    };
    const first = coalescedLoad(s, { ownership: '', accountId: 1 }, exec);
    // first 占锁期间再来两个：只记最新
    const second = coalescedLoad(s, { ownership: 'assigned', accountId: 1 }, exec);
    const third = coalescedLoad(s, { ownership: '', accountId: 2 }, exec);
    gate.resolve();
    await Promise.all([first, second, third]);
    // 旧账号请求 + 最新账号请求各一次，中间的被合并掉
    expect(seen).toEqual([
      { ownership: '', accountId: 1 },
      { ownership: '', accountId: 2 },
    ]);
    expect(s.loading).toBe(false);
    expect(s.pending).toBeNull();
  });

  it('执行体抛错时锁复位，不死锁', async () => {
    const s = createLoadCoalescer();
    await expect(
      coalescedLoad(s, { ownership: '', accountId: 1 }, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(s.loading).toBe(false);
    // 之后仍可用
    let ran = false;
    await coalescedLoad(s, { ownership: '', accountId: 1 }, async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });
});

describe('coalescedLoad (#452)：失败即丢弃积压', () => {
  /**
   * 时序缺陷复现（修复前）：
   *   t0: loadWith(A) 开始 → exec(A) 挂起
   *   t1: loadWith(B) 到达 → 占锁，记 pending=B
   *   t2: exec(A) 抛错 → 跳出循环，pending=B **残留**
   *   t3: loadWith(C) 到达 → 不忙 → 执行 exec(C)
   *       循环末尾 next = s.pending = B → **又执行 exec(B)**
   * 最终 state 被 B（更早的筛选）覆盖 —— 表现为「切到 C 账号却显示 B 账号数据」。
   *
   * **反向验证**：去掉 `catch` 分支里的 `s.pending = null` ⇒ 本用例失败。
   */
  it('抛错后残留的 pending 不得被下一次调用消费', async () => {
    const s = createLoadCoalescer();
    const gate = deferred();
    const seen: ListFilter[] = [];
    const failing = async (a: ListFilter) => {
      seen.push(a);
      await gate.promise;
      throw new Error('boom');
    };

    const first = coalescedLoad(s, { ownership: '', accountId: 1 }, failing);
    // 占锁期间来一个B —— 它只会被记进 pending
    const second = coalescedLoad(s, { ownership: 'mine', accountId: 2 }, failing);
    gate.resolve();
    await expect(first).rejects.toThrow('boom');
    await second;

    expect(s.loading).toBe(false);
    // 失败后不得残留 pending：否则下一次调用会把它当「最新参数」重放。
    expect(s.pending).toBeNull();

    // 下一次正常调用：只应执行 C 这一次，不该再冒出 B。
    const after: ListFilter[] = [];
    await coalescedLoad(s, { ownership: '', accountId: 3 }, async (a) => {
      after.push(a);
    });
    expect(after).toEqual([{ ownership: '', accountId: 3 }]);
    expect(
      after.some((f) => f.accountId === 2),
      '过期的 accountId=2 请求被重放了 —— 这正是 #452 要修的缺陷',
    ).toBe(false);
    // 全程 seen 里只有第一次的 accountId=1（B 从未被执行过，只是被记为 pending）
    expect(seen).toEqual([{ ownership: '', accountId: 1 }]);
  });

  it('抛错后仍能正常继续加载（丢弃积压不等于锁死）', async () => {
    const s = createLoadCoalescer();
    await expect(
      coalescedLoad(s, { ownership: '', accountId: 1 }, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(s.loading).toBe(false);

    const seen: ListFilter[] = [];
    await coalescedLoad(s, { ownership: '', accountId: 9 }, async (a) => {
      seen.push(a);
    });
    expect(seen).toEqual([{ ownership: '', accountId: 9 }]);
    expect(s.pending).toBeNull();
  });

  it('成功路径的合并语义不受影响（pending 仍会被消费一次）', async () => {
    // #452 只改失败路径；成功路径必须保持 #221 的「合并后重跑最新」语义。
    const s = createLoadCoalescer();
    const gate = deferred();
    const seen: ListFilter[] = [];
    const exec = async (a: ListFilter) => {
      seen.push(a);
      if (seen.length === 1) await gate.promise;
    };
    const first = coalescedLoad(s, { ownership: '', accountId: 1 }, exec);
    const second = coalescedLoad(s, { ownership: '', accountId: 2 }, exec);
    gate.resolve();
    await Promise.all([first, second]);
    expect(seen).toEqual([
      { ownership: '', accountId: 1 },
      { ownership: '', accountId: 2 },
    ]);
  });
});

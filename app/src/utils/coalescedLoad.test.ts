import { describe, expect, it } from "vitest";
import {
  coalescedLoad,
  createLoadCoalescer,
  type ListFilter,
} from "./coalescedLoad";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("coalescedLoad (#221)", () => {
  it("空闲时直接执行一次", async () => {
    const s = createLoadCoalescer();
    const seen: ListFilter[] = [];
    await coalescedLoad(s, { ownership: "", accountId: 1 }, async (a) => {
      seen.push(a);
    });
    expect(seen).toEqual([{ ownership: "", accountId: 1 }]);
    expect(s.loading).toBe(false);
    expect(s.pending).toBeNull();
  });

  it("并发请求合并：先到的跑完后用最新参数重跑一次", async () => {
    const s = createLoadCoalescer();
    const gate = deferred();
    const seen: ListFilter[] = [];
    const exec = async (a: ListFilter) => {
      seen.push(a);
      if (seen.length === 1) await gate.promise;
    };
    const first = coalescedLoad(s, { ownership: "", accountId: 1 }, exec);
    // first 占锁期间再来两个：只记最新
    const second = coalescedLoad(s, { ownership: "assigned", accountId: 1 }, exec);
    const third = coalescedLoad(s, { ownership: "", accountId: 2 }, exec);
    gate.resolve();
    await Promise.all([first, second, third]);
    // 旧账号请求 + 最新账号请求各一次，中间的被合并掉
    expect(seen).toEqual([
      { ownership: "", accountId: 1 },
      { ownership: "", accountId: 2 },
    ]);
    expect(s.loading).toBe(false);
    expect(s.pending).toBeNull();
  });

  it("执行体抛错时锁复位，不死锁", async () => {
    const s = createLoadCoalescer();
    await expect(
      coalescedLoad(s, { ownership: "", accountId: 1 }, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(s.loading).toBe(false);
    // 之后仍可用
    let ran = false;
    await coalescedLoad(s, { ownership: "", accountId: 1 }, async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });
});

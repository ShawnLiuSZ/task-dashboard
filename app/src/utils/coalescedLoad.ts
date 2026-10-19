/** 列表查询参数（归属筛选 + 账号过滤）。 */
export interface ListFilter {
  ownership: string;
  accountId: number | null;
}

/** 合并器状态（调用方持有，通常放 ref 里）。 */
export interface LoadCoalescer {
  loading: boolean;
  pending: ListFilter | null;
}

export function createLoadCoalescer(): LoadCoalescer {
  return { loading: false, pending: null };
}

/**
 * #221：合并并发的列表查询。
 *
 * 忙时不丢弃——记下最新参数，当前完成后重跑一次（多次并发合并为一次重跑）。
 * 旧逻辑"忙则直接 return"会在切换账号时吞掉新筛选的请求，导致看板长期
 * 停留在旧账号，直到下次轮询/聚焦才恢复。
 *
 * #452：`exec` 抛错时**清掉残留的 pending**。原实现只靠 `finally` 复位锁，
 * 把pending 留给"下次调用消费"—— 但那个 pending 是**更早一次**请求的参数：
 *
 *   t0: loadWith(A) 开始执行 exec(A)
 *   t1: loadWith(B) 到达 → loading=true，记 pending=B
 *   t2: exec(A) 抛错 → 跳出循环，pending=B 残留，loading=false
 *   t3: loadWith(C) 到达 → 不忙 → cur=C 执行 exec(C)
 *       循环末尾 next = s.pending = **B** → 又执行 exec(B)
 *
 * 于是最终 state 可能被 B（更早的筛选）覆盖 —— 表现为「切到C 账号却显示
 * B 账号的数据」。语义上正确的做法是「本次失败即丢弃积压」：调用方通常会在
 * 下一次轮询 / 聚焦时自然重试，不需要合并器替它重放一个过期参数。
 *
 * `exec` 内部抛错会向上传播（调用方可感知失败），但锁一定复位。
 */
export async function coalescedLoad(
  s: LoadCoalescer,
  args: ListFilter,
  exec: (a: ListFilter) => Promise<void>,
): Promise<void> {
  if (s.loading) {
    s.pending = args;
    return;
  }
  s.loading = true;
  try {
    let cur = args;
    for (;;) {
      await exec(cur);
      const next = s.pending;
      s.pending = null;
      if (!next) return;
      cur = next;
    }
  } catch (e) {
    // #452：失败即丢弃积压，避免下次调用消费到过期参数（见上方时序说明）。
    s.pending = null;
    throw e;
  } finally {
    s.loading = false;
  }
}

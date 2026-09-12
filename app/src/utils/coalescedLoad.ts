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
 * `exec` 内部自行处理错误（抛错会向上传播，但锁一定复位；残留的 pending
 * 由下次调用消费，不会死锁）。
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
  } finally {
    s.loading = false;
  }
}

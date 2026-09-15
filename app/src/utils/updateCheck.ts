/**
 * #256：检查更新的双通道并发与裁决逻辑（纯模块，可单测）。
 *
 * 背景：v0.5.0 的 AboutPanel 是串行的——先 `await checkAppUpdate()`
 *（tauri-plugin-updater 通道，该通道无内置超时，弱网下 hang 很久），失败后才走
 * `checkLatestRelease` fallback。用户体感是「很久才出结果，且退化成前往下载」，
 * 而 updater 的失败原因还被静默吞掉。
 *
 * 新流程：双通道并发 + 单路超时封顶（`UPDATE_CHECK_TIMEOUT_MS`），总耗时由加和变为
 * 取最大；updater 通道可用时仍优先一键更新；fallback 的版本结论为准（fallback 读的是
 * GitHub Releases API：它说已是最新，updater 就不可能有更新，即使 updater 侧超时未知）；
 * 显示手动下载时附带 updater 失败原因（不再静默）。
 */

import type { AppUpdate, CheckUpdate } from '../types';

/** 单路检查超时：updater 通道无内置超时，hang 住时不能无限等（fallback 自带 20s 超时）。 */
export const UPDATE_CHECK_TIMEOUT_MS = 30_000;

/** 永不抛的 settled 结果：超时或抛错都收敛为数据，调用方无需 try/catch。 */
export type Settled<T> = { ok: true; value: T } | { ok: false; error: string; timedOut: boolean };

export async function settleWithTimeout<T>(promise: Promise<T>, ms: number): Promise<Settled<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then<Settled<T>, Settled<T>>(
        (value) => ({ ok: true, value }),
        (e) => ({ ok: false, error: String((e as Error)?.message ?? e), timedOut: false }),
      ),
      new Promise<Settled<T>>((resolve) => {
        timer = setTimeout(() => resolve({ ok: false, error: '', timedOut: true }), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** updater 通道不可用原因（显示手动下载时附带，不再静默吞掉）。 */
export type UpdaterIssue = { kind: 'backend-error'; message: string } | { kind: 'timeout' };

export type UpdateDecision =
  | {
      phase: 'available';
      version: string;
      current: string;
      notes: string;
      manualUrl?: string;
      updaterIssue?: UpdaterIssue;
    }
  | { phase: 'upToDate'; current: string }
  | { phase: 'error'; message: string; timedOut: boolean };

/**
 * 双通道裁决：updater 通道返回可用更新则一键更新；否则以 fallback 的版本结论为准，
 * 并在手动下载时附带 updater 失败原因；双双失败则报错（具体错误优先于超时）。
 */
export function decideUpdateState(u: Settled<AppUpdate>, d: Settled<CheckUpdate>): UpdateDecision {
  if (u.ok && !u.value.error && u.value.available) {
    const { version, current, notes } = u.value;
    return { phase: 'available', version, current, notes };
  }

  const updaterIssue: UpdaterIssue | undefined = !u.ok
    ? u.timedOut
      ? { kind: 'timeout' }
      : { kind: 'backend-error', message: u.error }
    : u.value.error
      ? { kind: 'backend-error', message: u.value.error }
      : undefined;

  if (d.ok && !d.value.error) {
    if (!d.value.upToDate) {
      return {
        phase: 'available',
        version: d.value.latest,
        current: d.value.current,
        notes: '',
        manualUrl: d.value.url,
        updaterIssue,
      };
    }
    return { phase: 'upToDate', current: d.value.current };
  }

  // 双双失败：按「fallback 具体错误 > updater 具体错误 > 超时」的优先级展示。
  let message = '';
  if (d.ok) {
    message = d.value.error;
  } else if (!d.timedOut) {
    message = d.error;
  }
  if (!message && updaterIssue?.kind === 'backend-error') {
    message = updaterIssue.message;
  }
  const timedOut = (!d.ok && d.timedOut) || updaterIssue?.kind === 'timeout' || false;
  return { phase: 'error', message, timedOut };
}

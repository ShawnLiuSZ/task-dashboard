/**
 * #256：检查更新的双通道并发与分阶段展示（纯模块，可单测）。
 *
 * 背景：v0.5.0 的 AboutPanel 是串行的——先 `await checkAppUpdate()`
 *（tauri-plugin-updater 通道，该通道无内置超时，弱网下 hang 很久），失败后才走
 * `checkLatestRelease` fallback。用户体感是「很久才出结果，且退化成前往下载」，
 * 而 updater 的失败原因还被静默吞掉。实测用户 updater 通道本身是通的，只是慢。
 *
 * 新流程（分阶段展示）：
 * 1. 双通道同时发起；fallback 先到先展示——有新版立刻显示手动下载，
 *    已是最新立刻显示最新（fallback 读的是 GitHub Releases API：它说已是最新，
 *    updater 就不可能有更新，结论安全）；
 * 2. updater 后到做升级/备注：返回可用更新 → 把手动下载**升级为一键更新**；
 *    失败 → 给手动下载**附带失败原因**（不再静默）；
 * 3. fallback 也失败则保持 loading 继续等 updater（90s 封顶），updater 可用
 *    仍出一键更新，否则报错（fallback 具体错误 > updater 具体错误 > 超时）。
 *
 * 总耗时：从「串行加和」变为「fallback 先到先显示 + updater 后到升级」。
 */

import type { AppUpdate, CheckUpdate } from '../types';

/** fallback 单路封顶（Rust 侧自带 20s 超时，这里是兜底）。 */
export const UPDATE_CHECK_TIMEOUT_MS = 30_000;

/** updater 单路封顶：该通道无内置超时，hang 住时不能无限等。 */
export const UPDATER_TIMEOUT_MS = 90_000;

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

/** fallback 通道结论：先到先展示。 */
export type FallbackView =
  | { kind: 'manual'; version: string; current: string; url: string }
  | { kind: 'upToDate'; current: string }
  | { kind: 'failed'; error: string; timedOut: boolean };

export function viewFallback(d: Settled<CheckUpdate>): FallbackView {
  if (d.ok && !d.value.error) {
    if (!d.value.upToDate) {
      return {
        kind: 'manual',
        version: d.value.latest,
        current: d.value.current,
        url: d.value.url,
      };
    }
    return { kind: 'upToDate', current: d.value.current };
  }
  return {
    kind: 'failed',
    error: d.ok ? d.value.error : d.error,
    timedOut: !d.ok && d.timedOut,
  };
}

/** updater 通道结论：后到做升级（一键更新）或备注（失败原因）。 */
export type UpdaterView =
  | { kind: 'one-click'; version: string; current: string; notes: string }
  | { kind: 'issue'; issue: UpdaterIssue }
  | { kind: 'none' };

export function viewUpdater(u: Settled<AppUpdate>): UpdaterView {
  if (u.ok && !u.value.error) {
    if (u.value.available) {
      const { version, current, notes } = u.value;
      return { kind: 'one-click', version, current, notes };
    }
    return { kind: 'none' };
  }
  return {
    kind: 'issue',
    issue: !u.ok
      ? u.timedOut
        ? { kind: 'timeout' }
        : { kind: 'backend-error', message: u.error }
      : { kind: 'backend-error', message: u.value.error },
  };
}

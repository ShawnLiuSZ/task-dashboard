import { describe, expect, it } from 'vitest';
import { decideUpdateState, settleWithTimeout, type Settled } from './updateCheck';
import type { AppUpdate, CheckUpdate } from '../types';

function appUpdate(over: Partial<AppUpdate> = {}): AppUpdate {
  return { available: false, version: '', current: '0.5.0', notes: '', error: '', ...over };
}

function checkUpdate(over: Partial<CheckUpdate> = {}): CheckUpdate {
  return { current: '0.5.0', latest: '0.5.0', upToDate: true, url: '', error: '', ...over };
}

function ok<T>(value: T): Settled<T> {
  return { ok: true, value };
}

function failed<T>(error: string): Settled<T> {
  return { ok: false, error, timedOut: false };
}

function timedOut<T>(): Settled<T> {
  return { ok: false, error: '', timedOut: true };
}

describe('decideUpdateState', () => {
  it('updater 可用时一键更新（fallback 失败也不影响）', () => {
    const d = decideUpdateState(
      ok(appUpdate({ available: true, version: '0.5.1', notes: 'n' })),
      failed<CheckUpdate>('network'),
    );
    expect(d).toEqual({ phase: 'available', version: '0.5.1', current: '0.5.0', notes: 'n' });
  });

  it('updater 报错 + fallback 有新版 → 手动下载并附带后端原因', () => {
    const d = decideUpdateState(
      ok(appUpdate({ error: '检查更新失败：boom' })),
      ok(checkUpdate({ upToDate: false, latest: '0.5.1', url: 'https://dl' })),
    );
    expect(d).toEqual({
      phase: 'available',
      version: '0.5.1',
      current: '0.5.0',
      notes: '',
      manualUrl: 'https://dl',
      updaterIssue: { kind: 'backend-error', message: '检查更新失败：boom' },
    });
  });

  it('updater 超时 + fallback 有新版 → 手动下载并附带超时原因', () => {
    const d = decideUpdateState(
      timedOut<AppUpdate>(),
      ok(checkUpdate({ upToDate: false, latest: '0.5.1', url: 'https://dl' })),
    );
    expect(d.phase).toBe('available');
    if (d.phase === 'available') {
      expect(d.manualUrl).toBe('https://dl');
      expect(d.updaterIssue).toEqual({ kind: 'timeout' });
    }
  });

  it('updater 健康但无更新 + fallback 有新版 → 手动下载且不附原因（版本窗口期，不吓用户）', () => {
    const d = decideUpdateState(
      ok(appUpdate()),
      ok(checkUpdate({ upToDate: false, latest: '0.5.1', url: 'https://dl' })),
    );
    expect(d.phase).toBe('available');
    if (d.phase === 'available') {
      expect(d.manualUrl).toBe('https://dl');
      expect(d.updaterIssue).toBeUndefined();
    }
  });

  it('fallback 已是最新 → 直接最新（updater 超时未知也不影响结论）', () => {
    expect(decideUpdateState(timedOut<AppUpdate>(), ok(checkUpdate())).phase).toBe('upToDate');
    expect(decideUpdateState(ok(appUpdate({ error: 'x' })), ok(checkUpdate())).phase).toBe(
      'upToDate',
    );
  });

  it('双双失败 → 报错，fallback 的具体错误优先', () => {
    const d = decideUpdateState(
      ok(appUpdate({ error: 'updater bad' })),
      failed<CheckUpdate>('api bad'),
    );
    expect(d).toEqual({ phase: 'error', message: 'api bad', timedOut: false });
  });

  it('fallback 超时 + updater 有具体错误 → 展示 updater 的错误', () => {
    const d = decideUpdateState(ok(appUpdate({ error: 'updater bad' })), timedOut<CheckUpdate>());
    expect(d).toEqual({ phase: 'error', message: 'updater bad', timedOut: true });
  });

  it('双双超时 → 超时错误（无具体文案，由调用方按 timedOut 展示）', () => {
    expect(decideUpdateState(timedOut<AppUpdate>(), timedOut<CheckUpdate>())).toEqual({
      phase: 'error',
      message: '',
      timedOut: true,
    });
  });
});

describe('settleWithTimeout', () => {
  it('按时返回则透传值', async () => {
    await expect(settleWithTimeout(Promise.resolve(42), 1000)).resolves.toEqual({
      ok: true,
      value: 42,
    });
  });

  it('抛错收敛为失败（不向上传播）', async () => {
    await expect(settleWithTimeout(Promise.reject(new Error('nope')), 1000)).resolves.toEqual({
      ok: false,
      error: 'nope',
      timedOut: false,
    });
  });

  it('hang 住收敛为超时', async () => {
    await expect(settleWithTimeout(new Promise(() => {}), 20)).resolves.toEqual({
      ok: false,
      error: '',
      timedOut: true,
    });
  });
});

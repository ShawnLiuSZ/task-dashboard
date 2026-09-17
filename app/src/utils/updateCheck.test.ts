import { describe, expect, it } from 'vitest';
import { settleWithTimeout, viewFallback, viewUpdater, type Settled } from './updateCheck';
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

describe('viewFallback', () => {
  it('有新版 → 先展示手动下载', () => {
    expect(
      viewFallback(ok(checkUpdate({ upToDate: false, latest: '0.5.1', url: 'https://dl' }))),
    ).toEqual({ kind: 'manual', version: '0.5.1', current: '0.5.0', url: 'https://dl' });
  });

  it('已是最新 → 直接最新（updater 状态不影响结论）', () => {
    expect(viewFallback(ok(checkUpdate()))).toEqual({ kind: 'upToDate', current: '0.5.0' });
  });

  it('后端报错 → 失败并保留原文', () => {
    expect(viewFallback(ok(checkUpdate({ error: 'api bad' })))).toEqual({
      kind: 'failed',
      error: 'api bad',
      timedOut: false,
    });
  });

  it('抛错/超时 → 失败并标记超时', () => {
    expect(viewFallback(failed<CheckUpdate>('network'))).toEqual({
      kind: 'failed',
      error: 'network',
      timedOut: false,
    });
    expect(viewFallback(timedOut<CheckUpdate>())).toEqual({
      kind: 'failed',
      error: '',
      timedOut: true,
    });
  });
});

describe('viewUpdater', () => {
  it('返回可用更新 → 一键更新', () => {
    expect(viewUpdater(ok(appUpdate({ available: true, version: '0.5.1', notes: 'n' })))).toEqual({
      kind: 'one-click',
      version: '0.5.1',
      current: '0.5.0',
      notes: 'n',
    });
  });

  it('健康但无更新 → 无动作（不覆盖 fallback 已展示的内容）', () => {
    expect(viewUpdater(ok(appUpdate()))).toEqual({ kind: 'none' });
  });

  it('后端报错 → 失败原因备注', () => {
    expect(viewUpdater(ok(appUpdate({ error: '检查更新失败：boom' })))).toEqual({
      kind: 'issue',
      issue: { kind: 'backend-error', message: '检查更新失败：boom' },
    });
  });

  it('抛错/超时 → 失败原因备注', () => {
    expect(viewUpdater(failed<AppUpdate>('network'))).toEqual({
      kind: 'issue',
      issue: { kind: 'backend-error', message: 'network' },
    });
    expect(viewUpdater(timedOut<AppUpdate>())).toEqual({
      kind: 'issue',
      issue: { kind: 'timeout' },
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

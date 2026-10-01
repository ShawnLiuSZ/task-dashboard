import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { systemThemeListenerBound, themeManager, type ThemeMode } from './theme';

/**
 * #329 / #343：系统主题监听不得泄漏，且解绑必须真正生效。
 *
 * #329：旧实现里 `setMode('auto')` 每次都 `matchMedia(...).addEventListener(...)`
 * 且从不移除 —— 既泄漏监听器，又会在用户显式选定 light/dark 后仍被系统切换回调
 * `applyTheme('auto')` 覆盖（「选了浅色，系统一换主题 App 跟着变」）。#329 加了
 * add/remove，但只记了**函数引用**，解绑时重新 `matchMedia()` 取对象。
 *
 * #343：那仍是 no-op —— 按 CSSOM View 规范，`Window.matchMedia(q)` 每次返回
 * **new** MediaQueryList（各自独立的 EventTarget 监听列表）。在**新对象**上
 * `removeEventListener` 触碰不到挂在**旧对象**上的监听器 ⇒ #329 想修的缺陷
 * 实际完全没修好，且监听器随每次 `setMode('auto')` 线性泄漏。
 *
 * 旧打桩 `matchMedia: () => media` 永远返回**同一**对象 —— 与平台行为正好相反，
 * 致使该缺陷在测试里看着通过。本文件按平台语义重写打桩。
 *
 * theme.ts 是模块单例（无 React 依赖），本用例直接复用全局实例；
 * node 环境下 `window` 不存在，模块加载时的自动绑定会走 catch 分支（未绑定），
 * 每个用例先 `setMode('light')` 归零再断言增量。
 */

interface FakeMql {
  query: string;
  matches: boolean;
  /** 本实例当前挂着的监听器集合（真实语义：remove 只影响同一个实例）。 */
  listeners: Set<string>;
  addEventListener(type: string, fn: unknown): void;
  removeEventListener(type: string, fn: unknown): void;
}

let instances: FakeMql[] = [];
type ListenerSpy = ReturnType<typeof vi.fn> & ((type: string, fn: unknown) => void);
let addSpy: ListenerSpy;
let removeSpy: ListenerSpy;

/** 按平台语义打桩：每次 matchMedia 产出**新对象**，监听集合挂在各自实例上。 */
function stubEnv() {
  instances = [];
  // 用 function 表达式保留 `this`（theme.ts 以方法调用形式传入实例）
  addSpy = vi.fn(function (this: FakeMql, _type: string, fn: unknown) {
    this.listeners.add(String(fn));
  }) as unknown as ListenerSpy;
  removeSpy = vi.fn(function (this: FakeMql, _type: string, fn: unknown) {
    this.listeners.delete(String(fn));
  }) as unknown as ListenerSpy;
  const matchMedia = (query: string): FakeMql => {
    const mql: FakeMql = {
      query,
      matches: false,
      listeners: new Set<string>(),
      addEventListener: addSpy,
      removeEventListener: removeSpy,
    };
    instances.push(mql);
    return mql;
  };
  vi.stubGlobal('window', { matchMedia });
  vi.stubGlobal('localStorage', {
    getItem: () => 'auto',
    setItem: () => {},
    removeItem: () => {},
  });
  vi.stubGlobal('document', { documentElement: { setAttribute: () => {} } });
  return { addEventListener: addSpy, removeEventListener: removeSpy, matchMedia };
}

let add: ReturnType<typeof vi.fn>;
let remove: ReturnType<typeof vi.fn>;

/** 归零：light 会解绑历史绑定。返回本用例内的增量统计（调用次数口径）。 */
function baseline() {
  themeManager.setMode('light');
  const a0 = add.mock.calls.length;
  const r0 = remove.mock.calls.length;
  return {
    added: () => add.mock.calls.length - a0,
    removed: () => remove.mock.calls.length - r0,
    active: () => add.mock.calls.length - a0 - (remove.mock.calls.length - r0),
  };
}

/**
 * 真实语义的度量：**当前仍挂着监听器的实例总数**。
 *
 * 旧实现每次 bind 拿新对象、unbind 又拿另一个对象去 remove ⇒ 旧实例的监听器
 * 永远摘不掉 ⇒ 该计数随 `setMode('auto')` 次数线性增长。
 */
function liveListeners(): number {
  return instances.reduce((n, m) => n + m.listeners.size, 0);
}

/** 找出某个函数当前挂在哪些实例上（用于断言「解绑作用于同一实例」）。 */
function instancesHolding(fn: string): number[] {
  return instances.map((m, i) => (m.listeners.has(fn) ? i : -1)).filter((i) => i >= 0);
}

describe('theme 系统主题监听（#329 / #343）', () => {
  beforeEach(() => {
    const env = stubEnv();
    add = env.addEventListener;
    remove = env.removeEventListener;
  });
  afterEach(() => vi.unstubAllGlobals());

  it('auto 模式下重复 setMode 不累积监听器（净注册数恒为 1）', () => {
    const c = baseline();
    expect(systemThemeListenerBound()).toBe(false);
    themeManager.setMode('auto');
    themeManager.setMode('auto');
    themeManager.setMode('auto');
    // 每次都是「先解绑再绑定」→ 增量差恒为 1，不会线性增长
    expect(c.added()).toBe(3);
    expect(c.removed()).toBe(2);
    expect(c.active()).toBe(1);
    expect(systemThemeListenerBound()).toBe(true);
  });

  it('切到显式 light / dark 时解绑（系统主题变化不再覆盖用户选择）', () => {
    const c = baseline();
    themeManager.setMode('auto');
    expect(c.active()).toBe(1);
    themeManager.setMode('light');
    expect(c.active()).toBe(0);
    expect(systemThemeListenerBound()).toBe(false);
    themeManager.setMode('dark');
    expect(c.active()).toBe(0);
    expect(systemThemeListenerBound()).toBe(false);
    // 回到 auto 重新绑定
    themeManager.setMode('auto');
    expect(c.active()).toBe(1);
    expect(systemThemeListenerBound()).toBe(true);
  });

  it('解绑用同一函数引用（否则 removeEventListener 静默失效）', () => {
    baseline();
    // 不用 `.at(-1)`：tsconfig 的 lib 低于 es2022，`Array.prototype.at` 不可用。
    const last = <T>(arr: T[]) => arr[arr.length - 1];
    themeManager.setMode('auto');
    const first = last(add.mock.calls)[1];
    themeManager.setMode('auto');
    expect(last(add.mock.calls)[1]).toBe(first);
    expect(last(remove.mock.calls)[1]).toBe(first);
  });

  it('#343 跨实例解绑无效：真正活着的监听器不随 setMode(auto) 增长', () => {
    baseline();
    themeManager.setMode('auto');
    themeManager.setMode('auto');
    themeManager.setMode('auto');
    // 调用次数口径看不出问题（旧实现在此也「是 1」）——
    // 必须查**各实例自己的监听集合**，那才是浏览器上的真实状态。
    expect(liveListeners(), '同一时刻只应有一个实例挂着监听器').toBe(1);
  });

  it('#343 切到 light 后，先前实例上的监听器确实被摘掉', () => {
    baseline();
    themeManager.setMode('auto');
    const handler = add.mock.calls[add.mock.calls.length - 1][1];
    const boundIdx = instancesHolding(String(handler));
    expect(boundIdx, '绑定时应挂在某个实例上').toHaveLength(1);

    themeManager.setMode('light');

    // 解绑必须作用于**同一个实例**；若实现重新 matchMedia 取新对象，
    // 这里就会残留 1 个（且 removeSpy 是调在新实例上的）。
    expect(
      instances[boundIdx[0]].listeners.has(String(handler)),
      '切到 light 后原实例的监听器必须被摘掉',
    ).toBe(false);
    expect(liveListeners(), '切到 light 后不应有任何实例挂着监听器').toBe(0);
    // 且 removeEventListener 是挂在**绑定期那个实例**上调用的
    expect(
      removeSpy.mock.instances.includes(instances[boundIdx[0]] as object),
      'removeEventListener 必须在绑定时的同一实例上调用',
    ).toBe(true);
  });

  it('#343 反复切 light/auto 不累积实例上的监听器', () => {
    baseline();
    for (let i = 0; i < 5; i++) {
      themeManager.setMode('auto');
      themeManager.setMode('light');
    }
    expect(liveListeners(), '5 轮切换后不应有残留监听器').toBe(0);
    expect(systemThemeListenerBound()).toBe(false);
  });

  it('三个模式都能应用 data-theme（不因监听改动而退化）', () => {
    baseline();
    const setAttribute = vi.fn();
    vi.stubGlobal('document', { documentElement: { setAttribute } });
    for (const mode of ['light', 'dark', 'auto'] as ThemeMode[]) {
      themeManager.setMode(mode);
    }
    const values = setAttribute.mock.calls.map((c) => c[1]);
    expect(values).toEqual(expect.arrayContaining(['light', 'dark']));
  });
});

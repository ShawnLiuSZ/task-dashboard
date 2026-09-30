import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { systemThemeListenerBound, themeManager, type ThemeMode } from './theme';

/**
 * #329：系统主题监听不得泄漏。
 *
 * 旧实现里 `setMode('auto')` 每次都 `matchMedia(...).addEventListener('change', ...)`
 * 且从不移除：既造成监听器泄漏，又会在用户显式选定 light/dark 后仍被系统切换回调
 * `applyTheme('auto')` 覆盖（「选了浅色，系统一换主题 App 跟着变」）。
 *
 * theme.ts 是模块单例（无 React 依赖），本用例直接复用全局实例；
 * node 环境下 `window` 不存在，模块加载时的自动绑定会走 catch 分支（未绑定），
 * 每个用例先 `setMode('light')` 归零再断言增量。
 */
function stubEnv() {
  const addEventListener = vi.fn();
  const removeEventListener = vi.fn();
  const media = { matches: false, addEventListener, removeEventListener };
  vi.stubGlobal('window', { matchMedia: () => media });
  vi.stubGlobal('localStorage', {
    getItem: () => 'auto',
    setItem: () => {},
    removeItem: () => {},
  });
  vi.stubGlobal('document', { documentElement: { setAttribute: () => {} } });
  return { addEventListener, removeEventListener };
}

let add: ReturnType<typeof vi.fn>;
let remove: ReturnType<typeof vi.fn>;

/** 归零：light 会解绑历史绑定。返回本用例内的增量统计。 */
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

describe('theme 系统主题监听（#329）', () => {
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

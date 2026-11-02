import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SIDEBAR_PREF,
  getSidebarPref,
  nextSidebarPref,
  resolveSidebarCollapsed,
  setSidebarPref,
} from './sidebarPrefs';

/**
 * 侧边栏收起偏好（#517）。
 *
 * ## 核心不变式
 *
 * 1. **用户显式选择 > 环境默认**：用户点过之后，窗口宽度变化**不得**推翻他的选择
 *    （否则窄窗下点「展开」会没反应 ⇒ 按钮像坏了）。
 * 2. **从未选择过 ⇒ 跟随窗口宽度**（保持 #265 的响应式行为）。
 * 3. 非法值（手改 localStorage / 旧版本残留）⇒ 回落到 `'auto'`，**不**落到看不懂的状态。
 * 4. `localStorage` 不可用（隐私模式 / 非浏览器环境）⇒ **静默降级**，不抛错。
 */

/** 可读写的 localStorage 桩（记录写入，便于断言）。 */
function makeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k: string, v: string) => {
      map.delete(k);
      map.set(k, String(v));
    },
    removeItem: (k: string) => {
      map.delete(k);
    },
    clear: () => map.clear(),
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    get length() {
      return map.size;
    },
    _dump: () => Object.fromEntries(map),
  };
}

let storage: ReturnType<typeof makeStorage>;

beforeEach(() => {
  storage = makeStorage();
  vi.stubGlobal('localStorage', storage);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('侧边栏偏好读写（#517）', () => {
  it('默认是 auto（未明确选择 ⇒ 跟随窗口宽度）', () => {
    expect(getSidebarPref()).toBe('auto');
    expect(DEFAULT_SIDEBAR_PREF).toBe('auto');
  });

  it('写入后能读回（三态都覆盖）', () => {
    for (const p of ['auto', 'collapsed', 'expanded'] as const) {
      setSidebarPref(p);
      expect(getSidebarPref()).toBe(p);
    }
  });

  it('非法值一律回落到 auto（不落到看不懂的状态）', () => {
    storage.setItem('taskboard.sidebarCollapsed', 'garbage');
    expect(getSidebarPref()).toBe('auto');
    storage.setItem('taskboard.sidebarCollapsed', '');
    expect(getSidebarPref()).toBe('auto');
  });

  it('localStorage 不可用时静默降级（不抛错）', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    });
    expect(() => getSidebarPref()).not.toThrow();
    expect(getSidebarPref()).toBe('auto');
    expect(() => setSidebarPref('collapsed')).not.toThrow();
  });
});

describe('实际收起状态 = 偏好 + 窄窗（#517）', () => {
  it('auto ⇒ 跟随窗口宽度', () => {
    expect(resolveSidebarCollapsed('auto', false)).toBe(false);
    expect(resolveSidebarCollapsed('auto', true)).toBe(true);
  });

  it('collapsed ⇒ 任何窗口宽度都收起', () => {
    expect(resolveSidebarCollapsed('collapsed', false)).toBe(true);
    expect(resolveSidebarCollapsed('collapsed', true)).toBe(true);
  });

  it('expanded ⇒ 任何窗口宽度都展开（**覆盖**窄窗强制）', () => {
    expect(resolveSidebarCollapsed('expanded', false)).toBe(false);
    expect(resolveSidebarCollapsed('expanded', true)).toBe(false);
  });
});

describe('点击「收起 / 展开」后的新偏好（#517）', () => {
  it('展开态点 ⇒ collapsed', () => {
    expect(nextSidebarPref('auto', false)).toBe('collapsed');
    expect(nextSidebarPref('expanded', false)).toBe('collapsed');
  });

  it('折叠态点 ⇒ expanded', () => {
    expect(nextSidebarPref('collapsed', false)).toBe('expanded');
  });

  it('⚠️ 窄窗 + auto（被强制收起）⇒ 点「展开」得到 expanded（点了不能没反应）', () => {
    expect(nextSidebarPref('auto', true)).toBe('expanded');
  });

  it('⚠️ 窄窗 + expanded（用户已显式展开）⇒ 点「收起」得到 collapsed', () => {
    expect(nextSidebarPref('expanded', true)).toBe('collapsed');
  });

  it('点一次就落到具体态（不再 auto）⇒ 之后窗口 resize 不再推翻用户选择', () => {
    const next = nextSidebarPref('auto', true);
    expect(next).not.toBe('auto');
    // 用户显式展开 ⇒ 窗口变宽后仍是展开（不被环境默认推翻）。
    expect(resolveSidebarCollapsed(next, false)).toBe(false);
  });
});

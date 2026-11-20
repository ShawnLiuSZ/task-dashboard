import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyGlass, glassPrefs } from './glassPrefs';

/**
 * 毛玻璃偏好回归测试。
 *
 * 覆盖三组不变量：
 *  ① 持久化：只有显式存 `on` 才算开启；缺失 / 脏值一律关闭（默认关）。
 *  ② 门禁写入：开启 → `<html data-glass="on">`；关闭 → 移除属性（不残留）。
 *  ③ 模块加载即应用：首屏按持久化状态写入属性（防 FOUC），需 resetModules
 *     + 动态 import 复现「模块体在 stub 之后执行」。
 *
 * ⚠️ 与 theme.ts 的 #399 同类陷阱：若把「模块加载期逻辑」直接放顶层静态
 * import（在 beforeEach 的 stub 之前执行），`document` / `localStorage` 不存在，
 * 会被 try/catch 静默吞掉 ⇒ 那一段**无任何测试能发现**。故 ③ 用 resetModules
 * 单独验证，确保它真实跑过。
 */

const GLASS_KEY = 'taskboard.glassEffect';

let store: Map<string, string>;
/** 记录 documentElement 的属性写入，供断言。 */
let attrs: string[];

function stubStorage() {
  store = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => (store.has(k) ? store.get(k) : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  });
}

function stubDom() {
  attrs = [];
  vi.stubGlobal('document', {
    documentElement: {
      setAttribute: (n: string, v: string) => void attrs.push(`set:${n}=${v}`),
      removeAttribute: (n: string) => void attrs.push(`del:${n}`),
    },
  });
}

beforeEach(() => {
  stubStorage();
  stubDom();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('偏好读取：默认关 + 只认显式 `on`（#毛玻璃）', () => {
  it('默认态（无 key）= 关闭', () => {
    expect(glassPrefs.getEnabled()).toBe(false);
  });

  it('只有显式存 `on` 才算开启', () => {
    store.set(GLASS_KEY, 'on');
    expect(glassPrefs.getEnabled()).toBe(true);
  });

  it('脏值（true / 1 / 空串 / 大写 ON）一律视为关闭，绝不原样透传', () => {
    for (const bad of ['true', '1', '', 'ON', 'enabled', 'yes']) {
      store.set(GLASS_KEY, bad);
      expect(glassPrefs.getEnabled(), `"${bad}" 应视为关闭`).toBe(false);
    }
  });
});

describe('门禁写入：<html data-glass> 与持久化同步（#毛玻璃）', () => {
  it('开启 → 写 localStorage `on` + 设 data-glass="on"', () => {
    glassPrefs.setEnabled(true);
    expect(localStorage.getItem(GLASS_KEY)).toBe('on');
    expect(attrs).toContain('set:data-glass=on');
  });

  it('关闭 → 移除 localStorage key + 移除 data-glass 属性（不残留旧值）', () => {
    store.set(GLASS_KEY, 'on');
    glassPrefs.setEnabled(false);
    expect(localStorage.getItem(GLASS_KEY)).toBeNull();
    expect(attrs).toContain('del:data-glass');
    expect(attrs).not.toContain('set:data-glass=on');
  });

  it('applyGlass 直调：true 设属性 / false 移除属性（供设置面板即时应用）', () => {
    applyGlass(true);
    expect(attrs).toContain('set:data-glass=on');
    attrs = [];
    applyGlass(false);
    expect(attrs).toContain('del:data-glass');
  });
});

describe('模块加载即应用（防 FOUC，#毛玻璃）', () => {
  it('持久化为开启时，模块体执行即设 data-glass="on"', async () => {
    store.set(GLASS_KEY, 'on');
    // resetModules：让模块体在 stub 之后重新执行（复现「首屏读取持久化」路径）。
    vi.resetModules();
    await import('./glassPrefs');
    expect(attrs).toContain('set:data-glass=on');
  });

  it('无持久化时，模块体执行不设 data-glass（保持关闭）', async () => {
    vi.resetModules();
    await import('./glassPrefs');
    expect(attrs).not.toContain('set:data-glass=on');
  });
});

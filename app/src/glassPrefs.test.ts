import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyGlass, glassPrefs } from './glassPrefs';
import type { GlassLevel } from './glassPrefs';

/**
 * 毛玻璃偏好回归测试（#606：布尔 → 3 档透明度）。
 *
 * 覆盖四组不变量：
 *  ① 读取：默认关；新 key 只认白名单 1/2/3；旧 `on` 平滑迁移到档 2。
 *  ② 门禁写入：<html data-glass-level="N"> 或移除；持久化同步。
 *  ③ 兼容接口：setEnabled(true/false) → 档 2 / 关闭。
 *  ④ 模块加载即应用（防 FOUC）：首屏按持久化档位写属性，需 resetModules
 *     + 动态 import 复现「模块体在 stub 之后执行」。
 *
 * ⚠️ 与 theme.ts 的 #399 同类陷阱：若把「模块加载期逻辑」直接放顶层静态
 * import（在 beforeEach 的 stub 之前执行），`document` / `localStorage` 不存在，
 * 会被 try/catch 静默吞掉 ⇒ 那一段**无任何测试能发现**。故 ④ 用 resetModules
 * 单独验证，确保它真实跑过。
 */

const LEVEL_KEY = 'taskboard.glassLevel';
const LEGACY_KEY = 'taskboard.glassEffect';

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

describe('档位读取：默认关 + 白名单 1/2/3（#606）', () => {
  it('默认态（无 key）= 关闭', () => {
    expect(glassPrefs.getLevel()).toBeNull();
    expect(glassPrefs.getEnabled()).toBe(false);
  });

  it('新 key 只认 1/2/3（数字或字符串），其余脏值一律关闭', () => {
    for (const good of [1, 2, 3, '1', '2', '3'] as const) {
      store.set(LEVEL_KEY, String(good));
      expect(glassPrefs.getLevel(), `"${good}" 应为有效档位`).toBe(Number(good));
    }
    for (const bad of ['0', '4', 'true', '', 'ON', '1.5', '-1', ' 2 ']) {
      store.set(LEVEL_KEY, bad);
      expect(glassPrefs.getLevel(), `"${bad}" 应视为关闭`).toBeNull();
    }
  });

  it('旧 `on` 平滑迁移到档 2（升级后老用户不丢失开启状态）', () => {
    store.set(LEGACY_KEY, 'on');
    expect(glassPrefs.getLevel()).toBe(2);
    expect(glassPrefs.getEnabled()).toBe(true);
  });

  it('新 key 脏值优先于旧 on（用户显式改过就不迁移），视为关闭', () => {
    store.set(LEVEL_KEY, 'garbage');
    store.set(LEGACY_KEY, 'on');
    expect(glassPrefs.getLevel()).toBeNull();
  });
});

describe('门禁写入：<html data-glass-level> 与持久化同步（#606）', () => {
  it('setLevel(档位) → 写新 key + 设 data-glass-level="N" + 清除旧 key', () => {
    store.set(LEGACY_KEY, 'on');
    glassPrefs.setLevel(1);
    expect(localStorage.getItem(LEVEL_KEY)).toBe('1');
    expect(localStorage.getItem(LEGACY_KEY)).toBeNull();
    expect(attrs).toContain('set:data-glass-level=1');
  });

  it('setLevel(null) → 移除两个 key + 移除属性（不残留旧值）', () => {
    store.set(LEVEL_KEY, '3');
    store.set(LEGACY_KEY, 'on');
    glassPrefs.setLevel(null);
    expect(localStorage.getItem(LEVEL_KEY)).toBeNull();
    expect(localStorage.getItem(LEGACY_KEY)).toBeNull();
    expect(attrs).toContain('del:data-glass-level');
    expect(attrs).not.toContain('set:data-glass-level=3');
  });

  it('越界/脏档位被白名单挡下，不写 DOM', () => {
    glassPrefs.setLevel(99 as GlassLevel);
    expect(attrs).toContain('del:data-glass-level');
    expect(attrs).not.toContain('set:data-glass-level=99');
    expect(localStorage.getItem(LEVEL_KEY)).toBeNull();
  });

  it('兼容 setEnabled(true/false)：on → 档 2，off → 关闭', () => {
    glassPrefs.setEnabled(true);
    expect(localStorage.getItem(LEVEL_KEY)).toBe('2');
    expect(attrs).toContain('set:data-glass-level=2');
    attrs = [];
    glassPrefs.setEnabled(false);
    expect(localStorage.getItem(LEVEL_KEY)).toBeNull();
    expect(attrs).toContain('del:data-glass-level');
  });

  it('applyGlass 直调：档位设属性 / null 移除属性（供设置面板即时应用）', () => {
    applyGlass(3);
    expect(attrs).toContain('set:data-glass-level=3');
    attrs = [];
    applyGlass(null);
    expect(attrs).toContain('del:data-glass-level');
  });
});

describe('模块加载即应用（防 FOUC，#606）', () => {
  it('持久化为档 2 时，模块体执行即设 data-glass-level="2"', async () => {
    store.set(LEVEL_KEY, '2');
    vi.resetModules();
    await import('./glassPrefs');
    expect(attrs).toContain('set:data-glass-level=2');
  });

  it('旧 on 值在首屏也应用为档 2（迁移路径在模块加载期生效）', async () => {
    store.set(LEGACY_KEY, 'on');
    vi.resetModules();
    await import('./glassPrefs');
    expect(attrs).toContain('set:data-glass-level=2');
  });

  it('无持久化时，模块体执行不设属性（保持关闭）', async () => {
    vi.resetModules();
    await import('./glassPrefs');
    expect(attrs).not.toContain('set:data-glass-level=1');
    expect(attrs).not.toContain('set:data-glass-level=2');
    expect(attrs).not.toContain('set:data-glass-level=3');
  });
});

describe('白名单 ↔ i18n 词条一一对应（防动态 key 把 key 显示到界面）', () => {
  it('每个档位都有对应词条（t() 对缺失 key 返回 key 本身）', async () => {
    const [zh, en] = await Promise.all([
      import('./i18n/locales/zh-CN.json'),
      import('./i18n/locales/en-US.json'),
    ]);
    for (const level of [1, 2, 3] as const) {
      const key = `settings.glassLevel${level}`;
      expect(key in zh.default, `zh-CN 缺 ${key}`).toBe(true);
      expect(key in en.default, `en-US 缺 ${key}`).toBe(true);
    }
  });
});

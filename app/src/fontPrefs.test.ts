import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_FONT_FAMILY,
  DEFAULT_FONT_SIZE,
  DEFAULT_MONO_FAMILY,
  FONT_SIZE_PRESETS,
  applyFontPrefs,
  detectAvailableFonts,
  fontPrefs,
  getFontFamily,
  getFontSize,
  getMonoFamily,
} from './fontPrefs';

/**
 * #444 字体偏好回归测试。
 *
 * 覆盖三组不变量：
 *  ① 持久化：读非法值必须回落默认（localStorage 可被同源脚本 / 旧版本写脏）。
 *  ② CSS 变量写入：字号 / 界面栈 / 等宽栈三者的**相互关系**才是断言重点
 *     （等宽「跟随界面」时必须带上界面字体）。
 *  ③ 探测判别力：`detectAvailableFonts` 靠 canvas 宽度差判存在性，
 *     打桩必须**模拟真实引擎语义**——字体不存在时回退到基准字体、宽度不变。
 *
 * ⚠️ 探测测试最容易写成恒真：若打桩里「任何字体名都让宽度变化」，
 * 则连不存在的字体也会被判为可用，测试全绿而线上把 25 个候选全列出来。
 * 故下方桩严格区分「命中字体」与「未命中回退」，并有专门的负向用例。
 */

const FONT_SIZE_KEY = 'taskboard.fontSize';
const FAMILY_KEY = 'taskboard.fontFamily';
const MONO_KEY = 'taskboard.monoFamily';

type StyleBag = Record<string, string>;

/** 记录 setProperty 调用的假 documentElement。 */
let styleProps: StyleBag;
let setPropertySpy: ReturnType<typeof vi.fn>;

/**
 * 内存版 localStorage。仓库无 jsdom（§2.5 不引入新依赖）⇒ 必须自备桩，
 * 沿用 theme.test.ts 的 `vi.stubGlobal` 手法，但要**可写可读**（主题桩是只读的）。
 */
let store: Map<string, string>;

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
  styleProps = {};
  setPropertySpy = vi.fn((name: string, value: string) => {
    styleProps[name] = value;
  });
  vi.stubGlobal('document', {
    documentElement: { style: { setProperty: setPropertySpy } },
    createElement: () => null,
  });
}

/**
 * canvas 宽度桩 —— 模拟**字体是否已安装**，而非模拟栈位置。
 *
 * @param widths 字体名 → 已安装该字体时的测量宽度。
 *
 * ⚠️ 真实语义：字体一旦安装，无论它出现在 font-family 栈的哪个位置
 * （第1 位还是第 2 位），引擎都会采用它 ⇒ 两条探测栈（`, monospace` /
 * `, sans-serif`）测出的宽度**相同**。故桩按「名字是否在 widths 里」决定，
 * 未安装则两条栈都回退到各自基准。
 *
 * 之前把「是否命中」绑到栈位置（只查首个族名）是不正确的建模，会让
 * 「只满足双基准之一」的用例失去意义 —— 那不是浏览器会发生的事。
 */
function stubCanvas(widths: Record<string, number>, baseMono: number, baseSans: number) {
  const ctx = {
    font: '',
    measureText: (_s: string) => {
      const m = /(\d+)px\s+(.+)$/.exec(ctx.font);
      const spec = m ? m[2] : '';
      const parts = spec.split(',').map((x) => x.trim());
      // 栈里任一位置命中已安装字体 → 采用它（宽度与 generic 无关）
      for (const p of parts) {
        const name = p.replace(/^["']|["']$/g, '');
        if (name in widths) return { width: widths[name] };
      }
      // 全部未命中 → 回退到通用族基准
      return { width: parts.includes('monospace') ? baseMono : baseSans };
    },
  };
  vi.stubGlobal('document', {
    documentElement: { style: { setProperty: setPropertySpy } },
    createElement: () => ({ getContext: () => ctx }),
  });
  return ctx;
}

beforeEach(() => {
  stubStorage();
  stubDom();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('偏好读取：非法值回落默认（#444）', () => {
  it('默认态：字号 13px、两个字体均为「跟随」', () => {
    expect(getFontSize()).toBe(DEFAULT_FONT_SIZE);
    expect(getFontFamily()).toBe(DEFAULT_FONT_FAMILY);
    expect(getMonoFamily()).toBe(DEFAULT_MONO_FAMILY);
  });

  it('localStorage 里是合法值时按值返回', () => {
    localStorage.setItem(FONT_SIZE_KEY, '18');
    localStorage.setItem(FAMILY_KEY, 'PingFang SC');
    localStorage.setItem(MONO_KEY, 'Menlo');
    expect(getFontSize()).toBe(18);
    expect(getFontFamily()).toBe('PingFang SC');
    expect(getMonoFamily()).toBe('Menlo');
  });

  it('非法字号（9 / 100 / abc / 空串）一律回落默认，绝不原样透传', () => {
    for (const bad of ['9', '100', 'abc', '', '13.5', 'NaN']) {
      localStorage.setItem(FONT_SIZE_KEY, bad);
      expect(getFontSize(), `"${bad}" 应回落默认`).toBe(DEFAULT_FONT_SIZE);
    }
  });

  it('字号预设档位与基准的关系（默认档必须等于 DEFAULT_FONT_SIZE）', () => {
    expect(FONT_SIZE_PRESETS).toContain(DEFAULT_FONT_SIZE);
    // 档位递增且含默认档（UI 按此顺序渲染 chip）
    expect([...FONT_SIZE_PRESETS]).toEqual([...FONT_SIZE_PRESETS].sort((a, b) => a - b));
  });
});

describe('CSS 变量写入（#444）', () => {
  it('setFontSize 写 localStorage 并把 --font-size-base 更新为该档 px', () => {
    fontPrefs.setFontSize(16);
    expect(localStorage.getItem(FONT_SIZE_KEY)).toBe('16');
    expect(styleProps['--font-size-base']).toBe('16px');
  });

  it('设置界面字体后 --font-ui 以该字体开头，且含跨平台兜底栈', () => {
    fontPrefs.setFontFamily('PingFang SC');
    const ui = styleProps['--font-ui'];
    expect(ui.startsWith('"PingFang SC"'), `实际: ${ui}`).toBe(true);
    // 兜底栈必须保留，否则在没装该字体的机器上会退化成浏览器默认 serif
    expect(ui).toMatch(/sans-serif\s*$/);
  });

  it('含空格的族名加引号（不加引号在部分引擎解析异常）', () => {
    fontPrefs.setFontFamily('PingFang SC');
    expect(styleProps['--font-ui']).toContain('"PingFang SC"');
  });

  it('CSS 注入尝试被白名单挡下：非候选清单的名字回落为「跟随」', () => {
    // localStorage 可被同源脚本写脏 ⇒ 不能把它直接塞进 setProperty
    fontPrefs.setFontFamily('"; background: url(evil)');
    const ui = styleProps['--font-ui'];
    expect(ui).not.toContain('url(evil)');
    // 回落 = 栈里不含任何引号内注入内容
    expect(ui.startsWith('-apple-system')).toBe(true);
  });

  it('等宽「跟随界面」时 --font-mono 带上界面字体；选具体字体时替换而非追加', () => {
    fontPrefs.setFontFamily('Helvetica Neue');
    fontPrefs.setMonoFamily('');
    const mono = styleProps['--font-mono'];
    expect(mono, '跟随界面时等宽栈应含界面字体').toContain('"Helvetica Neue"');
    expect(mono).toMatch(/monospace\s*$/);

    // 选一款**在候选清单内**的字体（Optima）作为等宽字体
    fontPrefs.setMonoFamily('Optima');
    const mono2 = styleProps['--font-mono'];
    expect(mono2).toMatch(/^"?Optima"?\s*,/);
    // 显式选字体后不应再把界面字体塞进等宽栈（否则等宽优先命中界面字体）
    expect(mono2).not.toContain('"Helvetica Neue"');
  });

  it('不在候选清单内的字体名被白名单挡下，等宽回落系统等宽兜底', () => {
    // Menlo 是系统等宽字体（**本身就在兜底栈里**），但不在界面候选清单里 ——
    // 它不该出现在界面/等宽的下拉选项中。若用户改 localStorage 塞入它，
    // 不得被当作「用户选择」提升到栈首（那等于凭空多出一个可选项语义）。
    fontPrefs.setMonoFamily('Menlo');
    const mono = styleProps['--font-mono'];
    // 栈首必须是内置兜底族，而非用户输入
    expect(mono.startsWith('SF Mono')).toBe(true);
    expect(mono).toMatch(/monospace\s*$/);
    // 且恰好等于「未选字体」的兜底栈（用户输入未产生任何差异）
    fontPrefs.setMonoFamily('');
    expect(styleProps['--font-mono']).toBe(mono);
  });

  it('applyFontPrefs 显式传参时不读取持久化（供面板「即时预览」用）', () => {
    localStorage.setItem(FONT_SIZE_KEY, '18');
    applyFontPrefs(12, 'Optima', '');
    expect(styleProps['--font-size-base']).toBe('12px');
    expect(styleProps['--font-ui'].startsWith('Optima')).toBe(true);
  });
});

describe('字体探测的判别力（#444）', () => {
  const BASE_MONO = 500;
  const BASE_SANS = 520;

  it('只返回「命中宽度与两条基准都不同」的字体；未命中的回退字体被排除', () => {
    // 只有 Helvetica Neue 与 Optima 真实存在；其余候选引擎回退 ⇒ 宽度等于基准
    stubCanvas({ 'Helvetica Neue': 610, Optima: 700 }, BASE_MONO, BASE_SANS);
    const found = detectAvailableFonts();
    expect(found).toContain('Helvetica Neue');
    expect(found).toContain('Optima');
    // 关键负向断言：PingFang SC 未注册 ⇒ 不得出现在结果里
    expect(found).not.toContain('PingFang SC');
    expect(found).not.toContain('Microsoft YaHei');
  });

  it('探测不到任何字体时返回空数组（面板据此只显示「跟随系统」）', () => {
    stubCanvas({}, BASE_MONO, BASE_SANS);
    expect(detectAvailableFonts()).toEqual([]);
  });

  it('`-apple-system` 是系统兜底项，不作为可选项出现在列表里', () => {
    stubCanvas({ '-apple-system': 999 }, BASE_MONO, BASE_SANS);
    expect(detectAvailableFonts()).not.toContain('-apple-system');
  });

  it('宽度差不足 0.5px 的「伪命中」被判为不可用（抗亚像素噪声）', () => {
    // 该字体与**两条基准**都只差 0.2px：属测量噪声，不能算命中
    stubCanvas({ Optima: BASE_MONO + 0.2 }, BASE_MONO, BASE_SANS + 0.2);
    expect(detectAvailableFonts()).not.toContain('Optima');
  });

  it('与某条基准恰好等宽的字体被判为不可用（宽度无差异= 未被采用）', () => {
    // 字体「安装」但宽度与基准完全一致（如度量巧合）⇒ 无法证明被采用 ⇒ 不列。
    // 这条守的是探测的保守性：宁可少列也不要把无效项塞给用户。
    stubCanvas({ Optima: BASE_MONO }, BASE_MONO, BASE_SANS);
    expect(detectAvailableFonts()).not.toContain('Optima');
  });

  it('环境无 canvas（createElement 返回 null）时返回空数组而非抛错', () => {
    vi.stubGlobal('document', {
      documentElement: { style: { setProperty: setPropertySpy } },
      createElement: () => null,
    });
    expect(detectAvailableFonts()).toEqual([]);
  });
});

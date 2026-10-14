// #444：字体族 / 字号偏好——与 theme.ts 同款范式（模块单例 + localStorage +
// 模块加载时立即应用，避免 FOUC）。纯前端、零新依赖。
//
// ## 为什么需要「探测」而不是直接列系统字体
//
// Web 平台**不允许枚举已安装字体**（浏览器安全沙箱限制，`queryLocalFonts()`
// 至今未普及）。字体只能按名字交给 CSS 解析 ⇒ 想知道「本机到底有没有
// 某款字体」，只能用 `document.fonts.check()` 或尺寸测量差异去**试探**。
// 故此处内置一份候选清单（覆盖中英常用），启动时探测出实际可用的子集，
// 只把可用的放进下拉框——避免用户选了一个本机没有的字体却毫无提示。

/** 字号预设档位（px）。基准 13px = v0.7.1 及之前的正文大小。 */
export const FONT_SIZE_PRESETS = [12, 13, 14, 16, 18] as const;
export type FontSizePreset = (typeof FONT_SIZE_PRESETS)[number];

export const DEFAULT_FONT_SIZE: FontSizePreset = 13;

/** 候选界面字体（按「中文优先、再西文」排列，探测后取实际可用子集）。 */
const UI_FONT_CANDIDATES = [
  // 系统默认（恒存在，作为基准项）
  '-apple-system',
  // macOS 中文
  'PingFang SC',
  'Hiragino Sans GB',
  'STHeiti',
  'Songti SC',
  'Kaiti SC',
  // macOS 西文
  'Helvetica Neue',
  'SF Pro Text',
  'Avenir Next',
  'Optima',
  // Windows
  'Microsoft YaHei',
  'SimSun',
  'SimHei',
  'Segoe UI',
  'Consolas',
  // Linux
  'Noto Sans CJK SC',
  'Source Han Sans SC',
  'WenQuanYi Micro Hei',
  'Ubuntu',
  'DejaVu Sans',
  'Liberation Sans',
];

/** 空串 = 跟随系统默认（不指定 font-family，走浏览器默认栈）。 */
export const DEFAULT_FONT_FAMILY = '';
/** 空串 = 跟随界面字体（等宽文本不单独指定）。 */
export const DEFAULT_MONO_FAMILY = '';

const SIZE_KEY = 'taskboard.fontSize';
const FAMILY_KEY = 'taskboard.fontFamily';
const MONO_KEY = 'taskboard.monoFamily';

function read(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    // localStorage不可用（隐私模式 / 非浏览器环境）
    return fallback;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // 忽略：写不进去时本次会话内仍能生效（内存态）
  }
}

/** 读取字号；非法值（手改 localStorage / 旧版本残留）一律回落到默认档。 */
export function getFontSize(): FontSizePreset {
  const raw = Number(read(SIZE_KEY, String(DEFAULT_FONT_SIZE)));
  return (FONT_SIZE_PRESETS as readonly number[]).includes(raw)
    ? (raw as FontSizePreset)
    : DEFAULT_FONT_SIZE;
}

export function getFontFamily(): string {
  return read(FAMILY_KEY, DEFAULT_FONT_FAMILY);
}

export function getMonoFamily(): string {
  return read(MONO_KEY, DEFAULT_MONO_FAMILY);
}

/**
 * ⚠️ 注入面：`style.setProperty` 的值必须是**受控的字面量**，不能是任意用户输入。
 * 这里对字体名做白名单校验——只接受探测确认过存在于候选清单里的名字，
 * 杜绝 `"; background: url(...)"` 这类 CSS 注入（localStorage 可被同源脚本改写）。
 */
function safeFamily(raw: string, allowList: readonly string[]): string {
  const v = raw.trim();
  if (v === '') return '';
  return allowList.includes(v) ? v : '';
}

/**
 * 把当前偏好应用到 `<html>` 的 CSS 变量上。
 *
 * - `--font-ui`：界面字体栈（选中字体在最前，后接系统兜底栈）。
 * - `--font-mono`：等宽字体栈。**默认跟随界面字体**（用户选择「等宽=跟随」时，
 *   直接复用 `--font-ui`），否则用所选等宽字体 + 系统等宽兜底。
 *
 * ⚠️ 这修掉一个现存缺陷：`--font-mono` 在 `styles.css:2282` 被引用（会话卡片
 * meta 值）却**从未定义**，此前完全靠 `font-family` 声明缺失时的 fallback 侥幸
 * 渲染成默认字体；本次起该变量有了权威定义。
 */
export function applyFontPrefs(size?: FontSizePreset, family?: string, mono?: string): void {
  const px = size ?? getFontSize();
  const ui = safeFamily(family ?? getFontFamily(), UI_FONT_CANDIDATES);
  const monoName = safeFamily(mono ?? getMonoFamily(), UI_FONT_CANDIDATES);

  // 字号：以 13px 为基准折算rem 根值，令全站 `rem`/`em` 相对字号同步缩放。
  // （现存83 处硬编码 px 不受影响，属有意保留——见知识库文档「为何不改 px」。）
  const rootPx = px;
  try {
    const el = document.documentElement;
    el.style.setProperty('--font-size-base', `${rootPx}px`);
    el.style.setProperty('--font-ui', buildStack(ui, false));
    el.style.setProperty('--font-mono', buildStack(monoName, true, ui));
  } catch {
    // document 不可用
  }
}

/** 构造 font-family 栈：选中字体在最前，后接跨平台兜底。 */
function buildStack(name: string, mono: boolean, uiFallback = ''): string {
  const tail = mono
    ? ['SF Mono', 'Menlo', 'Consolas', 'DejaVu Sans Mono', 'monospace']
    : [
        '-apple-system',
        'BlinkMacSystemFont',
        'PingFang SC',
        'Microsoft YaHei',
        'Helvetica Neue',
        'Segoe UI',
        'sans-serif',
      ];
  const head: string[] = [];
  if (name) head.push(quoteFamily(name));
  // 等宽「跟随界面」：把界面字体也纳入等宽栈（用户选了衬线字体做等宽是可接受的）
  if (mono && !name && uiFallback) head.push(quoteFamily(uiFallback));
  return [...head, ...tail].join(', ');
}

/** 字体名加引号：含空格的族名（"PingFang SC"）不加引号在部分引擎解析异常。 */
function quoteFamily(name: string): string {
  return /^[-a-zA-Z][-a-zA-Z0-9]*$/.test(name) ? name : `"${name.replace(/"/g, '')}"`;
}

export const fontPrefs = {
  getFontSize,
  getFontFamily,
  getMonoFamily,
  /** 应用三件偏好（参数省略时读当前持久化值）。 */
  apply: applyFontPrefs,
  setFontSize(px: FontSizePreset) {
    write(SIZE_KEY, String(px));
    applyFontPrefs();
  },
  setFontFamily(name: string) {
    write(FAMILY_KEY, safeFamily(name, UI_FONT_CANDIDATES));
    applyFontPrefs();
  },
  setMonoFamily(name: string) {
    write(MONO_KEY, safeFamily(name, UI_FONT_CANDIDATES));
    applyFontPrefs();
  },
};

/**
 * 探测候选字体中**本机真实存在**的子集。
 *
 * 原理：把候选名塞进 `font-family` 末尾（**不作为首选**），若该字体不存在，
 * 浏览器会回退到默认字体 ⇒ 渲染宽度不变；存在则宽度变化。
 * 用 `canvas.measureText` 比对「候选名 vs纯默认名」的宽度差异来判定。
 *
 * ⚠️ 必须用 canvas 测量而非 `document.fonts.check()`：后者对**系统字体**
 * （非 @font-face 加载的 web font）恒返回 true —— 它只反映「字体是否已加载」，
 * 而系统字体从不经过加载流程 ⇒ 会把所有候选都判为「可用」，探测形同虚设。
 *
 * @returns 可用字体名（不含 `-apple-system` 这类系统兜底项）。
 *   环境不支持 canvas 时返回空数组（设置面板据此只显示「跟随系统」）。
 */
export function detectAvailableFonts(): string[] {
  const canvas = createProbeCanvas();
  if (!canvas) return [];
  const ctx = canvas.getContext('2d');
  if (!ctx) return [];
  // 基准：两种通用族分别测，取基线值。用 monospace 做基准可排除多数衬线差异。
  const SAMPLE = 'mmmmmmmmmmlliWWWW中文测试';
  const SIZE = '72px';
  ctx.font = `${SIZE} monospace`;
  const baseMono = ctx.measureText(SAMPLE).width;
  ctx.font = `${SIZE} sans-serif`;
  const baseSans = ctx.measureText(SAMPLE).width;

  return UI_FONT_CANDIDATES.filter((name) => {
    if (name === '-apple-system') return false; // 系统兜底，不是可选项
    // 用引号包裹：族名含空格时（PingFang SC）不加引号解析异常
    ctx.font = `${SIZE} ${quoteFamily(name)}, monospace`;
    const w1 = ctx.measureText(SAMPLE).width;
    ctx.font = `${SIZE} ${quoteFamily(name)}, sans-serif`;
    const w2 = ctx.measureText(SAMPLE).width;
    // 与两条基准都不同 ⇒ 该字体确实被采用了
    return Math.abs(w1 - baseMono) > 0.5 && Math.abs(w2 - baseSans) > 0.5;
  });
}

function createProbeCanvas(): HTMLCanvasElement | null {
  try {
    return typeof document !== 'undefined' ? document.createElement('canvas') : null;
  } catch {
    return null;
  }
}

// 模块加载时立即应用（避免 FOUC，与 theme.ts 同款；主题已用它解决过首屏闪白）。
try {
  applyFontPrefs();
} catch {
  // 非浏览器环境（测试 / node）：忽略
}

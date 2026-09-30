// #308: 主题检测与持久化
// 独立文件，无 React 渲染副作用，可被测试环境安全导入。

export type ThemeMode = 'auto' | 'light' | 'dark';

const THEME_KEY = 'taskboard.theme';
const DARK_QUERY = '(prefers-color-scheme: dark)';

/**
 * #329：系统主题监听句柄。原先 `setMode('auto')` 每次都新增一个监听器且从不移除 ——
 * 既造成监听器泄漏，又会在用户显式选定 light/dark 后仍被系统切换回调
 * `applyTheme('auto')` 覆盖（表现为「选了浅色，系统一换主题 App 跟着变」）。
 * 现在统一用同一个函数引用注册/注销，切出 auto 时**主动解绑**。
 */
let systemThemeListener: (() => void) | null = null;

function onSystemThemeChange() {
  applyTheme('auto');
}

/** 绑定系统主题监听（幂等：先解绑再绑定，避免重复注册）。 */
function bindSystemThemeListener() {
  unbindSystemThemeListener();
  try {
    window.matchMedia(DARK_QUERY).addEventListener('change', onSystemThemeChange);
    systemThemeListener = onSystemThemeChange;
  } catch {
    // matchMedia 不可用
  }
}

/** 解绑系统主题监听（只影响 auto 模式；显式 light/dark 不需要它）。 */
function unbindSystemThemeListener() {
  if (!systemThemeListener) return;
  try {
    window.matchMedia(DARK_QUERY).removeEventListener('change', systemThemeListener);
  } catch {
    // matchMedia 不可用
  }
  systemThemeListener = null;
}

/** 仅供测试：当前是否已绑定系统主题监听（防止重复注册导致泄漏）。 */
export function systemThemeListenerBound(): boolean {
  return systemThemeListener !== null;
}

export function resolveTheme(mode: ThemeMode): 'light' | 'dark' {
  if (mode === 'light' || mode === 'dark') return mode;
  // auto: 跟随系统
  try {
    return window.matchMedia(DARK_QUERY).matches ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

export function applyTheme(mode: ThemeMode) {
  try {
    const theme = resolveTheme(mode);
    document.documentElement.setAttribute('data-theme', theme);
  } catch {
    // document 不可用（如 SSR 环境）
  }
}

export const themeManager = {
  getMode: (): ThemeMode => {
    try {
      return (localStorage.getItem(THEME_KEY) as ThemeMode) || 'auto';
    } catch {
      return 'auto';
    }
  },
  setMode: (mode: ThemeMode) => {
    try {
      localStorage.setItem(THEME_KEY, mode);
    } catch {
      // localStorage 不可用
    }
    applyTheme(mode);
    // #329：只在 auto 下监听系统主题；切到显式 light/dark 时解绑，
    // 否则系统主题一变化就会把用户的显式选择覆盖掉。
    if (mode === 'auto') {
      bindSystemThemeListener();
    } else {
      unbindSystemThemeListener();
    }
  },
};

// 模块加载时立即应用主题（避免 FOUC）
let storedTheme: ThemeMode = 'auto';
try {
  storedTheme = (localStorage.getItem(THEME_KEY) as ThemeMode) || 'auto';
} catch {
  // localStorage 不可用
}
applyTheme(storedTheme);

// auto 模式监听系统主题变化（#329：统一走 bind/unbind，避免重复注册）
if (storedTheme === 'auto') {
  bindSystemThemeListener();
}

// #308: 主题检测与持久化
// 独立文件，无 React 渲染副作用，可被测试环境安全导入。

export type ThemeMode = 'auto' | 'light' | 'dark';

const THEME_KEY = 'taskboard.theme';

export function resolveTheme(mode: ThemeMode): 'light' | 'dark' {
  if (mode === 'light' || mode === 'dark') return mode;
  // auto: 跟随系统
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
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
    // 重新绑定系统主题监听（auto 模式下）
    if (mode === 'auto') {
      try {
        window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
          applyTheme('auto');
        });
      } catch {
        // matchMedia 不可用
      }
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

// auto 模式监听系统主题变化
if (storedTheme === 'auto') {
  try {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      applyTheme('auto');
    });
  } catch {
    // matchMedia 不可用
  }
}

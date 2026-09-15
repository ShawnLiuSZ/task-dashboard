import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import zhCN from './locales/zh-CN.json';
import enUS from './locales/en-US.json';

/**
 * 轻量 i18n（Issue #7）：
 * - 两份 JSON locale（zh-CN / en-US），key 缺失时回落中文并在控制台告警。
 * - 语言模式 auto（跟随系统）/ zh-CN / en-US，持久化在 localStorage。
 * - t(key, params) 支持 {name} 占位符。
 */

export type Lang = 'zh-CN' | 'en-US';
export type LangMode = 'auto' | Lang;

const STORAGE_KEY = 'taskboard.lang';

const DICTS: Record<Lang, Record<string, string>> = {
  'zh-CN': zhCN as Record<string, string>,
  'en-US': enUS as Record<string, string>,
};

function readMode(): LangMode {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === 'auto' || v === 'zh-CN' || v === 'en-US') return v;
  } catch {
    /* localStorage 不可用时回落 auto */
  }
  return 'auto';
}

/** auto 模式下按系统语言解析（zh 开头 → 中文，否则英文）。 */
export function resolveLang(mode: LangMode): Lang {
  if (mode !== 'auto') return mode;
  try {
    return navigator.language?.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US';
  } catch {
    return 'zh-CN';
  }
}

interface I18nValue {
  /** 用户选择的语言模式（auto / zh-CN / en-US）。 */
  mode: LangMode;
  /** 实际生效语言（auto 已解析）。 */
  lang: Lang;
  /** 切换语言模式并持久化。 */
  setMode: (m: LangMode) => void;
  /** 翻译：t("btn.save")、t("sync.result", { added: 1, updated: 2, done: 3 })。 */
  t: (key: string, params?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18nValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<LangMode>(readMode);
  const lang = resolveLang(mode);

  const setMode = useCallback((m: LangMode) => {
    setModeState(m);
    try {
      localStorage.setItem(STORAGE_KEY, m);
    } catch {
      /* 忽略持久化失败 */
    }
  }, []);

  const t = useCallback(
    (key: string, params?: Record<string, string | number>): string => {
      let s = DICTS[lang][key] ?? DICTS['zh-CN'][key];
      if (s === undefined) {
        console.warn(`[i18n] missing key: ${key} (${lang})`);
        return key;
      }
      if (params) {
        for (const [k, v] of Object.entries(params)) {
          s = s.split(`{${k}}`).join(String(v));
        }
      }
      return s;
    },
    [lang],
  );

  const value = useMemo(() => ({ mode, lang, setMode, t }), [mode, lang, setMode, t]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const v = useContext(I18nContext);
  if (!v) throw new Error('useI18n 必须在 <I18nProvider> 内使用');
  return v;
}

/** 便捷取 t（不需要 mode/setMode 的组件用这个，减少样板）。 */
export function useT(): I18nValue['t'] {
  return useI18n().t;
}

/** 本地化时间格式：ts 为秒级时间戳或 ISO 字符串；0/空 显示「从未 / Never」。 */
export function fmtTime(ts: number | string | null, lang: Lang): string {
  if (!ts) return lang === 'en-US' ? 'Never' : '从未';
  const d = typeof ts === 'number' ? new Date(ts * 1000) : new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

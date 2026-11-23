// 毛玻璃效果偏好——与 theme.ts / fontPrefs.ts 同款范式
// （模块单例 + localStorage + 模块加载时立即应用，避免 FOUC）。纯前端、零新依赖。
//
// #606：从布尔开关升级为 3 档透明度（照搬 macOS 27「设置-外观」的 Liquid Glass
// 透明度滑块：通透 / 均衡 / 清晰）。开启时在 <html> 上写 data-glass-level="1|2|3"，
// styles.css 按档位提供一套 --glass-* 令牌与 backdrop-filter 参数；关闭移除属性。
//
// ## 档位（数值越小越通透）
// - 1 通透：alpha 0.56 / blur 28px / saturate 1.75 —— 彩色最明显
// - 2 均衡：alpha 0.64 / blur 24px / saturate 1.60 —— 通透与可读平衡（默认档）
// - 3 清晰：alpha 0.74 / blur 20px / saturate 1.40 —— 偏不透明，文字最清晰
//
// ## 向后兼容（#600 / #603 旧值迁移）
// 旧 key `taskboard.glassEffect` 存 'on'（布尔开启）。本次读取时若发现 'on'
// 且无新 key，视为档 2（均衡），并在下次 setLevel 时写入新 key、清除旧 key。
// 这样升级后老用户不会丢失开启状态，也不会被突然切到最通透档影响可读。

/** 支持的档位白名单——所有外部输入必须过此校验（对比 fontPrefs 的白名单防御）。 */
export const GLASS_LEVELS = [1, 2, 3] as const;
export type GlassLevel = (typeof GLASS_LEVELS)[number];

/** 默认档位：均衡（兼顾通透与可读）。 */
export const DEFAULT_GLASS_LEVEL: GlassLevel = 2;

const LEVEL_KEY = 'taskboard.glassLevel';
const LEGACY_KEY = 'taskboard.glassEffect';

/** 白名单校验：只有 1 / 2 / 3 三个数字档位有效，其余（脏值 / 越界）回落 null。 */
function normalize(value: unknown): GlassLevel | null {
  if (value === 1 || value === 2 || value === 3) return value;
  if (typeof value === 'string' && /^[123]$/.test(value)) return Number(value) as GlassLevel;
  return null;
}

/**
 * 读取档位：新 key 优先；缺失时迁移旧 `on` → 档 2；两者皆无 → null（关闭）。
 * 返回 null 表示「关闭」，与档位值正交（关闭不占档位）。
 */
function read(): GlassLevel | null {
  try {
    const raw = localStorage.getItem(LEVEL_KEY);
    const level = normalize(raw);
    if (level !== null) return level;
    // 新 key 存在但脏值：不迁移旧值（用户显式改过），视为关闭。
    if (raw !== null) return null;
    // 新 key 缺失：迁移旧布尔开关。
    return localStorage.getItem(LEGACY_KEY) === 'on' ? DEFAULT_GLASS_LEVEL : null;
  } catch {
    return null;
  }
}

function write(level: GlassLevel | null): void {
  try {
    if (level === null) {
      localStorage.removeItem(LEVEL_KEY);
      localStorage.removeItem(LEGACY_KEY);
    } else {
      localStorage.setItem(LEVEL_KEY, String(level));
      localStorage.removeItem(LEGACY_KEY);
    }
  } catch {
    // localStorage 不可用（隐私模式 / 非浏览器环境）：本次会话内内存态仍生效
  }
}

/**
 * 应用档位：<html data-glass-level="N"> 或移除属性。
 * 只写白名单校验后的数字档位，**不注入任意用户输入**
 * ——无自由值面，不构成 CSS 注入面（同 fontPrefs 白名单是同类防御）。
 */
export function applyGlass(level: GlassLevel | null): void {
  try {
    const el = document.documentElement;
    if (level === null) {
      el.removeAttribute('data-glass-level');
    } else {
      el.setAttribute('data-glass-level', String(level));
    }
  } catch {
    // document 不可用（测试 / node / SSR 环境）
  }
}

export const glassPrefs = {
  getLevel: read,
  /** 是否开启（兼容旧调用语义：有档位即开启）。 */
  getEnabled(): boolean {
    return read() !== null;
  },
  setLevel(level: GlassLevel | null): void {
    const safe = level === null ? null : normalize(level);
    write(safe);
    applyGlass(safe);
  },
  /** 兼容旧接口：on → 默认档（2），off → 关闭。 */
  setEnabled(enabled: boolean): void {
    glassPrefs.setLevel(enabled ? DEFAULT_GLASS_LEVEL : null);
  },
};

// 模块加载时立即应用（避免首屏闪变；与 theme.ts / fontPrefs.ts 同款）
try {
  applyGlass(read());
} catch {
  // 非浏览器环境：忽略
}

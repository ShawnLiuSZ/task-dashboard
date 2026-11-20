// 毛玻璃效果偏好——与 theme.ts / fontPrefs.ts 同款范式
// （模块单例 + localStorage + 模块加载时立即应用，避免 FOUC）。纯前端、零新依赖。
//
// 开启时在 `<html>` 上写 `data-glass="on"`，styles.css 用
// `html[data-glass='on'] .modal { backdrop-filter: ... }` 门禁启用；
// 关闭时移除该属性，回到实心表面。默认**关闭**（避免改变既有视觉）。

const GLASS_KEY = 'taskboard.glassEffect';

/** 读取偏好：只有显式存了 `on` 才算开启，其余（含缺失 / 脏值）一律关闭。 */
function read(): boolean {
  try {
    return localStorage.getItem(GLASS_KEY) === 'on';
  } catch {
    return false;
  }
}

function write(enabled: boolean): void {
  try {
    if (enabled) {
      localStorage.setItem(GLASS_KEY, 'on');
    } else {
      localStorage.removeItem(GLASS_KEY);
    }
  } catch {
    // localStorage 不可用（隐私模式 / 非浏览器环境）：本次会话内内存态仍生效
  }
}

/**
 * 应用毛玻璃状态：开启 → `<html data-glass="on">`，关闭 → 移除该属性。
 * 只写一个布尔属性，**不注入任何用户输入**——该偏好没有任意值面，
 * 不构成 CSS 注入面（对比 fontPrefs 的白名单校验是同类防御）。
 */
export function applyGlass(enabled: boolean): void {
  try {
    const el = document.documentElement;
    if (enabled) {
      el.setAttribute('data-glass', 'on');
    } else {
      el.removeAttribute('data-glass');
    }
  } catch {
    // document 不可用（测试 / node / SSR 环境）
  }
}

export const glassPrefs = {
  getEnabled: read,
  setEnabled(enabled: boolean) {
    write(enabled);
    applyGlass(enabled);
  },
};

// 模块加载时立即应用（避免首屏闪变；与 theme.ts / fontPrefs.ts 同款）
try {
  applyGlass(read());
} catch {
  // 非浏览器环境：忽略
}

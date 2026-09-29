import { describe, expect, it, afterEach, vi } from 'vitest';
// 真实导入纯函数做单元断言；组件/路由用 `?raw` 源码静态断言（与 notes-layout.test.ts 同思路）。
import { getWebviewVersion } from '../utils/webviewVersion';
import aboutRaw from './AboutWindow.tsx?raw';
import mainRaw from '../main.tsx?raw';
import stylesRaw from '../styles.css?raw';

const styles = stylesRaw.replace(/\/\*[\s\S]*?\*\//g, '');

describe('About 小窗 WebView 版本推导（#325）', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  function setUA(ua: string) {
    vi.stubGlobal('navigator', { userAgent: ua });
  }
  it('macOS WKWebView：取 AppleWebKit 版本', () => {
    setUA(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
    );
    expect(getWebviewVersion()).toBe('WebKit 605.1.15');
  });
  it('Windows WebView2：取 Edg 版本', () => {
    setUA(
      'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.2210.0',
    );
    expect(getWebviewVersion()).toBe('WebView2 120.0.2210.0');
  });
  it('Linux WebKitGTK：取 WebKitGTK 版本', () => {
    setUA(
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/4.0 Safari/605.1.15 WebKitGTK/2.44.0',
    );
    expect(getWebviewVersion()).toBe('WebKitGTK 2.44.0');
  });
  it('未知引擎：回退空串（展示占位 …）', () => {
    setUA('Mozilla/5.0');
    expect(getWebviewVersion()).toBe('');
  });
});

describe('About 小窗结构与路由（#325）', () => {
  it('main.tsx：about 窗口只渲染 AboutWindow，不挂载 App', () => {
    // 通过窗口 label 区分；非 about 才渲染 App（避免连 DB / 跑同步）。
    expect(mainRaw).toContain('getCurrentWindow().label');
    expect(mainRaw).toContain("currentWindowLabel() === 'about'");
    expect(mainRaw).toContain('isAboutWindow ? <AboutWindow /> : <App />');
  });

  it('AboutWindow：三行信息 + 确定按钮均使用 i18n key', () => {
    expect(aboutRaw).toContain("t('aboutWindow.version')");
    expect(aboutRaw).toContain("t('aboutWindow.tauri')");
    expect(aboutRaw).toContain("t('aboutWindow.webview')");
    expect(aboutRaw).toContain("t('aboutWindow.ok')");
    // 确定按钮关闭当前窗口（Tauri API，而非浏览器 window.close）
    expect(aboutRaw).toContain('getCurrentWindow().close()');
  });

  it('AboutWindow：运行时信息来自 get_runtime_info 命令（app + tauri 版本）', () => {
    // Prettier 会把 `api.getRuntimeInfo()` 链式调用折行，故用正则而非连续子串断言。
    expect(aboutRaw).toContain('api');
    expect(aboutRaw).toMatch(/\.getRuntimeInfo\(\)/);
  });

  it('styles.css：about-window 容器 + 全宽确定按钮 + 三行布局', () => {
    expect(styles).toMatch(/\.about-window\s*\{[\s\S]*?flex-direction\s*:\s*column/);
    expect(styles).toMatch(/\.about-window-ok\s*\{[\s\S]*?width\s*:\s*100%/);
    expect(styles).toContain('.about-window-row');
    // 复用主色按钮样式（.btn.primary）而非裸 button
    expect(aboutRaw).toContain('className="btn primary about-window-ok"');
  });
});

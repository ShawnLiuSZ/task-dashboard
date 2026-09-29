import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import AboutWindow from './components/AboutWindow';
import { I18nProvider } from './i18n';
import { getCurrentWindow } from '@tauri-apps/api/window';
import './styles.css';
import './theme';

// #325：菜单栏「About TaskBoard」打开的独立小窗（label = "about"）只渲染 About 视图，
// 不挂载完整 App（避免连 DB / 跑同步）。主窗口（label = "main"）照常渲染 App。
// 非 Tauri 环境（测试 / 普通浏览器）取不到窗口，回落到 main，保证不崩。
function currentWindowLabel(): string {
  try {
    return getCurrentWindow().label;
  } catch {
    return 'main';
  }
}

const isAboutWindow = currentWindowLabel() === 'about';

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <I18nProvider>{isAboutWindow ? <AboutWindow /> : <App />}</I18nProvider>
  </React.StrictMode>,
);

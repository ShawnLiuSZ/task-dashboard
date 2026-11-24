import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import AboutWindow from './components/AboutWindow';
import TaskDetailWindow from './components/TaskDetailWindow';
import { I18nProvider } from './i18n';
import { getCurrentWindow } from '@tauri-apps/api/window';
import './styles.css';
import './theme';
// #603：毛玻璃偏好模块加载即应用（防 FOUC，与 theme 同款）。此前仅靠
// SettingsPanel 间接 import 才生效，独立窗（about / task-detail）不挂设置面板
// ⇒ 首屏不会应用已持久化的玻璃门禁。入口显式 import 兑现模块副作用。
import './glassPrefs';
// #609：指针跟随高光——事件委托挂在 document 上，需 DOM 就绪后初始化。
import { initGlassPointer } from './glassPointer';
initGlassPointer();

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

const windowLabel = currentWindowLabel();
const isAboutWindow = windowLabel === 'about';
// #526：任务详情独立窗（label = "task-detail-{accountId}-{issueKey}"）。
// ⚠️ 用**前缀**匹配而不是全等 —— label 随任务动态变化（同一任务重复打开会聚焦旧窗）。
const isTaskDetailWindow = windowLabel.startsWith('task-detail');

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <I18nProvider>
      {isAboutWindow ? <AboutWindow /> : isTaskDetailWindow ? <TaskDetailWindow /> : <App />}
    </I18nProvider>
  </React.StrictMode>,
);

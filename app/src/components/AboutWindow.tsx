import { useEffect, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { api } from '../api';
import { useI18n } from '../i18n';
import { getWebviewVersion } from '../utils/webviewVersion';

interface RuntimeInfo {
  appVersion: string;
  tauriVersion: string;
}

/** #325：菜单栏 About TaskBoard 打开的自定义独立小窗。 */
export default function AboutWindow() {
  const { t } = useI18n();
  const [info, setInfo] = useState<RuntimeInfo | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .getRuntimeInfo()
      .then((r) => {
        if (!cancelled) setInfo(r);
      })
      .catch(() => {
        if (!cancelled) setInfo({ appVersion: '?', tauriVersion: '?' });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const webview = getWebviewVersion();

  return (
    <div className="about-window">
      <div className="about-window-icon" aria-hidden>
        <span className="about-window-logo">T</span>
      </div>
      <div className="about-window-name">TaskBoard</div>
      <div className="about-window-rows">
        <div className="about-window-row">
          <span className="about-window-key">{t('aboutWindow.version')}</span>
          <span className="about-window-val">v{info?.appVersion ?? '…'}</span>
        </div>
        <div className="about-window-row">
          <span className="about-window-key">{t('aboutWindow.tauri')}</span>
          <span className="about-window-val">{info?.tauriVersion ?? '…'}</span>
        </div>
        <div className="about-window-row">
          <span className="about-window-key">{t('aboutWindow.webview')}</span>
          <span className="about-window-val">{webview || '…'}</span>
        </div>
      </div>
      <button
        className="btn primary about-window-ok"
        onClick={() => void getCurrentWindow().close()}
      >
        {t('aboutWindow.ok')}
      </button>
    </div>
  );
}

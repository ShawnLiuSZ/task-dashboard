import { useCallback, useEffect, useState } from 'react';
import { api, onUpdateProgress, openExternal } from '../api';
import { useI18n } from '../i18n';
import {
  UPDATER_TIMEOUT_MS,
  UPDATE_CHECK_TIMEOUT_MS,
  settleWithTimeout,
  viewFallback,
  viewUpdater,
} from '../utils/updateCheck';

interface Props {
  onClose: () => void;
}

/**
 * idle = 尚未检查（按钮可点）；loading = 正在检查（防重复点击）。
 * #231 扩展 available / installing / installed 三个阶段，用于承载应用内更新流程。
 */
type State =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | { phase: 'upToDate'; current: string }
  | {
      phase: 'available';
      version: string;
      current: string;
      notes: string;
      /** 非空表示应用内更新不可用，退化为前往 Releases 手动下载。 */
      manualUrl?: string;
      /** #256：手动下载时附带 updater 通道失败原因（不再静默吞掉）。 */
      updaterNote?: string;
    }
  | { phase: 'installing'; percent: number | null }
  | { phase: 'installed'; version: string }
  | { phase: 'error'; message: string };

/** 按当前安装平台返回 taskboard 二进制的默认路径（与 README 一致）。 */
export function getMcpCommand(): string {
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes('mac')) {
    return '/Applications/TaskBoard.app/Contents/MacOS/taskboard';
  }
  if (ua.includes('win')) {
    return 'C:\\Program Files\\TaskBoard\\taskboard.exe';
  }
  // Linux / 其他
  return '/usr/bin/taskboard';
}

/** MCP 接入配置片段（与 README 一致，代码块非翻译）。 */
export function buildMcpSnippet(): string {
  const cmd = getMcpCommand();
  return `{
  "mcpServers": {
    "taskboard": {
      "type": "stdio",
      "command": ${JSON.stringify(cmd)},
      "args": ["mcp"]
    }
  }
}`;
}

/** v0.3.19+「关于」弹窗：展示当前版本号 + 检查更新入口。 */
export default function AboutPanel({ onClose }: Props) {
  const { t } = useI18n();
  const [version, setVersion] = useState<string>('');
  const [state, setState] = useState<State>({ phase: 'idle' });

  const loadVersion = useCallback(async () => {
    try {
      setVersion(await api.getAppVersion());
    } catch {
      setVersion('?');
    }
  }, []);

  /**
   * #231：优先走应用内更新通道（tauri-plugin-updater）。
   * #256：双通道同时发起、分阶段展示——fallback 先到先展示（有新版立刻显示手动
   * 下载，不用干等慢的 updater 通道），updater 后到做升级（有可用更新则把手动
   * 下载替换为一键更新）或备注（失败原因，不再静默吞掉）。
   *
   * 该通道不可用时（尚未配置签名公钥、或 Releases 上还没有 latest.json、或超时）
   * 回退为纯版本号对比 + 跳转 Releases 手动下载，避免「检查更新」整体失效。
   */
  const check = useCallback(async () => {
    setState({ phase: 'loading' });
    try {
      // 双通道同时发起：fallback 无需等 updater，updater 结论后到按需升级界面。
      // 检查中按钮被禁用，不会有第二次 check 穿插导致旧 Promise 覆盖新状态。
      const updaterPromise = settleWithTimeout(api.checkAppUpdate(), UPDATER_TIMEOUT_MS);
      const fb = viewFallback(
        await settleWithTimeout(api.checkLatestRelease(), UPDATE_CHECK_TIMEOUT_MS),
      );
      if (fb.kind === 'upToDate') {
        setState({ phase: 'upToDate', current: fb.current });
        return;
      }
      if (fb.kind === 'manual') {
        setState({
          phase: 'available',
          version: fb.version,
          current: fb.current,
          notes: '',
          manualUrl: fb.url,
        });
      }
      // fallback 失败则保持 loading，继续等 updater；已有手动下载则等 updater 做升级。
      const uv = viewUpdater(await updaterPromise);
      if (uv.kind === 'one-click') {
        setState({
          phase: 'available',
          version: uv.version,
          current: uv.current,
          notes: uv.notes,
        });
        return;
      }
      const note =
        uv.kind === 'issue'
          ? uv.issue.kind === 'timeout'
            ? t('about.updaterTimeout')
            : t('about.updaterUnavailable', { reason: uv.issue.message })
          : null;
      if (fb.kind === 'manual') {
        // 仍停留在手动下载才追加备注（函数式更新守卫，避免覆盖用户后续操作）。
        if (note) {
          setState((prev) =>
            prev.phase === 'available' && prev.manualUrl ? { ...prev, updaterNote: note } : prev,
          );
        }
        return;
      }
      // fallback 失败 + updater 也无可用更新：报错（fallback 具体错误优先）。
      const fbMessage = fb.kind === 'failed' && !fb.timedOut ? fb.error : '';
      let message = fbMessage;
      if (!message && uv.kind === 'issue' && uv.issue.kind === 'backend-error') {
        message = uv.issue.message;
      }
      setState({
        phase: 'error',
        message: message ? t('about.error', { error: message }) : t('about.checkTimeout'),
      });
    } catch (e) {
      setState({ phase: 'error', message: String(e) });
    }
  }, [t]);

  /** #231：下载并安装更新，完成后引导用户重启生效。 */
  const install = useCallback(async (target: string) => {
    setState({ phase: 'installing', percent: null });
    try {
      await api.installAppUpdate();
      setState({ phase: 'installed', version: target });
    } catch (e) {
      setState({ phase: 'error', message: String(e) });
    }
  }, []);

  // 打开弹窗时先拉一次当前版本（不自动联网检查）。
  useEffect(() => {
    void loadVersion();
  }, [loadVersion]);

  // #231：订阅下载进度，仅在 installing 阶段刷新百分比。
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void onUpdateProgress((p) => {
      const percent =
        p.total && p.total > 0 ? Math.min(100, Math.floor((p.downloaded / p.total) * 100)) : null;
      setState((prev) => (prev.phase === 'installing' ? { phase: 'installing', percent } : prev));
    }).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, []);

  const busy = state.phase === 'loading' || state.phase === 'installing';

  return (
    <div className="modal-mask" onClick={onClose}>
      <div
        className="modal about-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={t('about.title')}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose();
        }}
      >
        <h3 className="modal-title">{t('about.title')}</h3>

        <div className="about-body">
          <div className="field readonly">
            <label>{t('about.versionLabel')}</label>
            <div className="muted small">v{version}</div>
          </div>

          <p className="muted small about-intro">{t('about.intro')}</p>

          <section className="about-section">
            <h4>{t('about.capsTitle')}</h4>
            <ul className="about-caps">
              <li>{t('about.cap.kanban')}</li>
              <li>{t('about.cap.sync')}</li>
              <li>{t('about.cap.session')}</li>
              <li>{t('about.cap.i18n')}</li>
            </ul>
          </section>

          <section className="about-section">
            <h4>{t('about.dataTitle')}</h4>
            <code className="about-data-path">{t('about.dataPath')}</code>
          </section>

          <section className="about-section">
            <h4>{t('about.mcpTitle')}</h4>
            <p className="muted small">{t('about.mcpDesc')}</p>
            <pre className="about-code">{buildMcpSnippet()}</pre>
            <p className="muted small">{t('about.mcpFallback')}</p>
          </section>

          <div className="about-repo-row" style={{ marginTop: 4 }}>
            <span className="muted small">{t('about.repoPath')}</span>
            <button
              className="about-repo-link"
              title="https://github.com/ShawnLiuSZ/task-dashboard"
              onClick={() => openExternal('https://github.com/ShawnLiuSZ/task-dashboard')}
            >
              ShawnLiuSZ/task-dashboard ↗
            </button>
          </div>

          {state.phase === 'loading' && <div className="about-status">{t('about.checking')}</div>}

          {state.phase === 'upToDate' && (
            <div className="about-status up-to-date">
              {'✅'} {t('about.upToDate', { version: state.current })}
            </div>
          )}

          {state.phase === 'available' && (
            <div className="about-status has-update">
              {'✨'}{' '}
              {t('about.updateAvailable', {
                latest: state.version,
                current: state.current,
              })}
              {state.notes && (
                <p className="muted small" style={{ whiteSpace: 'pre-wrap' }}>
                  {state.notes}
                </p>
              )}
              {state.updaterNote && <p className="muted small">{state.updaterNote}</p>}
              {state.manualUrl ? (
                <button
                  className="btn primary"
                  style={{ marginTop: 6 }}
                  onClick={() => openExternal(state.manualUrl as string)}
                >
                  {t('about.download')} ↗
                </button>
              ) : (
                <button
                  className="btn primary"
                  style={{ marginTop: 6 }}
                  onClick={() => void install(state.version)}
                >
                  {t('about.install')}
                </button>
              )}
            </div>
          )}

          {state.phase === 'installing' && (
            <div className="about-status">
              {state.percent === null
                ? t('about.installing')
                : t('about.progress', { percent: state.percent })}
            </div>
          )}

          {state.phase === 'installed' && (
            <div className="about-status has-update">
              {'✅'} {t('about.installed', { version: state.version })}
              <button
                className="btn primary"
                style={{ marginTop: 6 }}
                onClick={() => void api.restartApp()}
              >
                {t('about.restart')}
              </button>
            </div>
          )}

          {state.phase === 'error' && (
            <div className="about-status error">{t('about.error', { error: state.message })}</div>
          )}
        </div>

        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            {t('btn.close')}
          </button>
          <button className="btn primary" onClick={check} disabled={busy}>
            {state.phase === 'loading' ? t('about.checking') : t('about.checkUpdate')}
          </button>
        </div>
      </div>
    </div>
  );
}

import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { useT } from '../i18n';
import type { Task } from '../types';

function Icon({ d, size = 13 }: { d: string; size?: number }) {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={d} />
    </svg>
  );
}

const ICON = {
  expand: 'M10 6l6 6-6 6',
};

function relTime(
  ts: number,
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  if (!ts) return '-';
  const diff = Math.floor(Date.now() / 1000) - ts;
  if (diff < 60) return t('notes.time.justNow');
  if (diff < 3600) return t('notes.time.minutesAgo', { n: Math.floor(diff / 60) });
  if (diff < 86400) return t('notes.time.hoursAgo', { n: Math.floor(diff / 3600) });
  if (diff < 7 * 86400) return t('notes.time.daysAgo', { n: Math.floor(diff / 86400) });
  const d = new Date(ts * 1000);
  return t('notes.time.monthDay', { m: d.getMonth() + 1, d: d.getDate() });
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** #287：任务会话总览面板——列出所有活跃 session，快速一览「同时在做哪几个任务、各自在哪个分支」。 */
export default function SessionsPanel() {
  const t = useT();
  const [sessions, setSessions] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const loadSessions = useCallback(async () => {
    setLoading(true);
    try {
      setSessions(await api.listActiveSessions());
      setError(null);
    } catch (e) {
      console.error('加载会话失败:', e);
      setError(errText(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadSessions();
  }, [loadSessions]);

  const handleCopy = useCallback((text: string, key: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(null), 1500);
    });
  }, []);

  const handleOpenTask = useCallback((task: Task) => {
    void api.openInBrowser(task.url);
  }, []);

  return (
    <div className="panel-page">
      <header className="panel-page-head">
        <h2 className="panel-page-title">{t('sessions.title')}</h2>
      </header>
      <div className="panel-content sessions-content">
        {loading ? (
          <div className="notes-placeholder">{t('notes.loading')}</div>
        ) : error ? (
          <div className="note-error" role="alert">
            <span>{error}</span>
          </div>
        ) : sessions.length === 0 ? (
          <div className="notes-placeholder">{t('sessions.empty')}</div>
        ) : (
          <div className="sessions-list">
            {sessions.map((task) => (
              <div key={task.issueKey} className="session-card">
                <div className="session-card-header">
                  <span className="session-card-title">
                    {t('sessions.title_format', {
                      num: task.number,
                      title: task.title,
                    })}
                  </span>
                  <button
                    type="button"
                    className="note-tool"
                    title={t('sessions.openTask')}
                    onClick={() => handleOpenTask(task)}
                  >
                    <Icon d={ICON.expand} />
                  </button>
                </div>
                <div className="session-card-meta">
                  {task.createdAt > 0 && (
                    <div className="session-meta-row">
                      <span className="session-meta-label">{t('sessions.createdAt')}</span>
                      <span className="session-meta-value">
                        {new Date(task.createdAt * 1000).toLocaleString(undefined, {
                          year: 'numeric',
                          month: '2-digit',
                          day: '2-digit',
                          hour: '2-digit',
                          minute: '2-digit',
                          hour12: false,
                        })}
                      </span>
                    </div>
                  )}
                  {task.workBranch && (
                    <div className="session-meta-row">
                      <span className="session-meta-label">{t('sessions.branch')}</span>
                      <code className="session-meta-value">{task.workBranch}</code>
                      <button
                        type="button"
                        className="note-tool"
                        title={t('sessions.copyBranch')}
                        onClick={() => handleCopy(task.workBranch, `branch-${task.issueKey}`)}
                      >
                        {copiedKey === `branch-${task.issueKey}`
                          ? t('sessions.copyDone')
                          : t('btn.copy')}
                      </button>
                    </div>
                  )}
                  {task.workDir && (
                    <div className="session-meta-row">
                      <span className="session-meta-label">{t('sessions.workDir')}</span>
                      <code className="session-meta-value">{task.workDir}</code>
                      <button
                        type="button"
                        className="note-tool"
                        title={t('sessions.copyDir')}
                        onClick={() => handleCopy(task.workDir, `dir-${task.issueKey}`)}
                      >
                        {copiedKey === `dir-${task.issueKey}`
                          ? t('sessions.copyDone')
                          : t('btn.copy')}
                      </button>
                    </div>
                  )}
                  {task.sessionAgent && (
                    <div className="session-meta-row">
                      <span className="session-meta-label">{t('sessions.agent')}</span>
                      <span className="session-meta-value">{task.sessionAgent}</span>
                    </div>
                  )}
                  {task.sessionAt && (
                    <div className="session-meta-row">
                      <span className="session-meta-label">{t('sessions.time')}</span>
                      <span className="session-meta-value">{relTime(task.sessionAt, t)}</span>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

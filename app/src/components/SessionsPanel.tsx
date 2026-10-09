import { useCallback, useEffect, useRef, useState } from 'react';
import { api, openExternal } from '../api';
import ConfirmDialog from './ConfirmDialog';
import { useT } from '../i18n';
import type { Task } from '../types';
import { taskIdentity } from '../utils/taskIdentity';

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
  copy: 'M8 8v10h8V8z M12 4H5a1 1 0 0 0-1 1v12',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  trash: 'M4 7h16 M9 7V5h6v2 M6 7l1 13h10l1-13',
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
  const [clearKey, setClearKey] = useState<string | null>(null);
  // #391：多选删除——选择模式 + 已选 issueKey 集合 + 批量确认框。
  const [selectMode, setSelectMode] = useState(false);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [confirmMulti, setConfirmMulti] = useState(false);
  const [columns, setColumns] = useState(3);
  const listRef = useRef<HTMLDivElement>(null);

  const updateColumns = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    const tracks = getComputedStyle(el)
      .gridTemplateColumns.split(/\s+/)
      .filter((s) => s && s !== 'none');
    if (tracks.length > 0) setColumns(tracks.length);
  }, []);

  useEffect(() => {
    updateColumns();
    window.addEventListener('resize', updateColumns);
    return () => window.removeEventListener('resize', updateColumns);
  }, [updateColumns]);

  useEffect(() => {
    updateColumns();
  }, [sessions, updateColumns]);

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

  // #329：与 DetailPanel 同款——`writeText` 在权限不足 / 非安全上下文会 reject，
  // 原先既产生未处理拒绝又让「已复制」态卡住；定时器也要在卸载时清理，
  // 否则切页后在已卸载组件上 setState。
  const copiedTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
    },
    [],
  );

  const handleCopy = useCallback(async (text: string, key: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
      copiedTimer.current = window.setTimeout(() => {
        setCopiedKey(null);
        copiedTimer.current = null;
      }, 1500);
    } catch (e) {
      console.error('复制失败:', e);
      setCopiedKey(null);
    }
  }, []);

  const handleOpenTask = useCallback((task: Task) => {
    // #370：走 openExternal（内部 `.catch(reportError)`）——`void api.openInBrowser`
    // 只丢弃 Promise、不会吞掉 rejection ⇒ 命令失败时界面毫无反应也不报错。
    // 本文件曾是与 #329 批量替换**唯一**的漏网之处（同 #339 TaskCard、#345 MCP 分帧
    // 的「只改了一半」模式）。
    openExternal(task.url);
  }, []);

  const handleClear = useCallback(
    async (key: string) => {
      try {
        await api.clearSession(key);
        setClearKey(null);
        void loadSessions();
      } catch (e) {
        console.error('清除会话失败:', e);
        setClearKey(null);
      }
    },
    [loadSessions],
  );

  // #391：进入 / 退出选择模式（退出时清空已选，避免残留选中态）。
  const exitSelectMode = useCallback(() => {
    setSelectMode(false);
    setSelectedKeys(new Set());
  }, []);

  // #391：点击卡片切换选中（仅选择模式生效）。
  const toggleSelect = useCallback((key: string) => {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  // #391：全选 / 取消全选。
  const toggleSelectAll = useCallback(() => {
    setSelectedKeys((prev) =>
      prev.size === sessions.length ? new Set() : new Set(sessions.map((s) => s.issueKey)),
    );
  }, [sessions]);

  // #391：批量清除选中会话（确认后调用）。
  const handleClearMulti = useCallback(async () => {
    const keys = [...selectedKeys];
    try {
      await api.clearSessions(keys);
      setConfirmMulti(false);
      exitSelectMode();
      void loadSessions();
    } catch (e) {
      console.error('批量清除会话失败:', e);
      setConfirmMulti(false);
    }
  }, [selectedKeys, exitSelectMode, loadSessions]);

  const allSelected = selectedKeys.size === sessions.length && sessions.length > 0;

  return (
    <div className="panel-page">
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
          <>
            {/* #391：选择工具栏——非选择模式只显示「选择」入口；选择模式显示全选/计数/删除/取消。 */}
            <div className="sessions-toolbar">
              {selectMode ? (
                <>
                  <button type="button" className="btn small" onClick={toggleSelectAll}>
                    {allSelected ? t('sessions.cancelSelectAll') : t('sessions.selectAll')}
                  </button>
                  <span className="sessions-sel-count">
                    {t('sessions.selectedCount', { n: selectedKeys.size })}
                  </span>
                  <button
                    type="button"
                    className="btn small danger"
                    disabled={selectedKeys.size === 0}
                    onClick={() => setConfirmMulti(true)}
                  >
                    {t('sessions.deleteSelected')}
                  </button>
                  <button type="button" className="btn small ghost" onClick={exitSelectMode}>
                    {t('sessions.cancelSelect')}
                  </button>
                </>
              ) : (
                <button type="button" className="btn small" onClick={() => setSelectMode(true)}>
                  {t('sessions.select')}
                </button>
              )}
            </div>

            <div className="sessions-list" ref={listRef}>
              {sessions.map((task, index) => {
                const row = Math.floor(index / columns);
                const col = index % columns;
                const colorIdx = (row + col) % 4;
                const borderColor = `var(--session-card-border-${colorIdx + 1})`;
                const isSelected = selectMode && selectedKeys.has(task.issueKey);
                return (
                  <div
                    key={taskIdentity(task)}
                    className={`session-card${selectMode ? ' selectable' : ''}${
                      isSelected ? ' selected' : ''
                    }`}
                    style={{ borderColor }}
                    onClick={selectMode ? () => toggleSelect(task.issueKey) : undefined}
                  >
                    {/* #391：选择模式下卡片左侧复选框；点击 label 仅触发 checkbox 自身，
                        不冒泡到卡片（否则会触发两次 toggle）。 */}
                    {selectMode && (
                      <label className="session-card-check" onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={selectedKeys.has(task.issueKey)}
                          onChange={() => toggleSelect(task.issueKey)}
                          aria-label={t('sessions.toggleSelect', { num: task.number })}
                        />
                      </label>
                    )}
                    <div className="session-card-header">
                      <span className="session-card-title">
                        {t('sessions.title_format', {
                          num: task.number,
                          title: task.title,
                        })}
                      </span>
                      {/* #391：选择模式下隐藏单卡删除，统一走批量删除入口。 */}
                      {!selectMode && (
                        <button
                          type="button"
                          className="note-tool danger"
                          title={t('sessions.clear')}
                          onClick={() => setClearKey(task.issueKey)}
                        >
                          <Icon d={ICON.trash} />
                        </button>
                      )}
                      <button
                        type="button"
                        className="note-tool"
                        title={t('sessions.openTask')}
                        onClick={(e) => {
                          e.stopPropagation();
                          handleOpenTask(task);
                        }}
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
                            onClick={(e) => {
                              e.stopPropagation();
                              void handleCopy(task.workBranch, `branch-${task.issueKey}`);
                            }}
                          >
                            {copiedKey === `branch-${task.issueKey}` ? (
                              <Icon d={ICON.check} />
                            ) : (
                              <Icon d={ICON.copy} />
                            )}
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
                            onClick={(e) => {
                              e.stopPropagation();
                              void handleCopy(task.workDir, `dir-${task.issueKey}`);
                            }}
                          >
                            {copiedKey === `dir-${task.issueKey}` ? (
                              <Icon d={ICON.check} />
                            ) : (
                              <Icon d={ICON.copy} />
                            )}
                          </button>
                        </div>
                      )}
                      {task.sessionId && (
                        <div className="session-meta-row">
                          <span className="session-meta-label">{t('sessions.sessionId')}</span>
                          <code className="session-meta-value">{task.sessionId}</code>
                          <button
                            type="button"
                            className="note-tool"
                            title={t('sessions.copySession')}
                            onClick={(e) => {
                              e.stopPropagation();
                              void handleCopy(task.sessionId!, `session-${task.issueKey}`);
                            }}
                          >
                            {copiedKey === `session-${task.issueKey}` ? (
                              <Icon d={ICON.check} />
                            ) : (
                              <Icon d={ICON.copy} />
                            )}
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
                );
              })}
            </div>
          </>
        )}
        {clearKey && (
          <ConfirmDialog
            message={t('sessions.clearConfirm')}
            onConfirm={() => void handleClear(clearKey)}
            onCancel={() => setClearKey(null)}
          />
        )}
        {/* #391：批量删除确认框。 */}
        {confirmMulti && (
          <ConfirmDialog
            message={t('sessions.clearMultiConfirm', { n: selectedKeys.size })}
            onConfirm={() => void handleClearMulti()}
            onCancel={() => setConfirmMulti(false)}
          />
        )}
      </div>
    </div>
  );
}

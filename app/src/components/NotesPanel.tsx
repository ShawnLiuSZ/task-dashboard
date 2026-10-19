import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { CSSProperties } from 'react';
import { api } from '../api';
import { useT } from '../i18n';
import type { Note } from '../types';
import { groupNotesByDate } from '../utils/noteDateGroups';

type NoteLabel = Note['label'];

// v0.3.49 (#148)：标签名走 i18n；颜色保持不变。
const LABEL_DEFS: { value: NoteLabel; color: string }[] = [
  { value: 'low', color: '#9a9aa0' },
  { value: 'medium', color: '#0a6cff' },
  { value: 'high', color: '#f59e0b' },
  { value: 'urgent', color: '#e11d48' },
];

function useLabels(): { value: NoteLabel; label: string; color: string }[] {
  const t = useT();
  return useMemo(
    () =>
      LABEL_DEFS.map((l) => ({
        ...l,
        label: t(`notes.priority.${l.value}`),
      })),
    [t],
  );
}

function labelOf(labels: { value: NoteLabel; label: string; color: string }[], value: NoteLabel) {
  return labels.find((l) => l.value === value) ?? labels[0];
}

/* ---------- 图标（内联 SVG，避免 emoji 跨平台渲染差异） ---------- */

function Icon({ d, size = 14 }: { d: string; size?: number }) {
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
  pencil: 'M4 20h4l10.5-10.5a2.12 2.12 0 0 0-3-3L5 17v3z',
  trash: 'M4 7h16 M9 7V5h6v2 M6 7l1 13h10l1-13 M10 11v6 M14 11v6',
  close: 'M6 6l12 12 M18 6L6 18',
  download: 'M12 3v12 M7 10l5 5 5-5 M5 21h14',
  upload: 'M12 15V3 M7 8l5-5 5 5 M5 21h14',
};

/* ---------- 时间格式化（v0.3.49 #148：文案走 i18n） ---------- */

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

function fullTime(ts: number): string {
  if (!ts) return '-';
  return new Date(ts * 1000).toLocaleString();
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * 自适应高度的文本域：默认一行，随内容增长，上限 260px。
 * #322：改用 useLayoutEffect（DOM 变更后、绘制前同步测量），并在进入编辑态
 * （active=true）那一帧主动重测——否则挂载即预填长内容时，被动 useEffect 的
 * 初始测量会被 overflow-y:auto 列容器的滚动/绘制时序干扰，框体停在 min-height(42px)，
 * 只有继续输入（下一帧 value 变化）才撑开。
 */
function useAutoSize(value: string, active: boolean) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const resize = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 260)}px`;
  }, []);
  useLayoutEffect(() => {
    resize();
  }, [value, active, resize]);
  return { ref, resize };
}

export interface NotesPanelRef {
  /** #447：供顶栏创建 Modal 保存后主动刷新备忘录列表。 */
  reload: () => void;
}

/* ---------- 主组件 ---------- */

/** v0.3.24+ 记事本面板：快速记录任务相关的临时笔记。 */
export default forwardRef<NotesPanelRef>(function NotesPanel(_props, ref) {
  const t = useT();
  const labels = useLabels();
  const [notes, setNotes] = useState<Note[]>([]);
  const [loading, setLoading] = useState(true);
  /** #329：后台刷新（增删改后的重查）——不替换内容，只做轻量反馈。 */
  const [refreshing, setRefreshing] = useState(false);
  const loadedOnce = useRef(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [confirmId, setConfirmId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const editRef = useAutoSize(editDraft, editingId !== null);

  const loadNotes = useCallback(async () => {
    // #329：区分「首屏加载」与「后台刷新」。原先每次重查都把 loading 置真，
    // 于是增删改后右栏四列被整块替换成「加载中」占位 —— 界面跳变、列宽抖动。
    // 现在首屏才用 loading 占位，后续重查只置 refreshing（容器降透明度 + aria-busy）。
    if (loadedOnce.current) setRefreshing(true);
    else setLoading(true);
    try {
      setNotes(await api.listNotes());
      setError(null);
      loadedOnce.current = true;
    } catch (e) {
      console.error('加载记事失败:', e);
      setError(t('notes.loadFailed', { error: errText(e) }));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [t]);

  useImperativeHandle(ref, () => ({ reload: loadNotes }), [loadNotes]);

  useEffect(() => {
    void loadNotes();
  }, [loadNotes]);

  // #456：分列依据从**优先级**改为**添加日期**（相对时间段，列序从新到旧）。
  //
  // 优先级不再作为分列维度，但**颜色保留在卡片上**（`--note-accent` + `.note-tag` 色点），
  // 切换优先级的交互链路完全不变。原先的 `priorityColumns` 及其排序一并移除 ——
  // 列内已由日期分组函数保证倒序，不再需要全局按优先级排序。
  //
  // `now` 存state 而非在渲染里直接调 `Date.now()`：分组是纯函数、依赖显式时间戳，
  // 这样才能在测试里注入固定时刻验证日期边界。
  const [now] = useState(() => Date.now());
  const dateColumns = useMemo(() => groupNotesByDate(notes, now), [notes, now]);

  const renderNoteCard = (note: Note) => {
    const opt = labelOf(labels, note.label);
    const accent = { '--note-accent': opt.color } as CSSProperties;
    if (confirmId === note.id) {
      return (
        <article key={note.id} className="note-card confirming" style={accent}>
          <p className="note-confirm-text">{t('notes.deleteConfirm')}</p>
          <div className="note-confirm-actions">
            <button
              type="button"
              className="btn small danger"
              onClick={() => void handleDelete(note.id)}
            >
              {t('btn.delete')}
            </button>
            <button type="button" className="btn small ghost" onClick={() => setConfirmId(null)}>
              {t('btn.cancel')}
            </button>
          </div>
        </article>
      );
    }
    if (editingId === note.id) {
      return (
        <article key={note.id} className="note-card editing" style={accent}>
          <textarea
            ref={editRef.ref}
            className="note-textarea"
            value={editDraft}
            rows={1}
            autoFocus
            onChange={(e) => setEditDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                setEditingId(null);
                setEditDraft('');
              }
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void handleSave();
              }
            }}
          />
          <div className="note-edit-foot">
            <span className="note-hint">{t('notes.editHint')}</span>
            <div className="note-edit-actions">
              <button
                type="button"
                className="btn small ghost"
                onClick={() => {
                  setEditingId(null);
                  setEditDraft('');
                }}
                disabled={saving}
              >
                {t('btn.cancel')}
              </button>
              <button
                type="button"
                className="btn small primary"
                onClick={() => void handleSave()}
                disabled={saving || !editDraft.trim()}
              >
                {saving ? t('notes.saving') : t('btn.save')}
              </button>
            </div>
          </div>
        </article>
      );
    }
    return (
      <article key={note.id} className="note-card" style={accent}>
        <p className="note-content">{note.content}</p>
        <footer className="note-foot">
          <button
            type="button"
            className="note-tag"
            title={t('notes.toggleTag')}
            onClick={() => {
              const idx = labels.findIndex((l) => l.value === note.label);
              void handleLabelChange(note.id, labels[(idx + 1) % labels.length].value);
            }}
          >
            <span className="note-dot" />
            {opt.label}
          </button>
          <time className="note-time" title={fullTime(note.createdAt)}>
            {relTime(note.createdAt, t)}
            {note.updatedAt > note.createdAt && t('notes.editedSuffix')}
          </time>
          <div className="note-tools">
            <button
              type="button"
              className="note-tool"
              title={t('notes.editTitle')}
              onClick={() => {
                setEditingId(note.id);
                setEditDraft(note.content);
              }}
            >
              <Icon d={ICON.pencil} size={13} />
            </button>
            <button
              type="button"
              className="note-tool danger"
              title={t('notes.deleteTitle')}
              onClick={() => setConfirmId(note.id)}
            >
              <Icon d={ICON.trash} size={13} />
            </button>
          </div>
        </footer>
      </article>
    );
  };

  const handleSave = useCallback(async () => {
    if (editingId === null) return;
    const content = editDraft.trim();
    if (!content) return;
    setSaving(true);
    try {
      await api.updateNote(editingId, content);
      setEditingId(null);
      setEditDraft('');
      setError(null);
      await loadNotes();
    } catch (e) {
      console.error('更新记事失败:', e);
      setError(t('notes.saveFailed', { error: errText(e) }));
    } finally {
      setSaving(false);
    }
  }, [editingId, editDraft, loadNotes, t]);

  const handleDelete = useCallback(
    async (id: number) => {
      setConfirmId(null);
      try {
        await api.deleteNote(id);
        setError(null);
        await loadNotes();
      } catch (e) {
        console.error('删除记事失败:', e);
        setError(t('notes.deleteFailed', { error: errText(e) }));
      }
    },
    [loadNotes, t],
  );

  const handleLabelChange = useCallback(
    async (id: number, label: NoteLabel) => {
      try {
        await api.updateNoteLabel(id, label);
        setError(null);
        await loadNotes();
      } catch (e) {
        console.error('更新标签失败:', e);
        setError(t('notes.labelFailed', { error: errText(e) }));
      }
    },
    [loadNotes, t],
  );

  // v0.3.27+：导出全部记事为 JSON 文件（v0.3.45+ 默认写入系统下载目录，展示完整路径）。
  const handleExport = useCallback(async () => {
    if (busy) return;
    setBusy('export');
    setNotice(null);
    setError(null);
    try {
      const res = await api.exportNotes();
      if (res.count === 0) {
        setNotice(t('notes.exportEmpty'));
      } else {
        setNotice(t('notes.exported', { count: res.count, path: res.path }));
      }
    } catch (e) {
      console.error('导出记事失败:', e);
      setError(t('notes.exportFailed', { error: errText(e) }));
    } finally {
      setBusy(null);
    }
  }, [busy, t]);

  // v0.3.27+：从 JSON 文件导入记事（按内容去重，不覆盖已有数据）。
  const handleImport = useCallback(
    async (file: File | null) => {
      if (!file || busy) return;
      setBusy('import');
      setNotice(null);
      setError(null);
      try {
        const text = await file.text();
        const parsed = JSON.parse(text) as { notes?: { content?: string }[] };
        if (!Array.isArray(parsed.notes) || parsed.notes.length === 0) {
          throw new Error(t('notes.noImportable'));
        }
        // 校验格式：至少第一条含 content 字段
        if (!parsed.notes.some((n) => typeof n.content === 'string')) {
          throw new Error(t('notes.badFormat'));
        }
        // 前端读文件内容传给后端解析（Tauri 2 不暴露 file.path），后端按 content 去重
        const res = await api.importNotes(text);
        setNotice(t('notes.imported', { imported: res.imported, skipped: res.skipped }));
        await loadNotes();
      } catch (e) {
        console.error('导入记事失败:', e);
        setError(t('notes.importFailed', { error: errText(e) }));
      } finally {
        setBusy(null);
        if (fileInputRef.current) fileInputRef.current.value = '';
      }
    },
    [busy, loadNotes, t],
  );

  return (
    // #259：记事本是主区整页，宽度由 .notes-page 撑满 —— **不要再挂行内 flex/width**，
    // 行内样式优先级高于样式表，曾把面板锁在 25% 宽（四列被压成竖条的根因）。
    <aside className="notes-panel">
      {notice && (
        <div className="note-notice" role="status">
          <span>{notice}</span>
          <button
            type="button"
            className="note-tool"
            title={t('notes.closeTitle')}
            onClick={() => setNotice(null)}
          >
            <Icon d={ICON.close} size={12} />
          </button>
        </div>
      )}
      {error && (
        <div className="note-error" role="alert">
          <span>{error}</span>
          <button
            type="button"
            className="note-tool"
            title={t('notes.closeTitle')}
            onClick={() => setError(null)}
          >
            <Icon d={ICON.close} size={12} />
          </button>
        </div>
      )}

      {/* #447：创建入口移到顶部标题栏 Modal；面板内保留导入/导出工具行。 */}
      <div className="notes-toolbar">
        <span className="notes-toolbar-title">{t('notes.title')}</span>
        <span className="notes-toolbar-spacer" />
        <button
          type="button"
          className="note-tool"
          title={t('notes.exportTitle')}
          onClick={() => void handleExport()}
          disabled={busy !== null}
        >
          <Icon d={ICON.download} size={13} />
        </button>
        <button
          type="button"
          className="note-tool"
          title={t('notes.importTitle')}
          onClick={() => fileInputRef.current?.click()}
          disabled={busy !== null}
        >
          <Icon d={ICON.upload} size={13} />
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="application/json,.json"
          style={{ display: 'none' }}
          onChange={(e) => void handleImport(e.target.files?.[0] ?? null)}
        />
      </div>

      {/* #456：按添加日期横向分列（今天 → 昨天 → 本周 → 更早，只渲染非空列）。
          列头**不再有优先级色点与彩色列顶横条** —— 优先级颜色改由卡片承载
 （`.note-tag .note-dot` 取 `--note-accent`；卡片左侧色条是#259 时用户主动去掉的，勿再加回）。 */}
      <div className="notes-card-cols" aria-busy={refreshing || undefined}>
        {loading ? (
          <div className="notes-placeholder">{t('notes.loading')}</div>
        ) : (
          dateColumns.map((col) => (
            <div key={col.key} className={`note-col note-col--${col.key}`}>
              <div className="note-col-head">
                <span className="note-col-title">{t(`notes.dateGroup.${col.key}`)}</span>
                <span className="note-col-count">{col.items.length}</span>
              </div>
              <div className="note-col-body">
                {col.items.length === 0 ? (
                  <div className="note-col-empty">{t('notes.colEmpty')}</div>
                ) : (
                  col.items.map(renderNoteCard)
                )}
              </div>
            </div>
          ))
        )}
      </div>
    </aside>
  );
});

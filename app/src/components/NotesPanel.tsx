import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { CSSProperties } from 'react';
import { api } from '../api';
import { useT } from '../i18n';
import type { Note } from '../types';
import NoteEditorModal from './NoteEditorModal';
import NoteViewerModal from './NoteViewerModal';

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
  /** #465：查看全文（放大镜）。 */
  zoom: 'M11 4a7 7 0 100 14 7 7 0 000-14z M20 20l-4-4',
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
  const [confirmId, setConfirmId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** #465：正在「查看全文」的备忘录 id —— 非 null 时弹出查看 Modal。 */
  const [viewingId, setViewingId] = useState<number | null>(null);
  /**
   * #470：正在「编辑」的备忘录 id —— 非 null 时弹出**编辑 Modal**。
   *
   * 改造前这里是「行内编辑态」：点铅笔 ⇒ **原卡片**变成 textarea。同一屏里
   * 混着「高耸的编辑中卡片」与「折叠 9 行的只读卡片」，高度差一个数量级，
   * 瀑布流的列高被单张高卡片拉长。现在编辑也进弹窗 ⇒ 卡片**永远只有一种形态**。
   */
  const [editingId, setEditingId] = useState<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

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

  // #456：改为**列表展示**（与「任务会话」面板同构的单网格列表，不再分列）。
  //
  // 排序只用**创建时间倒序** —— 最新的在最前面，符合「刚写了什么」的使用直觉。
  // 优先级既不再分列也不再参与排序，仅作为**卡片上的颜色标记**存在
  // （`--note-accent` + `.note-tag` 色点），切换优先级的交互链路完全不变。
  const sortedNotes = useMemo(() => [...notes].sort((a, b) => b.createdAt - a.createdAt), [notes]);

  // #465：正在查看的备忘录。列表刷新后该条可能已被删除 ⇒ 找不到就当作没打开
  // （Modal 自动消失，而不是渲染一个空壳）。
  const viewingNote = useMemo(
    () => (viewingId === null ? null : (notes.find((n) => n.id === viewingId) ?? null)),
    [notes, viewingId],
  );

  // #470：正在编辑的备忘录（同样处理「刷新后已被删除」）。
  const editingNote = useMemo(
    () => (editingId === null ? null : (notes.find((n) => n.id === editingId) ?? null)),
    [notes, editingId],
  );

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
    // #470：原先这里有「行内编辑态」分支（卡片变成 textarea）。编辑已搬进
    // NoteEditorModal ⇒ 卡片**永远只呈现折叠只读这一种形态**，列表高度收敛、
    // 瀑布流列高一致。
    return (
      <article key={note.id} className="note-card" style={accent}>
        {/* #465：正文**折叠**（`.note-content` 的 `-webkit-line-clamp: 9`）——
            卡片里只显示前 9 行 + 省略号，完整内容走右上角「查看」按钮的 Modal。
            折叠而非全展开的原因：多列流里卡片越高该列越长，高度差过大时
            三列底部严重参差，瀑布流看起来像「一列很长、两列很短」。 */}
        <p className="note-content">{note.content}</p>
        {/* #465：右上角「查看全文」按钮。绝对定位，不占布局高度（否则每张卡片
            都多出一行，瀑布流会明显变高）；正文已预留 padding-right 让位，
            按钮恒不压住文字。 */}
        <button
          type="button"
          className="note-view-btn"
          title={t('notes.viewTruncated')}
          aria-label={t('notes.viewTitle')}
          onClick={() => setViewingId(note.id)}
        >
          <Icon d={ICON.zoom} size={13} />
        </button>
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
              onClick={() => setEditingId(note.id)}
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

  // #470：保存由**编辑弹窗**发起（弹窗内持有草稿与「保存中」状态）。
  // 面板这边只负责落库 + 刷新列表；抛错则由弹窗展示错误、保持在编辑态。
  const handleSave = useCallback(
    async (id: number, content: string) => {
      await api.updateNote(id, content);
      setError(null);
      await loadNotes();
    },
    [loadNotes],
  );

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

      {/* #456：列表展示 —— 网格容器与「任务会话」面板的 `.sessions-list` 同参
          （auto-fill minmax(320px, 1fr)：宽窗口自动排多列，窄窗口降为单列）。
          优先级颜色完全由卡片承载（`--note-accent` + `.note-tag` 色点），列不再存在。
          #462：改为多列流瀑布流（`column-count` + `column-fill: balance`）。

          #465：**滚动宿主与列容器分离** —— `.notes-scroll` 承担「固定最大高度 +
          纵向滚动条」，`.notes-list`（多列容器）高度自适应内容。
          两者合一（同一个元素既限高又滚动）会让多列流的列高被锁死 ⇒
          `break-inside: avoid` 失效（同一条备忘录被劈成两列）且纵向根本不滚动。 */}
      <div className="notes-scroll">
        <div className="notes-list" aria-busy={refreshing || undefined}>
          {loading ? (
            <div className="notes-placeholder">{t('notes.loading')}</div>
          ) : sortedNotes.length === 0 ? (
            <div className="notes-placeholder">{t('notes.colEmpty')}</div>
          ) : (
            sortedNotes.map(renderNoteCard)
          )}
        </div>
      </div>

      {/* #465：查看全文 Modal。挂在面板**内部**（而非 App 层）——
          `.notes-panel` 是 `position: relative` 的遮罩宿主，Modal 在此渲染
          才能覆盖整个面板区域；挂到 App 层会被 `.main-content` 的
          `overflow: hidden` 裁掉。 */}
      {viewingNote && <NoteViewerModal note={viewingNote} onClose={() => setViewingId(null)} />}

      {/* #470：编辑 Modal。与查看 Modal 同挂在面板内部（同一遮罩宿主）。
          弹窗内是**完整正文**的多行编辑框（不折叠）+ 保存/取消；
          ⌘/Ctrl + Enter 保存，Esc 取消编辑（丢弃草稿）。 */}
      {editingNote && (
        <NoteEditorModal
          note={editingNote}
          onClose={() => setEditingId(null)}
          onSave={async (content) => {
            await handleSave(editingNote.id, content);
            setEditingId(null);
          }}
        />
      )}
    </aside>
  );
});

import { useCallback, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { useT } from '../i18n';
import { useWindowEscLayer } from '../utils/useEscLayer';
import { useAutoSize } from '../utils/useAutoSize';
import type { Note } from '../types';

type NoteLabel = Note['label'];

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

function fullTime(ts: number): string {
  if (!ts) return '-';
  return new Date(ts * 1000).toLocaleString();
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const ICON = {
  close: 'M6 6l12 12 M18 6L6 18',
  pencil: 'M4 20h4l10.5-10.5a2.12 2.12 0 0 0-3-3L5 17v3z',
};

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

interface Props {
  note: Note;
  /** 保存回调；抛错则弹窗保持在编辑态并展示错误。 */
  onSave: (content: string) => Promise<void>;
  onClose: () => void;
}

/**
 * #470：备忘录**编辑**弹窗。
 *
 * ## 为什么编辑也要进弹窗（而不是在卡片上就地改）
 *
 * 改造前：点铅笔 ⇒ **原卡片**变成 textarea 行内编辑。同一屏里于是混着两种
 * 形态的卡片 —— 编辑中的（textarea 自适应高度，可达 260px）与折叠只读的
 * （`-webkit-line-clamp: 9`，约 9 行）。高度差一个数量级：
 *
 * - 瀑布流（`column-count` + `break-inside: avoid`）的**列高由内容决定** ⇒
 *   一张高卡片把整列拉长，底部参差比纯阅读状态更明显；
 * - 编辑态 textarea 不受折叠约束，正文一多就把列撑爆；
 * - 用户想「边看边改」得先关掉查看弹窗、回到卡片、点铅笔、再点放大镜，来回跳。
 *
 * 改造后：**编辑与查看共用弹窗形态**，卡片永远只呈现「折叠只读」这一种形态 ⇒
 * 列表高度收敛、列高一致；而弹窗内是**完整正文的多行编辑框**（不折叠），
 * 编辑所见即所得。
 *
 * ## 与查看弹窗的关系
 *
 * `NoteViewerModal`（#465）是**只读**的完整正文视图；本组件是**可写**的。
 * 两者都挂在 `.notes-panel` 内部（面板是 `position: relative` 的遮罩宿主），
 * 挂到 App 层会被 `.main-content` 的 `overflow: hidden` 裁掉。
 *
 * ## Esc 语义
 *
 * 走 window 级分层（#344）：弹窗是遮罩层，拿不到焦点 ⇒ 元素级 `onKeyDown`
 * 收不到事件。Esc = **取消编辑**（丢弃草稿、不落库），与行内编辑时代的
 * 「Esc 取消编辑」语义一致，只是落点从卡片换成了弹窗。
 */
export default function NoteEditorModal({ note, onSave, onClose }: Props) {
  const t = useT();
  const labels = useLabels();
  const opt = labelOf(labels, note.label);
  const accent = { '--note-accent': opt.color } as CSSProperties;

  const [draft, setDraft] = useState(note.content);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // #322：进入编辑态那一帧主动量高（textarea 刚挂载、内容已预填）。
  // 本弹窗里 textarea 一直挂载 ⇒ 传 active=true 常开。
  const textareaRef = useAutoSize(draft, true);

  // Esc 取消编辑。走 window 级分层（#344）。
  useWindowEscLayer(onClose);

  const handleSave = useCallback(async () => {
    const content = draft.trim();
    if (!content || saving) return;
    setSaving(true);
    setError(null);
    try {
      await onSave(content);
    } catch (e) {
      console.error('更新记事失败:', e);
      setError(t('notes.saveFailed', { error: errText(e) }));
    } finally {
      setSaving(false);
    }
  }, [draft, saving, onSave, t]);

  return (
    <div className="modal-mask note-editor-mask" onClick={onClose}>
      <div
        className="modal note-editor-modal"
        style={accent}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={t('notes.editModalTitle')}
      >
        <div className="note-editor-head">
          <h3 className="modal-title">{t('notes.editModalTitle')}</h3>
          <button
            type="button"
            className="note-tool"
            title={t('notes.viewClose')}
            aria-label={t('notes.viewClose')}
            onClick={onClose}
          >
            <Icon d={ICON.close} size={13} />
          </button>
        </div>

        {/* 编辑框：**完整正文**，不折叠（折叠只发生在卡片上）。
            ⌘/Ctrl + Enter 保存，Esc 取消。 */}
        <textarea
          ref={textareaRef}
          className="note-textarea note-editor-textarea"
          value={draft}
          rows={1}
          autoFocus
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void handleSave();
            }
          }}
        />

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

        <div className="note-editor-foot">
          <span className="note-tag">
            <span className="note-dot" />
            {opt.label}
          </span>
          <time className="note-time" title={fullTime(note.createdAt)}>
            {fullTime(note.createdAt)}
          </time>
        </div>

        <div className="note-editor-actions">
          <span className="note-hint">{t('notes.editHint')}</span>
          <div className="note-editor-buttons">
            <button type="button" className="btn ghost" onClick={onClose} disabled={saving}>
              {t('btn.cancel')}
            </button>
            <button
              type="button"
              className="btn primary"
              onClick={() => void handleSave()}
              disabled={saving || !draft.trim()}
            >
              {!saving && <Icon d={ICON.pencil} size={13} />}
              {saving ? t('notes.saving') : t('btn.save')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

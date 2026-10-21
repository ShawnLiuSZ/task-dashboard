import type { CSSProperties } from 'react';
import { useT } from '../i18n';
import { useWindowEscLayer } from '../utils/useEscLayer';
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
  return LABEL_DEFS.map((l) => ({
    ...l,
    label: t(`notes.priority.${l.value}`),
  }));
}

function labelOf(labels: { value: NoteLabel; label: string; color: string }[], value: NoteLabel) {
  return labels.find((l) => l.value === value) ?? labels[0];
}

function fullTime(ts: number): string {
  if (!ts) return '-';
  return new Date(ts * 1000).toLocaleString();
}

const ICON = {
  close: 'M6 6l12 12 M18 6L6 18',
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
  onClose: () => void;
}

/**
 * #465：备忘录「查看全文」弹窗。
 *
 * 存在的理由：卡片正文用 `-webkit-line-clamp` 折叠（只显示前 9 行 + 省略号），
 * 完整内容由本弹窗承载 —— 折叠让所有卡片高度收敛，多列流的三列底部不会
 * 严重参差（一张超高卡片会把整列拉长）。
 *
 * 挂在 `.notes-panel` 内部渲染（不是 App 层）—— 面板是 `position: relative`
 * 的遮罩宿主，且 App 层 Modal 会被 `.main-content` 的 `overflow: hidden` 裁掉。
 */
export default function NoteViewerModal({ note, onClose }: Props) {
  const t = useT();
  const labels = useLabels();
  const opt = labelOf(labels, note.label);
  const accent = { '--note-accent': opt.color } as CSSProperties;

  // Esc 关闭。走 window 级分层（#344）：确认框/弹窗这类遮罩层拿不到焦点，
  // 元素级 onKeyDown 收不到事件。
  useWindowEscLayer(onClose);

  return (
    <div className="modal-mask note-viewer-mask" onClick={onClose}>
      <div
        className="modal note-viewer-modal"
        style={accent}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={t('notes.viewModalTitle')}
      >
        <div className="note-viewer-head">
          <h3 className="modal-title">{t('notes.viewModalTitle')}</h3>
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
        {/* 全文按原样保留换行（white-space: pre-wrap），不截断 ——
            这是弹窗存在的意义：卡片里看不全的内容在这里完整呈现。 */}
        <div className="note-viewer-content">{note.content}</div>
        <div className="note-viewer-foot">
          <span className="note-tag">
            <span className="note-dot" />
            {opt.label}
          </span>
          <time className="note-time" title={fullTime(note.createdAt)}>
            {fullTime(note.createdAt)}
          </time>
        </div>
      </div>
    </div>
  );
}

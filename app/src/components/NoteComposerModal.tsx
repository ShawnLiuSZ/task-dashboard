import { useCallback, useState } from 'react';
import type { CSSProperties } from 'react';
import { useT } from '../i18n';
import { useEscLayer } from '../utils/useEscLayer';
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
  return LABEL_DEFS.map((l) => ({ ...l, label: t(`notes.priority.${l.value}`) }));
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** #470：自适应高度 hook 已抽到 `utils/useAutoSize.ts`（与编辑弹窗共用）。 */

function LabelPicker({ value, onChange }: { value: NoteLabel; onChange: (l: NoteLabel) => void }) {
  const t = useT();
  const labels = useLabels();
  return (
    <div className="label-picker sm" role="group" aria-label={t('notes.labelGroup')}>
      {labels.map((l) => (
        <button
          key={l.value}
          type="button"
          className={`label-chip${l.value === value ? ' active' : ''}`}
          style={{ '--chip': l.color } as CSSProperties}
          onClick={() => onChange(l.value)}
          title={t('notes.markAs', { label: l.label })}
        >
          {l.label}
        </button>
      ))}
    </div>
  );
}

const ICON = {
  plus: 'M12 5v14 M5 12h14',
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
  onSave: (content: string, label: NoteLabel) => Promise<void>;
  onClose: () => void;
}

/** #447：顶部标题栏触发的备忘录创建 Modal。 */
export default function NoteComposerModal({ onSave, onClose }: Props) {
  const t = useT();
  const [draft, setDraft] = useState('');
  const [label, setLabel] = useState<NoteLabel>('low');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useAutoSize(draft);
  const isEscTop = useEscLayer();

  const handleSave = useCallback(async () => {
    const content = draft.trim();
    if (!content || saving) return;
    setSaving(true);
    setError(null);
    try {
      await onSave(content, label);
    } catch (e) {
      setError(errText(e));
    } finally {
      setSaving(false);
    }
  }, [draft, label, saving, onSave]);

  return (
    <div className="modal-mask" onClick={onClose}>
      <div
        className="modal note-composer-modal"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && isEscTop()) {
            e.preventDefault();
            onClose();
          }
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !saving && draft.trim()) {
            e.preventDefault();
            void handleSave();
          }
        }}
        role="dialog"
        aria-modal="true"
        aria-label={t('notes.composer.title')}
      >
        <h3 className="modal-title">{t('notes.composer.title')}</h3>
        <textarea
          ref={textareaRef}
          className="note-textarea note-composer-textarea"
          placeholder={t('notes.composer.placeholder')}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={1}
          autoFocus
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
        <div className="note-composer-modal-foot">
          <LabelPicker value={label} onChange={setLabel} />
          <div className="note-composer-modal-actions">
            <button type="button" className="btn ghost" onClick={onClose} disabled={saving}>
              {t('btn.cancel')}
            </button>
            <button
              type="button"
              className="btn primary"
              onClick={() => void handleSave()}
              disabled={saving || !draft.trim()}
            >
              {!saving && <Icon d={ICON.plus} size={13} />}
              {saving ? t('notes.adding') : t('notes.add')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

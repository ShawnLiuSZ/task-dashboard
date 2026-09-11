import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { api } from "../api";
import { useT } from "../i18n";
import type { Note } from "../types";

type NoteLabel = Note["label"];

// v0.3.49 (#148)：标签名走 i18n；颜色保持不变。
const LABEL_DEFS: { value: NoteLabel; color: string }[] = [
  { value: "low", color: "#9a9aa0" },
  { value: "medium", color: "#0a6cff" },
  { value: "high", color: "#f59e0b" },
  { value: "urgent", color: "#e11d48" },
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

function labelOf(
  labels: { value: NoteLabel; label: string; color: string }[],
  value: NoteLabel,
) {
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
  notebook: "M5 4.5A1.5 1.5 0 0 1 6.5 3H18a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H6.5A1.5 1.5 0 0 1 5 19.5z M5 16.5h14 M9 8h6 M9 11.5h6",
  plus: "M12 5v14 M5 12h14",
  pencil: "M4 20h4l10.5-10.5a2.12 2.12 0 0 0-3-3L5 17v3z",
  trash: "M4 7h16 M9 7V5h6v2 M6 7l1 13h10l1-13 M10 11v6 M14 11v6",
  check: "M5 12.5l4.5 4.5L19 7.5",
  close: "M6 6l12 12 M18 6L6 18",
  collapse: "M14 6l-6 6 6 6",
  expand: "M10 6l6 6-6 6",
  download: "M12 3v12 M7 10l5 5 5-5 M5 21h14",
  upload: "M12 15V3 M7 8l5-5 5 5 M5 21h14",
};

/** 收起状态持久化键（本地偏好，不入数据库）。 */
const COLLAPSED_KEY = "notes.collapsed";

/** 宽度百分比持久化键（本地偏好，不入数据库）。范围 25–50，默认 25。 */
const WIDTH_KEY = "notes.widthPct";
const MIN_WIDTH_PCT = 25;
const MAX_WIDTH_PCT = 50;
const DEFAULT_WIDTH_PCT = 25;

/** 钳制到 [25, 50]；非法输入回默认。 */
export function clampNotesWidthPct(v: number): number {
  if (!Number.isFinite(v)) return DEFAULT_WIDTH_PCT;
  return Math.min(MAX_WIDTH_PCT, Math.max(MIN_WIDTH_PCT, v));
}

/** 读存档宽度（缺失/非法 → 默认 25）。 */
export function readNotesWidthPct(): number {
  const raw = localStorage.getItem(WIDTH_KEY);
  if (raw === null || raw.trim() === "") return DEFAULT_WIDTH_PCT;
  return clampNotesWidthPct(Number(raw));
}

/* ---------- 时间格式化（v0.3.49 #148：文案走 i18n） ---------- */

function relTime(ts: number, t: (key: string, params?: Record<string, string | number>) => string): string {
  if (!ts) return "-";
  const diff = Math.floor(Date.now() / 1000) - ts;
  if (diff < 60) return t("notes.time.justNow");
  if (diff < 3600) return t("notes.time.minutesAgo", { n: Math.floor(diff / 60) });
  if (diff < 86400) return t("notes.time.hoursAgo", { n: Math.floor(diff / 3600) });
  if (diff < 7 * 86400) return t("notes.time.daysAgo", { n: Math.floor(diff / 86400) });
  const d = new Date(ts * 1000);
  return t("notes.time.monthDay", { m: d.getMonth() + 1, d: d.getDate() });
}

function fullTime(ts: number): string {
  if (!ts) return "-";
  return new Date(ts * 1000).toLocaleString();
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 自适应高度的文本域：默认一行，随内容增长，上限 260px。 */
function useAutoSize(value: string) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 260)}px`;
  }, [value]);
  return ref;
}

/* ---------- 子组件 ---------- */

/** 标签选择：一组分段 chip，替代原生 select。 */
function LabelPicker({
  value,
  onChange,
  size = "md",
}: {
  value: NoteLabel;
  onChange: (l: NoteLabel) => void;
  size?: "sm" | "md";
}) {
  const t = useT();
  const labels = useLabels();
  return (
    <div className={`label-picker ${size === "sm" ? "sm" : ""}`} role="group" aria-label={t("notes.labelGroup")}>
      {labels.map((l) => (
        <button
          key={l.value}
          type="button"
          className={`label-chip${l.value === value ? " active" : ""}`}
          style={{ "--chip": l.color } as CSSProperties}
          onClick={() => onChange(l.value)}
          title={t("notes.markAs", { label: l.label })}
        >
          {l.label}
        </button>
      ))}
    </div>
  );
}

/* ---------- 主组件 ---------- */

/** v0.3.24+ 记事本面板：快速记录任务相关的临时笔记。 */
export default function NotesPanel() {
  const t = useT();
  const labels = useLabels();
  const [notes, setNotes] = useState<Note[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState("");
  const [draftLabel, setDraftLabel] = useState<NoteLabel>("low");
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [confirmId, setConfirmId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // #202 丝滑拖拽：拖动中只做 DOM 直写 + rAF 合并，不进 React state；
  // 松手才 setWidthPct（一次渲染 + 一次持久化）。pctRef 为拖动起点快照。
  const panelRef = useRef<HTMLElement | null>(null);
  const pctRef = useRef<number>(DEFAULT_WIDTH_PCT);
  // 收起后列表内容完全不渲染（避免旁人看到），状态记在本地，重启后保持。
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem(COLLAPSED_KEY) === "1",
  );
  // #202：展开态宽度（占主区百分比），拖拽/键盘调整后持久化。
  const [widthPct, setWidthPct] = useState(readNotesWidthPct);

  const draftRef = useAutoSize(draft);
  const editRef = useAutoSize(editDraft);

  useEffect(() => {
    localStorage.setItem(COLLAPSED_KEY, collapsed ? "1" : "0");
  }, [collapsed]);

  useEffect(() => {
    localStorage.setItem(WIDTH_KEY, String(widthPct));
    pctRef.current = widthPct;
  }, [widthPct]);

  const loadNotes = useCallback(async () => {
    setLoading(true);
    try {
      setNotes(await api.listNotes());
      setError(null);
    } catch (e) {
      console.error("加载记事失败:", e);
      setError(t("notes.loadFailed", { error: errText(e) }));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void loadNotes();
  }, [loadNotes]);

  const handleAdd = useCallback(async () => {
    const content = draft.trim();
    if (!content) return;
    setAdding(true);
    try {
      await api.addNote(content, draftLabel);
      setDraft("");
      setDraftLabel("low");
      setError(null);
      await loadNotes();
    } catch (e) {
      console.error("添加记事失败:", e);
      setError(t("notes.addFailed", { error: errText(e) }));
    } finally {
      setAdding(false);
    }
  }, [draft, draftLabel, loadNotes, t]);

  const handleSave = useCallback(async () => {
    if (editingId === null) return;
    const content = editDraft.trim();
    if (!content) return;
    setSaving(true);
    try {
      await api.updateNote(editingId, content);
      setEditingId(null);
      setEditDraft("");
      setError(null);
      await loadNotes();
    } catch (e) {
      console.error("更新记事失败:", e);
      setError(t("notes.saveFailed", { error: errText(e) }));
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
        console.error("删除记事失败:", e);
        setError(t("notes.deleteFailed", { error: errText(e) }));
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
        console.error("更新标签失败:", e);
        setError(t("notes.labelFailed", { error: errText(e) }));
      }
    },
    [loadNotes, t],
  );

  // v0.3.27+：导出全部记事为 JSON 文件（v0.3.45+ 默认写入系统下载目录，展示完整路径）。
  const handleExport = useCallback(async () => {
    if (busy) return;
    setBusy("export");
    setNotice(null);
    setError(null);
    try {
      const res = await api.exportNotes();
      if (res.count === 0) {
        setNotice(t("notes.exportEmpty"));
      } else {
        setNotice(t("notes.exported", { count: res.count, path: res.path }));
      }
    } catch (e) {
      console.error("导出记事失败:", e);
      setError(t("notes.exportFailed", { error: errText(e) }));
    } finally {
      setBusy(null);
    }
  }, [busy, t]);

  // v0.3.27+：从 JSON 文件导入记事（按内容去重，不覆盖已有数据）。
  const handleImport = useCallback(
    async (file: File | null) => {
      if (!file || busy) return;
      setBusy("import");
      setNotice(null);
      setError(null);
      try {
        const text = await file.text();
        const parsed = JSON.parse(text) as { notes?: { content?: string }[] };
        if (!Array.isArray(parsed.notes) || parsed.notes.length === 0) {
          throw new Error(t("notes.noImportable"));
        }
        // 校验格式：至少第一条含 content 字段
        if (!parsed.notes.some((n) => typeof n.content === "string")) {
          throw new Error(t("notes.badFormat"));
        }
        // 前端读文件内容传给后端解析（Tauri 2 不暴露 file.path），后端按 content 去重
        const res = await api.importNotes(text);
        setNotice(
          t("notes.imported", { imported: res.imported, skipped: res.skipped }),
        );
        await loadNotes();
      } catch (e) {
        console.error("导入记事失败:", e);
        setError(t("notes.importFailed", { error: errText(e) }));
      } finally {
        setBusy(null);
        if (fileInputRef.current) fileInputRef.current.value = "";
      }
    },
    [busy, loadNotes, t],
  );

  // 收起态：只留一条竖向导轨，列表内容完全不渲染。
  if (collapsed) {
    return (
      <aside className="notes-panel collapsed">
        <button
          type="button"
          className="notes-rail"
          onClick={() => setCollapsed(false)}
          title={t("notes.expandTitle")}
        >
          <Icon d={ICON.expand} size={14} />
          <span className="notes-rail-text">{t("notes.title")}</span>
          {notes.length > 0 && (
            <span className="notes-rail-count">{notes.length}</span>
          )}
        </button>
      </aside>
    );
  }

  return (
    <aside
      ref={panelRef}
      className="notes-panel"
      style={{ flex: `0 0 ${widthPct}%`, width: `${widthPct}%` }}
    >
      <header className="notes-head">
        <span className="notes-head-icon">
          <Icon d={ICON.notebook} size={15} />
        </span>
        <span className="notes-title">{t("notes.title")}</span>
        <span className="notes-count">{notes.length}</span>
        <div className="notes-tools">
          <button
            type="button"
            className="note-tool"
            title={t("notes.exportTitle")}
            onClick={() => void handleExport()}
            disabled={busy !== null}
          >
            <Icon d={ICON.download} size={13} />
          </button>
          <button
            type="button"
            className="note-tool"
            title={t("notes.importTitle")}
            onClick={() => fileInputRef.current?.click()}
            disabled={busy !== null}
          >
            <Icon d={ICON.upload} size={13} />
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/json,.json"
            style={{ display: "none" }}
            onChange={(e) => void handleImport(e.target.files?.[0] ?? null)}
          />
          <button
            type="button"
            className="note-tool"
            title={t("notes.collapseTitle")}
            onClick={() => setCollapsed(true)}
          >
            <Icon d={ICON.collapse} size={13} />
          </button>
        </div>
      </header>

      <div className="notes-body">
        {notice && (
          <div className="note-notice" role="status">
            <span>{notice}</span>
          <button
            type="button"
            className="note-tool"
            title={t("notes.closeTitle")}
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
            title={t("notes.closeTitle")}
            onClick={() => setError(null)}
          >
            <Icon d={ICON.close} size={12} />
          </button>
        </div>
      )}

      {/* 新建 */}
      <div className="note-composer">
        <textarea
          ref={draftRef}
          className="note-textarea"
          placeholder={t("notes.composer.placeholder")}
          value={draft}
          rows={1}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !adding && draft.trim()) {
              e.preventDefault();
              void handleAdd();
            }
          }}
        />
        <div className="note-composer-foot">
          <LabelPicker value={draftLabel} onChange={setDraftLabel} />
          <button
            type="button"
            className="btn primary"
            onClick={() => void handleAdd()}
            disabled={adding || !draft.trim()}
          >
            {!adding && <Icon d={ICON.plus} size={13} />}
            {adding ? t("notes.adding") : t("notes.add")}
          </button>
        </div>
      </div>

      {/* 列表 */}
      <div className="notes-list">
        {loading ? (
          <div className="notes-placeholder">{t("notes.loading")}</div>
        ) : notes.length === 0 ? (
          <div className="notes-empty">
            <span className="notes-empty-icon">
              <Icon d={ICON.notebook} size={22} />
            </span>
            <p>{t("notes.emptyTitle")}</p>
            <span>{t("notes.emptySub")}</span>
          </div>
        ) : (
          notes.map((note) => {
            const opt = labelOf(labels, note.label);
              const accent = { "--note-accent": opt.color } as CSSProperties;

              if (confirmId === note.id) {
                return (
                  <article key={note.id} className="note-card confirming" style={accent}>
                    <p className="note-confirm-text">{t("notes.deleteConfirm")}</p>
                    <div className="note-confirm-actions">
                      <button
                        type="button"
                        className="btn small danger"
                        onClick={() => void handleDelete(note.id)}
                      >
                        {t("btn.delete")}
                      </button>
                      <button
                        type="button"
                        className="btn small ghost"
                        onClick={() => setConfirmId(null)}
                      >
                        {t("btn.cancel")}
                      </button>
                    </div>
                  </article>
                );
              }

              if (editingId === note.id) {
                return (
                  <article key={note.id} className="note-card editing" style={accent}>
                    <textarea
                      ref={editRef}
                      className="note-textarea"
                      value={editDraft}
                      rows={1}
                      autoFocus
                      onChange={(e) => setEditDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Escape") {
                          e.preventDefault();
                          setEditingId(null);
                          setEditDraft("");
                        }
                        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                          e.preventDefault();
                          void handleSave();
                        }
                      }}
                    />
                    <div className="note-edit-foot">
                      <span className="note-hint">{t("notes.editHint")}</span>
                      <div className="note-edit-actions">
                        <button
                          type="button"
                          className="btn small ghost"
                          onClick={() => {
                            setEditingId(null);
                            setEditDraft("");
                          }}
                          disabled={saving}
                        >
                          {t("btn.cancel")}
                        </button>
                        <button
                          type="button"
                          className="btn small primary"
                          onClick={() => void handleSave()}
                          disabled={saving || !editDraft.trim()}
                        >
                          {saving ? t("notes.saving") : t("btn.save")}
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
                      title={t("notes.toggleTag")}
                      onClick={() => {
                        const idx = labels.findIndex((l) => l.value === note.label);
                        const next = labels[(idx + 1) % labels.length];
                        void handleLabelChange(note.id, next.value);
                      }}
                    >
                      <span className="note-dot" />
                      {opt.label}
                    </button>
                    <time className="note-time" title={fullTime(note.createdAt)}>
                      {relTime(note.createdAt, t)}
                      {note.updatedAt > note.createdAt && t("notes.editedSuffix")}
                    </time>
                    <div className="note-tools">
                      <button
                        type="button"
                        className="note-tool"
                        title={t("notes.editTitle")}
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
                        title={t("notes.deleteTitle")}
                        onClick={() => setConfirmId(note.id)}
                      >
                        <Icon d={ICON.trash} size={13} />
                      </button>
                    </div>
                  </footer>
                </article>
              );
            })
          )}
        </div>
      </div>
      {/* #202：宽度拖拽条（面板右缘；键盘左右箭头 ±1%）。 */}
      <div
        className="notes-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label={t("notes.resizeTitle")}
        aria-valuemin={MIN_WIDTH_PCT}
        aria-valuemax={MAX_WIDTH_PCT}
        aria-valuenow={Math.round(widthPct)}
        tabIndex={0}
        onMouseDown={(e) => {
          e.preventDefault();
          const panel = panelRef.current;
          const parent = panel?.parentElement;
          const handle = e.currentTarget;
          if (!panel || !parent) return;
          const startX = e.clientX;
          const startPct = pctRef.current;
          let latestX = startX;
          let raf = 0;
          const apply = () => {
            raf = 0;
            const w = parent.getBoundingClientRect().width;
            if (w <= 0) return;
            // 相对位移换算（只读一次起点，避免累积抖动）。
            const pct = clampNotesWidthPct(
              startPct + ((latestX - startX) / w) * 100,
            );
            panel.style.flex = `0 0 ${pct}%`;
            panel.style.width = `${pct}%`;
            handle.setAttribute("aria-valuenow", String(Math.round(pct)));
            pctRef.current = pct;
          };
          const move = (ev: MouseEvent) => {
            latestX = ev.clientX;
            if (!raf) raf = requestAnimationFrame(apply);
          };
          const up = () => {
            window.removeEventListener("mousemove", move);
            window.removeEventListener("mouseup", up);
            if (raf) {
              cancelAnimationFrame(raf);
              raf = 0;
              apply();
            }
            // 落点提交一次：触发单次渲染 + 持久化。
            setWidthPct(pctRef.current);
          };
          window.addEventListener("mousemove", move);
          window.addEventListener("mouseup", up);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft") {
            e.preventDefault();
            setWidthPct((v) => clampNotesWidthPct(v - 1));
          } else if (e.key === "ArrowRight") {
            e.preventDefault();
            setWidthPct((v) => clampNotesWidthPct(v + 1));
          }
        }}
      >
        <span className="notes-resizer-grip" aria-hidden="true" />
      </div>
    </aside>
  );
}

import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { api } from "../api";
import type { Note } from "../types";

type NoteLabel = Note["label"];

const LABELS: { value: NoteLabel; label: string; color: string }[] = [
  { value: "low", label: "低", color: "#9a9aa0" },
  { value: "medium", label: "中", color: "#0a6cff" },
  { value: "high", label: "高", color: "#f59e0b" },
  { value: "urgent", label: "紧急", color: "#e11d48" },
];

function labelOf(value: NoteLabel) {
  return LABELS.find((l) => l.value === value) ?? LABELS[0];
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

/* ---------- 时间格式化 ---------- */

function relTime(ts: number): string {
  if (!ts) return "-";
  const diff = Math.floor(Date.now() / 1000) - ts;
  if (diff < 60) return "刚刚";
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  if (diff < 7 * 86400) return `${Math.floor(diff / 86400)} 天前`;
  const d = new Date(ts * 1000);
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
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
  return (
    <div className={`label-picker ${size === "sm" ? "sm" : ""}`} role="group">
      {LABELS.map((l) => (
        <button
          key={l.value}
          type="button"
          className={`label-chip${l.value === value ? " active" : ""}`}
          style={{ "--chip": l.color } as CSSProperties}
          onClick={() => onChange(l.value)}
          title={`标记为「${l.label}」`}
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
  // 收起后列表内容完全不渲染（避免旁人看到），状态记在本地，重启后保持。
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem(COLLAPSED_KEY) === "1",
  );

  const draftRef = useAutoSize(draft);
  const editRef = useAutoSize(editDraft);

  useEffect(() => {
    localStorage.setItem(COLLAPSED_KEY, collapsed ? "1" : "0");
  }, [collapsed]);

  const loadNotes = useCallback(async () => {
    setLoading(true);
    try {
      setNotes(await api.listNotes());
      setError(null);
    } catch (e) {
      console.error("加载记事失败:", e);
      setError(`加载记事失败：${errText(e)}`);
    } finally {
      setLoading(false);
    }
  }, []);

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
      setError(`添加失败：${errText(e)}`);
    } finally {
      setAdding(false);
    }
  }, [draft, draftLabel, loadNotes]);

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
      setError(`保存失败：${errText(e)}`);
    } finally {
      setSaving(false);
    }
  }, [editingId, editDraft, loadNotes]);

  const handleDelete = useCallback(
    async (id: number) => {
      setConfirmId(null);
      try {
        await api.deleteNote(id);
        setError(null);
        await loadNotes();
      } catch (e) {
        console.error("删除记事失败:", e);
        setError(`删除失败：${errText(e)}`);
      }
    },
    [loadNotes],
  );

  const handleLabelChange = useCallback(
    async (id: number, label: NoteLabel) => {
      try {
        await api.updateNoteLabel(id, label);
        setError(null);
        await loadNotes();
      } catch (e) {
        console.error("更新标签失败:", e);
        setError(`更新标签失败：${errText(e)}`);
      }
    },
    [loadNotes],
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
        setNotice("当前没有记事可导出");
      } else {
        setNotice(`已导出 ${res.count} 条记事 → ${res.path}`);
      }
    } catch (e) {
      console.error("导出记事失败:", e);
      setError(`导出失败：${errText(e)}`);
    } finally {
      setBusy(null);
    }
  }, [busy]);

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
          throw new Error("文件中没有可导入的记事");
        }
        // 校验格式：至少第一条含 content 字段
        if (!parsed.notes.some((n) => typeof n.content === "string")) {
          throw new Error("无法识别的格式：应为 notes-backup 导出文件");
        }
        // 前端读文件内容传给后端解析（Tauri 2 不暴露 file.path），后端按 content 去重
        const res = await api.importNotes(text);
        setNotice(
          `导入完成：新增 ${res.imported} 条，跳过重复 ${res.skipped} 条`,
        );
        await loadNotes();
      } catch (e) {
        console.error("导入记事失败:", e);
        setError(`导入失败：${errText(e)}`);
      } finally {
        setBusy(null);
        if (fileInputRef.current) fileInputRef.current.value = "";
      }
    },
    [busy, loadNotes],
  );

  // 收起态：只留一条竖向导轨，列表内容完全不渲染。
  if (collapsed) {
    return (
      <aside className="notes-panel collapsed">
        <button
          type="button"
          className="notes-rail"
          onClick={() => setCollapsed(false)}
          title="展开记事本"
        >
          <Icon d={ICON.expand} size={14} />
          <span className="notes-rail-text">记事本</span>
          {notes.length > 0 && (
            <span className="notes-rail-count">{notes.length}</span>
          )}
        </button>
      </aside>
    );
  }

  return (
    <aside className="notes-panel">
      <header className="notes-head">
        <span className="notes-head-icon">
          <Icon d={ICON.notebook} size={15} />
        </span>
        <span className="notes-title">记事本</span>
        <span className="notes-count">{notes.length}</span>
        <div className="notes-tools">
          <button
            type="button"
            className="note-tool"
            title="导出全部记事为 JSON 备份"
            onClick={() => void handleExport()}
            disabled={busy !== null}
          >
            <Icon d={ICON.download} size={13} />
          </button>
          <button
            type="button"
            className="note-tool"
            title="从 JSON 备份导入记事（按内容去重）"
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
            title="收起记事本（内容不再显示）"
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
              title="关闭"
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
              title="关闭"
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
            placeholder="记点什么…（⌘/Ctrl + Enter 添加）"
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
              {adding ? "添加中…" : "添加"}
            </button>
          </div>
        </div>

        {/* 列表 */}
        <div className="notes-list">
          {loading ? (
            <div className="notes-placeholder">加载中…</div>
          ) : notes.length === 0 ? (
            <div className="notes-empty">
              <span className="notes-empty-icon">
                <Icon d={ICON.notebook} size={22} />
              </span>
              <p>还没有记事</p>
              <span>在上面输入框随手记一条</span>
            </div>
          ) : (
            notes.map((note) => {
              const opt = labelOf(note.label);
              const accent = { "--note-accent": opt.color } as CSSProperties;

              if (confirmId === note.id) {
                return (
                  <article key={note.id} className="note-card confirming" style={accent}>
                    <p className="note-confirm-text">删除这条记事？</p>
                    <div className="note-confirm-actions">
                      <button
                        type="button"
                        className="btn small danger"
                        onClick={() => void handleDelete(note.id)}
                      >
                        删除
                      </button>
                      <button
                        type="button"
                        className="btn small ghost"
                        onClick={() => setConfirmId(null)}
                      >
                        取消
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
                      <span className="note-hint">⌘/Ctrl + Enter 保存 · Esc 取消</span>
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
                          取消
                        </button>
                        <button
                          type="button"
                          className="btn small primary"
                          onClick={() => void handleSave()}
                          disabled={saving || !editDraft.trim()}
                        >
                          {saving ? "保存中…" : "保存"}
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
                      title="点击切换标签"
                      onClick={() => {
                        const idx = LABELS.findIndex((l) => l.value === note.label);
                        const next = LABELS[(idx + 1) % LABELS.length];
                        void handleLabelChange(note.id, next.value);
                      }}
                    >
                      <span className="note-dot" />
                      {opt.label}
                    </button>
                    <time className="note-time" title={fullTime(note.createdAt)}>
                      {relTime(note.createdAt)}
                      {note.updatedAt > note.createdAt && " · 已编辑"}
                    </time>
                    <div className="note-tools">
                      <button
                        type="button"
                        className="note-tool"
                        title="编辑"
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
                        title="删除"
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
    </aside>
  );
}

import { useState } from "react";
import { api, openExternal } from "../api";
import { COLUMNS, type StatusKey, type Task } from "../types";
import { fmtTime, useI18n } from "../i18n";

// 主流 coding agent 列表：供「中断会话」记录时标注来源。可按需增删。
// value 为规范化 slug（与 MCP/agent 自报名一致，便于存储与展示统一），
// label 为下拉里展示的名称。存储只认 value。
const AGENTS: { value: string; label: string }[] = [
  { value: "amazon-q", label: "Amazon Q" },
  { value: "augment", label: "Augment Code" },
  { value: "bolt", label: "Bolt.new" },
  { value: "chatgpt", label: "ChatGPT" },
  { value: "claude-code", label: "Claude Code" },
  { value: "cline", label: "Cline" },
  { value: "codebuddy", label: "CodeBuddy" },
  { value: "codeium", label: "Codeium" },
  { value: "codex", label: "Codex (OpenAI)" },
  { value: "codestral", label: "Codestral" },
  { value: "cody", label: "Sourcegraph Cody" },
  { value: "continue", label: "Continue" },
  { value: "copilot", label: "GitHub Copilot" },
  { value: "cursor", label: "Cursor" },
  { value: "deepseek", label: "DeepSeek" },
  { value: "devin", label: "Devin" },
  { value: "doubao", label: "豆包 (Doubao)" },
  { value: "factory", label: "Factory Droid" },
  { value: "gemini-cli", label: "Gemini CLI" },
  { value: "glm", label: "智谱 GLM" },
  { value: "goose", label: "Goose" },
  { value: "grok", label: "Grok (xAI)" },
  { value: "helix", label: "Helix CLI" },
  { value: "kimi", label: "Kimi" },
  { value: "llama", label: "Llama (Meta)" },
  { value: "opencode", label: "OpenCode" },
  { value: "openhands", label: "OpenHands" },
  { value: "phind", label: "Phind" },
  { value: "qwen-code", label: "Qwen Code" },
  { value: "replit", label: "Replit Agent" },
  { value: "roo-code", label: "Roo Code" },
  { value: "tabnine", label: "Tabnine" },
  { value: "tongyi", label: "通义灵码" },
  { value: "trae", label: "Trae" },
  { value: "v0", label: "Vercel v0" },
  { value: "windsurf", label: "Windsurf" },
  { value: "workbuddy", label: "WorkBuddy" },
  { value: "zcode", label: "ZCode" },
  { value: "aider", label: "Aider" },
];

interface Props {
  task: Task;
  onClose: () => void;
  onChanged: () => void;
}

export default function DetailPanel({ task, onClose, onChanged }: Props) {
  const { t, lang } = useI18n();
  const [busy, setBusy] = useState(false);
  const [sessionInput, setSessionInput] = useState(task.sessionId ?? "");
  const [agent, setAgent] = useState(task.sessionAgent ?? "claude-code");
  const [err, setErr] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [handoff, setHandoff] = useState(task.handoff ?? "");

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      onChanged();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  const copyToClipboard = async (text: string, key: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(null), 1500);
    } catch (e) {
      // 权限不足或非安全上下文时 writeText 会 reject：原先无 catch，
      // 既产生未处理拒绝，又让「已复制」态卡住不给任何反馈。
      setErr(String(e));
      setCopiedKey(null);
    }
  };

  return (
    <aside className="detail">
      <div className="detail-head">
        <div>
          <span className="repo">{task.repo}</span>
          <span className="num">#{task.number}</span>
        </div>
        <button className="btn ghost" onClick={onClose}>
          {t("btn.close")}
        </button>
      </div>

      <h2 className="detail-title">{task.title}</h2>

      <div className="tags">
        <span className={`own own-${task.ownership}`}>
          {t(`ownership.${task.ownership}`)}
        </span>
        {task.candidateDone && <span className="candidate-tag">{t("detail.closedPending")}</span>}
        <span className="muted small">{t("detail.updatedAt", { time: fmtTime(task.updatedAt, lang) })}</span>
      </div>

      <section className="detail-block">
        <div className="block-title">{t("detail.statusTitle")}</div>
        <div className="seg">
          {COLUMNS.map((c) => (
            <button
              key={c.key}
              className={`seg-btn${task.status === c.key ? " on" : ""}`}
              disabled={busy}
              onClick={() => run(() => api.updateStatus(task.key, c.key as StatusKey))}
            >
              {t(`status.${c.key}`)}
            </button>
          ))}
        </div>
      </section>

      <section className="detail-block">
        <div className="block-title">{t("detail.sessionTitle")}</div>
        <div className="row">
          <input
            className="input"
            placeholder="session id"
            value={sessionInput}
            onChange={(e) => setSessionInput(e.target.value)}
          />
          <select className="select" value={agent} onChange={(e) => setAgent(e.target.value)}>
            {AGENTS.map((a) => (
              <option key={a.value} value={a.value}>
                {a.label}
              </option>
            ))}
          </select>
        </div>
        <div className="row">
          <button
            className="btn"
            disabled={busy || !sessionInput.trim()}
            onClick={() =>
              run(() => api.recordSession(task.key, sessionInput.trim(), agent))
            }
          >
            {t("btn.record")}
          </button>
          <button
            className="btn"
            disabled={busy || !task.sessionId}
            onClick={() => run(() => api.clearSession(task.key))}
          >
            {t("btn.clear")}
          </button>
          <button
            className="btn"
            disabled={!task.sessionId}
            onClick={() => task.sessionId && copyToClipboard(task.sessionId, "session")}
          >
            {copiedKey === "session" ? t("btn.copied") : t("btn.copy")}
          </button>
        </div>
        {task.sessionId && (
          <div className="muted small">
            {t("detail.recordedAt", {
              agent: task.sessionAgent || t("detail.unlabeled"),
              time: fmtTime(task.sessionAt ?? 0, lang),
            })}
          </div>
        )}
      </section>

      <section className="detail-block">
        <div className="block-title">{t("detail.handoffTitle")}</div>
        <textarea
          className="input wide"
          rows={3}
          placeholder={t("detail.handoffPlaceholder")}
          value={handoff}
          onChange={(e) => setHandoff(e.target.value)}
        />
        <div className="row">
          <button
            className="btn"
            disabled={busy || !handoff.trim()}
            onClick={() => run(() => api.recordHandoff(task.key, handoff.trim()))}
          >
            {t("btn.save")}
          </button>
          {task.handoff && handoff.trim() !== task.handoff && (
            <button className="btn ghost" onClick={() => setHandoff(task.handoff ?? "")}>
              {t("btn.revert")}
            </button>
          )}
        </div>
        {task.handoff && (
          <div className="muted small top-gap">
            {t("detail.handoffSaved", { n: task.handoff.length })}
          </div>
        )}
      </section>

      <section className="detail-block">
        <div className="block-title">GitHub</div>
        <div className="row">
          <button className="btn" onClick={() => openExternal(task.url)}>
            {t("detail.openInBrowser")}
          </button>
          <button
            className="btn ghost"
            onClick={() => copyToClipboard(task.url, "url")}
          >
            {copiedKey === "url" ? t("btn.copied") : t("btn.copy")}
          </button>
          {task.prNumber > 0 && task.prUrl && (
            <>
              <button className="btn" onClick={() => openExternal(task.prUrl)}>
                PR #{task.prNumber}
              </button>
              <button
                className="btn ghost"
                onClick={() => copyToClipboard(task.prUrl, "pr")}
              >
                {copiedKey === "pr" ? t("btn.copied") : t("btn.copy")}
              </button>
            </>
          )}
          {task.latestCommentUrl && (
            <button className="btn" onClick={() => openExternal(task.latestCommentUrl)}>
              {t("detail.latestComment")}
            </button>
          )}
        </div>
        <div className="muted small top-gap">
          {task.assignees
            ? t("detail.assignees", {
                list: task.assignees
                  .split(",")
                  .filter(Boolean)
                  .map((a) => `@${a}`)
                  .join(" "),
              })
            : t("ownership.notassignee")}
          {task.mentioned && ` · ${t("detail.mentionedSuffix")}`}
        </div>
        {task.branch && (
          <div className="branch-line top-gap">
            <span>{t("detail.branch", { branch: task.branch })}</span>
            <button
              className="btn ghost small inline"
              onClick={() => copyToClipboard(task.branch, "branch")}
            >
              {copiedKey === "branch" ? t("btn.copied") : t("btn.copy")}
            </button>
          </div>
        )}
        <div className="muted small top-gap">{t("detail.localOnly")}</div>
      </section>

      {err && <div className="banner error">{err}</div>}
    </aside>
  );
}

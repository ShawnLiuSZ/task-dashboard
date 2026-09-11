import { useEffect, useMemo, useRef, useState } from "react";
import { api, openExternal } from "../api";
import { AGENTS, agentLabel } from "../agents";
import { COLUMNS, type ProjectStatus, type StatusKey, type Task } from "../types";
import { fmtTime, useI18n } from "../i18n";

interface Props {
  task: Task;
  onClose: () => void;
  onChanged: () => void;
  /** #196：项目 Status 选项（用于 GitHub 状态行的选项与排序；缺省时只展示当前值）。 */
  projectStatuses?: ProjectStatus[];
}

export default function DetailPanel({ task, onClose, onChanged, projectStatuses }: Props) {
  const { t, lang } = useI18n();
  const [busy, setBusy] = useState(false);
  const [sessionInput, setSessionInput] = useState(task.sessionId ?? "");
  const [agent, setAgent] = useState(task.sessionAgent ?? "claude-code");
  const [err, setErr] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [handoff, setHandoff] = useState(task.handoff ?? "");
  // 「已复制」提示的复位定时器：组件的卸载（切换任务、关闭面板）时需清理，
  // 避免定时器在其后触发 setCopiedKey（在已卸载组件上 setState）。
  const copiedTimer = useRef<number | null>(null);
  useEffect(() => {
    return () => {
      if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
    };
  }, []);

  // #196：当前 GitHub 状态键（与 Board.groupByProjectStatus 同规则）：
  // closed→done，有原文取原文，空→unclassified。详情状态区永远以此为准，
  // 不跟随 custom 列展示方式。
  const currentProjectStatus =
    task.issueState === "closed" ? "done" : task.projectStatus?.trim() || "unclassified";
  // 选项 = projectStatuses 名称；当前值不在其中时前置，保证永远可见且默认选中。
  const projectStatusOptions = useMemo(() => {
    const names = (projectStatuses ?? []).map((ps) => ps.name);
    if (!names.includes(currentProjectStatus)) return [currentProjectStatus, ...names];
    return names;
  }, [projectStatuses, currentProjectStatus]);
  const projectStatusLabel = (name: string) =>
    name === "done" ? t("status.done") : name === "unclassified" ? t("detail.unlabeled") : name;

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
      // 复用 ref 管理复位定时器：连点前先清旧定时器，避免多个定时器叠加提前复位。
      if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
      copiedTimer.current = window.setTimeout(() => {
        setCopiedKey(null);
        copiedTimer.current = null;
      }, 1500);
    } catch (e) {
      // 权限不足或非安全上下文时 writeText 会 reject：原先无 catch，
      // 既产生未处理拒绝，又让「已复制」态卡住不给任何反馈。
      setErr(String(e));
      setCopiedKey(null);
    }
  };

  return (
    <aside
      className="detail"
      role="dialog"
      aria-modal="true"
      aria-label={`${task.repo}#${task.number}`}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
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
        {/* #196：GitHub 状态行（同步只读镜像）：展示 projectStatuses 选项，
            当前 project.status 默认选中；四态按钮保留为手动覆盖入口。 */}
        <div className="muted small">{t("detail.projectStatus")}</div>
        <div className="seg">
          {projectStatusOptions.map((name) => (
            <button
              key={name}
              className={`seg-btn${name === currentProjectStatus ? " on" : ""}`}
              disabled
              title={projectStatusLabel(name)}
            >
              {projectStatusLabel(name)}
            </button>
          ))}
        </div>
        <div className="seg">
          {COLUMNS.map((c) => (
            <button
              key={c.key}
              className={`seg-btn${task.status === c.key ? " on" : ""}`}
              disabled={busy}
              onClick={() => run(() => api.updateStatus(task.issueKey, c.key as StatusKey))}
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
                {agentLabel(a.value, t)}
              </option>
            ))}
          </select>
        </div>
        <div className="row">
          <button
            className="btn"
            disabled={busy || !sessionInput.trim()}
            onClick={() =>
              run(() => api.recordSession(task.issueKey, sessionInput.trim(), agent))
            }
          >
            {t("btn.record")}
          </button>
          <button
            className="btn"
            disabled={busy || !task.sessionId}
            onClick={() => run(() => api.clearSession(task.issueKey))}
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
              agent: task.sessionAgent
                ? agentLabel(task.sessionAgent, t)
                : t("detail.unlabeled"),
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
            onClick={() => run(() => api.recordHandoff(task.issueKey, handoff.trim()))}
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

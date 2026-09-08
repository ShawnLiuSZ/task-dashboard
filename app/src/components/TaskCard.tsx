import type { MouseEvent } from "react";
import type { Task } from "../types";
import { openExternal } from "../api";
import { useT } from "../i18n";

interface Props {
  task: Task;
  active: boolean;
  onClick: () => void;
  /** v0.3.16+：账号标签（来自 accounts.label）。undefined/空时不显示徽章。 */
  accountLabel?: string;
  /** v0.3.22+：仓库颜色索引（0-19），用于仓库名标签配色。 */
  repoIndex?: number;
  /** v0.3.43+：自定义列视图下，卡片右上角显示 project.status（gh_status）徽章。 */
  showGhStatus?: boolean;
}

// 稳定哈希 gh_status → 0-19，复用 repo-N 色系，同状态保持一致颜色。
function ghStatusColor(s: string): number {
  let h = 7;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 997;
  return h % 20;
}

// 在浏览器中打开外链：阻止 webview 自身跳转，改用本机默认浏览器打开（失败经 reportError 可见）。
function openLink(url: string, e: MouseEvent) {
  e.preventDefault();
  e.stopPropagation();
  openExternal(url);
}

export default function TaskCard({ task, accountLabel, active, onClick, repoIndex, showGhStatus }: Props) {
  const t = useT();
  const mine = task.ownership === "assigned";
  const assigneeNames = task.assignees
    ? task.assignees.split(",").filter(Boolean)
    : [];

  return (
    <article
      className={`card${active ? " active" : ""}${
        task.candidateDone ? " candidate" : ""
      }${task.ownership === "notassignee" ? " unassigned" : ""}${mine ? " mine" : ""}`}
      onClick={onClick}
    >
      {/* v0.3.17+：账号徽章独占卡片最顶行（repo#编号 行的上一行）。 */}
      {accountLabel && (
        <div className="account-row-top">
          <span className="account-badge" title={t("card.accountTitle", { label: accountLabel ?? "" })}>
            @{accountLabel}
          </span>
        </div>
      )}

      <div className="card-top">
        <span
          className={`repo repo-${((repoIndex ?? 0) % 20)}`}
        >
          {task.repo}
        </span>
        <span className="num">#{task.number}</span>
        {mine && (
          <span className="mine-badge" title={t("ownership.assigned")}>
            ★
          </span>
        )}
{/* GitHub Issue 状态：仅 closed 显示 */}
        {task.ghState === "closed" && (
          <span className="gh-state gh-state-closed" title={t("card.ghState.closed")}>
            {t("card.ghState.closed")}
          </span>
        )}
        {/* v0.3.43+：自定义列视图下显示 project.status 真实值徽章 */}
        {showGhStatus && task.ghStatus && task.ghStatus.trim() !== "" && (
          <span
            className={`gh-status repo repo-${ghStatusColor(task.ghStatus)}`}
            title={t("card.ghStatusTitle")}
          >
            {task.ghStatus}
          </span>
        )}
      </div>

      <p className="card-title">{task.title}</p>

      {/* 时间上方一行：分配人 / @我 / 无人认领；分支不再展示在卡片（仅在详情中显示）。 */}
      <div className="meta-row">
        {assigneeNames.length > 0 && (
          <span className="assignee-info">
            <span className="assignee-label">{t("card.assigneeLabel")}</span>
            <span className="assignee-names">
              {assigneeNames.map((a) => (
                <span key={a} className="assignee-name">
                  @{a}
                </span>
              ))}
            </span>
          </span>
        )}
        {task.mentioned && (
          <span className="mention-badge" title={t("card.mentionedTitle")}>
            {t("card.mentionedBadge")}
          </span>
        )}
        {/* 仅未认领的任务在此行显示"无人认领"标识。 */}
        {task.ownership === "notassignee" && (
          <span className="unassigned-tag" title={t("card.unassignedTitle")}>
            {t("ownership.notassignee")}
          </span>
        )}
      </div>

      <div className="card-bottom">
        {task.sessionId ? (
          <span className="session">
            <span className="session-label">{t("card.sessionLabel")}</span>
            <code>{task.sessionId}</code>
          </span>
        ) : (
          <span className="muted small">
            {task.updatedAt ? task.updatedAt.slice(0, 10) : ""}
          </span>
        )}
        {task.latestCommentUrl && (
          <a
            className="cmt-link"
            title={t("card.commentTitle")}
            href={task.latestCommentUrl}
            onClick={(e) => openLink(task.latestCommentUrl, e)}
          >
            {t("card.newComments")}
          </a>
        )}
        {task.prNumber > 0 && task.prUrl && (
          <a
            className="pr-link"
            title={t("card.prTitle")}
            href={task.prUrl}
            onClick={(e) => openLink(task.prUrl, e)}
          >
            🔗 PR #{task.prNumber}
          </a>
        )}
        {task.candidateDone && <span className="candidate-tag">{t("card.candidateTag")}</span>}
      </div>
    </article>
  );
}

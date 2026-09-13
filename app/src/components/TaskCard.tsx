import { memo, useState, type MouseEvent } from "react";
import type { Task } from "../types";
import { api, openExternal, reportError } from "../api";
import { useT } from "../i18n";
import ConfirmDialog from "./ConfirmDialog";

interface Props {
  task: Task;
  active: boolean;
  /** v0.3.49 (#145)：稳定回调（父组件直接传 setState 类稳定引用），卡片内再绑定 key，
      配合 memo 避免每轮重渲染。 */
  onSelectKey: (key: string) => void;
  /** v0.3.22+：仓库颜色索引（0-19），用于仓库名标签配色。 */
  repoIndex?: number;
  /** v0.3.43+：自定义列视图下，卡片右上角显示 project.status（gh_status）徽章。 */
  showGhStatus?: boolean;
}

// 稳定哈希 gh_status → 0-19，复用 repo-N 色系，同状态保持一致颜色。
function projectStatusColor(s: string): number {
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

// v0.3.49 (#145+#150)：memo 包裹（props 全为稳定引用/原始值时跳过重渲染）
// + 键盘可达（role=button/tabIndex/Enter-Space）+ 可访问名称。
function TaskCard({ task, active, onSelectKey, repoIndex, showGhStatus }: Props) {
  const t = useT();
  const mine = task.ownership === "assigned";
  const assigneeNames = task.assignees
    ? task.assignees.split(",").filter(Boolean)
    : [];
  /** #237：issue 创建人；空 / 纯空白一律不渲染该行（老数据同步前不留空标签行）。
      用 `|| ""` 兜底：该字段是与前端同批发布的新列，防旧后端返回缺字段时整板崩掉。 */
  const creator = (task.author || "").trim();
  // #214：认领确认框与防重提交（成功靠后端 TASKS_CHANGED_EVENT 触发 App 重查）。
  const [confirmClaim, setConfirmClaim] = useState(false);
  const [claiming, setClaiming] = useState(false);

  return (
    <article
      className={`card${active ? " active" : ""}${
        task.candidateDone ? " candidate" : ""
      }${task.ownership === "notassignee" ? " unassigned" : ""}${mine ? " mine" : ""}`}
      onClick={() => onSelectKey(task.issueKey)}
      role="button"
      tabIndex={0}
      aria-pressed={active}
      aria-label={`${task.repo}#${task.number} ${task.title}`}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelectKey(task.issueKey);
        }
      }}
    >
      {/* #237：移除原「归属账号」徽章行（单账号视图下每张卡片都一样，无信息量）。 */}

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
        {task.issueState === "closed" && (
          <span className="gh-state gh-state-closed" title={t("card.ghState.closed")}>
            {t("card.ghState.closed")}
          </span>
        )}
        {/* v0.3.43+：自定义列视图下显示 project.status 真实值徽章 */}
        {showGhStatus && task.projectStatus && task.projectStatus.trim() !== "" && (
          <span
            className={`gh-status repo repo-${projectStatusColor(task.projectStatus)}`}
            title={t("card.ghStatusTitle")}
          >
            {task.projectStatus}
          </span>
        )}
      </div>

      <p className="card-title">{task.title}</p>

      {/* #237：创建人（issue author），位于「分配人」上一行。
          未知时整行不渲染——老数据未同步前不应出现空标签行。 */}
      {creator !== "" && (
        <div className="meta-row creator-row">
          <span className="assignee-info">
            <span className="assignee-label">{t("card.creatorLabel")}</span>
            <span className="assignee-names">
              <span className="assignee-name">@{creator}</span>
            </span>
          </span>
        </div>
      )}

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
        {/* #214：无人认领可点认领（确认框 → GitHub 写回）。 */}
        {task.ownership === "notassignee" && (
          <button
            type="button"
            className="unassigned-tag claim-btn"
            title={t("card.claimTitle")}
            disabled={claiming}
            onClick={(e) => {
              e.stopPropagation();
              setConfirmClaim(true);
            }}
          >
            {t("ownership.notassignee")}
          </button>
        )}
      </div>

      {/* #197：有 session 时在分配人下一行独立展示（不再挤占时间位置）。 */}
      {task.sessionId && (
        <div className="meta-row session-row">
          <span className="session" title={task.sessionId}>
            <span className="session-label">{t("card.sessionLabel")}</span>
            <code>{task.sessionId}</code>
          </span>
        </div>
      )}

      <div className="card-bottom">
        <span className="muted small">
          {task.updatedAt
            ? new Date(task.updatedAt * 1000).toISOString().slice(0, 10)
            : ""}
        </span>
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
      {/* #214：认领二次确认（失败经全局错误横幅可见；成功靠后端事件重查）。 */}
      {confirmClaim && (
        <div onClick={(e) => e.stopPropagation()}>
          <ConfirmDialog
            message={t("card.claimConfirm", { repo: task.repo, number: task.number })}
            onCancel={() => setConfirmClaim(false)}
            onConfirm={() => {
              setConfirmClaim(false);
              if (claiming) return;
              setClaiming(true);
              api
                .claimIssue(task.issueKey)
                .catch(reportError)
                .finally(() => setClaiming(false));
            }}
          />
        </div>
      )}
    </article>
  );
}

export default memo(TaskCard);
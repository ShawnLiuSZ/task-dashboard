import { useEffect, useMemo, useRef, useState } from 'react';
import { api, openExternal } from '../api';
import { AGENTS, agentLabel } from '../agents';
import { type ProjectStatus, type Task, type TaskComment } from '../types';
import { fmtTime, useI18n } from '../i18n';
import ConfirmDialog from './ConfirmDialog';
import TaskCommentsList from './TaskCommentsList';
import { registerEscLayer, type EscLayer } from '../utils/escLayer';

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
  const [sessionInput, setSessionInput] = useState(task.sessionId ?? '');
  const [agent, setAgent] = useState(task.sessionAgent ?? 'claude-code');
  const [err, setErr] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [handoff, setHandoff] = useState(task.handoff ?? '');
  // #472：评论链接（倒序：最新在前）。**按需拉取** —— 评论可达 100 条/issue，
  // 看板一次渲染几百张卡 ⇒ 不能随 `list_tasks` 一起返回（IPC 载荷会被撑爆）。
  const [comments, setComments] = useState<TaskComment[]>([]);
  const [commentsLoading, setCommentsLoading] = useState(false);
  // #215：待确认的目标 Project 状态（确认框 → set_project_status 写回）。
  const [pendingStatus, setPendingStatus] = useState<string | null>(null);
  // 「已复制」提示的复位定时器：组件的卸载（切换任务、关闭面板）时需清理，
  // 避免定时器在其后触发 setCopiedKey（在已卸载组件上 setState）。
  const copiedTimer = useRef<number | null>(null);
  // #329：本面板注册为 Esc 层。确认框（面板的子组件）后注册即为最上层，
  // 此时面板不再响应 Esc——否则「取消确认」会连带把整个详情面板关掉。
  const escLayer = useRef<EscLayer | null>(null);
  useEffect(() => {
    const layer = registerEscLayer();
    escLayer.current = layer;
    return () => {
      layer.release();
      escLayer.current = null;
      if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
    };
  }, []);

  // #472：按需拉取该 issue 的**全部**评论链接（后端已按倒序返回：最新在前）。
  //
  // ⚠️ 必须带 `task.accountId`：issue_key 是 `repo#number`（不含 owner），
  // 多账号下会重复 ⇒ 只按 issueKey 取会拿到**别的账号**的评论。
  //
  // ⚠️ 组件在切换任务时被 `key={taskIdentity(selectedTask)}` **重新挂载**，
  // 但同一 issueKey 在聚合视图下可能属于不同账号 ⇒ 依赖里带上 accountId。
  //
  // ⚠️ **依赖里必须带 `task.latestCommentUrl`**（#472 审查修复）：
  // 同步后 App 会重查任务列表 ⇒ `selectedTask` 变成新对象，但 `issueKey` /
  // `accountId` **不变** ⇒ 若依赖只有这两项，effect 不会重跑 ⇒ 评论列表停在
  // 打开那一刻（面板其它字段会刷新 ⇒ 只有评论这块陈旧，观感割裂）。
  // `latestCommentUrl` 恰好在「有新评论被成功拉到」时才变 ⇒ 精确触发重取，
  // 且没变化时**不产生多余的 IPC**。
  useEffect(() => {
    let cancelled = false;
    setCommentsLoading(true);
    api
      .listTaskComments(task.issueKey, task.accountId)
      .then((list) => {
        if (!cancelled) setComments(list);
      })
      .catch((e) => {
        // 读失败不打断详情面板（其余信息照常展示）⇒ 只清空列表。
        console.error('[taskboard] 读取评论链接失败:', e);
        if (!cancelled) setComments([]);
      })
      .finally(() => {
        if (!cancelled) setCommentsLoading(false);
      });
    return () => {
      // 卸载 / 换任务后到达的响应不得再 setState。
      cancelled = true;
    };
  }, [task.issueKey, task.accountId, task.latestCommentUrl]);

  // #196：当前 GitHub 状态键（与 Board.groupByProjectStatus 同规则）：
  // closed→done，有原文取原文，空→unclassified。详情状态区永远以此为准，
  // 不跟随 custom 列展示方式。
  const currentProjectStatus =
    task.issueState === 'closed' ? 'done' : task.projectStatus?.trim() || 'unclassified';
  /** #467：该 issue 关联的**全部** PR（含主 PR）。
   *
   * 后端已把「主 PR」也放进 `prs` 数组（含存量回退），故正常路径直接用 `task.prs`。
   * 回退：`prs` 为空但单值三字段有值时（老后端 / 手工构造的数据）退回单值 ⇒
   * PR 按钮不会因字段缺失而消失。
   *
   * ⚠️ 用「`prs` **非空**」而非「`prs` 字段存在」作判据：后者在 `prs: []`
   * 且 `prNumber > 0` 时会渲染出**空**的按钮组，把原本可见的 PR 入口弄丢。 */
  const prList =
    Array.isArray(task.prs) && task.prs.length > 0
      ? task.prs
      : task.prNumber > 0 && task.prUrl
        ? [{ number: task.prNumber, url: task.prUrl, state: task.prState || '' }]
        : [];
  // 选项 = projectStatuses 名称；当前值不在其中时前置，保证永远可见且默认选中。
  const projectStatusOptions = useMemo(() => {
    const names = (projectStatuses ?? []).map((ps) => ps.name);
    if (!names.includes(currentProjectStatus)) return [currentProjectStatus, ...names];
    return names;
  }, [projectStatuses, currentProjectStatus]);
  const projectStatusLabel = (name: string) =>
    name === 'done' ? t('status.done') : name === 'unclassified' ? t('detail.unlabeled') : name;

  // #278：关联 issue（父 / 子）。先落成 const 再判断——TS 只对 const 的收窄结果
  // 保留到闭包里，直接写 `task.parentIssue && ...` 会让 onClick 回调中的类型退化成
  // `IssueLink | null`（TS18047）。
  const parentIssue = task.parentIssue;
  const subIssues = task.subIssues;
  const parentKey = parentIssue ? `parent-${parentIssue.number}` : '';

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
        // #329：确认框叠在面板之上时不响应 Esc（见 escLayer 注册处说明）。
        if (e.key === 'Escape' && escLayer.current?.isTop()) onClose();
      }}
    >
      <div className="detail-head">
        <div>
          <span className="repo">{task.repo}</span>
          <span className="num">#{task.number}</span>
        </div>
        <button className="btn ghost" onClick={onClose}>
          {t('btn.close')}
        </button>
      </div>

      <h2 className="detail-title">{task.title}</h2>

      <div className="tags">
        <span className={`own own-${task.ownership}`}>{t(`ownership.${task.ownership}`)}</span>
        {task.candidateDone && <span className="candidate-tag">{t('detail.closedPending')}</span>}
        <span className="muted small">
          {t('detail.updatedAt', { time: fmtTime(task.updatedAt, lang) })}
        </span>
      </div>

      <section className="detail-block">
        <div className="block-title">{t('detail.statusTitle')}</div>
        {/* #215：GitHub 状态行可点（确认框 → 写回远端 Status）。
            #200 去掉了四态手动入口，此处是唯一的状态切换入口。 */}
        <div className="muted small">{t('detail.projectStatus')}</div>
        <div className="seg project-status-seg">
          {projectStatusOptions.map((name) => (
            <button
              key={name}
              className={`seg-btn${name === currentProjectStatus ? ' on' : ''}`}
              disabled={busy || name === currentProjectStatus}
              title={projectStatusLabel(name)}
              onClick={() => setPendingStatus(name)}
            >
              {projectStatusLabel(name)}
            </button>
          ))}
        </div>
      </section>
      {/* #215：状态写回二次确认（失败在详情内横幅展示；成功重查）。 */}
      {pendingStatus !== null && (
        <ConfirmDialog
          message={t('detail.projectStatusConfirm', { name: projectStatusLabel(pendingStatus) })}
          onCancel={() => setPendingStatus(null)}
          onConfirm={() => {
            const name = pendingStatus;
            setPendingStatus(null);
            void run(() => api.setProjectStatus(task.issueKey, name));
          }}
        />
      )}

      <section className="detail-block">
        <div className="block-title">{t('detail.sessionTitle')}</div>
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
            onClick={() => run(() => api.recordSession(task.issueKey, sessionInput.trim(), agent))}
          >
            {t('btn.record')}
          </button>
          <button
            className="btn"
            disabled={busy || !task.sessionId}
            onClick={() => run(() => api.clearSession(task.issueKey))}
          >
            {t('btn.clear')}
          </button>
          <button
            className="btn"
            disabled={!task.sessionId}
            onClick={() => task.sessionId && copyToClipboard(task.sessionId, 'session')}
          >
            {copiedKey === 'session' ? t('btn.copied') : t('btn.copy')}
          </button>
        </div>
        {task.sessionId && (
          <div className="muted small">
            {t('detail.recordedAt', {
              agent: task.sessionAgent ? agentLabel(task.sessionAgent, t) : t('detail.unlabeled'),
              time: fmtTime(task.sessionAt ?? 0, lang),
            })}
          </div>
        )}
      </section>

      <section className="detail-block">
        <div className="block-title">{t('detail.handoffTitle')}</div>
        <textarea
          className="input wide"
          rows={3}
          placeholder={t('detail.handoffPlaceholder')}
          value={handoff}
          onChange={(e) => setHandoff(e.target.value)}
        />
        <div className="row">
          <button
            className="btn"
            disabled={busy || !handoff.trim()}
            onClick={() => run(() => api.recordHandoff(task.issueKey, handoff.trim()))}
          >
            {t('btn.save')}
          </button>
          {task.handoff && handoff.trim() !== task.handoff && (
            <button className="btn ghost" onClick={() => setHandoff(task.handoff ?? '')}>
              {t('btn.revert')}
            </button>
          )}
        </div>
        {task.handoff && (
          <div className="muted small top-gap">
            {t('detail.handoffSaved', { n: task.handoff.length })}
          </div>
        )}
      </section>

      <section className="detail-block">
        <div className="block-title">GitHub</div>
        <div className="row">
          <button className="btn" onClick={() => openExternal(task.url)}>
            {t('detail.openInBrowser')}
          </button>
          <button className="btn ghost" onClick={() => copyToClipboard(task.url, 'url')}>
            {copiedKey === 'url' ? t('btn.copied') : t('btn.copy')}
          </button>
          {/* #467：同一 issue 可关联**多个** PR ⇒ 逐个渲染「打开 / 复制」按钮。
              `prs` 数组含主 PR（后端已做存量回退），无关联时为空数组。 */}
          {prList.map((pr) => (
            <span key={`${pr.number}-${pr.url}`} className="pr-btn-group">
              <button className="btn" onClick={() => openExternal(pr.url)}>
                PR #{pr.number}
              </button>
              <button
                className="btn ghost"
                onClick={() => copyToClipboard(pr.url, `pr-${pr.number}`)}
              >
                {copiedKey === `pr-${pr.number}` ? t('btn.copied') : t('btn.copy')}
              </button>
            </span>
          ))}
          {task.latestCommentUrl && (
            <button className="btn" onClick={() => openExternal(task.latestCommentUrl)}>
              {t('detail.latestComment')}
            </button>
          )}
        </div>
        <div className="muted small top-gap">
          {task.assignees
            ? t('detail.assignees', {
                list: task.assignees
                  .split(',')
                  .filter(Boolean)
                  .map((a) => `@${a}`)
                  .join(' '),
              })
            : t('ownership.notassignee')}
          {task.mentioned && ` · ${t('detail.mentionedSuffix')}`}
        </div>
        {task.branch && (
          <div className="branch-line top-gap">
            <span>{t('detail.branch', { branch: task.branch })}</span>
            <button
              className="btn ghost small inline"
              onClick={() => copyToClipboard(task.branch, 'branch')}
            >
              {copiedKey === 'branch' ? t('btn.copied') : t('btn.copy')}
            </button>
          </div>
        )}
        {/* #193：agent 工作分支（与 PR 分支不同时才展示，避免重复）。 */}
        {task.workBranch && task.workBranch !== task.branch && (
          <div className="branch-line top-gap">
            <span>{t('detail.workBranch', { branch: task.workBranch })}</span>
            <button
              className="btn ghost small inline"
              onClick={() => copyToClipboard(task.workBranch, 'workBranch')}
            >
              {copiedKey === 'workBranch' ? t('btn.copied') : t('btn.copy')}
            </button>
          </div>
        )}
        <div className="muted small top-gap">{t('detail.localOnly')}</div>
      </section>

      {/* #472：评论链接（**倒序：最新在前**）—— 按需拉取，不随看板列表返回。
          渲染拆到 `TaskCommentsList`（独立组件）⇒ 倒序语义有明确的断言落点
          （前端测试跑在 node 环境，`useEffect` 不会执行 ⇒ 放在本文件内部测不到）。
          ⚠️ 列表为空时**整节不渲染**（不显示空标题）—— 评论表在首次同步前是空的，
          此时上面的「最新评论」按钮仍可用（它走 `tasks.latest_comment_url` 单值列）。 */}
      <TaskCommentsList comments={comments} loading={commentsLoading} />

      {/* #278：关联 issue（父 / 子）—— 同步自 GitHub `parent` / `subIssues`（只读）。
          仅在确实有关联时渲染整节，避免每个详情都多一个空块；
          每项复用 openExternal + copyToClipboard，与上方 GitHub 行同一套交互。 */}
      {(parentIssue || subIssues.length > 0) && (
        <section className="detail-block">
          <div className="block-title">{t('detail.linksTitle')}</div>
          {parentIssue && (
            <div className="link-line">
              <span className="link-tag">{t('detail.parentIssue')}</span>
              <span className="link-ref">#{parentIssue.number}</span>
              {parentIssue.title && <span className="link-title">{parentIssue.title}</span>}
              <button
                className="btn ghost small inline"
                onClick={() => openExternal(parentIssue.url)}
              >
                {t('detail.openInBrowser')}
              </button>
              <button
                className="btn ghost small inline"
                onClick={() => copyToClipboard(parentIssue.url, parentKey)}
              >
                {copiedKey === parentKey ? t('btn.copied') : t('btn.copy')}
              </button>
            </div>
          )}
          {subIssues.length > 0 && (
            <div className="top-gap">
              <div className="muted small">{t('detail.subIssues', { n: subIssues.length })}</div>
              <ul className="link-list">
                {subIssues.map((sub) => {
                  const k = `sub-${sub.number}`;
                  return (
                    <li key={k} className="link-line">
                      <span className="link-ref">#{sub.number}</span>
                      {sub.title && <span className="link-title">{sub.title}</span>}
                      <button
                        className="btn ghost small inline"
                        onClick={() => openExternal(sub.url)}
                      >
                        {t('detail.openInBrowser')}
                      </button>
                      <button
                        className="btn ghost small inline"
                        onClick={() => copyToClipboard(sub.url, k)}
                      >
                        {copiedKey === k ? t('btn.copied') : t('btn.copy')}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </section>
      )}

      {err && <div className="banner error">{err}</div>}
    </aside>
  );
}

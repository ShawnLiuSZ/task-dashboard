import { useEffect, useMemo, useRef, useState } from 'react';
import { api, openExternal } from '../api';
import { AGENTS, agentLabel } from '../agents';
import {
  type ProjectStatus,
  type Task,
  type TaskComment,
  type LiveTaskDetail,
  type LiveTimelineItem,
} from '../types';
import { fmtTime, useI18n } from '../i18n';
import ConfirmDialog from './ConfirmDialog';
import TaskCommentsList from './TaskCommentsList';
import { registerEscLayer, type EscLayer } from '../utils/escLayer';
import { normalizeLiveDetail } from '../utils/liveDetail';
import { renderMarkdown, shouldCollapseBody } from '../utils/markdown';

/**
 * #506：已知的时间线事件类型（与 i18n 词条 `detail.ev.*` 一一对应）。
 *
 * ⚠️ 必须是**白名单**：GitHub 的 timeline 事件远不止这些（`renamed` /
 * `marked_as_duplicate` / `converted_to_draft` …），而 `t()` 对缺失 key
 * 会**返回 key 本身** ⇒ 直接拼 `detail.ev.<event>` 会把
 * `detail.ev.whatever` 显示在界面上。清单外的统一走 `detail.ev.generic`。
 *
 * ⚠️ 与 i18n 词条的一致性由 `detail-panel-head.test.tsx` 的用例锁定。
 */
const TIMELINE_EVENT_KEYS = new Set([
  'assigned',
  'unassigned',
  'labeled',
  'unlabeled',
  'closed',
  'reopened',
  'cross-referenced',
  'referenced',
  'sub_issue_added',
  'milestoned',
  'demilestoned',
  'locked',
  'unlocked',
  'review_requested',
  'added_to_project_v2',
  'removed_from_project_v2',
  'project_v2_item_status_changed',
]);

/**
 * #506（复查修复）：需要**目标数据**才能写出有意义文案的事件。
 *
 * 这些事件专用词条里带 `{who}` / `{what}` 占位（如「在 {what} 中被引用」）。
 * 但部分事件后端**暂无对应字段解析**（`milestoned` / `demilestoned` / `referenced`
 * 取不到目标 issue，`review_requested` 取不到被请求审查者）⇒ 渲染出来是悬空占位
 * （「在 中被引用」/「请求 <发起人> 审查」）。这类情况必须退回 `detail.ev.generic`，
 * 不能把残缺信息显示到界面上。
 *
 * ⚠️ 与 `TIMELINE_EVENT_KEYS` 不同：这里只挑「词条含占位符」的事件，
 * `closed` / `locked` / `added_to_project_v2` 等**固定文案**事件不需要目标，不在此列。
 */
const EVENTS_NEEDING_TARGET = new Set([
  'assigned',
  'unassigned',
  'labeled',
  'unlabeled',
  'cross-referenced',
  'referenced',
  'sub_issue_added',
  'milestoned',
  'demilestoned',
  'review_requested',
]);

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
  // #490：实时拉取结果（只读 GitHub、零落库）。打开详情即拉一次，覆盖本地库展示。
  // ⚠️ #496：存的是**规范化后**的形状（`utils/liveDetail.ts`）⇒ 渲染期不必再假定
  // `live.prCommits` / `live.issue` 一定存在；后端字段名漂移最坏是「少显示一段」，
  // 而不是抛 TypeError 把整棵 React 树打崩（那会让窗口全屏空白）。
  const [live, setLive] = useState<LiveTaskDetail | null>(null);
  const [liveLoading, setLiveLoading] = useState(false);
  const [liveError, setLiveError] = useState<string | null>(null);
  const [liveAt, setLiveAt] = useState(0);
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

  // #490：PR 编号用于拉取提交历史；优先主 PR 编号，否则回退 prs[0]。
  // 用 useMemo 稳定：仅当编号真正变化时才让下方 effect 重跑——
  // 同步后 `task.prs` 数组换新身份但编号不变 ⇒ 不触发重复实时拉取，
  // 符合「仅打开时自动拉取」的诉求。
  const livePrNumber = useMemo(() => {
    if (task.prNumber > 0) return task.prNumber;
    if (Array.isArray(task.prs) && task.prs.length > 0) return task.prs[0].number;
    return 0;
  }, [task.prNumber, task.prs]);

  // #490：打开详情即实时拉取 GitHub 详情 + 评论 + 关联 PR 提交历史（只读、零落库）。
  // 结果覆盖本地库展示（评论区 / 指派 / 标签 / PR 提交历史）；失败保留本地库数据。
  // 组件因 `key={taskIdentity}` 在切换任务时重挂载，故 deps 用 issueKey/accountId 即可；
  // PR 编号经 `livePrNumber` 稳定化（见上），编号真正变化时才重新拉提交历史。
  useEffect(() => {
    let cancelled = false;
    setLive(null);
    setLiveError(null);
    setLiveLoading(true);
    api
      .fetchTaskDetailLive(task.issueKey, task.accountId, livePrNumber)
      .then((d) => {
        if (!cancelled) {
          // #496：先规范化再 setState —— 保证进入渲染的形状一定安全。
          const normalized = normalizeLiveDetail(d);
          if (normalized) {
            setLive(normalized);
            setLiveAt(Date.now());
          } else {
            setLiveError('实时数据格式不可用，已回退到本地库数据');
          }
        }
      })
      .catch((e) => {
        if (!cancelled) setLiveError(String(e));
      })
      .finally(() => {
        if (!cancelled) setLiveLoading(false);
      });
    return () => {
      // 卸载 / 换任务后到达的响应不得再 setState。
      cancelled = true;
    };
  }, [task.issueKey, task.accountId, livePrNumber]);

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
  // #490：实时数据优先覆盖本地库展示（live 未加载时回退 DB 数据）。
  // ⚠️ #496：一律用「**数组非空判据**」而不是「字段存在」——
  //   后端结构体一旦漏写 `rename_all`（键变 snake_case）或换字段名，
  //   `live.prCommits` 会是 `undefined` ⇒ 裸取它的 `.length`
  //   会抛 TypeError ⇒ React 卸载整棵树 ⇒ 窗口全屏空白（#496 的实际故障）。
  const liveIssue = live?.issue;
  const liveComments = Array.isArray(live?.comments) ? live.comments : [];
  const liveAssignees = Array.isArray(liveIssue?.assignees) ? liveIssue.assignees : [];
  const liveLabels = Array.isArray(liveIssue?.labels) ? liveIssue.labels : [];
  const livePrCommits = Array.isArray(live?.prCommits) ? live.prCommits : [];
  // #506：Activity 时间线（评论 + 事件交织，对齐 orca 的 issue 详情）。
  // ⚠️ 必须 `useMemo` 稳定化：`liveTimeline` 若每次渲染都新建数组，
  // 下面 `timelineCommentHtml` 的 deps 就会每次都变 ⇒ memo 失效（且触发
  // `react-hooks/exhaustive-deps` 告警）。依赖 `live`（仅实时拉取返回时换新）。
  const liveTimeline = useMemo(() => (Array.isArray(live?.timeline) ? live.timeline : []), [live]);
  // #506（复查）：时间线评论正文**整体 memo** —— 否则在「交接任务」输入框每次按键触发整树
  // 重渲染时，最多 100 条评论的 markdown 会被无谓地全部重解析（`renderMarkdown` 输入仍是
  // 不可信的 GitHub 明文，安全性不受影响）。`idx` 与 `liveTimeline` 同序 ⇒ 渲染时直接按下标取。
  const timelineCommentHtml = useMemo(
    () => liveTimeline.map((it) => (it.kind === 'comment' ? renderMarkdown(it.body) : '')),
    [liveTimeline],
  );
  const shownComments = live ? liveComments : comments;

  // #506：时间线事件的**中文短语**。
  //
  // ⚠️ 只对**已知事件类型**用专用词条，其余一律走通用文案 ——
  // `t()` 对缺失 key 会返回 key 本身（还会打 warning）⇒ 绝不能让
  // `detail.ev.<未知事件>` 这种字符串出现在界面上。
  const timelineEventText = (item: LiveTimelineItem): string => {
    const target =
      item.event === 'assigned' || item.event === 'unassigned'
        ? item.assignee || item.actor
        : item.event === 'labeled' || item.event === 'unlabeled'
          ? item.label
          : item.event === 'cross-referenced' ||
              item.event === 'referenced' ||
              item.event === 'sub_issue_added'
            ? item.refIssue
            : '';
    // ⚠️ #506 复查：需要目标数据却取不到时，**退回通用文案**——否则 `t()` 会把
    // `{what}` 替换成空串（而不是保留占位符），旧守卫（判渲染结果里是否残留 `{`）
    // 永远为 false ⇒ 守卫从不触发 ⇒ 「在 中被引用」「请求 <发起人> 审查」这类残缺文案泄漏到界面。
    if (EVENTS_NEEDING_TARGET.has(item.event) && !target) {
      return t('detail.ev.generic', { who: item.actor, what: '' });
    }
    if (TIMELINE_EVENT_KEYS.has(item.event)) {
      return t(`detail.ev.${item.event}`, { who: target || item.actor, what: target });
    }
    return t('detail.ev.generic', { who: item.actor, what: target });
  };

  // #498：issue **正文**（body）——「具体的详细信息」就是它。
  // 后端实时拉取（#490）此前**只带标题**，正文从未被读取过。
  // markdown → 安全 HTML（零依赖，`utils/markdown.ts` 内部先转义再限白名单标签）。
  const liveBody = liveIssue?.body ?? '';
  const bodyHtml = useMemo(() => renderMarkdown(liveBody), [liveBody]);
  const bodyLong = shouldCollapseBody(liveBody);
  const [bodyExpanded, setBodyExpanded] = useState(false);
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
      {/* #500：「issue id 行」与「标题行」合并进**同一个 sticky 容器** ⇒ 两行都不参与滚动。
          此前标题是头部的兄弟节点（随内容滚走，滚动的中间态还会被头部盖掉上半部分）。 */}
      <div className="detail-head">
        <div className="detail-head-row">
          <div>
            <span className="repo">{task.repo}</span>
            <span className="num">#{task.number}</span>
          </div>
          <button className="btn ghost" onClick={onClose}>
            {t('btn.close')}
          </button>
        </div>

        <h2 className="detail-title">{task.title}</h2>
      </div>

      {/* #490：实时数据已加载时显示「实时」徽标 + 拉取时间；拉取中显示占位。 */}
      <div className="tags">
        {liveLoading && <span className="muted small">{t('detail.liveLoading')}</span>}
        {live && (
          <span className="live-badge" title={t('detail.liveBadge')}>
            {t('detail.liveBadge')}
            {liveAt > 0 && (
              <span className="muted small"> · {fmtTime(Math.floor(liveAt / 1000), lang)}</span>
            )}
          </span>
        )}
      </div>

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

      {/* #504：以下三块是**实时拉取**的内容（#490 / #498 的产出），统一聚在
          「交接任务」之后，形成一段连续的「远端实况」；原先它们分散在面板
          上下（描述在最上、评论在中、PR 提交历史在最末），读起来要来回跳。
          顺序：描述（正文）→ 评论链接 → 关联 PR 提交历史。 */}

      {/* #498：issue **正文**（描述）——用户要的「具体的详细信息」。
          实时数据未到达时不渲染整节（`live` 尚未加载 ⇒ 既没有正文、也没有「无正文」结论）。
          正文是 markdown 源文本 ⇒ 经 `utils/markdown.ts` 渲染成**安全** HTML
          （先 HTML 转义、只允许白名单标签、链接协议只放行 http/https）。
          #506 复查：无正文时显示「（无正文）」占位 ⇒ 启用此前死掉的 `detail.bodyEmpty` 词条。 */}
      {live && (
        <section className="detail-block">
          <div className="block-title">{t('detail.bodyTitle')}</div>
          {liveBody.trim() ? (
            <div
              className={`detail-body markdown${bodyLong && !bodyExpanded ? ' collapsed' : ''}`}
              // ⚠️ 安全：`renderMarkdown` 的返回值已转义并限白名单标签（见 utils/markdown.ts）。
              dangerouslySetInnerHTML={{ __html: bodyHtml }}
            />
          ) : (
            <div className="muted small">{t('detail.bodyEmpty')}</div>
          )}
          {liveBody.trim() && bodyLong && (
            <button className="btn ghost small" onClick={() => setBodyExpanded((v) => !v)}>
              {bodyExpanded ? t('detail.bodyCollapse') : t('detail.bodyExpand')}
            </button>
          )}
        </section>
      )}

      {/* #506：**Activity 时间线**（评论 + 事件交织）—— 对齐 orca 的 issue 详情。
          一次 Timeline API 请求同时拿到评论（带正文）与时间线事件
          （指派 / 标签 / 状态变更 / 交叉引用 / 项目列移动 …）。
          评论正文走 `utils/markdown.ts` 渲染（零依赖 + 安全白名单）。 */}
      {liveTimeline.length > 0 && (
        <section className="detail-block">
          <div className="block-title">{t('detail.timelineTitle')}</div>
          <ul className="timeline-list">
            {liveTimeline.map((item, idx) => (
              <li key={`${item.event}-${item.createdAt}-${idx}`} className="timeline-item">
                <div className="timeline-meta">
                  <span className="timeline-actor">
                    {item.actor || t('detail.timelineUnknown')}
                  </span>
                  {item.createdAt > 0 && (
                    <span className="muted small">{fmtTime(item.createdAt, lang)}</span>
                  )}
                </div>
                {item.kind === 'comment' ? (
                  <div
                    className="timeline-body markdown"
                    // ⚠️ 安全：`timelineCommentHtml` 已用 `renderMarkdown` 预先渲染
                    // （先转义、只允许白名单标签、链接协议只放行 http/https）。
                    dangerouslySetInnerHTML={{ __html: timelineCommentHtml[idx] }}
                  />
                ) : (
                  <div className="muted small timeline-event">{timelineEventText(item)}</div>
                )}
                {item.url && (
                  <button className="btn ghost small inline" onClick={() => openExternal(item.url)}>
                    {t('detail.openInBrowser')}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* #472：评论链接（**倒序：最新在前**）—— 按需拉取，不随看板列表返回。
          渲染拆到 `TaskCommentsList`（独立组件）⇒ 倒序语义有明确的断言落点
          （前端测试跑在 node 环境，`useEffect` 不会执行 ⇒ 放在本文件内部测不到）。
          ⚠️ 列表为空时**整节不渲染**（不显示空标题）—— 评论表在首次同步前是空的，
          此时上面的「最新评论」按钮仍可用（它走 `tasks.latest_comment_url` 单值列）。 */}
      {/* #490：评论区优先展示实时拉取的评论（覆盖本地库）；未加载时回退 DB 评论。
          加载态叠加 live 拉取中，避免评论区在实时数据到达前闪烁为空。 */}
      <TaskCommentsList comments={shownComments} loading={commentsLoading || liveLoading} />

      {/* #490：关联 PR 的提交历史（实时拉取，不落库）。仅在确实有关联 PR 时渲染。 */}
      {livePrCommits.length > 0 && (
        <section className="detail-block">
          <div className="block-title">
            {t('detail.prCommitsTitle', { n: livePrCommits.length })}
          </div>
          <ul className="link-list">
            {livePrCommits.map((c) => (
              <li key={c.sha} className="link-line">
                <span className="link-ref mono">{c.sha}</span>
                <span className="link-title">{c.message.split('\n')[0]}</span>
                {c.author && <span className="muted small">@{c.author}</span>}
                {c.date > 0 && <span className="muted small">{fmtTime(c.date, lang)}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}

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
          {liveAssignees.length > 0
            ? t('detail.assignees', { list: liveAssignees.map((a) => `@${a}`).join(' ') })
            : task.assignees
              ? t('detail.assignees', {
                  list: task.assignees
                    .split(',')
                    .filter(Boolean)
                    .map((a) => `@${a}`)
                    .join(' '),
                })
              : t('ownership.notassignee')}
          {task.mentioned && ` · ${t('detail.mentionedSuffix')}`}
          {liveLabels.length > 0 && ` · ${t('detail.labels', { list: liveLabels.join(', ') })}`}
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

      {/* #490：实时拉取失败只做轻量提示，不阻断详情面板（保留本地库展示）。 */}
      {liveError && (
        <div className="muted small top-gap">{t('detail.liveError', { msg: liveError })}</div>
      )}
      {err && <div className="banner error">{err}</div>}
    </aside>
  );
}

import { memo, useMemo } from "react";
import { COLUMNS, type Account, type AccountColumn, type ProjectStatus, type StatusKey, type Task, type BoardMode } from "../types";
import { useT } from "../i18n";
import TaskCard from "./TaskCard";

interface Props {
  tasks: Task[];
  selected: string | null;
  onSelect: (key: string) => void;
  /** v0.3.16+：账号列表（按 id），用于在卡片上显示账号徽章；空 Map 时不显示徽章。 */
  accounts?: Map<number, Account>;
  /** v0.3.21+：看板列模式。status=四态列，project=GitHub Project Status 列。 */
  boardMode?: BoardMode;
  /** v0.3.22+：项目 Status 选项（来自 project_statuses 表，用于列排序）。 */
  projectStatuses?: ProjectStatus[];
  /** v0.3.28+：自定义列配置（按账号配置看板列）。 */
  accountColumns?: AccountColumn[];
}

// GitHub Project Status 原文到显示用键的映射（用于分组去重）。
function groupByProjectStatus(tasks: Task[]): Map<string, Task[]> {
  const map = new Map<string, Task[]>();
  map.set("done", []);
  map.set("unclassified", []);

  for (const task of tasks) {
    if (task.issueState === "closed") {
      map.get("done")?.push(task);
      continue;
    }
    if (task.projectStatus && task.projectStatus.trim()) {
      const key = task.projectStatus.trim();
      if (!map.has(key)) map.set(key, []);
      map.get(key)?.push(task);
    } else {
      map.get("unclassified")?.push(task);
    }
  }
  return map;
}

// 按 project_statuses 表的 order_index 排序；无表数据时回退到字母序（稳定可预测）。
function sortProjectStatusKeys(
  keys: string[],
  projectStatuses?: ProjectStatus[],
): string[] {
  if (!projectStatuses || projectStatuses.length === 0) {
    // 无 project_statuses 表数据时，按字母序排序，避免返回 tasks 遍历顺序导致的不稳定渲染
    return [...keys].sort((a, b) => a.localeCompare(b));
  }
  const orderMap = new Map<string, number>();
  for (const ps of projectStatuses) {
    orderMap.set(ps.name, ps.orderIndex);
  }
  // 所有列纯按 order_index 排序；不在表中的放末尾
  return [...keys].sort((a, b) => {
    const oa = orderMap.get(a);
    const ob = orderMap.get(b);
    if (oa !== undefined && ob !== undefined) return oa - ob;
    if (oa !== undefined) return -1;
    if (ob !== undefined) return 1;
    return 0;
  });
}

/** v0.3.51 (#165)：从未匹配任务中提取未映射的 project_status 值（去重 + 计数，按首次出现顺序，空值剔除）。
 * 供「未标注」列提示用，让用户一眼看出哪些状态值没被任何自定义列覆盖。 */
export function extractUnmappedStatuses(tasks: Task[]): { value: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const task of tasks) {
    const v = task.projectStatus?.trim();
    if (!v) continue;
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  return [...counts.entries()].map(([value, count]) => ({ value, count }));
}

export type BoardViewKind = "project" | "custom" | "fourstate";

/** v0.3.51 (#159)：根据看板模式与自定义列配置决定实际渲染视图。
 * custom 模式未配置任何自定义列时回退到 project 视图，避免误导性的四态列；
 * status（legacy）优雅降级为 project；其余情况保留四态列作终极兜底。 */
export function resolveBoardView(
  boardMode: BoardMode,
  accountColumns: AccountColumn[] | undefined,
): BoardViewKind {
  if (boardMode === "custom") {
    return accountColumns && accountColumns.length > 0 ? "custom" : "project";
  }
  if (boardMode === "project" || boardMode === "status") return "project";
  return "fourstate";
}

/** v0.3.51 (#159)：自定义列分组——任务 status 命中列 colKey 归入对应组，未命中进 unmatched。 */
export function groupTasksByCustomColumns(
  tasks: Task[],
  accountColumns: AccountColumn[] | undefined,
): { groups: Map<string, Task[]>; unmatched: Task[] } {
  const cols = accountColumns ?? [];
  const valid = new Set(cols.map((c) => c.colKey));
  const groups = new Map<string, Task[]>();
  for (const c of cols) groups.set(c.colKey, []);
  const unmatched: Task[] = [];
  for (const task of tasks) {
    if (valid.has(task.status)) groups.get(task.status)?.push(task);
    else unmatched.push(task);
  }
  return { groups, unmatched };
}

// v0.3.49 (#145)：memo + 全量 useMemo。tasks 数组引用不变时整板跳过重渲染；
// 分组/排序/颜色映射均为单遍计算，不再每列扫全量。
function Board({
  tasks,
  selected,
  onSelect,
  accounts,
  boardMode = "project",
  projectStatuses,
  accountColumns,
}: Props) {
  const t = useT();

  // 仓库名 -> 颜色索引（按字母序，三视图共用，单遍）。
  const repoIndexMap = useMemo(() => {
    const allRepos = [...new Set(tasks.map((task) => task.repo))].sort();
    const m = new Map<string, number>();
    allRepos.forEach((r, i) => m.set(r, i));
    return m;
  }, [tasks]);

  // Project 视图：分组 + 列键 + 状态颜色映射。
  const grouped = useMemo(() => groupByProjectStatus(tasks), [tasks]);
  const projectKeys = useMemo(() => {
    // 以 project_statuses 表为准，确保所有状态列都展示（即使无任务）
    if (projectStatuses && projectStatuses.length > 0) {
      const keys = projectStatuses.map((ps) => ps.name);
      if ((grouped.get("done") ?? []).length > 0) keys.push("done");
      if ((grouped.get("unclassified") ?? []).length > 0) keys.push("unclassified");
      return keys;
    }
    // 无 project_statuses 时回退：只展示有任务的列
    return sortProjectStatusKeys(
      Array.from(grouped.keys()).filter((k) => (grouped.get(k) ?? []).length > 0),
    );
  }, [grouped, projectStatuses]);
  const statusIndexMap = useMemo(() => {
    const m = new Map<string, number>();
    projectStatuses?.forEach((ps, i) => m.set(ps.name, i));
    return m;
  }, [projectStatuses]);

  // 自定义列视图：单遍分组（列 key -> 任务）+ 未匹配列，替代原来的每列 filter 全量扫。
  const customGroups = useMemo(
    () => groupTasksByCustomColumns(tasks, accountColumns),
    [tasks, accountColumns],
  );

  // 四态视图：单遍分组。
  const statusGroups = useMemo(() => {
    const m = new Map<StatusKey, Task[]>();
    for (const c of COLUMNS) m.set(c.key, []);
    for (const task of tasks) {
      const arr = m.get(task.status as StatusKey);
      if (arr) arr.push(task);
      else m.get("todo")?.push(task);
    }
    return m;
  }, [tasks]);

  const cardProps = (task: Task) => ({
    accountLabel: accounts?.get(task.accountId)?.label,
    repoIndex: repoIndexMap.get(task.repo) ?? 0,
  });

  // v0.3.43+: "status" (legacy) gracefully degrades to "project"
  // v0.3.51 (#159): custom 模式未配置自定义列时回退到 project 列，避免误导性的四态列
  const view = resolveBoardView(boardMode, accountColumns);
  if (view === "project") {
    // GitHub Project Status 列视图
    return (
      <div className="board">
        {projectKeys.map((key) => {
          const items = grouped.get(key) ?? [];
          const colorIdx = key === "done" ? -1 : key === "unclassified" ? -1 : (statusIndexMap.get(key) ?? -1);

          const title = key === "done" ? t("status.done") : key === "unclassified" ? t("detail.unlabeled") : key;

          return (
            <section key={key} aria-label={title} className={`column column-status-${((colorIdx % 20) + 20) % 20}`}>
              <div className="column-head">
                <span className={`dot dot-status-${((colorIdx % 20) + 20) % 20}`} />
                <span className="column-title">{title}</span>
                <span className="count">{items.length}</span>
              </div>
              <div className="column-body" role="list">
                {items.length === 0 && <div className="empty">{title}</div>}
                {items.map((task) => (
                  <TaskCard
                    key={task.issueKey}
                    task={task}
                    {...cardProps(task)}
                    active={task.issueKey === selected}
                    onSelectKey={onSelect}
                  />
                ))}
              </div>
            </section>
          );
        })}
      </div>
    );
  }

  if (view === "custom") {
    // 自定义列视图（按账号配置渲染）；此处 view 为 custom 时 accountColumns 非空
    const { groups, unmatched } = customGroups;
    const cols = accountColumns ?? [];
    return (
      <div className="board">
        {cols.map((col, idx) => {
          const items = groups.get(col.colKey) ?? [];
          return (
            <section key={col.colKey} aria-label={col.colName} className={`column column-status-${idx % 20}`}>
              <div className="column-head">
                <span className={`dot dot-status-${idx % 20}`} />
                <span className="column-title">{col.colName}</span>
                <span className="count">{items.length}</span>
              </div>
              <div className="column-body" role="list">
                {items.length === 0 && <div className="empty">{col.colName}</div>}
                {items.map((task) => (
                  <TaskCard
                    key={task.issueKey}
                    task={task}
                    {...cardProps(task)}
                    active={task.issueKey === selected}
                    onSelectKey={onSelect}
                    showGhStatus
                  />
                ))}
              </div>
            </section>
          );
        })}
        {/* 未匹配任务列 */}
        {unmatched.length > 0 && (
          <section aria-label={t("detail.unlabeled")} className="column column-unclassified">
            <div className="column-head">
              <span className="dot dot-unclassified" />
              <span className="column-title">{t("detail.unlabeled")}</span>
              <span className="count">{unmatched.length}</span>
            </div>
            {(() => {
              // v0.3.51 (#165)：提示未映射的 project_status 值，帮助用户定位漏配/错配的列
              const unmapped = extractUnmappedStatuses(unmatched);
              if (unmapped.length === 0) return null;
              const all = unmapped.map((u) => `${u.value}(${u.count})`).join("、");
              const shown = unmapped.slice(0, 3).map((u) => `${u.value}(${u.count})`).join("、");
              return (
                <div className="unmapped-hint" title={all} aria-label={all}>
                  {t("board.unmappedHint")}: {shown}
                  {unmapped.length > 3 ? ` +${unmapped.length - 3}` : ""}
                </div>
              );
            })()}
            <div className="column-body" role="list">
              {unmatched.map((task) => (
                <TaskCard
                  key={task.issueKey}
                  task={task}
                  {...cardProps(task)}
                  active={task.issueKey === selected}
                  onSelectKey={onSelect}
                  showGhStatus
                />
              ))}
            </div>
          </section>
        )}
      </div>
    );
  }

  // 四态列视图（默认）
  return (
    <div className="board">
      {COLUMNS.map((col) => {
        const items = statusGroups.get(col.key) ?? [];
        return (
          <section key={col.key} aria-label={t(`status.${col.key}`)} className={`column column-${col.key}`}>
            <div className="column-head">
              <span className={`dot dot-${col.key}`} />
              <span className="column-title">{t(`status.${col.key}`)}</span>
              <span className="count">{items.length}</span>
            </div>
            <div className="column-body" role="list">
              {items.length === 0 && <div className="empty">{t(`hint.${col.key}`)}</div>}
              {items.map((task) => (
                <TaskCard
                  key={task.issueKey}
                  task={task}
                  {...cardProps(task)}
                  active={task.issueKey === selected}
                  onSelectKey={onSelect}
                  showGhStatus={boardMode === "custom"}
                />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

export default memo(Board);

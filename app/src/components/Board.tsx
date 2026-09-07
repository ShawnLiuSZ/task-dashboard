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
    if (task.ghState === "closed") {
      map.get("done")?.push(task);
      continue;
    }
    if (task.ghStatus && task.ghStatus.trim()) {
      const key = task.ghStatus.trim();
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

export default function Board({
  tasks,
  selected,
  onSelect,
  accounts,
  boardMode = "project",
  projectStatuses,
  accountColumns,
}: Props) {
  const t = useT();

  if (boardMode === "project") {
    // GitHub Project Status 列视图
    const grouped = groupByProjectStatus(tasks);
    // 以 project_statuses 表为准，确保所有状态列都展示（即使无任务）
    let keys: string[];
    if (projectStatuses && projectStatuses.length > 0) {
      keys = projectStatuses.map((ps) => ps.name);
      if ((grouped.get("done") ?? []).length > 0) keys.push("done");
      if ((grouped.get("unclassified") ?? []).length > 0) keys.push("unclassified");
    } else {
      // 无 project_statuses 时回退：只展示有任务的列
      keys = sortProjectStatusKeys(
        Array.from(grouped.keys()).filter((k) => {
          const items = grouped.get(k) ?? [];
          return items.length > 0;
        }),
      );
    }

    // 构建 status name -> order_index 映射（用于卡片颜色）
    const statusIndexMap = new Map<string, number>();
    if (projectStatuses) {
      projectStatuses.forEach((ps, i) => statusIndexMap.set(ps.name, i));
    }

    // 构建 repo name -> 颜色索引映射（按字母排序取不同颜色）
    const allRepos = [...new Set(tasks.map((t) => t.repo))].sort();
    const repoIndexMap = new Map<string, number>();
    allRepos.forEach((r, i) => repoIndexMap.set(r, i));

    return (
      <div className="board">
        {keys.map((key) => {
          const items = grouped.get(key) ?? [];
          const colorIdx = key === "done" ? -1 : key === "unclassified" ? -1 : (statusIndexMap.get(key) ?? -1);

          const title = key === "done" ? t("status.done") : key === "unclassified" ? t("detail.unlabeled") : key;

          return (
            <section key={key} className={`column column-status-${((colorIdx % 20) + 20) % 20}`}>
              <div className="column-head">
                <span className={`dot dot-status-${((colorIdx % 20) + 20) % 20}`} />
                <span className="column-title">{title}</span>
                <span className="count">{items.length}</span>
              </div>
              <div className="column-body">
                {items.length === 0 && <div className="empty">{title}</div>}
                {items.map((task) => (
                  <TaskCard
                    key={task.key}
                    task={task}
                    accountLabel={accounts?.get(task.accountId)?.label}
                    active={task.key === selected}
                    onClick={() => onSelect(task.key)}
                    repoIndex={repoIndexMap.get(task.repo) ?? 0}
                  />
                ))}
              </div>
            </section>
          );
        })}
      </div>
    );
  }

  if (boardMode === "custom" && accountColumns && accountColumns.length > 0) {
    // 自定义列视图（按账号配置渲染）
    const byColumn = (colKey: string) =>
      tasks.filter((task) => task.status === colKey);
    // 无匹配的任务归入「未分类」列
    const unmatched = tasks.filter(
      (task) => !accountColumns.some((col) => task.status === col.colKey),
    );

    // 构建 repo name -> 颜色索引映射
    const allRepos = [...new Set(tasks.map((t) => t.repo))].sort();
    const repoIndexMap = new Map<string, number>();
    allRepos.forEach((r, i) => repoIndexMap.set(r, i));

    return (
      <div className="board">
        {accountColumns.map((col, idx) => {
          const items = byColumn(col.colKey);
          return (
            <section key={col.colKey} className={`column column-status-${idx % 20}`}>
              <div className="column-head">
                <span className={`dot dot-status-${idx % 20}`} />
                <span className="column-title">{col.colName}</span>
                <span className="count">{items.length}</span>
              </div>
              <div className="column-body">
                {items.length === 0 && <div className="empty">{col.colName}</div>}
                {items.map((task) => (
                  <TaskCard
                    key={task.key}
                    task={task}
                    accountLabel={accounts?.get(task.accountId)?.label}
                    active={task.key === selected}
                    onClick={() => onSelect(task.key)}
                    repoIndex={repoIndexMap.get(task.repo) ?? 0}
                  />
                ))}
              </div>
            </section>
          );
        })}
        {/* 未匹配任务列 */}
        {unmatched.length > 0 && (
          <section className="column column-unclassified">
            <div className="column-head">
              <span className="dot dot-unclassified" />
              <span className="column-title">{t("detail.unlabeled")}</span>
              <span className="count">{unmatched.length}</span>
            </div>
            <div className="column-body">
              {unmatched.map((task) => (
                <TaskCard
                  key={task.key}
                  task={task}
                  accountLabel={accounts?.get(task.accountId)?.label}
                  active={task.key === selected}
                  onClick={() => onSelect(task.key)}
                  repoIndex={repoIndexMap.get(task.repo) ?? 0}
                />
              ))}
            </div>
          </section>
        )}
      </div>
    );
  }

  // 四态列视图（默认）
  const byStatus = (s: StatusKey) => tasks.filter((task) => task.status === s);

  return (
    <div className="board">
      {COLUMNS.map((col) => {
        const items = byStatus(col.key);
        return (
          <section key={col.key} className={`column column-${col.key}`}>
            <div className="column-head">
              <span className={`dot dot-${col.key}`} />
              <span className="column-title">{t(`status.${col.key}`)}</span>
              <span className="count">{items.length}</span>
            </div>
            <div className="column-body">
              {items.length === 0 && <div className="empty">{t(`hint.${col.key}`)}</div>}
              {items.map((task) => (
                <TaskCard
                  key={task.key}
                  task={task}
                  accountLabel={accounts?.get(task.accountId)?.label}
                  active={task.key === selected}
                  onClick={() => onSelect(task.key)}
                />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

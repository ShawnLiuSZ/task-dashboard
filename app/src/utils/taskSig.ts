import type { Task } from "../types";

const FIELD_SEP = " | ";
const ROW_SEP = " || ";

/**
 * #181：任务列表指纹，用于「无变化跳过 setState」。
 *
 * 为什么不能只看 `updated_at`：本地写入（`set_task_status` /
 * `touch_session` / `clear_task_session` / `record_task_handoff`）
 * 都不更新 `updated_at`（只有同步写），所以指纹必须覆盖这些写入
 * 会碰的字段：status / session 三件套 / handoff / work_branch，外加同步维度的
 * ownership / title / candidateDone / updatedAt 与集合本身。
 */
export function taskListSignature(tasks: Task[]): string {
  return (
    `${tasks.length} :: ` +
    tasks
      .map((t) =>
        [
          t.issueKey,
          t.status,
          t.ownership,
          t.title,
          t.sessionId ?? "",
          t.sessionAgent ?? "",
          t.sessionAt ?? 0,
          t.handoff,
          t.workBranch,
          t.updatedAt ?? 0,
          t.candidateDone ? 1 : 0,
        ].join(FIELD_SEP),
      )
      .join(ROW_SEP)
  );
}

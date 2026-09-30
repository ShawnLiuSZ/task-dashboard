import type { Task } from '../types';

/**
 * #329：任务在**前端**的唯一标识。
 *
 * 后端 `tasks` 表的唯一键是 `UNIQUE(repo, number, account_id)`，而 `issueKey`
 * 只编码 `owner/repo#number`：在「全部账号聚合视图」下，同一个 issue 被两个账号
 * 关联时会返回两条 `issueKey` 完全相同的记录。直接拿它做 React key 会触发重复 key
 * （React 复用错误 DOM、卡片错位），做选中态判定则会「点 A 打开 B」。
 *
 * 故渲染 key / 选中态一律用 `issueKey@accountId`。
 *
 * ⚠️ **写操作仍用 `task.issueKey`**：后端按 `issue_key` 定位任务
 * （`update_task_status` / `clear_session` 等），换成本函数的值会查不到。
 * 本函数只用于「前端身份」，不用于「后端定位」。
 */
export function taskIdentity(task: Pick<Task, 'issueKey' | 'accountId'>): string {
  return `${task.issueKey}@${task.accountId}`;
}

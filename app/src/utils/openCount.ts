import type { Task } from '../types';

/**
 * #484：顶栏计数的口径 —— 「我的未完成 issue 数」。
 *
 * 排除两类任务（用户视角都属于「做完了」）：
 * 1. `issueState === 'closed'`：GitHub 权威关闭（同步路径也会把本地状态置 done）；
 * 2. `status === 'done'`：看板手动标记「已完成」，issue 可能还没关。
 *
 * 为什么抽成纯函数：计数口径是产品语义，必须有独立单测守着 —— 内联在 JSX 里
 * 只能靠端到端测试，而 App 层没有组件测试基建（与 `taskIdentity` / `matchRules`
 * 同一处理方式）。
 *
 * 注意：入参应为**已按归属过滤**的任务列表（`list_tasks` 由后端筛 ownership 后下发），
 * 本函数不重复判定 `ownership` 字段。
 */
export function countOpenIssues(tasks: Task[]): number {
  let n = 0;
  for (const task of tasks) {
    if (task.issueState === 'closed') continue;
    if (task.status === 'done') continue;
    n += 1;
  }
  return n;
}

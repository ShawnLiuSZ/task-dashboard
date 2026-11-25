import type { StatusKey } from '../types';
import { isClosedIssueState } from './issueState';

/**
 * #612：一条任务的会话是否可一键清除。
 *
 * 两个维度正交，满足**任一**即可：
 * - `issueState === 'closed'`（GitHub issue 已关闭；大小写不敏感，见 #543）
 * - `status === 'done'`（本地看板四态的「已完成」；#541 只覆盖前者）
 *
 * 抽成纯函数是为了让四种组合可被真实数据流单测覆盖——组件里写
 * `a || b` 的静态断言对「漏掉一个分支」无感（变异盲点）。
 */
export function isClearableSession(issueState: string, status: StatusKey): boolean {
  return isClosedIssueState(issueState) || status === 'done';
}

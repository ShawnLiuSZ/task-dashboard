/**
 * `issue_state` 是否表示「已关闭」（#543）。
 *
 * **与后端 `common::is_closed_state` 同口径**（`trim` + 大小写不敏感）。该列历史上由
 * **两套来源**写入两套大小写 —— REST 给 `open`/`closed`（小写），GraphQL（ProjectV2
 * 条目查询）给 `OPEN`/`CLOSED`（大写）；#335 曾因此让「closed → done」分支对 Project
 * 来源的 issue 完全失效（实测 29 行已关闭 issue 滞留看板）。AGENTS.md §2.2 明确
 * 「读判定不得写死小写」，故前端所有读判定统一走本函数，**不依赖「写路径恰好归一化」这层
 * 隐式保障** —— 一旦未来某写路径漏归一化（#335 类回归），前端才不会静默误判。
 *
 * 注：后端写路径（`sync.rs` / `on_demand.rs`）已经 `common::normalize_issue_state`
 * 落库小写，真实库里恒为小写，本函数对 `'closed'` 的行为与旧的 `=== 'closed'` **严格等价**；
 * 它只是额外防御大写 / 带空白的历史残留值。
 */
export function isClosedIssueState(state: string): boolean {
  return state.trim().toLowerCase() === 'closed';
}

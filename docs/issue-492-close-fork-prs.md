# 公开仓库自动关闭非协作者的 fork PR — #492

> 关联 issue：[#492](https://github.com/ShawnLiuSZ/task-dashboard/issues/492)
> 决策：仓库保持公开，但不想让陌生 fork PR 打进来。

## 背景 / 动机

GitHub **没有**「公开仓库禁止 fork PR」的原生开关：Settings → Features 里 Issues、Wikis 都能关，唯独 **Pull Requests 不可关**——fork 后发 PR 是平台级行为，任何仓库设置都拦不住"提交"这个动作。

实际会发生的骚扰形态：陌生人 fork 仓库、改几行、开一个 PR。即使永远不合并，也会产生通知噪音，且 PR 打开期间其 CI 触发行为需要人工甄别。

## 设计 / 方案

新增 `.github/workflows/close-fork-prs.yml`，把「不接受 fork PR」从口头约定变成自动执行的仓库策略：

- **触发**：`pull_request_target`（`opened` / `reopened`）。选它而非 `pull_request` 的原因：`pull_request` 事件的 workflow 跑在 PR 合并预览 ref 上且**拿不到仓库写权限**，关不了 PR；`pull_request_target` 以默认分支上的 workflow 定义运行、持有 `github.token`，可以调 API 关闭。
- **判定**：`github.event.pull_request.author_association`——只有 `OWNER` / `MEMBER` / `COLLABORATOR` 放行；其余（`NONE` / `FIRST_TIME_CONTRIBUTOR` / `CONTRIBUTOR` 等）一律关闭。用 `if: >-` 折叠表达式把三个放行条件写在一起，job 级守卫。
- **动作**：runner 自带的 `gh pr close --comment` 一步完成「留言 + 关闭」，零第三方 action（无需版本固定，也缩小供应链面）。
- **安全性**：`pull_request_target` 是需要谨慎的事件（它信任 base 分支的 workflow 且有写权限），本 workflow **绝不 checkout PR 代码、不执行 PR 内容**，关闭动作与 PR 内容完全无关——这是该事件的正确用法。

### 为什么不用 branch protection

branch protection（要求审核通过才能合并）能保证 fork PR **合不进来**，但 PR 仍会打开、仍会发通知。本方案直接关掉，符合「不允许 fork 提交 PR」的语义；两者可叠加，前者作为纵深防御可选。

## 接口 / 行为变更

- 新增 workflow：`.github/workflows/close-fork-prs.yml`（仅一个 job 一个 step，无 secrets 依赖，用内置 `github.token`）。
- 协作者（OWNER / MEMBER / COLLABORATOR）的 PR **不受影响**，正常走 Quality Check 等既有门禁。
- 非协作者 PR 打开后立即被关闭，收到一条中文说明评论（引导先开 issue）。

## 数据 / Schema 变更

无。

## 测试 / 验收

- `python3 scripts/check-workflow-yaml.py` 通过（新文件纳入其全量扫描：偶数缩进 / `on:` 触发 / job 结构 / 表达式引号等 13 类静态规则）。
- `python3 -m unittest discover -s scripts -p 'test_*.py'` 通过——`test_workflow_yaml.py` 的正向回归会把仓库里**所有** workflow（含本文件）扫一遍，新文件不合规会让该测试失败。
- 行为验收：协作者 PR 正常合并（#491 已验证既有链路）；fork PR 由 workflow 自动关闭（真实 fork PR 出现时观察运行记录）。

## 相关链接

- issue：[#492](https://github.com/ShawnLiuSZ/task-dashboard/issues/492)
- 代码：`.github/workflows/close-fork-prs.yml`
- 更新记录：[`docs/CHANGELOG.md`](./CHANGELOG.md)

# issue-567：workflow linter 对 `on:` 内联子键误报「没有任何触发事件」

> 关联：[#567](https://github.com/ShawnLiuSZ/task-dashboard/issues/567) ｜ 2026-11-17 全量核查报告 中危-4

## 背景 / 动机

`scripts/check-workflow-yaml.py`（:372-379）`on:` 块下收集触发事件的判定写死
`ind == 2 and rest == ""`：只有块映射子键（`push:` / `pull_request:` 后跟空 rest）
被正确收集。

`push: {branches: [main]}`（内联映射）与 `pull_request: [opened]`（内联数组）的
rest 非空 ⇒ 收集不到 ⇒ `on_triggers` 空 ⇒ 合法 workflow 被误报
「`on:` 下没有任何触发事件（workflow 永远不会被触发）」—— CI 会直接红。

`on` 支持三种写法（块映射 / 内联数组 / 单事件），原实现只认块映射子键一种。

## 设计 / 方案

1. `:372-379` 判定从 `ind == 2 and rest == ""` 放宽为 `ind == 2`（`on:` 块下
   **任何**子键都是一个触发事件，不论 rest 是否为空）。
2. `test_workflow_yaml.py` 补两用例：
   - `test_on_inline_subkey_not_flagged_as_no_trigger`：内联映射 / 内联数组不误报；
   - `test_on_block_still_flagged_if_genuinely_empty`：`on:` 块真的空时仍必报（回归）。
3. 按 AGENTS.md §5.6 做注入确认：把判定改回 `if ind == 2 and rest == "":` ⇒
   用例①分支变红；还原 ⇒ 全绿。

## 接口 / 行为变更

`check-workflow-yaml.py` 判定放宽：`on:` 块下的内联映射 / 内联数组子键不再被误报。
仓库现存 workflow 均用块映射子键 ⇒ 无既有行为变化（`PositiveRegressionTest` 守住）。

## 测试 / 验收

- `scripts/test_workflow_yaml.py`：
  - `test_on_inline_subkey_not_flagged_as_no_trigger`（子串判断，非元素相等）
  - `test_on_block_still_flagged_if_genuinely_empty`
- 全量 `python3 -m unittest discover -s scripts -p 'test_workflow_yaml.py'` 55 例全绿。
- **反向验证踩坑记录**（§5.6）：初版用例用 `assertNotIn(needle, errs(...))`，其中
  `needle` 是错误消息的**子串**而非完整列表元素 —— `assertNotIn` 做的是列表**元素相等**
  判断，子串永远不在列表里 ⇒ 用例恒绿，mutation 验证暴露后改为
  `assertFalse(any(needle in p for p in errs(...)))` 子串判断。这正是「断言强度靠读代码
  判断极易出错」的实例。

## 相关链接

- Issue：[#567](https://github.com/ShawnLiuSZ/task-dashboard/issues/567)
- 核查报告：`CODE-REVIEW-2026-11-17.md`（中危-4）
- 既有：#329（`on` 三写法）/ #539（CI 供应链加固）

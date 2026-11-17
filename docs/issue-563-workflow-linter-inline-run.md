# issue-563：workflow linter 列表项内联 run 绕过脚本/插值检查

> 关联：[#563](https://github.com/ShawnLiuSZ/task-dashboard/issues/563) ｜ 2026-11-17 全量核查报告 中危-2

## 背景 / 动机

`scripts/check-workflow-yaml.py`（CI 供应链门禁，#539 引入）的列表项分支（`:284-311`）在
`continue` 前只设 `step.has_run`，**不做** `runs_scripts`（VULN-03：`scripts/` 未 checkout）
与 `run_interpolation_ln`（VULN-04：`${{ github.event.* }}` 脚本注入）判定；对照非列表 kv 分支
（`:328-332`）两行都有。

黑盒复现：文件写 `- run: echo "${{ github.event.issue.title }}"` → `scan()` 返回 `[]`（不报）；
同一值写独立行 `run:` → 正确报错。

且 VULN-04 在 `test_workflow_yaml.py` **零覆盖**（VULN-01/02/03 均有正反用例，唯独 VULN-04 无）
⇒ 该漏报无测试暴露面。

## 设计 / 方案

1. 列表项分支内、`continue` 前，对 `- run:` 补齐与独立行 `run:` 同口径的检查：
   - `"scripts/" in rest` ⇒ `runs_scripts = True`（VULN-03）
   - `rest` 非空 ⇒ `run_interpolation_ln(ln, rest, errors)`（VULN-04）
   - 块标量形态（`- run: |`）已在更早的 `continue` 处理，此处必然非块指示符。
2. `test_workflow_yaml.py` 补 VULN-04 表驱动用例：**独立行 / 块标量 / 列表项内联** 三种形态
   都必须被拦；另补「运营方 / GitHub 控制的 context 不误报」边界用例（secrets/github.sha/
   github.token/env/matrix/runner）。
3. 按 AGENTS.md §5.6 做注入确认：临时移除列表项分支的 `run_interpolation_ln` 调用 ⇒
   「列表项内联」子用例变红；还原 ⇒ 全绿。

## 接口 / 行为变更

`check-workflow-yaml.py` 判定收紧：`- run:` 列表项现在会参与 VULN-03 / VULN-04 检查。
仓库现存 workflow 均不用 `- run:` 列表项形态 ⇒ 无既有误报风险（`PositiveRegressionTest`
守住）。

## 数据 / Schema 变更

无（纯 Python 脚本 + 单测）。

## 测试 / 验收

- `scripts/test_workflow_yaml.py`：`test_run_interpolation_is_flagged`（三形态）+ 
  `test_run_interpolation_allowed_contexts_not_flagged`（边界）。
- 全量 `python3 -m unittest discover -s scripts -p 'test_workflow_yaml.py'` 53 例全绿。
- 反向验证通过（见上）。

## 相关链接

- Issue：[#563](https://github.com/ShawnLiuSZ/task-dashboard/issues/563)
- 核查报告：`CODE-REVIEW-2026-11-17.md`（中危-2）
- 既有：#539（CI 供应链加固）/ #451（列表项块标量）

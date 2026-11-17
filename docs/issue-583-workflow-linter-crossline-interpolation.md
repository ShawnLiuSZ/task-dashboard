# issue-583：workflow linter 拦截 run 插值跨行拆分绕过

> 关联：[#583](https://github.com/ShawnLiuSZ/task-dashboard/issues/583) ｜ 2026-11-17 全量核查报告 低危-5

## 背景 / 动机

`scripts/check-workflow-yaml.py::RUN_INTERPOLATION_RE` 用于 #539 VULN-04：`run:`（含块标量）
里禁止直接内插攻击者可影响的 context（`github.event.*` / `github.ref_name` / `github.head_ref`），
必须经 `env:` 中转（防脚本注入）。

原实现 `run_interpolation_ln(ln, text, errors)` 对**单行** `text` 做 `RUN_INTERPOLATION_RE.search`：

```python
RUN_INTERPOLATION_RE = re.compile(r"\$\{\{[^}]*github\.(?:event\.|ref_name|head_ref)")
```

`run: |` 块标量里 `${{` 与 `github.event` **跨行拆分**（黑盒实跑确认）：

```
run: |
  echo "${{ 
    github.event.issue.title }}"
```

`${{` 在上一行、`github.event` 在下一行 ⇒ 两行各自都不含完整模式 ⇒ **绕过**。
VULN-04 脚本注入防线的「该拦不拦」。

## 设计 / 方案

`scan()` 增加 run 块标量的完整文本累积：

1. `block_run_lines: list[str]` + `block_run_start: int` 状态变量。
2. `in_block` 分支里，`block_owner == "run"` 时把每行 `body` 追加进 `block_run_lines`
   （不再逐行调 `run_interpolation_ln`），首行记录 `block_run_start`。
3. 块标量结束（dedent 分支）或 EOF（循环后）时，对 `"\n".join(block_run_lines)`
   一次性调 `run_interpolation_ln` —— `[^}]*` 可跨 `\n` 命中拆分模式。
4. 内联 `- run: <cmd>` / 独立行 `run: <cmd>` 不受影响（本就是单行完整值）。

## 接口 / 行为变更

- `run: |` 块标量里跨行拆分的 `${{` + `github.event.*` / `github.ref_name` /
  `github.head_ref` 从「绕过」改为「报错」。
- 报错行号指向块标量**首行**（`block_run_start`），不再逐行。
- `secrets.*` / `env.*` / `matrix.*` / `runner.*` / `github.token` / `github.sha`
  等运营方控制的 context 仍不报（不在禁列），无新误报。

## 测试 / 验收

- `test_workflow_yaml.py::ExtendedDetectionTest::test_run_interpolation_cross_line_split_is_flagged`：
  跨行拆分 `github.event.issue.title` 与 `github.ref_name` 均必报（needle「攻击者可影响」）。
- 黑盒 7 场景：跨行拆分 event / ref_name ⇒ 报；同行 ⇒ 报（回归）；`secrets` / `env` ⇒
  不报（不误报）；无插值 ⇒ 不报；跨行但 `${{ }}` 已在 `github.event` 前闭合 ⇒ 不报
  （`github.event` 在表达式外，非注入，正确不报）。
- 全量 `python3 -m unittest discover -s scripts -p 'test_workflow_yaml.py'` 62 例全绿。
- **反向验证**（§5.6）：`in_block` 分支改回逐行 `run_interpolation_ln` ⇒
  `test_run_interpolation_cross_line_split_is_flagged` 变红（`scan` 返回 `[]`，绕过）；
  还原全绿。

## 相关链接

- Issue：[#583](https://github.com/ShawnLiuSZ/task-dashboard/issues/583)
- 核查报告：`CODE-REVIEW-2026-11-17.md`（低危-5）
- 既有：#539（VULN-04 引入）、#563（内联 `- run:` 补拦）

# issue-581：workflow linter 缺 checkout 判定改 per-job，文件级布尔掩盖缺失

> 关联：[#581](https://github.com/ShawnLiuSZ/task-dashboard/issues/581) ｜ 2026-11-17 全量核查报告 低危-4

## 背景 / 动机

`scripts/check-workflow-yaml.py::scan()` 的 VULN-03 缺 checkout 判定用**文件级**实现：

```python
runs_scripts = False                    # 文件级布尔
...
if runs_scripts and "actions/checkout@" not in "\n".join(lines):
    errors.append("有 step 直接执行仓库内脚本，但缺少 `actions/checkout@*`...")
```

三处缺陷：

1. **A job 跑脚本缺 checkout、B job 有 checkout** ⇒ B 的 `actions/checkout@` 命中全文件
   字符串搜 ⇒ **掩盖 A 的缺失**（漏报）。
2. **注释掉的 `actions/checkout@`** ⇒ 字符串搜命中注释行（`# - uses: actions/checkout@`）
   ⇒ **掩盖真实缺失**（漏报）。
3. **`./` 本地 action**（`uses: ./local-action`）隐含「仓库已 checkout」⇒ 原实现却因无
   `actions/checkout@` 字符串而**误报缺 checkout**（误报）。

## 设计 / 方案

1. `Job` 加 `runs_scripts` / `has_checkout` 字段（per-job 记录）。
2. `Step` 加 `is_local_action` property：`uses_val.startswith("./")` —— 本地 action 必须
   仓库已 checkout，故视同满足 checkout 需求。
3. 三处 `runs_scripts = True` 改 `job.runs_scripts = True`（块标量 `run: |` / 内联
   `- run:` / 独立 `run:` 三形态）。
4. `flush_step` 标记本 job 的 checkout（`step.is_checkout or step.is_local_action`
   ⇒ `job.has_checkout = True`）。
5. 移除文件级 `runs_scripts` + 全文件字符串搜，改 per-job 最终检查：只报
   「本 job 有脚本 step 且本 job 无 checkout」。

## 接口 / 行为变更

- 缺 checkout 报错从「文件级一条」改为「per-job 一条，带 job 名与行号」：
  `L{line}: job \`{name}\` 有 step 直接执行仓库内脚本，但缺少 \`actions/checkout@*\`...`。
- 修复三处漏报 / 误报：
  - 其它 job 的 checkout 不再掩盖本 job 的缺失（漏报修复）。
  - 注释掉的 checkout 不再掩盖缺失（漏报修复）。
  - `./` 本地 action 不再被误报缺 checkout（误报修复）。

## 测试 / 验收

- `test_workflow_yaml.py` 新增 3 用例：
  - `test_other_job_checkout_does_not_mask_missing`：A 缺 checkout + B 有 ⇒ 必报 A。
  - `test_commented_checkout_does_not_mask_missing`：注释掉的 checkout 不掩盖缺失。
  - `test_local_action_counts_as_checkout`：`./` 本地 action + run 脚本 ⇒ 不误报。
- 黑盒 5 场景全部符合预期（A 掩盖应报 / B 注释应报 / C `./` 应 OK / D 正常应 OK /
  E 单 job 无 checkout 应报）。
- 全量 `python3 -m unittest discover -s scripts -p 'test_workflow_yaml.py'` 61 例全绿。
- **反向验证**（§5.6，3 mutation 各自变红）：
  - 还原文件级字符串搜 ⇒ `test_other_job_checkout_does_not_mask_missing` +
    `test_commented_checkout_does_not_mask_missing` 变红。
  - `is_local_action` 恒 False ⇒ `test_local_action_counts_as_checkout` 变红。
  - `flush_step` 不标记 `has_checkout` ⇒ `test_checkout_present_silences_script_check` 变红。
  - 还原后 61 全绿。

## 相关链接

- Issue：[#581](https://github.com/ShawnLiuSZ/task-dashboard/issues/581)
- 核查报告：`CODE-REVIEW-2026-11-17.md`（低危-4）
- 既有：#539（VULN-02 persist-credentials）、#284（linter 初版）

# issue-585：workflow linter docstring 修正 @v5 矛盾 + 补 VULN-01~04 清单

> 关联：[#585](https://github.com/ShawnLiuSZ/task-dashboard/issues/585) ｜ 2026-11-17 全量核查报告 低危-6

## 背景 / 动机

`scripts/check-workflow-yaml.py` 文件头 docstring 第 5 条写：

> 引用的第三方 action 没有固定版本（`actions/checkout` 没有 `@v5` → 随时被上游改坏）

与实现**矛盾**：#539 VULN-01（`SHA_PIN_RE`）要求第三方 action 固定到**完整 40 位
commit SHA**，`@v5` / `@stable` / `@main` 这类 tag / 分支 / 通道**必报**。docstring 把
`@v5` 当「固定版本」的例子 ⇒ 误导后来者以为 `@v5` 合规。

此外 docstring 缺陷清单未列入 #539 的 VULN-02（checkout 必须 `with:
persist-credentials: false`）与 VULN-04（`run:` 禁止直接内插攻击者可影响 context），
VULN-01/03 也仅在第 5/9 条隐约提及。

## 设计 / 方案

**纯文档修正（无行为变更）**：

1. 第 5 条改为「必须固定完整 40 位 commit SHA，`@v5` / `@stable` / `@main` 属可变引用
   必报」，并说明供应链投毒可致恶意签名安装包通过 updater 验签。
2. 清单后补「#539 补丁」段，逐条列出 VULN-01~04 的检查内容与**不误报边界**
   （`secrets.*` / `env.*` / `matrix.*` / `runner.*` / `github.token` / `github.sha`
   等运营方或 GitHub 控制的 context 不在禁止之列）。

## 接口 / 行为变更

- 无（仅 docstring 文本，不改任何校验逻辑）。

## 测试 / 验收

- `python3 -m unittest discover -s scripts -p 'test_workflow_yaml.py'` 62 例全绿
  （文档修正不改变行为，无新增 / 变更用例）。
- docstring 现与 `SHA_PIN_RE`（:65）注释、`flush_step` VULN-02 注释、`run_interpolation_ln`
  VULN-04 注释逐条一致，不再互相矛盾。

## 相关链接

- Issue：[#585](https://github.com/ShawnLiuSZ/task-dashboard/issues/585)
- 核查报告：`CODE-REVIEW-2026-11-17.md`（低危-6）
- 既有：#539（VULN-01~04 引入）

# issue-569：workflow linter 误报注释内 tab 缩进 + `with:` 内联映射不认 persist-credentials

> 关联：[#569](https://github.com/ShawnLiuSZ/task-dashboard/issues/569) ｜ 2026-11-17 全量核查报告 中危-5

## 背景 / 动机

`scripts/check-workflow-yaml.py` 两处**误报**（合法 workflow 被 CI 判红）：

**① tab 检查位置（:233-235）**：`if "\t" in raw` 检查**整行**。YAML 只在**缩进（前导空白）**
里禁 tab；注释 / 普通标量 / 块标量内的 tab 是合法 YAML。黑盒复现：step 注释行含 tab ⇒
误报「使用 tab 缩进（YAML 只接受空格）」。

**② `with:` 内联映射（:426-429）**：`in_with = (rest.strip() == "")`，`with: {persist-credentials: false}`
（**内联映射**，GitHub 合法写法）rest 非空 ⇒ `in_with=False` ⇒ 该 `with:` 块的输入键不被识别 ⇒
VULN-02 误报「`actions/checkout` step 缺少 `with: persist-credentials: false`」。

## 设计 / 方案

1. **tab 检查收窄到前导空白**：`leading = raw[: len(raw) - len(raw.lstrip(" \t"))]`，
   `"\t" in leading` 才报。内容 / 注释里的 tab 不再误报。
2. **`with:` 内联映射识别**：`with:` 分支 rest 非空且形如 `{...}` 时，用
   `re.search(r"persist-credentials\s*:\s*([^}\s]+)", _inline)` 提取值并剥引号，
   `false` 才算已禁用（防误报）；`true` / 缺省 / 其它键仍算未禁用（必报）。
3. 补正反用例 + 按 AGENTS.md §5.6 做注入确认。

## 接口 / 行为变更

- tab 判定收紧：仅前导空白的 tab 报错（消除了注释 / 值内 tab 的误报）。
- `with:` 内联映射现在参与 VULN-02：`{persist-credentials: false}` 不再误报。

## 测试 / 验收

- `test_workflow_yaml.py`：
  - `test_tab_in_comment_not_flagged`（注释含 tab 不误报）
  - `test_with_inline_persist_credentials_false_ok`（内联 false 不误报）
  - `test_with_inline_persist_credentials_true_flagged`（内联 true 必报）
- 全量 `python3 -m unittest discover -s scripts -p 'test_workflow_yaml.py'` 58 例全绿。
- **反向验证踩坑记录**（§5.6）：内联映射初版用 `(\S+)` 捕获值，会把闭括号 `}` 吞进去
  （`false}` ≠ `false`）⇒ 修复无效。黑盒 probe 暴露后改用 `([^}\s]+)` 并剥引号。这再次
  印证「断言强度 / 修复有效性靠读代码判断极易出错，必须黑盒 + mutation」。

## 相关链接

- Issue：[#569](https://github.com/ShawnLiuSZ/task-dashboard/issues/569)
- 核查报告：`CODE-REVIEW-2026-11-17.md`（中危-5）
- 既有：#539（VULN-02 persist-credentials）/ #329（tab / 结构检查）

# issue-587：merge-cleanup load_payload 本地验证模式不强制 GITHUB_EVENT_PATH

> 关联：[#587](https://github.com/ShawnLiuSZ/task-dashboard/issues/587) ｜ 2026-11-17 全量核查报告 低危-7

## 背景 / 动机

`scripts/merge-cleanup.py::load_payload()` 无条件要求 `GITHUB_EVENT_PATH`，缺 env 直接
`SystemExit`。但 `--body-file` / `--dry-run` 帮助文本明确写着「本地验证用」——本地验证时
没有 workflow 事件负载，想验 body 内容跑不动（缺 env 就 SystemExit），与帮助文本矛盾。

## 设计 / 方案

1. `load_payload(allow_empty=False)`：`GITHUB_EVENT_PATH` 未设置时，
   `allow_empty=True`（`--body-file` / `--dry-run` 任一存在）返回 `{}`，否则仍
   `SystemExit`（workflow 调用路径不回归）。
2. 字段访问容错：`_pull = payload.get("pull_request") or {}`，`base_ref` / `head_ref` /
   `head_sha` 用 `.get()` 兜底；`event_pr_number` / `event_pr_title` / `event_pr_body`
   同样容错 —— 本地验证漏传 `--base-ref` 等不再 `KeyError`。

## 接口 / 行为变更

- `--body-file` / `--dry-run` + 无 `GITHUB_EVENT_PATH`：从 `SystemExit` 改为正常跑
  （字段由 `--pr-number` / `--base-ref` / `--head-ref` / `--head-sha` 显式提供）。
- 无 `--body-file` / `--dry-run` + 无 `GITHUB_EVENT_PATH`：仍 `SystemExit`（不回归）。

## 测试 / 验收

- `test_merge_cleanup.py::LocalValidationNoEventTest`（+3）：
  - `--dry-run` + 全显式参数 + 无 env ⇒ code=0，`[dry-run]` 输出正确。
  - `--body-file` + 无 env ⇒ code=0，读取文件内容。
  - 无 env 非本地模式（有 GH_TOKEN）⇒ 仍 `SystemExit`（不回归）。
- 全量 `python3 -m unittest discover -s scripts -p 'test_merge_cleanup.py'` 45 例全绿。
- **反向验证**（§5.6）：还原 `load_payload` 无条件 `SystemExit` ⇒
  `LocalValidationNoEventTest` 用例变红（本地模式被误杀）；还原全绿。

## 相关链接

- Issue：[#587](https://github.com/ShawnLiuSZ/task-dashboard/issues/587)
- 核查报告：`CODE-REVIEW-2026-11-17.md`（低危-7）
- 既有：#284（脚本初版）

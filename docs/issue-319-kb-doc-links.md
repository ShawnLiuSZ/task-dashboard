# Issue #319: 补全 #313/#314/#315 缺失的 KB 文档，修复 CHANGELOG 6 处断链

## 背景

`scripts/check-doc-links.py` 在 `main` 上持续失败：CHANGELOG.md / CHANGELOG.en.md 中 #313/#314/#315 的条目分别引用了 `docs/issue-313-remove-sepia.md`、`docs/issue-314-agent-tools.md`、`docs/issue-315-guide-text.md`，但这三篇 KB 文档**从未被创建**（对应合并提交只改了 CHANGELOG 文案，未建文档），共 6 处断链。这违反了 AGENTS.md「每修复必建知识库文档」的约定，也导致 CI 的文档完整性检查无法全绿。

## 设计 / 方案

不修改 CHANGELOG 既有的引用（链接目标文件名正确），而是**补齐缺失的三篇文档**，使链接指向真实存在的文件。三篇文档内容均依据 #313/#314/#315 的已合并改动（commit 信息 + i18n key）如实撰写，结构与既有 issue 文档一致（背景 / 实现 / 接口变化 / 验收 / 关联）。

| 新建文档 | 对应修复 |
|---|---|
| `docs/issue-313-remove-sepia.md` | #313 移除护眼模式，只保留浅色和深色 |
| `docs/issue-314-agent-tools.md` | #314 Agent 面板可用工具列表补全到 12 个 |
| `docs/issue-315-guide-text.md` | #315 接入指引文案更新（set_work_branch 触发时机 + work_dir 参数） |

## 接口 / 行为变更

- **无 schema / 无后端 / 无前端逻辑变更**：纯文档补全。
- 应用行为不受影响；仅修复仓库文档完整性。

## 测试 / 验收

- [x] `python3 scripts/check-doc-links.py` 通过（153 个 markdown 文件，0 断链 / 0 file:// / 0 行号锚点）
- [x] 三篇文档均存在且内容与各修复的实际改动一致
- [x] 未改动任何源码、i18n、schema

## 关联

- Issue: #319
- 修复的断链来源：#313 / #314 / #315 的 CHANGELOG 条目
- 新建文档：[issue-313-remove-sepia.md](./issue-313-remove-sepia.md) / [issue-314-agent-tools.md](./issue-314-agent-tools.md) / [issue-315-guide-text.md](./issue-315-guide-text.md)

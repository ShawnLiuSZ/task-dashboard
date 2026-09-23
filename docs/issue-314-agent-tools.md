# Issue #314: Agent 面板可用工具列表更新

## 背景

`AgentPanel` 的「可用工具」列表只列了 6 个看板工具，但 MCP Server 实际提供 **12 个工具**（7 个看板 + 5 个记事）。列表与真实能力不一致，agent 接入时看不到完整的工具集。

## 实现

### 工具表补全

`app/src/components/AgentPanel.tsx` 的 `TOOLS` 数组从 6 项扩展到 **12 项**，新增：

- `set_work_branch`：创建 / 切换分支后纠正工作分支（只写该列）
- 5 个记事工具：`list_notes` / `add_note` / `update_note` / `update_note_label` / `delete_note`

### i18n

新增 6 个 key（中文 + 英文各 6 处）：

- `agent.tools.setWorkBranch` — 创建/切换分支后纠正工作分支（只写该列）
- `agent.tools.notesList` / `notesAdd` / `notesUpdate` / `notesUpdateLabel` / `notesDelete` — 记事增删改查相关

### 文案

工具总述从「6 个看板工具」改为「12 个工具」。

## 接口 / 行为变更

- Agent 接入面板展示的工具表与 MCP Server 实际工具集对齐（12 个）。
- **无 schema / 无后端 / 无 MCP 协议变更**：纯前端 UI + i18n 改动，MCP 工具本身此前已存在，仅补文档。

## 验收

- [x] `TOOLS` 数组含 12 项（7 看板 + set_work_branch + 5 记事）
- [x] 6 个新 i18n key 中英文齐全
- [x] 工具总述文案已更新为「12 个工具」
- [x] `npx tsc --noEmit` 0 error
- [x] `npm test` 141 passed
- [x] `npm run build` 通过
- [x] `npm run i18n:check` 383 keys 一致
- [x] `npx prettier --check` 通过
- [x] `scripts/check-mcp-columns.py` 通过
- [x] `scripts/check-doc-links.py` 通过

## 关联

- Issue: #314
- PR: #314 合并提交（`e364c79`）

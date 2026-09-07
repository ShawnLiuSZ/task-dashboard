# issue-98：添加映射列时对已添加过的列置灰、禁止重复添加

> v0.3.42 修复 · 关联 [Issue #98](https://github.com/ShawnLiuSZ/task-dashboard/issues/98)

## 背景 / 动机

在设置面板「自定义列」为某个账号新建列、下选匹配的 Project status 时，目前可以重复选中**已被其它列选用**的 status，导致映射配置出现冗余/冲突，用户必须自行对比哪几个已被占用，体验差且易错。

需求：新建列时，已添加过的 status 选项**置灰**并**不可再次选中**；删除某列后其占用项恢复可选；置灰状态与当前映射实时同步。

## 设计 / 方案

改动集中在 [SettingsPanel.tsx](file:///Users/liushizhao/dev/dashboard/app/src/components/SettingsPanel.tsx)（纯前端，后端存储逻辑零改动）：

1. **新增解析辅助** `parseMatchRules`：把列的 `matchRules`（`JSON` 数组或旧版逗号分隔）解析成去重后的 status 字符串数组，供去重判定与既有列表展示复用。

2. **计算「已被其它列使用」集合** `usedElsewhere`（`useMemo` 派生）：
   - 遍历全部列，跳过**正在编辑的列自身**（`editingCol.index`），把其余列 `matchRules` 解析出的 status 并入集合。
   - 因此新建列（index = -1）时，所有既有列占用的 status 均视为不可选；编辑既有列时，允许保留它自己已占用的值。
   - 依赖 `columns` 与 `editingCol`，任何增删改 / 切列都实时重算。

3. **渲染与交互置灰**：status chips 中 `usedElsewhere.has(s) && !ruleChips.includes(s)` 视为 disabled —— 置灰度（`opacity`）、`cursor: not-allowed`、禁点；`title` 提示「已被其它列使用」。

4. **逻辑兜底**：`toggleRule` 对已被占用且未选中的值直接 `return`（同时覆盖「自由输入追加」路径 `addCustomRule` → `toggleRule`），保证不只能点、也绕不过去。

5. **取消占用**：删除某列即从 `columns` 移除 → `usedElsewhere` 相应收缩 → 该 status 恢复可选（满足「删除后恢复」。

### 关键权衡

- 去重以**跨列唯一**为约束，而非「全部唯一」：正在编辑的列自身允许保留既有选值，避免历史合法数据被误判为重复而无法保存。
- 校验放在交互层（前置禁止），不依赖保存时后端兜底，即时反馈、无静默失败。

## 接口 / 行为变更

- **无对外 API / Tauri command / MCP / DB schema 变更**。`AccountColumn.matchRules` JSON 数组格式不变，向后兼容。
- 仅新增一个 i18n key：`settings.customColumns.usedElsewhere`（zh-CN / en-US）。

## 数据 / Schema 变更

- 无。纯前端交互约束。

## 测试 / 验收

- `npm run i18n:check`：zh-CN / en-US 各 178 key，一致通过。
- `npx tsc --noEmit`：通过。
- `npm test`：vitest 3 例通过。
- 手动验收：
  1. 账号有 ≥2 个自定义列、某 status 已被列 A 占用：新建列 B 时该 status 置灰、不可点、不可经自由输入重复添加。
  2. 编辑列 A：其自身占用项仍可选/可移除，不被当成「重复」禁选。
  3. 删除列 A：该 status 在新建其余列时恢复可选。
  4. 切换账号加载各自列配置后，置灰状态正确重算。

## 相关链接

- Issue：[#98](https://github.com/ShawnLiuSZ/task-dashboard/issues/98)
- 代码：`app/src/components/SettingsPanel.tsx`（`parseMatchRules` / `usedElsewhere` / status chips）、`app/src/i18n/locales/{zh-CN,en-US}.json`
- CHANGELOG：`docs/CHANGELOG.md` v0.3.42
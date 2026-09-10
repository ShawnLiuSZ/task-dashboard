# custom 视图未匹配值提示（#165）

> 关联分支：`feature/issue-165-unmapped-hint`

## 背景 / 动机

custom 模式下任务归入自定义列依赖 matchRules 精确匹配 `project_status`。由于项目状态值是账号自定义的（中英混合、带 emoji），用户无法预知，漏配/错配后任务会全部落入「未标注」列，但界面上没有任何线索告诉用户「哪些状态值没被映射」，只能靠猜。

## 设计 / 方案

- 新增纯函数 `extractUnmappedStatuses(tasks)`（`app/src/components/Board.tsx`）：从**未匹配任务**中提取非空 `project_status`，去重 + 计数，按首次出现顺序返回。
  - 取「未匹配任务的 projectStatus」而非「project_statuses 表全量」，只提示用户当前真正受影响的状态值。
- 未标注列头下渲染 `.unmapped-hint` 提示条：显示前 3 个未映射值（含计数），超出显示 `+N`；hover 可看完整列表（`title` + `aria-label`）。
- 新增 i18n key：`board.unmappedHint`（zh「未映射」/ en「Unmapped」），扁平结构。
- 样式：橙色虚线边框 + 淡橙背景（警示但不刺眼），单行截断。

## 接口 / 行为变更

- Board 新增导出：`extractUnmappedStatuses`。
- 未标注列在存在未映射值时新增提示条；无未映射值（全部任务无项目状态）时无提示，行为与之前一致。

## 数据 / Schema 变更

无。

## 测试 / 验收

- [x] `unmapped-hint.test.ts` 4 例：去重计数、空值剔除、全空、空数组
- [x] `npm test` 7/7 通过、`npx tsc --noEmit`、`npm run i18n:check`（244 key 双语一致）
- [ ] 手工验收（custom 账号 + 未匹配任务）：未标注列显示「未映射：xx(n)…」，hover 看全

## 相关链接

- Issue：[#165](https://github.com/ShawnLiuSZ/task-dashboard/issues/165)
- 关联：custom 列分组语义见 [docs/issue-163-frontend-tests.md](./issue-163-frontend-tests.md)「确认过的一个设计语义」
- 分支：`feature/issue-165-unmapped-hint`

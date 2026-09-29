# issue-322 — 编辑记事文本框不随内容长度自适应高度

> 关联 issue：[#322](https://github.com/ShawnLiuSZ/task-dashboard/issues/322)
> 分支：`fix/issue-322-note-edit-autosize`（基于 `main` v0.6.4）
> 文档类型：缺陷修复（Issue 关联）

## 背景 / 动机

在记事本面板点击某条记事的编辑按钮（铅笔图标）进入编辑态时，编辑文本框
（`<textarea class="note-textarea">`）不会按已有内容的行数自动撑高，仅显示约 1 行
（CSS `min-height: 42px`），长内容需要框内滚动才能看全 / 编辑。

对比：进入编辑后继续输入字符，框体会随之增高——说明自适应逻辑本身可用，
只是「进入编辑态的初始测量」没生效。

## 设计 / 方案

编辑框高度由 `app/src/components/NotesPanel.tsx` 的 `useAutoSize(value)` 控制：用
`useEffect(..., [value])` 在内容变化时把 `el.style.height` 设为
`min(scrollHeight, 260)`，上限 260px。

**根因**：点击编辑时 `setEditingId(note.id)` 与 `setEditDraft(note.content)` 在同一批
更新中提交，`<textarea>` 在本轮才首次挂载，且带 `autoFocus`。`useEffect` 是被动副作用，
在浏览器绘制后、且元素已挂到 `overflow-y:auto` 的列容器（`.note-col-body`）中、被
`autoFocus` 滚动进可视区之后才执行。此时 `el.scrollHeight` 可能在列容器滚动位置 /
布局尚未稳定时被读取，导致内联 `height` 被留在 CSS 的 `min-height: 42px`，只有下一次
`value` 变化（输入 / 删除）才触发重测并撑高。即「挂载即预填长内容」场景的被动测量不可靠。

**修复**：
1. 把 `useEffect` 换成 `useLayoutEffect`——在 DOM 变更后、绘制前同步测量，避开列容器
   滚动 / 绘制时序干扰。
2. `useAutoSize` 新增 `active: boolean` 参数（调用处传 `editingId !== null`），
   依赖数组加入 `active`，使进入编辑态那一帧（而非仅 `value` 变化时）主动重测，
   确保挂载即预填的长内容也能被量到。
3. 把测量逻辑抽成 `resize`（`useCallback`），hook 返回 `{ ref, resize }`；
   编辑 textarea 改用 `ref={editRef.ref}`。

约束保持不变：上限 260px（`Math.min(el.scrollHeight, 260)`）、`min-height: 42px`
（`styles.css` `.note-textarea`）。

## 接口 / 行为变更

- 仅前端行为变更，无 Tauri command / MCP 工具 / API 变化。
- `useAutoSize(value: string)` → `useAutoSize(value: string, active: boolean)`，
  返回类型由 `RefObject<HTMLTextAreaElement>` 变为 `{ ref, resize }`。
- 进入编辑态：文本框首屏即按内容高度展开（≤260px）；输入过程中仍实时增高；超长封顶滚动。

## 数据 / Schema 变更

无。未触及 `tasks` 表或任何 SQLite schema。

## 测试 / 验收

- `app/src/components/notes-layout.test.ts` 新增 `记事本编辑文本框自适应高度（#322）`
  两个静态断言（vitest 无布局引擎，沿用「源码静态断言」思路）：
  - `useAutoSize` 函数体使用 `useLayoutEffect` 且不含被动 `useEffect` 测高；
  - `useAutoSize` 接收 `active` 参数、调用处为 `useAutoSize(editDraft, editingId !== null)`、
    编辑 textarea 挂 `ref={editRef.ref}`。
- 运行校验（均通过）：
  - `npx vitest run src/components/notes-layout.test.ts`（26 项全过，含新增 2 项）
  - `npx tsc --noEmit`
  - `npm run i18n:check`
  - `npx prettier --check "src/**/*.{ts,tsx,css}"`
  - `npm run lint`（18 警告，与基线一致，本改动未引入新警告）
- 真机验收（建议）：编辑一条多行记事，进入编辑态首屏即按内容高度展开；超长内容封顶 260px 滚动。

## 相关链接

- Issue：[#322](https://github.com/ShawnLiuSZ/task-dashboard/issues/322)
- 代码：`app/src/components/NotesPanel.tsx`（`useAutoSize`、编辑 `<textarea>`）、
  `app/src/styles.css`（`.note-textarea`）
- 回归测试：`app/src/components/notes-layout.test.ts`
- CHANGELOG：发版时在 `docs/CHANGELOG.md` 对应版本追加指向本文档的链接

# #470 备忘录编辑改为在 Modal 弹窗中完成

> 关联 issue：[#470](https://github.com/ShawnLiuSZ/task-dashboard/issues/470)
> 分支：`feature/issue-470-note-edit-modal`

## 一、背景 / 动机

用户需求原文：

> 备忘录 编辑时，也要在 modal 框中修改，不在原卡片上修改

改造前的形态是**两套并存**的：

| 入口 | 行为 | 载体 |
|---|---|---|
| 卡片右上角「查看」放大镜 | 打开**只读** Modal，看完整正文 | `NoteViewerModal`（#465） |
| 卡片页脚「编辑」铅笔 | **原卡片就地变成 textarea** | `NotesPanel` 里的 `editingId` 分支 |

即：**查看**进了弹窗，**编辑**还留在卡片上。

## 二、为什么行内编辑的形态不好

### 2.1 同屏混着两种高度差一个数量级的卡片

| 卡片形态 | 高度 |
|---|---|
| 只读（折叠） | `-webkit-line-clamp: 9` ⇒ **约 9 行**封顶 |
| 编辑中（textarea） | `useAutoSize` 自适应 ⇒ **可达 260px**（约 16 行） |

编辑中的卡片**没有折叠**（textarea 不受 `-webkit-line-clamp` 约束）⇒ 正文一多就把卡片撑到 260px。

### 2.2 瀑布流的列高由内容决定 ⇒ 单张高卡片把整列拉长

#462/#465 已定案的布局机制：

- `.notes-list` 是 **CSS multi-column** 容器，`height: auto`；
- 因此**列高 = 该列最高卡片的高度**；
- `break-inside: avoid` 恒生效（卡片不会被劈成两列）。

这在**纯阅读**状态下是优点（卡片按内容自然分布、底部参差小）。但一旦有卡片进入
**行内编辑**态并长到 260px：

- 那一列的高度被这张卡**单独撑到 260px**，其余卡片在该列底部留下大片空白；
- 三列之间的高度差被放大 ⇒ 底部参差比纯阅读状态明显得多；
- 用户滚动列表时，视线在「一张特别高的卡」与「一列短卡」之间来回跳。

### 2.3 「边看边改」要来回跳两个界面

想改一段文字，用户得：关掉查看弹窗 → 回到卡片 → 点铅笔 → （发现还是折叠的，看不全）→ 再点放大镜 → 再关 → 再点铅笔。

## 三、方案：编辑也进弹窗（与查看共用弹窗形态）

**编辑弹窗 `NoteEditorModal`（新增）**，与查看弹窗 `NoteViewerModal` 并列：

```
.notes-panel                (position: relative，遮罩宿主)
  .notes-scroll
    .notes-list             (多列容器)
      .note-card × N        ← 永远只有「折叠只读」这一种形态
  NoteViewerModal           (只读全文，#465)
  NoteEditorModal           (可编辑全文，#470)
```

⇒ **卡片形态恒定**，列表高度收敛，瀑布流列高一致。

编辑弹窗内部：

- 头部：标题「编辑备忘录」+ 关闭按钮；
- 中部：**多行 textarea**，承载**完整正文**（**不折叠** —— 折叠只发生在卡片上）；
- 底部：优先级色点 + 绝对时间戳；
- 底部操作区：提示（⌘/Ctrl + Enter 保存 · Esc 取消）+ 取消 / 保存按钮。

### 3.1 与查看弹窗的分工

| | `NoteViewerModal`（#465，只读） | `NoteEditorModal`（#470，可写） |
|---|---|---|
| 正文 | `.note-viewer-content`（`pre-wrap`，不折叠） | `.note-editor-textarea`（textarea，可编辑，不折叠） |
| 打开入口 | 卡片右上角放大镜 | 卡片页脚铅笔 |
| 操作 | Esc / 点遮罩 / 关闭按钮关闭 | ⌘/Ctrl+Enter 保存 · Esc 取消 · 取消/保存按钮 |
| 挂载位置 | `.notes-panel` 内部 | `.notes-panel` 内部（同一遮罩宿主） |

## 四、关键实现决策

### 4.1 弹窗挂在 `.notes-panel` 内部（不挂 App 层）

沿用 #465 的结论：`.notes-panel` 是 `position: relative` 的遮罩宿主，Modal 在此渲染
才能覆盖整个面板区域；挂到 App 层会被 `.main-content` 的 `overflow: hidden` **裁掉**。

### 4.2 Esc 走 window 级分层（`useWindowEscLayer`）

弹窗是**遮罩层**，拿不到焦点 ⇒ 元素级 `onKeyDown` 收不到 Esc 事件 ⇒ 必须用
`useWindowEscLayer`（#344 的分层机制，保证与其它弹窗的 Esc 不打架）。

**Esc = 取消编辑**（丢弃草稿、不落库），与行内编辑时代的语义一致，只是落点从卡片换成了弹窗。

### 4.3 `useAutoSize` 抽到 `utils/useAutoSize.ts`

改造后**两个地方**都要用自适应高度 textarea（编辑弹窗 + 新建弹窗 `NoteComposerModal`），
原先 `NotesPanel.tsx` 与 `NoteComposerModal.tsx` 各有一份**重复实现** ⇒ 抽公共模块。

`#322` 的教训保留：**必须用 `useLayoutEffect`**（DOM 变更后、绘制前同步测量），
不能用被动的 `useEffect` —— 后者的初始测量会被 `overflow-y:auto` 容器的滚动/绘制时序
干扰，框体停在 `min-height`，只有继续输入才撑开。

⚠️ `useEffect` 是 `useLayoutEffect` 的**子串** ⇒ 静态断言里必须精确匹配。

### 4.4 草稿与「保存中」状态放在弹窗内

弹窗自己持有 `draft` / `saving` / `error`：

- 保存失败 ⇒ **弹窗保持在编辑态**并展示错误（草稿不丢）；
- 面板只负责「落库 + 刷新列表」，抛错由弹窗兜住。

## 五、改动清单

| 文件 | 改动 |
|---|---|
| `app/src/components/NoteEditorModal.tsx` | **新增**：编辑弹窗（textarea + 保存/取消 + ⌘/Ctrl+Enter + Esc 取消） |
| `app/src/components/NoteEditorModal.test.tsx` | **新增**：8 条渲染回归 |
| `app/src/utils/useAutoSize.ts` | **新增**：自适应高度 hook（从 `NotesPanel.tsx` 抽出，消除与 `NoteComposerModal` 的重复） |
| `app/src/components/NotesPanel.tsx` | 移除行内编辑分支与 `useAutoSize`/`editDraft`/`saving` 状态；铅笔按钮改为 `setEditingId(note.id)` 打开编辑弹窗；挂载 `NoteEditorModal` |
| `app/src/styles.css` | 新增 `.note-editor-*` 系列样式；删除 `.note-card.editing` / `.note-edit-foot` / `.note-edit-actions` |
| `app/src/i18n/locales/zh-CN.json` / `en-US.json` | 新增 `notes.editModalTitle` |
| `app/src/components/notes-layout.test.ts` | #460「三态」改「两态」；#322 断言改指 `utils/useAutoSize.ts`；新增「编辑搬进弹窗（#470）」4 条 |
| `app/src/panel-wiring.test.ts` | 「NotesPanel 的 Esc 是取消行内编辑」改为「面板不再有行内编辑」；新增「编辑弹窗走 window 级 Esc 分层」 |

## 六、验证

- `vitest` **362 passed**（原 347，+15：新增 8 条弹窗渲染回归 + 4 条布局/接线 + 3 条改写后的既有断言）
- `tsc --noEmit` / `eslint --max-warnings 0` / `prettier --check` / `i18n:check`（418 key）/ `build` 全绿
- 纯前端改动（CSS + TSX + 测试 + i18n），后端 / DB schema / MCP 零改动

## 七、已知取舍

- **删除确认仍是行内态**（卡片变成「删除这条备忘录？」+ 按钮条）。它是**短文本 + 两个按钮**，
  高度与普通卡片同量级，不存在「编辑态高 260px vs 只读态 9 行」那种量级差 ⇒
  不在本次需求范围内，保持原样。
- 编辑弹窗**不带优先级选择器**（新建弹窗有）。改优先级走卡片页脚原有的标签按钮
  （点击循环切换），与改造前一致。

# #456 备忘录面板改为列表展示

> 关联 issue：[#456](https://github.com/ShawnLiuSZ/task-dashboard/issues/456)
> 分支：`feature/issue-456-notes-date-columns`

## 一、背景 / 动机

备忘录面板原本是**固定四列**（优先级：紧急 / 高 / 中 / 低）。分列在这个场景下有两个问题：

1. **纵向聚合价值低** —— 备忘录用完即弃、集中在最近几天，优先级分布并不构成有用的分组。
2. **挤占横向空间** —— 每列被锁死在 320px，卡片内容稍长就换行；同一屏放不下多少张卡片。

改为**列表展示**，网格参数与「任务会话」面板（`.sessions-list`）完全一致。

优先级仍有价值（决定颜色），因此从**分列依据**降级为**卡片标记**。

## 二、设计 / 方案

### 2.1 网格参数与「任务会话」同参

```css
/* .notes-list —— 与 .sessions-list 完全一致 */
display: grid;
grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
gap: 10px;
align-content: start;
```

效果：1180px 窗口排 3 列，900px（`minWidth`）降为 2 列，窄窗口自然变单列 —— 与任务会话面板的响应式行为一模一样。

### 2.2 卡片与 `.session-card` 同构

| 属性 | 值 |
|---|---|
| 背景 | `--surface-2`（面板是 `--bg`，保证卡片边界可见） |
| 圆角 | `10px` |
| 内边距 | `12px 14px` |
| 布局 | `flex` + `column` + `gap: 8px` |

`.note-content` 的 `margin-bottom: 4px` 归零 —— 间距已由 grid gap 与卡片内 gap 承担。

### 2.3 优先级颜色：整圈边框染色 + 标签色点

网格里**没有列头做视觉锚点**，优先级只能靠卡片自身传达。改动：

- **卡片边框染成优先级色**：`border: 1px solid var(--note-accent, var(--border))`
  —— 比仅靠 6px 色点更易扫视，网格排多列时尤其明显。
- 标签色点保留并加强：6px → 7px + `color-mix` 同色淡描边。

组件侧的 `--note-accent` 注入**保持不变**（原本就在用），只是原先只影响列顶横条与列头圆点，现在卡片边框也用它。

> ⚠️ **仍不用左侧色条**：`styles.css` 记录着「用户指定：卡片不再用左侧色条」（#259 时主动去掉），本次不推翻那个决定，只用整圈边框。

### 2.4 排序只用创建时间倒序

```ts
const sortedNotes = useMemo(() => [...notes].sort((a, b) => b.createdAt - a.createdAt), [notes]);
```

优先级**不再参与排序**，也不参与组织。最新写的在最前面。

### 2.5 回收的历史结构

| 移除项 | 说明 |
|---|---|
| `.notes-card-cols` | 分列容器 → `.notes-list` |
| `.note-col` / `--head` / `--title` / `--count` / `--dot` / `--body` / `--empty` | 列结构全套 |
| `--notes-col-w: 320px` | 列宽变量（网格列最小宽度已由 `minmax(320px,1fr)` 定义） |
| `notes.dateGroup.*` i18n 键 × 4 | 曾用于日期分列，现由统一排序取代 |

> 「僵尸 CSS」是分列改列表后最容易留的残留 —— 规则还在但没人用，日后改主题变量会误以为它在生效。测试里有专门断言锁住零残留。

## 三、接口 / 行为变更

| 对象 | 变更 |
|---|---|
| `NotesPanel.tsx` | `priorityColumns` / `dateColumns` / `sortedNotes`(旧) 全部移除；改用单一 `sortedNotes`；容器改 `.notes-list` |
| `styles.css` | 新增 `.notes-list`；`.note-card` 对齐 `.session-card`；移除 `.notes-card-cols` 与 `.note-col*` 全套 + `--notes-col-w` |
| i18n | 移除 `notes.dateGroup.*` × 4（回到 413 key） |

**编辑态、删除确认态、多选/优先级切换链路全部不变。**
**后端 / DB schema / MCP 工具集零改动。**

## 四、数据 / Schema 变更

无。

## 五、测试 / 验收

重写 `components/notes-layout.test.ts` 的布局 describe（10 条用例），核心是**与 `.sessions-list` / `.session-card` 逐项比对**：

| 测试 | 作用 |
|---|---|
| 网格参数与 `.sessions-list` 完全同参 | 从 `sessions` 规则里正则取出实际值再与 `notes-list` 比对，**防止日后两者漂移** |
| 列表容器是受约束的纵向滚动区 | `flex:1 1 auto` + `min-height:0` + `overflow-y:auto` + `overscroll-behavior:contain` |
| 旧分列结构零残留 | 组件无 `notes-card-cols`/`note-col`；样式表无对应规则；`--notes-col-w` 已清除 |
| 卡片与 `.session-card` 同构 | radius / padding / gap 逐项比对 |
| 优先级由卡片承载 | 边框取 `--note-accent` + 组件确实注入 + 色点加强 |
| 卡片仍无左侧色条 | #259 用户要求，防借改版之机加回来 |
| 排序只用时间倒序 | 断言 `b.createdAt - a.createdAt`、依赖数组、无 `prio:` 权重表、无分列 map |
| 空列表有占位提示 | 原先只有 loading 分支 |

另更新 `styles.test.ts:237` 的 `.notes-card-cols[aria-busy]` → `.notes-list[aria-busy]`。

### 渲染复核（无头 Chrome，隔离复现页）

`link` 同一份 `styles.css`，DOM 严格复刻组件，视口按 `tauri.conf.json`：

| 视口 | 读数 |
|---|---|
| 1180×760 | `横向溢出元素(0)`；`grid=3列`；`r=10px pad=12px 14px` |
| 900×560（minWidth） | `横向溢出元素(0)`；`grid=2列`；卡片 437px 不塌 |

### 已跑校验

```
npx vitest run                ✅（321 passed）
npx tsc --noEmit              ✅
npm run lint                  ✅（--max-warnings 0）
npx prettier --check          ✅
npm run i18n:check            ✅（413 key × 2 语种）
npm run build                 ✅
python3 scripts/check-doc-links.py   ✅
```

## 六、相关链接

- Issue：[#456](https://github.com/ShawnLiuSZ/task-dashboard/issues/456)
- CHANGELOG：[`docs/CHANGELOG.md`](./CHANGELOG.md)
- 参照实现：`SessionsPanel.tsx` + `.sessions-list` / `.session-card`
- 相关：#259（面板整页化 + 四列来源，本次继承其「不得挂行内宽度」约束）、#447（创建入口改 Modal）
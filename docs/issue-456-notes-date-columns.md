# #456 备忘录面板改为按添加日期横向分列

> 关联 issue：[#456](https://github.com/ShawnLiuSZ/task-dashboard/issues/456)
> 分支：`feature/issue-456-notes-date-columns`

## 一、背景 / 动机

备忘录面板原本按**优先级**（紧急 / 高 / 中 / 低）分成固定四列。实际使用中这个维度价值不高：

- 备忘录用完即弃，绝大多数集中在最近几天，优先级分布并不构成有用的纵向聚合。
- 真正关心的是「什么时候写的」—— 最近写的在左边一眼可见，旧的沉到右侧。

优先级仍有价值（决定颜色），因此从**分列依据**降级为**卡片标记**：颜色一点不变，只是不再用来分列。

## 二、设计 / 方案

### 2.1 分组粒度：相对时间段（今天 / 昨天 / 本周 / 更早）

三种候选对比：

| 方案 | 问题 |
|---|---|
| 按自然日分列 | 三个月前的一条备忘会让中间几十列全空，靠横向滚动找内容 |
| 按自然月分列 | 列数少，但近期任务区分度低（本月全挤一列） |
| **相对时间段** ✅ | 列数恒定 4，横向布局稳定，无需滚动找内容 |

`week` 组以**本周一 00:00** 为起点（符合中文语境）。

### 2.2 判据用本地日历日，不用固定秒数偏移

```ts
// ❌ 固定阈值：昨天 23:50 → 今天 00:10 只隔 20 分钟，会被判成「今天」
if (diff < 86400) return 'today';

// ✅ 本地日历日：按 Date 的年月日零点计算
const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
```

这是本组测试的核心防线（见 §5 反向验证）。

### 2.3 列序：从新到旧

`DATE_GROUP_ORDER = ['today', 'yesterday', 'week', 'earlier']`

与看板的「待处理 → 已完成」方向**相反**，这是刻意的：备忘录关心「刚写了什么」，不是「还剩什么」。

### 2.4 只渲染非空列

`groupNotesByDate` 返回只含非空列的结果。优先级四列时代无论有无内容都渲染（显示「暂无」），
日期列时代若沿用该行为，稀疏数据下会出现大量空列。

### 2.5 状态颜色：从列头移到卡片

| 位置 | 变化 |
|---|---|
| 列顶 `border-top: 3px solid var(--col-accent)` | **移除** —— 日期列没有「优先级」可言 |
| 列头 `.note-col-dot` 彩色圆点 | **移除** —— 同上 |
| 列边框 | 改为 `0.5px solid var(--border)`，保持列的包围感 |
| 卡片 `.note-tag .note-dot` | **保留并加强**：6px → 7px + 同色淡描边（`color-mix`） |

>⚠️ **未新增卡片左侧色条**：`styles.css` 里有一条注释「用户指定：卡片不再用左侧色条
> 区分优先级」（#259 时用户主动去掉的）。本次不推翻那个决定，只加强既有的标签色点。

`--col-accent` 的注入点（组件行内 `style`）一并删除。

### 2.6 `now` 存 state 而非渲染时调`Date.now()`

分组是纯函数、依赖显式时间戳。这样才能在测试里注入固定时刻验证日期边界，
也让「分组结果」成为可复现的纯函数。

## 三、接口 / 行为变更

| 对象 | 变更 |
|---|---|
| `utils/noteDateGroups.ts` | **新增**。`dateGroupOf` / `groupNotesByDate` 纯函数 |
| `NotesPanel.tsx` | `sortedNotes` / `priorityColumns` 移除；改用 `dateColumns`；列渲染改为 `note-col--${col.key}`；不再注入 `--col-accent` |
| `styles.css` | `.note-col` 去掉色条横条改普通边框；`.note-col-dot` 规则删除；`.note-dot` 加强 |
| i18n | 新增 `notes.dateGroup.{today,yesterday,week,earlier}` × 2 语种（413 → 417） |

**切换优先级的交互链路完全不变**（`handleLabelChange` → `loadNotes` → 卡片色重算）。

**后端 / DB schema / MCP 工具集零改动。**

## 四、数据 / Schema 变更

无。

## 五、测试 / 验收

新增 `utils/noteDateGroups.test.ts`（15 例）+ 更新 `components/notes-layout.test.ts`（3 条固化旧结构的断言）。

| 测试 | 作用 |
|---|---|
| `dateGroupOf` 今天/昨天/本周/更早 | 基本归类 |
| `昨天 23:50 → 今天 00:10` | **跨日边界**：20 分钟间隔必须分属两天 |
| `周日作为周界` | `getDay()===0` 归一为 7 的必要性 |
| `ts<=0 归入更早` | 未知时间不丢弃（DB `created_at` 默认可为 0） |
| 列序固定（输入乱序结果一致） | 防渲染抖动 |
| 列内倒序 | 最新在上 |
| 空列不返回 | 不渲染「暂无」占位 |
| 反向验证 × 3 | 固定 86400 偏移 / 列序倒置 / 列内升序 |

### 反向验证：1 处变异 → 3 个测试失败，捕获

| 变异 | 捕获 |
|---|---|
| 日历日判据 → 固定 `diff < 86400` | `跨日边界的 20 分钟也必须判昨天`、`列顺序从新到旧`、`固定 86400 偏移的实现会在跨日边界判错` |

### 渲染复核（无头Chrome，隔离复现页）

DOM 结构严格复刻组件、`link` 同一份`styles.css`、视口按 `tauri.conf.json`（1180×760）。

| 视口 | 结论 |
|---|---|
| 1180×760 | 四列正常，`borderTop=0.5px rgba(0,0,0,0.11)`（色条已移除），容器 `1180/1316 ox=auto` |
| 900×560（minWidth） | 列宽保持 320px 不塌、卡片正常换行、`headH=31` 四列一致 |

> 复现页首次截图时列未拉满，是复现页缺 `height: 100vh` 所致（真实应用 `.notes-page` 由主区flex 撑满），
> 非代码缺陷 —— 补上后确认正常。

### 已跑校验

```
npx vitest run                ✅（340 passed，原 324）
npx tsc --noEmit              ✅
npm run lint✅（--max-warnings 0）
npx prettier --check          ✅
npm run i18n:check            ✅（417 key × 2 语种）
```

## 六、相关链接

- Issue：[#456](https://github.com/ShawnLiuSZ/task-dashboard/issues/456)
- CHANGELOG：[`docs/CHANGELOG.md`](./CHANGELOG.md)
- 相关：#259（面板整页化 + 四列几何，本次的列宽/滚动/边框全部继承）、#447（创建入口改Modal）
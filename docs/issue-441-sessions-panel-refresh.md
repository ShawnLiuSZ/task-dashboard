# Issue #441：任务会话面板打开后不刷新（切走再切回才更新）

## 背景 / 动机

用户报告：「任务会话，第一次打开，不会刷新，需要在切一次其他页面然后在切回来才会刷新」。

现象精确描述为：面板**已经打开**的情况下，agent 通过 MCP 开工（`record_session`）或收工（`clear_session`）后，会话列表毫无变化；只有切走再切回（组件卸载后重新挂载）才看到新数据。

**为什么这是个真缺陷而不是「刷新频率低」**：会话面板的全部价值就是「一览当前同时在做哪几个任务」（#287 的原始设计动机）。它是一个**监控面板**，而监控面板显示陈旧快照比不显示更糟——用户会据此误判「这个任务没人做」，进而做出错误决策（重复开工 / 错误交接）。

## 根因

`SessionsPanel.tsx` 原先只有一个数据加载入口：

```tsx
const loadSessions = useCallback(async () => { ... }, [accountId]);

useEffect(() => {
  void loadSessions();
}, [loadSessions]);
```

`[loadSessions]` 的依赖是 `accountId`。**不切账号 ⇒ `loadSessions` 引用不变 ⇒ effect 不再触发**。也就是说，面板挂载后只在两种情况下重查：① 切换账号；② 切走再切回（重新挂载）。

对比同项目的 `App.tsx` 看板列表，它有**五路**刷新（`onSynced` / `onTasksChanged` / focus / visibilitychange / 20s 轮询），并在代码注释里写明了理由（#181）：

> 外部写入（MCP 独立进程直写 SQLite，发不出事件）靠这个跟进：窗口聚焦 / 可见性恢复即时重查 + 20s 轮询兜底。

`SessionsPanel` 从未获得这套接线。**MCP 是独立进程直写 SQLite，发不出 Tauri 事件**——这是关键约束：即使加了 `onSynced` / `onTasksChanged` 订阅，也只能覆盖本进程写入，覆盖不了 agent 侧写入。

## 设计 / 方案

照搬 `App.tsx` 的三路刷新（缺一不可），叠加 `NotesPanel` #329 的「首屏 / 后台刷新分离」避免闪屏。

### ① 三路刷新接线

| 通道 | 覆盖场景 | 为何必须有 |
|---|---|---|
| `onSynced` | 本进程触发的同步完成（顶栏 / 托盘 / 定时） | 同步会改 `issue_state` / `project_status`，卡片文案需跟进 |
| `onTasksChanged` | 本进程 GUI 写入（详情页记会话 / 清会话） | 同窗口多面板一致 |
| focus / visibilitychange / 20s 轮询 | **MCP 独立进程直写 SQLite** | 唯一能覆盖 agent 侧开工 / 收工的通道 |

`listen()` 返回 `Promise<unlisten>`，React cleanup 不能返回 Promise（否则快速重订阅会短暂双订阅）⇒ 用 `cancelled` 标记 + 闭包持有 unlisten（与 `App.tsx` 同款写法）。

### ② 依赖数组必须是 `[loadSessions]` 而非 `[]`

若写成 `[]`，订阅会永久捕获首次渲染的 `accountId` ⇒ 切账号后新增会话不出现、已删除会话不消失，且**表面看是「刷新了但数据不对」**，比原缺陷更难定位。

### ③ 首屏 / 后台刷新分离（照搬 NotesPanel #329）

会话面板刷新频率远高于记事面板（20s 一次 + 事件触发）。若每次重查都 `setLoading(true)`，卡片列表会**每 20 秒整块闪成「加载中」占位**——这是修一个 bug 引入另一个更烦的 bug。

改为：`loadedOnce` ref 记录是否已完成首查，首查用 `loading` 占位，后续只置 `refreshing`，容器加 `aria-busy` 由 CSS 降透明度反馈。

### ④ 监听器 / 定时器全量清理

漏移除 ⇒ 面板反复挂载累积 N 个定时器与 N 组监听，查询量线性放大。在 20s 轮询下这个放大效应尤其明显（用户反复切页时会打满 SQLite）。

## 接口 / 行为变更

### 前端行为

| 项 | 变更 |
|---|---|
| 会话面板打开期间的刷新 | **新增**：事件 + focus + 20s 轮询三路 |
| 后台刷新视觉反馈 | **新增**：容器 `aria-busy` 降透明（`.sessions-content[aria-busy] { opacity: 0.65 }`）+ `opacity` 过渡 |
| 首屏加载 | 不变（仍用 `notes-loading` 占位） |
| 后端命令 / SQL | **零改动** |
| 数据库 schema | **零改动** |
| i18n | **零改动**（未新增 key） |

### 样式

- `.sessions-content` 新增 `transition: opacity 0.15s ease`（降透明不硬跳变）。
- 新增 `.sessions-content[aria-busy] { opacity: 0.65 }`，与 `.notes-card-cols[aria-busy]` 同款。

## 测试 / 验收

### 新增回归（`app/src/sessions-panel.test.ts`，8 例）

逐路锁定刷新接线，任一路被删即失败：

1. 订阅 `onSynced` + `onTasksChanged`（含 import 语句本身）
2. unlisten 在 cleanup 释放（`cancelled` 标记 + `unlistenSynced?.()` / `unlistenTasks?.()`）
3. 回调真正触发重查（`refresh` / `onFocus` / `addEventListener`）
4. 20s 轮询存在 + 三处 removeEventListener / clearInterval
5. 首屏/后台分离（`loadedOnce` + `aria-busy`）
6. 依赖数组是 `[loadSessions]` 而非 `[]`

### 新增样式回归（`app/src/styles.test.ts`，2 例）

`decls('.sessions-content[aria-busy]')` 含 `opacity`；`decls('.sessions-content')` 含 `transition: opacity`。

### 反向验证（mutation，4/4 捕获）

| 注入的变异 | 捕获 |
|---|---|
| `onSynced(refresh)` → 换成空 Promise | ✅ |
| `setInterval(refresh, 20000)` → `const timer = 0` | ✅ |
| 刷新 effect 依赖改 `[]` | ✅ |
| （组合变异后effect 正则取不到） | ✅ |

### 全量校验

- `vitest` **290 passed**（22 文件；新增 8）
- `tsc --noEmit` 0 错 · `eslint --max-warnings 0` 0 警告 · `prettier --check "src/**/*.{ts,tsx,css}"` 全绿
- `npm run i18n:check` 401 key 一致 · `npm run build` 通过

### 边界场景

| 场景 | 期望 |
|---|---|
| 面板打开时 agent 开工 | ≤20s 内新卡片出现，无需切页 |
| 面板打开时 agent 收工 | ≤20s 内卡片消失 |
| 反复切换面板 50 次 | 定时器 / 监听器不累积（cleanup 全量移除） |
| 切账号后外部写入 | 用**新** accountId 查询（依赖数组守） |
| 窗口最小化 | `document.hidden` 时跳过轮询查询，不占资源 |
| 后台刷新时 | 卡片列表不闪「加载中」，仅降透明 |

## 相关链接

- 源issue：用户报告「任务会话，第一次打开，不会刷新」
- 相关：#181（App 看板的外部写入跟进机制，本次照搬）、#329（NotesPanel 首屏/后台分离）、#287（会话面板原始设计）、#391（会话多选删除）
- 代码：`app/src/components/SessionsPanel.tsx`、`app/src/styles.css`（`.sessions-content`）
- 回归：`app/src/sessions-panel.test.ts`、`app/src/styles.test.ts`
- CHANGELOG：[`CHANGELOG.md`](./CHANGELOG.md)
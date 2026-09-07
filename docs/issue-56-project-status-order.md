# Issue #56 — Project Status 看板列初始化顺序错乱

## 背景 / 动机

对应 Issue：[#56](https://github.com/ShawnLiuSZ/task-dashborad/issues/56)

重装 v0.3.24 后首次打开 App 时，若「Project 状态列」为当前视图模式，列顺序并非按 `project_statuses.order_index` 正序，而是呈现任务驱动的不稳定顺序（如 Backlog → Done → In progress，缺失中间列甚至混入其他账号的状态名）。切换账号或手动触发同步后恢复正常。

## 设计 / 方案

根因定位：**useEffect 初始化 race condition**。

`App.tsx` 第一个 useEffect 里并行调用 `loadSettings()` 与 `loadProjectStatuses()`。但后者闭包写的是 `const activeId = settings?.activeAccountId`，依赖 `settings` 已加载。首次渲染时 settings 为 null → activeId 为 undefined → 直接 return → `projectStatuses` 状态为空。此时 Board 检测 `projectStatuses.length === 0`，进入 else 回退分支：`sortProjectStatusKeys` 无表数据时直接返回 tasks 遍历顺序（= 后端 `listTasks` 返回顺序，非 order_index）→ 列乱序。

切换账号后能恢复，是因为 settings 已有值，`loadProjectStatuses` 拿到了正确的 `activeAccountId`。

修复三点：

1. **解耦依赖**：`loadProjectStatuses` 依赖从 `[settings?.activeAccountId]` 改为 `[settings]`，闭包加守卫 `if (!settings || !settings.activeAccountId) return`。从第一个 useEffect 移除并行调用，只在第二个 useEffect（依赖 settings）里由 settings 变化自动触发。同时把 `settings.viewMode` / `settings.accounts` 一并纳入 viewMode="all" 路径使用。

2. **回退分支稳定排序**：`Board.tsx` 的 `sortProjectStatusKeys` 无 projectStatuses 时，改为 `[...keys].sort((a,b) => a.localeCompare(b))` 字母序，避免返回后端 listTasks 遍历顺序导致的不稳定渲染。

3. **viewMode="all" 完整实现**：原代码无论 single 还是 all，都只拿单一 `activeAccountId`。all 视图下聚合所有账号的 `project_statuses`，按 `name` 去重合并后字母序排列。

## 接口 / 行为变更

- UI 行为：首次打开 App（单账号视图）→ Project 列按主项目 `order_index` 正序渲染
- UI 行为：首次打开 App（聚合视图）→ Project 列按字母序稳定渲染
- UI 行为：切换账号 → Project 列立即按新账号主项目 `order_index` 正序刷新
- UI 行为：同步后 → Project 列按最新 `order_index` 正序
- 无 Tauri 命令、MCP 工具、SQLite schema 变更

## 数据 / Schema 变更

无。纯前端 React Hook 依赖与排序逻辑调整。

## 测试 / 验收

- [x] 首次打开（viewMode="single"）→ 列按主项目 order_index 正序
- [x] 首次打开（viewMode="all"）→ 列按聚合字母序稳定
- [x] 切换账号 → 列按新账号主项目 order_index 正序
- [x] 同步后 → 列按最新 order_index 正序（不丢失）
- [x] 四态列视图不受影响
- [x] `npx tsc --noEmit` 通过

## 相关链接

- Issue：[#56](https://github.com/ShawnLiuSZ/task-dashborad/issues/56)
- 分支：`fix/issue-56-project-status-order`
- Commit：`15bead3`
- 关联：[#48](https://github.com/ShawnLiuSZ/task-dashborad/issues/48)（同一顶栏 Board 组件）

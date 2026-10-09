# 账号视图筛选失效：切换账号后仍显示全部账号（#422）

> 关联issue：<https://github.com/ShawnLiuSZ/task-dashboard/issues/422>
> 影响面：账号筛选（前端状态机 + 后端查询），影响任务列表、看板列、任务会话面板

---

## 背景 / 动机

用户报告：**在侧边栏点某个账号后，任务列表仍把所有账号的任务都列出来，且project.status（GitHub Project 状态）把所有账号的状态也都列了出来。**

本机生产库实测（只读查询）：

```
active_account_id = '5'
view_mode         = 'all'      ← 关键
account 4 = 213 任务/ account 5 = 486 任务（合计 699）
```

`view_mode` 停在 `all`（聚合模式），而 `active_account_id` 指向账号 5 ——
**两个字段各说各话**，界面表现就是「高亮了账号 5，却显示 699 条全部任务」。

## 根因

三个缺陷叠加，**主因只有一个**。

### 主因：切换账号不重置 `view_mode`（`App.tsx`）

`handleSwitchAccount` 原本只写`active_account_id`：

```tsx
await api.setActiveAccount(id);
await loadSettings();
await loadWith(ownership, id);   // 这一次查询是对的
```

而 `accountFilter` 由 `viewMode` 决定：

```ts
settings.viewMode === 'all' ? 0 : settings.activeAccountId
```

于是切换后 `filterRef.current.accountId` 被刷成 `0`，**20 秒后**的定时刷新 /
窗口聚焦 / `onSynced` 事件触发 `load()` → `loadWith(ow, 0)` → 后端把 `Some(0)`
解析为「聚合全部账号」⇒ 列表变回全部 699 条。

**这解释了「切换后短暂正确、随后变回全量」的关键现象** —— 也解释了为什么两个症状同时出现。

### 缺陷 2：`Some(0) => None` 语义塌缩（`commands.rs::rows_to_tasks`）

```rust
match account_filter {
    Some(0) => None,                    // 聚合
    Some(n) => Some(n),
    None => if active_account_id > 0 { Some(active_account_id) } else { None },
}
```

`0`（显式聚合）与 `None`（未指定）映射到同一个 `None`，无法区分；且 `None` 分支在
`active_account_id <= 0` 时也退化为全量。前端若把「无账号」传成 `0`，单账号视图会
静默退化成聚合。

### 缺陷 3：Sidebar 高亮误导（`Sidebar.tsx`）

```tsx
const active = nav === 'board' && a.id === activeAccountId;
```

聚合模式下**仍高亮被点的账号**，用户深信处于单账号视图 —— UI 在主动误导。

### project.status 为何也混合

status 的**值**随任务行一起过滤（正常）；但**列清单**是另一次独立查询
`listProjectStatuses(accountId)`（`App.tsx` 聚合分支），逐账号拉取后用 `Map`
跨账号去重合并 ⇒ 账号 4 的 `Backlog` / `In review` 混进账号 5 的看板。

**这是必要区分**：任务与status 值同过滤，status 列集合另取。

## 设计 / 方案

| # | 位置 | 改动 |
|---|---|---|
| 1 | `App.tsx::handleSwitchAccount` | `setActiveAccount` 后显式 `setViewMode('single')`（幂等短路） |
| 2 | `App.tsx::accountFilter` | 单账号分支对 `activeAccountId > 0` 校验，非法值回传 `null` 而非 `0` |
| 3 | `App.tsx::handleSwitchView` | 切回 single 时同样不把 `<= 0` 传成 `0` |
| 4 | `Sidebar.tsx` | 新增 `viewMode` prop；聚合模式下不高亮任何单个账号 |
| 5 | `commands.rs::list_active_sessions` | 补`account_id` 过滤，遵守与 `list_tasks` 同口径 |

### 关键决策

**为什么切账号要强制切视图模式**

「点某个账号」的用户意图就是「只看这个账号」。视图模式是另一个正交开关
（工具栏可切聚合），但账号切换时保留聚合态会让两个入口语义冲突 ——
用户点账号却得到聚合结果，这本身就是设计缺陷。强制切回 single 是让入口语义一致。

**为什么 `accountFilter` 回 `null` 而不是 `0`**

后端 `Some(0)` 已占用为「聚合」语义（`rows_to_tasks` 与 `list_active_sessions`
共用）。前端若把「无账号」也编码成 `0`，语义就撞了。回 `null` 让后端走
「读 `meta.active_account_id`」分支，语义保持单一。

**为什么 `list_active_sessions` 在Rust 侧过滤而非SQL**

会话表经`task_mapper` 映射成 `Task` 后已有 `account_id` 字段，加 `WHERE`
需要额外绑定参数；该命令原本就没有任何 `account_id` 参数，加参数会改变命令签名。
在 Rust 侧按 `t.account_id == id` 过滤保持了与 `list_tasks` 一致的语义，
且改动面最小。**代价**：全量行仍被读入内存再过滤 —— 会话表数据量小（本机 699 行
量级），可接受。

## 接口 / 行为变更

- **Tauri command 签名变更**：`list_active_sessions` 新增 `account_id: Option<i64>` 参数。
  Tauri v2 的 `invoke` 侧 camelCase 映射成立，**不破坏兼容**（缺参数时为 `None`，
  行为等同旧版全量）。
- **UI 行为变更**：
  - 点侧边栏账号 ⇒ 自动切回单账号视图（此前可能停留在聚合）
  - 聚合视图下侧边栏不高亮任何单个账号
  - 任务会话面板按当前账号过滤，不再跨账号混列

## 数据 / Schema 变更

**无。** 不涉及 SQLite schema、不涉及 `SELECT_COLS`、不涉及 MCP 双实现
（`mcp.rs::tool_list` 无账号参数是**设计如此**，MCP 工具不暴露账号维度）。

## 测试 / 验收

新增 `app/src/account-filter.test.ts`，15 例静态断言（`?raw` 读源码，
遵循 §2.5 不引入 jsdom / testing-library）：

- 切换账号必须 `setViewMode('single')`，且**顺序**在 `loadSettings` 之前
- `accountFilter` 单账号分支有 `> 0` 校验、非法值回 `null`
- `handleSwitchView` 不得出现 `activeAccountId ?? 0`
- Sidebar 有 `viewMode` prop、默认值 `'single'`、高亮条件排除聚合
- `SessionsPanel` 接收 `accountId` 并透传；`loadSessions` 依赖含 `accountId`
- 后端 `list_active_sessions` 有 `account_id` 参数 + `Some(0) => None` + `t.account_id == id`

### 反向验证

注入 **5 处变异**（删掉 `setViewMode` 调用、把 `> 0 ? : null` 改回 `?? 0`、
去掉 Sidebar 的 `viewMode !== 'all'`、SessionsPanel 不传 `accountId`、
后端 `Some(id) => t.account_id == id` 改成 `Some(_) => true`）：

```
MUTATION_TEST_EXIT=1     # 6 failed | 9 passed (15)
```

5 处变异被6 条断言全部捕获，恢复后 15 passed。

### 本地全量验证

| 项 | 结果 |
|---|---|
| `npm test -- --run` | **276 passed**（22 文件，原 261） |
| `cargo test --lib` | 178 passed |
| `npm run lint` | 0 警告（`--max-warnings 0`） |
| `npx tsc --noEmit` | 通过 |
| `npx prettier --check` | 通过（`--write` 修过 App/Sidebar/新测试） |
| `npm run i18n:check` | 397 key（无新增） |
| `cargo fmt --check` | 干净 |
| `cargo clippy --all-targets -p taskboard -- -D warnings` | 0 警告 |

## 遗留 / 后续

- **本机库仍有脏值 `view_mode='all'`**。修复后点任意账号即切回 single，
  但若用户启动即处于聚合态且从不点账号，仍是聚合视图 —— 这是**设计意图**，
  不需清理。
- **`Some(0)` / `None` 的双重语义**是治本议题：更彻底的方案是把「聚合」从魔法值 `0`
  改为显式 `all_accounts: bool`，消除 `None` / `0` / `active<=0` 三重歧义。
  本次用「前端不传 0 给非法值」在边界处收口，未改后端签名（兼容性考虑）。

## 相关链接

- Issue：<https://github.com/ShawnLiuSZ/task-dashboard/issues/422>
- 会话面板账号过滤：本次一并修复（`list_active_sessions` 原本完全无账号过滤）
- 方法论：[`methodology-assertion-strength-audit.md`](./methodology-assertion-strength-audit.md)
- CHANGELOG：[`CHANGELOG.md`](./CHANGELOG.md) / [`CHANGELOG.en.md`](./CHANGELOG.en.md)
# issue-99：看板列展示方式改进（每账号配置 / 移除顶栏切换 / 卡片 status 徽章）

> v0.3.43 · 关联 [Issue #99](https://github.com/ShawnLiuSZ/task-dashboard/issues/99)

## 背景 / 动机

原看板展示方式（`status` 四态 / `project` Project Status / `custom` 自定义列）是**全局唯一**配置，顶栏右侧有切换下拉。问题：

1. 切换账号后展示方式不随之改变，多账号各需不同列布局时只能反复手动切。
2. 顶栏承担了「展示方式」这一本属「配置偏好」的入口，与设置面板职责重叠。
3. 自定义列视图下只能靠列标题猜任务的 `project.status` 真实值，信息不透明。

本次把「列展示方式」收归**每账号**配置：在设置面板按账号选择，顶栏下拉移除；自定义列视图下任务卡片右上角显示 `project.status` 徽章。

## 设计 / 方案

### 数据：每账号展示方式存于 `meta` 表

遵循「不改动既有表结构」约束，复用现成的 `meta(key,value)` 键值表，新建 key 规约：

- key：`board_mode:<account_id>`
- value：`status` / `project` / `custom`，未配置默认 `project`

新增 db 层（[db.rs](file:///Users/liushizhao/dev/dashboard/app/src-tauri/src/db.rs)）：
- `account_board_mode_key(id)` / `get_account_board_mode(conn, id)`（空则 `project`）/ `is_valid_board_mode(mode)` / `set_account_board_mode(...)`（校验：非法值拒绝写入）
- `Account` 结构体新增 `board_mode` 字段，`list_accounts` 逐账号填充（前端一并拿到每账号模式）。

### 同步按账号取模式

[sync.rs](file:///Users/liushizhao/dev/dashboard/app/src-tauri/src/sync.rs)：`sync::run` 原来读全局 `meta.board_mode` 一次并透传给所有账号；改为在每个账号循环里读 `get_account_board_mode(conn, account.id)`，确保 `custom` 映射（`col_key` 写入）只对「该账号自己的模式为 custom」生效。

### API / 命令

- **移除** 全局 `set_board_mode` 命令及 `Settings.board_mode` 字段。
- **新增** `set_account_board_mode(account_id, mode)`：[commands.rs](file:///Users/liushizhao/dev/dashboard/app/src-tauri/src/commands.rs) 先校验账号存在，再 `db::set_account_board_mode`（含合法值校验）。注册到 `invoke_handler`（[lib.rs](file:///Users/liushizhao/dev/dashboard/app/src-tauri/src/lib.rs)）。
- `get_settings` 不再返回全局 boardMode；前端从 `accounts[].boardMode` 取激活账号模式。

### 前端

- 顶栏看板列切换下拉**移除**（[App.tsx](file:///Users/liushizhao/dev/dashboard/app/src/App.tsx)）。
- 有效展示方式 = 激活账号的 `boardMode`，缺失/聚合视图回退 `project`：
  `accountMap.get(activeAccountId)?.boardMode ?? "project"`。
- 设置面板「自定义列」tab 顶部新增「看板列展示方式」：账号下拉 + 模式下拉，切换即 `set_account_board_mode` 落库；关闭设置面板时 App 重载 settings，看板即时生效。
- 自定义列视图的任务卡片右上角显示 `project.status` 徽章：[TaskCard.tsx](file:///Users/liushizhao/dev/dashboard/app/src/components/TaskCard.tsx) 新增 `showGhStatus` 属性（仅 Board custom 分支传入）；按 `gh_status` 稳定哈希 → 复用 `repo-N` 20 色系，同状态同色。

### 关键权衡

- 「每账号」用 `meta` KV 而非给 `accounts` 表加列：零 schema 迁移、向后兼容。
- 聚合视图（`viewMode=all`，UI 暂隐藏）无法表达单一账号模式，统一回退 `project`。
- 旧版用户若曾在顶栏全局设过 `custom`，升级后需在设置里为该账号重设（未做自动迁移，保持默认 `project` 语义清晰）。

## 接口 / 行为变更

- **移除** Tauri 命令 `set_board_mode`；**新增** `set_account_board_mode(account_id, mode)`。
- `get_settings` 返回值：移除 `board_mode` 顶层字段；`accounts[]` 各元素新增 `boardMode`。
- i18n：新增 `settings.boardModeDesc`（zh/en）；复用既有 `settings.boardModeTitle/*/Project/Custom` 与 `card.ghStatusTitle`。
- 行为：顶栏不再可切换展示方式；切换账号自动按该账号模式展示；自定义列卡片显示 status 徽章。

## 数据 / Schema 变更

- 无表结构变更。仅 `meta` 表新增按账号 key `board_mode:<id>`（复用既有表）；`accounts` 表结构不变。

## 测试 / 验收

- `cargo check` / `cargo test --lib`：新增 `account_board_mode_defaults_and_validates`（默认值、按账号隔离、非法值拒绝）—— 与既有 23 例合计 24 例通过。
- `npm run i18n:check`：zh/en 各 179 key。
- `npx tsc --noEmit`、`npm test`（vitest 3 例）：通过。
- 手动验收：
  1. 设置面板按账号 A/B 各选不同展示方式，关闭后看板按当前激活账号展示。
  2. 顶栏切换账号（单账号视图）→ 看板列随之切换为对应账号模式。
  3. 顶栏已无展示方式下拉。
  4. 账号设为 `custom`：任务卡片右上角显示 `project.status` 彩色徽章；空状态不显示。
  5. 同步后 `custom` 列映射仅对自身模式为 custom 的账号写入 `col_key`。

## 相关链接

- Issue：[#99](https://github.com/ShawnLiuSZ/task-dashboard/issues/99)
- 代码：`app/src-tauri/src/db.rs`、`sync.rs`、`commands.rs`、`lib.rs`；`app/src/components/{App,Board,SettingsPanel,TaskCard}.tsx`、`app/src/{types,api}.ts`
- CHANGELOG：`docs/CHANGELOG.md` v0.3.43
# #276 每日自动检查更新 + 仅显示我创建筛选

## 背景

Issue #276：用户希望 App 每天自动检查新版本，而非手动点「检查更新」。同时增加「仅显示我创建」筛选，方便区分自己创建的 issue 与分配给自己的 issue。

## 设计

### 每日自动检查

- 后端 `lib.rs` 启动时 spawn 线程，每 1h 轮询，内部 24h 去重（`last_update_check_at`）
- `run_auto_update_check`：读 `auto_check_updates` 开关 → 检查 updater → 有新版时：
  - `auto_update == true`：静默 `download_and_install` + `restart_app`
  - `auto_update == false`：emit `UPDATE_AVAILABLE_EVENT`，前端弹框提醒
- 前端 App.tsx 监听事件，展示「立即更新 / 稍后」弹框

### 仅显示我创建

- `rows_to_tasks` 识别 `ownership == "my-created"` 时，改为 `WHERE author = ?` 过滤
- author 值从 `meta.login` 读取（用户主账号 GitHub login）
- 前端下拉增加 `my-created` 选项，复用现有 ownership 筛选通道

## 接口变更

| 变更 | 文件 | 说明 |
|---|---|---|
| Settings 新增字段 | `commands.rs` | `auto_check_updates: bool`, `auto_update: bool` |
| save_settings 参数 | `commands.rs` | 新增 `auto_check_updates: Option<bool>`, `auto_update: Option<bool>` |
| run_auto_update_check | `commands.rs` | 新增后台自动检查函数 |
| UPDATE_AVAILABLE_EVENT | `lib.rs` | 新增事件常量 `taskboard://update-available` |
| list_tasks 过滤 | `commands.rs` | `ownership == "my-created"` 走 author 过滤 |
| Settings 前端类型 | `types.ts` | 新增 `autoCheckUpdates`, `autoUpdate` |
| api.saveSettings | `api.ts` | 新增可选参数 |
| api.onUpdateAvailable | `api.ts` | 新增事件监听器 |

## 数据变更

`DEFAULT_SETTINGS` 新增 4 个 key：`auto_check_updates`(false), `auto_update`(false), `last_update_check_at`(0), `last_update_snoozed_at`(0)

## 测试

- `cargo check` ✓
- `npx tsc --noEmit` ✓
- `npm test` 136/136 ✓
- `npm run i18n:check` 353 keys ✓
- `cargo test --lib` 103/103 ✓
- `scripts/check-mcp-columns.py` ✓
- `scripts/check-doc-links.py` ✓

## 相关链接

- Issue: https://github.com/ShawnLiuSZ/task-dashboard/issues/276
- AboutPanel 精简：删除「本地数据」+「MCP 接入」section（MCP 配置仍在 AgentPanel 中可用）
- Toggle 开关：新增 `.toggle` / `.slider` CSS

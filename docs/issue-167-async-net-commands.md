# Issue #167：同步/诊断期间点击设置导致 UI 假死（主线程被网络 I/O 阻塞）

> 版本：v0.3.52 · 修复 · 关联 [Issue #167](https://github.com/ShawnLiuSZ/task-dashboard/issues/167)

## 背景 / 动机

用户报告：点击「同步」后，再点击设置面板「诊断」，界面短暂假死（macOS beachball）；同步期间点击「测试连接」「保存 PAT」「添加/更新账号」等操作同样卡顿。

历史背景：v0.3.7（#69）已把 `sync_now` 改为 `async + spawn_blocking`，v0.3.41（#97）让同步走独立 DB 连接，解决「同步长持共享锁」问题。但**其余内含网络 I/O 的同步命令一直未被处理**，是同类问题的漏网之鱼。

## 根因

`#[tauri::command]` **非 async** 命令在 Tauri 主线程（事件循环）上同步执行。以下命令内含 GitHub API 网络请求，执行期间主线程被阻塞，UI 事件循环停摆：

| 命令 | 网络操作 | 触发路径 |
|---|---|---|
| `diagnose_project_status` | 拉全部 project + 逐 project 拉 status + 逐 project GraphQL 查字段定义（多次往返） | 设置 → 诊断 |
| `test_pat` / `test_account_pat` | `test_connection()` | 设置 → 测试连接 |
| `save_pat` | 构造客户端 + `test_connection()` 探测真实 login | 保存 PAT |
| `add_account` | `test_connection()` + `fetch_user_org()` | 添加账号 |
| `update_account` | PAT 变更时 `test_connection()` 校验 | 编辑账号 |

这些命令虽然已注意「网络 I/O 在 db 锁外执行」（不占共享锁），但**网络调用本身仍在主线程**，与锁无关，照样假死。

## 设计 / 方案

与 `sync_now`（v0.3.7）同款处理：**改为 `async` 命令 + `tauri::async_runtime::spawn_blocking`**。

改造要点：

1. 签名 `pub fn` → `pub async fn`，返回值不变（前端 `invoke` 对同步/异步命令透明，零前端改动）。
2. 主线程只做**快速 DB 取数**（读 PAT / login / org，锁共享连接后立即释放，不跨 await 持有）。
3. 网络重活整体移入 `spawn_blocking(move || ...)` 闭包，闭包内只持有 owned 数据（String），不持有 `State` / `MutexGuard`（满足 `'static` 约束）。
4. 错误链路：`spawn_blocking(...).await.map_err(|e| format!("...线程异常: {e}"))??` —— 外层 `?` 解 JoinError，内层 `?` 透传命令业务错误。
5. 未变的命令保持原样：纯 SQL 命令（`get_settings` / `list_accounts` / `list_account_columns` / `set_account_board_mode` 等）毫秒级完成，无需异步化；同步期间点击它们不假死——同步用独立连接 + WAL，读不被写阻塞。

### 与 #97 / #69 的关系

- #69（sync_now）：第一个 async + spawn_blocking 先例，本修复沿用同一模式。
- #97（共享锁）：同步改用独立连接，解决「等锁」类假死；本修复解决「主线程网络 I/O」类假死。两者互补，本修复不依赖锁改动。

## 接口 / 行为变更

无接口变更。5 个命令签名（参数/返回类型/错误信息）完全不变，仅执行模型从「主线程同步」变为「工作线程 + 异步返回」。前端无需任何改动。

## 数据 / Schema 变更

无。零表结构 / 零 meta 变更。

## 测试 / 验收

- [x] `cargo check` 通过（仅剩历史 `fetch_state` dead_code 警告，保留备用）。
- [x] 顺手清理 `sync.rs` 中 `removed` 变量的 `unused_mut` 警告。
- [ ] 手动验收：同步期间依次点击 诊断 / 测试连接 / 保存 PAT / 添加账号 / 更新账号，无 beachball、UI 即时响应。

## 相关链接

- Issue：[#167](https://github.com/ShawnLiuSZ/task-dashboard/issues/167)
- 前例：v0.3.7 `sync_now` 异步化（[CHANGELOG.md](./CHANGELOG.md) v0.3.7 条目）、v0.3.41 独立连接（[issue-97-ui-freeze.md](./issue-97-ui-freeze.md)）
- CHANGELOG：v0.3.52 条目

# #114 任务变更本地实时推送（GUI 同进程 emit + MCP 跨进程轮询）

> 版本：v0.3.53 ｜ 状态：已实现（P0 + P1）｜ 分支：`feature/issue-114-task-change-push`

## 背景 / 动机

改任务后看板不会自己变，必须手动点「立即同步」或等定时同步（`lib.rs::run_sync`，默认 60 分钟）：

- GUI 里在详情面板改状态 / session / handoff，靠 `DetailPanel.onChanged → App.load()` 手动刷新；
- **MCP（`taskboard mcp` 是独立进程）改任务，GUI 完全感知不到**——这是 agent 协作场景的主要痛点：agent 调 `update_task_status` 后用户盯着看板以为没生效。

已有事件只有 `taskboard://synced`（整表同步结果，`lib.rs::SYNCED_EVENT`），没有任务级通知；
`TASKBOARD_ERROR_EVENT` 只是前端 `window.CustomEvent`（`api.ts`），与后端无关。

目标：

1. GUI 内改任务 → 即时刷新，无需手动触发；
2. MCP 改任务 → GUI 自动感知，目标 ≤5s；
3. `sync_now` 行为完全不变。

## 设计 / 方案

两条路径分开处理，因为**约束不同**：

| 路径 | 场景 | 机制 | 关键约束 |
|---|---|---|---|
| P0 | GUI 自己改任务 | Tauri `app.emit` 任务级事件 | 同进程内有效，跨进程投递不到 |
| P1 | MCP 改任务 | DB 里的写时间戳 + GUI 轮询 | 不做 socket / pipe，保持零新依赖 |

### P0：同进程 emit

- 新增 `lib.rs::TASK_CHANGED_EVENT = "taskboard://task-changed"`。
- `commands.rs` 四个写命令成功后 emit，payload 只有 `{ action, key }`：

  | 命令 | action |
  |---|---|
  | `update_task_status` | `update_status` |
  | `record_session` | `record_session` |
  | `clear_session` | `clear_session` |
  | `record_handoff` | `record_handoff` |

- **为什么 payload 不带完整 Task**：事件是「请刷新」信号，不是数据载体。带上 Task 就要在
  后端再查一次库、且前端要维护「事件里一份、列表里一份」两份状态，迟早不一致。
- **emit 放在 `commands.rs` 包装层，不进 `common.rs`**：`common.rs` 是 GUI 与 MCP 共用的
  纯逻辑层，MCP 进程没有 `AppHandle`，emit 不可能放那里。
- 失败路径不 emit：写库失败时前端刷新只会拿到「没变」的列表。
- 已知冗余：详情面板改任务时 `DetailPanel.onChanged` 会 `load()` 一次，事件又触发一次，
  两次都是幂等的全量拉取，不产生数据问题；保留 `onChanged` 是为了事件通道万一不通时
  仍有兜底，不把刷新逻辑绑死在单一通道上。

### P1：跨进程感知

MCP 与 GUI 是两个进程，`app.emit` 过不去；不做 socket / pipe（增加平台差异与依赖）。
改为在**公共写路径**统一 bump `meta.last_task_write_ts`（毫秒），GUI 轮询比对：

```
MCP 进程: common::set_task_status(...)  ─┐
GUI 进程: common::set_task_status(...)  ─┴─> bump meta.last_task_write_ts
                                              ↓ (轮询 3s)
                                    GUI: get_task_write_ts 变了 → load()
```

- bump 写在 `common.rs` 的 4 个写函数里（而非 `commands.rs`），这样 `mcp.rs` 走同一批函数
  时自动被记录，**不会漏掉 MCP 侧**。
- 用**毫秒**而非秒：MCP 批量改多个任务可能落在同一秒，秒级精度会让 GUI 漏掉后一次变更。
- 0 行更新（key 不存在）不 bump：没有数据变化，不该触发前端空刷新。
- 前端 `load()` 里**同时**取列表与时间戳（`Promise.all`）：两者必须同一次取回，否则
  「取列表之后、取时间戳之前」发生的外部写入会被漏判。取回后写入 `lastWriteTsRef`，
  使 GUI 自身的写操作不会在下一次轮询被误判成外部变更。
- 窗口不可见（托盘态）跳过轮询，`visibilitychange` / `focus` 时立即补查一次。

## 接口 / 行为变更

| 位置 | 变更 | 兼容性 |
|---|---|---|
| `lib.rs` | 新增 `TASK_CHANGED_EVENT` 常量 | 新增 |
| `commands.rs` | 4 个写命令新增 `app: AppHandle` 参数（Tauri 自动注入，前端调用不变） | 兼容 |
| `commands.rs` | 新增 `get_task_write_ts` 命令 | 新增 |
| `common.rs` | 新增 `LAST_TASK_WRITE_TS_KEY` / `now_millis` / `last_task_write_ts` / `bump_task_write_ts`（私有） | 新增 |
| `api.ts` / `types.ts` | 新增 `TASK_CHANGED_EVENT`、`onTaskChanged`、`TaskChangedEvent`、`api.getTaskWriteTs` | 新增 |
| `App.tsx` | 订阅 `onTaskChanged → load()`；新增 3s 轮询 effect | 新增 |
| `mcp_server/server.py` | 4 个工具写库后 bump 同一时间戳（与 Rust 侧一致） | 兼容 |

命令签名新增 `AppHandle` 不影响前端：`invoke("update_task_status", {key, status})` 的参数
由前端显式传入，`AppHandle` 由 Tauri 运行时注入。

## 数据 / Schema 变更

**无新表、无新列**。P1 复用既有 `meta` 表（`get_setting` / `set_setting`），新增一个 key
`last_task_write_ts`。老库无需迁移：读不到时 `last_task_write_ts` 返回 0，首次写入即建立。

## 测试 / 验收

已跑：

- `cargo check`（`app/src-tauri`）✅
- `cargo test common::tests`（新增 2 例：毫秒时间戳量级、写入 bump / 0 行不 bump）✅
- 严格模式类型检查（`tsc --noEmit`）✅
- `npm run i18n:check` ✅（本次无新增文案，无需改 i18n）

验收清单：

1. GUI 详情面板改状态 / 写 session / 清 session / 写 handoff → 看板即时更新；
2. MCP（或 `mcp_server/server.py`）改任务 → GUI 在 3s 内自动刷新；
3. 四个 action 均触发（开 `TASKBOARD_LOG=1` 可见 `[#114] emit task-changed ...`）；
4. `sync_now` 的行为与结果 banner 完全不变；
5. 托盘隐藏时不轮询，窗口回到前台立即补查一次。

> 说明：本机 `npx tsc --noEmit` 与 3 个 vitest 套件（board / sync-logs / unmapped-hint）
> 受开发环境的文件读取代理拦截而失败，与本次改动无关（在干净 `develop` 上同样失败）。
> 类型检查改用等价严格配置 + `@tauri-apps/api` 类型 stub 验证，0 error。

## 相关链接

- Issue：[ShawnLiuSZ/task-dashboard#114](https://github.com/ShawnLiuSZ/task-dashboard/issues/114)
- CHANGELOG：[v0.3.53 条目](./CHANGELOG.md)
- 关联：`docs/mcp-stdio-framing-ndjson.md`（#115，已关闭，与本 issue 无关）

## 发现的技术债（本次未修）

1. **`mcp_server/server.py` 已与 #155 的列名重构脱节**：`SELECT_COLS` 仍写 `key`
   （应为 `issue_key`），`tool_get_task_status` 的 `WHERE key=?` 同样失效——Python MCP 的
   读路径目前不可用。本次只顺手修了 `tool_record_handoff` 的 `WHERE key=?`
   （不修则本 issue 的 bump 永远走不到），其余已单开 **[issue #169](https://github.com/ShawnLiuSZ/task-dashboard/issues/169)** 跟进。
2. **Python MCP 写入未显式 commit**：`bump_task_write_ts()` 内补了 `conn().commit()`，
   使本工具的写入得以落盘；其余工具依赖同一次 commit，统一提交方案见 #169。

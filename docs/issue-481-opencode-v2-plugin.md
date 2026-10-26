# #481 opencode v2 插件 API 迁移

> 对应 issue：[#481](https://github.com/ShawnLiuSZ/task-dashboard/issues/481)
>
> 分支：`fix/issue-481-opencode-v2-plugin`
>
> 类别：opencode 集成 / 插件（agent 工具安装）/ 兼容性

## 背景 / 动机

本机 opencode 升级到 **v2（v2.0.32）** 后，原 `.opencode/plugins/taskboard.js` 不再生效。
现象：`opencode plugin list` 中该插件 ID 显示为 `-`（未被识别），导致：

- `record_session` 的 `session_id` / `agent` / `branch` 自动补参失效（模型编造的 session_id 不再被真实值覆盖，branch 不再自动从 git 取）。
- 用户消息含唯一未触发 issue 引用时，自动置「处理中」+ 记 session（`update_task_status` + `record_session`）的逻辑完全不触发。

`TASKBOARD_SESSION_ID` 注入 shell 环境变量也一并失效。

看板 MCP（`mcp` 配置键 + `taskboard` server）**不受影响**：v2 仍接受旧式扁平 `mcp` 对象（`opencode mcp list` 显示 `taskboard connected`），属 deprecated 但可用，本次不改动 MCP 注册逻辑。

## 设计 / 方案

### 根因：opencode v2 移除了 V1 插件 API

v2 加载器对 V1 插件形态**直接拒绝**（无兼容别名），旧式

```js
export const TaskboardPlugin = async (ctx) => ({ event, "tool.execute.before", "shell.env" });
```

不再被解析；`plugin list` 因此给出空 ID `-`。

v2 的契约（`@opencode/plugin` 的 `Plugin.define`）：默认导出必须是带 `id` + `setup(ctx)` 的定义，
在 `setup` 内**命令式注册**钩子，且每个钩子回调收到**单一可变 event 对象**（取代 V1 的 `(input, output)` 两参）。

### 迁移映射

| V1（已失效） | V2（本次采用） | 说明 |
|---|---|---|
| `return { event, ... }` | `Plugin.define({ id, setup(ctx) })` + `ctx.event.subscribe(cb)` | 事件流改为异步迭代，回调按 `event.type` 分发（`session.created` / `message.updated` / `message.part.updated` 不变） |
| `"tool.execute.before": (input, output) => { output.args.x = ... }` | `ctx.tool.hook("execute.before", (e) => { e.input.x = ... })` | 工具参数位于 `e.input`（对应 V1 的 `output.args`），是可变对象 |
| `"shell.env": (_input, output) => { output.env.X = ... }` | `ctx.shell.hook("create.before", (e) => { e.env.X = ... })` | 环境变量位于 `e.env` |
| 插件函数入参 `({ directory, $, client })` | `setup(ctx)` → `ctx.location.directory` | 项目目录改从 `ctx.location.directory` 取 |
| `client.app.log({...})` | `console.log` / `console.warn` | v2 context 已内聚领域方法，无独立 `client.app.log`；插件 stdout 由宿主捕获 |
| 用 `$` (Bun shell) 跑 `git` / `command -v` | `Bun.spawnSync` / `node:child_process.spawnSync`（sync helper `runSync`） | 移除对 `$` 的依赖，避免 v2 ctx 是否暴露 `$` 的不确定性 |

### 行为契约保持不变

- `pickSessionId` / `userTextOf` / `extractIssueRefs` 仍消费 `event.type` + `event.properties`（v2 事件结构与 V1 一致，kooky 参考插件亦用 `event.properties`）。
- 自动执行判定（唯一未触发引用、done/processed 不回退、doing 且有 session 视为已接管、同 `(session,issue)` 只执行一次）原样保留。
- 写库仍走 MCP 工具（`taskboard mcp` 子进程直写同一 SQLite），hooks 不直接写库——与 Claude 侧 `.claude/` 同构。

### 安装器联动

`app/src-tauri/src/hooks.rs` 通过 `include_str!("../../../.opencode/plugins/taskboard.js")` 内嵌该文件，安装时分别拷到项目 `.opencode/plugins/` 与全局 `~/.config/opencode/plugins/`：

- **源文件只用 `id: "taskboard"`**（项目级插件保留此 id）。
- **安装器对全局副本改写 id**：`install_one` 在 `project.is_none()` 且 `rel == "plugins/taskboard.js"` 时，把 `id: "taskboard"` → `id: "taskboard-global"`（见下文「后续修复：重复 id 告警」）。这是为了避免全局与项目级两份**同源**插件 id 撞车触发 opencode 的 `duplicate plugin id` 告警。
- 合并 / 卸载 / 去重逻辑不变；重跑「安装」即把 V2 版本 + 正确 id 同步到用户目录。

## 接口 / 行为变更

- 新增：插件默认导出形态从 V1 函数改为 `Plugin.define({ id: "taskboard", setup(ctx) })`。
- 新增：`setup` 内注册 `ctx.tool.hook("execute.before")`（补 `record_session` 参数）、`ctx.shell.hook("create.before")`（注入 `TASKBOARD_SESSION_ID`）、`ctx.event.subscribe`（会话/消息事件）。
- 移除：V1 的 `event` / `tool.execute.before` / `shell.env` 字符串键钩子（v2 已不识别）。
- 移除：对 Bun `$` shell 的依赖（改用同步 `runSync`）。
- MCP 配置 / 数据库 schema / i18n key 均**无变更**。

## 数据 / Schema 变更

无。

## 测试 / 验收

**加载验证（决定性）**：

```
opencode plugin list
# 期望：两份插件均显示正常 ID（不再为 -），且 id 不重复
#   项目级：/Users/liushizhao/dev/dashboard/.opencode/plugins/taskboard.js → taskboard
#   全局级：~/.config/opencode/plugins/taskboard.js → taskboard-global
```

> ⚠️ opencode 有后台常驻服务，会缓存插件。改完 `~/.config/opencode/plugins/taskboard.js` 后需
> `opencode reload`（或重启服务）才能生效；否则 `plugin list` 仍显示旧的 `-`。

**已执行验证**：

1. `opencode plugin list`（项目目录）：taskboard 显示 ID `taskboard`（V2 形态被接受，`setup` 完整跑完，三个 hook 全部注册成功——任一 `ctx.*.hook` 名称/签名错误都会在加载期抛错、拿不到 ID）。
2. 同步全局副本后 `opencode reload` + `opencode plugin list`（~）：全局显示 `taskboard-global`（id 与项目级 `taskboard` 区分，不再重复）。
3. 隔离探针确认 V2 钩子字段契约：`event.tool` / `event.input` / `event.env` / `event.type` / `event.properties` 与官方迁移文档及 kooky 参考插件一致。

**建议的手动冒烟（可选）**：在已装 TaskBoard、且有看板的仓库里开 opencode v2 会话，发一条含唯一 issue 引用（如 `task-dashboard#481`）的用户消息，应自动出现 `taskboard` 的 `update_task_status(doing)` + `record_session` 调用；直接调 `record_session` 时其 `session_id` 应被真实会话 id 覆盖、`branch` 自动填当前 git 分支。

**回归防护**：

- `scripts/check-doc-links.py`：新增 KB 文档后链接完整性通过。
- `hooks.rs` 安装器无需改动（`include_str!` 路径不变），既有 opencode MCP 合并单测不受影响。
- `hooks.rs::tests::opencode_global_plugin_id_distinct_from_project`：断言全局插件 id 为 `taskboard-global`、项目插件 id 为 `taskboard`，防止同源两份插件再次撞 id 触发重复告警。

## 后续修复：重复 id 告警

V2 插件被两处加载后（全局 `~/.config/opencode/plugins/` + 项目 `<repo>/.opencode/plugins/`），opencode 启动时弹出：

```
/Users/liushizhao/.config/opencode/plugins/taskboard.js, /Users/liushizhao/dev/dashboard/.opencode/plugins/taskboard.js
Run /plugins to view details.
```

**根因**：两份文件都来自同一个 `include_str!` 源，原本都声明 `id: "taskboard"`，opencode 按 id 去重时发现重复 → 告警。（V1 时代该插件根本不加载，所以没有此告警；V2 修好后两份同时生效才暴露。）

**影响评估**：功能上**无害**。`record_session` → `touch_session` 是按 `(issue_key, session_id)` 的 upsert，`update_task_status(doing)` 幂等，shell hook 注入相同 `TASKBOARD_SESSION_ID`，autoStart 有「同 (session,issue) 只执行一次」守护——双份 hook 同时触发也是幂等的。但告警是用户可见的，需消掉。

**修复**：全局副本改用独立 id `taskboard-global`：

1. 已部署全局文件 `~/.config/opencode/plugins/taskboard.js`：`id: "taskboard"` → `id: "taskboard-global"`（直接改盘，立即可消告警）。
2. 安装器 `app/src-tauri/src/hooks.rs::install_one`：写入全局范围（`project.is_none()` 且 `rel == "plugins/taskboard.js"`）时，对内容做 `content.replacen("id: \"taskboard\"", "id: \"taskboard-global\"", 1)`；项目级保持 `taskboard`。这样未来重装也正确。

**验证**：`opencode reload` 后 `opencode plugin list` 显示两份 id 分别为 `taskboard`（项目）与 `taskboard-global`（全局），告警消失。

## 相关链接

- Issue：[#481](https://github.com/ShawnLiuSZ/task-dashboard/issues/481)
- 源文件：[`.opencode/plugins/taskboard.js`](../.opencode/plugins/taskboard.js)（被 `app/src-tauri/src/hooks.rs` 的 `include_str!` 内嵌）
- 安装器：[`app/src-tauri/src/hooks.rs`](../app/src-tauri/src/hooks.rs)
- 参考：opencode v2 插件迁移文档（V1 → V2）、本机 kooky 参考插件 `~/.config/opencode/plugin/kooky.ts`
- 关联：#177（opencode hooks 初版）、#341（opencode 全局 MCP jsonc 合并）
- CHANGELOG：[`docs/CHANGELOG.md`](./CHANGELOG.md)

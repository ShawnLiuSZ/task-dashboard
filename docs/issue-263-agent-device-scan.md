# #263 Agent 接入面板：设备扫描（识别已安装 / 已卸载的 agent）

> 关联 issue：[#263](https://github.com/ShawnLiuSZ/task-dashboard/issues/263) ｜ 分支 `feature/issue-263-agent-device-scan` ｜ 面板入口：侧边栏「Agent 接入」→「Agent 接入」tab

## 背景 / 动机

「Agent 接入」面板的刷新按钮原先只重跑 `get_agent_hooks_status`，而该命令的 `host_present`
仅由**配置根目录是否存在**推导（`app/src-tauri/src/hooks.rs` 旧 `status_one`：`root.is_dir()`）。
这导致三个用户可见的缺陷：

1. **装了但没跑过 → 误判「未安装」**：CLI 在 PATH 上、但从未运行因而没有配置目录的 agent，
   被归入「未安装」组。本机实测：`codex` 在 PATH（`~/.local/state/fnm_.../bin/codex`）
   但没有 `~/.codex`，面板显示「未安装」。
2. **非一等 agent 完全不探测**：后端 `AgentSpec` 只有 5 个（claude-code / opencode / workbuddy /
   codebuddy / trae），其余 34 个 agent 永远落在「手动配置」组，看不出本机到底装没装。
3. **「已卸载」无任何检测**：CLI 从 PATH 消失、`.app` 被删除后，只要配置目录残留，面板仍无差别
   展示，用户分不清「真装了」和「卸载后剩的残留接入」。

需求：把刷新升级为**设备扫描** —— 一次点击回答「这台机器上装了哪些 agent、哪些已经卸载了」。

## 设计 / 方案

### 三类信号（任一命中即有安装证据）

| 信号 | 探测方式 | 典型场景 |
|---|---|---|
| `binary` | PATH + `~/.local/bin`、`~/bin`、`~/.cargo/bin`、`~/.bun/bin`、`~/.npm-global/bin`、`~/.volta/bin`，macOS 另加 `/opt/homebrew/bin`、`/usr/local/bin` | CLI 形态，**装了没跑过也能认出** |
| `config_dir` | `$HOME` 下该 agent 的配置目录候选 | 历史残留 / 已运行过 |
| `app` | macOS `/Applications`、`~/Applications` 下的 `.app` 包名（大小写不敏感） | GUI 形态（Trae / Cursor / WorkBuddy 等） |

由信号派生 `kind`（**最强信号**，前端据此显示徽标）：

```
cli        binary 命中（或 binary + app 同时命中）
app        仅 app 命中
config-only 仅 config_dir 命中  ← 疑似已卸载 / 历史残留
none       三者皆无
```

### 「已卸载」怎么判

单看现状无法区分「从未装过」和「装过又卸了」—— 两者都只剩配置目录。因此保留**上次扫描快照**
（`meta.agent_scan_snapshot`，JSON），逐 agent 对比 `kind`：

| 上次 `kind` | 本次 `kind` | 结论 |
|---|---|---|
| `none` | `cli` / `app` / `config-only` | **新发现安装** |
| `config-only` | `cli` / `app` | 新发现安装（补齐/重装） |
| `cli` / `app` | `none` / `config-only` | **疑似已卸载** |
| 其他组合 | — | 不报（避免噪音） |

**首次扫描（无快照 / 空快照）不产生任何变更**，否则首刷会把全部已装 agent 报成「新发现」。

### 为什么快照是唯一写入

扫描本身**只读**（不发网络请求、不写任何 agent 配置文件），唯一副作用是把快照写进
`meta.agent_scan_snapshot`，用于下一次对比。快照解析失败（手工改库 / 版本降级）时按首次扫描
处理，不让扫描整体失败。

### 单一来源与防漂移

- 探测口径表 `HOST_SPECS`（39 项，含 `bins` / `configs` / `apps`）放在**后端**，
  无本地信号的 agent（纯 Web / IDE 插件形态，如 Cline、Continue、Bolt）显式留空数组。
- 前端 `app/src/agents.ts` 仍是 label 与「是否支持一键接入」的来源；
  `HOST_SPECS` 只负责「怎么在本机认出它」。
- 两边 id 集合由 Rust 单测 `host_specs_cover_frontend_agent_ids` 断言一致：该测试用
  `include_str!("../../src/agents.ts")` 直接解析前端源文件里的 `value: '...'`，
  前端新增 agent 而漏配探测口径时**编译期就能发现**（同 `check-mcp-columns.py` 的防漂移思路）。

## 接口 / 行为变更

### 新增 Tauri command

```rust
#[tauri::command]
pub fn scan_agent_hosts(state: State<'_, AppState>) -> Result<hooks::AgentScanResult, String>
```

返回 `AgentScanResult`（`#[serde(rename_all = "camelCase")]`）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `scannedAt` | i64 | 本次扫描时间（秒） |
| `previousScannedAt` | Option\<i64\> | 上次扫描时间；首次为 null |
| `hasPrevious` | bool | 是否存在有效历史快照 |
| `agents` | AgentHostInfo[] | 全量 39 项，含 `kind` / `binary` / `configDir` / `app` |
| `newlyInstalled` | string[] | 本轮新发现安装 |
| `newlyRemoved` | string[] | 本轮疑似已卸载 |

### `get_agent_hooks_status` 的语义变化

`status_one` 新增可选参数 `host: Option<&AgentHostInfo>`：

- 正式路径（该 command）传入设备探测结果，`host_present = root.is_dir() || probed.present`
  —— 于是「装了没跑过的 CLI」归入**可接入**而不是「未安装」，可以一键接入。
- 测试路径传 `None`，退化为纯配置目录判定 —— 避免单测结果依赖开发机 PATH / `/Applications`
  （否则 `codebuddy` 之类的断言会在装了该 CLI 的机器上随机失败）。
- **项目级**（scope=project）跳过设备探测：只看目标仓库目录，语义不变。

### 前端

- 新增纯逻辑模块 `app/src/agent-groups.ts`（无 React 依赖，可单测）：
  `deviceStateOf` / `deviceDetail` / `groupOf` / `summarize` / `GROUP_ORDER`。
- 「刷新」按钮（i18n `settings.hooks.refresh`，文案改为**扫描设备**）同时刷新接入状态与设备扫描；
  切换作用域、打开 tab 也会自动执行一次（保持「接入状态」与「设备状态」同源同刻）。
- 新分组 **疑似已卸载**（`settings.hooks.group.uninstalled`，红点）：收录
  ① 本轮快照对比发现可执行/应用包消失的 agent；② 已接入但设备上只剩配置目录的 agent。
  该组每行额外展示残留路径（`deviceDetail`），并提供已有的一键卸载按钮用于清理。
- **分组收敛为 4 组**：「未安装」与「手动配置」合并为 **未接入**（详见下节「追加修正」）。
- 每行新增设备徽标：`本机已安装` / `已安装应用` / `仅残留配置` / `未检测到`；
  **无扫描结果时不渲染徽标**（避免整屏「未检测到」噪音）。
- 摘要行：`扫描于 HH:MM：已安装 N 个 · 新发现 X · 疑似已卸载 Y · 仅残留配置 Z`；
  首次扫描追加一句「已建立基线」。

### i18n

中英各 348 key（原 347）。改动：`settings.hooks.refresh` 与 `manualHint` 改文案；
新增 `scanSummary` / `scanHint` / `scanFirst` / `group.uninstalled` / `group.notIntegrated` /
`uninstalledHint` / `manualPath` / `notDetected` / `device.{cli,app,configOnly,none,suspectedRemoved}`；
删除随分组收敛而失效的 `group.missing` / `group.manual`（避免留下死 key）。

## 数据 / Schema 变更

**无 SQLite 表结构变更**，无需迁移。新增一个 `meta` 键（键值对表，天然向后兼容）：

| meta key | 值 | 说明 |
|---|---|---|
| `agent_scan_snapshot` | JSON 字符串 | `{ scannedAt: i64, agents: { "<id>": { kind, binary, configDir, app } } }` |

老库没有该键 → `get_setting` 返回空串 → 视为首次扫描（不报变更），行为安全。

## 测试 / 验收

### Rust（`app/src-tauri/src/hooks.rs` 单测，6 例新增）

| 测试 | 覆盖 |
|---|---|
| `host_specs_cover_frontend_agent_ids` | `HOST_SPECS` 与 `app/src/agents.ts` id 集合双向一致（防漂移） |
| `host_spec_ids_unique_and_cover_hook_specs` | id 不重复 + 5 个有安装契约的 agent 都能被探测 |
| `diff_scan_reports_install_and_uninstall` | 首次不报变更 / 新装 / `cli→config-only` 卸载 / `config-only→cli` 重装 |
| `snapshot_round_trips_through_json` | 快照 serde 往返 |
| `find_binary_probes_path_and_home_dirs` | 惯例目录命中；不存在与空清单返回 None |
| `find_app_matches_case_insensitively` | 应用包名大小写不敏感匹配 |
| `probe_classifies_config_only_and_app_signals` | `config-only` / `app` / 未知 id 分类（只读信号，与开发机环境无关） |
| `status_one_uses_probe_for_host_presence` | 探测结果参与 `host_present`（装了没跑过 → 可接入） |

已验证的既有测试同步改造：11 处 `status_one(...)` 调用补 `None`，语义不变。

### 前端（`app/src/agent-groups.test.ts`，15 例新增）

覆盖：无扫描结果 → `none`；差异优先判卸载；`cli/app/config-only/none` 映射；
**疑似已卸载优先于已接入**；已接入 + 仅残留配置 → 疑似已卸载；未接入 + 有安装证据 → 可接入；
状态未就绪不误判未安装；`summarize` 统计与首次扫描无噪音。

另在 `app/src/components/settings-groups.test.tsx` 追加 SSR 冒烟：按钮文案为「扫描设备」、
**未扫描时不渲染设备徽标与摘要**。

### 结果

| 检查 | 结果 |
|---|---|
| `cargo test` | 101 passed（lib）+ 21 passed（`db_test`），0 failed |
| `npx tsc --noEmit` | 0 error |
| `npm test` | 13 文件 **134 例**全绿（新增 16 + 1，含分组收敛后的守卫） |
| `npm run build` | ✅ |
| `npm run i18n:check` | 中英各 **348** key，占位符一致 |
| `python3 scripts/check-doc-links.py` | ✅ |
| `python3 scripts/check-mcp-columns.py` | ✅（本次未改 `tasks` 列，属例行回归） |

### 已知限制

- **无本地信号的 agent 永远显示「未检测到」**：Cline / Continue / Roo Code / Tabnine 等
  纯 IDE 插件或 Web 形态的 agent 没有可靠的路径信号，`HOST_SPECS` 中显式留空 —— 这是刻意的
  「不猜」，而不是漏配。要支持需按 IDE 的扩展目录（VS Code `globalStorage`）另做探测。
- **`config-only` 存在误报可能**：配置目录存在、但可执行文件与应用包都不在探测范围内时
  （例：本机 `~/.codebuddy` 存在而 `codebuddy` 不在 PATH、也无对应 `.app`），会被标为
  「仅残留配置」并进入「疑似已卸载」组。这是**保守的提示而非断言** —— 行内给出实际命中路径，
  由用户判断是否清理；不自动删除任何文件。
- **首次扫描不会显示差异**（设计如此，见「为什么快照是唯一写入」）。
- 快照在每次扫描时覆盖，粒度是「上一次扫描」而非「历史上线」；若用户在两次扫描之间装卸同一
  agent，不会被报告。

## 追加修正（2026-09-16）：合并「未安装」与「手动配置」为「未接入」

**问题（维护者提出）**：分组里「未安装」和「手动配置」各占一组，可否合并。

**为什么原来会拆开**：这两组自 `2e174e0`（#177 后续「接入页分组展示」）起就存在，当时是两个
不同维度：

| 组 | 维度 | 判定 |
|---|---|---|
| 未安装 | **设备** | 支持一键接入，但本机配置根不存在（`host_present=false`） |
| 手动配置 | **能力** | TaskBoard 未验证该 agent 的 hook 机制，与设备无关（本机装没装都在这组） |

**为什么现在应当合并**：

1. #263 之后**每行都有设备徽标**，「本机装没装」这一原本支撑拆分的依据已由徽标承载，不必再用组名表达。
2. 两组在本面板内的**可操作性完全相同** —— 都没有安装按钮：一个是因为本机还没装上游 agent，
   一个是因为尚未验证一键接入。用户能做的动作是同一类（去装上游 / 手动改配置）。
3. 拆分导致碎片化：「未安装」组最多只有 5 个候选，实测本机常常只有 1 行（`trae`），
   一个组头换一行内容，信息密度反而下降。

**改动**：

- `agent-groups.ts`：`AgentGroupKey` 由 `installed | available | uninstalled | missing | manual`
  收敛为 `installed | available | uninstalled | notIntegrated`；`GROUP_ORDER` 同步为 4 项。
  `groupOf` 的**行为差异**只有一处：支持一键、但本机无任何安装证据的 agent 由 `missing` 改归
  `notIntegrated`。`!supported` 仍**优先**返回 `notIntegrated`，所以手动 agent 即使被快照对比
  判为「已卸载」也不会进「疑似已卸载」组（本面板从未给它装过东西，没有残留可清）。
- **信息不丢**：行内 `detail` 仍是逐 agent 计算，并让两类**自述**（否则合并后读不出「为什么没有安装按钮」）：
  手动 agent → `手动配置：~/.codex/hooks.json`（新 key `settings.hooks.manualPath`）；
  支持但本机没装 → `本机未检测到`（新 key `settings.hooks.notDetected`）。
- 组级提示 `settings.hooks.manualHint` 改写为覆盖两种情形的一句话。
- i18n：删除 `settings.hooks.group.missing` / `settings.hooks.group.manual`（避免产生新死 key），
  新增 `group.notIntegrated` / `manualPath` / `notDetected`，中英各 348 key（原 347）。
- 顺带修正：底部「疑似已卸载」提示原先只看 `newlyRemoved`，可能出现「有提示但没有可清理的行」；
  现在与分组结果同源（`grouped.uninstalled.length > 0`），且分组结果只算一次供渲染与提示共用。
- 回归：`agent-groups.test.ts` 改为断言 `notIntegrated`（含「手动 agent 被判卸载也不进清理组」），
  新增一条「共 4 组、不得回归出 `missing` / `manual`」的守卫；`settings-groups.test.tsx` 的
  折叠态 stub 由 `{"manual":true}` 改为 `{"notIntegrated":true}`。

**验证**：`tsc --noEmit` 0 error、`npm test` 13 文件 **134 例**、`npm run build` ✅、
`npm run lint` exit 0（18 warnings，未新增）、`prettier --check` ✅、`i18n:check` 中英各 348 key。

## 相关链接

- 关联 issue：[#263](https://github.com/ShawnLiuSZ/task-dashboard/issues/263)
- 前序功能：[#177](https://github.com/ShawnLiuSZ/task-dashboard/issues/177)（一键安装/卸载 hooks）、
  [#206](https://github.com/ShawnLiuSZ/task-dashboard/issues/206)（取消启动自动接入，改手动一键安装）
- 代码：`app/src-tauri/src/hooks.rs`（`HOST_SPECS` / `probe_agent_hosts` / `diff_scan` / `status_one`）、
  `app/src-tauri/src/commands.rs`（`scan_agent_hosts`）、`app/src/agent-groups.ts`、
  `app/src/components/AgentPanel.tsx`
- 测试：`app/src-tauri/src/hooks.rs`（`mod tests`）、`app/src/agent-groups.test.ts`、
  `app/src/components/settings-groups.test.tsx`
- CHANGELOG：[`docs/CHANGELOG.md`](./CHANGELOG.md) / [`docs/CHANGELOG.en.md`](./CHANGELOG.en.md) 的 Unreleased 段

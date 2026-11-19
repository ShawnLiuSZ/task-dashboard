# #598 设备扫描漏探版本管理器安装的 CLI，codebuddy 被误判「疑似已卸载」

## 背景 / 动机

用户报障：本机**已安装** codebuddy（fnm + npm global），但「Agent 接入」面板把它归入红色的
**疑似已卸载** 组，行内徽标显示「仅残留配置」，而用户并未卸载。

对应 issue：[#598](https://github.com/ShawnLiuSZ/task-dashboard/issues/598)。
这是 `#263`（Agent 设备扫描）文档「已知限制：`config-only` 存在误报可能」在真实机器上的踩中 ——
该限制条目里举的例子恰好就是 `~/.codebuddy` 存在而 `codebuddy` 探不到。

### 根因（真机实测）

`hooks.rs::bin_search_dirs()` 只搜两类位置：

1. **进程自身 PATH** —— TaskBoard 是 GUI 应用，从 Finder/Dock 启动时只拿到 launchd 的最小 PATH：
   ```
   PATH=/usr/bin:/bin:/usr/sbin:/sbin   # ps -E 查运行中的 taskboard 进程实测
   ```
   终端里那串含 fnm multishell 目录的 PATH，GUI 进程继承不到。
2. **硬编码通用惯例目录** —— `.local/bin` / `bin` / `.cargo/bin` / `.bun/bin` /
   `.npm-global/bin` / `.volta/bin` / `/opt/homebrew/bin` / `/usr/local/bin`，
   **不含 fnm / nvm / mise / asdf 等版本管理器的安装目录**。

于是判定链退化：binary 探不到 + 无 `.app` + `~/.codebuddy` 存在 → `kind = config-only`
→ codebuddy 已开一键接入 → `agent-groups.ts::groupOf` 走「已接入 + 仅残留配置 → 疑似已卸载」。

本机 codebuddy 的真实位置（两种形态都存在）：

```
~/.local/share/fnm/aliases/default/bin/codebuddy        ← 稳定 alias（symlink）
~/.local/share/fnm/node-versions/v24.15.0/installation/bin/codebuddy
~/.local/state/fnm_multishells/<pid>_<ts>/bin/codebuddy ← shell 会话临时目录（终端 PATH 里的是它）
```

**同批漏判**：`codex` 同样 fnm 安装、同样被判 `config-only`（快照 `meta.agent_scan_snapshot`
实测两者皆 `bin=None`）。扫描快照时间 2026-11-18 10:15，而 `~/.codebuddy` mtime 当天仍在写入 ——
确认非卸载残留。

## 设计 / 方案

### 决策 1：把版本管理器安装目录纳入探测，而不是「读 shell PATH」

两个候选：

| 方案 | 取舍 |
|---|---|
| 启动时跑 login shell 取真实 PATH | ✗ 慢（spawn shell 数百 ms）、有副作用（触发 rc 文件）、可能弹交互提示；GUI 应用里跑 shell 本身不可靠 |
| **把版本管理器的安装目录作为静态模式纳入**（本方案） | ✓ 零副作用、只读 `stat`、可单测 |

### 决策 2：模式表 + 单层 `*` 通配，不用 glob crate

新增 `HOME_BIN_PATTERNS` 常量（`hooks.rs`），全部是**相对 `$HOME` 的正斜杠路径**：

- 通用惯例目录（原硬编码的 6 条原样搬入）
- **fnm**：`.local/share/fnm/aliases/default/bin`、`.local/share/fnm/node-versions/*/installation/bin`、`.fnm/versions/node/*/bin`
- **nvm**：`.nvm/versions/node/*/bin`
- **mise / asdf**：`.local/share/mise/shims`、`.asdf/shims`
- **pnpm / yarn**：`Library/pnpm`、`.local/share/pnpm`、`.yarn/bin`、`.config/yarn/global/node_modules/.bin`
- **Windows 版本管理器**：`AppData/Local/fnm/...`、`AppData/Roaming/nvm`、`AppData/Local/pnpm`
  （Unix 上这些路径不存在，展开为空，无副作用 —— 与 `bin_file_names` 的双平台写法同思路）

`expand_home_bin_dirs()` 只支持**单层** `*`，用 `std::fs::read_dir` 自行展开（AGENTS.md §2.5
不引新依赖；单层已覆盖 `node-versions/<ver>/` 这一实际形态）。`*` 段只保留目录项；
目录不存在 → 该分支自然为空，不报错。

### 决策 3：刻意**不含** `~/.local/state/fnm_multishells/*/bin`

那是 fnm 每个 shell 会话的 symlink 目录 —— 本机实测 **6000+ 条**，多为已退出会话的残留。
逐条展开既慢（每次扫描数千次 `stat`），又会把「曾经开过 shell」当成安装证据。
其内容与 `aliases/default/bin` 等价，故只取稳定目录。

### 决策 4：拆出 `home_bin_dirs()` 供测试确定性注入

原 `probe_one_with` / `find_binary` 内部直接吃 `bin_search_dirs()`（含开发机 PATH），
断言会随「开发机装没装 codebuddy」漂移 —— `#263` 文档已记过这个坑
（「否则 `codebuddy` 之类的断言会在装了该 CLI 的机器上随机失败」）。故拆三层：

```
bin_search_dirs(home)   = PATH + home_bin_dirs(home) + 系统级目录(macOS homebrew)   ← 生产
home_bin_dirs(home)     = expand_home_bin_dirs(home)                                ← 只含 $HOME 下路径
probe_one_in(home, id, app_names, bin_dirs) / find_binary_in(dirs, names)           ← 注入点
```

`home_bin_dirs` **不含 PATH、不含 `/opt/homebrew` 这类系统目录**，测试传它即可与本机环境完全解耦。

## 接口 / 行为变更

- **Tauri command `scan_agent_hosts`**：签名与返回结构不变；`agents[].kind` 对「版本管理器装的
  CLI」由 `config-only` 修正为 `cli`（`binary` 字段相应给出命中路径）。
- **UI 分组**：此类 agent 从「疑似已卸载」组回到「已接入 / 可接入」组，设备徽标由
  「仅残留配置」变「本机已安装」。前端零改动（`agent-groups.ts` 分组规则未动）。
- **MCP / 数据库**：无变更。快照 `meta.agent_scan_snapshot` 仍为唯一写入目标。
  下次扫描时 `config-only → cli` 会命中 `diff_scan` 的「新发现安装」分支（既有行为，非本次改动）。
- 新增/调整的私有函数：`HOME_BIN_PATTERNS`、`expand_home_bin_dirs`、`home_bin_dirs`、
  `dedup_dirs`、`find_binary_in`、`probe_one_in`（均为 `hooks.rs` 模块内，无 pub 导出）。

## 数据 / Schema 变更

无。`tasks` 表与 `SELECT_COLS` 未动，`scripts/check-mcp-columns.py` 属例行回归。

## 测试 / 验收

新增 3 条单测（`hooks.rs::tests`）：

| 用例 | 守什么 |
|---|---|
| `find_binary_probes_version_manager_dirs` | fnm 稳定 alias 目录 / fnm 版本目录（`*` 通配）/ nvm（`*` 通配）/ mise / asdf 五处都能探到；通配段不存在不 panic、不误命中 |
| `probe_finds_fnm_installed_cli_not_config_only` | **核心回归**：只有 fnm 目录有可执行文件 + 配置目录存在 → 必须判 `cli` 而非 `config-only`；并给出无信号时仍为 `config-only` 的反向断言 |
| `home_bin_dirs_is_deterministic_without_path` | `home_bin_dirs` 全部落在注入的 fake home 下（防 PATH / 真实 `$HOME` 泄漏进断言） |

**断言强度（AGENTS.md §5.6 变异验证）**：两条变异各自让对应用例变红 ——

1. 删掉 `".local/share/fnm/aliases/default/bin"` 模式 → `probe_finds_fnm_installed_cli_not_config_only`
   红，失败形态正是原 bug：`left: "config-only" / right: "cli"`；`find_binary_probes_version_manager_dirs` 同红。
2. 通配 `*` 分支不再 `read_dir` 展开 → `find_binary_probes_version_manager_dirs` 红
   （`node-versions/*/installation/bin` 路径未展开 ⇒ 探不到）。

已跑（全部退出码 0）：

```bash
cargo check --manifest-path app/src-tauri/Cargo.toml
cargo test  --manifest-path app/src-tauri/Cargo.toml --lib     # 281 passed / 0 failed / 4 ignored
cargo clippy --manifest-path app/src-tauri/Cargo.toml --all-targets -p taskboard -- -D warnings
npm test && npx tsc --noEmit && npm run i18n:check
python3 scripts/check-doc-links.py && python3 scripts/check-mcp-columns.py
```

边界场景：本机无 fnm/nvm/mise/asdf（对应目录不存在）→ 展开为空，行为与改动前一致；
`~/.fnm`、`~/.nvm` 等 legacy/未用目录不产生任何副作用。

## 相关链接

- Issue：[#598](https://github.com/ShawnLiuSZ/task-dashboard/issues/598)
- 前置功能：[`issue-263-agent-device-scan.md`](./issue-263-agent-device-scan.md)（设备扫描；
  其「已知限制」中的 `config-only` 误报条目已由本次修正缩小）
- 分组规则：`app/src/agent-groups.ts`、`app/src/agent-groups.test.ts`
- `CHANGELOG.md` 条目：见发版版本下「设备扫描漏探版本管理器 CLI」

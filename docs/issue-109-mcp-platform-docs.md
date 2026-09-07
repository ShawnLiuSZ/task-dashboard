# issue-109：MCP 接入文档完善 — 关于页按平台展示、README 覆盖全平台

> 关联 [Issue #109](https://github.com/ShawnLiuSZ/task-dashboard/issues/109)

## 背景 / 动机

MCP 接入方式的文档（README 与 App 内「关于」页）只写了 macOS 的接入路径，存在两处问题：

1. **关于页**（AboutPanel.tsx）的 MCP 配置 snippet 硬编码 macOS 路径 `/Applications/TaskBoard.app/Contents/MacOS/taskboard`，Windows / Linux 用户看到的路径不匹配。
2. **README** 只列了 macOS 路径，且罗列多个 agent 示例（WorkBuddy、claude-code、codex/cursor），反而不聚焦。

## 设计 / 方案

### 平台检测

不引入新依赖（如 `@tauri-apps/plugin-os`），使用前端 `navigator.userAgent` 判断当前 OS：

- `ua.includes("mac")` → macOS
- `ua.includes("win")` → Windows
- 其余 → Linux

在 Tauri 桌面应用中 `navigator.userAgent` 始终包含对应 OS 标识，可靠且零依赖。

### 各平台默认路径

| 平台 | `command` 路径 |
|---|---|
| macOS | `/Applications/TaskBoard.app/Contents/MacOS/taskboard` |
| Windows | `C:\Program Files\TaskBoard\taskboard.exe` |
| Linux (deb) | `/usr/bin/taskboard` |

用户安装到非默认位置时需手动修改 `command`。

### 关于页实现

将 `MCP_SNIPPET` 常量替换为 `getMcpCommand()` + `buildMcpSnippet()` 两个函数：

- `getMcpCommand()`：按 `navigator.userAgent` 返回当前平台的默认路径。
- `buildMcpSnippet()`：调用 `getMcpCommand()`，生成完整 JSON 配置字符串。

渲染时 `<pre className="about-code">{buildMcpSnippet()}</pre>` 动态展示。

### README 改动

- 新增「各平台 `command` 路径」表格（macOS / Windows / Linux）。
- 收敛为**单个 agent 完整配置示例**（claude-code 的 `~/.claude.json`），其余 agent 用一句话指引。
- 保留 `server.py` 兜底说明。

## 接口 / 行为变更

- AboutPanel MCP snippet 从硬编码常量变为运行时按平台动态生成，无 Tauri command / API 变更。
- i18n key 无变化（代码块保持非翻译）。

## 测试 / 验收

1. macOS 装机：关于页显示 mac command 路径。
2. Windows / Linux 装机：分别显示对应路径（通过修改 user agent 模拟或实际平台验证）。
3. 平台未知时降级为 Linux 路径（`/usr/bin/taskboard`）。
4. `npx tsc --noEmit` 通过。
5. `npm run i18n:check` 通过。

## 相关链接

- [Issue #109](https://github.com/ShawnLiuSZ/task-dashboard/issues/109)
- [PR #111](https://github.com/ShawnLiuSZ/task-dashboard/pull/111)
- `app/src/components/AboutPanel.tsx`
- `README.md` / `README.en.md`

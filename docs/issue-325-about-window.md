# #325 菜单栏 About TaskBoard 改为自定义独立小窗（对齐 WorkBuddy）

> 关联 issue：[#325](https://github.com/ShawnLiuSZ/task-dashboard/issues/325)
> 版本：待发布（Unreleased，预计随下一个发版）

## 背景 / 动机

macOS 菜单栏「About TaskBoard」此前是 **Tauri 默认应用菜单**触发的**系统原生 About 面板**：只能展示图标 / 名称 / 版本，样式固定、无法定制，也没有运行时信息与「确定」按钮。

WorkBuddy（Electron）的 About 是自定义弹框：应用图标 + 粗体名称 + 多行运行时版本（版本 / Electron / Chrome / Node）+ 全宽「确定」按钮。用户希望 TaskBoard 的菜单栏 About 也改成同款自定义样式，把运行时信息替换为 Tauri 对应项。

## 设计 / 方案

1. **自定义独立小窗（label = `about`）**：在 `tauri.conf.json` 的 `app.windows` 新增第二个窗口，启动即创建但 `visible: false`；点击菜单「About TaskBoard」时 `show()` + `set_focus()` 打开。窗口固定尺寸 `380×320`、`resizable: false`、`center: true`。
2. **前端按窗口 label 路由**：`main.tsx` 通过 `getCurrentWindow().label` 区分——`about` 窗口只渲染 `<AboutWindow />`，不挂载完整 `<App />`（避免连 DB / 跑同步）；主窗口（label = `main`）照常渲染 `<App />`。
3. **信息三行**（对齐 WorkBuddy 的三行运行时信息）：
   - `版本: <app version>` —— 来自 Rust 命令 `get_runtime_info()`。
   - `Tauri: <tauri version>` —— 来自 Rust 命令 `get_runtime_info()`（`tauri::VERSION`）。
   - `WebView: <引擎版本>` —— **由前端从 `navigator.userAgent` 推导**（`app/src/utils/webviewVersion.ts::getWebviewVersion`）。
4. **菜单接管（仅 macOS）**：用 `tauri::menu` 构建自定义应用菜单，把默认「About TaskBoard」替换为自定义项（id = `about`）；保留 App / Edit / Window 标准子菜单（隐藏、退出、服务、复制粘贴、最小化、关闭等用 `PredefinedMenuItem` 复用系统行为）。点击 `about` 在 `on_menu_event` 中打开小窗。非 macOS 平台保留 Tauri 默认菜单（含原生 About 面板），**保持无回归**。
5. **确定按钮**：全宽主色按钮，点击 `getCurrentWindow().close()` 关闭小窗。
6. **新命令 `get_runtime_info()`**：返回 `{ appVersion, tauriVersion }`（camelCase 序列化）。标签文案走 i18n（中英文）。

### WebView 版本为何在前端推导（重要取舍）

Tauri 2 **核心不暴露 WebView 引擎版本 API**（无 `Webview::version()`，官方另行提供 `tauri-plugin-webview-version` 插件）。而项目约定（AGENTS.md §2.5）**不引入新依赖**。系统 WebView（macOS 的 WKWebView / Windows 的 WebView2 / Linux 的 WebKitGTK）即 Tauri 实际使用的渲染引擎，故直接读其 `navigator.userAgent` 推导第三行，与 `get_runtime_info` 的 app/tauri 两行拼出完整信息。

## 接口 / 行为变更

### 新增 Tauri 命令

- `get_runtime_info() -> RuntimeInfo { app_version: String, tauri_version: String }`（`#[serde(rename_all = "camelCase")]` ⇒ `{ appVersion, tauriVersion }`）。
  - `app_version` = `env!("CARGO_PKG_VERSION")`（Rust 包版本，与发版号一致）。
  - `tauri_version` = `tauri::VERSION`。
  - 已在 `lib.rs` 的 `invoke_handler` 注册。

### 前端

- `app/src/api.ts`：新增 `api.getRuntimeInfo()`（`invoke<{appVersion, tauriVersion}>('get_runtime_info')`）。
- `app/src/components/AboutWindow.tsx`：新增组件，渲染图标 + 粗体「TaskBoard」+ 三行信息 + 全宽「确定」按钮。
- `app/src/utils/webviewVersion.ts`：新增 `getWebviewVersion()`，从 `navigator.userAgent` 解析引擎版本（macOS→`WebKit x.x`，Windows→`WebView2 x.x`，Linux→`WebKitGTK x.x`，未知→空串）。
- `app/src/main.tsx`：依 `getCurrentWindow().label` 路由，仅 `about` 窗口渲染 `AboutWindow`。
- i18n：zh-CN / en-US 各新增 4 个 key：
  - `aboutWindow.version` / `aboutWindow.tauri` / `aboutWindow.webview`（「版本」/「Tauri」/「WebView」）
  - `aboutWindow.ok`（「确定」/「OK」）
- `app/src/styles.css`：新增 `.about-window` / `.about-window-icon` / `.about-window-logo` / `.about-window-name` / `.about-window-rows` / `.about-window-row` / `.about-window-key` / `.about-window-val` / `.about-window-ok` 样式（居中布局、圆角图标、三行 flex 两端对齐、全宽主色按钮）。

### 配置

- `app/src-tauri/tauri.conf.json`：`app.windows` 新增 `about` 窗口（`visible: false`，固定 380×320，不可缩放）。

## 数据 / Schema 变更

无。`get_runtime_info` 仅读取编译期常量，不涉及 SQLite schema 或 `tasks` 表变更，无需迁移。

## 测试 / 验收

- **单测** `app/src/components/about-window.test.ts`（8 例）：
  - `getWebviewVersion` 对 macOS / Windows / Linux / 未知 userAgent 的解析（真实导入纯函数）。
  - `main.tsx` 按 label 路由（`about` 只渲染 `AboutWindow`，不挂载 `App`）。
  - `AboutWindow` 三行 + 确定按钮均用 i18n key，确定按钮走 `getCurrentWindow().close()`。
  - 信息来自 `get_runtime_info` 命令；`styles.css` 含 `.about-window` 容器 + 全宽 `.about-window-ok` + 三行布局，复用 `.btn.primary`。
- **回归校验**：`npx tsc --noEmit` 0 error ✅、`npm run i18n:check` 389 keys ✅、`npm run lint` 18 warnings（无新增）✅、`npx prettier --check` ✅、`npm test` 151 例 passed ✅、`cargo check --lib` ✅（macOS 菜单 / 命令 / 窗口路径类型检查通过）。
- **手动验收**（需 GUI 构建）：
  - 菜单栏「About TaskBoard」打开自定义小窗（不再是原生面板）。
  - 小窗展示：图标 + 粗体「TaskBoard」+ `版本: x.y.z` / `Tauri: x.x.x` / `WebView: <引擎>` + 全宽「确定」。
  - 「确定」关闭窗口；窗口尺寸固定、不可缩放。
  - 非 macOS 平台原生 About 无回归。

## 相关链接

- Issue：[#325](https://github.com/ShawnLiuSZ/task-dashboard/issues/325)
- 代码：`app/src-tauri/src/lib.rs`（菜单 / 窗口 / 命令注册）、`app/src-tauri/src/commands.rs`（`get_runtime_info`）、`app/src-tauri/tauri.conf.json`（`about` 窗口）、`app/src/main.tsx`（路由分叉）、`app/src/components/AboutWindow.tsx`、`app/src/utils/webviewVersion.ts`、`app/src/api.ts`、新增 i18n key、`app/src/styles.css`。
- CHANGELOG：[CHANGELOG.md](./CHANGELOG.md) / [CHANGELOG.en.md](./CHANGELOG.en.md)

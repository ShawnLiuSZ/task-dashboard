# #256 检查更新双通道并发 + 暴露 updater 失败原因

## 背景 / 动机

v0.5.0 用户实测（macOS Apple Silicon）：点「关于 → 检查更新」后**很久才出结果**，
且显示「前往下载」手动按钮，一键更新不可用（issue #256）。

排查过程：

- 服务端排除——`latest.json` 200 正常（version 0.5.1、全 18 个平台条目、`darwin-aarch64`
  在列）、各平台安装包 + `.sig` 俱在；签名公钥自 v0.5.0（#231）已内置，排除「老版本无更新器」；
- 根因在前端 `AboutPanel.check`：**串行**——先 `await api.checkAppUpdate()`
 （tauri-plugin-updater 通道），失败后才走 `checkLatestRelease` fallback；
- updater 通道的 HTTP 客户端**没有设置超时**（`updater.check()` 无 timeout 参数），
  而 fallback 自带 20s 超时。弱网下 updater hang 很久才失败，总耗时 = 两者加和；
- `check_app_update` 的 `error` 字段被前端**静默吞掉**（直接 fallback，不展示），
  用户无法自助定位，排查只能靠猜。

## 设计 / 方案

只改前端（`AboutPanel.tsx` + 新纯模块），零新依赖、Rust 零改动：

- **双通道并发**：`Promise.all` 同时发起 `checkAppUpdate` / `checkLatestRelease`，
  总耗时由加和变为取最大；
- **单路 30s 封顶**：新纯模块 `src/utils/updateCheck.ts` 的 `settleWithTimeout`
  把超时/抛错收敛为 `Settled` 数据（永不抛），updater hang 住不会无限拖住 fallback；
- **裁决函数 `decideUpdateState`**（纯函数，11 例单测）：
  - updater 返回可用更新 → 一键更新（与原来一致，fallback 状态不影响）；
  - 否则以 fallback 的版本结论为准：有新版 → 手动下载；已是最新 → 直接最新
    （API 说已是最新，updater 就不可能有更新，即使 updater 侧超时未知——结论依然安全）；
  - updater 健康但与 fallback 结论不一致（版本窗口期）→ 手动下载**不附原因**，不吓用户；
  - 双双失败 → 按「fallback 具体错误 > updater 具体错误 > 超时」优先级展示；
- **失败原因可见**：手动下载时附带 updater 失败行
 （`about.updaterUnavailable` 带后端原文 / `about.updaterTimeout`），双双失败走
  `about.error` / 新增 `about.checkTimeout`。

与已有模块的关系：复用 `AppUpdate` / `CheckUpdate` 类型与既有 `about.*` 文案风格；
纯模块 + 单测延续 `syncHint.ts` 的惯例（可测试逻辑不进组件）。

## 接口 / 行为变更

- 「检查更新」总耗时：加和 → 取最大（且单路 30s 封顶），弱网下不再「转很久才出前往下载」；
- 有新版但 updater 不可用时，「前往下载」按钮上方多一行 muted 小字说明原因
  （以前是什么都不说，直接给下载按钮）；
- updater 可用时行为零变化（一键更新按钮、进度、安装重启流程不动）；
- 新增 i18n key 三对（`about.updaterUnavailable` / `about.updaterTimeout` /
  `about.checkTimeout`），中英各 305 key（`i18n:check` 已过）。

## 数据 / Schema 变更

无。

## 测试 / 验收

- 新增 `src/utils/updateCheck.test.ts` 11 例：裁决 8 例（含超时/窗口期/双失败优先级）、
  `settleWithTimeout` 3 例（透传 / 抛错收敛 / hang 超时）；
- `npm test` 12 文件 99 例全过（之前 11 文件 88 例）；
- `npx tsc --noEmit` 0 error；`npm run i18n:check` 中英各 305 key；
- `prettier --check` 目标文件全过；`check-doc-links.py`（本文档新增后复跑）；
- 真机验收待用户在下一个含本修复的版本上复测（v0.5.0 的旧面板行为改不了，
  需手动安装一次新版，之后的一键更新走新流程）。

## 相关链接

- issue：https://github.com/ShawnLiuSZ/task-dashboard/issues/256
- 应用内更新原始设计：[./issue-231-macos-gatekeeper-update.md](./issue-231-macos-gatekeeper-update.md)
- `CHANGELOG.md` v0.5.2（未发布）条目

# #272 手动下载流程缺少「重启应用」按钮

> 关联 issue：[#272](https://github.com/ShawnLiuSZ/task-dashboard/issues/272)
> 修复分支：`fix/issue-272-restart-after-manual` → `develop`

## 背景 / 动机

用户反馈 v0.6.0 中更新后没有看到「重启应用」按钮，必须手动退出再重新打开 App。

排查后发现：`about.restart` 按钮**仅出现在 updater 通道安装成功后的 `installed` 阶段**（`api.installAppUpdate()` resolve 后）。当 updater 通道失败（签名公钥未配、网络超时、`latest.json` 不可达等），前端回退为手动下载流程（`manualUrl`），用户点「前往下载」跳转浏览器后——App 内**没有任何重启入口**，用户只能手动退出重开。

`latest.json` 和签名公钥在 v0.6.0 Release 上均存在且格式正确，但 updater 通道在弱网 / 代理 / 证书问题下仍可能失败，此时手动下载是唯一可用路径。

## 设计 / 方案

在 `available` 阶段的**手动下载分支**（`state.manualUrl` 非空）追加一个次级按钮「我已安装，重启应用」：

- 文案明确「先下载安装、再点重启」的时序，避免用户误点
- 复用已有的 `api.restartApp()`（Tauri 2 `app.restart()`），零新增依赖 / 零 Rust 改动
- 按钮样式为 `btn`（非 primary），视觉层级低于「前往下载」，符合「先做主操作再点这个」的 UX 直觉

```
┌─ available (manualUrl) ──────────────────────┐
│ ✨ 发现新版本 v0.6.0，当前为 v0.5.1            │
│ [前往下载 ↗]          ← primary，主操作        │
│ [我已安装，重启应用]    ← 次级，手动安装后点击   │
└──────────────────────────────────────────────┘
```

## 接口 / 行为变更

- **前端**：`AboutPanel.tsx` 的 `available` 阶段在 `manualUrl` 非空时新增 `<button>` 调用 `api.restartApp()`
- **i18n**：新增 `about.restartAfterManual` key（中文「我已安装，重启应用」/ 英文「I've installed it — restart app」）
- **Rust / DB schema / MCP**：零改动

## 测试 / 验收

- `npx tsc --noEmit` → 0 error
- `npm test` → 13 文件 136 例 passed
- `npm run i18n:check` → 350 key / locale，占位符一致
- 手动验收路径：updater 通道失败 → 手动下载 → 点「我已安装，重启应用」→ App 重启

## 相关链接

- issue：[#272](https://github.com/ShawnLiuSZ/task-dashboard/issues/272)
- 涉及文件：`app/src/components/AboutPanel.tsx`、`app/src/i18n/locales/{zh-CN,en-US}.json`
- CHANGELOG：`docs/CHANGELOG.md` / `docs/CHANGELOG.en.md`（v0.6.1 Unreleased）

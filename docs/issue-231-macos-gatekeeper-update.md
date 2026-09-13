# issue-231：macOS 更新免除重复 Gatekeeper 放行（固定签名 + 应用内更新）

> 关联 [Issue #231](https://github.com/ShawnLiuSZ/task-dashboard/issues/231)（主）
> · [Issue #232](https://github.com/ShawnLiuSZ/task-dashboard/issues/232)（隔离标记自清）
> · 前置根因 [Issue #87](https://github.com/ShawnLiuSZ/task-dashboard/issues/87) / [#101](https://github.com/ShawnLiuSZ/task-dashboard/issues/101)

## 背景 / 动机

用户反馈：**每次替换安装新版本后，都必须进入「系统设置 → 隐私与安全性」手动点击「仍要打开」**。macOS 15+ 已移除「右键 → 打开」的快捷放行路径，只能走系统设置，操作成本高。

期望：**仅首次安装需要一次人工放行，后续更新不再需要**。

## 设计 / 方案

### 根因（本机实测，macOS 26.5.0）

Gatekeeper 对「仍要打开」的放行记录，比对键是应用的 **designated requirement（DR）**：

```
$ codesign -d -r- /Applications/TaskBoard.app
designated => cdhash H"0a869f7d4529f25d6025cba82508a340a7811dad"

$ codesign -dv --verbose=2 /Applications/TaskBoard.app
Identifier=com.shawnliu.taskboard
Signature=adhoc
TeamIdentifier=not set
```

`macOS.signingIdentity = "-"` 是 **ad-hoc 签名**，其 DR 直接绑定 `cdhash`（整个二进制的哈希）。**每次构建 cdhash 都会变**，系统因此把每个新版本视为一个从未被批准过的全新应用，放行记录永远命中不了。

对照组，Apple 签名应用的 DR 不含哈希，跨版本恒定：

```
$ codesign -d -r- /System/Applications/Calculator.app
designated => identifier "com.apple.calculator" and anchor apple
```

### 方案 A：固定证书签名（让 DR 恒定）

用**稳定的自签名代码签名证书**签名（无需 Developer ID / $99 账号），DR 变为 `identifier + 证书锚点` 形态，跨版本不变 → 首次放行后长期复用。

`tauri.conf.json` 保留 `"signingIdentity": "-"` 作为本地默认，CI 通过 `APPLE_SIGNING_IDENTITY` 环境变量覆盖 —— 这样**没有证书的本地开发机不会构建失败**。

### 方案 B：应用内自动更新（彻底绕开 Gatekeeper）

接入 `tauri-plugin-updater`（此处豁免 AGENTS.md §2.5「不引入新依赖」约定，属功能必需）。

关键机制：**Gatekeeper 只在文件带 `com.apple.quarantine` 时介入评估**。而隔离标记由下载方进程写入 —— 浏览器会写，应用自身进程不会。更新包交由应用进程下载，产物天然不带隔离标记，**Gatekeeper 完全不参与**。

- 完整性校验用 Tauri 自有 minisign 密钥对，与 Apple 证书体系无关
- macOS 产物：`TaskBoard.app.tar.gz` + `.sig`；三端统一由 tauri-action 汇总为 `latest.json`

### 方案 C：修复 #101 隔离标记自清（#232）

实测发现 #101 的自动清除长期空转：

```
$ xattr -l /Applications/TaskBoard.app
com.apple.provenance:
com.apple.quarantine: 01c3;6aa53d50;Safari;1395650C-...

$ xattr -l /Applications/TaskBoard.app/Contents/MacOS/taskboard
com.apple.provenance:          ← 可执行文件上没有隔离标记
```

隔离标记落在 **bundle 根目录**，而原实现清理的是 `current_exe()`（文件路径），`xattr -dr` 不向上越级，永远够不到 bundle 根，`has_quarantine(exe)` 恒为 false 即提前返回。修复方式是同时清理 bundle 根与可执行文件两个目标。

### 关键权衡

- **为何 A 与 B 都要做**：B 覆盖「应用内更新」这条主路径，但用户手动重装 DMG 时仍走 Gatekeeper；A 让这条旁路也只需首次放行。两者互补。
- **为何不关闭 Gatekeeper**：`spctl --master-disable` 会移除整机防护，且 macOS 15+ 仍有额外限制，收益与风险不成比例。
- **为何在 macOS 上 updater 依赖签名**：Tauri 替换 bundle 后，若应用无稳定签名，新版本可能无法通过系统校验启动。A 是 B 的前置保障。

## 接口 / 行为变更

### 新增 Tauri 命令

| 命令 | 签名 | 说明 |
|---|---|---|
| `check_app_update` | `(app) -> Result<AppUpdate, String>` | 经 updater 通道检查；失败不抛错，填进 `error` 字段供前端回退 |
| `install_app_update` | `(app) -> Result<(), String>` | 下载并安装更新，下载期间持续发进度事件 |
| `restart_app` | `(app)` | 调用 `AppHandle::restart()` 重启生效 |

### 新增事件

| 事件名 | 负载 | 说明 |
|---|---|---|
| `taskboard://update-progress` | `{ downloaded: u64, total: Option<u64> }` | 更新下载进度 |

### 前端行为

`AboutPanel` 的「检查更新」改为**优先走应用内更新**：

1. `check_app_update` 可用且有新版本 → 展示版本 + release notes + **「立即更新」**按钮（一键下载安装）
2. 安装完成 → 提示「重启应用后生效」+ **「重启应用」**按钮
3. `check_app_update` 返回 error（未配置公钥 / 尚无 latest.json）→ **静默回退**为原 `check_latest_release` 版本号对比 + 「前往下载」跳转，功能不整体失效

### 新增 i18n key（中英双份）

`about.install` / `about.installing` / `about.progress` / `about.installed` / `about.restart`

## 数据 / Schema 变更

无。纯构建配置、更新通道与启动期环境修复。

## 部署前置（一次性）

### 1. 生成代码签名证书（方案 A）

用「钥匙串访问 → 证书助理 → 创建证书」，名称**必须是** `TaskBoard Local Signing`（与 `release.yml` 中的 `APPLE_SIGNING_IDENTITY` 一致），身份类型选「代码签名」，有效期建议 3650 天。

导出为 `.p12` 后，连同密码一起配置为 GitHub Secrets。

> ⚠️ 若改用 CLI 生成，必须注意两个坑（已实测）：
> 1. PKCS12 **必须用旧算法打包**，否则 `security import` 报 `MAC verification failed`：
>    `openssl pkcs12 -export -legacy -certpbe PBE-SHA1-3DES -keypbe PBE-SHA1-3DES -macalg SHA1 ...`
> 2. 分开导入 PEM 证书与 PEM 私钥**不会配对成身份**，必须整包 p12 导入（成功标志：`1 identity imported.`）

### 2. 生成 minisign 更新密钥（方案 B）

```bash
cd app
npm run tauri signer generate -- -w ~/.tauri/taskboard-updater.key
```

- **私钥务必离线备份** —— 丢失后已安装的客户端将无法再收到任何更新
- 公钥内容填入 `tauri.conf.json` 的 `plugins.updater.pubkey`（替换占位符 `__REPLACE_WITH_TAURI_SIGNER_PUBLIC_KEY__`）

### 3. 配置 GitHub Secrets

| Secret | 来源 |
|---|---|
| `APPLE_CERTIFICATE` | 证书 `.p12` 的 base64：`base64 -i cert.p12 \| pbcopy` |
| `APPLE_CERTIFICATE_PASSWORD` | 导出 p12 时设置的密码 |
| `KEYCHAIN_PASSWORD` | 自定，CI 临时钥匙串口令 |
| `TAURI_SIGNING_PRIVATE_KEY` | minisign 私钥文件内容或路径 |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | 生成密钥时设置的密码 |

> ⚠️ 未配置 `TAURI_SIGNING_PRIVATE_KEY` 时，因 `bundle.createUpdaterArtifacts` 已开启且签名不可禁用，**release 构建会直接失败**。本改动合并后、下次发版前必须完成配置。

## 测试 / 验收

已执行：

- `cargo check` 通过（`tauri-plugin-updater v2.11.0` 编译成功，45.75s）
- `npx tsc --noEmit` 通过
- `npm run i18n:check` 通过（中英 key 数与占位符一致）

手动验收（需真实发布两个版本）：

1. 首次安装仍需一次人工放行（系统强制行为，无法绕过）
2. 通过应用内更新升级到下一版本，全程**无 Gatekeeper 提示**
3. 应用内更新后，新 bundle 不含 `com.apple.quarantine`
4. 手动下载 DMG 覆盖安装，`codesign -d -r-` 的 DR 与上一版**逐字符一致**
5. 三端 CI 打包通过，Release 附件包含 `.app.tar.gz` / `.sig` / `latest.json`
6. `check_app_update` 在 pubkey 未配置时返回 error，界面正确回退到「前往下载」

## 相关链接

- Issue：[#231](https://github.com/ShawnLiuSZ/task-dashboard/issues/231)（本）、[#232](https://github.com/ShawnLiuSZ/task-dashboard/issues/232)
- 根因：#87（MCP 握手超时）、#101（隔离标记自清）
- 代码：`app/src-tauri/src/commands.rs`、`app/src-tauri/src/lib.rs`、`app/src/components/AboutPanel.tsx`
- 构建：`.github/workflows/release.yml`、`app/src-tauri/tauri.conf.json`
- 排障：[troubleshoot-mcp-timeout.md](./troubleshoot-mcp-timeout.md)
- CHANGELOG：`docs/CHANGELOG.md` / `docs/CHANGELOG.en.md`

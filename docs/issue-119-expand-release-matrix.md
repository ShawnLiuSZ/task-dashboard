# Issue #119：扩展 Release 打包矩阵（arm64 全平台 + rpm + 便携 zip 尝试）

> 补写文档：本 issue 的实现在 v0.3.48 合入（提交 `b8a8bd3`，PR #124），但知识库文档当时**未创建**，导致 `CHANGELOG` 的链接长期悬空。本文依据该提交及其**当日回滚提交**的真实 diff 回填。见 [issue #239](https://github.com/ShawnLiuSZ/task-dashboard/issues/239)。

## 背景 / 动机

[#118](./issue-118-expand-platform-support.md) 补齐了「架构」维度（macOS 双架构 + Windows ARM64），但**格式**维度仍有缺口：

| 缺口 | 影响 | 结果 |
|---|---|---|
| Linux 只有 amd64，无 arm64 | ARM 服务器 / 树莓派 / ARM 桌面无法原生运行 | ✅ 已交付 |
| 无 `rpm` | Fedora / RHEL / openSUSE 用户无法用系统包管理器安装 | ✅ 已交付 |
| 无 Windows `msi` | 企业批量部署（GPO / 静默安装）缺形态 | ✅ 已交付 |
| 无独立便携 `zip` | 无安装权限的受限环境没有可用形态 | ❌ **当日回滚**，见下 |

对应 issue：[#119](https://github.com/ShawnLiuSZ/task-dashboard/issues/119)

## 设计 / 方案

### 决策 1：Linux 补 arm64（`ubuntu-22.04-arm` runner）

新增矩阵条目：

```yaml
# Linux arm64
- platform: ubuntu-22.04-arm
  bundles: deb,rpm,appimage
  target: aarch64-unknown-linux-gnu
```

### 决策 2：Linux 依赖安装条件从「平台全等」改为「按 OS 判定」

原条件 `if: matrix.platform == 'ubuntu-22.04'` 在新增 arm64 条目后会**被跳过**（平台名不相等），ARM 构建将因缺依赖而失败。改为：

```yaml
- name: Install Linux dependencies
  if: runner.os == 'Linux'
```

同时依赖列表追加 `rpm`（Tauri 打 rpm 需要 `rpmbuild`）。

### 决策 3：Windows 同时提供 NSIS 与 MSI

`bundles: nsis,msi`——NSIS 适合一般用户（体积小、交互简单），MSI 适合企业批量部署（GPO / 静默安装）。

### ⚠️ 决策 4（已回滚）：便携 `zip` —— Tauri 2 不支持该 bundle 类型

`b8a8bd3` 曾为 macOS / Windows 追加 `zip`：

```yaml
# 已被回滚，勿再照抄
bundles: app,dmg,zip      # macOS
bundles: nsis,msi,zip     # Windows
```

**同一天 30 分钟后**（提交 `18049ec`，2026-09-07 20:04）即被移除，提交信息给出确定结论：

> Tauri 2 只支持以下 bundle 类型：
> - macOS: app, dmg
> - Windows: nsis, msi
> - Linux: deb, rpm, appimage
>
> zip 不是有效的 bundle 类型。

因此「独立便携 zip」这一目标**未达成**，且不应再尝试——`tauri-action` 的 `--bundles` 只接受上述枚举值。若日后确实需要便携形态，正确做法是**在 `tauri-action` 之后加一步 `actions/upload-artifact` / 打包 `target/release/*.app`（或 `.exe`）为 zip**，而不是把 `zip` 塞进 `--bundles`。

## 最终矩阵（当前仓库实际状态）

```yaml
matrix:
  include:
    # macOS ARM (Apple Silicon)
    - platform: macos-latest
      bundles: app,dmg
      target: aarch64-apple-darwin
    # macOS x64 (Intel)
    - platform: macos-latest        # v0.3.55 起改为交叉编译（原 macos-13 排队严重）
      bundles: app,dmg
      target: x86_64-apple-darwin
    # Windows x64
    - platform: windows-latest
      bundles: nsis,msi
      target: x86_64-pc-windows-msvc
    # Windows ARM64
    - platform: windows-11-arm
      bundles: nsis,msi
      target: aarch64-pc-windows-msvc
    # Linux amd64
    - platform: ubuntu-22.04
      bundles: deb,rpm,appimage
      target: x86_64-unknown-linux-gnu
    # Linux arm64
    - platform: ubuntu-22.04-arm
      bundles: deb,rpm,appimage
      target: aarch64-unknown-linux-gnu
```

构建条目由 #118 的 5 条扩为 **6 条**，覆盖 `3 平台 × 2 架构`。

## 接口 / 行为变更

- **CI**：矩阵 `5` → `6` 条；Linux 依赖条件改为 `runner.os == 'Linux'` 并追加 `rpm`；Windows 增加 `msi`。
- **产物**：新增 Linux arm64（deb/rpm/appimage）、Windows msi、Linux rpm。
- **未交付**：便携 zip（见「决策 4」）。
- **文档**：README / README.en.md 平台表同步。

Tauri command、MCP 工具、SQLite schema **均无变更**。

## 数据 / Schema 变更

无。

## 测试 / 验收

### 验收标准

- [x] 矩阵含 arm64 全平台（macOS / Windows / Linux）
- [x] Windows 有 msi、Linux 有 rpm
- [x] Linux 依赖安装按 OS 判定，ARM runner 不再被跳过
- [x] `rpm` 构建工具已装入 Linux runner
- [ ] ~~便携 zip~~ —— **不适用**（Tauri 2 不支持 `zip` bundle 类型，已回滚）

### 验证方式

CI 工作流改动无法本地单测；验证依赖**发布一次 Release 并核对产物列表**（`release.yml` 在 Release Publish 时触发）。

### 同批次的其他 CI 修复（供排查参考）

同日还修过：`tauri-action@v2` 不存在 → 改 `v1`（`e5a44ae`/`1f148e1`）、升级 `checkout` / `setup-node` 消除 Node 弃用警告（`294ccf5`）。更早（09-04）修过 `libayatana-appindicator3-dev` 与 `libappindicator3-dev` 冲突（`d2135d1`）。**改动 bundle 列表前先确认 Tauri 2 的有效枚举值，别照抄其他项目的写法。**

## 相关链接

- Issue：[#119](https://github.com/ShawnLiuSZ/task-dashboard/issues/119)
- 实现提交：`b8a8bd3`（PR #124）；**回滚提交**：`18049ec`
- 前置 issue：[#118](https://github.com/ShawnLiuSZ/task-dashboard/issues/118)（架构扩展）
- 相关文档：[docs/design-and-release.md](./design-and-release.md)、[docs/issue-118-expand-platform-support.md](./issue-118-expand-platform-support.md)
- 补写原因：[#239](https://github.com/ShawnLiuSZ/task-dashboard/issues/239)
- CHANGELOG：[docs/CHANGELOG.md](./CHANGELOG.md) v0.3.48 条目

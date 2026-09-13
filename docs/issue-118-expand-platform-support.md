# Issue #118：扩展平台支持（macOS 双架构 + Windows ARM64）

> 补写文档：本 issue 的实现在 v0.3.48 合入（提交 `4fb6c7b`，PR #123），但知识库文档当时**未创建**，导致 `CHANGELOG` 的链接长期悬空。本文依据该提交的真实 diff 回填，非事后追述。见 [issue #239](https://github.com/ShawnLiuSZ/task-dashboard/issues/239)。

## 背景 / 动机

v0.3.47 之前，release 工作流只产出单一架构的安装包：

| 平台 | 架构 | 格式 |
|---|---|---|
| macOS | 仅 `macos-latest`（当时为 ARM 或 x64 之一，取决于 runner 池） | app, dmg |
| Windows | 仅 x64 | nsis |
| Linux | 仅 amd64 | deb, appimage |

问题：

1. **macOS 架构不明确**——`macos-latest` 的架构随 GitHub runner 池演进，用户下载到的包可能与其机器架构不匹配（Apple Silicon 用户拿到 x64 包需经 Rosetta 转译）。
2. **Windows ARM64 完全缺位**——ARM 设备（Surface Pro X 等）只能跑模拟。
3. 构建产物没有显式声明 `target`，`tauri-action` 依赖 runner 默认 host target，跨架构构建无路径。

对应 issue：[#118](https://github.com/ShawnLiuSZ/task-dashboard/issues/118)

## 设计 / 方案

### 决策 1：矩阵显式声明 `target`，不再依赖 runner 默认值

`release.yml` 的 `matrix.include` 中每个条目新增 `target` 字段：

```yaml
matrix:
  include:
    # macOS ARM (Apple Silicon)
    - platform: macos-latest
      bundles: app,dmg
      target: aarch64-apple-darwin
    # macOS x64 (Intel)
    - platform: macos-13
      bundles: app,dmg
      target: x86_64-apple-darwin
    # Windows x64
    - platform: windows-latest
      bundles: nsis
      target: x86_64-pc-windows-msvc
    # Windows ARM64
    - platform: windows-11-arm
      bundles: nsis
      target: aarch64-pc-windows-msvc
    # Linux amd64
    - platform: ubuntu-22.04
      bundles: deb,appimage
      target: x86_64-unknown-linux-gnu
```

### 决策 2：用 `macos-13` 承担 Intel 构建

Apple Silicon runner（`macos-latest`）跑 `aarch64-apple-darwin`，Intel 构建交给 `macos-13`（当时的 x64 runner）。**注意**：`macos-13` 后续被 GitHub 标记 deprecated，v0.3.55 已改为在 `macos-latest` 上交叉编译（见下方「后续演进」）。

### 决策 3：Rust 工具链显式安装目标

```yaml
- name: Setup Rust
  uses: dtolnay/rust-toolchain@stable
  with:
    targets: ${{ matrix.target }}
```

不装目标时 `--target` 会报 target 未安装。构建参数同步改为：

```yaml
args: --target ${{ matrix.target }} --bundles ${{ matrix.bundles }}
```

### 决策 4：README 增加「支持的平台与架构」表

原 README 只写「三端安装包（macOS / Windows / Linux）」，改为逐架构列出，让用户知道该下哪个包。

## 接口 / 行为变更

- **CI**：release 矩阵 `3` → `5` 个条目；每个条目新增 `target`；`tauri-action` 新增 `--target` 参数。
- **产物**：新增 macOS x64（显式）、Windows ARM64 安装包。
- **文档**：README / README.en.md 新增平台-架构表。

Tauri command、MCP 工具、SQLite schema **均无变更**。

## 数据 / Schema 变更

无。

## 测试 / 验收

### 验收标准

- [x] 矩阵含 macOS aarch64 / x86_64、Windows x64 / ARM64、Linux amd64 共 5 条
- [x] 每条显式声明 `target`，`Setup Rust` 安装对应 target，`tauri-action` 传 `--target`
- [x] README / README.en.md 列明平台与架构

### 验证方式

CI 工作流改动无法在本地单测覆盖，验证依赖**发布一次 Release 并检查产物矩阵**（`release.yml` 在 Release Publish 时触发）。

## 后续演进（本文档时序外补充）

| 时间 | 变更 | 文档 |
|---|---|---|
| v0.3.48（#119） | 打包矩阵补齐 arm64 全平台、rpm、独立 zip | [docs/issue-119-expand-release-matrix.md](./issue-119-expand-release-matrix.md) |
| v0.3.55 | Intel 构建改用 `macos-latest` 交叉编译，解决 `macos-13` runner 排队问题 | `git log --grep="macos-13 runner 排队"` |
| #231/#232 | 应用内自动更新 + 固定签名，免除 macOS 重复 Gatekeeper 放行 | [docs/issue-231-macos-gatekeeper-update.md](./issue-231-macos-gatekeeper-update.md) |

## 相关链接

- Issue：[#118](https://github.com/ShawnLiuSZ/task-dashboard/issues/118)
- 实现提交：`4fb6c7b`（PR #123，`feature/issue-118-expand-platform-support`）
- 后续 issue：[#119](https://github.com/ShawnLiuSZ/task-dashboard/issues/119)（打包矩阵）
- 相关文档：[docs/design-and-release.md](./design-and-release.md)（发布流程与签名前提）
- 补写原因：[#239](https://github.com/ShawnLiuSZ/task-dashboard/issues/239)
- CHANGELOG：[docs/CHANGELOG.md](./CHANGELOG.md) v0.3.48 条目

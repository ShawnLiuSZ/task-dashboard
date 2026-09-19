# 配置项目开源协议（LICENSE）（#281）

> 对应 issue：[#281 chore: 配置项目开源协议（LICENSE）](https://github.com/ShawnLiuSZ/task-dashboard/issues/281)

## 1. 背景 / 动机

仓库此前没有任何协议声明——根目录无 `LICENSE`，`package.json` 与 `Cargo.toml` 都没有 `license` 字段。后果是法律意义上的**默认保留全部权利（all rights reserved）**：别人能 fork、能看，但没有任何条款允许复制、修改或分发。对一个公开开源的仓库，这等于"看起来是开源，实际上没有授权"，也是 GitHub 上最常见的合规漏洞。

同时协议声明散落在四个载体里，任一缺失都会让下游工具读不到：根目录 `LICENSE` 文件（人读、GitHub 页脚自动识别）、包管理器元数据（`package.json` / `Cargo.toml` 的 `license` 字段，供依赖扫描器与安装器读取）、文档（README / CONTRIBUTING 让贡献者与使用者一眼看到）。

## 2. 决策：为什么是 MIT

| 协议 | 归属 | ✅ 优势 | ⚠️ 代价 / 不适合的理由 |
| --- | --- | --- | --- |
| **MIT** | Permissive | 条款最短（约 170 词），使用者几乎无义务；Tauri 2 自身即 MIT，与本项目技术栈惯例一致 | 无任何专利授权条款（Apache-2.0 才有显式专利授权） |
| Apache-2.0 | Permissive | 显式专利授权 + 显式修改声明要求 | 条款长（4 节正文 + 2 个附录），对"个人任务看板"这个体量过重 |
| GPL-3.0 | Copyleft | 强传染，保证下游继续开源 | 用户把本工具改造成闭源内部工具即构成违规——与"个人工具、随取随用"的定位直接冲突 |
| AGPL-3.0 | Network Copyleft | 覆盖网络服务场景 | 本项目是本地桌面 App、无服务端分发场景，AGPL 的触发条件基本用不上，却把使用门槛推到最高 |

结论选 **MIT**（issue 内的推荐项），理由收敛为三点：

1. **技术栈惯例**：Tauri 核心、`tauri-plugin-updater` 为 MIT；`rusqlite` / `serde` 为 MIT；前端 `react` / `react-dom` 为 MIT；`@tauri-apps/cli` 为 Apache-2.0。全部依赖都是宽松类协议，本项目的 MIT 与依赖树零冲突。
2. **定位匹配**：本项目是个人效率工具，不是被公司集成的商业组件——不需要 Apache-2.0 的专利兜底，也不应该用 copyleft 阻碍使用者改造。
3. **贡献门槛**：MIT 只需保留版权声明，PR 作者不需要理解修改声明义务，降低上游合并的心理成本。

### 2.1 选 `MIT` 而非 `MIT-0`

SPDX 里还有 **MIT-0（MIT No Attribution）**，它去掉了"必须保留版权声明"这一条。本项目**不选 MIT-0**：保留版权声明条款是 MIT 与 MIT-0 的唯一实质差别，而保留要求对上游追溯（谁改了什么、原始代码在哪）是免费的收益，去掉它没有任何必要收益。因此元数据统一写 SPDX 标识符 `MIT`，**不是** `MIT-0`、也**不是** npm 历史惯用的 `ISC`（ISC 与 MIT 文本不同，混用会误导依赖扫描器）。

### 2.2 版权主体与年份

- 版权主体写仓库 owner 的 GitHub login **`ShawnLiuSZ`**，与 `README` / CI 配置 / GitHub Actions 产物中的归属一致（`Cargo.toml` 的 `authors` 写作 `liushizhao`，是更早期的简写，本次不动以避免额外改动面）。
- 年份写 **2026**（项目首个公开发布年为 2026）。不写 `2026-YYYY` 这种未来区间，也不写 `2025-2026`——本项目首个公开提交都在 2026 年。

## 3. 落地清单

issue 内四项待办的对应关系：

| # | 待办 | 落地位置 | 状态 |
| --- | --- | --- | --- |
| 1 | 确定协议类型 | MIT（决策依据见 §2） | ✅ |
| 2 | 创建 LICENSE 文件 | 根目录 `LICENSE` | ✅ |
| 3 | README 注明协议 | `README.md` / `README.en.md` 顶部徽章 + 底部「协议」章节 | ✅ |
| 4 | 更新 `package.json` / `Cargo.toml` | 各加 `license` 字段 | ✅ |

### 3.1 根目录 `LICENSE`

采用 MIT 官方标准文本（SPDX 收录版本），只改动版权行。全文 21 行，末尾保留换行。

### 3.2 包管理器元数据

```jsonc
// app/package.json
"private": true,
"version": "0.6.0",
"license": "MIT",
```

```toml
# app/src-tauri/Cargo.toml
[package]
name = "taskboard"
version = "0.6.0"
description = "GitHub 个人任务看板"
license = "MIT"
authors = ["liushizhao"]
```

两处都用 SPDX 标识符（npm 与 Cargo 都接受），而不是自然语言描述 `"license": "MIT License"` 之类——后者会让 `npm license` / `cargo metadata` 归一化为 `Unknown`。

`Cargo.toml` 里字段按惯例插在 `description` 与 `authors` 之间，保持 name → version → description → license → authors → edition 的常见顺序。

### 3.3 两个包管理器为何不需要额外改动

- **`Cargo.lock` 不改**：Cargo 只对来自 registry 的包记录 `license` 字段，**本地路径包（含 workspace 根包）只记 name / version / dependencies**。所以根包的 `license` 不会、也不应该出现在 `Cargo.lock` 里——`cargo metadata --locked` 已验证不因本次改动失配。
- **`package-lock.json` 不改**：`license` 不参与依赖树解析，`npm ci` 的同步性检查只看 `dependencies` / `devDependencies` 的 spec 是否一致。本仓库的 lock 根条目版本号历史就与 `package.json` 不同步（lock 为 `0.4.0`、package.json 为 `0.6.0`），本次不扩大改动面。

`package.json` 的 `"private": true` 与新增的 `license` 并不矛盾：`private` 只阻止 `npm publish`，`license` 是给**使用者读**的元数据（GitHub 页脚识别、依赖扫描器、`npm ls --license`），私有包带上它依然是正确且推荐的做法。

### 3.4 文档

- `README.md` / `README.en.md`：预览图下方新增 License 徽章（`shields.io` 静态文本徽章，非第三方 API），底部新增「协议（License）」/ `License` 章节——点明 MIT、给出 `LICENSE` 链接、概括「保留版权声明」这一唯一义务、并复述免责条款的存在。
- `CONTRIBUTING.md`：新增「协议（License）」小节，说明三条对贡献者的影响——PR 即视为按 MIT 授权、引入第三方代码需自行确认兼容并保留原版权声明、依赖各自的协议以其自带 `LICENSE` 为准。

## 4. 无其他变更

不碰 SQLite schema、不碰 Rust 业务逻辑、不碰前端代码、不碰 MCP 双实现、不碰 CI 配置。纯仓库元数据与文档改动。

## 5. 测试 / 验收

### 5.1 元数据解析

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| `package.json` 仍是合法 JSON 且 license 被解析 | `python3 -c "import json;print(json.load(open('app/package.json'))['license'])"` | 输出 `MIT` |
| Cargo 能解析新 `license` 字段（SPDX 合法） | `cargo metadata --locked` | 通过（无 `failed to parse` / `license ... is invalid`） |
| 依赖解析未受影响 | `npm ci`（`app/`） | 通过（exit 0，未报 lock 失配） |

### 5.2 文档完整性

| 检查 | 结果 |
| --- | --- |
| `python3 scripts/check-doc-links.py` | ✅ 无断链（新增 `LICENSE` 相对链接与徽章 URL 均可达） |
| `python3 scripts/check-workflow-yaml.py` | ✅ 6 个 workflow 全绿（本次未动 workflow，回归防误伤） |
| `python3 -m unittest discover -s scripts -p 'test_*.py'` | ✅ 全绿（同上，回归） |

### 5.3 GitHub 侧效果

- 仓库根有 `LICENSE` 且内容可被识别为 MIT 后，GitHub 会在**仓库主页顶部与文件树下方**自动显示 `MIT license`，PR 页脚也会显示协议。
- `CONTRIBUTING.md` 与 `SECURITY.md` 均存在，GitHub 会在 PR / Issue 表单中自动附加对应链接。

## 6. 相关链接

- issue：[#281](https://github.com/ShawnLiuSZ/task-dashboard/issues/281)
- 本仓库：[`LICENSE`](../LICENSE) / [`CONTRIBUTING.md`](../CONTRIBUTING.md) / [`SECURITY.md`](../SECURITY.md)
- MIT License 官方文本：<https://spdx.org/licenses/MIT.html>
- SPDX License List：<https://spdx.org/licenses/>
- npm `license` 字段：<https://docs.npmjs.com/cli/v10/configuring-npm/package-json#license>
- Cargo `license` 字段：<https://doc.rust-lang.org/cargo/reference/manifest.html#the-license-and-license-file-fields>

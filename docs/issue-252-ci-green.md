# #252 让 quality-check.yml 全绿 —— prettier 全量格式化 + 补 Linux 系统库

## 背景 / 动机

`quality-check.yml`（#246 引入）**4 个 job 里有 3 个在 `develop` 上就是红的**，与本仓库任何业务改动无关：

| job | 修复前 | 修复后 |
|---|---|---|
| Frontend Tests | ✅ pass | ✅ pass |
| Frontend Lint | ❌ `format:check`：29 个文件未格式化 | ✅ pass |
| Rust Clippy | ❌ 缺 GTK/GLib 系统库 | ✅ pass |
| Rust Tests | ❌ 同上 | ✅ pass |

这是**既有失败**（都是 push / PR 到 develop 的运行）：

- push `develop`：<https://github.com/ShawnLiuSZ/task-dashboard/actions/runs/34854155269>
- 引入该 workflow 的 #246 PR：<https://github.com/ShawnLiuSZ/task-dashboard/actions/runs/34853788230>

**动机**：任何新 PR 的 CI 都必然红，判定「失败是否由本次改动引入」只能逐 job 翻日志。
实际已经挡了 #249 与 #251 两个 PR。

## 设计 / 方案

### 问题 A：29 个文件未 prettier 格式化

#246 引入了 `.prettierrc` 与 `npm run format` / `format:check`，但 **`npm run format` 从未跑过**，
于是 `format:check` 从加入的第一天起就是红的。

**决策 A1：格式化成独立 commit，且用「产物哈希不变」证明零影响。**

纯格式化 commit 的问题是 review 时噪音极大（29 个文件 / +2137 −1625）。除了「单独 commit」，
这里额外做了**可验证的零影响证明**：格式化前后各构建一次，比对产物 sha256。

| | sha256 |
|---|---|
| `dist/assets/index-7Ca_BQwS.js` | `717d704e…cf2daacfd2` |
| `dist/assets/index-BKrHbFZ_.css` | `49bc8527…1f701f1b52` |

两处**逐字节一致** —— 比「测试通过」更强的证据：格式化没有改变任何构建结果。
（这个技巧值得复用：凡是对源码做机械变换，都可先用「产物哈希是否变化」做一道硬判定。）

**澄清：ESLint 不是阻塞项。** `npm run lint` 实测 `exit=0`：#246 把脚本写成
`--max-warnings 20`，而实际只有 17 条 `react-refresh/only-export-components` warning，
所以一直没触发失败。**本 issue 不动 ESLint 配置。**

### 问题 B：两个 Rust job 缺 Linux 系统库

`rust-clippy` / `rust-tests` 都是 `runs-on: ubuntu-latest` 后直接跑 cargo，
**没有安装 Tauri 在 Linux 上所需的系统库**，于是连 `--lib` 都编不过
（tauri → wry → webkit2gtk → gtk/glib 在 build script 阶段就要 pkg-config 找到库）：

```
error: failed to run custom build command for `glib-sys v0.18.1`
  pkg-config exited with status code 1
  > pkg-config --libs --cflags glib-2.0 'glib-2.0 >= 2.70'
error: failed to run custom build command for `gio-sys v0.18.1`
error: failed to run custom build command for `gobject-sys v0.18.0`
```

根因很具体：**`release.yml` 一直有 `Install Linux dependencies` 这一步，`quality-check.yml` 没有。**
同一份 apt 清单散落多处时，漏装只是时间问题。

**决策 B1：抽 composite action，而不是复制第三遍。**

新增 `.github/actions/install-linux-deps/action.yml`，三个调用点引用它：

| 调用方 | 变更 |
|---|---|
| `.github/workflows/release.yml` | 内联步骤 → `uses: ./.github/actions/install-linux-deps`（apt 清单原样不变） |
| `.github/workflows/quality-check.yml` → `rust-clippy` | 新增该步骤（在 checkout 之后） |
| `.github/workflows/quality-check.yml` → `rust-tests` | 同上 |

把 `if: runner.os == 'Linux'` **放进 action 内部**，调用方无需重复写条件
（release.yml 的矩阵含 macOS/Windows，会自动跳过）。

**决策 B2：不拆「测试用精简版 + 打包用完整版」两份清单。**

`patchelf` / `xdg-utils` / `rpm` 其实只有打包才需要，测试装它们是浪费十几秒。
但仍然共用同一份完整清单 —— 一旦按用途拆成两份，就重新引入了「改一处漏一处」的结构，
正是本 issue 的成因。多花十几秒换取清单唯一性，划算。

**决策 B3：不把 Rust job 挪到 `macos-latest`。**

macOS runner 计费约为 Linux 的 10 倍；且 release 矩阵本就覆盖 Linux，
这两个 job 正好承担「守住 Linux 上能编译」的职责。若想额外验证 macOS，应**另加** job 而非替换。

## 接口 / 行为变更

| 项 | 变更 |
|---|---|
| 产品代码 | **无行为变更**（格式化的产物哈希逐字节一致） |
| 新增文件 | `.github/actions/install-linux-deps/action.yml`（composite action） |
| `release.yml` | 步骤等价替换，执行内容不变 |
| `quality-check.yml` | 两个 Rust job 新增「安装 Linux 依赖」步骤 |

## 数据 / Schema 变更

无。

## 测试 / 验收

### 本地验证（可复现）

| 检查 | 结果 |
|---|---|
| `npm run format:check` | ✅ `All matched files use Prettier code style!`（29 → 0） |
| 构建产物 sha256（格式化前 vs 后） | ✅ **逐字节一致**（JS `717d704e…`、CSS `49bc8527…`） |
| `npx tsc --noEmit` | 0 error |
| `npm test` | 11 文件 88 例 |
| `npm run lint` | exit 0 |
| `npm run i18n:check` | 中英各 302 key |
| YAML 合法性 | ✅ 5 个 workflow + `action.yml` 全部可解析 |
| 结构性断言 | ✅ 两个 Rust job 均引用 `install-linux-deps`；release.yml 亦已改为引用 |

YAML 校验与断言脚本（本次临时执行，未入库）：

```python
# 5 个 workflow + action.yml 全部 yaml.safe_load 通过；
# 并断言 quality-check.yml 的 rust-clippy / rust-tests 的 steps 里含
# uses: ./.github/actions/install-linux-deps
```

### CI 验收

Linux 环境无法在本地复现，**最终以本 PR 的 workflow 运行结果为准**：

1. `quality-check.yml` 四个 job 全部 pass
2. 合并后 `develop` 上的 push 运行同样四个 job 全绿
3. 后续新 PR 不再出现「这两个 job 红但与自己无关」的噪音

### 验收清单

1. `quality-check.yml` 四个 job 全部 pass
2. `npm run format:check` 本地零警告（29 → 0）
3. `cargo clippy --lib -p taskboard -- -D warnings` 与 `cargo test --lib` 在 CI 上通过
4. 格式化 commit 不含任何业务逻辑改动，且产物哈希不变（见上表）
5. 格式化 commit 与 CI 改动分开，可各自 revert
6. 不引入新依赖、不改 ESLint 配置

## 相关链接

- issue：[#252](https://github.com/ShawnLiuSZ/task-dashboard/issues/252)
- 分支：`fix/issue-252-ci-green`
- 引入该 workflow 的批次：[#246](https://github.com/ShawnLiuSZ/task-dashboard/issues/246)（Lint / Clippy / CI / 文档）
- 被这两个 job 挡过的 PR：#249（#248 同步日志横向滚动）、#251（#250 未同步 issue 按需拉取）
- CHANGELOG：[`CHANGELOG.md`](./CHANGELOG.md) Unreleased 段

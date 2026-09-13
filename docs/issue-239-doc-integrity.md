# Issue #239：文档完整性修复（断链 + 不可移植路径 + 失效锚点 + CHANGELOG 缺口）

## 背景 / 动机

起因是 [#237](./issue-237-card-creator-row.md) 的 PR 描述里附带提到「`CHANGELOG` 有两个断链」。随后对全仓库 markdown 做了一次链接扫描（115 个文件），发现同类问题共 **7 类、24 处**；在核实「链接指向的文档是否存在」的过程中，又发现 **CHANGELOG 本身存在更大的完整性缺口**。

对应 issue：[#239](https://github.com/ShawnLiuSZ/task-dashboard/issues/239)

### 缺陷清单

| 类别 | 数量 | 说明 |
|---|---|---|
| **A. 指向不存在的文档** | 8 处引用 / 3 篇文档 | `issue-118-*` / `issue-119-*`（`CHANGELOG` 引用）、`perf-audit-optimization.md`（4 篇 KB 文档引用）。三篇**从未被提交过**（`git log --diff-filter=A` 为空） |
| **B. `file://` 绝对路径** | 15 处 / 7 文件 | 形如 `file:///Users/<家目录>/repo/app/...`，只在本机可用 |
| **C. 相对路径深度错误** | 4 处 / 1 文件 | `issue-95` 用 `](app/...)`，从 `docs/` 出发解析为 `docs/app/...` |
| **D. 失效行号锚点** | 5 处 / 2 文件 | `#Lxxx` 已全部漂移，点击落到**无关代码**（符号名未变，行号变了） |
| **E. 工作记忆相对路径错误** | 1 处 | `.workbuddy/memory/MEMORY.md` 用 `../docs/`，只到 `.workbuddy/docs/` |
| **F. v0.3.50 CHANGELOG 缺记 13 个 issue** | 13 项 | v0.3.50 实际合并 11 个 PR，条目只写了 #155 |
| **G. `v0.3.49` 是幽灵版本号** | 约 50 处注释 | 该版本号**从未打 tag、从未发布**，却作为「已发布版本」被代码注释引用 |

## 设计 / 方案

### 决策 1：缺失文档「据实补写」，不虚构

三篇缺失文档分为两类，处理方式不同：

| 文档 | 内容可还原性 | 做法 |
|---|---|---|
| `issue-118-expand-platform-support.md` | ✅ 提交 `4fb6c7b` 的 diff 完整保留 | 依据真实 diff 补写（矩阵条目、`target` 参数、Rust target 安装、README 平台表） |
| `issue-119-expand-release-matrix.md` | ✅ 提交 `b8a8bd3` + 回滚提交 `18049ec` | 依据真实 diff 补写，**并如实记录 zip 部分的回滚** |
| `perf-audit-optimization.md` | ⚠️ 审计报告**未落库**，但其 `P0-1`…`P2-2` 编号在 GitHub issue 标题中有完整定义 | 写成**批次索引**：逐条把编号映射到 issue 与落地文档，**不重新陈述未落库的审计发现** |

**不虚构是硬约束**：`perf-audit-optimization.md` 明确声明「本文档性质：批次索引，不是审计报告原文」，避免制造假文档。

### 决策 2：`zip` 的历史必须如实标注，不能以「当时的设计」为准

补写 #119 时发现一个事实错误：提交信息称 #119 引入了「独立便携 zip」，但**同一天 30 分钟后**的提交 `18049ec` 把它移除了，并给出确定结论：

> Tauri 2 只支持以下 bundle 类型：macOS `app,dmg`；Windows `nsis,msi`；Linux `deb,rpm,appimage`。`zip` 不是有效的 bundle 类型。

因此：
- #119 文档把 zip 标为 **❌ 当日回滚**，并给出正确的替代做法（在 `tauri-action` 之后另加 `upload-artifact` 打包，而不是把 `zip` 塞进 `--bundles`）；
- `CHANGELOG` 的 v0.3.48 条目原文「新增 zip/msi/rpm 格式」是**失实的**，已就地加勘误注记（保留原始措辞 + 标注订正，而非静默改写历史）。

### 决策 3：行号锚点一律删除，不「更新为当前行号」

`#Lxxx` 的问题不是「写错了」而是**结构上必然失效**——任何代码改动都会让行号漂移。把它更新为当前值只能撑到下一次改动。故统一删除锚点，保留文件路径；链接文本已含符号名（如 `[db.rs](../app/src-tauri/src/db.rs)`），足以定位。

### 决策 4：`v0.3.49` 的幽灵版本号——只订正文档，不动代码注释

`git tag` 序列为 `v0.3.48` → `v0.3.50`，**`v0.3.49` 不存在**；`git tag --contains` 逐条验证 #143–#150 的全部提交都落在 `v0.3.50` 内。但约 50 处代码注释把它当已发布版本引用。

- ✅ 在 `CHANGELOG` 的 v0.3.50 条目顶部加**版本号说明**，点明「注释里的 v0.3.49 = 本版本」；
- ✅ `perf-audit-optimization.md` 同步标注；
- ❌ **不改代码注释**：50+ 处改动会污染 `git blame` 且零功能收益。订正信息集中在一处（CHANGELOG）即可被检索到。

### 决策 5：加 `check-doc-links.py` + CI，防同类再犯

本仓库已有先例：`scripts/check-mcp-columns.py`（#169）就是因为「改列名漏改另一侧、CI 兜不住」而建立的。文档链接属完全同构的问题——**没有检查会碰到它**，因此积累了 24 处。新增检查覆盖三类缺陷：

| 检查项 | 判定 |
|---|---|
| 断链 | 相对链接的 `path` 部分解析后不存在 |
| `file://` | 链接目标含 `file://` → 直接报错（违反 §5.5） |
| 行号锚点 | 链接目标含 `#L\d+` 或 `#L\d+-L\d+` → 直接报错 |

外部链接（`http(s)://`）不做可达性校验——离线 CI 无法可靠判断，且会造成 flaky。

## 接口 / 行为变更

- **CI**：新增 `.github/workflows/docs-check.yml`（PR 与 push 到 `main`/`develop` 时运行 `python3 scripts/check-doc-links.py`）。
- **脚本**：新增 `scripts/check-doc-links.py`。
- **文档**：`AGENTS.md §4.2` 由「两个零依赖检查」改为「三个」，并登记新脚本的触发时机。
- **`CHANGELOG`**：v0.3.50 条目重写（补录 13 个 issue + 版本号说明）；v0.3.48 的 #119 条目加勘误。
- **代码**：**零改动**（本次不碰任何 `.rs` / `.ts` / `.tsx`）。

MCP 工具、SQLite schema、Tauri command 均无变更。

## 数据 / Schema 变更

无。

## 测试 / 验收

### 验收标准

- [x] 全仓库 markdown 扫描 0 断链、0 `file://`、0 行号锚点
- [x] 3 篇新文档具备 `AGENTS.md §5.2` 的全部必填章节
- [x] `check-doc-links.py` 在本仓库返回 0，且**故意造断链时返回非 0**
- [x] 既有测试全绿
- [x] 新文档在 `README.md` 建立反向链接

### 已跑验证

| 检查 | 结果 |
|---|---|
| `python3 scripts/check-doc-links.py` | ✅ 115 个文件，0 断链 / 0 `file://` / 0 行号锚点 |
| 脚本有效性（故意注入 3 类缺陷） | ✅ 三类全部被捕获，`EXIT=1`；还原后 `EXIT=0`（非恒真断言） |
| `cargo check --lib` | ✅ 零 warning |
| `cargo test --lib` | ✅ 80 passed / 0 failed / 2 ignored |
| `cargo test --test db_test` | ✅ 21 passed |
| `npx tsc --noEmit` | ✅ 0 error |
| `npm test` | ✅ 10 files / 84 tests |
| `npm run i18n:check` | ✅ 中英各 302 key |
| `python3 scripts/check-mcp-columns.py` | ✅ 24 列一致 |

### 边界场景

- **外部链接**：`http(s)://` / `mailto:` / 页内 `#anchor` 均跳过，不误报。
- **构建产物**：`node_modules` / `target` / `.git` / `dist` 下的 markdown 不参与扫描。
- **`file://` 与断链重叠**：一个 `file://` 链接同时不解析为有效路径，脚本只归入 `file://` 类别报一次，避免重复噪声。
- **链接文本含空格**：正则按 `]\(([^)\s]+?)\)` 匹配，含空格的路径不会被误判（本仓库无此类链接）。

## 相关链接

- Issue：[#239](https://github.com/ShawnLiuSZ/task-dashboard/issues/239)
- 触发来源：[#237 卡片结构调整](./issue-237-card-creator-row.md)（其 PR 描述首次暴露 CHANGELOG 断链）
- 补写的文档：[docs/issue-118-expand-platform-support.md](./issue-118-expand-platform-support.md)、[docs/issue-119-expand-release-matrix.md](./issue-119-expand-release-matrix.md)、[docs/perf-audit-optimization.md](./perf-audit-optimization.md)
- 同类先例：[docs/issue-169-mcp-server-schema-sync.md](./issue-169-mcp-server-schema-sync.md)（`check-mcp-columns.py` 的由来）
- 检查脚本：`scripts/check-doc-links.py`、`.github/workflows/docs-check.yml`
- 分支：`fix/issue-239-doc-links`
- CHANGELOG：[docs/CHANGELOG.md](./CHANGELOG.md) v0.3.50 条目（本次重写）

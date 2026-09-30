# #330 P3 批次：规范、文档与 CI 门禁 7 项

> code review 的 **P3 批次**，来源 [`CODE-REVIEW-2026-09-30.md`](../CODE-REVIEW-2026-09-30.md)
> （基线 `main @ f66f83f` / v0.6.5）。
> 本批**不改变运行时行为**，处理的是**可维护性与门禁有效性**：几处「写了规则但无人校验」
> 的地方已经实际漂移（版本号落后两个大版本、15 篇文档无人引用），另有多条 CI 门禁
> 事实上不生效（阈值接近饱和、不跑构建、无格式检查、无超时与最小权限）。

## 背景 / 动机

前四批处理的是「代码对不对」。本批处理「**守门人本身可不可靠**」。7 项按性质归类：

| # | 问题 | 性质 |
|---|---|---|
| 1 | 版本号「多处同步」零自动化校验，且**已实际漂移**（`package-lock.json` = 0.4.0 vs 0.6.5） | 规范漂移 |
| 2 | README 版本号过期（中英尾注分别停在 v0.6.4 / v0.6.0） | 规范漂移 |
| 3 | **15 篇孤岛文档**：既不在 README 也不在 CHANGELOG，无人引用 | 文档可达性 |
| 4 | ESLint `--max-warnings 20` 只剩 2 条余量，与真实缺陷无关地挡 CI | 门禁失效 |
| 5 | CI 不跑 `vite build`、不跑 `cargo fmt --check`；action 版本 v4/v5 混杂 | 门禁缺失 |
| 6 | release 6 个平台 job 无 `timeout-minutes`（挂死按 6 小时计费）、无 `concurrency`（重复触发互相覆盖产物）；4 个只读 workflow 未声明 `permissions` | CI 硬化 |
| 7 | `check-i18n.mjs` 硬编码两个语种，新增语言漏检却照样「通过」 | 虚假安全感 |

## 设计 / 方案

### 1. 版本号一致性校验（新增 `scripts/check-versions.py`）

版本号分散在 **5 个文件**里，发版靠手抄，而**全仓库没有任何一步校验过**：

| 文件 | 字段 |
|---|---|
| `app/package.json` | `version`（权威源） |
| `app/package-lock.json` | `version` **与** `packages[""].version`（两处） |
| `app/src-tauri/Cargo.toml` | `[package] version` |
| `app/src-tauri/tauri.conf.json` | `version` |
| `app/src-tauri/Cargo.lock` | `[[package]] name="taskboard"` 的 `version` |

实测前 4 处是 `0.6.5`，而 **`package-lock.json` 停在 `0.4.0`**（落后两个大版本）——
`AGENTS.md §4.3 / §6.4` 与 `release.yml` 注释都只写「对齐**三处** version」，清单本身就不完整。

`check-versions.py` 做三件事（零第三方依赖）：

1. 5 个文件的版本号必须完全一致（`package-lock.json` 的两处都要对）；
2. `README.md` / `README.en.md` 里代表「当前版本」的字符串必须一致 —— 模式刻意只匹配
   `最新 vX.Y.Z` / `latest vX.Y.Z` 与尾注 `版本 vX.Y.Z` / `Version vX.Y.Z`，
   **不**匹配历史叙述（`v0.3.24 及以下`、`v0.3.10 新增`、`v0.3.50 CHANGELOG`），
   否则「版本历史」会要求跟着当前版本漂移；
3. 若 `GITHUB_REF_NAME` / `TAG_NAME` 提供了 tag（形如 `v0.6.5`），一并比对 ——
   拦住「打了 `v0.7.0` 的 tag 但文件还写 `0.6.5`」这类只在 Release 落地后才暴露的错配。

`Cargo.toml` / `Cargo.lock` 用逐行解析而**不引 `tomllib`**：该模块 3.11 才进标准库，
而本仓库 `scripts/` 的既有约定是「零依赖 + 兼容更老解释器」；这里的 TOML 形状极简单
（一层 section + 字符串值），手写解析的复杂度远低于为它抬升解释器下限。

同步修正 `package-lock.json` 0.4.0 → 0.6.5，并把 `AGENTS.md §4.3 / §6.4`、`release.yml`
注释统一为「**四处 + lockfile**，跑 `check-versions.py` 确认」。

### 2. README 版本号（同上，由校验脚本兜住）

`README.md`：`最新 v0.6.0` → `v0.6.5`，尾注 `v0.6.4 · 2026-09-23` → `v0.6.5 · 2026-09-29`。
`README.en.md`：`latest v0.6.0` → `v0.6.5`，尾注 `v0.6.0 · 2026-09-17` → `v0.6.5 · 2026-09-29`。

### 3. 孤岛文档：补 README 反链 + 检测防回归

`AGENTS.md §5.5` 早就要求「新增文档后必须在 README / CHANGELOG 建立反向链接（避免孤岛文档）」，
但 `check-doc-links.py` **只查正向链接有效性，不查「是否被引用」**。实测 `docs/` 下：

- **14 篇**没有任何文档引用；
- **1 篇**（`v0.3.16-multi-account.md`）只被另一篇文档引用。

合计 **15 篇**，它们只能靠「知道文件名」才找得到，等于写完就沉底。

两项修改：

- **补反链**：`README.md` 的「文档」清单新增 `### 历史知识库文档` 小节，把这 15 篇逐条登记
  （带摘要，说明「为什么存在」而不只是链接）；
- **防回归**：`check-doc-links.py` 新增**孤岛检测** —— `docs/`（直属，不下钻子目录）下的
  每篇 `.md` 必须至少被 `README.md` / `README.en.md` / `docs/CHANGELOG.md` /
  `docs/CHANGELOG.en.md` 之一引用。

判定逻辑抽成纯函数 `find_orphans(docs_rels, inbound, index_files)`，
配套 `scripts/test_check_doc_links.py`（14 例）。

### 4. ESLint 阈值：按规则粒度显式配置（`eslint.config.js` + `package.json`）

现有 16 条告警**全部**是 `react-refresh/only-export-components` ——「HMR 只支持
只导出组件的文件」这条**开发体验**规则。本仓库有 16 处**刻意**违反：那些纯函数与组件
同文件导出，方便前端单测直接 `import`（`Board.extractUnmappedStatuses` /
`SyncLogsPanel.apiLogKindLabel` / `i18n.resolveLang` 等）。

原配置把它们放行成 warning，而 `--max-warnings 20` 只留 2 条余量 ⇒ 门禁实际含义变成
「**不许再写第 3 条 warning**」，一个无关的 `any` 就能让 CI 变红，与真实缺陷无关。

改为**逐名登记**：

```js
'react-refresh/only-export-components': ['warn', {
  allowConstantExport: true,
  allowExportNames: [ /* 16 个已知导出，按文件分组并注明用途 */ ],
}],
```

同时 `--max-warnings 20` → **`--max-warnings 0`**：存量归零后，门禁变成「任何新告警都挡住」，
这才是它应有的强度。

为避免名单变成**死配置**（名字改名/删除后残留），新增 `src/lint-config.test.ts` 断言
**双向相等**：4 个 `.tsx` 里真实的「非组件导出」集合 === 名单集合。

### 5. CI 门禁：`vite build` + `cargo fmt --check` + action 版本统一

- **`npm run build`**：CI 此前只跑 `npm test` + `tsc`，**不跑真实构建** ⇒ vite 配置 /
  `build.target` / `frontendDist` 这类只在构建期暴露的问题要等到 release 打包才现形
  （那时已经打了 tag）。已加入 `frontend-tests` job。
- **`cargo fmt --check`**：仓库此前**完全没有** rustfmt 门禁。本批先做**全仓库归一化**
  （`cargo fmt`，**263 个 hunk / 11 个文件**，独立成一个 commit 便于审阅与单独 revert），
  再把 `cargo fmt --check` 挂进 `rust-clippy` job（`components: clippy, rustfmt`）。
- **action 版本统一**：`quality-check.yml` 是最后一个还用 `checkout@v4` / `setup-node@v4`
  的 workflow（其余已是 v5）；全部升到 v5。

### 6. workflow 硬化：`timeout-minutes` / `concurrency` / 最小权限

- `release.yml::build`：加 `timeout-minutes: 60`（此前 6 个平台 job 无超时，卡死按 GitHub
  默认 **6 小时**计费；正常打包 10~20 分钟）；顶层加
  `concurrency: { group: release-${{ github.ref }}, cancel-in-progress: false }`
  （同一 tag 重复 Publish / 手动 Run 会并发往同一个 Release 上传附件、互相覆盖；
  `cancel-in-progress: false` 是因为打包很贵，半途取消会留下不完整附件）。
- 4 个只读 workflow（`docs-check` / `i18n-check` / `mcp-schema-check` / `quality-check`）
  补 `permissions: { contents: read }` —— 此前完全未声明，沿用仓库默认权限（可能含 write），
  违反最小权限。`release.yml`（`contents: write`）与 `merge-cleanup.yml`
  （`contents: write` + `issues: write`）本来就已声明，未动。

### 7. `check-i18n.mjs`：动态发现语种

原实现 `const files = { "zh-CN": ..., "en-US": ... }` **写死两份**，而 `README.md` 明确
宣传「复制 `en-US.json` 为新语言文件（如 `ja-JP.json`）」⇒ 新增语种**不会被校验**，
脚本却照样输出「✓ 通过」，给出虚假安全感。

修法：

- 新增 `app/scripts/i18n-lib.mjs` 存放**纯逻辑**（`localeIds` / `placeholders` /
  `compareLocales`），`check-i18n.mjs` 只负责读盘与退出码 —— 这样逻辑能被 vitest 单测覆盖，
  而不是只能「跑一次 CLI 看输出」；
- `readdirSync(localesDir)` 动态发现 `*.json`，以 `zh-CN` 为基准**逐一比对**其余全部语种；
- 为让 TS 能解析该 `.mjs` 导入，`tsconfig.json` 开 `allowJs`（`checkJs` 保持关闭，
  不改变既有严格度）。

配套 `src/i18n-check.test.ts`（13 例），其中「**第三语种**缺失 key 会被报出」直接锁住
原实现的漏检路径。

## 接口 / 行为变更

| 项 | 变更 | 影响面 |
|---|---|---|
| 1 | 新增 `scripts/check-versions.py` 并接入 `quality-check.yml` | 版本号漂移在 PR 阶段即被拦住 |
| 1 | `package-lock.json` 0.4.0 → 0.6.5 | npm 锁文件与包版本对齐（仅 version 字段，不影响依赖解析） |
| 1 | `AGENTS.md §4.3/§6.4`、`release.yml` 注释改「四处 + lockfile」 | 发版清单口径统一 |
| 2 | README 中英版本号与日期更新 | 用户可见 |
| 3 | 15 篇文档获得 README 反链；`check-doc-links.py` 新增孤岛检测（失败即退出 1） | 新增 KB 文档若不入 README / CHANGELOG 会在 PR 阶段变红 |
| 4 | `react-refresh/only-export-components` 改为逐名登记；`--max-warnings 20` → `0` | 新增非组件导出必须登记或挪出 `.tsx` |
| 5 | CI 新增 `npm run build` 与 `cargo fmt --check` | PR 阶段即暴露构建期问题与格式问题 |
| 5 | `quality-check.yml` 的 action 升到 v5 | 无行为变化 |
| 6 | `release.yml` 加 `timeout-minutes: 60` + `concurrency` | 重复触发不再互相覆盖产物 |
| 6 | 4 个只读 workflow 加 `permissions: contents: read` | 权限收窄 |
| 7 | `check-i18n.mjs` 支持任意语种数量；逻辑抽到 `i18n-lib.mjs` | 新增语种自动纳入校验 |
| 7 | `tsconfig.json` 开 `allowJs` | 仅影响 TS 的模块解析，`checkJs` 仍关闭 |

- **无运行时行为变更**（前端 / Rust / MCP 一行逻辑都没动）。
- **无 SQLite 列 / 表结构变更**；**无 MCP 工具变更**；**无 i18n key 变更**（仍 389 keys）。
- 唯一的「代码」层面改动是 `cargo fmt` 的**纯格式化**（263 hunk / 11 文件，独立 commit）。

## 数据 / Schema 变更

**无。**

## 测试 / 验收

新增测试 3 个文件 / 32 例：

| 文件 | 例数 | 覆盖 |
|---|---|---|
| `scripts/test_check_versions.py` | 14 | 5 个文件的解析（含 `Cargo.toml` 只取 `[package]`、`Cargo.lock` 取 `taskboard` 块）、`package-lock` 两处版本、README 版本模式（排除历史叙述）、tag 比对、真实仓库断言 |
| `scripts/test_check_doc_links.py` | 14 | `is_kb_doc`、`find_orphans`（含「只被另一篇文档引用」这一真实形态）、`mask_code` 行数不变式、真实仓库「零孤岛」断言 |
| `app/src/lint-config.test.ts` | 5 | allowExportNames 与实际导出**双向相等**（漏登记 / 死配置）、`--max-warnings 0` |
| `app/src/i18n-check.test.ts` | 13 | `localeIds` 动态发现、`placeholders`、`compareLocales`（第三语种缺 key / 多 key / 占位符 / 空翻译 / 缺基准）、真实 locale 断言 |

逐项通过**反向验证**（把修复改回缺陷写法，测试/检查必然失败）：

| 反向操作 | 结果 |
|---|---|
| `package-lock.json` 顶层 `version` 改回 `0.4.0` | ✅ 报「`app/package-lock.json（顶层 version）= 0.4.0，应为 0.6.5`」 |
| `README.md` 尾注改回 `v0.6.4` | ✅ 报「`README.md（尾注版本）= v0.6.4，应为 v0.6.5`」 |
| `GITHUB_REF_NAME=v9.9.9` | ✅ `test_tag_mismatch_is_reported` 失败 |
| 从 README 移走 `issue-216` 的反链 | ✅ 报「孤岛文档 1 篇 … `docs/issue-216-del-last-account.md`（没有任何文档引用）」 |
| `find_orphans` 只认 README（不认 CHANGELOG） | ✅ `test_doc_referenced_by_changelog_is_not_orphan` 失败 |
| `allowExportNames` 多写一个不存在的名字 | ✅ `lint-config.test.ts` 2 例失败（含「名单为 16 条」） |
| `allowExportNames` 删掉任一条 | ✅ 「漏登记」例失败（同时 lint 报 warning → CI 红） |
| `compareLocales` 改回只比 `zh-CN` / `en-US` | ✅ 「第三语种缺失 key 会被报出」失败（13 例中 1 失败） |
| `docs-check.yml` 的 `permissions:` 留空 | ✅ 报「`permissions:` 下没有任何 scope 声明」 |
| `actions/checkout@v5` 改回 `@main` | ✅ 报「用了浮动分支 `@main`（上游一次 push 就会替换你 CI 里执行的代码）」 |
| 撤销 `cargo fmt` | ✅ `cargo fmt --check` 报 263 处 diff（归一化前实测值） |

全量校验：

```
npx tsc --noEmit                                 0 error ✅
npm run build                                    ✅（vite 6 真实构建）
npm test                                         212 passed（+18）✅
npm run i18n:check                               389 keys ✅
npm run lint                                     0 warnings / 0 errors（--max-warnings 0）✅
npx prettier --check "src/**/*.{ts,tsx,css}"     ✅
cargo fmt --check                                ✅（本批归一化后首次通过）
cargo clippy --lib -p taskboard -- -D warnings   ✅
cargo test --lib -p taskboard                    141 passed ✅
cargo test --test db_test                        24 passed ✅
python3 scripts/check-versions.py                0.6.5 ✅
python3 scripts/check-doc-links.py               163 文件 / 无孤岛 ✅
python3 scripts/check-mcp-columns.py             28 列 + ensure 覆盖 33 列 ✅
python3 scripts/check-workflow-yaml.py           6 文件 ✅
python3 -m unittest discover -s scripts -p 'test_*.py'   114 tests OK ✅
```

## 未处理（记录备查）

- 本次**未**做**全仓库** `cargo fmt` 之外的格式化统一；`docs/*.md` 不满足 prettier
  （`docs/CHANGELOG.md`、`docs/issue-32x-*.md` 等在 `main` 上本就不满足），而仓库的
  prettier 门禁范围刻意只含 `src/**/*.{ts,tsx,css}`，故不动。
- `docs/issue-62-bug-audit-fixes.md` / `docs/issue-52-custom-column-mapping.md` 中指向
  `ShawnLiuSZ/task-dashborad` 的外部链接是**仓库改名前的旧名**（GitHub 对改名仓库保留
  重定向，链接仍可解析）。属外部链接，不在本批 7 项范围内，未改。

## 相关链接

- 来源审计：[`CODE-REVIEW-2026-09-30.md`](../CODE-REVIEW-2026-09-30.md)
- 上游批次：[#327](./issue-327-p0-functional-defects.md)（PR #331）、
  [#328](./issue-328-p1-data-safety.md)（PR #332）、
  [#329](./issue-329-p2-quality.md)（PR #333）
- GitHub issue：[#330](https://github.com/ShawnLiuSZ/task-dashboard/issues/330)
- 关联历史教训：
  [#239 文档完整性](./issue-239-doc-integrity.md)、
  [#252 修好既有 CI](./issue-252-ci-green.md)、
  [#281 协议与 lockfile 取舍](./issue-281-license.md)、
  [#284 PR 合并自动收尾](./issue-284-merge-cleanup.md)
- CHANGELOG：[`docs/CHANGELOG.md`](./CHANGELOG.md) / [`docs/CHANGELOG.en.md`](./CHANGELOG.en.md)

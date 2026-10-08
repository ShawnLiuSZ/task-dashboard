# 版本更新记录（Changelog）

> **中文**
>
> English version see [CHANGELOG.en.md](./CHANGELOG.en.md)

> TaskBoard 各版本的更新说明与修复记录。当前版本与项目概览见 [README](../README.md)。

- **断言强度审计续篇：#215 写回路径的 mutation 形状断言过弱（#411）**

  - 审 `project_status_mutation` —— **TaskBoard 唯一向 GitHub 写入**的地方。现有断言是 `contains("updateProjectV2ItemFieldValue")`，改成 `...FieldValues`（拼写错误）**断言仍通过**。
  - 实测 8 个变异**5 个存活**：`mutation`→`query`、响应选集丢弃、`input:` 包装丢弃、mutation 名字拼错。**严重性如实界定为低于 #409** —— 这 5 处在运行期**都是响亮失败**（GitHub 直接拒绝；且 `set_project_item_status` 明确校验 `projectV2Item.id`，为空即报「GitHub 未返回确认」），**不存在静默数据损坏**。
  - **仍需锁定的两条理由**：①**响应选集是查询与调用方之间的契约** —— 漏掉则每次写回都报「GitHub 未返回确认」，**#215 整体不可用**，而该症状极具误导性（代码里的错误提示会把排查者引向 PAT 权限，不会想到是查询少选一个字段）；②本函数存在的**全部意义**就是「纯函数、可单测」。
  - 修复为 1 例六层，含**反向契约「不得出现名字+多余字符的变体」**。**反向验证 7/7**；lib 175 → 176，clippy 0 error。
  - 💡 **方法论新增纪律 3b：名称类断言必须配反向契约** —— `contains("someName")` 只要求包含，故拼写错误（`...Value`→`...Values`）、版本后缀（`v1`→`v1Beta`）、前缀重复（`item`→`itemItem`）**全部逃逸**。与 #407 同族：**断言了「包含某物」，没断言「恰好是某物」**。
  - ⚠️ **过程中一次事故**：为验证「还原是否干净」我跑了 `git checkout <file>`，**把自己的 68 行测试删掉了**（靠事先留的备份恢复）。**`git status`/`git diff --stat` 安全，`git checkout <file>` 破坏性** —— 它不区分「变异残留」与「我自己的改动」。
  - 详见 [`issue-411-write-path-mutation-shape.md`](./issue-411-write-path-mutation-shape.md)

- **断言强度审计续篇：Project 条目查询的字段选集几乎全无守护（#409）**

  - 审 `project_items_query`（#356 抽成纯函数）。**关键背景是这个函数已被同类缺陷咬过一次** —— 注释写着「⚠️ issue 分支的 `updatedAt` **不可删**…**该缺陷已真实发生过一次**」，但 #356 当时**只补了 `updatedAt` 一条断言**，其余字段选集全部无人守护。
  - 实测 **9 个变异全部存活**：漏 `pageInfo`/`hasNextPage`/`endCursor` ⇒ **分页在第 50 条停住、之后的 issue 永不出现**；`items/fieldValues/assignees/labels(first:N)` 改成 `first:0` ⇒ 各自功能静默失效；`comments{totalCount:0}`、`author{login:""}` ⇒ 评论数恒 0、作者列空白。**全部不报语法错** —— `first:0` 与 `totalCount: 0` 都是**合法 GraphQL**，请求成功、字段为空、客户端回落默认值，**无任何错误信号**。
  - **修复**：1 例四层断言 —— 分页驱动 / 7 条 `(字段, 支撑什么功能)` 表驱动 / **反向契约「任何 `first:0` 都不得出现」**（语法层面唯一能拦它的手段）/ 分支结构（`updatedAt` 不得进 PullRequest 分支，**多选字段的代价是查询直接报错**而非静默降级）。**反向验证 9/9**。
  - ⚠️ **纪律 2 补上「位置也要断言」**：`s.replace(old, new, 1)` 命中的是**第一处**同名片段 —— `pageInfo {{...}}` 在 1083 行与 1154 行各出现一次、**前者属于另一个函数** ⇒ 目标函数毫发无损 ⇒ 5 个变异「存活」。改为 `s.index(old, FUNC)` 后 9/9 全捕获。这比纪律 1「注入须确认生效」**更隐蔽**：注入确实生效了，只是生效在错误位置。**本系列已三次犯「变异落到错误位置」**。
  - 详见 [`issue-409-project-items-fields.md`](./issue-409-project-items-fields.md)

- **断言强度审计续篇：GraphQL 链接查询的顶层字段选集无人断言（#407）**

  - 选 `build_links_query` / `repo_level_failure` 是因为 #278 抽它们时注释就写明「GraphQL 语法错只在真实请求时才暴露，**代价高**」。14 个变异：**10 捕获**（含 #342 缺陷本体与它注释里警告的「错用顶层 data 判据」）、**1 等价变异**（`is_null() || !is_object()` ≡ `!is_object()`，因 `Null.is_object()` 恒 `false`）、**2 真实存活**。
  - **根因：只断言了参数、没断言字段选集** —— 原有断言只有 `q.contains("a0: issue(number: 278)")`，那是 issue 的**参数**，从未断言节点**选了什么字段**。`parent` 与 `subIssues` **内部**的 `number title url` 都有断言，唯独**顶层**漏了 —— 而顶层恰是 `parse_links_from_graphql` **建键的依据**。
  - **后果是静默降级而非语法错**：去掉 `number` ⇒ 父子关系**整体丢失且无任何报错**；去掉 `title`/`url` ⇒ 子 issue 卡片与父链接渲染成**空白文案**。与 #376 的「字段组断言」同族：**断言了容器，没断言被取用的字段**。
  - 修复用**前缀断言**（`starts_with("number title url parent")`）而非解析嵌套花括号 —— 第一版 `split_once("}")` 把 `parent { ... }` 的嵌套内容一起吃进来了。本仓无 GraphQL 解析器且 §2.5 不引入新依赖，故只校验前缀顺序。**反向验证 6/6**；lib 174 全绿，clippy 0 error，fmt 干净。
  - 详见 [`issue-407-link-fragment-fields.md`](./issue-407-link-fragment-fields.md)

- **断言强度审计续篇：`Board.tsx` 列顺序零覆盖，回落分支 `orderMap` 是死代码（#405）**

  - 选它是因为 `projectKeys` 决定**看板列顺序**、且其回落路径正是 #372 的「看板列静默错序」点。实测 5 个变异**全部存活**，两个原因都需记录：①测试只传 **1 个** status 且 `tasks={[]}`，没有「两列以上 + 需重排」的输入；②**更根本** —— 全仓唯一调用点 `Board.tsx:145` **不传第二个参数** `projectStatuses`，而 `orderMap` 分支**只在传了该参数时可达**，主路径压根不经过这个函数 ⇒ **对 `orderIndex` 的 4 个变异天然无效**。
  - ⚠️ **「签名承诺了、调用点用不上」**：`sortProjectStatusKeys` 承诺可按 `orderIndex` 排序，但该能力**实际不可用**。可能有意备用、也可能重构残留 —— **属产品判断，本次不改代码**，KB 给出两个选项（保留则注释写明备用路径 / 清理则删死分支，回落行为不变）。
  - **与盲区 E 类（#400）的区别**：E 类不可达因**测试数据**构造不出，本项是**被测代码本身**有一段不执行。判别方法相同（删掉看是否全绿）但结论不同 —— 本项需「记录 + 产品判断」而非补断言。
  - 💡 **补测试 → 再 mutation → 发现新缺口，两次迭代才收敛**：补完 3 例后重验发现**两个我自己也没覆盖的存活变异**（主路径漏 `done` 列、回落不过滤空列）⇒ 又补 2 例。**断言写完不等于有效，仍要用 mutation 验收新测试本身**。另踩一坑：合成列列头走 **i18n**（`已完成` / `未标注`）而非内部 key，第一版按 `/done/i` 匹配失败，被断言消息里的实际列序点出来才发现。
  - 详见 [`issue-405-board-column-order-coverage.md`](./issue-405-board-column-order-coverage.md)

- **断言强度审计续篇：悬空项收尾 —— legacy 判据可证明永不决定（#404，无代码变更）**

  - #402 标注了「未能构造的窄场景」，本 issue 收尾。**探针迭代 4 次**：①手工造表 → `open_db` 失败；②从真实库改名 `issue_key` → **探针无效**（不是真正 legacy 布局）；③补 6 列但漏建 1 个索引名；④补齐 6 列 + **8 个索引名全建**（已是能构造的最窄状态）⇒ **两侧仍相同**。此时正确结论不是「守卫无用」，而是**转向可构造性分析**。
  - **决定性结构事实**：`open_db` 里 `schema_is_current` 在 **427 行**求值、`execute_batch(SCHEMA)` 在 **438 行** —— **探测发生在建表之前**；而 `SCHEMA` 的 `tasks` 是现代布局、**没有 `key` 列**。故要让它成为决定性因素需「全现代结构 + 遗留 `key`」，而 `tasks` 拿到现代结构只有 `SCHEMA` 与 `migrate_tasks_v2_rebuild` 两条途径，**两者都不创建 `key`** ⇒ **对任何迁移流程可达的状态，它都不是决定性因素**。
  - **结论：不建议删掉它** —— 廉价纵深防御、符合代码注释声明的「兜底」定位、删除无收益。**无代码变更。**
  - 💡 **方法论真正的产出：等价变异有强弱之分**。**弱等价**（「试了几个状态都没差异」）**不足以下结论**；**强等价**（代码路径分析 + **可达性论证**）才可下结论。并沉淀**存活变异完整排查路径**：①变异方向对吗 ②能构造出差异状态吗 ③有第二个等价守卫吗 ④该状态可达吗 —— 四步全过才判定等价。**连续 N 次换构造仍无差异时，别再换构造 —— 该问「这个状态可达吗？」**
  - 详见 [`issue-404-schema-is-current-legacy-undecidable.md`](./issue-404-schema-is-current-legacy-undecidable.md)

- **断言强度审计续篇：悬空项落实 —— `schema_is_current` 的 legacy 判据是冗余守卫（#402，无代码变更）**

  - #400 审计时把变异 ⑤ 标注为「推测未实测」。**推测必须落实** —— 留着不验证就是给审计留一个未验证的断言。
  - **我原先的推测是错的**：`REQUIRED_COLUMNS` 实际**不含** `issue_key`。但用 `legacy_tasks_db` 的真实 DDL 造库探针实测后，结论是**变异为等价变异** —— `missing_columns` 对真实 pre-#155 表必然非空 ⇒ **同样**强制 `needs_migration = true`；且 `run_migrations` 里**独立地**再检查一次 `tasks_uses_legacy_key`。**同一条件被检查两次，删掉一次不改变行为** —— 冗余本身是好事（纵深防御），mutation 存活正是它的表现。
  - ⚠️ **探针本身也要先验证**：第二次探针从真实库把 `issue_key` 改名成 `key`，两侧仍相同，**差点据此判「守卫无用」** —— 但那不是真正的 legacy 布局（缺 `gh_state` / `updated_at TEXT`）⇒ 重建读不到列 ⇒ 两种情况都停在坏状态 ⇒ **看起来等价，实为探针无效**。**「两种情况结果相同」有两种可能：真的等价，或探针没测到差异。**
  - **如实记录未能构造的窄场景**：「`key` 仍在但 6 个 `REQUIRED_COLUMNS` 已补齐且索引齐全」—— 需在 legacy 表上建引用 `issue_key` 的索引（会报 `no such column`），我未构造成功，故**既不能断言必要、也不能断言多余**。
  - **无代码变更**，方法论文档的等价变异清单已补该条。
  - 详见 [`issue-402-schema-is-current-legacy-check-redundant.md`](./issue-402-schema-is-current-legacy-check-redundant.md)

- **断言强度审计续篇：`agent-groups` 测试辅助函数耦合字段（新盲区类型 E）（#400）**

  - 审计 14 个变异，**13 个捕获良好**（`groupOf` 全部 6 分支、`newlyRemoved` 优先级、`summarize` 三项、`GROUP_ORDER` 顺序、`deviceDetail` 拼接顺序）。**唯一存活的暴露了一个测试设计缺陷**。
  - 辅助函数 `host(agent, kind)` 写成 `present: kind !== 'none'`，于是 `present === false` **必然蕴含** `kind === 'none'` ⇒ 删掉 `deviceStateOf` 的 `!info.present` 守卫后行为完全一致 ⇒ **mutation 存活**。但 `types.ts` 里二者是**独立字段、类型系统不强制一致**，该组合是**类型允许的输入**，而守卫正是为处理它而存在（否则界面会把**并未安装**的 agent 显示成「已安装」）。**契约在代码里不在类型里，而测试辅助函数替生产代码补上了这个不变量。**
  - **修复**：补 1 例**显式构造该组合**（绕开辅助函数手工构造对象），并加前置不变式防止辅助函数日后被「修正」时无声破坏构造前提。
  - **新增盲区类型 E 类**（原有 A 枚举不全 / B 匹配形式单一 / C 解析子集太窄 / D 只守正向都不覆盖）：**测试辅助函数补上了生产代码没有的不变量，使某个分支在测试数据里不可构造**。与 #399 同属「代码路径没走到」但根因不同 —— #399 是**环境**缺打桩，本项是**测试数据的构造方式**。**教训：辅助函数越「方便」，它替生产代码做的假设就越多。**
  - ⚠️ **测量错误的新变体**：`npx tsc --noEmit 2>&1 | tail -1 && echo "tsc 干净"` 中 **`tail` 的退出码覆盖了 `tsc` 的**，我在实际报 TS2739 时输出了「tsc 干净」；改为看退出码后暴露并修掉两处类型错误。**「判结果只用退出码」不仅适用于测试，「检查是否通过」本身也必须看退出码。**
  - 方法论文档已同步扩为**五类盲区**。
  - 详见 [`issue-400-agent-groups-helper-coupling.md`](./issue-400-agent-groups-helper-coupling.md)

- **断言强度审计续篇：`theme.ts` 模块加载期逻辑结构上不可测（#399）**

  - 按方法论文档流程续审，选 `theme.ts` 的理由是**缺陷史** —— #343 在这里找到过真实 bug。审计 8 个目标，**#343 / #329 本体均被捕获**（回归良好），但发现一处结构性缺口。
  - **问题**：`theme.test.ts` 顶层 `import './theme'` 让**模块体在 `beforeEach` 的 `stubEnv()` 之前执行一次** ⇒ `window` / `localStorage` 不存在 ⇒ 模块尾部的 `applyTheme(storedTheme)`（防 FOUC）与 `if (storedTheme === 'auto') bindSystemThemeListener()`（首屏跟随系统）被 `try/catch` **静默吞掉**。
  - **后果实测：把后一行整段删掉，`theme.test.ts` 全绿** —— 即「首屏 auto 模式下系统主题变化不再跟随应用」这个用户可见缺陷**当前无任何测试能发现**，而它正落在 #329 / #343 这条反复出问题的时间线上。
  - **「有测试」不等于「测到了」**：该文件有 7 例 29 行断言、覆盖 `setMode` / `bind` / `unbind` / `resolveTheme` 都很好，但那段代码**在测试环境里从未执行过**。测试量与覆盖范围是两回事。
  - **修复**：`vi.resetModules()` + **动态 `import()`**，让打桩**先于**模块体建立（vitest 内置，§2.5 不引入新依赖）。补 4 例：`stored=auto` 须恰好注册 **1** 个监听（不多不少）/ `stored=light/dark` **不绑定**（#329 核心不变量）/ 缺失与抛错**回落 auto**（回落值本身即契约）/ 模块加载期写 `data-theme`（防 FOUC）。配套加 `stubEnvWithStored(stored)`。
  - **反向验证 5/5**：2 个存活变异全部捕获；**反向对照**「恒绑定」（显式模式也绑 ⇒ #329 被改坏）亦被捕获 —— 双向都验才知道断言方向没反；#343 本体回归仍被捕获。
  - **方法论定位**：纪律 4「信号覆盖被测对象」的**新形态** —— #384 是「过滤条件不含用例名」，本项是「**模块根本没在测试环境里跑**」。共同点：**信号（测试通过）覆盖了对象，但没覆盖对象在该环境下的实际行为**；检测手段同为纪律 1 的「删掉整段看是否全绿」。
  - 详见 [`issue-399-theme-moduleload-untestable.md`](./issue-399-theme-moduleload-untestable.md)

- **断言强度审计方法论沉淀（11 项审计的总结）**

  - 新增 [`methodology-assertion-strength-audit.md`](./methodology-assertion-strength-audit.md)，并在 **AGENTS.md 新增 §5.6** 作为评估断言强度时的强制入口。
  - **核心结论：断言强度靠读代码判断极易出错** —— #376 的表驱动用例读起来完全合理，只有 mutation 才暴露它漏守 8 个字段。
  - 沉淀内容：**五条纪律**（注入确认生效 / 变异方向与位置 / 期望值外部来源 / 信号覆盖被测对象 / **判结果只用退出码**）、**四类盲区**归纳（枚举覆盖不全 / 匹配形式单一 / 解析语法子集太窄 / **只守正向不守反向**）、**等价变异判别清单**（8 条已确认的「存活但不该捕获」）、可复用流程与目标选择优先级。
  - **11 项里只有 3 项是真实的代码缺陷**（#376 / #384 / #388），另有 **3 项是守卫自身有盲区**（#390 / #392 / #394）、**5 项仅缺守护**（#378 / #380 / #382 / #386 / #396）⇒ **测试的主要作用不是抓 bug，是把隐含契约显式化**。
  - 同时记录**我自己犯过的十余次「测量手段本身出错」** —— 方法的失效方式比方法本身更值得沉淀；并显式声明该文档是草稿而非圣经，**若与实践不符以实践为准并修正文档**。

- **Unreleased — 断言强度审计（十一）：`db.rs` 首次审计 —— #340 指纹保护无测试（#396）**

  - `db.rs` 是本仓**唯一「最坏事故类别 + 零审计」的组合** —— #340 是**永久数据丢失**（`tasks` 被 DROP、`tasks_new` 保有全量数据却打不开库、版本号盖到最新、迁移此后再不重跑）。审计 8 个目标，**最关键的判据只被守住一半**。
  - **发现**：`open_db` 里逐字写着「⚠️ 必须确认 tasks_new **确实是 tasks 布局**才 RENAME，否则 SCHEMA 的 `CREATE INDEX ... ON tasks(ownership)` 会因缺列而整个 batch 失败 —— 那比『看板为空但能打开』更糟（**库直接打不开**）」，**但这条保护没有任何测试**。已有用例只覆盖**正向**（真实 tasks 布局 ⇒ 应恢复），**反向情形（`tasks_new` 存在但并非 tasks 布局）完全没测**。
  - **后果实测**：指纹在 ⇒ `tasks_new` **保留原状**（安全侧）；指纹去掉 ⇒ 被**当成 tasks 升为看板主表**。**与 #376 `taskSig` 完全同型：契约被逐字写在注释里，却只守住契约的一半。**
  - **修复**：补 1 例，三层断言 —— 前置确认（确实处于目标状态）/ 核心（`tasks_new` 必须仍存在，断言消息直接引用源码警告）/ **反向契约**（恢复出的 `tasks` 必须带 `issue_key`，证明它不是那张被 `DROP COLUMN` 的残表）。
  - **反向验证**：指纹校验变异由**存活**转为**捕获**；`!table_exists(tasks)` 判据移除亦被捕获。
  - **方法论：为什么 `db.rs` 适合 mutation** —— 它虽依赖真实 SQLite，但可测的是纯逻辑（迁移门控条件、恢复探测的可达性、`SCHEMA` 与迁移列表的一致性）。**不需要对 SQL 执行做 mutation**：要测的是「这段代码在什么状态下才会跑」，而 #340 的形态（自愈分支不可达）恰是可达性缺陷，**注入「把前置条件改成永不成立」一测就暴露**，读代码极易漏判。
  - ⚠️ **又犯了 #380 的同一个错误**（当时已写进 KB，本次仍重犯）：插入点替换的 anchor 只取 `fn xxx() {` 一行 ⇒ 上方 doc + `#[test]` 留在原地 ⇒ `duplicated attribute` + **原函数失去 `#[test]` 变 dead code**，而 **`cargo test` 仍通过（27 passed）**，只有 clippy 暴露。**教训固化**：插入点替换必须**连 `#[test]` 一起锚定**，或插入后**立即**跑 `clippy --all-targets` —— 这是 clippy 门禁（#366）的第二重价值。
  - 另记 1 个存活但**不是缺陷**的等价变异：去掉 `table_exists(tasks_new)` 判据 —— 全新库上两表都不存在，而 `table_has_column` 对不存在的表返回 `false`，条件仍为假。
  - 详见 [`issue-396-tasks-new-fingerprint-untested.md`](./issue-396-tasks-new-fingerprint-untested.md)

- **Unreleased — 断言强度审计（十）：CSS 静态断言 helper 只认精确选择器（#394）**

  - 审 `notes-layout.test.ts` 与 `styles.test.ts`（两者用 `?raw` 读 `styles.css` 做静态断言，因 vitest 跑在 node 环境无 DOM/布局引擎、§2.5 不引入 jsdom）。**同一个 `decls()` helper 在两个文件里各写了一份**（30 + 25 = **55 个守卫**受影响），且只匹配精确选择器字面量。
  - **盲区 1（最讽刺）**：锚点 `(?:^|[},])` **不含 `{`** ⇒ `@media` 内规则的 selector 前驱是 `{` ⇒ **完全不可见**；而 **#259 的缺陷本体正是「窄屏四列被压成 ~18px 竖条」** —— 要防的问题所在的空间恰好是守卫的盲区。
  - **盲区 2**：只认字面量相等 ⇒ 后代选择器 `.notes-page .notes-card-cols`（作用于同一元素、特异性更高、**实际生效**）与合并选择器 `.notes-card-cols, .sidebar` 全被漏。
  - **注入验证 5 种形态漏网 4 种**，修复后 **8/8 全捕获**。
  - **修复**：匹配语义改为「规则选择器按逗号拆开、去掉祖先前缀后**以调用方选择器结尾**」，一次覆盖四种写法（完全相同 / 后代 / 合并其中一项 / **调用方自带后代** —— `styles.test.ts` 里确实这么调用）。用 `endsWith` 避免 `.note-col` 误命中 `.note-col--p1`。规则提取用 `/([^{}]+)\{([^{}]*)\}/g`：**外壳因声明体含 `{` 被自然跳过，内层规则直接取到**，无需专门写嵌套解析。
  - **归纳出更一般的规律**（本系列第 3 例，成因各不相同）：#390 枚举只手写 6 个组件、#392 正则只匹配一种写法、**#394 解析只认一种语法形态** ⇒ **断言的实现形式（枚举 / 字面量 / 语法子集）必须覆盖问题出现的全部语法形式**。
  - 详见 [`issue-394-css-decls-selector-shape.md`](./issue-394-css-decls-selector-shape.md)

- **Unreleased — 断言强度审计（九）：#344 Esc 依赖守卫正则过窄（#392）**

  - `#390` 修好 `panel-wiring.test.ts` 的 openExternal **枚举**盲区后，本项是该文件的第二类盲区 —— **正则过窄**。
  - 守卫原文 `not.toMatch(/\}, \[on(Close|Cancel)\]\)/)` **只匹配依赖数组恰好等于 `[onClose]` 的形态**。而 #344 要防的是「**不稳定的回调依赖导致 Esc 层整体重排**」这**一类**问题（面板压过子层 ⇒ 一次 Esc 跳过取消直接关面板），不是「恰好等于 `[onClose]`」这一个写法。
  - **实测**：`[onClose, t]` 这种**完全自然**的写法 —— 任何人多留一个变量就绕过守卫，而失效机制照样发生。修复后 `[onClose]` / `[onClose, t]` / `[t, onClose]` / `[onClose, onClose]` / `[onCancel]` **5 种形态全捕获**，而 `[deps]` / `[]` **不误报**。
  - **关键取舍**：间接依赖（`useCallback` 把回调吃进 deps）当前无法被字面量正则发现，**如实标注为遗留局限**而非强上 —— 解析依赖来源的成本远高于收益。
  - **排查过程含两个假阳性**：①逐一核对 14 个 `?raw` 变量使用次数 ⇒ **无死 import**；②用组件名 grep 找未覆盖组件 ⇒ **误报**（`notesRaw` / `boardRaw` / `agentRaw` 走变量而非字符串）。**找覆盖缺口时「按名字 grep」与「按实际引用」结论可能相反。**
  - ⚠️ **本轮第八、九次「测量手段本身出错」，也是最该记住的一条：判结果只用退出码，不要解析输出文本**。⑧用 `grep -oE "Tests .*"|head -1` 抓到的是失败输出行 `Tests 1 ⎯⎯⎯`（非汇总行）⇒ 把 5 个形态全判反；⑨自写脚本用 `grep -q "No tests failed"` 判全绿，而该字符串并非 vitest 输出、**恢复态就误报** ⇒ 整张表结论作废。最终改用 `(npx vitest run >/dev/null 2>&1); echo $?`（0 = 全绿）一次跑完全部形态。
  - **与 #390 根因同源**：守卫覆盖范围窄于它要防的问题域。两者印证 —— **测试断言的措辞形式（枚举 / 相等 / 正则）必须匹配它要防的问题的粒度**，否则会在同一问题的其他写法前静默失效。
  - 详见 [`issue-392-esc-deps-regex-too-narrow.md`](./issue-392-esc-deps-regex-too-narrow.md)

- **Unreleased — 断言强度审计（八）：前端组件测试 —— openExternal 守卫的枚举盲区（#390）**

  - **结构性事实**：3 个组件测试文件全部用 `renderToStaticMarkup`（19 处），而服务端渲染**完全丢弃事件处理器**，且全仓**零交互模拟** ⇒ **任何组件测试都不可能抓到事件绑定缺陷**。在 §2.5 不引入 jsdom 的约束下，`panel-wiring.test.ts` 的静态正则守卫是唯一防线。
  - **但该守卫只遍历手写的 6 项枚举**：该文件已 import 12 个组件的 `?raw`，清单只有 6 个（`components/` 下共 **16 个** `.tsx`）。实测往 `AgentPanel` / `SettingsPanel` 各注入一处 `api.openInBrowser(` ⇒ **panel-wiring 全绿**；清单内的 `SessionsPanel` 注入才失败。
  - **「只改了一半」模式的第 5 次实例，且递归了一层**：#370 修的正是 `SessionsPanel` 裸调并**加了这条守卫**，但守卫只覆盖当时已知的 6 个组件 ⇒ 前四次是「只改了一半的**代码**」，这次是「只覆盖了一半的**守卫**」。
  - **修复**：与 #376 / #380 同源 —— **手写枚举 → `import.meta.glob` 自动枚举**（`components/*.tsx` + `App.tsx`），新增组件天然在范围内，**无需记得同步维护清单**。
  - **两条防恒真守卫**（#367 教训）：实测 `import.meta.glob` 路径写错时**静默匹配 0 个文件不报错**（`BAD=0`），守卫会变成恒真断言。故加 `names.length > 10` 下限 + **反向契约**（自动枚举范围须是手写清单的**严格超集**）。
  - **反向验证 7/7**：6 个原漏网组件 + `App.tsx` 全部捕获；破坏 glob 路径也捕获（`expected 1 to be greater than 10`）。
  - **过程中我犯了两次同类错误，都被当场抓出**：① 第一版只写 `'./components/*.tsx'`，漏了根目录的 `App.tsx` ⇒ **由我自己写的反向契约当场报出**（若无它，这个盲区会随修复合入 main，**与本 issue 修的正是同一类问题**）；② 验证时误判「守卫存活」，实际是 **vitest 变换缓存**返回旧结果 —— 本轮**第六次**「测量手段本身出错」。
  - **如实记录遗留局限**：`renderToStaticMarkup` 使组件测试**无法验证事件绑定**（`onClick` 绑错函数、回调内部逻辑错误当前无任何测试能发现），修它需引入 jsdom 违反 §2.5，应作独立提案评估。本 issue 只把「静态可查」那部分的覆盖从 6 个扩到 16 个 + `App.tsx`。
  - 详见 [`issue-390-openbrowser-guard-enumeration.md`](./issue-390-openbrowser-guard-enumeration.md)

- **Unreleased — 断言强度审计（七）：双实现一致性 —— 日期转换两侧 5 处分歧（#388）**

  - **`server.py::_iso_to_secs` 与 Rust `iso8601_to_secs` 是两份完全独立的实现**（一个手写闭式公式、一个调 `strptime`），而 Python docstring 明确声称「对齐 Rust」。实测 **5 处不一致**。
  - **真实缺陷**：Python 直接返回 `calendar.timegm(...)`，`1969-01-01` 得到**负数** `-31536000`，而 Rust 有显式 `y < 1970` 守卫返回 `0` ⇒ 同一 issue 被两条路径先后写入时 `created_at` / `updated_at` **取决于谁最后动手**，下游「相对时间」遇到负值显示荒谬文案。修复：`return secs if secs >= 0 else 0`。
  - 另 4 处（`2024-02-30` / `2024-1-01` / `2024-01-01T0:00:00Z` / `sec=60`）Python 一侧都更严格或更宽松，但**除 `sec=60` 外严格方向都是「返回 0」= 失败关闭**，故保持现状并显式记录，不为对齐而改行为。
  - **⚠️ `2024-01-01T00:00:60Z` 带跨平台性质（本项最值得记录）**：实测（macOS arm64 / glibc / Python 3.14.8）**`%S` 接受 60 与 61（闰秒）**，`timegm` 再进位到下一分钟；而 **musl（Alpine）与 Windows 的 C 库未必接受** ⇒ 同一份 `server.py` 在 Linux/macOS 与 Windows 上结果**可能不同**。而 `server.py` 正是 Windows / Linux 的**兜底实现**，故该值不能当稳定契约。GitHub 从不发闰秒故当前不可达，但将来若要支持闰秒语义，**必须两侧同时改且不能依赖 `strptime` 的平台行为**。
  - **方案：共享 fixture `mcp_server/fixtures/iso_parity.json`**（`must_agree` 27 条 + `known_divergence` 4 条附 `note`），**两侧测试各读同一个文件**。**不各写一份表的理由**：#155 已证明双实现副本必然漂移，且 **`server.py` 不参与 Tauri 构建**，Rust CI 完全跑不到 Python 侧测试。
  - **反向验证双向生效**：Python 退回 `return secs` → failures=2；改坏 fixture 中 `2100-03-01` 期望值 → **Python failures=1 且 Rust 1 failed 同时报警**（各自维护副本做不到这点）。
  - **插曲**：第一版 fixture 我照 Rust 抄了 `sec=60` 的期望值，测试当场报 `1704067260 != 0` —— 共享表的第一道价值生效。这是「期望值必须外部来源、必须实测」纪律的**第三次**生效（#378 手算 `2024-02-30` 出错是第一次）。
  - 详见 [`issue-388-iso-parity-two-implementations.md`](./issue-388-iso-parity-two-implementations.md)

- **Unreleased — 断言强度审计（六）：Python 侧第一批 —— MCP 引用解析形态覆盖缺口（#386）**

  - **`mcp_server/server.py::parse_issue_ref_parts` 是 agent 每次调用 MCP 工具的入口**（`update_task_status(issue, ...)` / `record_session` 等全部走它），而 AGENTS.md §8.6 要求它与 Rust `on_demand.rs` 行为等价。实测 **4 个变异存活**。
  - **最关键的一个**：`(?:issues|pull)` 退化为 `(?:issues)` ⇒ **`/pull/{n}` 链接全部解析失败**，且失败方式是抛「无法解析 issue 引用」—— 看起来像「用户填错了引用」，**不会有任何告警**。另 3 个：漏 `rstrip("/")` 使 `owner/repo/#N` 解析出错误 repo、`rpartition`→`split` 改多 `#` 行为、删空引用守卫改错误消息。
  - **跨侧覆盖不对称（额外发现）**：`on_demand.rs:459,485` **已有** `/pull/` 断言而 Python 侧完全没有 ⇒ Rust 改正则时 Python 侧无人发现。与 #155（改名漏改 Python 侧、读路径静默失效几个版本）同类风险面，只是那次靠人工比对列名发现、这次靠断言审计发现。
  - **关键技术点：断言必须断言**错误消息**而非只断言异常类型**。我第一版只写 `assertRaises(ValueError)`，结果 `rpartition`→`split` **依旧存活** —— 后者也抛 `ValueError`（unpack 长度不匹配），两种写法在测试眼里完全一样。改为断言 `编号非法` / `引用为空` 后 **6/6 全捕获**。**这正是 #376「断言看起来合理 ≠ 有判别力」的教训落在自己身上。**
  - **诚实标注 1 个存活不是缺陷**：`[^/#?]+` 放宽为 `[^/]+` 对合法 URL 是等价变异（路径段本就不含 `?`/`#`），只有畸形 URL 才分歧，不计入缺口。
  - **本轮第五次「测量手段本身出错」**：验证脚本 grep 只匹配 `FAILED (failures=`，而 `url-pull` 产生 `errors=1`（异常 vs 断言失败）⇒ 报成 `??`。五条纪律共同点：**先验证测量手段本身，再采信结论**。
  - 详见 [`issue-386-python-mcp-parse-ref-coverage.md`](./issue-386-python-mcp-parse-ref-coverage.md)

- **Unreleased — 断言强度审计（五）：Rust 侧第四批 —— GraphQL 链接解析别名守卫「空洞为真」（#384）**

  - **审计前 `parse_links_from_graphql` 只有 2 条平凡断言**（`{}` 与 `{"data": {}}` → 空），整条父子链接解析路径几无直接覆盖。
  - **发现真实漏洞（空洞为真）**：别名守卫 `!key.starts_with('a') || !key.chars().skip(1).all(is_ascii_digit)` 中，Rust 的 `Iterator::all` 对**空迭代器返回 `true`** ⇒ 光秃秃的 `"a"` 被当成合法别名放行，与紧邻注释声明的「别名固定为 `a<序号>`」相悖。实测 `{"a":{"number":994},"a1":{"number":101}}` 解析出 `[994, 101]`。
  - **严重性如实标注：当前不可达** —— `build_links_query` 生成的别名永远是 `a1..aN`，故这是**潜在缺陷**而非线上 bug。但它出现在一段**专门用于防御 `repo` 非别名字段**的守卫里，恰好在最该生效的场景失效；且 `name` 是字符串、`as_object()` 恰好返 `None` 挡住 ⇒ **连报错都没有**。修复：加 `key.len() < 2`。
  - 另发现缺失 `title` / `url` 的默认值（`unwrap_or("")` 改成 `unwrap_or("X")`）**无任何测试守护**，而该默认值直接进 UI（子 issue 标题、链接文案）。
  - **修复**：补 4 例 —— 真实响应形状（含 `name`/`owner` 仓库字段须被跳过）/ 逐个点名守卫判据（含裸 `"a"`）/ 9 种脏形状不 panic / 默认值回落空串（含类型不符）。外加生产代码一处加固。
  - **反向验证 3/3 全捕获**；lib 测试 168 → 172，clippy / fmt 干净。
  - **记录两个「存活但不该捕获」的变异**：删掉 `.filter(|p| !p.is_null())` 是等价变异（`link_from_node` 对 null 本就返 `None`）；host 提取取 `@` 后段（#382）是正确行为。避免后人重复排查。
  - **本轮第四次「测量手段本身出错」**：`cargo test --lib parse_links` 的过滤条件**不含新用例名**，用例**根本没跑**就报「存活」；改跑全量后 3/3 全捕获。至此形成四条纪律 —— ①注入须确认生效 ②变异方向须表达真实缺陷 ③期望值须外部来源 ④**过滤条件须覆盖被测用例**，共同点是**先验证测量手段本身，再采信结论**。
  - 详见 [`issue-384-parse-links-alias-guard.md`](./issue-384-parse-links-alias-guard.md)

- **Unreleased — 断言强度审计（四）：Rust 侧第三批 —— URL 白名单子域边界无守护（#382）**

  - **`common::validate_browser_url` 是 `open_in_browser` 命令的唯一闸门**，而 URL 来自 issue 正文 / PR 链接 / agent session 工作目录等**外部数据**（#370 确认 `SessionsPanel` 走这条路）。实测 **4 个变异存活，其中 2 个是真实的白名单逃逸**。
  - **逃逸形态（当前实现正确拒绝，但无守护）**：`ends_with(".ghe.com")` → `ends_with("ghe.com")` 会放行 `evilghe.com` / `notghe.com`（任何人可注册的域）；→ `contains("ghe.com")` 还会放行 `ghe.com.attacker.net` / `a.ghe.com.evil.net`。
  - **这是本轮最危险的变异形态**：去掉那个点看起来只是「去掉多余的点」的无害简化 —— Linter 不报，code review 极易放过（读者自动脑补「当然是指子域」），却把安全边界从「ghe.com 的子域」放宽成「任何以 ghe.com 结尾/包含 ghe.com 的域」，**且没有任何观测信号表明白名单已失效**。
  - 另 2 个存活是大小写方向（属**失败关闭**，合法大写 URL 被拒而非放进危险域），仍锁定：URL 大小写不受控，且**若有人为「修大写被拒」而把判据改成 `contains`，会一并放宽域匹配 —— 从功能修复变成安全逃逸**。
  - **修复**：补 2 例 —— 9 条伪装域（兄弟域 / 前后缀拼接 / userinfo 混淆 / 分隔符混用）+ 大小写与 trim 契约。额外验证 userinfo 逃逸向量：host 提取改取 `@` **前段**会放行 `https://github.com@attacker.net/o/r`，新用例成功捕获。
  - **反向验证 4/4 + userinfo 全捕获**；lib 测试 166 → 168，clippy / fmt 干净。
  - **变异方向教训**：userinfo 变异我第一次取了 `@` **后段**（存活），差点误判成「测试仍弱」—— 实际是**变异方向反了**，`@` 后段才是真实 host，取它本就是正确行为。与 #380 轮「把『只跑一次』写成无限循环」同类：**变异必须表达真实缺陷方向，否则存活不代表测试弱**。
  - 详见 [`issue-382-browser-url-whitelist-boundary.md`](./issue-382-browser-url-whitelist-boundary.md)

- **Unreleased — 断言强度审计（三）：Rust 侧第二批 —— Project Status 映射表 33/45 条目无测试守护（#380）**

  - **`sync.rs::map_project_status` / `map_project_status_en` 逐条 mutation 后只有 7 个条目被用例点名**（`done`/`completed`/`closed`/`released`/`ready for release`/`in review`/`in testing`），**实测 33 个条目删掉后无任何测试失败**。这两张表是 **#335 修复的核心产出**，函数注释逐字点名了「按整值精确匹配，不做子串匹配」「不认识的选项仍返回 `None`，绝不臆造」这份**显式契约**。
  - **缺陷形态是静默降级而非报错**（比 #378 更难发现）：删掉一个英文条目后落 `_ => None` ⇒「保持本地手动态」，而这**本就是许多 Project Status 的正确表现** ⇒ 不报错、不告警、UI 完全正常。删中文判据词同理会落到下一个 `contains` 或英文表。
  - **中文表尤其脆弱**：现有用例 `map_project_status("🎉完成/上线")` **一个字符串同时含「完成」和「上线」两个判据词**，删掉任一个另一个仍命中 ⇒ 断言通过。这与 #376 `taskSig` 的「字段组断言」**完全同型**（一次覆盖多个 ⇒ 单独删除测不出来）。
  - **修复**：表驱动测试 —— 39 个英文条目 + 9 个中文判据词逐条锁定，**中文用例每个只命中一个判据词**；另加反向契约断言表外值须返回 `None`，样本含注释承诺的陷阱（`release notes` 含 `release` 但≠`ready for release`、`in review needed` 多余后缀），锁定「不做子串匹配」。
  - **表驱动的额外价值**：把表本身搬进测试后，**增删条目时漏更新测试即编译失败** ⇒ 从根上消除「改了表没改测试」这个盲区本身。
  - **反向验证 0/33 → 33/33 全捕获**；lib 测试 163 → 166，clippy 干净。
  - **附记本轮自身的一次失误**：用脚本做字符串插入点替换时 anchor 只取 `fn xxx() {` 一行，上方 `#[test]` 与 doc 留在原地 ⇒ 叠加成 `duplicated attribute` 且**原函数丢失 `#[test]` 变成 dead code**。值得记录的是 **`cargo test` 当时仍然通过（166 passed）**，只有 `clippy --all-targets` 才暴露 —— 若只跑 `cargo test` 就提交，等于把「原测试静默失效」合进 `main`，**与本 issue 修的正是同一类问题**。
  - 详见 [`issue-380-status-map-table-contract.md`](./issue-380-status-map-table-contract.md)

- **Unreleased — 断言强度审计（二）：Rust 侧第一批 —— `iso8601_to_secs` 零测试覆盖（#378）**

  - **`common::iso8601_to_secs` 没有任何测试**，却被 `sync.rs` / `on_demand.rs` / `github.rs` **三个生产模块调用**；它含 Gregorian 闰年算术（`month_adjust` + 世纪年规则）与 6 项输入范围校验。唯一间接覆盖是 `sync.rs` 里一处 `> 0` 断言 —— 它无法区分「解析正确」与「解析出一个荒谬但为正的值」。
  - **实测 6 个变异全部存活**（注入后跑全部 lib 测试 160 passed，无一失败）：闰年规则退化为朴素 `%4`、`month_adjust` 漏 `m > 2`、`d - 1` 写成 `d`、去掉 `y < 1970` 守卫、月份上界放到 `1..=13`、时区偏移 `* 3600` 写成 `* 3601`。**缺陷形态是「静默偏移 86400」而非返回 0/负数**，正是最难察觉的一类。
  - **风险不是「当前实现有 bug」** —— 已用 Python `datetime`（标准库权威实现）逐条核对，实现**是正确的**。问题是**无守护**：任何人重构该函数（换日期库、修 lint、顺手「简化」闰年判断），CI 全绿而线上所有 issue 的创建/更新时间整体偏移一天。
  - **修复**：补 3 例，期望值**一律由 Python `datetime` 算出**，不用 Rust 闭式公式自证（测试与实现同源则同样错、同样过，等于零覆盖）。第三例**跨闰日逐日核对相邻间隔恒为 86400**，把「闰年规则」与「month_adjust」两个易错点组合验证 —— 单点用例可能碰巧对上，连续性不会。
  - **反向验证 0/6 → 6/6 全捕获**；lib 测试 160 → 163，`cargo clippy --all-targets -D warnings` 干净。
  - **审计方法论沉淀**：①「零测试的高调用量纯函数」应优先审；②每次注入都要确认注入生效（本轮第一版脚本因 `$` 被 shell 吞掉报「注入失败」，若采信就会把注入失败误判为断言失效）；③变异设计须能区分语义（第一轮把「只跑一次」写成 `for (let once = true; once;)` —— 那是**无限**循环、等价变异，白耗一轮）；④期望值必须外部来源，本轮我手算 `2024-02-27` 即算错（`1_708_128_000` → 实际 `1_708_992_000`），测试当场拦下。
  - 详见 [`issue-378-iso8601-test-coverage.md`](./issue-378-iso8601-test-coverage.md)

- **Unreleased — 断言强度审计（一）：`taskSig` 契约字段清单无人守护（#376）**

  - **#376 对 `taskSig.ts` 做逐字段 mutation（每次删一个字段再跑测试），15 个字段中 8 个删掉后无任何测试失败**：含两处**真实 bug** —— 漏 `updatedAt` ⇒ issue 被评论时同步只改 `updated_at`、其余字段全不变 ⇒ `applyTasks` 直接 return ⇒ **TaskCard 日期不刷新**；漏 `workDir` ⇒ agent 经 MCP `record_session` 设的工作目录**不刷新**（后者正是 #287 引入该字段要解决的问题）。
  - **根因：测试按「字段组」断言而非逐字段** —— session 三件套一次改三个，只要组内任意一个仍在签名里指纹就会变 ⇒ 断言通过 ⇒ **单独**删掉某个字段测不出来。`taskSig.ts` 注释逐个点名了必须纳入的字段（#181 / #220），即一份**显式契约**，却没有任何测试在守。
  - **修复**：改为**表驱动测试**（15 个契约字段逐个单独变化并断言指纹变化）+ 一条**反向契约**（抽样 `owner`/`repo`/`assignees`/`author` 断言它们**不**改变指纹，防契约与实现漂移）。比逐字段写用例更紧凑，且恰好覆盖「部分删除」这一当前盲区形态。
  - **反向验证：逐个删除 14 个字段，每个都必须让测试失败**（注入均确认源码残留 0 处）—— 修复前 8 个「存活」，修复后 **14/14 全部被捕获**。
  - **无运行时行为变更**：只改测试、不动 `taskSig.ts`。两处真实 bug 是「未来重构可能引入」的隐患，而非当前已存在的缺陷。
  - **方法论**：断言强度靠读代码判断极易出错 —— 本项的表驱动用例**读起来完全合理**，只有 mutation 才暴露问题。这与 #367 审计的结论一致：判定标准应是「注入缺陷后能否失败」。审计中我也一度把 mutation 失败误判为「注入没生效」，因此本轮每次注入都**附带打印源码残留计数**确认后才采信。

- **Unreleased — 深度 code review 第三批 · 续二：看板列模式乐观更新无回滚，UI 与后端分叉（#374）**

  - **#374 切换「看板列展示方式」保存失败时无提示且不回滚**：`handleBoardModeChange` 先 `setBoardMode(mode)` 乐观更新、再 `await onBoardModeChange(mode)`（最终是 `api.setAccountBoardMode`）却**无 `try/catch`** ⇒ 失败时 `<select>` 仍显示新值（看起来成功），刷新后跳回旧值，用户不知发生了什么。
  - **比 #372 更重**：#372 是「界面静默降级」，本项是「**界面显示的状态与后端实际不一致**」。
  - **根因是范式没被套用**：`AccountCard` 自身没有错误状态（外层 `SettingsPanel` 的 `err` 它取不到），而同文件其他写路径都有出口 —— `saveSettings` 用 `catch → setErr`，自定义列操作用 `state.msg`。**只有这条漏了**。
  - **修复**：补 `catch`，失败时 **`setBoardMode(prev)` 回滚** + `reportError` 上抛。成功路径行为不变。
  - **测试**：2 例，逐项锁定「`try/catch` + `reportError` + 回滚」三者齐全；第二例留余地（将来改用 `setErr` 也应接受）。**反向验证特意覆盖「加了 `try/catch` 但没回滚」的半修状态** —— 这是最常见的假修复，断言必须能识别它（实测如期 FAILED）。`npm test` 225 → 227 passed。
  - **无 schema / MCP 工具签名 / i18n key 变更**。

- **Unreleased — 深度 code review 第三批 · 续：看板列静默错序 / 静默退回 project 模式（#372）**

  - **#372 聚合视图下列表加载失败只落 `console.warn`，看板静默降级**：`listProjectStatuses` 失败 ⇒ `projectStatuses` 为空 ⇒ `sortProjectStatusKeys` 退化为**字母序**；`listAccountColumns` 失败 ⇒ `accountColumns` 为空 ⇒ `resolveBoardView` 从 `'custom'` **整体退回 `'project'`** —— 用户看到列全变了却不知原因。**后者比 `bug-audit-2026-09` P2-#7 记录的更严重**（审计只记了第一处，漏了同文件 `:266` 的同形缺陷）。
  - **修法**：改用 `reportError` 上抛到全局错误横幅 —— 仓库早在 `App.tsx` 就写下过这条经验（「避免无 UI 上下文的异步失败只落在 console 里造成点了没反应」），`openExternal`（#370）正是同源同解。**保留 #145 的隔离语义**（单账号失败仍返回空数组继续聚合，不因单账号失败而整块为空）。单账号视图本就调 `setError`、可见性正常，未改动。
  - **测试**：新增 2 例，**反向验证两处各自独立**（各改回 `console.warn` 均 FAILED）。写断言时我先后踩了两次自己的坑 —— ① `[\s\S]*?` 跨到另一个 catch；② 固定长度 + 假定缩进而那个 catch 塞了 4 行注释。最终改为「定位调用 → 定位紧随的 `.catch(` → 限定其后窗口」，**不再依赖跨块匹配与缩进假设**。`npm test` 223 → 225 passed。
  - **附：对 `bug-audit-2026-09.md` 的逐条复核结论** —— P0-#5（`branch`/`handoff` 未写入 `SCHEMA`）**已修**、P0-#6（`setBoardMode` 并发竞争）**已不成立**（那段代码已重构）、P0-#11 由 #370 修掉、P0-#13 测试覆盖不足**大幅改善**（前端 20 文件 225 例 / Rust 186 例 / Python 170 例）。该审计基于 2026-09 旧代码、部分条目已过期；按 `AGENTS.md §5.5`（历史记录不改）本次未动它，仅在此记录复核结论。
  - **无 schema / MCP 工具签名 / i18n key 变更**。

- **Unreleased — 深度 code review 第三批：SessionsPanel 打开外链失败时界面静默（#370）**

  - **#370 「任务会话」面板点击任务链接打不开时，界面毫无反应也不报错**：`void api.openInBrowser(task.url)` **只丢弃 Promise、不为 rejection 提供处理器**，于是 `invoke` 的 reject 变成未处理拒绝。而 `api.ts` 早有收口好的 `openExternal`（内部 `.catch(reportError)`），`SessionsPanel` 是全仓 6 个组件里**唯一**绕过它的漏网之处。
  - **可达性非理论**：`open_in_browser` 有多条现实失败路径 —— `validate_browser_url` 仅放行 `https://github.com` 与 `*.ghe.com`（历史数据混入其他 host 即被拒）、以及 macOS `open` / Windows `cmd /C start` / Linux `xdg-open` 的 `spawn()` 失败（无默认浏览器、进程上限、沙箱限制）。
  - **「只改了一半」模式的第四次实例**：`docs/bug-audit-2026-09.md` 的 **P0-#11 早已记录该模式**并建议「封装统一 `openExternal` 内部 catch，替换各处裸调用」；#329 完成封装并替换 5 处，**唯独漏了 SessionsPanel**。前三次：#339 `TaskCard` 未跟进 `taskIdentity`、#345 MCP 分帧只修 Rust 侧、#357 `get_req` 改了而 `get_opt` 仍静默丢弃。
  - **修复**：一行（改走 `openExternal` + 补 import，`api` 仍被该文件其他 3 处使用故不产生 unused）。
  - **测试**：把「封装 + 全部替换」变成可机械校验的不变量 —— ① 六个组件均不得裸调 `api.openInBrowser`；② **额外锁定 `openExternal` 自身必须带 `.catch`**（否则大家确实都在调 `openExternal`、第 ① 条仍全绿，收口形同虚设而无人察觉 —— #369 失效守卫教训的直接应用）。**反向验证两个方向各自独立**：改回裸调用 ⇒ ① FAILED；去掉 `.catch` ⇒ ② FAILED。`npm test` 221 → 223 passed。
  - **无 schema / MCP 工具签名 / i18n key 变更**；`handleOpenTask` 签名不变。

- **Unreleased — 静态守卫自诊断加固 + 全仓静态断言审计（#367）**

  - **#367 #355 修掉失效守卫后留下的新脆弱点**：`take_while("mod tests {")` 依赖「该文件只有唯一测试模块」这一**未被守护的前提** —— 测试模块改名/拆分后截断点消失，计数重新把测试代码算进去 ⇒ 静默退化成 #355 修复前的失效状态。修复：截断点改用 `#[cfg(test)]`（语义更准）并补「截断点之前确实读到生产代码」的守卫，范式取自 `lint-config.test.ts` 已有的「本条测试失去意义」用例。
  - **⚠️ 按实测更正了问题判断**：我原以为旧实现在「新增更靠前的测试模块」时会因计数被截掉而报「实测 0 处」（误导性报错），**构造场景逐一验证后发现并非如此** —— `mod tests {` 仍能正确命中、计数仍是 5。**新守卫的真实价值不在「能否失败」而在「报错是否自诊断」**：顶部插入测试模块时旧写法静默通过（报「实测 5 处」），新写法明确报「静态断言已失去意义」。这再次印证 #355 / #358 的教训：**静默通过的失效断言比直接失败的更危险**。
  - **顺带完成全仓静态断言审计**（借 #355 暴露的模式：断言声称的覆盖范围与实际不符 / 被自身污染）：对 `panel-wiring` / `styles` / `lint-config` / `about-window` / `notes-layout` 共 6 处逐个注入缺陷形态做反向验证，**全部如期失败 ⇒ 均真正承重，无同类失效**。它们普遍具备三个可复用范式：① 剥离注释后再匹配（避免注释里提到的写法被命中）；② 「失去意义」守卫（先断言确实读到了东西，再断言内容）；③ 双向相等而非单向包含。
  - **审计中的一次自我修正**：首次注入行内样式时正则未匹配到 `<aside className="notes-panel">`（误按 `<div>` 匹配），得出「反向验证没失败」的假警报；修正选择器后如期失败。**此类验证必须确认注入真的生效**，否则会把「注入失败」误读成「断言失效」。
  - **⚠️ 审计发现 #344 中我自己写的一条守卫是失效的**：`panel-wiring.test.ts` 里 `escHookRaw.match(...)` 只写 `?.[0]` 无 `?? ''` 兜底 ⇒ 无匹配时是 `undefined`，而 `expect(undefined).not.toBe('')` **会通过**（`undefined !== ''`）⇒ 守卫恒真。实测破坏 `useEscLayer` 的注册层片段后该文件**仍 25 passed 全绿**；加 `?? ''` 后同一注入如实失败。**这正是「静默通过的失效断言」本身的一个实例**，且是我上一批刚写的代码 —— 说明该模式值得作为审计项固化。已全仓复查 `not.toBe('')` 守卫，仅此一处漏兜底。Rust 侧无同类问题（`String` 无 `undefined` 语义）。
  - **实测数据**：`--all-targets` 确实多 lint 测试目标，但整条 `quality-check` 流水线实测仍约 **1.5 分钟**（`rust-clippy` 与其余 job 并行），**不是瓶颈**，故不需要 `--no-deps` 或拆分 job。
  - **无运行时行为变更**（改动仅限 `app/src-tauri/src/commands.rs` 的测试代码 + 文档）。

- **Unreleased — 深度 code review 批次（第二批）：写路径 0 行守卫 / Project issue 缺日期 / Rust 侧 MCP 三处缺口 / URL 锚点 / 工具链卫生（#355–#359）**

  - 本批 5 项来自第一批（#339–#346）review 中标记为「未展开」的较低优先级遗留项。与第一批同源，**共性仍是「门禁有盲区」**：`commands.rs` 的静态守卫被自身污染、CI clippy 只跑 `--lib`、`check-mcp-columns.py` 只校验读列。
  - **[#355](https://github.com/ShawnLiuSZ/task-dashboard/issues/355) `clear_session` / `record_handoff` 未守 `require_affected`**：key 不存在时返回 `Ok`（前端显示成功）却什么都没改、还误发 `TASKS_CHANGED_EVENT`，而 MCP 侧同名工具正确报错 ⇒ 两侧不一致。可达性非理论：GUI 传的 `task.issueKey` 来自列表快照，而 `sync.rs` 会硬 `DELETE` 30 天前的 `done` 行、仓库改名也改 `issue_key`。**修复**：两处先接返回值再过守卫。详见 [docs/issue-355-require-affected-remaining-writes.md](./issue-355-require-affected-remaining-writes.md)。
  - **⚠️ #355 顺带修掉一个**本来就失效**的防回归测试**：`write_commands_check_affected_rows`（#328 留下）用 `src.matches(needle)` 对整份源码计数，而 `mod tests` 里本文件自己的用例也含同样的 `require_affected(` 调用、把计数抬到阈值之上；且旧断言用 `>=` 而阈值恰好等于当时的实数，「又漏掉一条」时计数不降。实测：按原样把阈值提到 5 再做反向验证（删掉 `clear_session` 的守卫），**用例仍然通过**（实测 9 处，仍 ≥ 5）。修正为「过滤注释 + 在 `mod tests` 处截断 + `assert_eq!(…, 5)`」后反向验证如实失败。**教训：用源码静态断言做防回归时，断言体自身若包含被计数的模式，计数即被污染。**
  - **[#356](https://github.com/ShawnLiuSZ/task-dashboard/issues/356) 仅经 Project 发现的 issue `updated_at` 恒为 0、卡片日期永久空白**：根因**双重** —— 项目条目查询根本没选 `updatedAt`，而 `RawTask.updated_at` 又写死空串；`TASK_CONFLICT_UPDATE` 每次同步把 0 写回。修复补选字段并取值，**同时把内联查询串抽成纯函数**（沿用 #327 `org_projects_query` 先例）—— 这正是该缺陷长期潜伏的原因：查询串内联在网络函数里，没有任何测试能看到它选了什么字段。存量数据无需迁移（同步 Upsert 每次刷新该列）。详见 [docs/issue-356-project-issue-updated-at.md](./issue-356-project-issue-updated-at.md)。
  - **[#357](https://github.com/ShawnLiuSZ/task-dashboard/issues/357) Rust 侧 MCP（正式路径）仍有三处缺口**（#345 只修了 Python 侧）：① 缺/不可解析 `Content-Length` 误判 `Malformed` —— 原注释称「头部结束处帧边界已确定」，但那**恰是正文首字节**，正文长度未知、流位置未确定，应判 `Fatal`（与紧邻的 `len == 0` 分支口径本就不一致）；② NDJSON 分支无单帧上限（#328 的 `MAX_FRAME_BODY` 只覆盖 Content-Length 分支），无终止符的长行可无界撑爆堆，属同一类 DoS；③ **非字符串参数静默丢弃** —— `list_my_tasks({status:123})` 返回整块看板且 `isError:false`，而 Python 侧正确报错 ⇒ **正式路径给错数据、兜底路径给错误**。修复：两个取值器都校验类型（新增 `json_type_name`）；关键在 `get_opt` 也校验 —— **可选 ≠ 类型错误等于不传**（首版只改 `get_req`，被新测试当场打红）。详见 [docs/issue-357-mcp-framing-and-args.md](./issue-357-mcp-framing-and-args.md)。
  - **[#358](https://github.com/ShawnLiuSZ/task-dashboard/issues/358) issue 永久链接的尾部锚点在正式 MCP 路径被拒**：GitHub UI「复制链接」的标准形式 `.../issues/7#issuecomment-1` 是 agent 极常见输入。根因两处与 Python 侧不一致 —— 编号整体 `parse`（`trim_start_matches('#')` 只剥前导 `#`）、完全忽略第 3 段（`discussions/7` 被误当 issue 接受而 Python 拒绝）。修复后 6 组输入两侧行为逐条一致。**并纠正一条名不副实的既有测试注释**（「尾部锚点」其实只测了空白）—— 与 #355 同源：注释声称覆盖了什么、实际没覆盖。详见 [docs/issue-358-issue-url-anchor.md](./issue-358-issue-url-anchor.md)。
  - **[#359](https://github.com/ShawnLiuSZ/task-dashboard/issues/359) 工具链三项（门禁盲区）**：① `serverInfo.version` 硬编码 `0.6.1` 而实际 `0.6.5`（Rust 侧 `CARGO_PKG_VERSION` 自动取值），且 `check-versions.py` 不覆盖该文件 ⇒ 改为读 `Cargo.toml` **单一来源** + 反向校验；② CI clippy 只跑 `--lib`，**测试代码完全没被检查**，`main` 上 `--all-targets` 实测 5 处存量 error ⇒ 修掉并把门禁扩到 `--all-targets`（首次真正覆盖测试代码）；③ `check-mcp-columns.py` 只校验 `ENSURE_COLUMNS ⊇ SELECT_COLS`、未覆盖写列清单 ⇒ 新增 `⊇ TASK_INSERT_COLS` 断言，并补齐 `synced_at` 使门禁常绿。**③ 的性质是防御性冗余而非修 bug** —— #346 已复核该差集在真实路径中不可达。详见 [docs/issue-359-tooling-hygiene.md](./issue-359-tooling-hygiene.md)。
  - **本批测试增量**：前端 0（纯后端 / 工具链批次）、`cargo test` 150 + 26、Python MCP 53、scripts 114 → 117。
  - **行为变更**：`initialize` 返回的 `serverInfo.version` 由 `0.6.1` → `0.6.5`（此后随发版自动同步）；issue 永久链接带锚点时正式 MCP 路径不再报错。**无 schema / `tasks` 列定义 / MCP 工具签名（清单与参数不变）/ i18n key 变更**。

- **Unreleased — 深度 code review 批次 #7：MCP 分帧健壮性只修了 Rust 侧，Python 兜底一行坏数据即终止（#345）**

  - **#345 Python MCP Server 进程被一行坏数据整个终止，agent 侧表现为随机 `connection closed`**：Rust `mcp.rs` 早在 #328 就改为四态 `ReadOutcome`（畸形帧 `continue` 而非退出），`mcp.rs:750-753` 也明确写着「客户端发 UTF-8 BOM、写入被截断…agent 侧就会随机看到 connection closed」—— **但当时只修了 Rust 侧**。Python `server.py` 仍把畸形与 EOF 折叠成 `(None, None)`，主循环见 `None` 即 `break`；且 `json.loads(body)` 未包 try，异常上抛后被 `main()` 的 `except` 吞掉再 `break`，效果相同。
  - **修法**：移植四态 —— `MSG` / `EOF` / `MALFORMED`（本帧已完整消费 ⇒ 丢弃后 continue）/ `FATAL`（帧边界已丢失，body 未消费 ⇒ 只能终止）。关键区分：`Content-Length` 越界与头部不终止属 `FATAL`（继续读会把 body 字节当头部解析出垃圾），而 JSON 畸形 / 缺失 `Content-Length` 属 `MALFORMED`（边界已知，可安全继续）。
  - **一并补上两个 DoS 上限**（Rust 侧 #328 已有、Python 侧原本**完全没有**）：`MAX_FRAME_BODY = 8 MiB`、`MAX_FRAME_HEADER = 8 KiB`；且 **NDJSON 分支原本连长度上限都没有** —— 客户端发一条无终止符的长行会让长驻进程堆无界增长，属同类 DoS，一并补齐。
  - **刻意不改**：分帧仍靠**首字符**判定（`{` → NDJSON），故 BOM / 混入日志会走错路径并 EOF。这与 Rust 侧完全一致、属既有设计，本次用 `test_framing_is_decided_by_first_char` 显式钉住，避免后人误当「畸形帧」来「修」。
  - **测试（此前该文件 36 个用例无一触碰 `read_message` / `main`）**：新增 `FramingTests` 14 例 —— 11 例驱动真实 `read_message`（两种分帧正常路径防回归 + 各类畸形/越界/截断），**3 例端到端驱动 `main()`**（桩 stdin/stdout，不触网）。
  - **⚠️ 首次反向验证暴露的真实缺口**：缺陷症状（进程退出）由 `main()` 的**循环**决定，不是 `read_message` 的**分类**决定 —— 只测分类会漏掉「分类改对了但循环仍 break」的半修状态（当时只回退分类层，用例全绿）。补 3 例端到端后，两层可独立回退验证：回退 `main()` 的 `break` ⇒ 2 例失败；回退分类折叠 ⇒ 3 例失败。
  - **遗留边界（记录备查）**：① Rust 侧 NDJSON 分支同样没有单帧长度上限（两侧对齐宜作独立议题）；② `serverInfo.version` 仍硬编码 `0.6.1`（Rust 用 `CARGO_PKG_VERSION`），`check-versions.py` 未覆盖该文件。
  - **无 schema / MCP 工具签名（清单与参数不变）/ i18n key 变更**；改动限 `mcp_server/server.py` + 测试 + 文档。
- **Unreleased — 深度 code review 批次 #6：Esc 层注册放在不稳定 deps，父重渲染会颠倒层级（#344）**

  - **#344 确认框打开时按 Esc 不取消对话框、直接关掉整个父面板**：`escLayer.ts` 的分层栈要求「子层晚于父层注册、早于父层释放」，但 `SyncLogsPanel`（`}, [onClose])`）与 `ConfirmDialog`（`}, [onCancel])`）把**层注册**放进了带**不稳定回调依赖**的 effect —— 那些回调每次父渲染都是新函数。确认框打开期间一次父重渲染会让两个 effect 一起重跑，按「destroy 自底向上 → create 自底向上」把层级整体重排：栈空 → `[对话框]` → `[对话框, 面板]`，**面板反过来压过自己的子层** ⇒ 一次 Esc 跳过用户的「取消」直接关面板。
  - **触发路径均已在代码树中**：自动同步完成（`onSynced` → `loadSettings` → `setSettings`，默认 15/30 分钟一触发）、手动同步后 4 秒横幅消失计时器、20 秒轮询 + `focus` 处理器。其余四个面板免疫，因其 `useEscLayer` 用 `[]` 依赖。
  - **修复**：新增 hook `useWindowEscLayer(onEsc)`，把**层注册**放进 `[]` 依赖的 effect（整个生命周期只注册一次）、**业务回调**放进 ref（引用变化不影响层级）—— 「层注册」与「业务回调」解耦。两个组件改用它，并在 `registerEscLayer` 文档里写明「每个实例只应调用一次」及原因。**权衡**：不做「每次重渲染主动重注册」的自愈式修正 —— 那正是缺陷本身；层级应只反映挂载关系，与重渲染次数无关。
  - **本批唯一「正确机制因实现细节失效」的一项**：#329 的分层栈本身是对的，坏在调用方的注册方式。
  - **测试**：① `escLayer.test.ts` 新增 2 例**直接把不变式钉在栈原语上**（不依赖源码正则）—— 一例把「父重渲染 → 子被父压过」的**缺陷形态写成期望值**作反面对照，一例验证「注册各一次 + 3 次重渲染」后子层始终在栈顶且 Esc 命中子层；② `panel-wiring.test.ts` 新增静态守卫（两组件不得自己 `registerEscLayer`、不得有 `}, [onClose])` / `}, [onCancel])`，hook 侧层注册 effect 依赖须恒为 `[]`）。
  - **调整 2 条既有断言以跟随抽象**：#329 那两条用源码正则找 `registerEscLayer()` / `isTop()`，逻辑下沉后必然失效，故改为断言「走了分层 hook」。这是**跟随重构而非削弱** —— 真正的不变式由上述新增用例覆盖。
  - **反向验证**：把 `SyncLogsPanel` 还原成缺陷形态 ⇒ 新守卫失败（`1 failed / 21 passed`）；恢复后 215 passed。
  - **无 schema / MCP 工具签名 / i18n key 变更**；两组件 Props 接口与对外行为不变。
- **Unreleased — 深度 code review 批次 #5：`theme.ts` 用新 `matchMedia` 对象解绑导致 no-op（#343）**

  - **#343 显式选择浅色/深色后，系统主题变化仍会覆盖它 —— #329 的修复实际没生效**：按 CSSOM View 规范，`Window.matchMedia(q)` 每次返回 **new** MediaQueryList（各自独立的 EventTarget 监听列表）。#329 只记了**函数引用**，解绑时重新 `matchMedia(DARK_QUERY)` 拿到**新对象**去 `removeEventListener` ⇒ **对旧对象上的监听器无效**，解绑恒为 no-op。
  - **双重后果**：① 用户选 light/dark 后，系统主题一变仍触发 `applyTheme('auto')`；② **监听器泄漏** —— 每次 `setMode('auto')` 都在新对象上加一个，N 次切换 ⇒ 每次系统主题变更触发 N 次（幂等故无额外视觉症状）。
  - **既有测试为何发现不了**：`theme.test.ts` 的打桩是 `matchMedia: () => media`（**每次返回同一对象，与平台行为正好相反**）；那条名为「解绑用同一函数引用（否则 removeEventListener 静默失效）」的用例**只比较函数身份、从不比较 MediaQueryList 身份**，精确记录了自己无法观测的失败模式；`systemThemeListenerBound()` 标志位无论移除成功与否都置 `null`，故所有断言在完全泄漏的构建上照样通过。
  - **修复**：持有 **MediaQueryList 实例本身**（`systemThemeListener` → `systemMql`），解绑作用于同一对象。模块对外 API 签名与语义均不变。
  - **测试**：先把打桩改为平台语义（每次产出新对象 + 监听集合挂在该实例 + `function` 表达式保留 `this`，跨实例移除天然无效），并新增真实度量 `liveListeners()`（统计所有实例上仍挂着的监听器总数 —— 调用次数口径看不出问题，旧实现在此也是「1」）。新增 3 例；保留全部 4 条 #329 既有用例未削弱。
  - **反向验证**：还原 `theme.ts` 后**新增 3 例全败、既有 4 例仍通过**，失败数值精确对应泄漏模型（`expected 3 to be 1` / `expected 5 to be 0`）—— 同时**实证了旧测试为何无效**。恢复后 215 passed。
  - **无 schema / MCP 工具签名 / i18n key 变更**；改动限 `app/src/theme{,.test}.ts`。
- **Unreleased — 深度 code review 批次 #4：崩溃残留的 `tasks_new` 永久孤立，整个看板静默丢失（#340）**

  - **#340 崩溃窗口残留的 `tasks_new` 永久孤立，用户整个看板静默丢失且无法恢复**（本批唯一**数据永久丢失**项）：`migrate_tasks_v2_rebuild` 事务停在 `DROP TABLE tasks`（已提交）与 `RENAME`（未执行）之间 ⇒ 留下 **`tasks` 缺失、`tasks_new` 保有全量数据** 的状态。`migrate_tasks_v2_rebuild` doc comment 自己把它列为头号动机，#328 也加了 `DROP TABLE IF EXISTS tasks_new` 自愈，**但该 DROP 只在重建函数内部可达**，而前置条件 `tasks_uses_legacy_key()` 在 `tasks` 已不存在时为 false ⇒ **自愈分支恰好在最需要时不可达** ⇒ `SCHEMA` 建出空 `tasks`、结构检查通过、`user_version` 盖到 4 ⇒ 迁移此后再不重跑。
  - **实测（探针）**：`after-open: tasks_visible=0 orphan_tasks_new=1 user_version=4`；`after-2nd-open: tasks_visible=0 orphan_tasks_new=1 user_version=4` —— **二次打开不自愈**，与「下次启动重试」的设计预期直接矛盾。⚠️ **非 #328 引入的回归**（基线 `f66f83f` 行为相同）：#328 事务化把窗口从两次独立提交缩成一个事务，但没堵上这个洞，而其 doc comment 让人以为已修。
  - **修复**：在 `fresh` 短路**之前**探测 `!tasks 存在 && tasks_new 存在` 并 `RENAME` 回收，让既有 `missing_columns` / `MIGRATION_DDL` 按正常路径收敛。**这是恢复不是迁移**，故不触碰 `user_version`。
  - **⚠️ 实现中新发现的坑（第一版被新写的测试当场打红）**：探测块必须放在 `SCHEMA` **之前**（放晚了会「先建空表再 RENAME 失败」），但若 `tasks_new` 是**列不全**的同名表，`RENAME` 后 `SCHEMA` 的 `CREATE INDEX ... ON tasks(ownership)` 会因缺列失败、**整个库打不开** —— 比修复前「看板为空但能打开」更糟。故加 `issue_key` 列指纹判定（#155 重建后 tasks 的标志性列），命中失败则维持原状、下次启动重试。
  - **无 DDL / 列变更**（迁移路径完全复用既有逻辑）；稳态下不产生任何写语句，不影响 #329 的「稳态零写锁」优化。
  - **验证**：`cargo test --test db_test` 26 passed（25 → +1）✅、`cargo test --lib` 146 passed ✅、`cargo fmt --check` ✅、`cargo clippy --lib -- -D warnings` ✅（CI 实际门禁范围）；**反向验证**（删掉探测块）1 例失败（`0 passed / 1 failed`）。新用例 6 组断言含**手动态不被默认 todo 覆盖**与**二次打开幂等**。夹具刻意用**真实 `tasks` 布局**（先 `open_db` 建库再 `RENAME`）—— 手写精简列名会测到「SCHEMA 索引先失败」而非目标行为。
  - **附带发现**：`cargo clippy --tests` 在 `main` 上已有 **5 处**存量 error（`db_test.rs:43`、`commands.rs:2158`、`lib.rs:262` 等）。本 PR 未新增，但 CI 的 `rust-clippy` job 只跑 `--lib`、覆盖不到，可作独立议题跟进。
- **Unreleased — 深度 code review 批次 #3：仓库级 GraphQL 失败被降级成 `Ok(空)`，父子关联被静默清空（#342）**

  - **#342 仓库改名 / 转移 / 删除 / token 失权时，issue 的父子关联被静默清空且无任何报错**：#328 为避免「单个编号 NOT_FOUND 导致 25 个 issue 关联一起丢」而把 `fetch_issue_links` 改为宽松模式，放行判据是 `v["data"].is_null()` —— 但 **`data` 是仓库包装层**。仓库级失败时 GitHub 返回 `{"data":{"r":null},"errors":[…]}`，`data` 是**非 null 对象** ⇒ 守卫不触发 ⇒ 解析器命中 `data.r` 为 null 返回**空 map 而非 `Err`**。
  - **安全网恰好在最需要它时失效**：`Ok(空)` ⇒ `sync.rs` 视作成功 ⇒ `links_failed_repos` 收不到该仓库 ⇒ 落入 `unwrap_or((String::new(), String::new()))` 写空 ⇒ `TASK_CONFLICT_UPDATE` 无条件覆盖 `parent_issue` / `sub_issues` ⇒ 关联清空。`sync.rs` 那道「失败则保留既有值，避免一次网络抖动把已有关联清空」的保险**正是为此场景设计**，却被绕过。
  - **修复**：新增纯函数 `repo_level_failure`，把判据精确落在 **`data.r`** 这一层（仓库级失败 ⇒ `Err`），并在解析前调用。**不能把宽松整体关掉**——那会让 #328 想修的「25 个关联一起丢」重新出现；两类失败的区分点是 `data.r` 是否为对象（仓库有效 + 个别别名取不到 ⇒ 仍按宽松采信其余编号）。
  - **仍为只读**：不新增任何对 GitHub 的写操作，`AGENTS.md §2.1` 数据单向流动约束不变。
  - **无 schema / MCP 工具签名 / i18n key 变更**；改动限 `app/src-tauri/src/github.rs` 一个源文件 + 文档。
  - **验证**：`cargo test --lib` 148 passed（146 → +2）✅、`db_test` 25 passed ✅、`cargo fmt --check` ✅、`cargo clippy --lib -- -D warnings` ✅、`check-mcp-columns.py` / `check-doc-links.py` / `check-versions.py` ✅；**反向验证**：判据改回「只看顶层 `data`」则 1 例失败（`1 passed / 1 failed`）。新增的第 2 例是**反向对照**（仓库有效 + 个个别名失败 ⇒ 不得判失败），防修复过度连带关掉 #328 的宽松收益。
- **Unreleased — 深度 code review 批次 #2：全局 `opencode.jsonc` 空 `mcp` 被写成非法 JSON（#341）**

  - **#341 全局 `opencode.jsonc` 的空 `mcp` 对象被合并成非法 JSON，写坏用户全局配置**：`hooks.rs::find_top_object_span` 返回的是**键起始引号**位置而非 `{` 位置，而唯一调用方按 `{` 位置使用 ⇒ `inner` 恒以 `mcp":` 开头 ⇒ **空对象守卫是死代码**、`else` 分支永远执行 ⇒ 把 `,` 插进 `{` 后面，产出 `"mcp": {,`。后果：**用户全局配置被写坏、opencode 自身无法启动**，而安装流程返回 `Ok`（UI 报「安装成功」，用户不知需要从备份恢复）。
  - **「注释型 JSONC + 空 `mcp`」是 opencode 标准配置形态**（用户手写最小配置的常见结果），非边缘场景。**非空 `mcp` 不暴露缺陷**（插入点恰为合法追加），故既有测试 `global_merge_jsonc_appends_into_existing_mcp`（只覆盖非空、且只断言 `contains()` 从不解析）结构上抓不到。
  - **修复（两处，缺一不可）**：① 返回值改为 `{` 的位置，让 span 契约与调用方语义一致；② 空对象分支格式串同步修正 —— 改动 ① 之后 `text[..ms + 1]` 已含开括号，原格式串会多写一个字面 `{`，**只改 ① 会把 `"mcp": {,` 换成 `"mcp": {{`，仍是非法 JSON**（本次新写测试当场抓出）。详见 [docs/issue-341-opencode-jsonc-empty-mcp.md](./issue-341-opencode-jsonc-empty-mcp.md)。
  - **无 schema / MCP 工具签名 / i18n key 变更**；改动限于 `app/src-tauri/src/hooks.rs` 一个源文件 + 文档。
  - **验证**：`cargo test --lib` 148 passed（146 → +2）✅、`cargo test --test db_test` 25 passed ✅、`cargo fmt --check` ✅、`cargo clippy --lib -- -D warnings` ✅、`check-doc-links.py` / `check-mcp-columns.py` / `check-versions.py` ✅；**反向验证**（返回值改回键起始位置）2 例均失败。
- **Unreleased — 深度 code review 批次：卡片点击完全失灵（P0）等 8 项缺陷（#339–#346）**

  - 本批 8 项来自一次跨模块深度 review（范围 `v0.6.5 → HEAD`，含 #327/#328/#329/#330/#335/#336）。基线全绿（212 vitest + 171 cargo + `tsc` / `i18n:check` / `check-mcp-columns.py`），**8 项全部逃过现有测试**。
  - **共同根因模式：「只改了一半」** —— 三项高危都源于重构只覆盖了一侧：`TaskCard` 漏改身份生产端（消费端全改）；MCP 分帧健壮性只做 Rust 侧、Python 兜底未同步；崩溃残留自愈只覆盖了 `tasks` 仍存在的一个分支。
  - **[#339](https://github.com/ShawnLiuSZ/task-dashboard/issues/339)（P0）点击任务卡片完全无响应，详情面板不可达**：#329 把前端任务身份升级为 `issueKey@accountId`（聚合视图下同一 issue 来自两个账号时 `issueKey` 会重复），消费端（`Board` 4 处 `active` 判定 + `App` 的 `selectedTask` 查找）全部改用 `taskIdentity`，但**生产端 `TaskCard.tsx` 根本没进那次 diff**，仍在发裸 `issueKey`。两者永不相等 ⇒ `selectedTask` 恒 `null` ⇒ 四个看板视图 100% 无法打开详情。**既有测试给了虚假安全感**：`panel-wiring.test.ts` 用正则只断言消费端有 8 处 `taskIdentity`，从不检查生产者。**修复**：两处调用点改传 `taskIdentity(task)`；**写操作仍用 `issueKey`**（后端按 `issue_key` 定位，边界不变，测试显式锁住）。详见 [docs/issue-339-taskcard-select-identity.md](./issue-339-taskcard-select-identity.md)。
  - 其余 6 项已修复（各自独立 issue / 分支 / PR，见对应文档）：[#340](https://github.com/ShawnLiuSZ/task-dashboard/issues/340) 崩溃窗口残留 `tasks_new` 永久孤立致看板静默丢失；[#341](https://github.com/ShawnLiuSZ/task-dashboard/issues/341) 全局 `opencode.jsonc` 空 `mcp` 被合并成非法 JSON；[#342](https://github.com/ShawnLiuSZ/task-dashboard/issues/342) 仓库级 GraphQL 失败被降级成 `Ok(空)`、父子关联被清空；[#343](https://github.com/ShawnLiuSZ/task-dashboard/issues/343) `theme.ts` 用新 `matchMedia` 对象解绑导致 no-op；[#344](https://github.com/ShawnLiuSZ/task-dashboard/issues/344) Esc 层注册放在不稳定 deps 致层级颠倒；[#345](https://github.com/ShawnLiuSZ/task-dashboard/issues/345) MCP 分帧健壮性只修 Rust 侧。
  - **第 8 项 [#346](https://github.com/ShawnLiuSZ/task-dashboard/issues/346)（`synced_at` 不在 `ENSURE_COLUMNS`）经复核为误报、已关闭**：其声称的 `NOT NULL constraint failed` 需「列存在且 `NOT NULL`」+「该列不在 INSERT 列表」同时成立，而 `_write_task_if_absent` 的 INSERT 列清单正是从实际表结构过滤出来的（有列必被插入、无列无约束可违）；且 `synced_at` 自 Initial commit 起即在 `SCHEMA` 内，真正「老到缺列」的库会先被 `LEGACY_TASKS_COLUMNS` 判定拒绝服务。**未提交无效修复**，推理详见该 issue 内评论。
  - **本批次无 schema / MCP 工具签名变更**（`SELECT_COLS` 未动，`tasks` 列定义未改）；**无 i18n key 变更**。

- **Unreleased — CI 门禁盲区 / 操作类文档 `develop` 漂移 / 旧仓库名拼写残留（#336）**

  - **#336 `quality-check.yml` 的 `push` 只挂 `develop`，而该分支已不存在** ⇒ **直接 push 到 `main` 完全跳过重型门禁**（clippy / `cargo fmt --check` / `vite build` / `check-versions.py` / `scripts` 单测），只有 base = `main` 的 PR 才跑。这是 #330 刚加固完门禁后留下的缺口。**修复**：`push.branches` 补 `main`。详见 [docs/issue-336-docs-ci-reality-alignment.md](./issue-336-docs-ci-reality-alignment.md)。
  - **#336 操作类文档仍按「集成分支 = `develop`」描述**：`AGENTS.md`（8 处）、`CONTRIBUTING.md`（2 处）、`mcp_server/AGENT_INSTRUCTIONS{,.en}.md`（各 5 处）、`.claude` / `.opencode` 的 `task-start.md`（4 + 2 处）、`README.md`（1 处），以及 `mcp.rs` / `commands.rs` / `common.rs` / `server.py` 里 `set_work_branch` 的文档注释与**工具 description**（6 处，对 agent 可见）。这些不是历史叙述，而是**指导下一步动作的指令** —— 照错做会从已不存在的 `develop` 开分支，且 tool description 会把错误基线喂给每个调用 MCP 的 agent。**修复**：统一改为 `main`；`AGENTS.md §6.1` 删除「集成分支」行、`§6.3` 删除 `develop → main` 发版行，常规流程改为单主干。
  - **#336 `docs/release-backmerge-policy.md` 全文建立在失效前提上**：原文要求「release 合入 `main` 后把 `main` 回合 `develop`」。按 `AGENTS.md §5.5` 在顶部加**失效横幅**（指向现行约定），正文保留作历史记录，并声明保留 1 个版本周期后再评估删除。**不做内容重写**。
  - **#336 旧仓库名 `task-dashborad` 残留 4 处**：`docs/issue-52-custom-column-mapping.md`（2 处）、`docs/issue-62-bug-audit-fixes.md`（2 处）指向 2026-09-06 改名前的旧名。GitHub 保留重定向、链接可用，属**陈旧**而非断链。**顺带修真断链**：`docs/issue-279-work-branch-not-updated.md` 两条 `blob/develop/…` 绝对外链随 `develop` 删除已成 404，改为 `blob/main`（`check-doc-links.py` 只校验相对链接，覆盖不到此类）。
  - **边界口径（刻意不改的部分）**：历史知识库文档（`docs/issue-*.md` / `docs/bug-audit-*.md`）中的 `develop` 描述的是**当时的实况**，属正确的历史记录；`scripts/merge-cleanup.py` 的 `base ∈ {develop, main}` 与 `check-workflow-yaml.py` 的浮动分支名单是**工具应具备的能力**，一并保留。
  - **无运行时行为变更**（改动为文档 / CI 配置 / 注释）；**无 schema / MCP 工具签名 / i18n key 变更**（`SELECT_COLS` 未动）。
  - **验证**：`check-workflow-yaml.py` 6 文件 ✅、`check-doc-links.py` 无断链无孤岛 ✅、`check-mcp-columns.py` 28 列 ✅、`check-versions.py` 0.6.5 ✅、`scripts` 单测 ✅、`cargo fmt --check` ✅、`cargo clippy -- -D warnings` ✅、`cargo test --lib` / `--test db_test` ✅、Python MCP 单测 ✅；全仓库检索 `develop` 后，剩余位置**只**落在「历史知识库文档 / CHANGELOG 历史条目 / 工具能力描述与 fixtures / `quality-check.yml` 的兼容项」四类之内。

- **Unreleased — 已关闭 issue 滞留看板：`closed` 判据大小写敏感 + 英文 Project Status 未映射（#335）**

  - **#335 `tasks.issue_state` 同一列存在 4 种大小写**：`closed` 422 / `OPEN` 96 / `CLOSED` 63 / `open` 40。`github.rs::fetch_project_issues`（ProjectV2 条目查询）取 `content["state"]`，而 **GraphQL 的 `IssueState` 是大写枚举 `OPEN`/`CLOSED`**，REST 则是小写 —— 该值被原样落库，全链路无归一化。详见 [docs/issue-335-closed-state-case.md](./issue-335-closed-state-case.md)。
  - **#335 三处 closed 判据写死小写，大写行永不命中**：`sync.rs` 的 `t.state == "closed"`（`AGENTS.md §2.2` 优先级第 1 条「closed → done 远程权威覆盖」，**最高优先级分支对 Project 来源的 issue 完全失效**）、`db.rs::fallback_state_from_gh_state`、`commands.rs::set_project_status`（「已关闭就不再改 Project」的守卫形同虚设）。
  - **#335 兜底同样失效**：`map_project_status()` 只认中文 OMS 文案，而本项目两个 Project 的 Status 选项是**英文**（`Released` / `Done`）⇒ 返回 `None` ⇒ 按 §2.2 第 4 条保持本地手动态 ⇒ 卡在 `todo`/`processed`。另注 `sync.rs` 的 stale 清扫写的是**小写** `closed`，与 GraphQL 大写进一步混用。
  - **影响面（本地库实测）**：`issue_state = 'CLOSED'` 且 `status <> 'done'` 共 **29 行** —— fad-backend 13、foodsup-client 9、task-dashboard 4（#327–#330）、foodsup-app-h5-2.0 3；而 `issue_state = 'closed'` 且 `status <> 'done'` 为 **0 行**，反证缺陷只在大写一侧。
  - **修复（四层，缺一不可）**：① 新增 `common::is_closed_state()`（`eq_ignore_ascii_case`）替换全部三处判据；② 新增 `common::normalize_issue_state()`，同步 / 按需拉取 / Python MCP 三路径落库前统一转小写；③ `map_project_status()` 追加**整值全等**（非子串，防 `Ready for release` 误判成 `done`）的英文分支，兼容 emoji 与连字符写法；④ 新增一次性存量数据修复，随 `SCHEMA_VERSION` 3→4 门控执行（先归一化、再修正状态）。
  - **存量修复刻意不写 `done_at`**：一次修复拿不到真实关闭时间，而 `done_at` 唯一用途是「已完成任务保留 1 个月」的淘汰窗口（`WHERE done_at > 0`），臆造时间戳会启动淘汰倒计时;留 `0` 保证这些行不被误删（前端不读该列，展示不受影响）。修复语句为 best-effort：失败只记日志、不影响版本号推进，避免因失败导致 `needs_migration` 恒真而每次建连都跑迁移（回归 #329 修掉的「每次 `open_db` 写库」缺陷）。
  - **⚠️ 唯一对外行为变更**：Project Status 为**英文**选项（`Done` / `Released` / `In progress` / `In Review` / `Backlog` / `To Do` 等）时，此前一律「保持本地手动态」，现在会映射到四态 —— 这是修复的必要组成，否则 closed 判据修好后兜底路径仍是坏的。既有的 `resolve_final_status_follows_priority` 用例原先用 `"Backlog"` 当「映射不到」的样例，已随本次变更改用真正未识别的值。
  - **无 schema / MCP 工具 / i18n key 变更**（无增删改列；`SELECT_COLS` 未动）；前端零改动。
  - **验证**：`cargo test --lib` 146 passed（+5）✅、`cargo test --test db_test` 25 passed（+1）✅、`cargo fmt --check` ✅、`cargo clippy --lib -- -D warnings` ✅、Python MCP `unittest` 36 passed（+3）✅；**3 项反向验证逐项通过**（改回缺陷写法必失败：`is_closed_state` 改大小写敏感 → 2 例失败；清空数据修复 → db_test 1 例失败；Python 侧改回 → 2 例失败）。

- **Unreleased — code review P3 批次：版本号零校验且已漂移 / 15 篇孤岛文档 / ESLint 门禁形同虚设 / CI 缺构建与格式检查 7 项（#330）**

  - **#330 版本号「多处同步」零自动化校验，且已实际漂移**：版本号分散在 5 个文件（`package.json` / `package-lock.json` / `Cargo.toml` / `tauri.conf.json` / `Cargo.lock`），发版靠手抄，而**全仓库没有任何一步校验过**；实测前 4 处是 `0.6.5` 而 **`package-lock.json` 停在 `0.4.0`**（落后两个大版本）。`AGENTS.md §4.3/§6.4` 与 `release.yml` 注释还都只写「对齐**三处** version」，清单本身就不完整。详见 [docs/issue-330-p3-quality-gates.md](./issue-330-p3-quality-gates.md)。
  - **修复**：新增 `scripts/check-versions.py`（5 个文件必须一致，`package-lock.json` 的两处 `version` 都要对）+ 校验 README 中英的「当前版本」字符串（模式只匹配 `最新/latest vX.Y.Z` 与尾注，**不**匹配 `v0.3.24 及以下` 这类历史叙述）+ 可在 CI 与 `GITHUB_REF_NAME` tag 比对；接入 `quality-check.yml`。修正 `package-lock.json` → 0.6.5；`AGENTS.md` 与 `release.yml` 口径统一为「四处 + lockfile」。
  - **#330 README 版本号过期**：`README.md` 停 `最新 v0.6.0`／尾注 `v0.6.4`，`README.en.md` 停 `latest v0.6.0`／尾注 `v0.6.0`。**修复**：全部更新为 `v0.6.5`（日期 2026-09-29），并由上条脚本兜住。
  - **#330 15 篇孤岛文档**：`AGENTS.md §5.5` 要求「新增文档必须在 README / CHANGELOG 建立反链」，但 `check-doc-links.py` **只查正向链接有效性、不查是否被引用**。实测 `docs/` 下 14 篇没有任何文档引用 + 1 篇（`v0.3.16-multi-account.md`）只被另一篇引用，合计 **15 篇**只能靠「知道文件名」才找得到。**修复**：README 新增「历史知识库文档」小节逐条登记这 15 篇；`check-doc-links.py` 新增**孤岛检测**（`docs/` 直属的每篇 `.md` 必须被 README / CHANGELOG 引用），判定抽成纯函数 `find_orphans` 并配 14 例单测。
  - **#330 ESLint `--max-warnings 20` 只剩 2 条余量**：现存 16 条告警**全部**是 `react-refresh/only-export-components`（开发体验规则），而本仓库有 16 处**刻意**违反（纯函数与组件同文件导出，便于前端单测直接 import）⇒ 门禁实际含义变成「不许再写第 3 条 warning」，一个无关的 `any` 就能挡 CI。**修复**：改为按规则粒度**逐名登记**这 16 个导出（`allowExportNames`），并把阈值降到 **`--max-warnings 0`**（存量归零后任何新告警都挡住）；新增 `src/lint-config.test.ts` 断言名单与真实导出一致（防漏登记 / 防死配置）。
  - **#330 CI 不跑 `vite build` 与 `cargo fmt --check`**：vite 配置 / `build.target` / `frontendDist` 这类只在构建期暴露的问题要等到 release 打包才现形（那时已打 tag）；Rust 格式此前**完全没有**门禁。**修复**：`frontend-tests` job 追加 `npm run build`；先做全仓库 `cargo fmt` 归一化（**263 hunk / 11 文件**，独立 commit），再把 `cargo fmt --check` 挂进 `rust-clippy` job（`components: clippy, rustfmt`）。
  - **#330 action 版本 v4/v5 混杂**：`quality-check.yml` 是最后一个还用 `checkout@v4` / `setup-node@v4` 的 workflow。**修复**：全部升到 v5。
  - **#330 release 无超时 / 无并发控制**：6 个平台 job 都没有 `timeout-minutes`（挂死按 GitHub 默认 **6 小时**计费）；同一 tag 重复触发会并发往同一个 Release 上传附件、互相覆盖产物。**修复**：加 `timeout-minutes: 60` + `concurrency: {group: release-${{ github.ref }}, cancel-in-progress: false}`。
  - **#330 4 个只读 workflow 未声明 `permissions`**：`docs-check` / `i18n-check` / `mcp-schema-check` / `quality-check` 完全未声明，沿用仓库默认权限（可能含 write），违反最小权限。**修复**：全部补 `permissions: {contents: read}`（`release.yml` 与 `merge-cleanup.yml` 本就已声明，未动）。
  - **#330 `check-i18n.mjs` 硬编码两个语种**：`const files = {"zh-CN":…, "en-US":…}` 写死两份，而 README 明确宣传「复制 `en-US.json` 新增 `ja-JP.json`」⇒ 新增语种**不会被校验**，脚本却照样「✓ 通过」，给出虚假安全感。**修复**：`readdirSync` 动态发现 `locales/*.json`，以 `zh-CN` 为基准逐一比对；对比逻辑抽到新模块 `app/scripts/i18n-lib.mjs`（纯函数，配 13 例单测，含「第三语种缺 key」这一原实现看不见的用例）；`tsconfig.json` 开 `allowJs` 让 TS 能解析该 `.mjs` 导入（`checkJs` 仍关闭）。
  - **无运行时行为变更**（前端 / Rust / MCP 逻辑未动）；**无 schema / MCP 工具 / i18n key 变更**（仍 389 keys）。唯一代码层改动是 `cargo fmt` 的纯格式化。
  - **验证**：`npm test` 212 passed（+18）✅、`npx tsc --noEmit` ✅、`npm run build` ✅、`npm run i18n:check` 389 keys ✅、`npm run lint` 0 warnings（`--max-warnings 0`）✅、`npx prettier --check` ✅、`cargo fmt --check` ✅、`cargo clippy --lib -- -D warnings` ✅、`cargo test --lib` 141 passed ✅、`cargo test --test db_test` 24 passed ✅、`scripts/check-versions.py` ✅、`scripts/check-doc-links.py` 163 文件 / 无孤岛 ✅、`scripts/check-mcp-columns.py` 28 列 ✅、`scripts/check-workflow-yaml.py` 6 文件 ✅、`scripts` 单测 114 OK ✅；**11 项反向验证逐项通过**（改回缺陷写法必失败）。

- **Unreleased — code review P2 批次：校验脚本误报漏报 / MCP 列清单缺失 / 主线程阻塞 / 前端健壮性 18 项（#329）**

  - **#329 `merge-cleanup.py::CLOSE_RE` 丢中间 issue 编号**：编号用可重复捕获组 `(?:\s*#\s*(\d+)(?!\d))*` 收集，`(?:\u2026)*` 是非捕获组，内层 `(\d+)` 每轮迭代**覆盖**前一轮 ⇒ `m.groups()` 只剩「第一个 + 最后一个」。实测 `extract_issue_refs('t','Closes #1 #2 #3')` → `[1, 3]`，**#2 静默丢失**（该 issue 永不被自动关闭）；原单测只测 2 个编号，恰落在「首 + 尾 = 全部」的巧合区间。详见 [docs/issue-329-p2-quality.md](./issue-329-p2-quality.md)。
  - **修复**：编号串**整体**捕获，再用 `ISSUE_NUM_RE.findall()` 逐个取出。
  - **#329 `merge-cleanup.py::SKIP_DELETE_MARKERS` 子串匹配误伤**：`'test' in 'chore: bump to latest deps'` → `True`，任何标题含 `latest` / `contest` / `protest` / `attest` 的 PR 都被判为「验证用 PR」而**静默跳过删分支**，分支越堆越多。
  - **修复**：改词 / 短语边界匹配 `(?<![a-z0-9])(test|draft)(?![a-z0-9])`，保留 `test_workflow` / `test-PR` 原意。
  - **#329 `check-workflow-yaml.py` 误报合法写法**：顶层 `permissions: read-all`（官方简写）报「没有任何 scope 声明」；`on: [push, pull_request]`（合法内联数组）报「没有任何触发事件」。
  - **修复**：识别 `read-all` / `write-all` 与内联映射 `{...}`；`on:` 行非空即计入触发器。
  - **#329 `check-workflow-yaml.py` 漏报面**：新增 4 类判定——① 第三方 action 用 `@main` / `@master` 等**浮动分支**（上游一次 push 就替换你 CI 里执行的代码，本地零 diff 痕迹）；② 有 `runs-on` 但**无 `steps`** 的 job（GitHub 直接解析失败）；③ **顶层 key 重复**（原只查 `jobs`，两个 `on:` 会让第一段触发条件整段失效）；④ `needs:` 指向**不存在的 job**（该 job 永远 pending）。浮动分支用**明确 denylist**，不误伤 `dtolnay/rust-toolchain@stable` 这类受支持的通道写法；`needs` 只收集内联写法，宁漏不误报。
  - **#329 `server.py::ensure_schema` 缺列 → 旧库 `no such column`**：`SELECT_COLS` 要读 28 列，ALTER 清单只有 10 条，缺 `assignees` / `mentioned` / `latest_comment_url` / `pr_number` / `pr_url` / `work_dir` / `created_at` 等 7 列；症状只在「Python MCP 首次打开尚未被 App 迁移过的旧库」出现（App 自身正常、两侧测试都测不到，同 #169/#262/#278 源）。
  - **修复**：`ENSURE_COLUMNS` 覆盖全部 28 列 + 按需路径附加列；`check-mcp-columns.py` 新增「`ENSURE_COLUMNS` ⊇ `SELECT_COLS`」断言，漏改即 PR 阶段红。旧布局（含 `key`/`gh_state`/`gh_status`）改为**显式探测并拒绝**，提示「先启动一次 App 完成迁移」，不再把「schema 太旧」误报成「列名不存在」。
  - **#329 MCP `handoff_len` 字节数 vs 字符数不一致**：Rust 侧 `text.len()`（UTF-8 字节）报 6，Python 侧 `len(text)`（码点）报 2，同一份中文 handoff 两侧结论矛盾。
  - **修复**：Rust 改 `text.chars().count()`，两侧统一为**字符数**（本批唯一对外契约变动）。
  - **#329 `open_db` 每次建连都写库，与同步长事务叠加卡 UI**：每次调用都执行 `DELETE FROM notes` + 6 条 `INSERT meta` + 十余条 `ALTER`，而 `open_db` 被反复调用；同步侧把 stale 标记 + 全量 upsert 包成一个持锁事务，期间跑在主线程的命令在 `busy_timeout=5000` 上等待 ⇒ **最长 5 秒 beachball**。
  - **修复**：三层门控（`SCHEMA_VERSION=3` + `fresh`/`needs_migration` 判定）；`schema_is_current` 为**只读自愈探测**（`PRAGMA table_info` 比对 `REQUIRED_COLUMNS`/`REQUIRED_INDEXES` + legacy key 检查），只读语句永不阻塞 ⇒ **稳态零写锁**。`notes` 去重挪进一次性迁移；`ensure_default_settings` 改只读比对（只补缺失 key，不覆盖用户值）；`user_version` 快路径与只读探测并存，兼顾「版本号已推进但列/索引被删」的自愈。
  - **#329 重活跑在 Tauri 主线程**：`list_tasks`（全表扫描 + 逐行反序列化 JSON 父子关系，无 `LIMIT`）、`scan_agent_hosts`（遍历 `/Applications` 与 PATH 全目录 `is_file()`，冷 FS 数百毫秒）、`export_notes` / `import_notes` / `get_agent_hooks_status` 都是同步 `fn`，Tauri 2 在主线程执行。
  - **修复**：5 个命令统一改 `async fn` + `tauri::async_runtime::spawn_blocking`（与 `sync_now` 同款）；`get_agent_hooks_status` 抽出同步实现 `agent_hooks_status_blocking`。
  - **#329 前端任务唯一键跨账号不唯一**：后端唯一键是 `UNIQUE(repo, number, account_id)`，而前端用 `issueKey` 做 React key / 选中标识 / 指纹；**聚合视图**下同一 issue 来自两账号渲染成两行 ⇒ React key 重复、详情选错第一个、diff 失真。
  - **修复**：新增 `taskIdentity = \`${issueKey}@${accountId}\``，`Board`（4 处卡片 key/active）、`App`（选中文案 + `DetailPanel` key）、`SessionsPanel`（key）、`taskSig`（指纹补 `accountId`）全部接入。
  - **#329 Esc 冒泡双触发**：确认框与 `DetailPanel` / `SyncLogsPanel` 各监听 Esc，一次按键**同时**关闭确认框与整块面板。
  - **修复**：新增 `escLayer`（后注册者为栈顶，token 用 `Symbol` 精确出栈，StrictMode 双调用安全）+ `useEscLayer`；`ConfirmDialog` / `DetailPanel` / `SyncLogsPanel` / `SettingsPanel` / `AccountsPanel` / `AboutPanel` / `App`（更新提示抽成独立 `UpdatePrompt`，仅挂载时注册）的 `onKeyDown` 一律先判 `isTop()`。
  - **#329 `SessionsPanel.handleCopy` 无 catch + 定时器泄漏**：改 `await` + `try/catch`，定时器提 `useRef` 卸载清理。**#329 启动 quarantine 拉取无 catch**：`App.tsx` 补 `.catch(reportError)`。
  - **#329 `AgentPanel` 项目目录输入每键触发 2 次 IPC（含 FS 扫描）**：把实时 `targetDir` 与已提交 `committedTargetDir` 分离，输入框移出查询依赖，改失焦 / 回车提交。
  - **#329 `NotesPanel` 每次增删改整块替换成「加载中」**（界面跳变）：用 `loadedOnce` ref 区分首屏 `loading` 与后台 `refreshing`，右栏四列以 `aria-busy` 降透明而非换占位。
  - **#329 `SettingsPanel` 的 `[settings.accounts]` effect 重置未保存草稿**：依赖改稳定指纹 `accounts.map(a=>a.id).join(',')`。
  - **#329 `clearAllFilters` 绕过查询合并器直写 state**（与并发 load 竞态，最长 20s 自愈）：改 `await loadWith('', accountFilter)`。
  - **#329 CSS 引用未定义变量 → 样式静默失效**：`--text-secondary`（未定义）→ `--text-2`；`:root` 补 `--font-mono` 定义。**#329 主题切回「跟随系统」重复注册监听**：句柄提模块级，`setMode('auto')` 先 `unbind` 再 `bind`。
  - **无 schema / 无 MCP 工具 / 无 Tauri command 签名 / 无 i18n key 变更**：与 schema 相关只有「何时/如何跑迁移」（`user_version` 门控 + 只读探测 + `notes` 去重进迁移 + `PROJECT_ITEMS_DDL` 拆出），列仍 28 列受 `check-mcp-columns.py` 校验。`handoff_len` 语义由字节改字符是本批唯一对外契约变动。
  - **验证**：`npm test` 194 passed（+39）✅、`npx tsc --noEmit` ✅、`npm run build` ✅、`npm run i18n:check` 389 keys ✅、`npm run lint` 16 warnings（0 error）✅、`npx prettier --check` ✅、`cargo clippy --lib -- -D warnings` ✅、`cargo test --lib` 141 passed（+12）✅、`scripts/check-doc-links.py` 162 文件 ✅、`scripts/check-mcp-columns.py` 28 列 + ensure 覆盖 33 列 ✅、`scripts/check-workflow-yaml.py` 6 文件 ✅、`scripts` 单测 86 OK ✅；**18 项断言逐项通过反向验证**（改回缺陷写法必失败；前端 4 处同时回退令 8 例失败）。

- **Unreleased — code review P0 批次：About 按钮失效 / 语言切换器丢失 / 记事重复报错 / 项目条目数取错（#327）**

  - **#327 About 小窗「确定」按钮失效**：capability 只声明了 `windows:["main"]`，而 `about` 是独立 webview，不匹配任何 capability ⇒ 零 IPC 权限；且 `core:window:default`（实测 28 项）不含 `allow-close`，`getCurrentWindow().close()` 被 ACL 拒绝、按钮静默失效（#325 功能实际未生效）。详见 [docs/issue-327-p0-functional-defects.md](./issue-327-p0-functional-defects.md)。
  - **修复**：新增 `capabilities/about.json`（`windows:["about"]` + `core:window:allow-close`）；移除 `main` 上从未被前端调用的 `allow-show` / `allow-hide`。
  - **#327 设置面板「界面语言」切换器丢失**：基础设置里连续渲染了两个完全相同的「外观主题」下拉框，语言切换入口整块消失（i18n 的 `mode` / `setMode` 与 4 个语言 key 全零引用，成死代码）。
  - **修复**：第二块改回语言选择器（跟随系统 / 简体中文 / English）。
  - **#327 记事内容重复时报原始 SQLite 错误**：`notes.content` 上有唯一索引 `idx_notes_content`，`add_note` / `update_note` 未捕获约束冲突，重复内容直接在 UI 与 MCP 返回体暴露 `UNIQUE constraint failed: notes.content`。
  - **修复**：新增 `is_unique_violation()`（`SQLITE_CONSTRAINT_UNIQUE` = 2067），冲突时返回「已存在相同内容的记事」。
  - **#327 `projects.number_of_items` 取错字段**：`fetch_all_projects` 把 GraphQL 的 `number`（项目编号）当条目数存库（实测 OMS Kanban 存 `20` / 真实 `items.totalCount` = 273），使 `resolve_project_write_target` 的 `ORDER BY number_of_items DESC` 退化成「按编号排序」→ 多 Project 时写错写回目标（表现为「API 日志成功但目标项目状态不变」）。
  - **修复**：两处查询补 `items { totalCount }`；抽出 `org_projects_query` / `user_projects_query` / `parse_projects_nodes` 三个纯函数锁住回归。
  - **无 schema / 无 MCP 工具 / 无 i18n key 变更**：历史 `number_of_items` 旧值会在下次成功同步时被 `upsert_projects` 覆盖，无需迁移脚本。
  - **验证**：`npm test` 155 passed（+4）✅、`npx tsc --noEmit` ✅、`npm run i18n:check` 389 keys ✅、`npm run lint` 18 warnings（无新增）✅、`npx prettier --check` ✅、`cargo clippy --lib -- -D warnings` ✅、`cargo test --lib` 119 passed（+3）✅、`scripts/check-doc-links.py` ✅、`scripts/check-mcp-columns.py` 28 列 ✅；4 项静态/单测断言均通过反向验证（改回缺陷写法必失败）。

- **Unreleased — code review P1 批次：迁移无事务 / MCP 分帧退出 / 同步静默失败 / 403 误判限流等 9 项（#328）**

  - **#328 `migrate_tasks_v2_rebuild` 自称「单事务」实则无事务**：`rusqlite::execute_batch` **不会隐式开启事务**（只是逐条 `prepare` + `step`），`DROP TABLE tasks` 与 `ALTER … RENAME` 是两次独立提交。① 两步之间进程被杀 → `tasks` 丢失、数据滞留 `tasks_new`，下次启动 `CREATE TABLE IF NOT EXISTS tasks` 重建**空表**，本地权威态（`status` / `session_*` / `handoff` / `work_branch` / `work_dir`）永久丢失；② 中途失败残留 `tasks_new`（`CREATE TABLE` 无 `IF NOT EXISTS`）后，此后每次 `open_db` 都报 already exists ⇒ `needs_v2` 恒 `false` ⇒ `user_version` 永不推进，而查询报 `no such column: issue_key`，日志只有默认静默的 `tlog!`，**无自愈路径**。详见 [docs/issue-328-p1-data-safety.md](./issue-328-p1-data-safety.md)。
  - **修复**：`DROP TABLE IF EXISTS tasks_new` 自愈残留 + `BEGIN IMMEDIATE … COMMIT` 包住整段（`PRAGMA user_version = 2` 也进事务），失败显式 `ROLLBACK`。
  - **#328 MCP 一行坏 JSON 就退出整个进程**：`read_message` 用 `None` 同时表示 EOF 与「这一行畸形」，主循环 `while let Some(..)` 因此直接跳出、stdio 断开，而日志文案却写「跳过该行」（注释与行为不符）。客户端发 UTF-8 BOM / 写入被截断都会触发 agent 侧随机 `connection closed`。
  - **修复**：改为四态 `ReadOutcome`（`Msg` / `Eof` / `Malformed` / `Fatal`）——畸形帧丢弃后继续读，仅在帧边界无法定位（长度非法、头部不终止）时才终止。
  - **#328 MCP `Content-Length` 无上界 → 分配失败 abort**：`vec![0u8; len]` 直接吃客户端声明，`Content-Length: 99999999999` 会让 Rust **abort（不可捕获）**；头部逐字节读取同样无界。
  - **修复**：body 上限 8 MiB、头部上限 8 KiB，越界判 `Fatal`。
  - **#328 同步全败仍返回 `Ok`**：全部账号因 PAT 失效 / 空 PAT / 网络失败而跳过时，`run` 仍返回 `Ok` ⇒ `lib.rs` 清空 `last_sync_error`、推进 `last_sync_at`、广播 `SYNCED_EVENT`，用户看到「同步成功」但一条都没拉到；且被 `continue` 跳过的账号其 `sync_logs` 行**永久停在 `status='running'`**。
  - **修复**：新增 `ok_accounts` 计数，全 0 时返回 `Err`；把清理与 `last_sync_at` 写入移到早返回之前（失败也留痕）；跳过分支补日志收尾。`accounts_synced` 语义保持不变。
  - **#328 `graphql()` 无限流处理 → 项目状态 / 父子关系静默降级**：GraphQL 有独立配额，超限返回 403 + `Retry-After`，而原实现只判 `!is_success()` 即 `Err`；四个调用方全是 best-effort，于是限流窗口内 Project Status 全空、父子关系不更新。另 `fetch_issue_links` 里单个编号 `NOT_FOUND` 会让整块 25 个 issue 的关系全丢。
  - **修复**：抽出 `graphql_impl`，403/429 走与 `get_impl` 同一套 `rate_limit_wait` + 退避重试；新增宽松模式 `graphql_partial`（`data` 有值即采信），`fetch_issue_links` 改走该模式，写路径仍严格。
  - **#328 GUI 写命令吞掉「0 行受影响」**：`set_task_status` / `touch_session` 的返回值被直接丢弃，前端传已不存在的 `issueKey` 会收到 `Ok`、UI 显示成功但什么都没改（同文件 `set_work_branch` 却做了判断，内部不一致）。
  - **修复**：抽出 `common::require_affected`，GUI 三处与 MCP 侧共用同一实现（MCP 文案不变）。
  - **#328 查询错误被折叠成「不在任何 Project 中」**：`.map(Some).unwrap_or(None)` 把 `no such table` / 类型不符 / IO 等真实故障一并折叠成业务结论，把排障引向「再同步一次」的无效操作。
  - **修复**：只把 `QueryReturnedNoRows` 映射为 `None`，其余错误带原文上抛。
  - **#328 全部 403 都当限流 → 权限问题白等最多 30s**：403 也代表 token 无权限 / SSO 未授权 / 组织策略，原实现一律当成限流，缺权限时每次请求白睡默认 10s、重试 3 次。另 `search()` 限流重试分支漏掉 `items.len() < 100` 的分页终止条件。
  - **修复**：抽出纯函数 `rate_limit_wait_from_headers`（**仅** `X-RateLimit-Remaining == 0` 或存在 `Retry-After` 才按限流），非限流 403 立即返回并附权限指引；`get_impl` / `search` / `graphql` 三处共用；补上缺失的分页终止条件。
  - **#328 `search()` 单条坏 item 拖垮整个数据源**：`all.push(RawTask::from_item(item)?)` 让一条缺字段的坏 item 使整个 `search()` 失败，同源其它几百条正常数据一起进 `failed`（而 `fetch_prs_for_repo` 早已是逐条跳过，两处不一致）。
  - **修复**：抽出 `push_parsed_items` 统一为「跳过坏项」。
  - **无 schema 变更 / 无 MCP 工具变更 / 无 Tauri command 签名变更 / 无 i18n key 变更**：与 schema 相关的只有「迁移执行方式」（DDL 进事务、`user_version` 写入时机），列仍是 28 列受 `check-mcp-columns.py` 校验。
  - **验证**：`cargo test --lib` 129 passed（+12）✅、`cargo clippy --lib -- -D warnings` ✅、`npm test` 155 passed ✅、`npx tsc --noEmit` ✅、`npm run i18n:check` 389 keys ✅、`npm run lint` 18 warnings（无新增）✅、`npx prettier --check` ✅、`scripts/check-doc-links.py` 159 文件 ✅、`scripts/check-mcp-columns.py` 28 列 ✅、`scripts/check-workflow-yaml.py` ✅、`scripts` 单测 OK ✅；**12 个新增断言逐项通过反向验证**（改回缺陷写法必失败）。仓库整体尚未 `cargo fmt` 化，故本批不做全量格式化（P3 / #330 独立处理）。

- **v0.6.5（2026-09-29）— 编辑记事文本框不随内容长度自适应高度（#322）**

  - **#322 编辑记事文本框不随内容长度自适应高度**：进入编辑态时 `<textarea>` 与 `editDraft` 同帧挂载且带 `autoFocus`，原 `useAutoSize` 用被动 `useEffect(..., [value])` 测高，初始 `scrollHeight` 被 `overflow-y:auto` 列容器的滚动 / 绘制时序干扰，框体停在 `min-height:42px`，长内容需框内滚动；只有继续输入才撑开。详见 [docs/issue-322-note-edit-autosize.md](./issue-322-note-edit-autosize.md)。
  - **修复**：`useEffect` → `useLayoutEffect`（DOM 变更后、绘制前同步测量）；`useAutoSize` 新增 `active` 参数（调用处传 `editingId !== null`），进入编辑态那一帧主动重测；抽 `resize` 并返回 `{ ref, resize }`，编辑 textarea 改用 `ref={editRef.ref}`。
  - **约束不变**：上限 260px、`min-height:42px` 维持不变；纯前端行为，无 schema / 无后端 / 无 MCP 变更。
  - **验证**：`npm test` 143 例 passed ✅、`npx tsc --noEmit` 0 error ✅、`npm run i18n:check` 385 keys ✅、`npm run lint` 18 warnings（无新增）✅、`npx prettier --check` ✅、`python3 scripts/check-doc-links.py` 157 文件无断链 ✅。

- **v0.6.5（2026-09-29）— 菜单栏 About 改为自定义独立小窗（#325）**

  - **#325 原生 About 面板无法定制**：macOS 菜单栏「About TaskBoard」是 Tauri 默认应用菜单触发的系统原生面板，只有图标 / 名称 / 版本，无运行时信息与「确定」按钮。改为自定义独立小窗（label `about`，固定 380×320、不可缩放），菜单栏「About TaskBoard」打开该小窗。详见 [docs/issue-325-about-window.md](./issue-325-about-window.md)。
  - **自定义 macOS 应用菜单**：用 `tauri::menu` 构建应用菜单，把默认 About 替换为打开小窗的自定义项（id `about`），保留 App / Edit / Window 标准项（隐藏 / 退出 / 服务 / 复制粘贴 / 最小化 / 关闭用 `PredefinedMenuItem` 复用系统行为）。非 macOS 保留默认菜单（原生 About 面板），无回归。
  - **新命令 `get_runtime_info`**：返回 `{ appVersion, tauriVersion }`（应用版本 + Tauri 版本）；WebView 版本由前端从 `navigator.userAgent` 推导（Tauri 2 核心不暴露该 API，且不引入新依赖）。
  - **前端路由**：`main.tsx` 按 `getCurrentWindow().label` 区分，`about` 窗口只渲染 `AboutWindow`（不挂载完整 App），主窗口照常渲染 App。
  - **新增 i18n key**：中英文各 4 个（`aboutWindow.version` / `aboutWindow.tauri` / `aboutWindow.webview` / `aboutWindow.ok`）。
  - **无 schema / 无 DB 变更**：纯菜单 + 窗口 + 命令 + 前端 UI 改动。
  - **验证**：`npx tsc --noEmit` 0 error ✅、`npm run i18n:check` 389 keys ✅、`npm run lint` 18 warnings（无新增）✅、`npx prettier --check` ✅、`npm test` 151 例 passed ✅、`cargo check --lib` ✅、`cargo clippy --lib -- -D warnings` ✅、`cargo test --lib` 116 passed ✅、`scripts/check-doc-links.py` ✅。

- **v0.6.4（2026-09-23）— 删除会话二次确认恢复为居中弹框（#317）**

  - **#317 删除任务会话的二次确认弹框被铺满成全屏页面**：`.panel-page .modal` / `.panel-page .modal-mask` 覆盖规则本意是让内嵌面板（Settings / Accounts / SyncLogs / About）铺满主区，但 `ConfirmDialog` 也使用 `.modal` + `.modal-mask` 类名且渲染在 `.panel-page` 内部，于是被误伤成 `width:100%; height:100%` 的全屏「页面」。详见 [docs/issue-317-session-clear-confirm-modal.md](./issue-317-session-clear-confirm-modal.md)。
  - **收窄覆盖规则**：`.panel-page .modal` → `.panel-page .modal:not(.confirm-modal)`；`.panel-page .modal-mask` → `.panel-page .modal-mask:not(.confirm-mask)`。
  - **ConfirmDialog 加标记类**：遮罩加 `confirm-mask` 类，使 `:not()` 能精确命中、排除铺满规则。
  - **行为变化**：任务会话面板 / 账号面板（删除账号）/ 同步日志面板（清空日志）等所有面板内的二次确认框，现在均为居中弹框，不再全屏铺满。
  - **无 schema / 无后端变更**：纯 CSS + 1 行 TSX 类名改动。
  - **验证**：`npx tsc --noEmit` 0 error ✅、`npm run i18n:check` 385 keys ✅、`npm run lint` 18 warnings（无新增）✅、`npx prettier --check` ✅、`confirm-dialog.test.tsx` + `board.test.tsx` 22/22 passed ✅。

- **v0.6.4（2026-09-23）— 补全 #313/#314/#315 缺失的 KB 文档，修复 CHANGELOG 6 处断链（#319）**

  - **#319 CHANGELOG 6 处断链**：#313/#314/#315 的 CHANGELOG 条目引用了 `docs/issue-313-remove-sepia.md` / `docs/issue-314-agent-tools.md` / `docs/issue-315-guide-text.md`，但三篇 KB 文档此前从未创建，导致 `scripts/check-doc-links.py` 在 main 上持续失败。详见 [docs/issue-319-kb-doc-links.md](./issue-319-kb-doc-links.md)。
  - **补全三篇 KB 文档**：从 #313/#314/#315 的已合并改动补齐 `docs/issue-313-remove-sepia.md`、`docs/issue-314-agent-tools.md`、`docs/issue-315-guide-text.md`（背景 / 设计 / 接口变化 / 验证），使 CHANGELOG 链接指向真实存在的文件。
  - **无 schema / 无后端 / 无前端逻辑变更**：纯文档补全。
  - **验证**：`python3 scripts/check-doc-links.py` 通过（153 个 markdown 文件，0 断链）✅。

- **v0.6.3（2026-09-21）— 接入指引文案更新（#315）**

  - **#315 接入指引缺少 set_work_branch 触发时机**：record_session 也缺少 work_dir 参数说明。详见 [docs/issue-315-guide-text.md](./issue-315-guide-text.md)。
  - **补齐触发时机**：新增「切到 issue 分支之后」→ `set_work_branch(issue, branch=<当前 issue 分支>)`。
  - **补齐参数说明**：record_session 动作加上 `work_dir=<目录>` 参数。
  - **新增 2 个 i18n key**：`agent.guide.setBranch.when` + `agent.guide.setBranch.action`，中英文各 2 处。
  - **无 schema / 无后端变更**：纯前端 UI + i18n 改动。
  - **验证**：`npx tsc --noEmit` 0 error ✅、`npm test` 141 例 passed ✅、`npm run build` ✅、`npm run i18n:check` 385 keys ✅、`npx prettier --check` ✅。

- **v0.6.3（2026-09-21）— Agent 面板可用工具列表更新（#314）**

  - **#314 AgentPanel 可用工具表不完整**：只列了 6 个看板工具，但 MCP Server 实际提供 12 个工具（7 个看板 + 5 个记事）。详见 [docs/issue-314-agent-tools.md](./issue-314-agent-tools.md)。
  - **补齐工具列表**：TOOLS 数组从 6 项扩展到 12 项，新增 set_work_branch + 5 个记事工具（list_notes/add_note/update_note/update_note_label/delete_note）。
  - **新增 6 个 i18n key**：`agent.tools.setWorkBranch` + 5 个 `agent.tools.notes*`，中英文各 6 处。
  - **更新描述文案**：从「6 个看板工具」改为「12 个工具」。
  - **无 schema / 无后端变更**：纯前端 UI + i18n 改动。
  - **验证**：`npx tsc --noEmit` 0 error ✅、`npm test` 141 例 passed ✅、`npm run build` ✅、`npm run i18n:check` 383 keys ✅、`npx prettier --check` ✅、`scripts/check-mcp-columns.py` ✅、`scripts/check-doc-links.py` ✅。

- **v0.6.3（2026-09-21）— 移除护眼模式，只保留浅色和深色（#313）**

  - **#313 护眼色偏黄**：用户反馈护眼模式（sepia）颜色偏黄，要求移除，只保留浅色和深色两种主题。详见 [docs/issue-313-remove-sepia.md](./issue-313-remove-sepia.md)。
  - **移除 sepia 主题**：删除 `[data-theme='sepia']` CSS 块，theme.ts 类型从 `'auto'|'light'|'sepia'|'dark'` 改为 `'auto'|'light'|'dark'`。
  - **移除 i18n key**：删除 `settings.themeSepia`（中英文各 1 处）。
  - **无 schema / 无后端变更**：纯前端 CSS + TS + i18n 改动。
  - **验证**：`npx tsc --noEmit` 0 error ✅、`npm test` 141 例 passed ✅、`npm run build` ✅、`npm run i18n:check` 377 keys ✅、`npx prettier --check` ✅、`scripts/check-mcp-columns.py` ✅、`scripts/check-doc-links.py` ✅。

- **v0.6.3（2026-09-21）— 会话卡片：移除元数据白底 + 图标颜色调整（#310）**

  - **#310 会话卡片元数据白底突兀 + 图标辨识度低**：`.session-meta-value` 带白色背景块与卡片底色不统一；复制/删除图标颜色偏灰（`--text-2`），与可点击操作预期不一致。详见 [docs/issue-310-session-card-icon.md](./issue-310-session-card-icon.md)。
  - **移除白底**：`.session-meta-value` 删除 `background: var(--surface-3, var(--bg));`，文字与卡片底色自然融合。
  - **图标颜色**：`.session-card .note-tool` 使用 `var(--accent)` 强调色（复制/打开）；`.note-tool.danger` 静止态 `var(--danger)` 红色（删除）。
  - **无 schema / 无后端变更**：纯 CSS + 1 行 TSX 类名改动。
  - **验证**：`npx tsc --noEmit` 0 error ✅、`npm test` 141 例 passed ✅、`npm run build` ✅、`npx prettier --check` ✅、`scripts/check-mcp-columns.py` ✅、`scripts/check-doc-links.py` ✅。

- **v0.6.3（2026-09-21）— 主题系统：护眼/深色/跟随系统（#308）**

  - **#308 应用只有浅色背景**：长时间看板浏览偏刺眼，无深色/护眼可选，无法跟随操作系统主题。详见 [docs/issue-308-theme-system.md](./issue-308-theme-system.md)。
  - **3 套主题**：浅色（默认）、护眼（低饱和米黄/sepia）、深色（深紫蓝底 + 浅色文字）。
  - **CSS 变量**：`：root` 定义基础变量，`[data-theme="sepia"]` 和 `[data-theme="dark"]` 覆盖，包括背景/文字/边框/强调色/语义色/代码块/阴影等 20+ 变量。
  - **主题检测与持久化**：`localStorage['taskboard.theme']` 存储，`matchMedia` 检测系统主题，`auto` 模式下监听系统变化自动切换，模块加载时立即应用防 FOUC。
  - **设置入口**：SettingsPanel 基础设置 tab 新增「外观主题」下拉选择器（跟随系统/浅色/护眼/深色）。
  - **颜色转换**：将 `#a32d2d`→`var(--error)`、`#c0392b`→`var(--danger)`、`#fdecec`→`var(--error-bg)`、`#eaf6ef`→`var(--success-bg)` 等 15+ 硬编码颜色转换为 CSS 变量。
  - **新增 5 个 i18n key**：`settings.theme` + `settings.themeAuto` + `settings.themeLight` + `settings.themeSepia` + `settings.themeDark`，中英文各 5 处。
  - **新增文件**：`app/src/theme.ts`（主题管理模块，无 React 副作用，可被测试环境安全导入）。
  - **验证**：`npx tsc --noEmit` 0 error ✅、`npm test` 141 例 passed ✅、`npm run build` ✅、`npm run i18n:check` 378 keys ✅、`npx prettier --check` ✅、`scripts/check-mcp-columns.py` ✅、`scripts/check-doc-links.py` ✅。

- **v0.6.3（2026-09-21）— 会话卡片彩色边框区分相邻卡片（#304）**

  - **#304 会话卡片底色与面板背景过于接近**：整面墙缺乏区分度，扫一眼难以定位某张卡片。需要每张卡片加边框，使用几种颜色随机区分，且上下左右相邻卡片颜色必须不同。详见 [docs/issue-304-session-border.md](./issue-304-session-border.md)。
  - **4 色调色板**：定义蓝/绿/橙/紫 4 种边框色 CSS 变量（`--session-card-border-1` ~ `-4`），低饱和中等明度，浅底可辨识。
  - **着色公式 `(row + col) % 4`**：水平相邻（col 差 1）与垂直相邻（row 差 1）颜色必不同，无需第三方着色库。
  - **响应式列数实测**：CSS grid `auto-fill` 列数随窗口宽度变化，通过 `getComputedStyle` 读取 `gridTemplateColumns` 实测，窗口 resize 时重算。
  - **静态断言回归**：`styles.test.ts` 新增 5 条断言覆盖调色板、border 声明、着色公式、列数实测、ref 挂载。
  - **验证**：`npx tsc --noEmit` 0 error ✅、`npm test` 141 例 passed ✅、`npm run build` ✅、`npx prettier --check` ✅、`scripts/check-mcp-columns.py` ✅、`scripts/check-doc-links.py` ✅。

- **v0.6.3（2026-09-21）— 会话卡片补「清除会话」+ 复制按钮改 icon（#301）**

  - **#301 会话卡片缺清除入口 + 复制按钮视觉噪音大**：每张卡片只有「在浏览器打开」一个操作，用户想清除已结束/误记的会话只能去 SQLite 手动 UPDATE。后端 `clear_session` 命令已齐备，前端 `api.clearSession(key)` 已封装，只缺前端按钮。评论补充：卡片里的复制按钮目前是竖排文字，占位突兀。详见 [docs/issue-301-session-clear.md](./issue-301-session-clear.md)。
  - **清除会话**：卡片操作区新增 trash icon 按钮，点击弹出 `ConfirmDialog` 二次确认，确认后调 `api.clearSession` + `loadSessions()` 刷新，卡片即时移除。失败走 error 通道提示。
  - **复制按钮改 icon**：三个可复制行（分支/目录/Session）统一改为 icon 按钮，默认 copy icon，成功后短暂切换 check icon（1.5s），tooltip 保留。
  - **新增 2 个 i18n key**：`sessions.clear` + `sessions.clearConfirm`，中英文各 1 处。
  - **无 schema / 无后端变更**：纯前端 UI + i18n 改动，复用已有 `clear_session` 命令。
  - **验证**：`npm run i18n:check` 373 keys / locale ✅、`npx tsc --noEmit` 0 error、`npm test` 136 例 passed、`npm run build` ✅、`npx prettier --check` ✅、`cargo test` 24 例 passed、`scripts/check-mcp-columns.py` ✅、`scripts/check-doc-links.py` ✅。

- **v0.6.3（2026-09-21）— 会话卡片补 Session ID 展示 + 补齐 work_dir 写入链路（#300）**

  - **#300 会话卡片缺 Session ID + 工作目录恒不显示**：`list_tasks` 后端已返回 `sessionId`，但卡片没有任何行显示它；`record_session` 的 `work_dir` 参数是 #287 才加的，但写入入口覆盖不全（hooks.rs 提示词、session-start.sh、AGENT_INSTRUCTIONS.md、task-handoff.md 均未提 `work_dir`），导致生产库 17 条活跃会话的 `work_dir` 全部为空串。详见 [docs/issue-300-session-card.md](./issue-300-session-card.md)。
  - **Session ID 展示**：卡片新增「Session」行，完整显示 `task.sessionId`（不截断），等宽字体 + 一键复制按钮。放在「目录」行之后、Agent 行之前。
  - **work_dir 写入链路补齐**：hooks.rs `script_variant` 提示词补 `（含 branch、work_dir）`；taskboard-session-start.sh 示例补 `work_dir` 参数；AGENT_INSTRUCTIONS.md 触发规则表 + 两个示例补 `work_dir`；task-handoff.md（claude 版）补 `work_dir=$(pwd)`；task-handoff.md（opencode 版）补 `work_dir` 自动填充说明。opencode 插件已有 `work_dir` 自动填充逻辑，不需要改。
  - **新增 2 个 i18n key**：`sessions.sessionId`（Session）+ `sessions.copySession`（Copy session ID），中英文各 1 处。
  - **无 schema / 无 Rust 变更**：纯前端 UI + i18n + hooks 脚本 + 文档改动。
  - **验证**：`npm run i18n:check` 371 keys / locale ✅、`npx tsc --noEmit` 0 error、`npm test` 136 例 passed、`npm run build` ✅、`npx prettier --check` ✅、`cargo test` 24 例 passed、`scripts/check-mcp-columns.py` ✅、`scripts/check-doc-links.py` ✅。

- **v0.6.3（2026-09-21）— 去掉「任务会话」面板顶部的页面标题（#298）**

  - **#298 面板标题与侧边栏重复**：「任务会话」面板顶部显示大标题「任务会话」，而左侧侧边栏当前导航项已经高亮显示「任务会话」，信息完全重复，且占据面板顶部一整行空间。详见 [docs/issue-298-sessions-title.md](./issue-298-sessions-title.md)。
  - **做法**：移除 `SessionsPanel.tsx` 顶部的 `<header>` 和 `<h2>` 元素，面板内容区直接占据顶部空间。参考 Agent 面板处理方式——Agent 保留标题是因为顶部有操作按钮需要标题行承载工具栏，Sessions 面板顶部无任何操作按钮，标题行纯属冗余。同步清理 `sessions.title` i18n key（中英文各 1 处），保留 `sessions.title_format`（卡片内标题格式，与本次无关）。
  - **无 schema / 无 Rust 变更**：纯前端 UI + i18n 改动。
  - **验证**：`npm run i18n:check` 369 keys / locale ✅、`npx tsc --noEmit` 0 error、`npm test` 136 例 passed、`npm run build` ✅、`npx prettier --check` ✅、`scripts/check-doc-links.py` ✅。

- **v0.6.3（2026-09-21）— PR 正文裸提 #N 被误关联（#299）**

  - **#299 PR 正文裸提 #N 被误关联**：`sync.rs` 的 `parse_issue_refs` 把所有裸 `#N` 都当作关联目标，导致 PR 正文里顺带提一下某个 issue 编号就被错误关联。例如 PR #1342 正文里提了 `#1340` 就被关联上去，即使这两个根本不是同一个任务。详见 [docs/issue-299-pr-linkage.md](./issue-299-pr-linkage.md)。
  - **做法**：`parse_issue_refs` 改为只匹配有关闭关键词的引用（Closes/Fixes/Resolves/Refs/References/关闭/解决/修复），与 `scripts/merge-cleanup.py` 的 `CLOSE_RE` 保持一致。关键词前检查词边界（避免 `prefixfixed` 误匹配），但允许前面是中文（`已关闭 #284` 应匹配）；关键词后允许空白、可选冒号、repo 前缀；连续引用 `Closes #1 #2 #3` 一次匹配三个。
  - **影响**：PR 正文裸提 `#N` 不再关联，只有带关闭关键词的才关联。已关联的错误 PR 在下次同步时会被清除。不影响 MCP 的 `record_session` / `set_work_branch`（它们按 `issue_key` 查，不走 PR 关联）。
  - **验证**：新增 9 个测试用例覆盖关键词匹配、裸引用忽略、中文关键词、URL 锚、前缀子串等场景；`cargo test --lib parse_issue_refs` 9/9 通过、`cargo test --lib` 116/116 通过、`cargo clippy -- -D warnings` 0 warning、`scripts/check-doc-links.py` ✅、`scripts/check-mcp-columns.py` ✅。

- **v0.6.2（2026-09-20）— 任务会话总览：独立面板一览活跃 session（#287）**

  - **#287 同时在做几个任务、各自在哪个分支**：用户需要快速一览「同时在做哪几个任务、各自在哪个分支」——即所有活跃 session 的集中视图。核心需求：(1) 记录项目目录+分支+session+agent+时间 (2) 独立面板展示 (3) 自动写入+手动查看 (4) 任务完成自动清理 (5) 快速一览。详见 [docs/issue-287-task-sessions.md](./issue-287-task-sessions.md)。
  - **数据模型**：`tasks` 新增 `work_dir` 列（`TEXT NOT NULL DEFAULT ''`），复用已有 `work_branch` / `session_id` / `session_agent` / `session_at`。`touch_session`（common.rs）新增 `work_dir: Option<&str>` 参数，非空才写，与 `work_branch` 同款逻辑。
  - **读取路径**：新增 Tauri command `list_active_sessions`，返回所有 `session_id IS NOT NULL` 的任务（按 `session_at DESC` 排序）。MCP `SELECT_COLS` 同步（Rust 28 列 + Python 28 列），`row_to_value` 位置索引更新。
  - **自动清理**：`update_task_status` 在状态变为 `done` 时自动调用 `clear_task_session`（清空 `session_id` / `session_agent`，保留 `session_at` 审计）。
  - **前端**：新建独立 `SessionsPanel.tsx`（与备忘录平级），侧边栏新增「任务会话」导航项。会话卡片显示：任务标题+编号、工作分支（可复制）、工作目录（可复制）、Agent 名称、开始时间（相对时间）、点击可打开 GitHub issue。`Task` 类型新增 `workDir` 字段，`taskSig.ts` 指纹纳入 `workDir`。
  - **task-start 贯通**：`.claude/commands/task-start.md` 增加 `work_dir=$(pwd)` 参数；`.opencode/plugins/taskboard.js` 自动执行和 `tool.execute.before` 补参时自动填入 `work_dir`（项目目录）；`.opencode/commands/task-start.md` 说明 work_dir 由插件自动填充。
  - **文档**：`AGENTS.md` / `mcp_server/AGENT_INSTRUCTIONS.md` / `AGENT_INSTRUCTIONS.en.md` 同步更新 `record_session` 工具签名（增加 `work_dir?` 参数说明）。
  - **验证**：`scripts/check-mcp-columns.py` ✅（28 列两侧一致）、`scripts/check-doc-links.py` ✅、`npm run i18n:check` 中英各 369 key、`npx tsc --noEmit` 0 error、`npm test` 13 文件 136 例、`cargo check` 编译通过。

- **v0.6.1（2026-09-19）— 立即同步后看板空白、重启才恢复（#285）**

  - **#285 点「立即同步」后当前账号看板整体变空，必须重启 App 才恢复**：根因在产品层而非同步本身——同步完成后前端必跑一次 `listTasks`，而该查询在某些筛选下会直接报错或恒返回空集，于是「无数据」被写进 state 清空看板；`ownership` 是前端本地状态、重启即复位为「全部归属」，所以重启自然恢复。两处缺陷都在 `commands.rs::rows_to_tasks`（详见 [docs/issue-285-sync-empty-board.md](./issue-285-sync-empty-board.md)）。
  - **缺陷 A（列数错位）**：归属筛选分支的 SELECT 漏了 #278 新增的 `parent_issue` / `sub_issues` 两列（27 → 25 列），但 mapper 固定按位置索引读 25/26 列 → `Row::get(25)` 越界 → `list_tasks` 整体报错，拖垮「分配给我 / 未分配 / 分配给他人」三种筛选。
  - **缺陷 B（`meta.login` 恒空）**：`my-created` 过滤原读 `meta.login` 当「我」，但该字段只有 v0.3.15 单账号的 `save_pat` 会写，`add_account` / `device_login_poll` 从不写，多账号生产库实测恒为空串 → 该筛选无条件返回空集。
  - **做法**：统一所有筛选分支走同一条 `TASK_SELECT_COLUMNS`（27 列）+ 同一个 `task_mapper`，消除「归属分支漏列」；新增 `my_logins` 从 `accounts` 表按视图范围解析 login 集（聚合取全部账号、单账号取过滤/激活账号，**不读 `meta.login`**）；`read_active_account_id` 抽出来兜底。`doSync`（#19）改为快照点击时筛选 + 走合并器 `loadWith` 刷新（避免与 `onSynced` 并发的 coalesced load 互相覆盖），并在同步后显式重拉 `project_statuses` / 自定义列（同步会清空重写 `project_statuses`，沿用旧列也会让新任务落到任何列之外）。
  - **无 schema 变更**：不碰 SQLite、不新增列、不改迁移。
  - **验证**：新增 3 个 Rust 回归测试（`ownership_filter_returns_matching_rows_without_column_error` / `my_created_uses_account_login_not_legacy_meta_login` / `active_account_id_drives_default_filter`）——复现并修复两缺陷，含聚合视图与「账号 login 为空返回空集」边界；`cargo test --lib` 命令模块 9 例全绿、`cargo clippy -- -D warnings` 0 warning、`tsc --noEmit` 0 error、`npm run build` ✅、`npm test` 13 文件 136 例、`i18n:check` 中英各 356 key、`npm run lint` 18 warning（未超 `--max-warnings 20`）、`prettier --check` ✅、`scripts/check-mcp-columns.py` ✅、`scripts/check-doc-links.py` ✅。

- **v0.6.1（2026-09-19）— 配置项目开源协议（#281）**

  - **#281 仓库没有任何协议声明**：根目录无 `LICENSE`、`package.json` 与 `Cargo.toml` 也都没有 `license` 字段。法律上这等于**默认保留全部权利（all rights reserved）**——别人能 fork、能看，但没有任何条款允许复制、修改或分发，属 GitHub 上最常见的合规漏洞。协议声明散落在四个载体（`LICENSE` 文件、两个包管理器的 `license` 字段、README、CONTRIBUTING），任一缺失都会让下游工具读不到。详见 [docs/issue-281-license.md](./issue-281-license.md)。
  - **协议选 MIT**：issue 内的推荐项，依据收敛为三点——① **技术栈惯例**：Tauri 核心与 `tauri-plugin-updater` 为 MIT，`rusqlite` / `serde` / `react` 均为 MIT，`@tauri-apps/cli` 为 Apache-2.0，依赖树与 MIT 零冲突；② **定位匹配**：个人效率工具而非被公司集成的商业组件，不需要 Apache-2.0 的显式专利授权，也不该用 copyleft 阻碍使用者改造（GPL / AGPL 与「个人工具、随取随用」直接冲突）；③ **贡献门槛**：MIT 只需保留版权声明，PR 作者不用理解修改声明义务。决策对比表（MIT / Apache-2.0 / GPL-3.0 / AGPL-3.0 的优劣）见 KB 文档 §2。
  - **落地**：新建根目录 `LICENSE`（MIT 官方标准文本，只改版权行为 `Copyright (c) 2026 ShawnLiuSZ`——与 README / CI / Release 产物中的 owner 归属一致，`Cargo.toml` 里更早期的简写 `authors = ["liushizhao"]` 不动以免扩大改动面）；`app/package.json` 与 `app/src-tauri/Cargo.toml` 各加 `license = "MIT"`；`README.md` / `README.en.md` 预览图下方加 License 徽章、底部加「协议（License）」章节（点明唯一义务「保留版权声明」并复述免责条款的存在）；`CONTRIBUTING.md` 新增协议小节（PR 即按 MIT 授权、引入第三方代码需自行确认协议兼容、依赖协议以其自带 `LICENSE` 为准）。
  - **刻意不做的事**：① 用 SPDX 标识符 `MIT` 而非自然语言 `"MIT License"`（后者会让 `npm license` / `cargo metadata` 归一化为 `Unknown`），也**不是** `MIT-0`（去掉了必须保留版权声明这一条，而保留要求对上游追溯是免费收益，去掉没有必要收益），更不是 npm 历史惯用的 `ISC`（文本不同，混用会误导依赖扫描器）；② 不动 `Cargo.lock`——Cargo 只对 registry 包记录 `license`，本地路径包（含 workspace 根包）只记 name / version / dependencies，`cargo metadata --locked` 已验证不受影响；③ 不动 `package-lock.json`——`license` 不参与依赖树解析，`npm ci` 的同步性检查只看 `dependencies` / `devDependencies`，且该 lock 根条目版本号历史就与 `package.json` 不同步，不扩大改动面。`package.json` 的 `"private": true` 与新增 `license` 不矛盾：前者只阻止 `npm publish`，后者是给使用者读的元数据。
  - **验证**：`package.json` 仍为合法 JSON 且 `license` 解析为 `MIT`、`cargo metadata --locked` 通过（未报 license 非法）、`npm ci` 通过（exit 0，未报 lock 失配）、`scripts/check-doc-links.py` ✅（新增 `LICENSE` 相对链接与徽章 URL 均可达）、`scripts/check-workflow-yaml.py` ✅、`scripts` 单测全绿（后两项为回归防误伤，本次未动 workflow 与脚本）。
  - **无 schema / 无代码变更**：不碰 SQLite、不碰 Rust 业务逻辑、不碰前端、不碰 MCP 双实现、不碰 CI 配置——纯仓库元数据与文档。

- **v0.6.1（2026-09-19）— PR 合并后自动收尾：删分支 + 关关联 Issue（#284）**

  - **#284 每个 PR 合入后都要人工收尾**：删掉 `feature/issue-N-xxx` 分支、关闭 PR 标题 / 正文里声明的 issue —— 每合并一个 PR 重复一遍，且没有判断成分（分支名与 issue 号都在 PR 元数据里）。一个常被忽略的事实：GitHub 的 Closing keywords（`Closes #N`）只在合入**默认分支** `main` 时自动生效，而日常开发合入的是 `develop`，所以绝大多数 PR 的 `Refs #N` 从来不触发自动关闭，手动关是常态而非例外。详见 [docs/issue-284-merge-cleanup.md](./issue-284-merge-cleanup.md)。
  - **做法**：新增 `merge-cleanup.yml`，在 `pull_request: closed` 且 `merged == true` 且 base ∈ {`develop`, `main`} 时触发；先 `check-workflow-yaml.py` 校验全部 workflow 配置、再执行写操作（配置没验证就不动数据）。提取规则抽成纯函数 `extract_issue_refs`，**刻意保守、宁可漏关不可误关**：PR 标题全量匹配 `#N`；正文**只认带关闭关键词**的引用（Closes / Fixes / Resolves / Refs / 关闭 / 解决 / 修复），正文裸 `#N` 一律不关 —— 本仓库 PR 正文习惯引用历史 issue（「沿用 #155 / #175 / #237 的教训」），裸匹配会往早已关闭的无关 issue 里留言。安全护栏：fork 源分支跳过删除、标题含 `test` / `draft` 跳过删除（验证本 workflow 时保留现场）、远端分支 sha 与 PR head sha 不一致不删、已关闭的 issue 跳过且不重复留言、单项失败只 `::warning::` 不中断。正文走 `GITHUB_EVENT_PATH` 事件负载文件而非 shell 变量（正文含单引号 / 反引号 / 多行代码块，转义风险大）。
  - **顺带补齐 workflow 语法零覆盖**：此前 CI 只跑 i18n / MCP 列名 / 文档链接，**没有任何检查会碰 `.github/workflows/`**。新增 `check-workflow-yaml.py`（零依赖、逐行结构校验，刻意不用 PyYAML —— `${{ }}` 表达式、`on:` 被 YAML 1.1 解析成布尔值等 GitHub 专有写法通用解析器更易误报），拦下 9 类缺陷：tab 缩进 / 结构行奇数缩进 / 重复 key / 缺 `name`·`on`·`jobs` / `on:` 无触发 / job 缺 `runs-on`·`uses` / step 缺 `uses`·`run` / 第三方 action 未固定版本 / `${{ "..." }}` 引号冲突 / `if:` 含 `: ` 裸标量 / `permissions:` 空或 scope 非法 / 引用 `scripts/` 却没有 checkout。该检查器自己也被 CI 跑，故有**双向**要求（一个误报就让每个 PR 的 CI 都红），两类都有测试兜住。`quality-check.yml` 新增 `scripts-checks` job 随每个 PR 运行。
  - **测试拦下的真实缺陷**：`args.dry-run`（Python 解析成 `args.dry - run` → AttributeError，纯逻辑单测覆盖不到 `main()`）；`rest = s[len(key):]` 把冒号留在 value 里（`if: >-` 变 `": >-"`，初版对全部 6 个 workflow 报 30 处误报）；`on_block` / `jobs` 在每个顶层 key 处被重置（循环后恒空）；step 子键被记到 `job.keys`（两步式 step 全误判「空步骤 + 重复 key」）；`run: |` 在标记 `has_run` 前被 flush；块标量内强制偶数缩进（`if: >-` 续行非偶数缩进是合法格式）；`USE_RE` 不匹配 `- uses:` 内联形式（本仓库最常用写法从未被校验）；`strip_comment` 用 `line[i:i+3] == "}}"`（3 字符切片永不相等，只有 `}}` 落在行尾时才复位表达式深度）；`merge-cleanup.yml` 缺 `actions/checkout`（runner workspace 默认是空的，会以 file not found 静默失败）。review 另拦下两条：`CLOSE_RE` 用 `\b` 做词边界（汉字都是 `\w`，「已关闭 #284」永远匹配不上）；删分支对同一端点发两次 GET（合并为单次请求的 `head_branch()`，省一次网络往返）。
  - **验证**：`python3 -m unittest discover -s scripts -p 'test_*.py'` **62 例全绿**（`test_merge_cleanup.py` 29 例 = 提取逻辑 21 + dry-run 走完整 `main()` 8；`test_workflow_yaml.py` 33 例 = 现存 6 个 workflow 正向回归 + 每类缺陷反向验证 + 解析器单测）、`scripts/check-workflow-yaml.py` 6 个 workflow 全绿、`scripts/check-mcp-columns.py` ✅（26 列两侧一致）、`scripts/check-doc-links.py` ✅（135 个 markdown 无断链）。dry-run 四场景实测：正常路径 / fork 跳过删分支但仍关 issue / `test` 标记跳过删分支 / 正文仅裸引用不关任何 issue，退出码均 0 且全程无网络调用。
  - **追加（[#289](https://github.com/ShawnLiuSZ/task-dashboard/issues/289)，首个真实合并才暴露）**：PR #287 合并后 workflow 首次真实运行，issue 关闭成功（#284 已自动 CLOSED）但**删分支失败** —— runner 报 `::warning::删除分支 feature/issue-284-merge-cleanup 失败（HTTP 404）`，远端分支仍在。根因：DELETE 用了**单数** `/git/ref/heads/{branch}`，而 GitHub 上单数 `git/ref/{ref}` **只有 GET 路由、没有 DELETE 路由**，对任何分支名恒 404；更隐蔽的是 GET 对单复数都能路由，于是「分支存在 + sha 比对」全部照常有通过、走完所有护栏后才在 DELETE 那一步 404 —— **读路径把写路径的缺陷完全掩盖**。本仓库分支名全是 `feature/issue-N-xxx`（含 `/`），所以该缺陷从第一天起对每个分支生效；dry-run 全程不打网络，62 个全绿单测也拦不住。修法：抽出 `ref_head_path()` 纯函数让 GET 与 DELETE **共用同一路径**（复数 `/git/refs/heads/`；`/` 保留不编码 —— 该端点实测对编码与未编码的 `/` 都接受，保留字面 `/` 便于日志直接读出分支名）；新增 `RefPathTest` 4 例（含显式反向断言路径里不得出现 `/git/ref/`）与 `BranchDeleteFlowTest` 4 例（`mock.patch.object` 打桩 `api`、零真实网络，覆盖非 dry-run 的端点正确 / sha 不匹配保留分支 / 分支已不存在 / DELETE 失败只告警且不影响关 issue），**70 例全绿**；反向验证：端点退回单数时 5 个用例失败。真机复验：临时分支 `probe/merge-cleanup-verify` 被脚本实际删除、`git ls-remote` 确认远端已清空、退出码 0。
  - **无 schema / 无前端变更**：不碰 SQLite、不碰 Rust、不碰前端、不碰 MCP 双实现 —— 纯仓库工程自动化。

- **v0.6.1（2026-09-19）— 任务详情关联 parent / sub issue 并支持打开与复制（#278）**

  - **#278 详情看不出 issue 的父子关系**：GitHub issue 支持父子关系（子任务），但 TaskBoard 详情面板完全不体现——某 issue 挂在父任务下、或自身拆了子任务，看板里都看不出来，只能离开 App 去 GitHub 看。诉求：显示父 issue 编号 + 子 issue 编号列表，父与每个子项都能「在浏览器打开」「复制链接」。详见 [docs/issue-278-issue-links.md](./issue-278-issue-links.md)。
  - **做法**：`tasks` 新增两列 `parent_issue` / `sub_issues`（`TEXT NOT NULL DEFAULT ''`，存 JSON 对象 / 数组串，仅 `number` / `title` / `url` 三字段），不建关联表——父子语义不对称（0..1 / 0..N）、不参与任何本地逻辑（状态同步 / 筛选 / 排序都不碰它）、MCP 读 JSON 串天然透明，省一张表、一组 CRUD、一处双实现同步。同步走**批量 alias GraphQL**：按 `(owner, repo)` 分组、编号排序去重后每 25 个合一个请求（`a0` / `a1` … 逐个 `issue(number: N)`），解析以节点自身 `number` 为键；`subIssues` 属特性开关，`GraphQL-Features: sub_issues` 头**统一注入到 `graphql()` 的每个请求**（而非为这条查询复制一份 POST 实现）。失败策略按仓库粒度 best-effort：整组失败只跳过该仓库并**保留既有值**（记 `tlog`、不中断同步），与 PR 关联同一取舍；拉取成功而关系已移除则正常写空串覆盖。
  - **接口 / 迁移**：`common.rs` 增 `IssueLink` / `IssueLinks` + 静默降级的 `parse_parent_link` / `parse_sub_links`（脏数据不炸整个列表）；`github.rs` 增 `fetch_issue_links` 与两个纯函数；`commands.rs` 的 `Task` 暴露 `parentIssue` / `subIssues`（SELECT 追加在末尾，位置索引 25/26）；`on_demand.rs` 单 issue 按需拉取无法给出父子关系，两列写空串。`open_db()` 热路径幂等 `ALTER` 补列——**不能只放 `migrate_legacy_alters`**（它仅在 `user_version < 1` 执行，v2 物理重建走写死列白名单的 `INSERT..SELECT` 会丢列），沿用 #155 / #175 / #237 的迁移教训。前端新增「关联 Issue」块（**仅在有关联时渲染**，复用 `openExternal` / `copyToClipboard`），新增 3 个 i18n key；MCP `SELECT_COLS` 24 → 26 列，Rust 与 Python 逐列逐序一致、原样透传 JSON 串。
  - **验证**：`cargo test` 135 例全绿（111 lib + 24 db，含 v2 旧库补齐 / 重建不丢列 / 冲突清空与更新三条迁移回归、GraphQL 查询布局与解析降级三条纯函数测试、MCP 26 列逐列不错位）、`cargo clippy -- -D warnings` 0 warning、`tsc --noEmit` 0 error、`npm run build` ✅、`npm test` 13 文件 136 例、`i18n:check` 中英各 356 key、`npm run lint` 18 warning（未超 `--max-warnings 20`）、`prettier --check` ✅、`python3 -m unittest discover -s mcp_server` 29 例全绿、`scripts/check-mcp-columns.py` ✅（26 列两侧一致）、`scripts/check-doc-links.py` ✅。真机实测 alias 查询（带特性头）：`errors: null`、`parent: null`、`subIssues.nodes: []`、alias 与 `owner.login` 回包正常。

- **v0.6.1（2026-09-19）— 开始任务后 work_branch 仍关联基线分支（develop/master）（#279）**

  - **#279 开始任务后工作分支没更新**：用户把 issue 派给 agent，agent 先在 `develop` / `master` 上「开始任务」、随后才创建 / 切换到该 issue 的工作分支；结果 GitHub 上分支已建好，看板详情的 `work_branch` 却仍关联基线分支。根因是两个 `task-start` slash command 在第一步（agent 仍在基线分支）就取分支并写入 `work_branch`，opencode 版更在命令展开时即填入基线分支。详见 [docs/issue-279-work-branch-not-updated.md](./issue-279-work-branch-not-updated.md)。
  - **做法**：两路互为兜底——① 重写两个 `task-start` 指令与 prompt-reminder 钩子，强制「先切 issue 工作分支、再记录会话」，分支捕获移到切换之后；② 新增窄工具 `set_work_branch(issue, branch)`，agent 切到 issue 分支后调用即可纠正 `work_branch`，只写 `work_branch`、不碰同步自动拉的 PR `branch`。Rust（`common.rs` / `commands.rs` / `mcp.rs`，含 3 例 mcp 测试）与 Python（`mcp_server/server.py`，含 3 例单测）双实现一致；`record_session` 的 `branch` 入参行为不变。
  - **验证**：`cargo test --lib` 全绿（新增 3 例）、`python3 -m unittest discover -s mcp_server` 29 例全绿、`scripts/check-mcp-columns.py` ✅、`scripts/check-doc-links.py` ✅。

- **v0.6.1（2026-09-19）— 手动下载流程补充「重启应用」按钮（#272）**

  - **#272 手动下载后无重启入口**：`about.restart` 按钮仅在 updater 通道安装成功后（`installed` 阶段）出现；当 updater 失败回退为手动下载（`manualUrl` 分支），用户点「前往下载」跳转浏览器后 App 内**没有任何重启按钮**，必须手动退出重开。详见 [docs/issue-272-restart-after-manual.md](./issue-272-restart-after-manual.md)。
  - **做法**：在 `available` 阶段的手动下载分支追加次级按钮「我已安装，重启应用」，复用已有 `api.restartApp()`（Tauri 2 `app.restart()`），文案明确「先下载安装、再点重启」的时序。纯前端 + i18n 改动，零 Rust / schema 改动。
  - **验证**：`tsc --noEmit` 0 error、`npm test` 136 例 passed、`i18n:check` 350 key / locale。

- **v0.6.1（2026-09-19）— 全库 review 隐藏 bug 批量修复**

  - **Python MCP `serverInfo.version` 硬编码落后 7 个版本**：`mcp_server/server.py:953` 返回 `"version": "0.3.47"`（实际 App 已 0.6.0），与 Rust 侧 `mcp.rs` 的 `env!("CARGO_PKG_VERSION")` 不一致。Agent 读 `initialize.serverInfo.version` 获得错误能力信号。已更新为 `"0.6.1"`。
  - **Python MCP `ensure_schema` 只补 2 列、缺 6 列**：`server.py:139` 只 ALTER `branch` / `handoff`，但 `SELECT_COLS` 引用 `project_status` / `candidate_done` / `account_id` / `work_branch` / `author` / `comments_count` 等列。对部分迁移的 DB 会报 `no such column` 硬失败。已补齐 6 列。
  - **device-login 轮询卸载后永不停止**：`AccountsPanel.tsx` 的 `while` 循环仅靠 UI 触发取消，组件卸载时不中断——持续调用 `device_login_poll` 并在已卸载组件上 `setState`（每几秒一次网络请求，内存泄漏）。新增 `useEffect` 清理函数递增 `oauthRunRef`。
  - **`taskListSignature` 指纹缺 `workBranch`**：`taskSig.ts` 的指纹计算漏了 `workBranch` 字段，导致 agent 通过 `record_session` 更新 `work_branch` 后前端不感知变化（`useEffect` 依赖数组中 `signature` 不变 → 跳过重渲染）。已补入指纹计算。
  - **`iso8601_to_secs` 对空串 panic**：`common.rs` 的 `iso8601_to_secs` 在输入空串时 `str.parse::<i64>()` 返回 `Err` 被 `.unwrap()` 炸掉。改为 `.unwrap_or(0)`，与 `created_at` 的 `DEFAULT 0` 语义一致。

- **v0.6.1（2026-09-19）— 任务卡片显示 issue 创建时间（#280）**

  - **#280 卡片缺少创建时间维度**：用户需要知道 issue 是什么时候创建的，便于判断任务新鲜度。详见 [docs/issue-280-created-time.md](./issue-280-created-time.md)。
  - **做法**：`tasks` 表新增 `created_at` 列（`INTEGER NOT NULL DEFAULT 0`），从 GitHub Search API + REST 响应解析 RFC3339 字符串并转为秒级时间戳；卡片在「创建人」与「分配人」之间插入「创建于」行（`YYYY/MM/DD HH:mm` 格式，值为 0 时不渲染）；MCP `SELECT_COLS` 新增末列（27 列）；新增 i18n key `card.createdAt`。
  - **无 schema 破坏性变更**：老库通过 `ALTER TABLE` 幂等补齐，`DEFAULT 0` 不影响既有数据。

- **v0.6.1（2026-09-19）— 切换账号后搜索状态未重置（#286）**

  - **#286 跨账号搜索干扰**：在账号 A 搜索 issue 编号后切换到账号 B，搜索框仍保留上次内容，导致新账号看板被过滤为空。详见 [docs/issue-286-search-reset.md](./issue-286-search-reset.md)。
  - **做法**：`handleSwitchAccount` 补充 `setQuery('')` + `setRepo('')` + `setHiddenAfterSync(0)`，与 `clearAllFilters` 行为一致。纯前端改动，零后端 / schema 变更。
  - **AgentPanel 读过期 `targetDir`**：`refreshHooksStatus` 的 `useCallback` deps 缺 `targetDir`，用户输入路径后刷新仍发 `target_dir=null` → 后端报「目标目录不能为空」。已补 deps。
  - **Hooks 自动刷新缺空路径守卫 + 漏 `hooksBusy`**：切到 project 作用域但未填路径即触发刷新 → 错误 banner；操作中切作用域后回来不刷新。已补守卫并纳入 deps。
  - **`handleSwitchView` 读过期 `filterRef`**：`await loadSettings()` 后被动 effect 尚未刷新 `filterRef`，`load()` 用旧 `accountFilter` 查错账号。改为显式传 `accountId`（与 `handleSwitchAccount` 同款修复）。
  - **`onUpdateProgress` 监听器卸载前泄漏**：AboutPanel 的 `listen()` Promise 未 resolve 前卸载 → 监听器永不注销、持续 `setState`。加 `cancelled` 标志（与 App.tsx 同款模式）。
  - **`quarantine-cleared` 事件前端收不到**：#101 的 macOS Gatekeeper 自动清除在 App 启动时 `emit` 事件，但前端此时尚未加载 → 消息永远丢失。改为存入 `AppState.quarantine_notice`（`Mutex<Option<String>>`），新增 `get_quarantine_notice` command 供前端轮询读取（一次性，读取后后端自动清空），App 启动时显示 warn banner（点击关闭）。

- **v0.6.0（2026-09-17）— 修复 Rust 测试随机 disk I/O error（#266）**

  - **#266 测试临时库命名未隔离导致 CI 偶发失败**：`commands.rs` 的测试辅助 `mem_conn()` 把临时库只按 `process::id()` 命名并每次 `remove_file` 两次，Rust 测试同进程内并行执行时所有调用共用同一文件、互相 unlink 对方正在使用的库，初始化 schema 时随机撞 `disk I/O error`（重跑即绿）。`sync.rs:843` 的 `taskboard_headless_test.db` 也是完全固定名，属同一类隐患。详见 [docs/issue-266-test-flake.md](./issue-266-test-flake.md)。
  - **做法**：`mem_conn()` 临时库路径加**每调用递增的 `AtomicUsize` 序号**（`{pid}_{SEQ}`），保证每个连接独享一个文件；连接存活期不再 `remove_file`。`sync.rs` 固定名一并改为带 pid。新增防回归断言 `mem_conn_returns_unique_paths_per_call`（两次调用路径必须不同）。纯测试辅助改动，不涉及任何产品代码 / 公共 API / schema。
  - **验证**：`cargo test --lib -- --test-threads=16` → 102 passed / 0 failed / 3 ignored；连续 4 次 `cargo test --lib` 全绿（含新增断言）。CI `Rust Tests` 连续多次全绿。
  - **追加清理**：`sync.rs` 的 `sync_target_accounts` 测试与 `db.rs` 6 个测试在连接存活期仍调用 `remove_file` / `remove_dir_all`（#266 修 `mem_conn()` 时漏改的同类反模式），本次发版一并清理——统一 `drop(conn)` 后再清理，Windows 下不再 sharing violation 静默失败、Unix 下不再留孤儿 `-wal`/`-shm`。

- **v0.6.0（2026-09-17）— 多账号同步修复（#262）**

  - **#262 多账号同步失效：同步恒覆盖全部账号**：配置 ≥2 个 GitHub 账号后，立即 / 定时 / 启动 / 托盘四条同步路径每轮都只同步激活账号、其余账号永不同步（本机 `sync_logs` 历史从未有一轮覆盖 2 个账号）。根因是同步目标集由 `meta.view_mode` 决定，而 `view_mode` 恒为默认值 `single`——其唯一写入入口（topbar 的 `<select>`）已被 `597840b` 删除，后端 `set_view_mode` / `api.setViewMode` / i18n key 全部残留但无调用方（「有实现、无入口」）。详见 [docs/issue-262-multi-account-sync.md](./issue-262-multi-account-sync.md)。
  - **做法**：采用方案 A——**同步范围与视图模式解耦**，同步不再受 `view_mode` 限制，恒覆盖全部已配置账号（多账号用户核心诉求是「数据都要进本地库」）；抽出 `sync_target_accounts(conn)` 返回全部账号便于回归测试。`view_mode` 仅影响前端展示（单账号 / 聚合全部），并**撤回 `597840b` 的 UI 部分**在 topbar 重新接回「单账号 / 全部账号」切换，消除死代码（`set_view_mode` 的 `#[allow(dead_code)]` 误标注）与死 i18n key。附带修复：账号遍历处 `get_account_pat(...)?` 改为 `match` + 记失败 + `continue`，单账号读 PAT 失败不再中止整轮；`SyncResult` 新增 `accountsSynced` 字段，UI banner 在 ≥2 账号时展示「覆盖 N 个账号」。
  - **无 schema 变更**：`meta.view_mode` / `active_account_id` 继续存在并被消费，仅不再参与同步目标选择；`SyncResult` 为进程内返回结构。
  - **验证**：新增 Rust 回归测试 `sync_target_accounts_covers_all_accounts_regardless_of_view_mode`（写入 `view_mode=single` + 2 账号仍断言返回 2 个目标）；全套 `cargo test --lib` 102 passed、`tsc --noEmit` 0 error、`npm test` 13 文件 136 例、`i18n:check` 中英各 349 key、`prettier --check` ✅、`npm run lint` 18 warning（未超 `--max-warnings 20`）、`check-doc-links.py` ✅。

- **v0.6.0（2026-09-17）— Agent 接入面板：设备扫描（#263）**

  - **#263 刷新升级为设备扫描**：刷新按钮（文案改为「扫描设备」）现在一次点击就探出本机**已安装**与**已卸载**的 agent，直接回答「这台机器上到底装了哪些 agent」。原先 `host_present` 只看配置根目录是否存在（`hooks.rs` 的 `root.is_dir()`），于是 ① 装了 CLI 但从未运行（没有配置目录）的 agent 被误判「未安装」——本机实测 `codex` 在 PATH 上却没有 `~/.codex`；② 后端只有 5 个 `AgentSpec`，其余 34 个 agent 永远落在「手动配置」组，看不出本机装没装；③ 卸载 CLI / 删掉 `.app` 之后只要配置目录残留、或接入文件还在，就完全没有提示。详见 [docs/issue-263-agent-device-scan.md](./issue-263-agent-device-scan.md)。
  - **做法**：三类信号合并探测——PATH 与常见安装目录下的可执行文件、`$HOME` 配置目录、macOS `/Applications` 与 `~/Applications` 的 `.app` 包；按最强信号派生 `cli` / `app` / `config-only` / `none`。新增 `scan_agent_hosts` command 返回全量 39 项探测结果，并与上次快照（`meta.agent_scan_snapshot`，本次唯一写入目标）对比得出「新发现安装 / 疑似已卸载」，首次扫描不报变更（否则首刷会把全部已装 agent 报成新增）。前端把分组规则抽成纯模块 `src/agent-groups.ts`，新增「疑似已卸载」分组（红点，行内给出残留路径 + 复用一键卸载清理）与每行设备徽标（本机已安装 / 已安装应用 / 仅残留配置 / 未检测到；未扫描时不渲染，避免整屏噪音）。`status_one` 新增可选探测参数：正式路径下「装了没跑过的 CLI」归入**可接入**而不再误判「未安装」，单测传 `None` 保持纯配置目录语义（否则断言会依赖开发机 PATH）。
  - **无 schema 变更**：未新增/修改 SQLite 表，只多一个 `meta` 键（键值表天然向后兼容）；老库无该键即按首次扫描处理。扫描本身只读文件系统，不联网、不写任何 agent 配置文件。
  - **验证**：Rust 新增 6 例——含 `HOST_SPECS` 与 `app/src/agents.ts` 的 agent id 集合**双向一致**的防漂移断言（`include_str!` 直接解析前端源文件）、快照 diff 的新装/卸载/重装/首次四种迁移、应用包名大小写不敏感匹配；既有 11 处 `status_one` 调用同步补参，语义不变。前端新增 `src/agent-groups.test.ts` 15 例 + SSR 冒烟 1 例（按钮文案为「扫描设备」且未扫描时不出现设备徽标）。`cargo test` 101 + 21 passed / 0 failed、`tsc --noEmit` 0 error、`npm test` 13 文件 132 例、`npm run build` ✅、`i18n:check` 中英各 347 key、`check-doc-links.py` ✅。真机渲染复核待起 dev server 确认（本机沙箱内无头 Chrome 已不可用）。
  - **#263 追加修正：分组收敛为 4 组**——「未安装」与「手动配置」两个维度（设备 vs 能力）合并为 **未接入**。理由：① 设备装没装这一原本支撑拆分的依据，已由新增的**每行设备徽标**承载；② 两组在本面板内的可操作性完全相同（都没有安装按钮，一个因本机未装、一个因未验证一键接入）；③ 「未安装」组最多 5 个候选、实测常只剩 1 行，组头比内容还吵。信息不丢：行内 detail 让两类**自述**（手动 agent 显示「手动配置：~/.codex/hooks.json」，支持但本机没装的显示「本机未检测到」），组级提示改写为覆盖两种情形的一句话；手动 agent 即使被判「已卸载」也不进「疑似已卸载」组（本面板从未给它装过东西，无残留可清）。顺带修正底部提示原先只看 `newlyRemoved` 导致「有提示却无可清理行」的问题（改为与分组结果同源）。i18n 删 `group.missing` / `group.manual`、加 `group.notIntegrated` / `manualPath` / `notDetected`（中英各 348 key）；`npm test` 13 文件 134 例（含「共 4 组、不得回归出 missing/manual」守卫）。

  - **#265 窗口过窄侧边栏自动收起为纯图标模式**：窗口宽度 `< 900px` 时，左侧 Sidebar 由 200px 的固定文字导航自动收起为 ~56px 的纯图标模式——只保留图标、隐藏文字标签 / 账号名 / 分组标题 / 空态提示，账号项靠 `title` 悬浮提示辨识。详见 [docs/issue-265-sidebar-collapse.md](./issue-265-sidebar-collapse.md)。
  - **做法**：纯响应式、不持久化——`App.tsx` 用 `window.innerWidth < 900` 作初始态并监听 `resize` 驱动 `sidebarCollapsed` 状态；状态值与上次相同（同为 false / true）时 `setState` 为 no-op，不触发多余重渲染；`Sidebar` 据此在 `nav` 上加 `.collapsed` 类。main-content 仍 `flex: 1` 自动占满释放出的空间，主区无需改动。纯前端，SQLite / Rust 零改动。
  - **验证**：`tsc --noEmit` 0 error、`npm run build` ✅、`npm test` 13 文件 136 例（新增 `styles.test.ts` 侧边栏收起静态回归 2 例）、`i18n:check` 中英各 348 key（无新增 key）、`prettier --check` ✅、`check-doc-links.py` ✅。真机渲染复核待起 dev server 确认（沙箱无头 Chrome 不可用）。

- **v0.6.0（2026-09-17）— 左右分栏布局 + Agent 接入面板（#259）**

  - **#259 左右分栏重构**：新增左侧固定 Sidebar（200px）承载全部功能入口——记事本 / 账号列表（点选切换 + 添加账号）/ 设置 / Agent 接入 / 同步日志 / 账号登录 / 底部关于。顶栏从「账号下拉 + 4 按钮 + 同步」精简为「品牌 + 总条数 + 上次同步 + 立即同步」。设置 / 账号 / 同步日志由 Modal 改为**主区内嵌全高页面**（面板组件零侵入，靠 `.panel-page` 容器 + CSS 覆盖）；NotesPanel 改为主区「页面」，选中才渲染。详见 [docs/issue-259-sidebar-nav.md](./issue-259-sidebar-nav.md)。
  - **做法**：`activeModal` 状态废弃，改 `nav`（`notes | board | settings | agents | synclogs | accounts`）+ 独立 `showAbout`（关于保留 Modal）；账号切换复用 `handleSwitchAccount` 并切回看板；新增 `Sidebar.tsx`、`AgentPanel.tsx` 两个组件；`main-layout` CSS 废弃由 `app-shell` + `main-content` 替代。纯前端改动，SQLite / Rust 零改动。
  - **验证**：`tsc --noEmit` 0 error、`npm run build` ✅、`npm test` 12 文件 99 例、`i18n:check` 中英各 334 key、`check-doc-links.py` ✅。真机手动 QA 待补充。

  - **#259 记事本四列布局修正**：真机上四列被压成 ~18px 竖条（文字逐字换行）、面板只占主区左侧 1/4、四列区内部还带横向滚动条；且四列在任何窗口尺寸下都不并排（1180×760 默认 2+2、1440 3+1、900 叠成 4 行）。**根因是两个缺陷叠加**：① `NotesPanel` 给面板挂了行内 `style={{flex:'0 0 25%', width:'25%'}}`（`#202` 拖宽机制遗留），行内样式优先级高于样式表，导致 `.notes-page .notes-panel { flex:1 1 auto; width:100% }` 的「撑满」覆盖**从未生效**（实测面板 245px，比创建列自己的 280px 还窄，四列区只剩 20px ⇒ 横向滚动条）；② 四列是固定 `flex: 0 0 260px` + 容器 `flex-wrap: wrap`，四列需 1076px ⇒ 必然换行。详见 [docs/issue-259-sidebar-nav.md](./issue-259-sidebar-nav.md)（「追加修正：记事本四列并排 + 面板撑满主区」一节）。
  - **做法**：先移除 `#202` 宽度机制（`widthPct` / `clampNotesWidthPct` / `readNotesWidthPct` / `.notes-resizer` / `notes.resizeTitle` / 拖拽与键盘处理），把 `.notes-panel` 直接定义成整页形态（`flex: 1 1 auto` + `min-width/min-height: 0`，删掉 320px 硬锁 / sticky / 50% 上限），从结构上保证行内宽度不会被挂回来；再按看板 `.column` 既有模式改造四列——容器去 `flex-wrap` + `overflow: hidden`，`.note-col` 改 `flex: 1 1 0` + `min-width: 0`，纵向滚动下沉到 `.note-col-body`，窄列用 `.note-card { min-width: 0 }` + `.note-foot { flex-wrap: wrap }` 换行收缩而非裁剪；**收起粒度从整面板改为只收起创建列**（30px `.notes-add-rail` 作四列容器的兄弟节点），空数据时始终渲染四列，创建列 textarea 撑满列高；顺带清理 `.notes-panel.collapsed` / `.notes-rail*` / `.notes-add-col-open` / `.notes-empty*` / `.notes-resizer*` / `.notes-date-list` / `.notes-group*` 死代码与 5 个无用 i18n key（中英各 337），删除随功能失效的 `notes-width.test.tsx`。纯前端，SQLite / Rust 零改动。
  - **验证**：修正后的隔离复现页（补上遗漏的行内样式）复现出面板 `245x617` / 四列区 `20x575`（`scrollLeft=260` 可横滚）/ 四列 `w260@top52 \| w260@top329`；新增回归测试 `app/src/components/notes-layout.test.ts` 12 例（含「面板不得挂行内宽度」「`.notes-panel` 不得回到固定 320px / sticky / 50% 锁」），并**反向验证** 5 类缺陷写法改回后对应 6 条断言全部失败。⚠️ 修复后的**渲染复核未完成**：本机沙箱内 Chrome 无头已无法启动（`sandbox initialization failed`，提权未生效），需在 `npm run tauri dev` 窗口确认。`tsc --noEmit` 0 error、`npm test` 12 文件 105 例、`npm run build` ✅、`i18n:check` 中英各 337 key、`prettier --check` 新增/改动文件 ✅、`check-doc-links.py` ✅。

  - **#259 记事本交互定稿（第三轮）：四列改看板列模式**——四列**固定宽度**且与最左侧创建列同宽（`.notes-panel` 上 `--notes-col-w: 280px`，创建列与 `.note-col` 共用同一变量，改一处即可整体调宽），列放不下时出**有意**的横向滚动条（`.notes-card-cols` 显式 `overflow-x: auto`、不换行），对齐看板任务列的交互；记事卡片**不再用左侧色条**区分优先级（删 `.note-card::before`，`--note-accent` 仅剩底部标签圆点在用）。固定列宽从结构上消除了「容器被压窄 ⇒ 列被压成竖条」这类退化，**取代上一轮**的「等分 + 不滚动」方案。回归测试 13 例并反向验证（一轮注入 5 处缺陷 ⇒ 3 条新断言失败；第一轮注入脚本因 `overflow-x: auto` 片段先命中了文件里另一条规则而「假全绿」，已改为带选择器锚点并断言每处替换命中）。
  - **#259 记事本第四轮：列包围框可见 + 宽窗口不留死空间**——真机发现四列的「包围框」**根本看不见**：`.notes-panel` 与 `.note-col` 同为 `--surface-2`，列和页面底色相同 ⇒ 列融进页面，看起来像卡片悬在空白里（用户标注的「上边距不一致」实为手画框围着不同内容）；且固定 280px 四列在宽窗口下右侧留一大块空白。做法：面板背景改 `var(--bg)`（与看板页面一致 ⇒ surface-2 列的框可见，即看板原样式）；`.note-col` 改 `flex: 1 1 0` + `min-width: var(--notes-col-w)`（宽窗口四列等分**撑满**，窄窗口**不低于 280px**、超出横向滚动——同时满足「列宽比较固定 + 横向滚动」与「宽度与面板一致」）；创建列改与四列**同款包围框**（surface-2 圆角块，去 `border-right`），`.notes-body` 统一 `gap/padding`；`.notes-card-cols` 显式 `align-items: stretch`（列全高，与创建列等高）；空列提示改看板 `.empty` 同款灰字。回归测试 16 例并反向验证（4 处缺陷 ⇒ 4 条新断言失败）。
  - **#259 记事本第五轮：移除整行页头，导入/导出挪进创建列；列头间距统一**——页头（记事本标题 + 计数 + 导入/导出 + 收起）与侧边栏标题重复且白占一行纵向空间，整行删除（`.notes-head*` / `.notes-tools` CSS 一并清理；`.notes-head-icon` 仍被 AgentPanel 复用故保留）；导入/导出与「收起创建列」挪到**创建列顶部工具行**（列收起时随列隐藏）；列头→内容间距统一（列头 `margin-bottom: 2px→0`、列体 `padding-top: 0→8px`，空列提示去独立内边距）——旧值下有记录的列上边距只有 2px，与空列观感不一致；`.notes-body` 内边距对齐看板（`12px 16px 16px`）。回归测试 19 例并反向验证（页头回归 / 工具行挪出创建列 / 间距回退 ⇒ 3 条断言失败；注入锚点须选目标节点自身特征串——`fileInputRef` 首次出现是其声明处，曾导致切错块假通过）。
  - **#259 记事本第六轮：列头高低不一致**——有记录的列（列体内部滚动）的列头比空列高 ~5-7px。像素测量确认五个列框顶边完全对齐、高度一致，唯独可滚动列的列头被滚偏：`overflow: hidden` 的盒子仍是滚动容器，列体滚到头后继续滚动的手势会**链式传导**到列框本身。做法：`.note-col` 追加 `overflow: clip`（只裁剪、不是滚动容器，不支持时回退 hidden），`.note-col-body` 加 `overscroll-behavior: contain`（列体滚到头不向父级链式传导）。回归测试 20 例并反向验证。
  - **#259 记事本第七轮（用户 DevTools 定位）：空列复用看板裸 `.empty` 类，多出 8px 顶部内边距**——记事本空列的列框挂了 `empty` 类，而看板的 `.empty { padding: 8px 4px }` 是全局选择器，直接命中记事本列框 ⇒ 空列列头被顶下 8px，与有记录的列「上边距不一致」。做法：记事本列改用专属类 `note-col--empty`（相关 CSS 同步改名），看板 `.empty` 规则限定作用域为 `.board .empty` 防止再漏。回归测试 21 例并反向验证。
  - **#259 记事本第八轮：四列与看板列视觉统一**——用户要求记事本列改用账号面板（看板）列的样式与宽度，避免两个面板「列演示不统一」。逐条对齐 `.column` / `.column-head` / `.column-body`：列宽改**固定 320px**（与看板一致，窄窗口由列区横向滚动）、列头几何 `margin: 8px 8px 2px / padding: 5px 10px / radius 7px`、列头底色按优先级取**看板同一套浅色**（紧急 `#fde7ec`、高 `amber-bg`、中 `#dbe9fc`、低 `#e6e7ea`）、列头内容改为「圆点 + 标题 + 右侧灰色计数」（原为彩色计数徽章 + 标题内嵌圆点）、列体 `padding: 0 8px 10px / gap 8px`；类名改为 `note-col--<优先级>`；为与看板统一，**取消空列灰化**（看板空列同样显示彩色列头与计数 0）。回归测试 24 例并反向验证（注入 7 处缺陷 ⇒ 5 条断言失败）。
  - **#259 记事本第九轮：列头改为看板状态列写法**——第八轮抄的是看板 **4 状态视图**的浅色胶囊列头（`.column-todo .column-head { background }`），而账号面板列实际用的是**状态列写法**：`.column-status-N { border-top: 3px solid var(--status-N) }`。改为：列顶 3px 状态色横条（`.note-col { border-top: 3px solid var(--col-accent) }`）+ 列头**无底色**（状态色只落在横条与圆点上，标题用默认文字色），列头几何与「圆点 + 标题 + 右侧灰色计数」保持与看板同参。回归测试 24 例并反向验证。
  - **#259 界面文案改名：记事本 → 备忘录**——用户可见的中文文案共 10 条由「记事本 / 记事」改为「备忘录」（侧边栏项、面板标题/导轨、导入导出按钮与提示、优先级分组名、删除确认、加载失败提示等）；英文 locale 保留 `Notes` 命名，代码标识与类名仍为 `notes` / `NotesPanel`（不影响行为）。`i18n:check` 中英 key 数与占位符一致。
  - **#256 检查更新慢且失败原因不可见**：v0.5.0 的「检查更新」是串行的——先等 tauri updater 通道（该通道无内置超时，弱网下 hang 很久），失败后才走 GitHub API fallback，总耗时是加和；且 updater 的失败原因被静默吞掉，用户只看到「很慢才出现的『前往下载』按钮」。实测用户环境：v0.5.0 + macOS Apple Silicon。详见 [docs/issue-256-update-check.md](./issue-256-update-check.md)。
  - **做法**：双通道同时发起、分阶段展示——fallback 先到先显示手动下载（不等慢的 updater），updater 到达后升级为一键更新或附带失败原因；单路超时封顶（fallback 30s / updater 90s）。只改前端（新纯模块 `src/utils/updateCheck.ts` + `AboutPanel`），零新依赖、Rust 零改动。
  - **验证**：新增单测 11 例（`viewFallback` 4 + `viewUpdater` 4 + 超时收敛 3）、`npm test` 12 文件 99 例、`tsc --noEmit` 0 error、`i18n:check` 中英各 305 key。真机复测待含本修复的版本发布后（v0.5.0 旧面板行为改不了，需手动安装一次新版）。

- **v0.5.1（2026-09-15）— 修好既有 CI（#252）+ 未同步 issue 按需拉取（#250）+ 同步日志表格横向滚动（#248）**

  - **#252 `quality-check.yml` 恢复全绿**：#246 引入该 workflow 时留下两类既有失败 —— `Frontend Lint` 的 `format:check` 报 **29 个文件**未格式化（`.prettierrc` 加了但 `npm run format` 从未跑）；`Rust Clippy` / `Rust Tests` 缺 Tauri 的 Linux 系统库（`glib-sys` / `gio-sys` / `gobject-sys` 在 build script 阶段 pkg-config 失败）。两者都已在 `develop` 上红了很久，让每个新 PR 的 CI 都必然红（#249、#251 均被挡）。详见 [docs/issue-252-ci-green.md](./issue-252-ci-green.md)。
  - **做法**：格式化单独一个 commit，并用「构建产物 sha256 逐字节一致」证明零语义影响（比测试通过更强的证据）；系统库**不复制第三遍**，抽成 composite action `.github/actions/install-linux-deps`，`release.yml` 与 `quality-check.yml` 的两个 Rust job 共用同一份清单（`runner.os` 判断放在 action 内部）。
  - **注**：`npm run lint`（ESLint）一直是通过的（`--max-warnings 20` 未触发，实际 17 条 warning），本次未动 ESLint 配置；亦未把 Rust job 挪到 macOS runner（计费约 10 倍，且 release 矩阵已覆盖 Linux）。
  - **验证**：`format:check` 29 → 0、格式化前后产物哈希一致、`tsc --noEmit` 0 error、`npm test` 11 文件 88 例、`npm run lint` exit 0、`i18n:check` 各 302 key、5 个 workflow + action.yml YAML 合法且断言两个 Rust job 均引用该 action。CI 结果以本 PR 运行为准。

  - **#250 消除写状态时的「任务不存在」**：`tasks` 表只由同步单向填充，而 MCP 工具是纯本地 SQL，于是**刚创建、还没同步到的 issue** 会让所有写路径报「任务不存在」（实测：issue 建于 10:26，10:52 调用 `update_task_status` 仍失败）。现在未命中时会**按需拉取该单个 issue** 并落库，再执行原操作；只读 GitHub（单次 `GET`）、不触发全量同步、已存在的任务零额外请求。返回体新增 `pulled` 标记（`get_task_status` 另有 `reason`）。详见 [docs/issue-250-ondemand-issue-pull.md](./issue-250-ondemand-issue-pull.md)。
  - **实现要点**：把同步内联的 upsert 抽成 `db::TaskUpsert` + `db::write_task`（两种模式共用同一份列清单与参数绑定）；按需拉取用 `InsertIfAbsent`（`ON CONFLICT DO NOTHING`）——单 issue REST 拿不到 `project_status` / `mentioned` / `pr_*`，用覆盖模式会把同步刚写好的值清空。拉取必须在写入**之前**（自定义列的校验要读该行 `account_id`）。`parse_issue_ref` 原先会丢掉 owner（拉取需要 owner+repo），已下沉到共用解析器；Rust 侧新增 `on_demand.rs`、`github.rs::fetch_issue`（404 → `Ok(None)`）。
  - **真机发现的两个坑（单测测不到，已补测试固化）**：① 账号匹配必须同时看 `org` 与 `login`——实测 task-dashboard 所属账号 `org` 是**空串**（个人命名空间），只按 org 匹配会让本功能对该仓库完全不可用；② 「API 请求用的 owner」与「落库的 `owner` 列」是两回事（后者与同步一致写 `account.org`），不区分会拼出 `/repos//repo/...`。另外 `repo#N` 不带 owner 时 404 不代表 issue 不存在，错误文案会带上实际查询目标与改写提示。
  - **无 schema 变更**：未改 `tasks` 表结构，无需迁移。
  - **验证**：`cargo test --lib` 93 passed（+11）、`cargo test --test db_test` 21 passed、Clippy 零警告、`python3 -m unittest discover -s mcp_server` 26 passed（新增 `mcp_server/test_server.py`，并接入 `mcp-schema-check.yml`）、`tsc --noEmit` 0 error、`npm test` 10 文件 84 例、`check-mcp-columns.py` 24 列、`check-doc-links.py` ✅。另有**真机端到端验证**（数据库副本 + 真实 PAT）：未同步 issue 写状态返回 `pulled:true`、再次调用 `pulled:false`、落库字段与真实 GitHub 响应一致、失败路径文案带原因（结果见知识库文档）。

  - **#248 两个页签的右侧列被静默裁切**：`.sync-logs-table-wrap` 用 `overflow: hidden`，溢出列被直接裁掉且**不产生任何滚动条**——「同步记录」的错误列、「API 明细」的明细列，恰好是 `#161` / `#235` 新增的交互入口，默认窗口（1180×760）下等于功能不可用。改为 `overflow: auto`；同时把 `.sync-logs-body` 改为纵向 flex 列、容器补 `min-height: 0`，使**横纵滚动条同处一个视口**——只改 `overflow-x` 是不够的，横向滚动条会落在整张表格底部（40 行日志时位于可视区下方 **1029px**），必须先滚到底才够得着。详见 [docs/issue-248-synclogs-hscroll.md](./issue-248-synclogs-hscroll.md)。
  - **验证**：`tsc --noEmit` 0 error、`npm run build` ✅、`npm test` 11 文件 88 例（新增 `src/styles.test.ts` 4 例，且已反向验证——把 `overflow` 改回 `hidden` 即失败）、`i18n:check` 中英各 302 key、`check-doc-links.py` ✅。为让测试读到真实 CSS 文本，`vitest.config.ts` 开启 `css: true`（默认 `css: false` 会把 CSS 打桩成空串）并新增 `src/vite-env.d.ts` 提供 `?raw` 类型——**零新增依赖**，改用 Vite `?raw` 而非 `node:fs`（后者需要 `@types/node`，本仓库未安装，CI 会报 TS2307）。

- **v0.5.0（2026-09-13）— macOS 免重复放行 + 应用内自动更新（#231/#232）+ 应用内 API 调用明细（#235）+ 看板卡片调整（#237）+ 文档完整性（#239）**

  - **#231/#232 macOS 更新免除重复 Gatekeeper 放行 + 应用内自动更新**：根因是 ad-hoc 签名（`signingIdentity="-"`）的 designated requirement 直接绑定 `cdhash`，**每次构建都会变**，系统因此把每个新版本视为从未批准过的全新应用，放行记录永远命中不了。改为用**固定自签名证书**签名让 DR 恒定（首次放行后长期复用），并接入 `tauri-plugin-updater` 走应用内更新——更新包由**应用自身进程**下载，产物天然不带 `com.apple.quarantine`，Gatekeeper 完全不参与。同时修掉 #101 隔离标记自清长期空转：标记落在 **bundle 根目录**，原实现只清 `current_exe()`，`xattr -dr` 不向上越级，故 `has_quarantine(exe)` 恒为 false 提前返回；现同时清理 bundle 根与可执行文件。新增 `check_app_update` / `install_app_update` / `restart_app` 命令与 `taskboard://update-progress` 事件；About 页「检查更新」优先走应用内更新，失败**静默回退**为原版本号对比 + 跳转下载。详见 [docs/issue-231-macos-gatekeeper-update.md](./issue-231-macos-gatekeeper-update.md)。
  - **#235 请求/返回参数落盘 + 应用内可查**：新增 `api_logs` 表（`kind` / `method` / `target` / `status` / `ok` / `elapsed_ms` / `request` / `response`），把同步、领取任务（`claim_issue`）、更新状态（`set_project_status`）三路 GitHub API 调用的**请求参数与返回参数**落盘。同步日志面板改为**双页签**（「同步记录」/「API 明细」），明细页签支持按类型筛选、逐行展开查看请求与返回。承接 [#228](./issue-228-api-logging.md) 的 stderr 埋点（默认静默、终端可见），补齐「落盘 + UI 可视化」。详见 [docs/issue-235-in-app-api-log.md](./issue-235-in-app-api-log.md)。
  - **#235 实现要点**：`GitHubClient` 采用可选 sink（`new_with_sink`，`new` 保持原签名走 `None`），既有调用点零改动；drain 放在 `sync_account` 包装层，保证 `sync_account_inner` 内 `?` 提前返回的**失败路径也落盘**；`ApiLogEntry.ok` 独立于状态码（GraphQL 可 HTTP 200 带 `errors`）；请求/返回按字符截断（400/600）存摘要，保留 7 天 / 上限 2000 行；绝不写入 PAT。
  - **#237 移除账号行 / 新增创建人行 / 加大 repo#编号 字号**：卡片第一行的「归属账号」徽章（`@liushizhao2025`）整行移除——单账号视图下每张卡片都一样，无信息量；改为展示 issue **创建人**，位置在「分配人」**上一行**；`repo #编号`（如 `fad-backend #1198`）行字号 11px → **13px**，成为扫视整列时的视觉锚点。详见 [docs/issue-237-card-creator-row.md](./issue-237-card-creator-row.md)。
  - **#237 实现要点**：`tasks` 表新增 `author` 列（Search API `user.login` + GraphQL `author { login }` 两路取值，缺失即空串不阻断同步）；前端创建人空/纯空白时**不渲染该行**，不留空标签行；`accountLabel` / `accounts` 死 prop 链（TaskCard → Board → App）一并清理，`card.accountTitle` i18n key 删除、新增 `card.creatorLabel`。**迁移要点**：`author` 的 `ALTER TABLE` 必须放在 `migrate_tasks_v2_rebuild` **之后**的热路径——v2 物理重建的列白名单是写死的，不含后增列，放前面会被重建丢掉（#175 同款陷阱）。
  - **#239 文档完整性修复**：一次性修掉 7 类共 24+ 处缺陷——3 篇**被引用却从未创建**的文档（`issue-118-*` / `issue-119-*` / `perf-audit-optimization.md`，其中前两篇违反 §2.4「每功能必建 KB 文档」）已据实补写；15 处 `file:///Users/<家目录>/...` 绝对路径与 4 处相对路径深度错误改为 `../app/...`；5 处已漂移到无关代码的 `#Lxxx` 行号锚点删除。同时对 CHANGELOG 本身勘误与补录：v0.3.48 的 #119 条目原写「新增 zip 格式」失实（`zip` 并非 Tauri 2 有效 bundle 类型，当日已回滚），v0.3.50 条目补录原先缺记的 13 个 issue，并说明 **`v0.3.49` 是幽灵版本号**（从未打 tag、从未发布）。新增 `scripts/check-doc-links.py` + CI 防回归。详见 [docs/issue-239-doc-integrity.md](./issue-239-doc-integrity.md)。
  - **部署前置（一次性）**：#231 需在本机用「钥匙串访问 → 证书助理」创建名为 **`TaskBoard Local Signing`** 的自签名代码签名证书（身份类型「代码签名」，建议 3650 天），CI 通过 `APPLE_SIGNING_IDENTITY` 覆盖；`tauri.conf.json` 保留 `signingIdentity="-"` 使**没有证书的本地开发机不会构建失败**。首次发版还需生成 updater 的 minisign 密钥对并配置 `latest.json`。
  - **schema 变更**：新增 `api_logs` 表 + 两个索引（#235，新表走 `CREATE TABLE IF NOT EXISTS` 幂等，老库启动自动建表）；`tasks` 新增 `author TEXT NOT NULL DEFAULT ''`（#237，热路径幂等 ALTER，覆盖全部 `user_version`）。**无破坏性变更**，老库自动迁移。
  - **验证**：`cargo test --lib` 80 passed、`cargo test --test db_test` 21 passed（+2）、`tsc --noEmit` 0 error、`npm run build` ✅、`npm test` 10 文件 84 例（+5）、`i18n:check` 中英各 302 key、`check-mcp-columns.py` 24 列一致、`check-doc-links.py` 116 文件无缺陷。

- **v0.4.0（2026-09-12）— GitHub 写回反转（#214 认领 + #215 状态）+ 记事本宽度 + 详情重做**

  - **写回反转（产品约束变更）**：`AGENTS.md §2.1` / `PRD.md` 从"只读 GitHub"放宽为"默认读 + 用户确认的显式写回"；同步路径本身仍只读，MCP 工具保持只写本地。PAT 需配套升级写权限（classic `repo` + `project`；Device Flow scope 已补 `project`，老 token 需重授权）。
  - **#214 卡片认领**：点"无人认领"→ 确认框 → `POST assignees` 设自己为 assignee，本地乐观更新；owner 为空时从 URL 反推；全链路日志。详见 [docs/issue-214-claim-assignee.md](./issue-214-claim-assignee.md)。
  - **#215 详情 Project 状态写回**：同步补存 item/field/option 三件套（`projects.status_field_id`、`project_statuses.option_id`、`project_items` 新表，老库迁移）；`set_project_status`（缺 ID 即时补拉、closed 拒绝、乐观更新走同步同一决策）；详情 GitHub 状态行可点 + 确认框。详见 [docs/issue-215-proj-status-write.md](./issue-215-proj-status-write.md)。
  - **#196/#200 详情重做**：状态区永远按 `project.status` 展示与默认选中（#196）；宽度 460px→50%，去掉四态按钮，行间距 +1px（#200）。详见 [docs/issue-196-detail-project-status.md](./issue-196-detail-project-status.md) 与 [docs/issue-200-detail-width.md](./issue-200-detail-width.md)。
  - **#202/#209 记事本宽度可调**：右缘拖拽 + 键盘 ±1%，按主区百分比（25%–50%，默认 25%），localStorage 持久化；拖动中 DOM 直写 + rAF 合并；`main-layout` grid 改 flex row。详见 [docs/issue-202-notes-width.md](./issue-202-notes-width.md) 与 [docs/issue-209-notes-min-width.md](./issue-209-notes-min-width.md)。
  - **#190 hooks 备份**：安装覆盖/卸载摘除改动前必备份（此前项目级 opencode 备份的是改后文件）。详见 [docs/issue-190-hooks-backup.md](./issue-190-hooks-backup.md)。
  - **#191/#204 opencode 自动执行**：失败看两路结果、成功后才去重、`processed` 不回退（#191）；改按当前消息判定，单窗口多任务可依次执行（#204）。
  - **#206 取消启动自动接入**：全部走手动一键安装；开发版安装给时效提醒。详见 [docs/issue-206-no-auto-enroll.md](./issue-206-no-auto-enroll.md)。
  - **#192 Label 优先**：显式 label→todo 优先于 gh_status（owner 已确认）。详见 [docs/issue-192-label-todo-priority.md](./issue-192-label-todo-priority.md)。
  - **#193/#207/#224/#228 小项**：开发版跳过自动注册 + `workBranch` 贯通详情（#193）；agent 四分组下拉（#207）；同步日志账号列（#224）；同步与写回请求/返回日志（#228）。
  - **修复**：#197 卡片 session 独立行；#212 死代码 warning 清零；#216 仅剩单账号可删；#220 指纹纳入 projectStatus（写回即时刷新）；#221 切换账号请求合并（不再滞留旧账号）。
  - **schema 变更**：`projects.status_field_id`、`project_statuses.option_id`、`project_items` 新表（新库 SCHEMA + 老库迁移双写）。
  - **验证**：`cargo test`（lib 72 例 + db_test 19 例）零 warning、`tsc --noEmit`、`vitest` 10 文件 54 例、`i18n:check` 279 key 一致、`check-mcp-columns.py` 24 列一致。

- **v0.3.55（2026-09-11）— 跨 agent 看板 hooks（#177）+ 同步筛选提示（#178）+ 外部写入自动刷新（#181）+ 看板列模式精简（#108）**

  - **#177 跨 agent 看板 hooks 与一键安装/卸载**：新增项目级 `.claude/`（commands `/task-start` `/task-done` /hooks）与 `.opencode/` 插件，开始处理 issue 时一次完成「处理中 + session_id/session_agent + work_branch」三写入，结束时清 session；`AGENT_INSTRUCTIONS.md` 明确触发时机，根治"只靠 prompt 约定易遗忘"。详见 [docs/issue-177-claude-session-hooks.md](./issue-177-claude-session-hooks.md)。
  - **#177 后续 opencode 自动执行与全局 MCP 自动合并**：`.opencode/plugins/taskboard.js` 事件 hook 从用户消息自动提取唯一 issue 引用并直调本地 `taskboard mcp`（`get_task_status` + 置处理中 + `record_session`，多引用回退手动）；`hooks.rs::merge_global_opencode_mcp` 按 `opencode.jsonc > opencode.json > config.json` 首个生效文件自动合并全局 MCP 配置（JSONC 注释保留，他人条目保留）。详见 [docs/issue-177-claude-session-hooks.md](./issue-177-claude-session-hooks.md)。
  - **#178 同步后被筛选隐藏任务的提示与一键清除**：同步前后按 `issueKey → updatedAt` 快照 diff，精确算出"本次新变且被当前筛选藏住"的任务数，藏住才出琥珀色横幅 + 数量 + 一键清除筛选；无筛选时恒不打扰。新增可单测纯函数模块 `syncHint.ts`（8 例）。详见 [docs/issue-178-sync-filter-hint.md](./issue-178-sync-filter-hint.md)。
  - **#181 外部写入后自动刷新任务列表**：前端窗口聚焦/`visibilitychange` 即时重查 + 20s 轮询兜底（后台隐藏跳过，`loadingRef` 防重入）；`taskSig.ts` 指纹覆盖本地写入字段（不能只看 `updated_at`，本地写库不更新它），无变化不重渲染；后端 `update_task_status` / `record_session` / `clear_session` / `record_handoff` 成功后 emit 新事件 `taskboard://tasks-changed`（多窗口正确性）。MCP 协议与 DB schema 无变化。详见 [docs/issue-181-auto-refresh.md](./issue-181-auto-refresh.md)。
  - **#108 看板列模式精简**：设置页「看板列模式」去掉「四态列」选项，仅保留「Project 状态列」和「自定义列」；`boardModeProject` 文案缩短；历史 `status` 值在 Board 渲染层降级为 `project`，零 schema 变更；设置 modal 宽度 460px→520px。详见 [docs/issue-108-simplify-board-mode.md](./issue-108-simplify-board-mode.md)。
  - **仓库改名与全量 bug 排查**：远程仓库改名 `task-dashboard`，同步全部引用（含 About 页链接 typo）；新增 [docs/bug-audit-2026-09.md](./bug-audit-2026-09.md)（13 条问题 + 3 条存疑 + 2 条误报排除，只出清单未改源码）。
  - **CI**：Intel 构建改用 `macos-latest` 交叉编译，解决 `macos-13` runner 排队问题。
  - **无 schema 变更**。验证：`npm test` 7 文件 36 例通过、`tsc --noEmit` 通过、`i18n:check` 273 key 一致、`check-mcp-columns.py` 24 列一致。

- **v0.3.54（2026-09-09）— Rust 内置 MCP 读路径字段错位修复（#173）**

  - **#173 `row_to_value` 位置索引未同步 24 列 `SELECT_COLS`**：#155 重建 `tasks` 表并插入 `url` / `issue_state` / `project_status` / `pr_number` 等列、#169/#171 把 `SELECT_COLS` 扩成 24 列后，`mcp.rs::row_to_value` 仍按老的精简列序用位置 `get(0..10)` 取值，导致内置 MCP 的 `list_my_tasks` / `get_task_status` 返回字段**几乎全部错位**（`repo` 填 owner、`number` 填 repo 字符串、`status` 填 title……）。`check-mcp-columns.py` 只比两侧 `SELECT_COLS` 字符串、管不了「位置 → 列名」映射，故 CI 一直绿而功能坏。现已重写 `row_to_value` 严格按 24 列顺序逐一映射（含 `work_branch` / `updated_at` 等），语义与 Python 侧 `dict(row)` 对齐。
  - **#173 回归测试**：新增 2 个 Rust 单测（`list_my_tasks_returns_correct_column_values` / `get_task_status_returns_correct_column_values`），在内存库建含全部被选列的 `tasks` 表、每列填可辨识值，逐字段断言返回正确。lib 测试 34→36 例。
  - **#175 `work_branch` 迁移补漏**：`work_branch` 的 ALTER 只挂在 `migrate_legacy_alters`（user_version<1），使 `user_version=2`（#155 已 v2 重建）的旧库永不补列、`SELECT_COLS` 一查就 `no such column`。现将该 ALTER 提升到 `open_db` 每次建连都跑的幂等热路径（已存在则忽略），对所有 user_version 一致生效。新增 db_test（18→19）验证。
  - **无 schema 变更（仅数据迁移补齐）、零接口变更**。详见 [docs/issue-173-mcp-read-row-to-value.md](./issue-173-mcp-read-row-to-value.md) 与 [docs/issue-175-work-branch-migration-gap.md](./issue-175-work-branch-migration-gap.md)。

- **v0.3.53（2026-09-09）— Python MCP 与列名重构脱节修复（#169）+ record_session 记录工作分支（#171）**

  - **#169 Python MCP 读路径修复**：#155 把 `tasks.key` 改名 `issue_key` 后 `mcp_server/server.py` 没跟上，`SELECT_COLS` 与 `tool_get_task_status` 仍写 `key`，`list_my_tasks` / `get_task_status` 必然报 `no such column: key`。现已统一两侧 `SELECT_COLS`（补齐 `url` / `issue_state` / `project_status` / `pr_number` 等 #155 后的新列，共 23 列），返回字段 `key` → `issue_key`。详见 [docs/issue-169-mcp-server-schema-sync.md](./issue-169-mcp-server-schema-sync.md)。
  - **#169 写入丢失修复**：四个写任务工具没有 `commit()`，sqlite3 默认事务下进程退出即回滚，写入全丢。连接改为 `isolation_level=None` 自动提交——比在 11 个工具出口各写一次 commit 更难漏。详见 [docs/issue-169-mcp-server-schema-sync.md](./issue-169-mcp-server-schema-sync.md)。
  - **#169 列名一致性防回归**：新增零依赖 `scripts/check-mcp-columns.py` + CI `mcp-schema-check`，以 `db.rs::SCHEMA` 为唯一事实来源，校验 `server.py` 与 `mcp.rs` 的列名真实存在且逐列一致。详见 [docs/issue-169-mcp-server-schema-sync.md](./issue-169-mcp-server-schema-sync.md)。
  - **#171 `record_session` 新增 `branch` 参数**：开始处理 issue 时即可一并记录当前工作分支，写入独立 **`work_branch`** 列（非空才写）。复用公共 `common::touch_session`（Rust）与 `server.py`（Python）条件更新，两侧行为一致；`SELECT_COLS` 同步补入 `work_branch`（共 24 列）。
  - **#171 `branch` 回归 PR 专用**：`sync.rs` 中该 issue 无关联 PR 时仍清空 `branch`（PR head.ref 原逻辑不回归）；`work_branch` 不在同步 upsert 列中，**同步不覆盖 Agent 工作分支**，两者职责分离。
  - **#171 触发时机提前**：`AGENT_INSTRUCTIONS.md` 明确「开始处理」即 `record_session`（含 `git branch --show-current` 取的分支）。
  - **#171 schema 变更**：`tasks` 新增 `work_branch TEXT NOT NULL DEFAULT ''`（新库 SCHEMA + 老库 ALTER + v2 重建同步迁移）。
  - **验证**：`cargo test`（lib 34 例 + db_test 18 例）、`cargo check` 通过。详见 [docs/issue-171-record-session-branch.md](./issue-171-record-session-branch.md)。

- **v0.3.52（2026-09-08）— 设置面板假死修复（#167）**

  - **#167 同步/诊断期间点击设置假死**：`diagnose_project_status` / `test_pat` / `test_account_pat` / `save_pat` / `add_account` / `update_account` 六个命令原为同步命令，内含 GitHub 网络 I/O，在 Tauri 主线程执行期间阻塞事件循环 → macOS beachball 假死。统一改为 `async + spawn_blocking`（与 v0.3.7 `sync_now` 同款模式），网络重活放工作线程池，主线程仅快速取 DB 数据后立即返回。纯 SQL 配置命令不受影响，同步用独立连接 + WAL 不阻塞读者。零接口变更、零前端改动。详见 [docs/issue-167-async-net-commands.md](./issue-167-async-net-commands.md)。

- **v0.3.51（2026-09-08）— 前端修复三连（#159 #160 #161）**

  - **#159 自定义列空配置回退 project 列**：账号未配置自定义列时选择「自定义列」展示，不再误导性回退到四态列，改为回退到 project.status 状态列。详见 [docs/issue-159-160-161-frontend-bugs.md](./issue-159-160-161-frontend-bugs.md)。
  - **#160 应用内确认弹窗替代 window.confirm**：Tauri WebView 原生不支持 `window.confirm`（静默返回 false），「清理全部日志」「删除账号」的二次确认改为应用内 ConfirmDialog 弹窗，根治点了没反应。详见 [docs/issue-159-160-161-frontend-bugs.md](./issue-159-160-161-frontend-bugs.md)。
  - **#161 同步日志错误信息可展开**：错误单元格默认单行截断，hover 有全文 tooltip，点击展开/收起完整错误信息。详见 [docs/issue-159-160-161-frontend-bugs.md](./issue-159-160-161-frontend-bugs.md)。
  - **#163 前端测试补充**：新增 3 个测试文件 18 个用例（合计 21 例），零依赖覆盖 #159/#160/#161 修复逻辑，为可测性抽出 `resolveBoardView` 等 4 个纯函数。详见 [docs/issue-163-frontend-tests.md](./issue-163-frontend-tests.md)。
  - **#165 custom 视图未匹配值提示**：未标注列展示未映射的 `project_status` 值（去重 + 计数，hover 看全），帮助用户快速定位漏配/错配的自定义列。详见 [docs/issue-165-unmapped-hint.md](./issue-165-unmapped-hint.md)。

- **v0.3.50（2026-09-08）— 性能 / 安全优化批次 + 同步日志与自定义列改进 + tasks 表物理重建（#133 #134 #135 #137 #138 #143–#150 #155）**
  - ℹ️ **版本号说明**：本版本实际承载了「原计划的 v0.3.49」内容——**`v0.3.49` 版本号被跳过，从未打 tag、从未发布**（tag 序列 `v0.3.48` → `v0.3.50`）。因此源码中约 50 处标注为 `v0.3.49 (#143)` 之类的注释，所指即本版本 v0.3.50；代码注释不作订正以免污染 `git blame`。本条目的 #133–#150 部分为**事后补录**（原先只记了 #155），依据 `git log v0.3.48..v0.3.50` 与各 issue 补写。详见 [#239](https://github.com/ShawnLiuSZ/task-dashboard/issues/239)。
  - **性能 / 安全优化批次（8 个 issue）**，批次索引见 [docs/perf-audit-optimization.md](./perf-audit-optimization.md)：
    - **P0-1 #143 同步链路并发化**：5 个 Search 源 + Project 拉取并行，去掉固定 `sleep`；新增共享 Search 限流门。详见 [docs/issue-143-147-sync-concurrency.md](./issue-143-147-sync-concurrency.md)。
    - **P0-2 #144 同步链路 N+1 消除 + 整段事务化写入**：预加载替代任务循环内的逐条查询，N 次 autocommit 合并为 1 次 commit。详见 [docs/issue-144-146-sync-db.md](./issue-144-146-sync-db.md)。
    - **P0-3 #145 前端并行加载**：`Promise.all` 并行 + `Board`/`TaskCard` `memo` + 搜索防抖。详见 [docs/issue-145-148-150-frontend.md](./issue-145-148-150-frontend.md)。
    - **P1-1 #146 热查询索引补齐**：`label_mappings` 复合索引 / `tasks` 看板复合索引 / `notes` 内容唯一索引 / prune 索引。详见 [docs/issue-144-146-sync-db.md](./issue-144-146-sync-db.md)。
    - **P1-2 #147 建连版本化迁移**：引入 `PRAGMA user_version` 版本化迁移 + 抽取 `common.rs` + `import_notes` 事务化。**这是后续所有列迁移机制的前置**（见 [docs/issue-237-card-creator-row.md](./issue-237-card-creator-row.md)「决策 5」）。详见 [docs/issue-143-147-sync-concurrency.md](./issue-143-147-sync-concurrency.md)。
    - **P1-3 #148 类型 / 拼写修复**：清零 i18n `any`、`SyncLogsPanel`/`NotesPanel` 补 i18n、`check_update` URL 修正。详见 [docs/issue-145-148-150-frontend.md](./issue-145-148-150-frontend.md)。
    - **P2-1 #149 安全加固**：PAT 入 Keychain、CSP 最小策略 + 外链白名单、跨平台 `open_in_browser`、DB 文件权限 0600、日志门控。详见 [docs/issue-149-security-hardening.md](./issue-149-security-hardening.md)。
    - **P2-2 #150 可访问性 a11y + CSS 收敛**：`TaskCard` 键盘可达、modal `role` / 焦点陷阱、对比度提升。详见 [docs/issue-145-148-150-frontend.md](./issue-145-148-150-frontend.md)。
  - **#133 自定义列视图补 `gh_status` 徽章**：切到自定义列显示后卡片不再展示 `project.status`，补正确类名、无列配置时也显示，并在保存列配置时自动置 `boardMode=custom`。详见 [docs/issue-133-custom-col-status-badge.md](./issue-133-custom-col-status-badge.md)。
  - **#134 同步日志保留期 7 天 → 30 天 + 「清理全部日志」**：新增全量清理按钮（二次确认）。详见 [docs/issue-134-sync-logs-cleanup.md](./issue-134-sync-logs-cleanup.md)。
  - **#135 同步日志区分触发类型**：新增 `auto` / `manual` / `startup` 三态，「触发」列不再一律显示「自动」。详见 [docs/issue-135-sync-trigger-type.md](./issue-135-sync-trigger-type.md)。
  - **#137 跳过已关闭 issue 的逐条 `fetch_state`**：改为批量标记 `candidate_done`，省 GitHub API 调用。详见 [docs/issue-137-skip-fetch-state.md](./issue-137-skip-fetch-state.md)。
  - **#138 自定义列映射改为平铺账号布局**：账号维度不再用下拉切换，平铺列出所有账号各自独立配置。详见 [docs/issue-138-flat-account-config.md](./issue-138-flat-account-config.md)。
  - **#155 tasks 表物理重建**：字段命名彻底理清——`key→issue_key`（业务引用，新增）、自增 `id` 主键 + `UNIQUE(repo, number, account_id)` 解决多账号互相覆盖、`gh_state→issue_state`、`gh_status→project_status`（与本地四态 `status` 语义分离）、`updated_at` 由 TEXT 统一为 INTEGER 秒。基于 `PRAGMA user_version` 版本化迁移 + `key` 列幂等判定，老库自动重建、数据完整迁移。详见 [docs/issue-155-tasks-schema-rebuild.md](./issue-155-tasks-schema-rebuild.md)。

- **v0.3.48（2026-09-07）— 扩展平台支持与 CI 优化（#118 #119 #120 #121 #122）**

  - **#118 扩展平台支持**：GitHub Actions release 工作流新增 macOS ARM/x64、Windows ARM64 双架构构建支持。详见 [docs/issue-118-expand-platform-support.md](./issue-118-expand-platform-support.md)。
  - **#119 扩展 Release 打包矩阵**：补齐 arm64 全平台、rpm 与 msi 格式。macOS/Windows/Linux 均支持双架构。详见 [docs/issue-119-expand-release-matrix.md](./issue-119-expand-release-matrix.md)。<br>⚠️ **勘误（2026-09-13 补注，[#239](https://github.com/ShawnLiuSZ/task-dashboard/issues/239)）**：本条原写「新增 zip/msi/rpm 格式」，其中 **`zip` 当日即被回滚**——Tauri 2 的 `--bundles` 只接受 app/dmg/nsis/msi/deb/rpm/appimage，`zip` 不是有效类型（提交 `18049ec`）。便携 zip 未曾交付，勿再尝试该写法。
  - **#120 CI 弃用警告修复**：升级 GitHub Actions（checkout@v5、setup-node@v5、tauri-action@v2），Node.js 版本升级到 22 LTS，消除弃用警告。详见 [docs/issue-120-upgrade-ci-actions.md](./issue-120-upgrade-ci-actions.md)。
  - **#121 关于页删除专属话术**：移除 AboutPanel 中 WorkBuddy/claude-code 专属性 agent 接入话术，收敛为通用说明。详见 [docs/issue-121-remove-workbuddy-text.md](./issue-121-remove-workbuddy-text.md)。
  - **#122 数据库路径全平台标注**：README 与 Rust 注释覆盖 Windows/Linux/macOS 三平台数据库路径。详见 [docs/issue-122-db-path-docs.md](./issue-122-db-path-docs.md)。

- **v0.3.47（2026-09-07）— MCP stdio 分帧格式修复（#115）**

  - **#115 MCP stdio 分帧格式修复**：`read_message` 改为双格式自动识别——首字节 `{` 走 NDJSON（MCP 规范），否则走 Content-Length 头（LSP 历史兼容）；`write_message` 回以与请求相同的分帧格式。根治 Claude Code / Cursor 等标准 MCP 客户端连接时 `connection timed out after 30000ms`。失败路径新增 stderr 诊断输出。Rust + Python 两份实现同步修改。详见 [docs/mcp-stdio-framing-ndjson.md](./mcp-stdio-framing-ndjson.md)。

- **v0.3.46（2026-09-07）— 设置页看板列模式精简（#108）+ MCP 接入文档完善（#109）**

  - **#108 看板列模式精简**：移除下拉菜单中的「四态列」选项，仅保留「Project 状态列」和「自定义列」两项；`boardModeProject` 文案精简为「Project 状态列」；历史 `boardMode="status"` 账号在 Board.tsx 渲染层优雅降级为 `project`，零 schema 变更。设置页 modal 宽度从 460px 调整为 520px。详见 [docs/issue-108-simplify-board-mode.md](./issue-108-simplify-board-mode.md)。
  - **#109 MCP 全平台文档**：AboutPanel 通过 `navigator.userAgent` 检测当前平台，动态生成 macOS / Windows / Linux 对应 command 路径的 MCP snippet；README 新增三平台路径表格，收敛为单个 agent 完整配置示例。详见 [docs/issue-109-mcp-platform-docs.md](./issue-109-mcp-platform-docs.md)。

- **v0.3.45（2026-09-07）— 记事导出默认写入设备下载目录（#103）**

  - **#103 导出默认下载目录**：`export_notes` 新增可选 `target_dir`；未传时经 `dirs::download_dir()` 落到系统真实下载目录（macOS `~/Downloads` / Windows `%USERPROFILE%\Downloads` / Linux `$XDG_DOWNLOAD_DIR`），取不到/不可写时回退应用数据目录 `notes-backup/`。新增 `resolve_export_dir` 做优先级 + 可写校验。**零新依赖**（`dirs` 已在用）。前端导出成功提示本就展示完整 `path`。详见 [docs/issue-103-notes-export-download.md](./issue-103-notes-export-download.md)。
  - **验证**：`cargo check`；新增单测 `resolve_export_dir_prefers_target_then_download`（合 26 例）。

- **v0.3.44（2026-09-07）— 首启自动清除 Gatekeeper 隔离标记，MCP 免 sudo 开箱即用（#101）**

  - **#101 自动清除自身 quarantine**：macOS 首次启动在 `setup()` 用 `xattr` 检测主二进制（`taskboard mcp`）是否带 `com.apple.quarantine`，存在即 `xattr -dr` 递归清除（当前用户拥有自身 bundle，**无需 sudo**）。GUI 放行一次后自动清理，此后 MCP 客户端 spawn 不再触发 Gatekeeper 慢评估，根治「MCP 连接 30s 超时」。详见 [docs/issue-101-quarantine-autoclear.md](./issue-101-quarantine-autoclear.md)。
  - **验证**：`cargo check`（macOS）通过；验收为多机手动（清除后 `xattr -l` 无 quarantine 标记、MCP 工具可发现可调用）。

- **v0.3.43（2026-09-07）— 看板列展示方式改为每账号配置（#99）**

  - **#99 每账号列展示方式**：移除顶栏展示方式切换下拉；在设置面板「自定义列」tab 按账号独立选择 status/project/custom（存 `meta` 的 `board_mode:<id>`，未配置默认 project）。切换账号后看板按该账号模式展示。自定义列视图下任务卡片右上角显示 `project.status` 彩色徽章（复用 20 色系，同状态同色）。
  - **接口**：移除全局 `set_board_mode` 命令与 `Settings.board_mode` 字段；新增 `set_account_board_mode(account_id, mode)`；`accounts[]` 新增 `boardMode`。同步 `sync::run` 逐账号读取模式（仅该账号自己为 custom 才写 `col_key`）。零表结构变更、复用 `meta` 键值表。
  - **验证**：`cargo test --lib`（新增 `account_board_mode_defaults_and_validates`，合计 24 例）、`npm run i18n:check`（zh/en 各 179 key）、`npx tsc --noEmit`、`npm test` 通过。详见 [docs/issue-99-board-mode-per-account.md](./issue-99-board-mode-per-account.md)。

- **v0.3.42（2026-09-07）— 自定义列映射去重（#98）**

  - **#98 新建列时已使用 status 置灰去重**：设置面板「自定义列」新建/编辑列时，已被**其它列**选用的 Project status 置灰且不可再次选中（`usedElsewhere` 由 `columns` + `editingCol` 实时派生；`toggleRule` 兜底拦截，覆盖自由输入路径）；正在编辑的列自身占用项保留可选，删除列后其占用项自动恢复可选。纯前端改动、零后端/schema 变更。新增 i18n key `settings.customColumns.usedElsewhere`。
  - **验证**：`npm run i18n:check`（zh/en 各 178 key）、`npx tsc --noEmit`、`npm test`（3 例）通过。详见 [docs/issue-98-dedup-col-status.md](./issue-98-dedup-col-status.md)。

- **v0.3.41（2026-09-07）— 首次启动 UI 卡死转圈修复（#97）**

  - **#97 设置 / 关于 / 账号 / 同步日志 面板卡死**：根因是启动同步把整段 **GitHub 网络 I/O** 包在共享 `AppState.db` 的 `Mutex<Connection>` 里长持有，导致这些面板触发的读命令（同步非 async，跑在主线程）排队等锁 → macOS beachball、鼠标卡死转圈。修复：`run_sync` / `sync_now` 改用**独立 DB 连接**（`open_sync_conn`，复用 WAL + `busy_timeout`），同步不再占用共享锁，UI 随到随取。零新依赖、零 schema 变更、对外接口不变。
  - **验证**：`cargo check`、`cargo test --lib`（23 例）通过。详见 [docs/issue-97-ui-freeze.md](./issue-97-ui-freeze.md)。

- **v0.3.40（2026-09-07）— 设置面板 tab 化 + 自定义列映射下拉配置（#95）**

  - **#95 自定义列 Project status 映射配置**：设置面板改为 **tab 切换（基础设置 / 自定义列映射 / 诊断）**，自定义列配置独立成页、标题栏加关闭按钮。自定义列编辑移除「列标识(colKey)」概念 —— col_key 由系统自动生成，**用户只需填列显示名称 + 下选匹配的 Project status（下拉多选 chips + 自由输入）**，保存写 `matchRules` JSON 数组，后端逻辑与存储零改动、向后兼容。详见 [docs/issue-95-status-mapping-dropdown.md](./issue-95-status-mapping-dropdown.md)。

- **v0.3.39（2026-09-07）— 审计清理收尾（#72 #73 #80）**

  - **#72 看板模式下拉补 status 选项**：核验确认 `status / project / custom` 三个选项均已存在（v0.3.29 #64 一并补齐），无需代码改动，关闭 issue。

  - **#73 MCP serverInfo 版本注入**：`mcp.rs` 删除硬编码 `SERVER_VERSION = "0.3.24"`，改用 `env!("CARGO_PKG_VERSION")`，与发版三处版本保持单点一致，避免 serverInfo 版本落后。文档合规收尾——为孤岛 KB 恢复 CHANGELOG 引用：补建 [docs/issue-55-update-check.md](./issue-55-update-check.md)，并在本条目引用 [docs/issue-54-auth-account-refresh.md](./issue-54-auth-account-refresh.md)、[docs/issue-55-update-check.md](./issue-55-update-check.md)、[docs/issue-56-project-status-order.md](./issue-56-project-status-order.md)。

  - **#80 清理 i18n 死 key**（共 21 个）：移除已不存在的「Label 状态映射」「Label 列顺序」两套 UI 的残留 key（`settings.labelMapping.*`、`settings.labelColumns.*`、`settings.labelMappingsTitle/Desc`、`settings.labelColumnsTitle/Desc`）及废弃的看板模式 `settings.boardModeLabel`、`settings.boardModeLabelOnly`。zh-CN / en-US 各由 193 → 172 个 key，双语一致。

  - **验证**：`npm run i18n:check`（zh/en 各 172 key）、`npx tsc --noEmit`、`cargo check` 均通过。

- **v0.3.38（2026-09-07）— TaskCard 仓库颜色与全部账号下拉修复（#77 #78）**

  - **背景**：四态列视图的 TaskCard 漏传 `repoIndex`，仓库标签恒同色；`viewMode=all` 时账号下拉仍可切换但对列表无影响，语义含混。

  - **改动**：

    - **#77**：四态视图构建 `repoIndexMap` 并为 TaskCard 传 `repoIndex`，各视图独立构建，仓库标签按字母序取不同颜色。

    - **#78**：`viewMode=all` 时账号下拉 `disabled`，`title` 提示聚合语义（新增 i18n key `topbar.switchAccountAll`）。

  - **验证**：`npx tsc --noEmit`、`npm run i18n:check`（zh/en 各 193 key）通过。详见知识库文档 [docs/issue-77-78-card-board-fixes.md](./issue-77-78-card-board-fixes.md)。

- **v0.3.37（2026-09-07）— NotesPanel 快捷键与 DetailPanel 定时器修复（#75 #76）**

  - **背景**：NotesPanel Ctrl/⌘+Enter 快捷键绕过 `adding` 守卫，连按产生重复记事；DetailPanel `copyToClipboard` 的裸 `setTimeout` 未清理，组件卸载后仍触发 `setCopiedKey`（在已卸载组件上 setState）。

  - **改动**：

    - **#75**：快捷键触发收紧为 `!adding && draft.trim()`，与添加按钮禁用条件一致，连按/空草稿不再触发。

    - **#76**：`copyToClipboard` 改用 `useRef` 管理复位定时器（先清旧再存新，避免叠加）；新增卸载 `useEffect` 清理定时器。

  - **验证**：`npx tsc --noEmit` 通过。详见知识库文档 [docs/issue-75-76-ui-fixes.md](./issue-75-76-ui-fixes.md)。

- **v0.3.36（2026-09-07）— i18n 文本泄漏修复（#71）**

  - **背景**：SettingsPanel「诊断 & 项目列表」诊断文本与 DetailPanel agent 下拉（豆包/智谱 GLM/通义灵码）为硬编码中文，英文界面下不随语言切换（issue #62 已识别范围之外的新遗漏）。

  - **改动**：纯展示层接入 i18n。

    - DetailPanel：`AGENTS` 三项中文 label 增加 `i18nKey`；新增 `agentLabel(value, t)` helper，下拉与「记录于 {agent}」回显统一翻译。

    - SettingsPanel：`diagnoseProject` 组装文本改为 `t()` 插值。

    - 双语 locale 新增 `agents.doubao/glm/tongyi` 与 `settings.diag*` 共 8 个 key。

  - **验证**：`npm run i18n:check` 通过（zh/en 各 192 key）、`npx tsc --noEmit` 通过。详见知识库文档 [docs/issue-71-i18n-leaks.md](./issue-71-i18n-leaks.md)。

- **v0.3.35（2026-09-07）— run_sync 并发同步去重（#69）**

  - **背景**：Tray「立即同步」、启动同步、定时同步、前端 `sync_now` 多入口互不感知，可并发触发全量同步；`sync::run` 持 `db` 锁跑 5 次 Search + 1 次 GraphQL（5~15s），并发时背靠背排队、阻塞 UI 并放大 GitHub 限流。

  - **改动**：`AppState` 新增 `syncing: AtomicBool` 去重标志；新增 `SyncGuard`（`acquire` 抢占 / `Drop` 复位）。

    - `lib.rs::run_sync` 与 `commands.rs::sync_now` 统一走同一把标志：已有同步在跑时自动入口静默跳过、手动入口返回「同步进行中」。

  - **验证**：新增单测 `sync_guard_dedupes_concurrent_acquisition` 覆盖抢占去重与释放复位；`cargo test` lib 23 passed。详见知识库文档 [docs/issue-69-sync-dedup.md](./issue-69-sync-dedup.md)。

- **v0.3.34（2026-09-07）— update_task_status 校验 status 合法性（#70）**

  - **背景**：前端 `update_task_status` 把传入 status 直接写入 `tasks.status`，不校验合法性；拼错的非四态值或已删除的自定义列名落库后任务不属于任何列，从看板静默「消失」。

  - **改动**：校验口径统一为「四态 ∪ 中文四态 ∪ 该任务账号的 `account_columns::col_key`」。

    - `commands.rs::update_task_status`：中文四态归一化到英文四态；新增 `validate_task_status`，非四态非该账号自定义列时拒绝且 DB 不改动。

    - `mcp.rs::tool_update`：非四态时同样校验该账号自定义列 `col_key`，命中放行，否则拒绝（此前一律拒绝自定义列，口径不一致）。

  - **验证**：新增单测覆盖四态放行、该账号自定义列放行、拼错/未知列/任务不存在拒绝；`cargo test` lib 22 passed。详见知识库文档 [docs/issue-70-status-validation.md](./issue-70-status-validation.md)。

- **v0.3.33（2026-09-07）— MCP 双实现一致性修复（#68 #79）**

  - **背景**：内置 MCP（Rust `mcp.rs`）与便携兜底（Python `server.py`）在 `delete_note` 返回键、`update_note_label` 空标签处理上行为不一致，同一调用在不同环境下得到不同结果。

  - **改动**：

    - **#68**：`server.py::tool_delete_note` 返回键由 `id` 改为 `note_id`，与 Rust 端对齐。

    - **#79**：`server.py::tool_update_note_label` 空标签由报错改为回落 `low`，与 `tool_add_note` 及 Rust `normalize_note_label` 统一。

  - **验收**：内置 app 与便携 server 对 `delete_note`、`update_note_label("")`、`add_note("")` 返回/落库一致。详见知识库文档 [docs/issue-68-79-mcp-consistency.md](./issue-68-79-mcp-consistency.md)。

- **v0.3.32（2026-09-07）— Project V2 中的 PR 不再被当作 issue 上板（#67）**

  - **背景**：`fetch_project_issues` 用 `pull_request`/`mergedAt`/`headRefOid` 判型，但 GraphQL 查询并未选取这些字段，判断恒为假，导致 Project V2 里的 PR 被当作 issue 抓上看板。

  - **改动**：GraphQL 查询 `content` 区新增 `__typename`；判型改用 `content["__typename"] == "PullRequest"` 跳过 PR，可靠且与查询强一致。

  - **验收**：Project 中同时含 issue 与 PR 时，同步后 PR 不再上板，issue 正常上板、不占状态列。详见知识库文档 [docs/issue-67-pr-typename.md](./issue-67-pr-typename.md)。

- **v0.3.31（2026-09-07）— DetailPanel 切换任务时会话状态重置（#66）**

  - **背景**：DetailPanel 的 `sessionInput`/`agent`/`handoff` 用 `useState(task.sessionId)` 初始化但只在首次挂载取值，切换选中任务时组件未卸载、state 不重置，可能把上一个任务的会话/交接误写到当前任务。

  - **改动**：`App.tsx` 给 `<DetailPanel>` 加 `key={selectedTask.key}`，任务切换时强制重挂载、状态随新任务初始化。

  - **验收**：不关闭面板直接切到另一任务时，会话/交接输入不再残留上一任务的旧值；切回同一任务不丢未保存编辑。详见知识库文档 [docs/issue-66-detailpanel-session-reset.md](./issue-66-detailpanel-session-reset.md)。

- **v0.3.30（2026-09-07）— 空搜索结果误删看板任务修复（#65）**

  - **背景**：Search API 返回 422 时 `search()` 误当「空结果」，部分搜索源失败会让真实关联任务被标记陈旧后移出看板（数据丢失风险）。

  - **改动**：

    - `github.rs::search()`：422（含限流重试后仍 422/非 2xx）由返回空结果改为返回 `Err`，计入 `failed`，让下游感知搜索链路不完整。

    - `sync.rs::sync_account()` stale 清理：任一搜索源失败时，对仍 open 的任务仅解除 stale、保留本地记录，不再 DELETE；确认已关闭的仍正常标记已完成。

  - **验收**：搜索源 422/失败时同步不再中断，不再误删 open 任务；搜索完整时「移出看板」行为不变。详见知识库文档 [docs/issue-65-empty-search-no-delete.md](./issue-65-empty-search-no-delete.md)。

- **v0.3.29（2026-09-06）— 看板列模式持久化与一致性修复（#64 #72 #74）**

  - **背景**：二次审计发现看板列模式（boardMode）体系存在三处缺陷，导致自定义列功能不可用、四态视图任务消失、模式切换不持久。

  - **改动**：

    - **#64 boardMode 持久化**：后端 `Settings` 结构体补齐 `board_mode` 字段，`get_settings` 从 `meta.board_mode` 读回；前端切换模式后 `setBoardMode` → `loadSettings` 串行执行，不再被旧值覆盖。

    - **#72 四态选项恢复**：看板模式下拉补回 `status`（四态）选项；`Board.tsx` 默认值由 `status` 改为 `project`，与 `db.rs` 默认值对齐。

    - **#74 自定义列门控**：`sync.rs` 中自定义列映射仅在 `board_mode == "custom"` 时生效，避免四态 / Project 视图下任务 status 被写成 col_key 后从看板消失。

  - **验收**：看板模式可在 status / project / custom 间自由切换并持久化；非 custom 视图下同步不会把任务分到自定义列导致消失；cargo check / tsc / i18n:check 通过。详见知识库文档 [docs/issue-64-board-mode-fixes.md](./issue-64-board-mode-fixes.md)。

- **v0.3.28（2026-09-06）— 自定义列映射（#52）**

  - **背景**：每个账号可能使用不同的 GitHub Project Status 值体系，看板需要支持按账号自定义列映射规则，而非只有固定的四态列或 Project Status 列。

  - **改动**：

    - 后端新增 `account_columns` 表，支持按账号独立配置列（col_key、col_name、match_rules、order_index）；新增 `list_account_columns`、`save_account_columns` 两个 Tauri command；`sync.rs` 状态判定中自定义列映射优先于 label 映射和 Project Status 映射。

    - 前端 `Board.tsx` 新增 `custom` 模式渲染，按账号配置动态生成列，无匹配任务归入「未分类」列；`App.tsx` 看板模式下拉新增「自定义列」选项；`SettingsPanel.tsx` 新增列映射编辑界面（账号选择 → 列列表 → 增删改 → 保存）。

    - i18n 新增 12 个 key（zh-CN / en-US）。

  - **验收**：各账号可独立配置列映射规则；同步后匹配的任务自动归入对应列；切换看板模式为「自定义列」按自定义列渲染；关闭的任务始终归入「已完成」。详见知识库文档 [docs/issue-52-custom-column-mapping.md](./issue-52-custom-column-mapping.md)。

- **v0.3.27（2026-09-06）— 记事本导出 / 导入功能（#53）**

  - **背景**：破坏性更新（重新安装 / 清空数据 / 升级误删 SQLite）可能导致本地记事本数据丢失，此前无任何备份恢复入口。

  - **改动**：

    - 后端新增 `export_notes`、`import_notes` 两个 Tauri command：导出全部记事为 JSON 到应用数据目录 `notes-backup/`；导入按内容去重、保留原时间、不覆盖已有数据。

    - 前端 `NotesPanel` header 增加导出 / 导入两个图标按钮；导出后提示保存路径，导入后反馈「新增 / 跳过」条数。

  - **验收**：导出文件内容完整可读；从导出文件导入后记事（内容、label、时间）完整恢复；重复导入不产生重复条目；破坏性更新后可通过导入恢复。详见知识库文档 [docs/issue-53-notes-backup.md](./issue-53-notes-backup.md)。

- **v0.3.26（2026-09-06）— 授权登录后账号 modal 自动刷新（#54）**

  - **问题**：在「账号」modal 中完成 GitHub 设备授权登录后，账号列表不会自动刷新，新授权的账号不显示，必须手动关闭再重开 modal 才会出现。

  - **根因**：`AccountsPanel` 把父级 props 快照进本地 state（`useState<Account[]>(settings.accounts)`），此后**没有任何机制把 props 变化同步回本地**。授权成功只调用 `onAccountsChanged()`（父级 `loadSettings()` 刷新 settings），本地 `accounts` 始终不变，只能靠组件重新挂载才刷新。

  - **改动**：`AccountsPanel.tsx` 增加 `useEffect`，把 `settings.accounts` 同步回本地 state；全量替换而非追加，天然避免重复项。顺带修复同源问题——「设为默认」后默认标签不立即更新。

  - **验收**：授权成功回调后账号列表自动刷新、新账号即时显示；无需关闭重开 modal；不出现重复账号或数据错乱。

- **v0.3.25（2026-09-06）— 修复「检查更新」按钮不可点击（#55）**

  - **问题**：关于页打开后「检查更新」按钮始终处于 disabled 状态，用户无法主动触发版本检查。根因是 `AboutPanel` 的 `state` 初始值被设为 `{ phase: "loading" }`，把「尚未检查」与「正在检查」复用了同一状态，而按钮的 `disabled` 判断是 `state.phase === "loading"`，导致一打开就被禁用。

  - **改动**：

    - `AboutPanel.tsx`：`State` 新增 `idle` 初始态（未检查、按钮可点击），`loading` 仅表示检查进行中；移除冗余的 `checkedOnce` 标志；检查中显示「检查中…」并短暂禁用以防重复点击，检查完成（成功 / 报错）后一律恢复可点击；已是最新时展示具体版本号。

    - `zh-CN.json` / `en-US.json`：`about.upToDate` 增加 `{version}` 占位符，文案改为「当前已是最新版本 v{version}」。

  - **验收**：按钮打开即可点击；点击后正确展示「当前已是最新版本 vX.Y.Z」或「发现新版本 X，当前为 Y + 下载跳转」；检查完成后按钮恢复可点击。

- **v0.3.24（2026-09-05）— 记事本 + 账号体系 + 同步日志 + 顶栏布局（含 #6/#7/#27/#26/#31/#24/#25/#37/#38/#41/#33/#9/#48）**
  - **多账号与账号体系（#25/#31/#33/#38）**：修复第二个账号增收 422；新增账号管理面板（增删、切换）；删除账号时级联清理该账号下所有本地数据；移除 org 默认切换。
  - **记事本面板（#9）**：看板最左侧新增独立笔记列。
  - **同步日志（#27）**：应用内记录最近一周同步日志，超期自动删除；新增「同步日志」弹窗。
  - **顶栏布局优化（#48）**：右侧按钮组不换行；移除左侧 "TaskBoard" 文字；5 个按钮内联 SVG 图标，窗口过窄（≤1100px）仅显图标；四个弹窗收敛到互斥 `activeModal`（修复叠加，根因同 #26）；弹窗高度随视口收敛 + 内部滚动；遮罩 z-index 提升修复被搜索栏压住。
  - **同步体验（#24）**：同步完成后自动刷新。
  - **i18n 双语（#7）**：界面中英文切换；GitHub 授权倒计时格式修复（#6）。
  - **MCP 静默化（#41）**：MCP 调用隐藏 db 列迁移日志。
  - **知识库文档**：[`docs/issue-48-topbar-layout.md`](./issue-48-topbar-layout.md)、[`docs/issue-27-sync-logs.md`](./issue-27-sync-logs.md)、[`docs/issue-33-cascade-delete-account.md`](./issue-33-cascade-delete-account.md)、[`docs/issue-41-mcp-silent-migration.md`](./issue-41-mcp-silent-migration.md)、[`docs/issue-9-notepad-panel.md`](./issue-9-notepad-panel.md)

- **v0.3.23（2026-09-05）— 同步日志功能（#27）**

  - 需求：同步操作（定时/手动）执行后，用户无法查看同步历史和错误详情，难以排查「部分账号失败 / 422」等问题。

  - 改动：

    - `db.rs`：新增 `sync_logs` 表（account_id, trigger_type, started_at, finished_at, status, added/updated/removed/candidate_done/pruned 计数, failed_sources, error_message），自动创建表和索引。

    - `sync.rs`：同步开始时为每个目标账号插入日志，同步完成时更新日志状态和统计数据；每次同步后自动清理超过 7 天的旧日志。

    - `commands.rs`：新增 `list_sync_logs`（列出同步日志）和 `prune_sync_logs`（清理过期日志）两个 Tauri 命令。

    - `lib.rs`：注册新命令。

    - `types.ts`：新增 `SyncLog` 类型。

    - `api.ts`：新增 `listSyncLogs` 和 `pruneSyncLogs` API 调用。

    - `SyncLogsPanel.tsx`：新建同步日志面板组件，展示最近 100 条同步记录（时间、触发方式、耗时、状态、新增/更新/移除数量、错误信息），支持手动清理过期日志。

    - `App.tsx`：顶栏新增「同步日志」按钮。

    - `styles.css`：新增同步日志面板样式。

  - 验证：`cargo check` 通过；`npx tsc --noEmit` 通过；`npm run tauri build` 编译成功。

  - 知识库文档：[`docs/issue-27-sync-logs.md`](./issue-27-sync-logs.md)

- **v0.3.19（2026-09-05）— 关于页面 + 检查更新（#21）**

  - 背景：应用内缺少版本显示与更新入口，用户无法了解当前版本或触发升级。

  - 新增「关于」页面（顶栏「关于」按钮进入）：

    - 展示当前版本号（后端读取 Rust 包版本，非前端硬编码）

    - 「检查更新」按钮：调用 GitHub Releases API `releases/latest`，对比当前/最新版本，显示「已是最新」或「发现新版本」并提供跳转下载

    - 应用仓库名改为可点击链接，经系统浏览器打开 `https://github.com/ShawnLiuSZ/task-dashboard`

    - 内置中英文（i18n 新增 `about.*` / `btn.about` 键）

  - 技术说明：`check_latest_release` 为只读公开仓库请求，无需 PAT；用 `spawn_blocking` 避免 reqwest(blocking) 阻塞主线程。

  - 版本号统一升至 0.3.19（Cargo / package / tauri.conf / 内置 MCP / 便携 server.py）。

  - **Bundle Identifier 改为** **`com.shawnliu.taskboard`**（原 `com.liushizhao.taskboard`）：默认数据目录随之变为 `~/Library/Application Support/com.shawnliu.taskboard/`。⚠️ 已有本地数据如需沿用，请手动迁移旧目录中的 `taskboard.db` 到新目录，或试用 `TASKBOARD_DB` 指向旧库。

- **v0.3.18（2026-09-05）— 建立并执行版本发布流程（首个统一版本号）**

  - 背景（#5）：从 v0.3.17 起建立明确的 SemVer 版本发布流程，保证 Rust/Cargo、前端 package.json、Tauri 配置、内置 MCP、便携 `mcp_server/server.py` 与文档多处版本号一致，并为后续 release 提供可复现基础。

  - 版本号统一升至 0.3.18：

    - `app/src-tauri/Cargo.toml` `version=0.3.18`

    - `app/package.json` + `package-lock.json` `version=0.3.18`

    - `app/src-tauri/tauri.conf.json` `version=0.3.18`（产物 `TaskBoard_0.3.18_*.app/dmg`）

    - `app/src-tauri/src/mcp.rs` `SERVER_VERSION=0.3.18`（内置 MCP `serverInfo.version`，经 `taskboard mcp` 的 `initialize` 返回）

    - `mcp_server/server.py` `serverInfo.version` 由陈旧的 0.3.10 校正为 0.3.18（便携兜底与内置二进制保持一致）

  - 文档同步：README / PRD / 中英 CHANGELOG 均以 0.3.18 为准；新增英文版文档（README.en / AGENT\_INSTRUCTIONS.en / CHANGELOG.en）。

  - 跨平台文档（#8）随本版一并发布：README / CLAUDE / PRD 移除「仅 macOS」表述，改为 Windows / macOS / Linux 跨平台。

  - 验证：`cargo check` 零警告；`cargo build --release` 产出内置 MCP 二进制（冒烟 `initialize`→`serverInfo 0.3.18`、`tools/list` 6 工具齐全）；便携 `mcp_server/server.py` 冒烟一致。

- **v0.3.17（2026-09-04）— GitHub OAuth Device Flow 登录（替换 PAT 粘贴）**

  - 需求：登录 GitHub 不再手动创建/粘贴 PAT，改为「点按钮 → 浏览器授权」的链接登录体验。

  - 实现（RFC 8628 Device Flow）：新增 `src-tauri/src/oauth.rs`——① `start` 申请设备码（`POST /login/device/code`，scope=`repo read:org read:project`）；② `poll_once` 轮询 access\_token（`authorization_pending`/`slow_down`/`expired_token`/`access_denied` 全覆盖；**后端不 sleep**，由前端按 interval 控制节奏）。**token 全程不回流前端**——轮询成功后由后端探测 login 并直接建/更账号。

  - 首次使用前置（一次性）：GitHub → Settings → Developer settings → OAuth Apps → New OAuth App（Callback 随意），勾选 **Enable Device Flow**，复制 Client ID 填入设置面板（存 `meta.oauth_client_id`）。此后登录零配置。

  - UI（SettingsPanel）：添加账号表单改为「账号名称 + 组织 + Client ID + 通过 GitHub 授权登录」；授权面板大字显示 user\_code + 「重新打开授权页」（用 `verification_uri_complete` 预填免输码）+ 轮询状态；移除旧的「GitHub Personal Access Token（兼容字段）」整块 UI（后端 `save_pat`/`test_pat`/`clear_pat` 命令保留兼容）。

  - 命令注册：`save_oauth_client_id` / `device_login_start` / `device_login_poll`；`Settings` 增 `oauthClientId` 字段；MCP SERVER\_VERSION 同步 0.3.17。

  - 同登录同 login 的账号自动复用（更新 PAT 而非重复建号）；首个账号自动设为默认并激活。

  - 验证：`cargo check` 零警告；`cargo test` 16 lib + 15 integration 全过（新增 oauth 单测 2 条）；`npm run build` 通过。

- **v0.3.16.1（2026-09-04）— 修复首次启动 SIGABRT + SQLite WAL 加固**

  - 现象：v0.3.16 二进制首次启动 1.6s 内 SIGABRT，连续复现；crash log 栈顶 `tao::app_delegate::did_finish_launching + 272`（C 边界 `panic_cannot_unwind`），threadState.x22 = `sqlite3azCompileOpt`（SQLite 编译 SQL 时 panic）。

  - 根因链：v0.3.16 启动事务（建 accounts 表 + 写默认设置 + ALTER ADD account\_id）中途 abort → DELETE 模式残留 `.db-journal` 半提交 → bundled SQLite 0.31 在 macOS 26.6 上 forward-rollback 失败报 "disk I/O error" → 列迁移失败被 `let _ = ...` 静默吞掉 → DB 半新半旧 → 后续同步 panic。系统 sqlite3 3.51 能正常读写，证明文件本身健康，是 bundled SQLite 对残留 journal 的处理差异。

  - DB 恢复（手工）：备份后移走 `-journal`，用系统 sqlite3 补上 `account_id` 列；78 条任务完好。

  - 代码加固（`db.rs::open_db`）：① 强制 `PRAGMA journal_mode=WAL + synchronous=NORMAL + busy_timeout=5000`——WAL 模式下主 DB 文件始终一致可读，崩溃天然安全；② ALTER 失败不再吞，`eprintln!` 显式记录。

  - 新增测试：`open_db_uses_wal_journal_mode` / `open_db_recovers_from_dirty_journal_file`（伪造残留 journal 验证 open\_db 仍成功）。

- **v0.3.1（2026-09-04）— 看板漏拉「分配给我」的任务**

  - 现象：看板随机缺失已分配给我的 issue（如 `fad-backend#1200` 及 #1066/#1071/#1072/#1100/#1138/#1139、`pq-backend#259`）。

  - 根因：原同步仅用 `involves:<login>` 单一查询，而 GitHub 的 `involves:` 搜索对 assignee 覆盖不稳定，会偶发漏拉已分配 issue。

  - 修复：改为 `assignee:<login>`（权威）+ `involves:<login>`（其他相关）两次查询按 key 合并去重；编译通过并端到端验证 7 个漏洞 issue 已全部进入看板。

  - 残留限制：「与我相关但非我负责」（`assigned-others` / `notassignee`）仍依赖 `involves:`，理论上仍可能受同一偶发漏拉影响；「分配给我」已彻底稳定。

- **v0.3.2（2026-09-04）— 彻底消除** **`involves:`** **抖动导致的随机漏拉**

  - 进一步定位：GitHub `involves:` 搜索结果**非确定性抖动**——总数恒为 76，但成员会随机漏拉（同一批已分配 issue 在不同次查询中时有时无）。单一 `assignee:` 仅能兜住「分配给我」，兜不住「相关但非我负责」。

  - 修复：改为 **5 个稳定查询源取并集**——`assignee:` + `author:` + `mentions:` + `commenter:` + `involves:`（兜底），按 `repo#number` 去重。`github.rs` 抽 `fetch_search` 通用函数 + 4 个专属 `fetch_*` + `merge_tasks_all`；`sync.rs` 改为合并五源。

  - 验证：5 源合并唯一总数 = 76（即完整相关集），对 `involves:` 抖动免疫；任何单源漏拉都会被其他源补回。每次同步发起 5 次 Search API 调用（认证限额 30 次/分钟，充足）。

- **v0.3.3（2026-09-04）— 多源同步容错 + 失败提示**

  - 问题：多源改造后每次同步发起 5 次 Search API 调用，若某次偶发失败（限流/网络抖动）原 `?` 会让**整次同步失败**，反而可能让用户误以为"任务没了"。

  - 修复：`sync.rs` 改为 **best-effort 合并**——单源失败仅跳过该源、其余源照常并入；仅当全部源失败才报错。给 `SyncResult` 增加 `warning` 字段，`App.tsx` 横幅对"部分数据源失败"给出 ⚠️ 提示（不静默丢任务）。

  - 验证：`cargo check` + `npm run tauri build` 通过（`.dmg` 仍沙箱限制）；端到端同步 76 条入库、分布不变。

- **v0.3.4（2026-09-04）— 看板顶部搜索 + 仓库/归属筛选（可见性增强）**

  - 背景：同步已无漏拉，但长列（如「待处理」含 61 条 `fad-backend`）下具体任务难以定位，用户易误判"没拉下来"（如 `fad-backend#1200`）。

  - 改动：新增顶部 `.toolbar`——搜索框（命中 `repo#number 标题`，实时）+ 仓库下拉（按仓库隔离）+ 归属下拉（自 topbar 移入）+ 重置按钮；`visible` 经 `useMemo` 前端过滤，"共 N 条"改显可见数。

  - 验证：`npm run build` 通过；`npm run tauri build` 本次 `.app` 与 `.dmg` 双双产出；重拉起新构建自动同步 76 条、`fad-backend#1200` 在库，启动正常。

  - 用法：直接搜 `1200` 或 `fad-backend` 即可一秒定位该任务。

- **v0.3.5（2026-09-04）— 看板状态随 GitHub issue 状态联动 + 同步健壮性修复**

  - 用户反馈：看板里几乎所有任务都停在「待处理」，只有经 MCP/skill 手动改过的才会变；希望**看板状态能反映 issue 真实状态**。

  - 改动（`sync.rs`）：GitHub 已关闭的 issue 在同步时**自动归入「已完成」**（`status='done'`，覆盖本地手动态）+ 标 `candidate_done`；仍打开但不再与用户相关者移出看板。open 状态的 issue 仍保留本地手动四态（todo/doing/processed/done），不强行覆盖。

  - **顺带修复两个真实健壮性缺陷**（调试中暴露）：

    1. `github.rs` 的 `run_gh` 原用 `Command::output()` 无限等待，一次 `gh` 卡住（限流退避/网络 TLS 超时）会让整个同步**永久阻塞**。现加 30s 调用超时（轮询 `try_wait`，超时即 kill 报错，由 best-effort 跳过该源）。
    2. `sync.rs` stale 回路原在 `fetch_state` 失败时 `DELETE` 任务——限流/抖动时会被误删清空整个看板。现改为：**仅当** **`fetch_state`** **明确返回** **`open`（确认仍开但与我无关）才删除；查询失败一律保留**，避免一次限流误清空看板。

  - 验证：`open -g` 拉起新构建 → 自动同步 → 插入一个真实的已关闭 issue（`fad-backend#1195`）模拟"曾 open 现已关闭"，同步后该任务 `status=done / gh_state=closed / candidate_done=1`，其余 77 个 open issue 保持 `todo`。调试中曾因旧代码 + 限流把 76 条误删，已随修复恢复（正常同步会自动重新拉取，无需从 GitHub 之外恢复）。

- **v0.3.6（2026-09-04）— 看板状态联动 GitHub Project（OMS Kanban）的 Status 字段**

  - 用户反馈：`#1247/#1237/#1223` 等 issue 在 GitHub 上已是「开发完成测试中」之类的进度，看板却仍停在「待处理」。

  - 根因：看板此前**只读 GitHub Search API 的** **`state`（open/closed）**。而团队用 **GitHub Project「OMS Kanban」的 Status 字段**（如 `🔎开发完成/测试中`）表达进度，Search API 完全不返回该字段，所以看板对这些 issue 毫无感知，永远停在初始 `todo`。

  - 改动：

    - `github.rs` 新增 `fetch_project_status()`：通过 GraphQL 一次性分页拉取 OMS Kanban 全部条目的 `Status`（按 `repo#number` 建映射）；新增 `run_gh_graphql()` 复用 `run_gh` 的 30s 超时机制。

    - `sync.rs` 新增 `map_project_status()`，将 Project Status 映射到看板四态（`🧠需求池/🤔产品规划/🚧待开发处理→待处理`、`✨开发中→处理中`、`🔎开发完成/测试中/✅测试通过/待上线→已处理`、`🎉完成/上线/↩️取消→已完成`）；同步时对「在 Project 中」的 issue **以 Project Status 为权威覆盖本地手动态**，不在 Project 的 issue 维持原样。

    - `db.rs` 新增 `gh_status` 列（并含旧库迁移）；`commands.rs` / 前端 `types.ts` / `TaskCard.tsx` 透传并在卡片上展示该原始状态徽章。

  - 验证：`npm run tauri build` 通过（`.app` 产出，`.dmg` 仍受沙箱 `/Volumes` 限制）；拉起新构建自动同步后核对——`#1223`→已处理（`🔎开发完成/测试中`）、`#1247`→处理中（`✨开发中`）、`#1237`→待处理（`🧠需求池`，其真实状态确为需求池，并非测试中）；全量 77 条 issue 的 `gh_status` 均已填充且映射正确。

  - 注意：用户原以为三条都是「开发完成测试中」，实际仅 `#1223` 是；`#1247` 为开发中、`#1237` 为需求池——修复后看板反映的是 GitHub 上的**真实**状态。若后续想调整映射（如「测试通过/待上线」也归为已完成），改 `sync.rs` 的 `map_project_status` 即可。

- **v0.3.7（2026-09-04）— 修复「立即同步」点击后整个 App 转圈（beachball）卡死现象**

  - 现象：点界面上的「立即同步」，鼠标在 App 上转圈（macOS 彩虹球），像是卡死。

  - 根因：前端 `doSync` 早已设了 `syncing=true` 并显示「同步中…」、禁用按钮，但 Rust 端 `sync_now` 是**同步命令**，会**在主线程（事件循环线程）上跑完整个同步**（5 次 Search API + 1 次 GraphQL，5\~15s）。主线程被占满 → macOS 转圈、UI 无法渲染「同步中…」、看似卡死。菜单栏的「立即同步」因为走了 `thread::spawn` 子线程所以没这问题，只有界面按钮触发的前端 `invoke('sync_now')` 会。

  - 修复：`sync_now` 改为 `async` 命令，把真正耗时的 `sync::run` 用 `tauri::async_runtime::spawn_blocking` 丢到工作线程执行；主线程仅派发后立即返回。UI 全程不冻结，「同步中…」正常显示。前端无需改动（`invoke` 对同步/异步命令透明）。

  - 验证：`cargo check` + `npm run tauri build` 通过；拉起新构建自动同步正常（77 条、映射不变、`last_sync_error` 为空），进程稳定存活。macOS 转圈现象已结构性消除（异步命令不再阻塞主线程）。

- **v0.3.8（2026-09-04）— 已完成任务 30 天自动清理 + 他人分配显示真实昵称**

  - 用户反馈（两条）：

    1. 「已完成的 issue，只保留 1 个月」——已完成任务积压，看板越来越长。
    2. 「如果已经分配给他人了，就将他人 name 显示出来，而不是显示『分配给他人』」——`assigned-others` 一律显示成「分配给他人」，看不出具体是谁。

  - 改动：

    - `db.rs` 新增两列：`assignees TEXT`（该 issue 的全部 assignee 登录名，逗号分隔）与 `done_at INTEGER`（首次进入「已完成」的时间戳，默认 0）；两者均带旧库 `ALTER TABLE` 迁移。

    - `sync.rs` 写入：INSERT 落 `assignees = t.assignees.join(",")`；`done_at` 用 `CASE`——**首次**变为 `done` 时打上当前时间戳，之后保持不变（不每次重置），移出 `done` 时归零（重做会重新计时）。stale 回路中 GitHub 已关闭→`done` 的路径同样打 `done_at`。

    - `sync.rs` 末尾新增 **30 天清理**：`DELETE FROM tasks WHERE status='done' AND done_at>0 AND now-done_at > 2592000`。`done_at=0`（v0.3.8 前历史数据的完成时间未知）**不清理**，仅淘汰带真实时间戳、且距完成超 30 天的新任务——避免一次性误删历史。清理条数经 `SyncResult.pruned` 回传。

    - 前端透传：`commands.rs` 的 `Task` 加 `assignees` 字段（SELECT/mapper 索引同步）；`types.ts` 的 `Task` 加 `assignees`、`SyncResult` 加 `pruned`；`App.tsx` 同步结果文案新增「· 清理已完成 N」。

    - `TaskCard.tsx`：`assigned-others` 不再显示「分配给他人」，改为展示 `@login1 @login2`（从 `assignees` 拆分）。`notassignee` 仍显示「无人认领」，`assigned` 仍不显示归属标签。

  - 验证：`cargo check` + `npx tsc --noEmit` 均通过；`npm run tauri build` 产出 `.app`（`.dmg` 受沙箱 `/Volumes` 限制时另处处理）。逻辑自检：新完成任务的 `done_at` 在 30 天内不被清；历史 `done_at=0` 任务保留；`assigned-others` 卡片显示真实 `@昵称`。

- **v0.3.9（2026-09-04）— 卡片增强：我的红色标识 / 分配人 / @我 / 新评论链接 / 关联 PR**

  - 用户反馈（五条，合并为一版）：

    1. 分配给我（own）的 issue，以**红色醒目**标识。
    2. 卡片上「时间」上方加一行**分配人**，可显示多个（有的 issue 分配了两人），格式 `@a @b`。
    3. 评论区有人 **@我**，卡片上标识。
    4. 有**新评论**时，记录最新评论的链接，卡片一键跳转。
    5. issue 若对应 **PR**，记录 PR 编号与链接，便于查找。

  - 改动：

    - `db.rs`：新增 `mentioned` / `comments_count` / `latest_comment_url` / `pr_number` / `pr_url` 五列（含旧库 `ALTER` 迁移）。

    - `github.rs`：`RawTask` 增 `comments`（搜索返回评论数）；新增 `fetch_prs()`（一次分页拉全组织内 PR，取 `repo#number/url/body`）+ `fetch_comments()`（取该 issue 最新评论 `html_url`）；`JQ_PRS` 投影。

    - `sync.rs`：

      - **@我**：复用 `mentions:` 搜索源（`mention_keys` 集合），`mentioned = 在集合中 且 非分配给我`；mentions 源失败则保留既有标记。

      - **PR 关联**：`fetch_prs` 后用 `parse_issue_refs()` 解析每个 PR 正文的 `#N` / `owner/repo#N` 引用，反向建 `repo#issue -> (pr_number, pr_url)` 映射；PR 列表拉取成功才更新（失败保留既有）。

      - **新评论**：仅当评论数较上次增加 **且** 单次同步预算（≤30 条）充足时回源 `fetch_comments`，取最新评论永久链接；其余沿用缓存，控制 API 调用量。

      - 以上字段写入 `INSERT/ON CONFLICT`。

    - 前端：`commands.rs` `Task` 加 `mentioned/latestCommentUrl/prNumber/prUrl`（SELECT/mapper 索引同步）；`types.ts` 同步；`TaskCard.tsx` 渲染——`mine` 红色左边框 + 「★ 我的」红标、`分配人` 行（多 `@名`）、「📣 @我」橙标、「💬 新评论」「🔗 PR #N」跳转链接（点击经 `open_in_browser` 打开本机浏览器，且不触发卡片选中）；`styles.css` 补对应样式；`DetailPanel.tsx` 同步展示分配人/@我/PR/评论链接。

  - 验证：`cargo check` + `npx tsc --noEmit` 通过；`parse_issue_refs` 以多组样本（含 `owner/repo#N`、`/path/repo#N`、无引用）验证映射正确；`npm run tauri build` 产出 `.app` 与 `.dmg`。

  - 注意（取舍）：

    - **@我**基于 GitHub `mentions:` 搜索（覆盖正文+评论中的 @），非逐条拉评论判定，因而零额外 API 成本、与现有 5 源合并一致；若某 issue 仅在评论里 @我而 `mentions:` 未返回（极少数抖动），可能漏标。

    - **新评论链接**首次同步会对所有「评论数>0」的 issue 回源拉评论（受 30 条/次预算限流，少量 issue 顺延至后续同步补齐）；`fetch_comments` 仅取前 100 条评论里的最后一条（一般足够）。

    - **PR 关联**靠 PR 正文里的 `#N` 反推，纯文本启发式：形如「step #1」这类非引用也可能误关联（低风险）；跨仓库 `owner/repo#N` 已支持。

- **v0.3.9.1（2026-09-04）— 修复 PR 关联恒为 0（管道缓冲死锁，非限流）**

  - 现象：v0.3.9 五张卡增强里，前四项（红标/@我/分配人/新评论）正常，**唯独「关联 PR」`pr_number`** **全部为 0**。隔离验证（`parse_issue_refs` + 真实 PR 正文 + 真实 DB key）证明逻辑层应命中 44/77，但线上始终 0。

  - 根因（推翻此前「GitHub 二次限流」的误判）：`github.rs` 的 `run_gh_once` 在 `gh` 进程**退出后**才 `read_to_end` 读 stdout/stderr。当 `gh` 输出超过 OS 管道缓冲（macOS \~64KB，如 `fad-backend` 单页 PR JSON 达 442KB）时，`gh` 写满管道后**阻塞在 write、进程无法退出**，于是等到 60s 超时再 `kill` —— 该页 PR 被 best-effort 跳过 → `prs` 为空 → `pr_number` 全 0。证据：隔离跑 `fetch_prs`（不跑任何搜索）依旧 3/4 仓库 60s 超时、**唯独小响应仓库** **`flutter-driver`** **成功**；同一条 `gh api .../pulls?per_page=100` 在 bash 直跑 2.3s，在 Rust 子进程里却 60s 超时。

  - 修复：

    1. `run_gh_once` 改为**用独立线程并发排空** stdout/stderr（`thread::spawn` + `read_to_end`），主循环只 `try_wait` 轮询超时；`gh` 不再因管道满而阻塞（核心修复）。
    2. `RawPr.repo` 补 `#[serde(default)]`：REST pulls 的 JQ 投影不输出 `repo`，原反序列化会因「缺 repo 字段」失败（`flutter-driver` 已暴露 `missing field repo`）。
    3. PR 拉取超时放宽到 60s 单发（`gh` 自带按 `Retry-After` 退避，不再外层 3× 重试放大到 180s/页）。
    4. `sync.rs`：搜索→PR、PR→项目状态两处 4s 阶段冷却 + 评论预算 30→12（锦上添花，非主因）。

  - 验证：`cargo test --lib -- --ignored test_fetch_prs_isolated` 隔离 `fetch_prs` 793 个 PR / 31.6s（修复前 3/4 仓库 60s 超时）；`test_headless_sync_pr_linkage`（已改为复制生产库到临时副本、不误改用户数据）全量 `sync::run` 实测 `pr_number>0 = 44/77`，69.7s 完成（修复前 222.9s 且全 0）。前端 `TaskCard.tsx`(🔗 PR #N) / `DetailPanel.tsx`(PR #N 按钮) 经 `rename_all=camelCase` 链路闭合。

  - 经验（通用）：Rust 里用 `Command` 拉取「可能超过管道缓冲」的子进程输出时，**务必并发排空 stdout/stderr**，或改用 `output()`；「先等退出再读输出」在大数据量下必然死锁——这是比「限流重试/超时调参」更常见的坑。

- **v0.3.10（2026-09-04）— 卡片信息重整 + 分支/交接记录 + 体验修复（共 8 项）**

  - 背景：用户就「任务卡片信息」提出 8 条反馈/需求（含 4 张截图）。逐项落地如下：

    1. **（设计澄清）session id 的存入方式**：当前为**手动录入**——在详情页「中断会话」输入 session id + 选 agent → `record_session` 命令写入本地 SQLite（`session_id` / `session_agent` / `session_at`）。**并非 MCP 自动写入**；PRD.md 规划的「MCP Server + Skill 自动记录」尚未实现（架构预留，未动工）。本期保持手动录入不变，MCP 自动记录留待单独排期。
    2. **agent 下拉补全主流项**：`DetailPanel.tsx` 的 agent `<select>` 由原本 3 项（claude-code / workbuddy / doubao）扩为 10 项，新增 `opencode` / `codex` / `zcode` / `gemini-cli` / `cursor` / `aider` / `qwen-code`（以常量数组集中维护，便于增删）。
    3. **点击空白关闭详情**：`App.tsx` 在 `DetailPanel` 外包裹一层 `.detail-backdrop` 遮罩（覆盖看板区、`z-index:10`），点击遮罩即 `setSelected(null)`；详情面板 `z-index:11`，点击面板本身不穿透。关闭按钮仍保留。
    4. **「无人认领」上移到时间行上方 + issue 旁只留「我的」**：`TaskCard.tsx` 从 `card-top` 移除「分配人 @名」/归属徽章；`card-top` 仅留 `repo` / `#编号` / 「★ 我的」(若分配给我) / Project 状态。`无人认领` 与 `分配人 @名` 统一收进「时间上方一行」(`meta-row`)，不再挤在标题行。
    5. **「@我」移到时间行上方一行**：`mention-badge`（📣 @我）从 `card-top`（标题行）移至 `meta-row`（时间行上方），与「无人认领/分配人」同处一行，标题行不再拥挤。
    6. **记录关联分支**：GitHub issue 本身无分支字段，只能从**关联 PR 的** **`head.ref`** 反取。`github.rs` 的 `RawPr` 增 `head_ref` 并纳入 `JQ_PRS_REST` 投影；`sync.rs` 的 `pr_map` 由 `(num,url)` 扩为 `(num,url,branch)`，关联命中时一并写入新增的 `branch` 列；`db.rs` 加 `branch` 迁移；卡片 `meta-row` 在 `branch` 非空时显示「🌿 <分支名>」。
    7. **记录交接任务**：新增 `handoff TEXT` 列 + `record_handoff(key, text)` 命令 + 前端 `api.recordHandoff`。`DetailPanel.tsx` 新增「交接任务」区块（textarea + 保存，可还原）。接入 claude / codex 等 agent 后，由其识别「生成交接任务」类意图时**调用该命令写入**；本期先落地存储层与手动录入，agent 自动触发需配合 MCP/命令集成（与 #1 同源）。
    8. **卡片固定宽度 + 受控截断**：`styles.css` 看板网格由 `repeat(4, minmax(0,1fr))` 改为 `repeat(auto-fill, minmax(248px,1fr))`，卡片 `width:100%` 且不再被压到过窄；`card-top` 设 `flex-wrap:nowrap` 且 `repo/num/★我的` 不收缩不换行（根除「不该换行的换行」）；仅 `gh-status`（Project 状态，可较长）保留省略号。

  - 改动文件：`db.rs`（两列迁移）、`github.rs`（`head_ref` + JQ）、`sync.rs`（`pr_map` 三元组 + 读写 `branch` + 测试库补 ALTER）、`commands.rs`（`Task` 加 `branch`/`handoff`、SELECT/mapper 索引同步、`record_handoff` 注册）、`lib.rs`（注册 `record_handoff`）、`types.ts` / `api.ts`（加 `branch`/`handoff` + `recordHandoff`）、`TaskCard.tsx`（meta-row 重构）、`DetailPanel.tsx`（agent 列表 + 交接区块）、`App.tsx`（backdrop）、`styles.css`（网格/卡片/meta-row/backdrop 样式）。

  - 验证：`cargo check` 通过；`npm run build`（`tsc --noEmit && vite build`）通过；`npm run tauri build` 产出 `TaskBoard.app`（`.dmg` 仍受沙箱 `/Volumes` 限制，未产出）。`record_handoff` 命令已注册进 `invoke_handler`，与 `list_tasks` 等并列。

  - 迁移注意：新增 `branch` / `handoff` 两列由 `db.rs::init` 的 `ALTER TABLE` 在应用启动时自动补齐（旧库无此两列也不会报错）；**重启用新构建后**首屏 `SELECT` 即可读到新列。

- **v0.3.11（2026-09-04）— agent 下拉扩至 38 个主流 coding agent**

  - 背景：v0.3.10 仅把 agent 下拉扩到 10 项，而用户截图显示市面主流 agent 有 20+ 个，需补全以覆盖常用工具。

  - 改动：`DetailPanel.tsx` 的 `AGENTS` 常量数组由 10 项扩为 **38 项**（覆盖 Claude Code / Codex / Codex CLI 之外的 OpenCode、ZCode、Gemini CLI、Cursor、Aider、Qwen Code，以及 Copilot、Windsurf、Augment、Amazon Q、Devin、Replit、Bolt、v0、Cline、Roo Code、Continue、Cody、Codeium、OpenHands、Factory、Goose、Phind、Tabnine、ChatGPT、Grok、Codestral、Llama、Helix CLI，与中文系的 豆包 / 通义灵码 / 智谱 GLM / Trae / Kimi / DeepSeek / CodeBuddy 等）。`value` 用规范化 slug（与 MCP/agent 自报名一致，保证已存档的 `session_agent` 仍能匹配），`label` 为下拉展示名；其余存储/展示链路不变。

  - 同步说明：MCP Server、AGENT\_INSTRUCTIONS.md、CLAUDE.md 中的 agent 名为**自由字符串**（无白名单），无需随下拉改动而同步；下拉仅为人工录入时提供快捷选择。

  - 验证：`npm run build`（`tsc --noEmit && vite build`）通过；`npm run tauri build` 编译 + 打包 `TaskBoard.app` 成功产出（`.dmg` 仍受沙箱 `/Volumes` 限制未产出，与历史一致，非代码问题）。

- **v0.3.12（2026-09-04）— 把 MCP Server 集成进 app 二进制（消除散落文件夹 + Python 依赖）**

  - 背景（用户反馈）：装了 `.app` 之后，MCP Server 仍是独立进程，由 `~/.workbuddy/mcp.json` 用**写死在本机环境**的绝对路径引用 `mcp_server/server.py` + 受管 python 解释器。它和 app 是两套东西——装了 app ≠ 装了 MCP，必须单独保留 `mcp_server/` 文件夹，且那条配置换机器就失效。

  - 根因：MCP 此前是外部 Python 脚本，未被打包进 Tauri 产物，数据库路径虽与 app 一致（`~/Library/Application Support/com.liushizhao.taskboard/taskboard.db`）但运行形态完全独立。

  - 方案（用户选定 B：Rust 原生子命令）：把 MCP 做成 `taskboard` 二进制的 `mcp` 子命令，**完全内置**，而非打包 Python 资源（方案 A 仍依赖系统 python3 且仍是散落文件）。

  - 改动：

    1. `db.rs`：抽出无 GUI 的 `db_path_default()`（用 `dirs::data_dir()` + `APP_IDENTIFIER` 推导，与 Tauri `app_data_dir` 解析一致）、`data_dir()`、`APP_IDENTIFIER` 常量；新增共享的 `open_db(path)`（建表 + 全部历史 `ALTER` 迁移 + 默认设置），GUI 的 `init(app)` 改为调用它，确保 **schema 单一来源、MCP 与 GUI 零漂移**。
    2. 新增 `mcp.rs`：`src-tauri/src/mcp.rs` 实现 stdio JSON-RPC 2.0（LSP `Content-Length` 分帧，逐字节读取避免 BufRead 与 `read_exact` 错位）；`initialize` / `ping` / `tools/list` / `tools/call` 全覆盖、通知（无 id）不回；`busy_timeout=5000`（`execute_batch` 设置，兼容与 GUI 并发占用）；6 个工具（`list_my_tasks` / `get_task_status` / `update_task_status` / `record_session` / `record_handoff` / `clear_session`）与 `mcp_server/server.py` 完全对齐；`issue` 引用解析（`repo#number` / `owner/repo#number` / GitHub URL）、状态枚举（四态 + 中文）一致；`parse_issue_ref` 纯标准库手写（无 `regex` 依赖）。
    3. `main.rs`：argv 含 `mcp` 时调用 `taskboard_lib::run_mcp()`（走 stdio 循环，**不启动 GUI**），否则走原 `run()`。`lib.rs` 注册 `mod mcp` + `pub fn run_mcp()`。
    4. `mcp_server/server.py` 保留为**便携 / 开发兜底**（非 macOS 或未装 app 时仍可让 Agent 读写同一数据库），工具契约与内置二进制保持一致；README 配置片段改为指向 app 内二进制，并说明兜底路径。
    5. `~/.workbuddy/mcp.json` 的 `taskboard` 项改为 `"command": "/Applications/TaskBoard.app/Contents/MacOS/taskboard", "args": ["mcp"]`（装到 `/Applications` 后的规范路径；装到别处改绝对路径即可）。

  - 验证：`cargo check` 通过；`cargo build --release` 产出 `target/release/taskboard`（12 MB）；**冒烟测试**（Python 驱动二进制 `mcp` 子命令）实测：`initialize`→`serverInfo v0.3.12`、`tools/list`→6 个工具齐全；对**生产库** `list_my_tasks` 返回 78 条真实任务；对 **DB 副本** 验证 4 个写工具（`update_task_status` / `record_session` / `record_handoff` / `clear_session`）全部 `isError:false` 且 `get_task_status` 回读 `handoff` 正确（未改生产库）。已把新二进制 `cp` 进 `TaskBoard.app/Contents/MacOS/taskboard`，对该 `.app` 内二进制复测 `initialize` / `tools/list` 正常、无 `busy_timeout` 报错（已用 `execute_batch` 修正 PRAGMA 返回行报错）。

  - 效果：装了 app 即自带 MCP，mcp.json 指向 app 内二进制即可，**不再需要单独的** **`mcp_server/`** **文件夹、不再依赖受管 python**。

- **v0.3.13（2026-09-04）— 卡片微调：移除分配人展示 + 固定列宽加横向滚动**

  - 背景（用户 3 条反馈，附截图）：

    1. 把"无人认领"挪到日期上一行。
    2. 把 issue id 后的分配人信息去掉。
    3. 固定卡片宽度，给看板加横向滚动条。

  - 改动：

    - `TaskCard.tsx`：

      - 移除原先 `meta-row` 中"分配人 @xxx"整段渲染（`assigneeNames` 计算一并删除）。

      - "无人认领"保留在 `meta-row`（日期上一行），改为基于 `task.ownership === "notassignee"` 判定（与卡片左边框 `.unassigned` 一致），不再依赖 `assignees` 拆分。

      - `meta-row` 注释同步更新（"@我 / 无人认领 / 关联分支；分配人不再展示"）。

    - `styles.css`：

      - `.board` 从 `display: grid`（`repeat(auto-fill, minmax(248px, 1fr))`）改为 `display: flex; flex-direction: row; overflow-x: auto; overflow-y: hidden; min-height: 0;`——超出窗口宽度的列走横向滚动。

      - `.column` 固定 `flex: 0 0 320px; width: 320px;`——列宽与卡片宽度随之恒定（≈300px 可读），不再被压窄或拉宽。

      - `.card` 注释更新（宽度跟随列宽）。

  - 关于 #1 的备注：源码里"无人认领"在 v0.3.10 起就已位于日期上一行（`meta-row`），但用户截图显示它贴在 issue id 后——说明运行的 `.app` 前端是陈旧构建，未含 v0.3.10 的 card 重构。本版重新 `npm run tauri build` 出新 `.app`，源码本就正确，运行时也校正到位。

  - 验证：`npm run build`（`tsc --noEmit && vite build`）通过；`npm run tauri build` 一次性产出 `TaskBoard.app` 与 `TaskBoard_0.1.0_aarch64.dmg`（本次 dmg 也成功，沙箱未拦截）。

- **v0.3.14（2026-09-04）— 卡片逆调整：恢复分配人 + 分支移入详情 + 横向滚动上移 app + 修复同步按钮 hover**

  - 背景（用户 4 条反馈，附截图）：v0.3.13 的卡片改动部分需回退，并修正"立即同步"按钮 hover 看不见文字的问题。

    1. 恢复日期上一行（卡片 `meta-row`）的"分配人 @xxx"展示。
    2. 卡片上不再显示分支；分支**只在卡片详情（DetailPanel）中显示**。
    3. 撤销 `.board` 的横向滚动；改为**整个** **`.app`** **加横向滚动条**（看板列超出窗口宽度时整窗横向滚动，顶栏/工具栏 `position: sticky; left:0` 保持可见）。
    4. 鼠标悬停"立即同步"按钮时，按钮变白底、文字仍是白色 → 看不见文字，需修复。

  - 改动：

    - `TaskCard.tsx`：

      - 恢复 `const assigneeNames = task.assignees ? task.assignees.split(",").filter(Boolean) : [];` 计算。

      - `meta-row` 重新渲染"分配人"整段（`assignee-info` 含 label + 多个 `assignee-name` `@xxx`）；无人认领仍基于 `ownership === "notassignee"` 判定。

      - 移除 `meta-row` 中的 `🌿 分支`（`branch-tag`）渲染——分支不再出现在卡片上。

    - `DetailPanel.tsx`：在「GitHub」区块「分配人 / 无人认领」下方新增一行 `🌿 分支：{task.branch}`（仅当 `task.branch` 存在），确保卡片移除分支后信息不丢。

    - `styles.css`：

      - `.app` 加 `overflow-x: auto`（横向滚动上移到整窗）。

      - `.board` 去掉 `overflow-x: auto; overflow-y: hidden;`，保留 `display:flex; flex-direction:row` + `min-height:0`（列容器，列宽仍固定 320px）。

      - `.topbar` / `.toolbar` 加 `position: sticky; left: 0; z-index: 5;`，整窗横向滚动时搜索/同步/设置始终可见。

      - 新增 `.btn.primary:hover:not(:disabled)`（`background:#0858d6; border-color:#0858d6; color:#fff`）——其特异性（0,4,1）高于 `.btn:hover:not(:disabled)`（0,3,1），覆盖后保持 accent 底色 + 白字，消除白底白字。

  - 验证：`npm run build`（`tsc --noEmit && vite build`）通过；`npm run tauri build` 编译 + `.app` 产出成功；`.dmg` 因沙箱拦截 `/Volumes` 挂载失败，改用 `hdiutil create -srcfolder` 直读文件夹打包产出 `TaskBoard_0.1.0_aarch64.dmg`(4.2MB)。

- **v0.3.15（2026-09-04）— 完全替换 gh CLI 改用 GitHub PAT + visual polish（卡片配色 / 我的去背景）**

  - 背景：用户反馈"使用 gh 命令获取有些不妥——切 gh 账户后直接获取不到任何 task，建议用 GitHub 登录获取任务信息"。沿袭当前会话里揭示的两个 gh 历史包袱，正式移除 gh 子进程路径；同期打磨卡片视觉。

  - **架构变更（PAT 替换 gh）**：

    1. 移除 `github.rs` 全部 gh 子进程代码（`resolve_gh` + `run_gh` / `run_gh_once_timed` / `current_login` / `run_gh_graphql` 共约 250 行），新增 `GitHubClient { pat, login, http }` 用 `reqwest` blocking + `rustls-tls`（无 native-tls 依赖，跨平台编译干净）直接调 GitHub REST/GraphQL。删掉 800ms 调用间隔与阶段 4s 冷却，改由客户端主动解析 `X-RateLimit-Remaining` / `X-RateLimit-Reset` / `Retry-After`（Search 调用间仍固定 1s 间隔，对应 30 req/min 上限）。
    2. `db.rs` 默认设置加 `pat_token` + `last_sync_error` 两项；`meta` 是 kv 表，新字段首次启动时由 `DEFAULT_SETTINGS` 写入。
    3. `sync.rs` 改造：用 `pat_token` 构造 `GitHubClient`（构造时自动 `GET /user` 探测 login 并缓存）；空 PAT 直接报错 "未配置"由 `lib.rs` 跳过本次同步并写入错误提示。`sync.rs` 不再触碰 `gh_path` / 探测 gh 路径 / 当前 gh 登录用户。
    4. `commands.rs` 新增 `save_pat` / `test_pat` / `clear_pat` 三个 Tauri 命令（构造客户端时自动探测账号，写回 `meta.login` 便于前端展示）；`Settings` 加 `hasPat` / `lastSyncError` 两个字段。
    5. `lib.rs`：`run_sync` 启动前检查 PAT，缺失则设置 `last_sync_error` 并跳过；同步成功清空该字段；前端 `App.tsx` 渲染 `lastSyncError` 为红色 banner。
    6. `SettingsPanel.tsx`：PAT 输入框（password type）+ 当前账号展示 + 「保存 PAT / 测试连接 / 清除」三按钮。保存后清空 input 显示（防肩膀偷看 / 截屏）。`gh_path` 字段保留为只读兼容字段。

  - **visual polish（同期合并发布）**：

    1. **卡片右上 Project Status 配色**：新增 `gh-status-todo`（中性灰）/ `doing`（淡蓝）/ `processed`（淡紫）/ `done`（淡绿）/ `canceled`（淡红），替换原本统一的灰底配色。匹配逻辑按关键词（`TaskCard.tsx` 内维护，emoji 与文案变体兼容）。
    2. **「我的」去掉粉色背景**：`.card.mine` 去 `background:#fff6f6`，仅保留左侧 4px 红色边框；避免与「@我」(橙)、「新评论」(绿)、「💬 新评论」等暖色标签混淆。

  - **根因复盘（消解）**：

    - 触发事件：CI 产物首次同步 5 个 Search 源全 422 → `meta` 的 `last_sync_error` 写明 "Validation Failed"。

    - 直接原因：`gh auth switch` 切到 `ShawnLiuSZ`（GitHub 早期 **listed user** 类型），Search API 对 listed user 一律拒绝搜索（HTTP 422）。

    - 深层原因：探测路径用了子进程 `gh` + 环境探测，无法与 `gh` 内部账号切换解耦；其它历史包袱还含管道缓冲 60s 死锁、`gh api graphql -F` 临时文件等。

    - 直接修复：把 DB `meta.login` 改回 `liushizhao2025` 让看板瞬间恢复；本版从架构层根治。

  - **改动文件**：`Cargo.toml`（+ `reqwest`）、`github.rs`（整体重写）、`db.rs`（+2 设置项）、`sync.rs`（+49 行、`fetch_*` 去 gh 参数）、`commands.rs`（+3 命令 + PAT 类型）、`lib.rs`（PAT 检查 + 新命令注册）、`mcp.rs`（版本号 0.3.11 → 0.3.15）、`SettingsPanel.tsx`（PAT 块 +3 按钮）、`TaskCard.tsx`（状态类名映射）、`App.tsx`（banner 改用 `lastSyncError`）、`styles.css`（5 色 + 去掉粉底）、`types.ts` / `api.ts`（PAT 类型与方法）。

  - **不在本期范围**（已记 backlog）：fine-grained PAT 强化引导、系统 keyring 存储、OAuth、设备码流、多账号切换（→ v0.3.16 单独排期）。

  - 验证：`cargo check` 0 errors / 2 warning（dead\_code 已被 `#[allow(dead_code)]` 抑制为已知 pattern，注释说明）；`npm run build` 通过；`npm run tauri build` 产出新 `.app`。


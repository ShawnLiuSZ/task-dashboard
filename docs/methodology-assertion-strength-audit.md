# 断言强度审计方法论

> 沉淀自 v0.3.22 的断言强度审计（mutation testing）系列，共 11 项修复。
> 面向**任何要评估「测试是否真的在守什么」的人** —— 无论是接手续做审计，还是怀疑某处断言太弱。
>
> 关联：[`issue-376`](./issue-376-tasksig-field-contract-test.md)（前端首项）、[`issue-396`](./issue-396-tasks-new-fingerprint-untested.md)（Rust 末项）

## 0. 为什么需要这份文档

审计得出的核心结论是：

> **断言强度靠读代码判断极易出错。**

`taskSig` 那条表驱动用例（#376）**读起来完全合理** —— 注释详尽、断言清晰 —— 只有 mutation 才暴露它漏守 8 个字段。

而这 11 项的结论**全部依赖 mutation**，不是靠推理。所以：

1. **方法本身比任何单项结论更值得沉淀**
2. **方法的失效方式比方法本身更值得沉淀** —— 我在 11 项里犯了**十余次**「测量手段本身出错」，其中**多次差点得出完全相反的结论**

**11 项里只有 3 项是真实的代码缺陷**，其余 8 项「生产代码正确、只是没人守」：

| 类别 | 数量 | issue |
|---|---|---|
| **真实代码缺陷** | 3 | #376（漏字段 ⇒ UI 不刷新）· #384（`all()` 空洞为真，**当前不可达**）· #388（写入负时间戳） |
| **守卫自身有盲区** | 3 | #390 · #392 · #394（生产代码正确，但守卫会在「换个写法」时静默失效） |
| **仅缺守护** | 5 | #378 · #380 · #382 · #386 · #396（代码与守卫都正确，只是没有断言） |

这个分布本身说明：**测试的主要作用不是抓 bug，是把隐含契约显式化。**

（写这份文档时我一度把 #396 误算成「真实 bug」—— 它其实只是缺测试。这个纠错本身就是纪律 3 的应用：**数字与分类必须回查原始记录，不能凭印象**。）

---

## 1. 五条纪律

### 纪律 1：注入必须确认生效

**做法**：每次注入后打印源码残留计数，或先跑一次确认变异确实写入。

**反面教材**：`syncHint` 那次用 shell 内联反斜杠，`${t.title}` 被吞 → 脚本报「注入失败」。若采信该输出，会把**注入失败**误判成**断言失效**。

### 纪律 2：变异必须表达**真实缺陷方向与位置**

不是「能让代码不同」，而是「能复现一个真实缺陷」。

**三个反面教材**：

| 变异 | 为什么无效 |
|---|---|
| 把「只跑一次」写成 `for (let once = true; once;)` | 那是**无限**循环，不是单次 |
| host 提取取 `@` **后段** | `@` 后段才是真实 host —— 取它**本来就是正确行为** |
| 在 `.catch(` **之前**插入填充 | 同时平移 `.catch` 与 `reportError`，两者距离不变 —— **根本没测到想测的量** |

> 第三例最隐蔽：注入**技术上生效了**，但它没改变被测的量。我据此得出「魔数窗口静默失效」的**错误结论**，实测证明守卫其实会响。

### 纪律 3：期望值必须**外部来源**、必须**实测**

**不要用实现自己的公式自证期望值** —— 测试与实现同源则同样错、同样过，等于零覆盖。

| 场景 | 教训 |
|---|---|
| #378 闰年测试 | 我手算 `2024-02-27` = `1_708_128_000`，**错的**（实际 `1_708_992_000`）。测试当场拦下 |
| #388 共享 fixture | 我**照 Rust 抄**了 `sec=60` 的期望值，测试当场报 `1704067260 != 0` |

**做法**：Python `datetime` / `strftime` 等标准库算出真值，逐条核对。

### 纪律 4：过滤条件 / 信号必须**覆盖被测对象**

**反面教材**：验证 `title-X` / `url-X` 时用了 `vitest run src/panel-wiring.test.ts`，而新用例名 `link_from_node_defaults_...` **不含 `panel-wiring`** ⇒ **用例根本没跑**，我却据此报「存活」。

**做法**：注入后若结果异常，先确认**目标用例确实被执行**（用 `--reporter=verbose` 看用例名）。

### 纪律 5：判结果**只用退出码**，不要解析输出文本

```sh
(cd app && npx vitest run src/x.test.ts >/dev/null 2>&1); echo $?   # 0=全绿 1=有失败
(cd . && timeout 250 cargo test --manifest-path app/src-tauri/Cargo.toml >/dev/null 2>&1); echo $?
(cd mcp_server && python3 -m unittest test_server >/dev/null 2>&1); echo $?
```

**两个反面教材**：

1. `grep -oE "Tests .*"|head -1` 抓到的是 `Tests 1 ⎯⎯⎯`（**失败输出行**，非汇总行）⇒ 把 5 个形态全判反
2. 自写脚本用 `grep -q "No tests failed"` 判全绿 —— 该字符串**并非 vitest 输出**，**恢复态就误报** ⇒ 整张表结论作废

> 前七次测量错误是「采信了某个信号」；这两个证明**信号本身的选取**也会错。**退出码是唯一无歧义的信号。**

---

## 2. 固化教训：改测试文件后必须跑 clippy

**这不是 lint 洁癖，是结构安全。**

用脚本做**插入点替换**时，若 anchor 只取 `fn xxx() {` 一行，上方的 doc 注释与 `#[test]` 会留在原地 ⇒

- 属性叠加成 `duplicated attribute`
- **原函数失去 `#[test]` 变成 dead code**

**而 `cargo test` 当时仍然通过。** 只有 `cargo clippy --all-targets -D warnings` 才暴露。

**我犯了两次**（#380、#396），且**第一次已把这条写进 KB 文档，第二次仍重犯**。

**做法**：

```diff
- const anchor = "fn foo() {";          // ❌ 上方 doc + #[test] 留在原地
+ const anchor = "/// doc …\n#[test]\nfn foo() {";   // ✅ 连 #[test] 一起锚定
```

改完 `#[cfg(test)]` / `mod tests` / `tests/` 下的文件后，**立即**跑 `clippy --all-targets`。

---

## 3. 五类盲区（12 项的归纳）

审计发现的缺口可归为四类。**每一类的修复都是扩大覆盖面，而非增加断言数量。**

| 类 | 描述 | 实例 |
|---|---|---|
| **A. 枚举覆盖不全** | 守卫只列了当时已知的对象，新增的不在范围内 | #390 手写 6 个组件（实有 16 个 + `App.tsx`） |
| **B. 匹配形式单一** | 只匹配问题的一个**写法** | #392 正则只认 `}, [onClose])`，不认 `}, [onClose, t])` |
| **C. 解析语法子集太窄** | 解析器只认一种语法形态 | #394 `decls()` 看不见 `@media` 内规则、后代与合并选择器 |
| **D. 只守正向不守反向** | 契约的正例被守住，**反例没有** | #376 字段组断言 · #386 只测 `/issues/` 不测 `/pull/` · **#396 #340 指纹保护完全没测** |
| **E. 测试辅助函数补上了生产代码没有的不变性** | 辅助函数让某个分支在测试数据里**不可构造** | **#400** `host()` 把 `present` 由 `kind` 推导 ⇒ `present=false ∧ kind≠none` 构造不出来 ⇒ `!info.present` 守卫永不执行 |

### E 类值得单独记一笔

它与 #399（模块根本没在测试环境跑）同属「代码路径没被走到」，但**根因不同**：

- **#399**：环境缺打桩 —— 顶层 import 早于 `beforeEach`
- **#400**：**测试数据的构造方式**把分支排除掉了 —— 生产代码里 `present` 与 `kind` 是独立字段、类型系统不强制一致，而测试辅助函数 `host()` 把 `present: kind !== 'none'` 写死，**替生产代码补上了这个不变量**

> **辅助函数越「方便」，它替生产代码做的假设就越多。**
> 写 `host(agent, kind)` 这类糖时，要问一句：**它有没有把两个本应独立的字段绑在一起？**

### 归纳成一句话

> **断言的实现形式（枚举 / 字面量 / 语法子集 / 正反两面）必须覆盖问题实际出现的全部形式。**
> 否则同一问题的「换个写法」就会静默逃逸。

### D 类最值得警惕

A/B/C 三类里，读代码时**能看出**覆盖不全（D 类不能）—— 因为契约已经写在注释里，只是没人为它的**另一半**写断言。

**自查方法**：对每条写着「必须 / 不得 / 务必」的注释，问一句 —— **「这句话的反面有测试吗？」**

---

## 4. 「存活 ≠ 测试弱」：等价变异判别清单

mutation 存活有三种原因，**必须逐一排除后才能判定测试弱**：

| 原因 | 判别方法 | 实例 |
|---|---|---|
| ① 测试真的弱 | 行为确实改变且无人察觉 | 本系列 11 项 |
| ② **等价变异** | 变异后行为完全一致 | 见下表 |
| ③ **变异方向错** | 变异表达的不是缺陷 | 见纪律 2 |

### 已确认的等价变异（勿重复排查）

| 等价变异 | 为何等价 |
|---|---|
| 删 `link_from_node` 的 `.filter(\|p\| !p.is_null())` | `link_from_node` 走 `.get("number")?` 对 null 本就返回 `None` |
| host 提取取 `@` **后段** | `@` 后段才是真实 host，取它本就是正确行为 |
| CSS `decls()` 不匹配 `[deps]` / `[]` | 字面量不含回调；`[]` 本就正确 |
| 删 `table_exists(tasks_new)` 判据 | 全新库上两表都不存在，`table_has_column` 对不存在的表返回 `false` |
| `syncHint` 删无筛选 fast path | 无筛选时 `isHiddenByFilters` 本就全 false，结果同为 0（**是优化不是 bug**） |
| `updateCheck` 不 `clearTimeout` | 定时器残留不影响正确性，且检查一天跑一次 |
| `escLayer` release 用 `indexOf` | token 唯一 ⇒ 与 `lastIndexOf` 等价 |
| Rust `resolveBoardView` 取 `@` 前段 → 那是**真实逃逸**（反向对照） | 用来确认守卫方向没搞反 |
| `schema_is_current` 去掉 `!tasks_uses_legacy_key` | **同一条件在 `run_migrations` 里被独立检查第二次** —— 冗余纵深防御，删掉不改变行为（详见 [`issue-402`](./issue-402-schema-is-current-legacy-check-redundant.md)） |

**反例警示**：`assertRaises(ValueError)` 单独使用**判别力不足** —— `rpartition` 改 `split`、删空引用守卫，两种写法**都仍抛 ValueError**。必须断言**具体错误消息**（#386）。

---

## 5. 可复用流程

### 5.1 选目标（按性价比排序）

| 优先级 | 特征 | 实例 |
|---|---|---|
| 1 | **被 3+ 生产模块调用却零测试** | `iso8601_to_secs`（#378） |
| 1 | **代码注释里有显式契约，但只守了一半** | #340 指纹（#396） |
| 1 | **「自称对齐、实际不一致」的孪生实现** | `_iso_to_secs` vs `iso8601_to_secs`（#388） |
| 2 | **手写枚举 / 精确计数 / 正则守卫** | #390 / #392 / #394 |
| 2 | **表驱动但按「组」而非逐项断言** | `taskSig`（#376） |
| 3 | 分组/合并/排序等纯逻辑 | `format` / `coalescedLoad` —— 这类**通常覆盖良好** |

### 5.2 执行

```sh
# 1. 先记录基线（只用退出码）
(cd app && npx vitest run src/x.test.ts >/dev/null 2>&1); echo $?     # 期望 0

# 2. 备份被测源码
cp src/x.ts /tmp/x.bak

# 3. 逐个注入变异，每次：改 → 跑 → 打印判定 → 还原
python3 mutate.py <name>   # 注入后必须确认写入成功
(cd app && npx vitest run src/x.test.ts >/dev/null 2>&1); echo $?
cp /tmp/x.bak src/x.ts

# 4. 判别：存活 ⇒ 先排除「等价变异」与「方向错」，再判定测试弱

# 5. 修复后重跑同一批变异，逐字段/逐形态确认 0 存活

# 6. 改完 Rust 测试文件立即跑 clippy
cargo clippy --manifest-path app/src-tauri/Cargo.toml --all-targets -p taskboard -- -D warnings
```

### 5.3 交付（本仓约定，见 [`AGENTS.md`](../AGENTS.md)）

- 每项独立 issue + 分支 + PR（`main` 受保护）
- 知识库文档：`docs/issue-<num>-<topic>.md`，必填背景 / 设计 / 接口 / 测试 / 相关链接
- 索引到 `README.md` + `docs/CHANGELOG.md`
- `python3 scripts/check-doc-links.py` 必须通过

---

## 6. 11 项成果索引

| # | 模块 | 缺口类型 | 真实 bug |
|---|---|---|---|
| [#376](./issue-376-tasksig-field-contract-test.md) | 前端 `taskSig` | D（字段组断言） | ✅ |
| [#378](./issue-378-iso8601-test-coverage.md) | Rust `iso8601_to_secs` | 零测试 | ❌ |
| [#380](./issue-380-status-map-table-contract.md) | 状态映射表 | 覆盖 7/45 | ❌ |
| [#382](./issue-382-browser-url-whitelist-boundary.md) | URL 白名单 | 「无害简化」可逃逸 | ❌ |
| [#384](./issue-384-parse-links-alias-guard.md) | GraphQL 别名守卫 | 语言语义（`all()` 空洞为真） | ✅ 不可达 |
| [#386](./issue-386-python-mcp-parse-ref-coverage.md) | Python 引用解析 | D（形态未覆盖）+ 跨侧不对称 | ❌ |
| [#388](./issue-388-iso-parity-two-implementations.md) | 双实现日期转换 | 自称对齐实则不一致 | ✅ |
| [#390](./issue-390-openbrowser-guard-enumeration.md) | openExternal 守卫 | A（枚举） | ✅ 结构 |
| [#392](./issue-392-esc-deps-regex-too-narrow.md) | #344 Esc 守卫 | B（匹配形式） | ✅ 结构 |
| [#394](./issue-394-css-decls-selector-shape.md) | CSS `decls()` | C（语法子集） | ✅ 结构 |
| [#396](./issue-396-tasks-new-fingerprint-untested.md) | #340 恢复探测 | D（只守正向） | ✅ |
| [#399](./issue-399-theme-moduleload-untestable.md) | `theme.ts` 模块加载期 | 代码路径从未执行 | ❌ |
| [#400](./issue-400-agent-groups-helper-coupling.md) | `agent-groups` 测试辅助函数 | **E（辅助函数补上不变量）** | ❌ |
| [#402](./issue-402-schema-is-current-legacy-check-redundant.md) | `db.rs` legacy 判据 | 结论：**等价变异**（守卫冗余），无代码变更 | — |

（本表 11 行对应 issue #376–#396 中与审计相关的 11 篇 KB 文档；期间 PR 号与 issue 号交错，具体以 GitHub 为准。）

---

## 7. 给后续审计者的话

**别把「审计没发现东西」当成结论。** 本系列里我至少有一次（`panel-wiring` 剩余守卫的重点假设「魔数窗口静默失效」）**实测证伪、没有产出 issue** —— 那是正确的结果，不是失败。

同样地，**发现缺口时先问「这条保护有多重要」**：`updateCheck` 的定时器残留能测到，但修了没收益，我没为它开 PR。避免用低价值改动稀释仓库。

**最后**：这份文档里的纪律本身也**被重犯过**（插入点替换那条我犯两次）。若你发现本文与实践不符，**以实践为准并修正本文** —— 它是草稿，不是圣经。
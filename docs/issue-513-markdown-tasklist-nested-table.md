# 任务详情正文没按原有样式显示 —— 补齐任务列表 / 嵌套层级 / GFM 表格 — #513

> 用户反馈：**「任务详情显示的内容没有按 html 原有样式显示」**。
> 本 issue 用**真实数据**定位到根因，并补齐三项高频缺失的 markdown 构造。

## 背景：这不是「样式不好看」，是**渲染器缺功能**

#498 引入的 `utils/markdown.ts` 是一个**自写零依赖**的轻量渲染器（仓库前端零运行时依赖，
AGENTS.md §2.5 不允许引 markdown 库）。它支持标题 / 列表 / 引用 / 代码块 / 行内标记，
但**明确不支持**：表格、任务列表、嵌套列表、原始 HTML。

当时这些缺口没被注意到，是因为**没有量过真实数据里到底有多常见**。

## 定位：扫 121 个真实 issue body

样本来自用户实际在看的仓库（`FoodsUp-Inc/fad-backend` / `pq-backend` /
`foodsup-client-web` / `foodsup-client`），用 `GET /search/issues` 拉 40 条/仓，
逐个用正则统计**渲染器不支持**的构造（表格判定前先剥掉代码围栏，避免把代码里的
`|` 当成表格）：

| 构造 | 出现率 | 修复前渲染成 |
|---|---|---|
| **任务列表** `- [ ]` / `- [x]` | **104 / 121（86%）** | `<li>[ ] 待办 A</li>`（复选框丢失） |
| **嵌套列表**（缩进子项） | **53 / 121（44%）** | 缩进层级丢失 ⇒ 子项变成与父项**平级** |
| **GFM 表格** | **46 / 121（38%）** | 整段变成 `\| 字段 \| 说明 \|` 的原始文本 |
| 列表续行 | 5 / 121（4%） | 仍按纯文本（占比低，暂不支持） |
| 脚注 `[^x]` | 2 / 121（1%） | 仍按纯文本 |
| `<details>` / 自动链接 / 引用式链接 | **0** | — |

⇒ **86% / 44% / 38%** —— 这三项就是用户看到的「没按原有样式显示」。

复现（修复前，同一份输入）：

```html
<h2>变更背景</h2><p>P1 OD 司机欠框账：</p>
<ul><li>[ ] 待办 A</li><li>[x] 已完成 B</li>
<li>父项</li><li>子项 1</li><li>子项 2</li></ul>   ← 缩进层级丢失
<p>| 字段 | 说明 |                                  ← 表格变成原始文本
| --- | --- |
| a | 1 |</p>
```

## 实现

### 1. 任务列表（`parseListItem` + `taskPrefix`）

列表项解析时识别 `[ ]` / `[x]` 前缀（后跟至少一个空格，否则不是任务标记）：

```ts
const TASK_MARK_RE = /^\[([ xX])\]\s+(.*)$/;
```

渲染成**只读**复选框：

```html
<input type="checkbox" class="task-list-item-checkbox" disabled />        <!-- [ ] -->
<input type="checkbox" class="task-list-item-checkbox" checked disabled /> <!-- [x] -->
```

⚠️ **安全**：`type="checkbox"` + `disabled`，**无** `name` / `value` / 任何事件属性
⇒ 不可提交、不可交互、无脚本执行面。

### 2. 嵌套层级（`renderListLevel` / `renderListChildren` / `renderListItems`）

把「一行一个 `<li>`」的扁平实现换成**按缩进建树**：

- 缩进宽度：tab 按 **4** 空格展开（GitHub 口径）；
- 子项挂在上一个条目**内部** ⇒ `<li>父项<ul><li>子项</li></ul></li>`；
- 类型变化（`-` → `1.`）**另起一个列表**（与 GitHub 一致）；
- 三层递归：`renderListLevel`（本层）→ `renderListChildren`（子项分段）→ `renderListItems`（顶层分段）。

⚠️ **两个必须保证的「不变量」**（否则又是死循环 / 丢内容）：

1. **任何分支都必须消费至少一行** —— `renderListLevel` 里遇到「缩进比本层深」的项
   （理论上不该出现，子项由递归吃掉）时 `i += 1` 前进，而不是原地打转
   （#502 的教训：任何分支不前进 ⇒ 死循环）。
2. **`next === k` 时必须强制前进** —— `renderListChildren` / `renderListItems` 里
   若某层一条都没消费，`next` 会等于 `k` ⇒ 取 `k + 1` 兜底。

⚠️ 列表项的正则**必须与旧实现等价**（`^(\s*)(?:([-*+])|(\d+)[.)])\s+(.*)$`
vs 原来的两条独立正则）—— 因为**段落分支的终止条件**用的是同一套语义
（#502：两套独立写法曾在 CRLF 上互相矛盾 ⇒ 死循环）。

### 3. GFM 表格

识别条件：**当前行含 `|` 且下一行是分隔行**（`| --- | :---: | --: |`）。

- 表头行 → `<thead><tr><th …>`；数据行 → `<tbody><tr><td …>`；
- 分隔行的 `:---` / `:---:` / `---:` → `align="left|center|right"`；
- 单元格内容走 `renderInline`（**已转义** ⇒ 安全）；
- 列数不足补空、过多截断（GFM 口径）；
- 单元格首尾空白 **trim**（GFM 口径：`| a | b |` 的单元格是 `a` / `b`）。

### 4. CSS

| 选择器 | 作用 |
|---|---|
| `.markdown li > ul, .markdown li > ol` | 嵌套子列表收紧上下间距（默认 `ul ul { margin-block-start: 1em }` 会把子列表推得离父条目很远，与 GitHub 观感不符） |
| `.markdown input[type='checkbox'].task-list-item-checkbox` | 复选框与文字基线对齐 + `accent-color` 取主题色 |
| `.markdown table` / `th` / `td` | 表格边框、表头底色（`--surface-2`）、`display:block` + `overflow-x:auto`（issue 正文里的宽表很常见） |

## 验证

### 单测（+19，既有 44 条**全部仍绿**）

| 分组 | 例数 | 内容 |
|---|---|---|
| 任务列表 | 5 | 未勾选 / 已勾选 / **只读**（无 `name`/`value`/事件属性）/ 普通项不受影响 / `[x]` 后必须跟空格 |
| 嵌套层级 | 6 | 子项挂进父条目 / 两级嵌套 / 不同父项各持自己的子列表 / 有序嵌套 / 类型变化另起列表 / tab 按 4 空格 |
| GFM 表格 | 8 | `<thead>`/`<tbody>` / 单元格 trim / 三种对齐 / 单元格走行内解析 / 列数补空与截断 / 无数据行无 `<tbody>` / 非分隔行不误判 / 单元格 HTML 被转义 |

⚠️ **列表分支被整体重写 ⇒ 回归风险高** ⇒ 既有 44 条必须全绿（实测全绿）。

### 反向验证（3 处 mutation 全被捕获）

| mutation | 结果 |
|---|---|
| ① 任务列表标记不再识别 | ✓ 用例失败 |
| ② 嵌套层级被抹平（`childHtml = ''`） | ✓ 用例失败 |
| ③ 表格分支不可达（`if (false && …)`） | ✓ 用例失败（5 条） |

⚠️ **第一版反向验证脚本自己踩了坑**：用 `grep` 解析 vitest 输出数失败条数，
连续三次把「5 条失败」报成「0 条失败」（汇总行与失败输出行极易混淆）⇒
改为**只用退出码**判定（`docs/methodology-assertion-strength-audit.md` 的纪律 ①）。

### 可视化验证（Chrome 无头 + 真实 `styles.css`）

复现页用**真实** `styles.css` + **真实** `renderMarkdown` 产物，注入读数实测：

| 读数 | 值 | 判据 |
|---|---|---|
| `nestedIndentDelta`（父 li → 子 li 的 left 差） | **18px** | > 0 ⇒ 缩进生效 |
| `nestedSecondLevelDelta`（第二个父项的子树） | **18px** | > 0 ⇒ 逐层收进 |
| `checkboxCount` / `checkboxChecked` | **2 / 1** | 未勾选与已勾选可区分 |
| `checkboxAllDisabled` / `checkboxHasNameOrValue` | **true / false** | 只读、无提交面 |
| `tableColCount` / `tdBorderTop` | **3 / 1px** | 表格成型 |
| `thAligns` | `['none','left','right']` | 对齐由分隔行决定 |
| `docOverflowX` | **0** | 页面无横向溢出 |

⚠️ **探针也踩了一次坑**：第一版量的是子 `<ul>` 的 border-box `left`，
它**天然等于**父 `<li>` 的 `left`（子 `<ul>` 是父 li 内容盒里的第一个子元素）
⇒ 读数恒为 0 ⇒ 差点误判成「缩进没生效」（截图里明明有缩进）。
⇒ 改为量**子 `<li>`** 的 `left`（才是文字所在位置）。

⚠️ 另：Chrome 在本机 `--headless=new` 会以 133 退出（`Trying to load the allocator
multiple times`）⇒ 改用旧 `--headless` + `--user-data-dir` 才出图。

### 门禁

| 项 | 结果 |
|---|---|
| `cargo fmt --check` / `clippy --all-targets` / `test` | ✓（本次零 Rust 改动） |
| `npx tsc --noEmit` | ✓ |
| `npm run lint`（`--max-warnings 0`） | ✓ |
| `npx prettier --check "src/**/*.{ts,tsx,css}"` | ✓ |
| `npm run build` | ✓ |
| `npm run i18n:check` | ✓（中英各 449 key，**零新词条**） |
| `npx vitest run` | ✓ 32 文件 / **526** 例（原 507） |
| `python3 -m unittest discover -s scripts -p 'test_*.py'` | ✓ 143 例 |
| 四个 `scripts/check-*.py` | ✓ |

## 影响面

| 文件 | 改动 |
|---|---|
| `app/src/utils/markdown.ts` | 列表解析/渲染重写 + 任务列表 + 表格 + 文档注释 |
| `app/src/utils/markdown.test.ts` | +19 例 |
| `app/src/styles.css` | 嵌套列表 / 复选框 / 表格三组规则 |

**零后端改动** · 零 DB schema 改动 · 零 i18n 改动 · 零新依赖。

## 仍然不支持（已知边界）

| 构造 | 占比 | 处置 |
|---|---|---|
| 列表续行（条目文本跨行） | 4% | 仍按纯文本（GitHub 会续行；占比低，暂不做） |
| 脚注 `[^x]` | 1% | 仍按纯文本 |
| **原始 HTML** | — | **刻意不支持**（转义成字面文本）—— #498 定的安全模型 |

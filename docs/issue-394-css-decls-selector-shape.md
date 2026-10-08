# #394：CSS 断言 helper 只认精确选择器

> 断言强度审计（mutation testing）第六轮 —— 前端 CSS 静态断言。
> 所属版本：v0.3.22（待发版）· 关联 issue [#394](https://github.com/ShawnLiuSZ/task-dashboard/issues/394)

## 背景 / 动机

审 `app/src/components/notes-layout.test.ts` 与 `app/src/styles.test.ts`。

两者都用 `?raw` 读 `styles.css` 做静态断言 —— vitest 跑在 node 环境（无 DOM、无布局引擎），§2.5 又不引入 jsdom/testing-library。**断言质量直接决定 #259 那类布局回归能否被发现。**

## 核心问题：同一个 helper 复制了两份，且只认精确选择器字面量

```ts
function decls(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?:^|[},])\\s*${escaped}\\s*\\{([^}]*)\\}`, 'gm');
  const hits = [...styles.matchAll(re)].map((m) => m[1]);
  expect(hits.length).toBeGreaterThan(0);
  return hits.join('\n');
}
```

### 盲区 1：锚点 `(?:^|[},])` 不含 `{` ⇒ `@media` 内规则完全不可见

`styles.css` 有 2 个 `@media` 块。块内规则的 selector 前驱是 `{`（而非 `,` / `}` / 行首）⇒ 正则匹配不到。

> **而 #259 的缺陷本体正是「窄屏四列被压成 ~18px 竖条」。**
> 响应式回归恰好活在媒体查询里，而守卫**看不见那里**。

这是最讽刺的一处错配：**要防的问题所在的空间，恰好是守卫的盲区。**

### 盲区 2：只认字面量相等 ⇒ 后代选择器与合并选择器被漏

| 写法 | 是否作用于目标元素 | 是否被旧 helper 捕获 |
|---|---|---|
| `.notes-page .notes-card-cols { … }` | ✅ 同一元素、特异性更高、**实际生效** | ❌ |
| `.notes-card-cols, .sidebar { … }` | ✅ 命中第一项 | ❌ |

## 注入验证

在 `styles.css` 末尾追加规则（CSS 层叠下同特异性后写者胜 ⇒ 真实生效）：

| 注入形态 | 修复前 | 修复后 |
|---|---|---|
| `.notes-card-cols { flex-wrap: wrap }` | 捕获 | 捕获 |
| `.notes-page .notes-card-cols { … }`（后代） | **漏网** | 捕获 ✅ |
| `.notes-card-cols, .sidebar { … }`（合并） | **漏网** | 捕获 ✅ |
| `@media { .notes-page .notes-card-cols { … } }` | **漏网** | 捕获 ✅ |
| `@media { .notes-card-cols { … } }` | **漏网** | 捕获 ✅ |
| `@media { .notes-card-cols, .sidebar { … } }` | — | 捕获 ✅ |
| `.notes-page .sync-logs-table-wrap { overflow: hidden }` | — | 捕获 ✅（`styles.test.ts` 侧） |
| `@media { .sync-logs-table-wrap { overflow: hidden } }` | — | 捕获 ✅（`styles.test.ts` 侧） |

**8/8 全捕获**（修复前 5 种形态漏网 4 种）。

## 波及范围：55 个守卫

同一个 helper 在**两个文件里各写了一份**：

| 文件 | `decls()` 调用次数 |
|---|---|
| `app/src/components/notes-layout.test.ts` | 30 |
| `app/src/styles.test.ts` | 25 |

两份重复实现意味着修复必须做两遍 —— 这本身也是问题：**只改一处会让两文件行为分叉**，与 #386 跨侧漂移是同一类。

## 设计 / 方案

匹配语义改为「**规则选择器（按逗号拆开、去掉祖先前缀后）以调用方选择器结尾**」：

```ts
const target = selector.trim();
const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
for (const m of styles.matchAll(ruleRe)) {
  const applies = m[1].split(',').some((part) => part.trim().endsWith(target));
  if (applies) hits.push(m[2]);
}
```

一次覆盖四种写法：

| 写法 | 覆盖原理 |
|---|---|
| `.notes-card-cols` | 完全相同 |
| `.notes-page .notes-card-cols` | `endsWith('.notes-card-cols')` |
| `.notes-card-cols, .sidebar` | 逗号拆开后第一项命中 |
| `.notes-page .notes-panel`（**调用方自带后代**） | `styles.test.ts` 里确实这么调用，故 target 必须是调用方的**完整**选择器 |

### 为什么用 `endsWith` 而非 `startsWith` / 包含

避免 `.note-col` 误命中 `.note-col--p1`（BEM 后缀），也避免 `.a.b` 与 `.b` 混淆。

### 规则提取：为什么 `/([^{}]+)\{([^{}]*)\}/g` 能穿透 `@media`

`@media (max-width: 900px) { .notes-card-cols { … } }` 中：

- 外壳：selector 部分 `@media (max-width: 900px) ` 后面是 `{`，但 `([^{}]*)` 匹配到 ` .notes-card-cols ` 后要求 `}`，下一个字符是 `{` ⇒ **不匹配**
- 内层：` .notes-card-cols ` + `{ flex-wrap: wrap; }` ⇒ **匹配**

即「外壳因声明体含 `{` 被自然跳过，内层规则被直接取到」。无需专门写嵌套解析。

## 过程中的一次脚本失误

替换时用 `re.sub(new_string, s)`，Python 把替换串里的 `\s` 当转义处理，报 `bad escape \s`。

改用**函数形式** `pat.sub(lambda m: new, s)` 规避 —— 正则替换串中的反斜杠必须走函数形式。

## 接口 / 行为变更

无。纯测试变更。

## 数据 / Schema 变更

无。

## 测试 / 验收

- [x] 8/8 注入全部捕获
- [x] 41 个 CSS 断言全绿，**无既有用例回归**
- [x] 前端 231 tests 全绿
- [x] `tsc --noEmit` 干净
- [x] `prettier --check` 干净
- [x] `eslint --max-warnings 0` 干净

## 本项与前几项的关系

这是「**守卫覆盖范围窄于问题域**」这系列的第 3 例，但盲区的**成因**不同：

| # | 守卫 | 盲区成因 |
|---|---|---|
| #390 | openExternal | 枚举只手写了 6 个组件 |
| #392 | #344 Esc 依赖 | 正则只匹配一种写法 |
| **#394** | **CSS `decls()`** | **解析只认一种语法形态** |

三者可归纳为一条更一般的规律：

> **断言的实现形式（枚举 / 字面量 / 语法子集）必须覆盖问题出现的全部语法形式。**
> 否则同一问题的「换个写法」就会静默逃逸。

而 #394 尤其值得记：盲区**恰好覆盖了要防的问题所在的空间**（媒体查询 = 响应式回归）。

## 相关链接

- issue [#394](https://github.com/ShawnLiuSZ/task-dashboard/issues/394)
- PR #395
- 前置：#390 / #392（同系列，同文件 `panel-wiring.test.ts`）、#386（跨侧漂移）
- 要防的缺陷本体：#259（记事本四列被压成 ~18px 竖条）
- 源文件：`app/src/components/notes-layout.test.ts`、`app/src/styles.test.ts`
# 任务详情：issue 正文在 CRLF 行尾下死循环，导致详情面板整块消失 — #502

> 关联 issue：[#502](https://github.com/ShawnLiuSZ/task-dashboard/issues/502)

## 现象

用户反馈：「实时拉取信息，为什么没有拉取 issue 的 body、评论记录等信息展示在详情中」。

排查结论：**拉到了，但渲染时炸了** —— `renderMarkdown` 在真实正文上**死循环**，
渲染期抛 `RangeError` ⇒ React 卸载整棵树 ⇒ **详情面板（连同 body / 评论 / PR 提交历史）整块消失**。

## 根因

### 1. JavaScript 的 `.` **不匹配 `\r`**

`.` 排除 `\n` `\r` `\u2028` `\u2029`（行终止符）。而 GitHub issue 正文**普遍是 CRLF 行尾**
（Windows 编辑器粘贴的常见形态）。

`app/src/utils/markdown.ts` 里这几条**带 `$` 锚点**的块级正则在 CRLF 行上**整行失配**
（`(.*)` 停在 `\r` 前，而 `$` 要求到行尾）：

```ts
const heading = line.match(/^(#{1,6})\s+(.*)$/);    // 标题
const bullet  = line.match(/^\s*[-*+]\s+(.*)$/);   // 无序列表
const ordered = line.match(/^\s*\d+[.)]\s+(.*)$/); // 有序列表
const fence   = line.match(/^\s*(```|~~~)(.*)$/);   // 代码围栏
```

### 2. 「分支判定」与「段落终止条件」是两套写法 ⇒ 不一致 ⇒ 空转

段落分支（⑦）的终止条件**没有** `$` 锚点：

```ts
while (i < lines.length && lines[i].trim() &&
       !/^\s*(```|~~~)/.test(lines[i]) &&
       !/^(#{1,6})\s+/.test(lines[i]) &&      // ← 判「这是标题行」
       ... ) { buf.push(lines[i]); i += 1; }
out.push(`<p>${renderInline(buf.join('\n'))}</p>`);
```

⇒ CRLF 的标题行（如 `## 现状\r`）：
**进不了**标题分支（`$` 失配）⇒ 却**被段落终止条件判成「标题行」** ⇒ 段落 `while` 一次都不执行
⇒ `buf` 为空且 **`i` 不前进** ⇒ 外层 `while` 原地打转 ⇒ `out` 无限增长
⇒ `RangeError: Invalid array length`（或内存暴涨被 OOM kill）。

### 3. 实测（真实 issue 正文）

`FoodsUp-Inc/fad-backend#1630` 的正文（首行即 `## 现状\r\n`，共 30 行）：

```
RangeError: Invalid array length
 ❯ renderMarkdown src/utils/markdown.ts:205:9
    205|     out.push(`<p>${renderInline(buf.join('\n'))}</p>`);
```

循环 **111 秒**后才抛错；未加保护时进程直接被 OOM kill（`SIGTERM` / exit 137）。

### 4. 为什么 #498 的 27 条单测没抓到

**全部用 `\n` 造数据** ⇒ 与真实数据的形状不一致 ⇒ 这条路径根本没被覆盖。
（与本仓反复出现的同型教训一致：「测试数据形状 ≠ 真实数据形状」比「断言写错」更隐蔽。）

### 5. 触发条件（两个同时满足）

1. 正文含 CRLF 行尾；
2. 至少有一行是**标题**（`#`）或**列表项**（`-` / `*` / `+` / `1.`）—— 纯段落行不触发。

## 修复

### 1. 根因修复：进块级解析前归一化行尾

```ts
const lines = escapeHtml(src.replace(/\r\n?/g, '\n')).split('\n');
```

⇒ 行内不再带 `\r` ⇒ 所有 `$` 锚点语义一致 ⇒ 分支判定与终止条件重新对齐。

### 2. 结构兜底：段落分支**必须**推进 `i`

```ts
if (buf.length === 0) {
  i += 1;
  continue;
}
```

⇒ 任何「终止条件与分支判定不一致」都不再退化成**死循环**，最坏只是那一行渲染成普通段落。

## 验证

| 场景 | 修复前 | 修复后 |
|---|---|---|
| 真实正文（`#1630`，CRLF + 标题 + 列表） | 循环 111s → `RangeError` | **1ms** → 1072 字符 HTML（含 `<h2>` / `<ul>` / `<p>`） |
| CRLF + 标题 | 死循环 | `<h2>现状</h2>` |
| CRLF + 列表 | 死循环 | `<ul><li>一条</li><li>两条</li></ul>` |
| CRLF 与 LF 渲染结果 | 不一致 | **完全一致**（逐字节相等） |

## 反向验证（2 处 mutation 全被捕获）

| 变异 | 结果 |
|---|---|
| 去掉 CRLF 归一化（保留段落兜底） | `markdown.test.ts` **8 条失败**（标题 / 列表 / 有序列表 / 代码围栏 / 裸 CR / CRLF≡LF / 真实正文 / 规模），且**毫秒级返回不死循环** —— 证明「兜底」把灾难降级为「输出不完整」 |
| 同时去掉段落兜底（= 修复前原样） | 加计数器的探针立刻报 `LOOP STUCK i=0` ⇒ 死循环复现 |

## 测试

`app/src/utils/markdown.test.ts` 新增「renderMarkdown — CRLF 行尾不得死循环（#502）」**9 例**：
CRLF 标题 / 列表 / 有序列表 / 代码围栏 / 水平线 / 裸 CR / CRLF≡LF 逐字节一致 /
真实 issue 正文形状 / 2000 行 CRLF 的终止性与规模（毫秒级）。

## 影响面

- 仅 `app/src/utils/markdown.ts`（#498 引入的零依赖 markdown 渲染器）+ 其单测；
- 触发时机：**打开任意含 CRLF 标题/列表的 issue 详情** ⇒ 详情面板（含 body / 评论 / PR 提交历史）整块消失，最坏整窗空白；
- 零后端 / 零 DB schema / 零 i18n 改动。

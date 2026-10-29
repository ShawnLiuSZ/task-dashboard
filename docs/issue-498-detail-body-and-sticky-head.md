# 任务详情：sticky 头部遮挡标题 + 未展示 issue 正文 — #498

> 关联 issue：[#498](https://github.com/ShawnLiuSZ/task-dashboard/issues/498)

## 现象

打开任务详情后有两个问题：

1. **标题行挡住标题**：`fad-backend #1630` 那一行（sticky 头部）的下边框横切在 issue 标题文字上沿，标题上半部分被盖掉。
2. **没有展示具体的详细信息**：详情面板只有 issue 的**标题**，没有 issue 的**正文描述**（body）。

## 根因

### 1. `position: sticky` 会**抵消负 margin**

`.detail-head` 原本是 `margin: -16px -18px 0` —— 用负 margin 抵消 `.detail` 的 `padding-top`，
好让吸顶头部**满宽**（左右也负 18px）。

但 `position: sticky` 与负 margin **自相矛盾**：sticky 把元素钉到「滚动容器 padding box 顶部」时
**按 border box 对齐**，负 margin 的上移效果被**抵消** ⇒ 头部整体下移 16px
⇒ 盖住紧随其后的 `.detail-title`（`.detail-title` 的 `margin-top: 8px` 是相对**未钉住**位置算的）。

Chrome 无头实测（真实 CSS + 真实 DOM，视口 1280×900）：

```
detail: top=285.9 left=280.0 w=720.0 h=185.3
head  : top=302.9 bottom=354.9 h=52.0
title : top=346.9 bottom=367.9 h=21.0
titletext: top=348.9 bottom=365.9
OVERLAP(head vs title)    = 8.00px
OVERLAP(head vs titletext) = 6.00px   ← 标题文字上沿被盖 6px
```

### 2. issue 正文**从未被拉取过**

`app/src-tauri/src/github.rs::RawTask` **没有 `body` 字段** ⇒ GitHub REST issue 响应里的
`body` 从未被读取 ⇒ `LiveIssue` 也没有 body ⇒ 详情面板从来只显示标题。

这与 #490 当时的约定不符：那一轮明确选了「展示范围 = 覆盖 **body** 评论区、历史提交记录等」，
但实现只做了评论区 / 指派 / 标签 / PR 提交历史，**body 漏做**。

## 修复

### 1. 后端取 body（`github.rs` / `on_demand.rs`）

新增 `GitHubClient::fetch_issue_with_body` —— 与 `fetch_issue` 走**同一次**请求，
区别只是多返回一段正文。

⚠️ **body 刻意不进 `RawTask`**：GitHub 的 Search API 返回的 issue 项**同样带 body**，
塞进 `RawTask` 会让每次同步多下载几百 KB 正文（5 个 Search × 100 条/页），
而同步路径（写 `tasks` 表）根本不需要正文。正文只在「打开详情」这一次请求里取。

正文提取抽成纯函数 `issue_body_from_json`（可单测）：`body` 缺失 / 为 `null` / 类型异常
⇒ 一律降级为**空串**（详情面板据此不渲染「描述」区块），绝不报错。

`LiveIssue` 新增 `body: String`；「REST 响应 → `LiveIssue`」的转换抽成纯函数
`build_live_issue`（**理由见下方的「断言落点」**）。

### 2. 前端渲染正文（`utils/markdown.ts` + `DetailPanel.tsx`）

新增 `app/src/utils/markdown.ts` —— 自写**轻量** markdown → 安全 HTML，**零依赖**
（仓库现状：前端零运行时依赖；为渲染正文引入 `marked` 要付出几百 KB + 一条新供应链面）。

支持：代码块（``` / ~~~）、标题（# ~ ######）、无序 / 有序列表、引用、水平线、段落；
行内 `` `code` ``、`**粗体**`、`*斜体*` / `_斜体_`、`~~删除线~~`、`[文字](链接)`。

**安全模型**（返回值会被 `dangerouslySetInnerHTML` 注入 DOM ⇒ 必须是安全的）：

1. **先转义、后加工**：源文本先做 HTML 转义（`&` `<` `>` `"` `'`），
   之后生成的标签**只允许白名单**里的那几种 ⇒ 源文本里的 `<script>` 只会是字面文本；
2. **不注入原始 HTML**；
3. **链接协议白名单**：只放行 `http://` / `https://`；
   `javascript:` / `data:` / 相对链接一律**降级为纯文本**（保留可见文字，不生成可点链接）。

正文区块放在标题下方（「描述」），超过 600 字默认折叠（限高 132px + 底部渐隐遮罩），
配「展开全文 / 收起」按钮。

### 3. 修 sticky 遮挡（`styles.css`）

```css
.detail { padding: 0 18px 16px; }        /* padding-top 归零 */
.detail-head { margin: 0 -18px; }        /* 只左右撑满宽，不再上下位移 */
```

头部内容的顶部留白改由头部自己的 `padding-top: 16px` 提供（视觉与之前一致）。
**核心：不再有任何上下位移 ⇒ sticky 钉住位置与正常流位置一致 ⇒ 标题不再被盖。**

### 4. 渲染验证（Chrome 无头 + 注入读数）

修完后同一套复现页实测：

| 指标 | 修复前 | 修复后 |
|---|---|---|
| `OVERLAP(head vs title)` | **8.00px** | **0.00px** |
| `OVERLAP(head vs titletext)` | 6.00px | 0.00px |
| `head.top` 相对 `detail.top` | +17.0px | **+1.0px**（= border，贴顶） |
| 滚动 200px 后 `head.top` 相对 `detail.top` | — | **+1.0px**（仍钉在顶部） |
| 滚动 200px 后 `OVERLAP(head vs title)` | — | **0.00px** |
| 正文折叠态高度 | — | **132.0px**（展开 638.9px） |
| 弹窗内横向溢出元素数 | — | **0** |

## 断言落点：一次「反向验证没抓到」的教训

第一版的 body 断言写成了「手工构造 `LiveIssue` 字面量 ⇒ 序列化后含 `body`」。
**反向验证时把转换里的 `body` 换成空串，单测仍然全绿** —— 因为那条断言压根没经过真实数据流。

⇒ 断言必须落在**真实转换路径**上。故把转换抽成纯函数 `build_live_issue`，
断言改为「给定 `RawTask` + body ⇒ `LiveIssue.body` 原样透传」。

这与本仓此前多次教训同型（#376 `taskSig`、#355 `write_commands_check_affected_rows`）：
**「断言看起来合理」≠「断言有判别力」**。

## 测试

| 位置 | 内容 |
|---|---|
| `github.rs` | `issue_body_is_extracted_verbatim` / `issue_body_degrades_to_empty_string`（缺失 / null / 数字 / 对象四种脏形状）/ `issue_body_empty_equals_missing` |
| `on_demand.rs` | `live_issue_carries_body_from_rest_response`（**落在真实转换路径上**）/ `live_task_detail_serializes_camel_case_keys` 追加 `issue.body` 断言 |
| `app/src/utils/markdown.test.ts`（新） | 27 例：XSS（`<script>` / `<img onerror>` / `javascript:` / `data:` / 相对链接 / 属性逃逸）+ 结构（段落 / 标题 / 列表 / 引用 / 水平线 / 代码块）+ 行内（粗体 / 斜体 / 删除线 / 行内代码）+ 边界（空输入 / 未闭合代码块） |
| `app/src/utils/liveDetail.test.ts` | 追加 body 正常保留 / 缺失降级 / 类型异常降级 3 例 |
| `app/src/components/task-comments-list.test.tsx` | 「DetailPanel 的 issue 正文展示（#498）」5 例 |
| `app/src/styles.test.ts` | 「详情头部不得遮挡标题 #498」4 例 + 「issue 正文区块 #498」3 例 |

**反向验证（3 处 mutation 全被捕获）**：

| 变异 | 结果 |
|---|---|
| `.detail-head` 的 margin 改回 `-16px -18px 0` | `styles.test.ts` 失败（「不得有上下负 margin」） |
| 转换里 `body` 换成空串 | Rust 用例失败（「正文必须原样透传」）——**第一版断言抓不到，重构断言落点后才抓到** |
| 正文区块改成不渲染 | 前端断言失败（「正文为空时整节不渲染」） |

## 影响面

- 后端：`github.rs`（新增 `fetch_issue_with_body` + `issue_body_from_json` + 3 条单测）、
  `on_demand.rs`（`LiveIssue.body` + `build_live_issue` + 1 条单测）；
- 前端：新增 `utils/markdown.ts`（含单测）、`types.ts`（`LiveIssue.body`）、
  `utils/liveDetail.ts`（body 归一化）、`components/DetailPanel.tsx`（正文区块）、
  `styles.css`（sticky 头部修正 + 正文排版）；
- i18n：新增 4 个词条（`detail.bodyTitle` / `bodyExpand` / `bodyCollapse` / `bodyEmpty`），
  中英各 429 key；
- **零 DB schema 改动** ⇒ 无需 `check-mcp-columns.py`。

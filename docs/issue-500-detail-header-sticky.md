# 任务详情：issue id 行与标题行固定吸顶 + 消除顶部透明边距 — #500

> 关联 issue：[#500](https://github.com/ShawnLiuSZ/task-dashboard/issues/500)

## 现象

用户反馈（滚动任务详情弹窗时）：

> 向下滚动时，issue id 行和 modal 顶部有一段透明边距，建议 issue id 行和标题行，都不参与滚动。

拆成两条诉求：

1. **顶部透明边距**：滚动后「issue id 行」（`fad-backend #1630`）与弹窗顶边之间冒出一段**纯白空隙**。
2. **标题行不参与滚动**：标题是头部的**兄弟节点** ⇒ 必然随内容滚走；滚动到一半还会被吸顶头部**盖住上半截**
   （#498 的现象之一），只剩一条边露在头部上方。

对用户截图逐像素测量（`screenshot-20261029-141740.png`，弹窗内宽 726px）：

| 位置 | y 坐标 | 颜色 |
|---|---|---|
| 弹窗顶边（外侧） | 0–4 | `(199,199,199)` 看板底色 |
| 弹窗边框 | 5 | `(242,242,242)` |
| **顶部空隙（纯白，无内容）** | **6–40** | **`(255,255,255)`** |
| issue id 行徽章 | 41–59 | `(240,241,243)` 徽章底 |
| issue id 行文字 | 46–55 | 深色字 |
| 头部下边框（分隔线） | 71 | `(242,242,242)` |

⇒ 弹窗顶边与 issue id 行之间有 **35px 纯白空隙**，且**标题只剩一条 11px 高的边**露在头部上方
（`y=11..21`，被吸顶头部盖住下半截）。

## 根因

### 1. `position: sticky` 抵消负 margin ⇒ 钉住位置比正常流低一截

v0.7.10（#494）的头部写法是：

```css
.detail      { padding: 16px 18px; }
.detail-head { position: sticky; top: 0; margin: -16px -18px 0; padding: 16px 18px 8px; }
```

负 margin `-16px` 用来抵消 `.detail` 的 `padding-top`，好让吸顶头部**满宽**。

但 **`position: sticky` 与负 margin 自相矛盾**：sticky 把元素钉到「滚动容器 padding box 顶部」时
**按 border box 对齐** ⇒ 负 margin 的上移效果被抵消 ⇒ **钉住时头部比正常流低 16px**。

于是：

- **未滚动**：头部在正常流位置（比弹窗顶边低 16px），看着正常；
- **滚动后**：头部被钉到「padding box 顶部 + 16px」⇒ 顶部凭空多出 16px 空隙 ⇒ **透明边距**。

（#498 已把 `.detail` 的 `padding-top` 归零、头部改 `margin: 0 -18px`，这一条随之修掉；
但用户看到的是**已发布版本**的行为，且标题固定这条仍未做。）

### 2. 标题是头部的**兄弟节点** ⇒ CSS 无法让它「不参与滚动」

```tsx
<div className="detail-head">…issue id 行…</div>
<h2 className="detail-title">{task.title}</h2>   ← 兄弟节点
```

sticky 只对**自身**生效。标题在头部之外 ⇒ 滚动时照常上移 ⇒ 先被头部盖住上半截，
再滚出视口。**只改 CSS 永远做不到「标题不参与滚动」，必须改 DOM。**

## 修复

### 1. DOM：两行并入**同一个 sticky 容器**（`DetailPanel.tsx`）

```tsx
<div className="detail-head">
  <div className="detail-head-row">
    <div><span className="repo">{task.repo}</span><span className="num">#{task.number}</span></div>
    <button className="btn ghost" onClick={onClose}>{t('btn.close')}</button>
  </div>

  <h2 className="detail-title">{task.title}</h2>
</div>
```

⇒ issue id 行 + 标题行同属一个 sticky 容器 ⇒ 滚动时**一起被钉住**。

### 2. CSS：头部改纵向块，左右分列下沉（`styles.css`）

```css
.detail-head {
  position: sticky;
  top: 0;
  z-index: 1;
  margin: 0 -18px;        /* 只左右撑满宽，绝不上下位移 */
  padding: 16px 18px 10px;
  background: var(--surface);
  border-bottom: 0.5px solid var(--border);
}

.detail-head-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.detail-title { margin: 8px 0 0; }   /* 下 margin 归零：不再与头部 padding 叠加 */
```

⚠️ 头部容器**不能**再是横向 flex —— 否则标题会被排到第一行右侧（不再是「单独一行」）。
横向排布（`repo#编号` | 「关闭」）下沉到 `.detail-head-row`。

## 渲染验证（Chrome 无头，真实 `styles.css` + 真实 DOM 复刻）

视口 1280×900，`/tmp/build_repro500.py` 生成复刻页并注入读数：

| 指标 | 未滚动 | 滚动 120px |
|---|---|---|
| `head.top` 相对 `detail.top` | **1.00px**（= 弹窗自身 1px 边框） | **1.00px** |
| `row.top`（issue id 行） | **17.00px** | **17.00px** |
| `title.top`（标题行） | **52.00px** | **52.00px** |
| 标题是否完全在头部内 | 是 | 是 |
| 标题是否被头部遮挡 | 否 | 否 |
| 弹窗顶部 +2px 处元素 | `DIV.detail-head` | `DIV.detail-head` |
| 弹窗内横向溢出 | — | 无（scrollWidth == clientWidth == 718） |

⇒ 三个关键值在滚动前后**完全一致** ⇒ **两行都固定、不参与滚动**；
弹窗顶部 +2px 命中的始终是 `.detail-head` ⇒ **顶部没有空隙、没有内容透出**。

## 测试

| 位置 | 内容 |
|---|---|
| `app/src/components/detail-panel-head.test.tsx`（新） | 「任务详情头部结构（#500）」3 例 —— 断言落在**真实 SSR 渲染产物**上：标题必须渲染在 `.detail-head` **内部**且紧跟 `.detail-head-row` 之后、头部容器在标题之后闭合 |
| `app/src/styles.test.ts` | 「详情头部两行固定 #500」4 例（头部不得是横向 flex / `.detail-head-row` 必须是 flex + space-between / sticky + top:0 + 不透明背景 / 头部不得有**任何方向**的负 margin / 标题下 margin 归零）+ #498 的 padding 断言同步更新 |

**反向验证（4 处 mutation 全被捕获）**：

| 变异 | 结果 |
|---|---|
| 标题移回 `.detail-head` **之外**（DOM 回归） | `detail-panel-head.test.tsx` 失败（「标题必须渲染在 .detail-head 内部」） |
| `.detail-head` 改回 `display: flex`（横向排布） | `styles.test.ts` 失败（「头部不得是横向 flex」） |
| `.detail-head` 的 margin 改回 `-16px -18px 0` | `styles.test.ts` 失败 2 条（#498 与 #500 各一条） |
| `.detail-title` 的 margin 改回 `8px 0` | `styles.test.ts` 失败（「标题下 margin 归零」） |

## 影响面

- 前端：`components/DetailPanel.tsx`（头部结构）、`styles.css`（头部改纵向块 + 新增 `.detail-head-row` + 标题 margin）；
- 测试：新增 `components/detail-panel-head.test.tsx`（3 例）、`styles.test.ts` 新增 4 例并更新 1 例；
- **零后端 / 零 DB schema / 零 i18n 改动** ⇒ 无需 `check-mcp-columns.py`，i18n 仍为中英各 429 key。

# #475 备忘录瀑布流：某列首卡上边距多 10px

> 对应 issue：[#475](https://github.com/ShawnLiuSZ/task-dashboard/issues/475)
> 分支：`fix/lsz/notes-column-top-alignment`
> 范围：纯 CSS（`app/src/styles.css`）+ 静态断言同步（`notes-layout.test.ts`）

## 一、现象

备忘录面板（CSS multi-column 瀑布流）里，**某一列的首张卡片**比其它列的首卡
**低 10px**。截图实测：第 1、2 列首卡顶部在 `y=87`，第 3 列在 `y=97`。

⚠️ **不是最后一列专属** —— 换一组数据，偏移会出现在**中间列**（首卡 top =
`[8, 18, 8]`）；再换一组又「好了」⇒ 表现为「时有时无」，极难自查。

## 二、根因（WebKit 实测复现）

`column-fill: balance` 的平衡算法取**能放下全部内容的最小列高 H** ⇒
**决定 H 的那一列必然「刚好填满」**。此时该列**末张卡片的 `margin-bottom: 10px`
放不进列框** ⇒ WebKit 把它**画到下一列的顶部** ⇒ 下一列首卡被下推 10px。

实测结论（Playwright + **WebKit**，macOS App 跑的是 WKWebView）：

| 验证项 | 结果 |
|---|---|
| 卡片 `margin-bottom` 归零 | 偏移消失（但卡片贴在一起） |
| 改用 `margin-top: 10px` | 偏移**换了一列**出现，问题依旧 |
| 外层 wrapper（`flow-root` / `padding-bottom`） | 无效 —— 只要间距是「列内最后一个盒子之后的溢出空间」，就会被带到下一列顶部 |
| 间距改为**卡片自身 box 内**的透明下边框 | ✅ 各列首卡全部对齐（7 组数据实测） |

⇒ 结论：**任何「靠外边距/溢出空间实现」的纵向间距都会命中这个坑**；
间距必须落在**卡片的 box 之内**（列高已把它算进去 ⇒ 没有溢出到列外的空间）。

## 三、修法

把纵向间距从「卡片的外部 `margin-bottom`」改成「**卡片自身 box 内的透明下边框**」：

```css
.note-card {
  margin: 0;                        /* 外边距归零 */
  border-bottom-width: 10px;         /* 1px 彩色底边 + 10px 透明间距 */
  border-bottom-color: transparent;
  background-clip: padding-box;      /* 背景不铺进透明边框 ⇒ 间距露出容器底色 */
  box-shadow: inset 0 -1px 0 var(--note-accent, var(--border)); /* 补回彩色底边 */
}
```

- 透明下边框让 **10px 间距在 box 之内** ⇒ 列高已算进去 ⇒ 无溢出 ⇒ 各列对齐；
- `background-clip: padding-box` ⇒ 背景只铺到 padding box ⇒ 透明边框那 10px
  露出**容器底色** = 视觉上的卡片间距；
- 彩色底边被透明边框顶掉 ⇒ 用 **inset 阴影**在 padding box 底边补回 1px。

⚠️ `.note-card:hover` 与 `.note-card.confirming` 都会覆盖 `box-shadow` ⇒
两处都必须**补回 inset 底边**并**显式保持 `border-bottom-color: transparent`**
（否则 hover 时 10px 间距会被填成实色、卡片贴到一起）。

### 视觉零差异

WebKit 逐像素比对（自动高度卡片）：卡片底色范围、彩色四边、**10px 间距**、
**正文位置**全部一致，仅整体上移 1px（`border-bottom` 由 1px 变 10px、
彩色底边改用 inset 阴影补回）。

## 四、验收标准

| # | 标准 | 验证方式 |
|---|---|---|
| 1 | 各列首卡顶部对齐（偏差 0px） | Playwright + WebKit，7 组数据（含「列高恰好填满」那组） |
| 2 | 卡片纵向间距仍是 10px（露出容器底色） | 逐像素比对 |
| 3 | 彩色边框四边齐全 | 逐像素比对（底边由 inset 阴影补回） |
| 4 | hover / 删除确认态正常 | `notes-layout.test.ts` 新增 2 条静态断言 |

## 五、已知边界

| 边界 | 说明 |
|---|---|
| 卡片底角半径 | 背景被裁到 padding box（圆角 10px−1px = 9px）⇒ 底角比原来略方，**亚像素级、不可分辨** |
| 横向边框 | 透明下边框的两端圆角跨越 10px ⇒ 间距在卡片左右角上略宽，**不可分辨** |

## 六、相关链接

- Issue：[#475](https://github.com/ShawnLiuSZ/task-dashboard/issues/475)
- 瀑布流设计（#462）：见 [`issue-462`](https://github.com/ShawnLiuSZ/task-dashboard/issues/462)
  与 `styles.css` 中 `.notes-list` / `.note-card` 的长注释
- CHANGELOG：[`CHANGELOG.md`](./CHANGELOG.md) / [`CHANGELOG.en.md`](./CHANGELOG.en.md)

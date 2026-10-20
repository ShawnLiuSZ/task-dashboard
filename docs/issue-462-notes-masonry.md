# #462 备忘录改为瀑布流（CSS multi-column）

> 关联 issue：[#462](https://github.com/ShawnLiuSZ/task-dashboard/issues/462)
> 分支：`feature/issue-462-notes-masonry`

## 一、背景 / 动机

#456 把备忘录改成了列表（CSS Grid 卡片流），但**同行卡片等高对齐**（grid 默认
`align-items: stretch`）—— 短内容卡片的下方留出空白，版面参差不齐。

改为**瀑布流**：卡片高度随内容自适应，不被同行拉齐。

## 二、关键技术约束：为什么不能用原生 masonry

`grid-template-rows: masonry` 只被 **Chromium 116+** 支持，且生效条件苛刻：

- 必须**显式**写 `grid-template-columns`（`auto-fill` / `auto-fit` 会被拒绝）
- 容器必须有确定 `height`（仅 `min-height` 不够）
- 子项不能有 `grid-row` / `rowspan` / `align-self`
- 子项内部不能有 `position: absolute` / `float` / `contain: layout`

漏一条就**静默退化为单列**（无报错、无日志）。且在 Safari / Firefox 中
`@supports (grid-template-rows: masonry)` **恒为 false** —— 无法可靠做特性检测。

本项目三端 webview：

| 目标 | masonry 支持 |
|---|---|
| macOS WKWebView | ❌ 不支持（Safari 26.4+ 才有实验性的 `grid-lanes`） |
| Linux WebKitGTK | ❌ 不支持 |
| Windows WebView2 | ⚠️ Chromium 116+ 理论支持，但受上述条件限制 |

⇒ 唯一**全引擎可用且零 JS** 的方案：**CSS multi-column**。

## 三、方案与实测参数

```css
.notes-list {
  column-count: 3;        /* 列数（精确值，不随容器自动变） */
  column-gap: 10px;       /* 列间距 */
  column-fill: balance;   /* 必须保留 */
  overflow-y: auto;
}
.note-card {
  break-inside: avoid;    /* 卡片不被切成两半 */
  width: auto;            /* ⚠️ 不能用 100% */
  margin: 0 0 10px;       /* 卡片纵向间距（column-gap 只管列间距） */
}
```

### 3.1 三条实测得出的硬约束

| 参数 | 结论 | 依据 |
|---|---|---|
| `column-fill` | **必须 `balance`** | `auto` 会让内容**退化成单列**（多列容器不产生纵向滚动，而是横向铺开）⇒ 瀑布流完全失效 |
| `column-width` | **不能加** | 它只是「建议」值，浏览器会压缩它以塞进更多列。实测 `column-count: 3` + `column-width: 320px` 在 1154px 容器里仍排 3 列但**卡宽 378px** ⇒ 根本没约束住列宽 |
| 卡片 `width` | **必须 `auto` 不能 `100%`** | 多列流里 `width: 100%` 解析为相对**整个容器**而非列宽。实测单列时卡片撑到 **2688px**（容器 900px）⇒ 横向溢出 |

### 3.2 列数必须用 `@media` 断点写死

`column-count` 是**精确值**，不像 grid 的 `auto-fill` 会随容器宽度自动降列：

```css
@media (max-width: 1400px) { .notes-list { column-count: 2; } }
@media (max-width: 900px)  { .notes-list { column-count: 1; } }
```

断点参照 Tauri 窗口默认 1180×760 与 `minWidth` 900。

## 四、已知取舍（用户已确认）

**列式填充**：浏览器先填满一列再换下一列，阅读顺序是「读完第一列再读第二列」，
与时间倒序的直觉不同。

**#460 的页脚沉底在瀑布流下空转**：卡片不再被拉伸 ⇒ 没有剩余空间可吸收 ⇒
`margin-top: auto` 解析为 0。**保留**该声明：若日后回退到 grid 等高布局，
它立刻重新生效，是一道便宜的保险。

## 五、测试

`components/notes-layout.test.ts` 新增 4 条（瀑布流组）+ 更新既有断言：

| 用例 | 作用 |
|---|---|
| 瀑布流不再是 grid | 断言无 `display: grid` / `grid-template-columns` |
| `column-fill: balance` 必留、不得用 `column-width` | 两条实测约束 |
| `@media` 断点写死列数 | `column-count` 不随容器自动变 |
| 卡片 `break-inside: avoid` + `margin-bottom` | 多列流子项的两处必要声明 |
| 卡片不得用 `width: 100%` | 挡「撑破容器」回归 |

### 反向验证：3 处变异，全部捕获

| 变异 | 捕获 |
|---|---|
| `column-fill: balance` → `auto` | 1 条失败 |
| 卡片 `width: auto` → `100%` | 1 条失败 |
| 删除 `≤900px` 单列断点 | 1 条失败 |

### 渲染复核（无头 Chrome 隔离复现页）

`link` 同一份 `styles.css`，DOM 严格复刻组件。读数取
`computed column-count` + 按 `offsetLeft` 分组的实测列数：

| 视口 | computed | 实测列数 | 卡宽 | 横向溢出 |
|---|---|---|---|---|
| 1440×900 | `column-count: 3` | 3 | 468 | 0 |
| 1180×760 | `column-count: 2` | 2 | 577 | 0 |
| 900×760 | `column-count: 1` | 1 | 884 | 0 |

高度参差实测：`74, 95, 115, 95, 199`（4 种不同高度）⇒ 瀑布流观感成立。
内容可达性：20 张卡滚到底后**视口外卡数 = 0**。

## 六、踩过的坑（记录以免重犯）

### 6.1 测量口径错误导致两次误判

第一次用 `getBoundingClientRect` 判断「卡片是否滚出视口」，得出「12 张卡不可达」
的结论 —— 实际是**测量方法错了**（多列流里元素的 rect 参照系与 grid 不同）。

改用 **offset 口径**（`offsetTop + offsetHeight` vs `scrollTop + clientHeight`）
后得到正确结论：全部可达。

⚠️ **两次都是先怀疑结论、再怀疑自己的测量**。#460 那次也是同类问题。

### 6.2 `--dump-dom` 模式下 `--window-size` 不生效

用 `--dump-dom` 取读数时，三档视口读数完全相同（都是默认宽度 756px）⇒
**误以为媒体查询没生效**。改用 `--screenshot` 模式后视口正常。

⚠️ 读数类验证必须走 `--screenshot`（或用 CDP 设 `Emulation.setDeviceMetricsOverride`）。

### 6.3 浏览器缓存导致变异测试读到旧样式

连续测不同 CSS 组合时读数完全相同 → 是**浏览器缓存了页面**。加随机查询参数
（`?v=$RANDOM`）解决。

### 6.4 `rm` 的 glob 无匹配会中断整条命令

`rm -f shot-*.png` 在无匹配时 zsh 报 `no matches found` 并**中断后续命令** ⇒
截图没生成却以为成功了。分步执行。

## 七、校验

```
npx vitest run                ✅（329 passed，原 325）
npx tsc --noEmit              ✅
npm run lint                  ✅（--max-warnings 0）
npx prettier --check          ✅
npm run i18n:check            ✅
npm run build                 ✅
```

**后端 / DB schema / MCP 工具集 / i18n 零改动。**（纯 CSS + 测试）

## 八、相关链接

- Issue：[#462](https://github.com/ShawnLiuSZ/task-dashboard/issues/462)
- CHANGELOG：[`docs/CHANGELOG.md`](./CHANGELOG.md)
- 相关：[#456](https://github.com/ShawnLiuSZ/task-dashboard/issues/456)（改列表布局，grid 等高对齐是本次的起因）、[#460](https://github.com/ShawnLiuSZ/task-dashboard/issues/460)（页脚沉底，瀑布流下空转但保留）
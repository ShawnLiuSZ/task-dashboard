# 备忘录全屏时列表只占上半屏（#600）

> 用户反馈：窗口最大化 / 全屏后，备忘录页面的列表**只占上半屏**，下半屏是一片空白，
> 滚轮在空白区也无效。本文记录根因、修法与实测数据。

## 背景 / 动机

备忘录页是主区整页（`.notes-page > .notes-panel`，flex 纵向：工具行 + 列表滚动区）。
用户截图（1733×821）像素分析显示：内容止于 **y≈537（65% 高度）**，其下直到窗口底部
都是 `.notes-panel` 的空白底色 —— 不是「被别的面板遮住」，而是**列表容器自己不再长高**。

真机窗口越大，空白越多 —— 典型的「滚动区写了固定高度上限」症状。

## 设计 / 方案

### 根因

`app/src/styles.css` 的 `.notes-scroll` 写死了 `max-height: 520px`：

```css
.notes-scroll {
  flex: 1 1 auto;
  min-height: 0;
  max-height: 520px; /* ← 元凶 */
  overflow-y: auto;
}
```

这个 520px 来自 #465 的窗口假设（Tauri 默认 1180×760，主区约 688px）。但：

- 窗口最大化 / 全屏后主区涨到 **1008px**（1080px 屏），滚动区仍停在 **520px**；
- flex 的 `1 1 auto` 本意是「吃掉剩余高度」，却被 `max-height` 硬截断；
- 多出来的 ~488px 既没有列表、也不接收滚轮事件 ⇒ 用户感知为「半屏被遮住 / 不能用」。

### 修法

删除 `max-height: 520px`，高度完全交给 flex：

```css
.notes-scroll {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  overscroll-behavior: contain;
}
```

- **保留 #465 的「滚动宿主与列容器分离」结构**：`.notes-scroll` 仍是唯一滚动宿主，
  `.notes-list`（CSS multi-column）保持 `height: auto`、不限高、不自带滚动 ——
  否则列高被锁死会让同一条备忘录跨列切断。
- 极窄窗口下由 `flex` 压缩 + `min-height: 0` 保证仍可滚动，不会溢出面板。
- 不采用 `max-height: calc(100vh - Npx)`：主区上方还有顶栏 / 工具行，写死扣除值
  会在字号 / 主题 / 窗口装饰变化时再次失准；flex 分配才是单一事实源。

## 接口 / 行为变更

- **无** API / Tauri command / MCP / DB schema 变更。
- UI 行为：列表滚动区始终撑满 `.notes-panel` 剩余高度；内容不足时无滚动条，
  超出时才出现（与既有滚动语义一致）。

## 测试 / 验收

### 静态回归（`app/src/components/notes-layout.test.ts`）

原先断言 `max-height: 520px`（把缺陷当契约锁住了），改为：

- 仍要求 `flex: 1 1 auto` / `min-height: 0` / `overflow-y: auto` / `overscroll-behavior: contain`；
- **禁止** `.notes-scroll` 出现任何 `max-height` 或固定 `height`。

变异验证（注入 `max-height: 520px` → 测试退出码 1 → 还原），确认断言真的会红。

### Chrome 无头实测（1760×1080，面板高 1008px）

| 场景 | 修前 `.notes-scroll` | 修后 |
|---|---|---|
| 7 张卡 | 520px（下方 488px 死区） | **935px**（到底） |
| 40 张卡 | 520px，`canScroll=true` | 935px，`canScroll=true`，可滚到 2191px |
| 卡片跨列切断 | 0 | **0**（多列行为未回归） |

`.notes-scroll` 计算的 `max-height` 为 `none`，底边与面板底边重合（1080）。

## 相关链接

- Issue：[#600](https://github.com/ShawnLiuSZ/task-dashboard/issues/600)
- 代码：`app/src/styles.css`（`.notes-scroll` / `.notes-list` 注释）
- 测试：`app/src/components/notes-layout.test.ts`
- 前序设计：#465（滚动宿主与列容器分离）、#462（CSS multi-column 瀑布流）、
  #475（卡片间距做进 box）
- CHANGELOG：[`CHANGELOG.md`](./CHANGELOG.md) / [`CHANGELOG.en.md`](./CHANGELOG.en.md)
  的「未发布」条目

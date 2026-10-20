# #460 备忘录卡片页脚永远沉到卡片底部

> 关联 issue：[#460](https://github.com/ShawnLiuSZ/task-dashboard/issues/460)
> 分支：`fix/issue-460-notes-footer-bottom`

## 一、背景 / 动机

用户截图反馈：备忘录列表里，**正文短的卡片**，页脚（优先级标签 + 时间 + 编辑/删除按钮）浮在卡片中部，下方留一大片空白。

对比截图里长正文卡片（「5 天前」那两条）页脚看似正常，**纯属内容恰好够长** —— 属巧合，不是正确行为。

## 二、根因

`.note-card` 是 `display: flex; flex-direction: column`（#456 改列表布局时引入），但 `.note-foot` **没有 `margin-top: auto`**：

```css
.note-card { display: flex; flex-direction: column; gap: 8px; }
.note-foot  { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
```

列表布局用 `grid-template-columns: repeat(auto-fill, minmax(320px, 1fr))`，grid 默认 `align-items: stretch` ⇒ **同一行卡片等高对齐**。

于是：

```
┌─────────────────┐
│ 正文（短）        │  ← 内容自然高度
│ [标签][时间][操作]│  ← 页脚紧跟正文（普通 flow）
│                  │  ← ← ← 剩余空间落在页脚「下面」
└─────────────────┘
```

#456 只把卡片几何对齐了 `.session-card`，漏掉了「卡片等高时页脚要沉底」这一步 —— 这是改布局时典型的连带遗漏。

## 三、方案

### 3.1 三态同时改

不止普通态。编辑态（`.note-edit-foot`）与删除确认态（`.note-confirm-actions`）各有一个底部操作区，**必须同时沉底**，否则同一张卡在三态之间切换时页脚位置会跳变。

三处都是 `.note-card` 的直接子元素（`margin-top: auto` 只在直接 flex 子元素上生效）。

### 3.2 为什么是 `margin-top: auto` 而不是固定 margin

- `auto` 在 flex column 下把**剩余空间吸收到该元素之前** ⇒ 页脚永远贴底。
- **空间不足时 `auto` 解析为 0** ⇒ 长内容卡片的页脚仍紧随正文，不产生额外间隙。
- 固定 margin（如原先 `.note-edit-foot` 的 `margin-top: 6px`）会让长内容卡片也多出这段间隙，且与父级 `gap: 8px` 叠加后间距不一致（8 + 6 = 14px）。

### 3.3 前提依赖

`margin-top: auto` **只在 flex/grid 容器里吸收剩余空间**。若日后把 `.note-card` 改成 `display: block`，该声明会**静默失效**，页脚重新浮在中间 —— 测试对此有专门断言。

## 四、测试

`components/notes-layout.test.ts` 新增 `卡片页脚永远沉底（#460）` 组，4 条：

| 用例 | 作用 |
|---|---|
| 三态底部区都有 `margin-top: auto` | 缺任一处 ⇒ 切换时页脚跳位 |
| 沉底靠 `auto` 而非固定 margin | 堵住「换回 `margin-top: 6px`」 |
| 前提：`.note-card` 是 flex column | 堵住「退回 `display: block` 导致 auto 静默失效」 |
| 三态底部区是 `.note-card` 直接子元素 | 堵住「被包在中间层 div 里，auto 无效」 |

### 反向验证：3 处变异，全部捕获

| 变异 | 捕获 |
|---|---|
| `.note-foot` 去掉 `margin-top: auto`（= 用户报的缺陷本体） | 2 条失败 |
| `.note-edit-foot` 换回固定 `margin-top: 6px` | 2 条失败 |
| `.note-card` 退回 `display: block` | 2 条失败（含 #456 那条「与 `.session-card` 同构」） |

### 渲染复核（无头 Chrome，隔离复现页）

用用户截图里的真实内容复现，读数取「页脚底边到卡片内底边的距离」：

| 卡片 | 距底 | 判定 |
|---|---|---|
| 短正文（systemd / 三方登录 / Resets） | 12px | ✓ 贴底（12px = 卡片 padding） |
| 长正文（pii\backfill 日志） | 12px | ✓ 贴底，且无额外间隙 |
| 编辑态 | 12px | ✓ 贴底 |
| 删除确认态 | 12px | ✓ 贴底 |

## 五、校验

```
npx vitest run                ✅（325 passed，原 321）
npx tsc --noEmit              ✅
npm run lint                  ✅（--max-warnings 0）
npx prettier --check          ✅
npm run i18n:check            ✅
```

**后端 / DB schema / MCP 工具集 / i18n 零改动。**（纯 CSS + 测试）

## 六、相关链接

- Issue：[#460](https://github.com/ShawnLiuSZ/task-dashboard/issues/460)
- CHANGELOG：[`docs/CHANGELOG.md`](./CHANGELOG.md)
- 相关：[#456](https://github.com/ShawnLiuSZ/task-dashboard/issues/456)（引入 flex column 卡片与 grid 等高对齐，本缺陷是它的连带遗漏）
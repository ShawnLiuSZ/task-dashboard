# Liquid Glass 动态光学增强：指针高光 / 倒角描边 / 活背景（#609）

> 用户反馈：#606 的玻璃已经能透出彩色，但与 macOS 27 原生 Liquid Glass 相比仍「像贴膜」。
> 本期确认差距不在参数，而在**材料模型**，补三项纯前端动态光学效果。零新依赖 / 零 DB / 零 Tauri command / 零 API 变更。

## 背景 / 动机

#600 → #603 → #606 已依次交付「毛玻璃开关」「彩色光斑采样源」「3 档透明度 + 静态景深层次」。
#606 把 alpha / blur / saturate 推到 WCAG AA 边界后，继续调数值只会牺牲可读性。实测与参考图对照，差距集中在四处：

| 差距 | 现状 | Liquid Glass |
|---|---|---|
| 高光 | 静态 `inset 0 1px` 一条线 | 镜面高光随视角/指针移动 |
| 描边 | 四边等亮 1px 白边 | 左上亮、右下暗，有厚度与弧度 |
| 背景 | 静态径向渐变，糊完仍是平涂 | 背后内容有细节、有微动 |
| 表面 | 完全平滑 | 细微颗粒打破塑料感 |

结论：**不是模糊不够，是玻璃不"活"**。本期只做 P0 三项；P1（SVG `feDisplacementMap` 折射 / 边缘色散）因 WKWebView 支持差、P2（macOS `NSGlassEffectView` 原生材料）因打破零依赖约束且仅覆盖单平台，明确不做。

## 设计 / 方案

### ① 指针跟随高光

新增 `app/src/glassPointer.ts`：

- **事件委托**挂在 `document` 的 `pointermove` 上，浮层动态挂载/卸载不漏绑、不泄漏。
- `rAF` 节流：**每帧只读一次** `getBoundingClientRect()`（强制布局），只写一次内联 CSS 变量 `--glass-mx` / `--glass-my`。
- 坐标换算抽成纯函数 `glassHighlightAt(clientX, clientY, rect)`，夹紧到 0–100%；零尺寸回退 50%，不产生 `NaN`。
- 入口 `main.tsx` 显式调用 `initGlassPointer()`（幂等）；不自动执行，保持副作用可见、可测。

高光**画在 `background` 层**而非覆盖伪元素：`radial-gradient(240px circle at var(--glass-mx) var(--glass-my), var(--glass-sheen), transparent 72%)`。这样不遮挡正文、不影响焦点环与点击，也不新增层叠上下文。

### ② 四边不等亮倒角描边

浮层 `box-shadow` 由「上亮下暗两条」扩为四条：

| 层 | 声明 | 作用 |
|---|---|---|
| 左上亮边 | `inset 1px 1px 0 var(--glass-highlight)` | 捕捉光，取代四边等亮白边 |
| 内侧柔光 | `inset 0 6px 12px -8px var(--glass-inner-glow)` | 玻璃厚度的倒角 |
| 右下暗边 | `inset -1px -1px 0 var(--glass-shadow-low)` | 与亮边建立弧度 |
| 外投影 | `0 18px 48px var(--glass-shadow)` | 悬浮于彩色底之上（沿用 #606） |

sticky 的 `.detail-head` 沿用同一组 `--glass-mx/--glass-my`（CSS 变量从浮层继承），避免滚动时头/身亮度不连续；头部**不加 grain**，少一层重复纹理重绘。

### ③ 活背景：光斑微动 + 细颗粒

- `.app::before` 挂 `glass-blob-drift` 动画，38s 一轮、幅度 <2%，只动 `transform`（合成层，不触发重排）。肉眼几乎不觉察「在动」，但模糊后的玻璃底不再是静帧。
- `@media (prefers-reduced-motion: reduce)` 下 `animation: none`（WCAG 2.3.3）。
- 细颗粒是**白色点阵** `radial-gradient(circle at 0.5px 0.5px, var(--glass-grain) 0.4px, transparent 0.55px)` + `background-size: auto, 2px 2px, auto`，只叠在**浮层**上。
  ⚠️ Chrome 无头截图实测：初版 3px / alpha 0.5 形成**肉眼可见的规则网格**（像塑料磨砂板，与 Liquid Glass 的光滑相悖）⇒ 降到 2px / alpha 0.18（深色 0.1），近看才有质感。
  ⚠️ 关键决策：曾考虑把灰度噪点铺满 `.app::after`，实测会让浅色主界面原生 `--text-3` 从 4.55 掉到 **4.31**（灰度 128 在浅底上是变暗）⇒ 改为白色点阵且只作用浮层，主界面对比度完全不受影响。

### 令牌（预计算，禁 `color-mix()` / `oklch()`）

| 令牌 | 浅色 | 深色 | 说明 |
|---|---|---|---|
| `--glass-mx` / `--glass-my` | `50%` / `50%` | 继承（无需重定义） | 高光中心，JS 写百分比 |
| `--glass-sheen` | `rgba(255,255,255,0.14)` | `rgba(255,255,255,0.04)` | 镜面高光强度 |
| `--glass-inner-glow` | `rgba(255,255,255,0.12)` | `rgba(255,255,255,0.06)` | 内侧柔光带 |
| `--glass-grain` | `rgba(255,255,255,0.18)` | `rgba(255,255,255,0.1)` | 2px 极淡白色点阵 |
| `--glass-text-3` | `#5d5d5d`（不变） | `#9099a8` → **`#98a1af`** | 深色高光提亮底色后的补偿 |

深色**必须独立重定义**整组颜色令牌，否则沿用浅色值 ⇒ 亮斑 + 对比度崩（延续 #600/#606 纪律）。

## 接口 / 行为变更

- **新模块**：`app/src/glassPointer.ts` 导出 `GLASS_FLOAT_SELECTOR` / `GlassRect` / `glassHighlightAt()` / `initGlassPointer()`。
- **新 DOM 写入**：浮层内联 `--glass-mx` / `--glass-my`（仅在 `pointermove` 后）。不新增属性、不改门禁属性 `data-glass-level`。
- **偏好 / 设置面板 / i18n**：零变更。默认仍关闭，关闭时全部效果不生效。
- **数据 / Schema**：不适用（无 SQLite / DB / API 改动）。

## 对比度复算（真实层叠模型，WCAG AA）

按「光斑 → 遮罩 → 表面 → 高光 → grain（覆盖率 π×0.5²/9×alpha）」逐层混合，取各档最坏底色：

| 档 | 最坏混合底 | `--text` | `--text-2` | `--text-3` | `--accent`（≥3:1） |
|---|---|---|---|---|---|
| 浅 1 通透 | `rgb(228,216,223)` | 11.50 ✅ | 6.21 ✅ | 4.99 ✅ | 3.30 ✅ |
| 浅 2 均衡 | `rgb(230,220,228)` | 11.88 ✅ | 6.23 ✅ | 4.93 ✅ | 3.42 ✅ |
| 浅 3 清晰 | `rgb(234,228,233)` | 12.72 ✅ | 6.05 ✅ | 4.80 ✅ | 3.64 ✅ |
| 深 1 通透 | `rgb(38,55,63)` | 9.21 ✅ | 5.53 ✅ | 4.73 ✅ | — |
| 深 2/3 | `rgb(43,52,59)` | 9.56 ✅ | 5.67 ✅ | 4.86 ✅ | — |

主界面（无遮罩、无 grain）：保持 #606 实测 `--text-3` 4.55–4.75 / `--text-2` 5.85–6.11 / `--accent` 4.04–4.21，全部达标。
⚠️ 若直接把浅色高光 0.14 用在深色，三级文字会掉到 **4.5:1 以下**（实测旧参数下 4.22:1）——这是本期最关键的约束。

## 测试 / 验收

| 文件 | 覆盖 |
|---|---|
| `glassPointer.test.ts`（新） | `glassHighlightAt` 中心 / 相对坐标 / 0–100% 夹紧 / 零尺寸回退；`initGlassPointer` 事件委托只绑一次、rAF 节流、rect 只在 flush 读、只写两个 CSS 变量、非玻璃区域不排帧 |
| `styles.test.ts` | 三层背景（末层仍 `--glass-bg`）+ `background-size`、四边不等亮阴影、动态令牌浅深各一套且深色高光更弱、光斑动画 + reduced-motion、sticky 头高光连续；更新深色补偿色断言 |
| 变异验证 | 5 组注入全部变红、还原基线全绿：删高光层引用 / 深色高光改 0.14 / 删 reduced-motion 块 / 删漂移动画 / 倒角退回均匀描边 |

### 验收标准

- [x] 指针在浮层移动时高光跟随，不遮挡点击与焦点环
- [x] 描边四边亮度不等，有内侧柔光带
- [x] 光斑微动 + 细颗粒；reduced-motion 下静止
- [x] 三档 × 浅深 × 浮层/主界面四列对比度全部达标（含新增高光与 grain）
- [x] 门禁边界不回退：`.detail-window` / `.panel-page .modal` 仍实心
- [x] 默认关闭零视觉回归；零新依赖 / DB / API / Tauri command 变更

## 相关链接

- Issue：[#609](https://github.com/ShawnLiuSZ/task-dashboard/issues/609)
- 前序：[`glass-effect.md`](./glass-effect.md)（#600）· [`issue-603-glass-visibility.md`](./issue-603-glass-visibility.md) · [`issue-606-liquid-glass-origin.md`](./issue-606-liquid-glass-origin.md)
- 代码：`app/src/glassPointer.ts` · `app/src/main.tsx` · `app/src/styles.css`
- 测试：`app/src/{glassPointer,styles}.test.ts`
- CHANGELOG：`docs/CHANGELOG.md` / `docs/CHANGELOG.en.md`（未发布条目）

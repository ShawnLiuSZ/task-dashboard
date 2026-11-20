# 毛玻璃效果（用户可开关）· frosted glass

> 用户请求：**「增加毛玻璃效果，可以通过开关控制」**。本期为 TaskBoard 界面视觉新增，
> 纯前端（零新依赖 / 零 DB / 零 Tauri command / 零 API 变更）。
> 后续并入 GitHub issue [#600](https://github.com/ShawnLiuSZ/task-dashboard/issues/600)
> （该 issue 同时包含「备忘录全屏列表只占半屏」修复与代码审查发现的四类毛玻璃缺陷）。

## 背景 / 动机

TaskBoard 的浮动表面（弹窗 `.modal`、详情 `.detail`、以及若干 modal 变体）目前都是
**实心不透明**（`background: var(--surface)`），悬浮在遮罩（`.modal-mask` /
`.detail-backdrop`）之上。用户希望提供一种「毛玻璃」质感选项：开启后这些浮动表面
呈半透明磨砂（`backdrop-filter: blur()`），透出并柔化背后的看板内容；关闭恢复实心。

需求约束：**可通过设置面板开关控制**，且需本地持久化 + 即时生效（与主题 / 字体偏好同款
「即时生效」契约，见 `theme.ts` / `fontPrefs.ts`），并兼容深浅两套主题与 WCAG AA。

## 设计 / 方案

### 范围决策（哪些表面启用毛玻璃）

| 元素 | 启用 | 理由 |
|---|---|---|
| `.modal`（含 `.about-modal` / `.confirm-modal` / `.note-*-modal` / `.sync-logs-modal`，皆以 `.modal` 为基类） | ✅ | 覆盖在 `.modal-mask` 遮罩之上，背后确有内容可模糊 |
| `.detail:not(.detail-window)`（详情弹窗）+ 其 `.detail-head`（sticky 头部） | ✅ | 覆盖在 `.detail-backdrop` 之上，背后确有内容；sticky 头随面板一起半透明，避免滚动时出现实心横带 |
| `.modal-mask` / `.detail-backdrop`（遮罩） | ❌ | 模糊遮罩会把整层背景糊掉、失去空间层次感（保持实心 `--overlay`） |
| `.detail.detail-window`（#526 独立任务详情窗） | ❌ | 整窗页面（`border: none; background: var(--bg)`），背后是系统桌面而非应用内容，模糊无层次且会把整窗变成半透明 + 描边 |
| `.panel-page .modal`（设置 / 账号 / 同步日志） | ❌ | 复用 `.modal` 结构但**整页替换**布局，背后无内容可模糊；须复位为实心面（`.confirm-modal` 除外，它是真浮层） |
| `.sidebar` / `.panel-page` / `.notes-panel` | ❌ | 并列或替换布局，背后**无内容可模糊**，启用无视觉效果（`backdrop-filter` 只模糊背后已绘内容） |

### 实现方式

1. **偏好模块 `app/src/glassPrefs.ts`**（与 `theme.ts` / `fontPrefs.ts` 同款范式）：
   - localStorage key `taskboard.glassEffect`，只有显式存 `on` 才算开启（缺失 / 脏值一律关）。
   - `glassPrefs.getEnabled()` / `setEnabled(on)` / `applyGlass(on)`。
   - 开启 → `<html data-glass="on">`；关闭 → 移除该属性（不残留旧值）。
   - **模块加载即应用**（防 FOUC）。
   - 只写布尔属性、无任意值面 ⇒ 不构成 CSS 注入面（对比 fontPrefs 的白名单是同类防御）。
2. **CSS 门禁 `styles.css`**：`html[data-glass='on'] .modal, .detail:not(.detail-window) { ... }`。
   - `background: var(--glass-bg)`（半透明底）。
   - `border: 0.5px solid var(--glass-border)`（毛玻璃补一道边缘描边；`.modal` 原本无描边）。
   - `-webkit-backdrop-filter` + `backdrop-filter: blur(16px) saturate(1.4)`（**双前缀**，Safari 15 需 `-webkit-`）。
   - `--text-3: var(--glass-text-3)`（三级文字**作用域覆盖**补偿，见对比度）。
   - `.detail:not(.detail-window) .detail-head` 同款半透明 + 模糊（`--glass-bg-strong`）。
   - **#600 复位** `html[data-glass='on'] .panel-page .modal:not(.confirm-modal)`：
     `background: var(--surface)` + `border: none` + `backdrop-filter: none` +
     `--text-3: inherit`（还原主题三级文字色）。选择器多一层 `.panel-page` ⇒
     特异性高于门禁，无需 `!important`；`.confirm-modal` 保留毛玻璃（真浮层）。
3. **设置面板 `SettingsPanel.tsx`**：主题字段下新增 `.field` + `.toggle` 开关
   （`.toggle` + `.slider`，沿用既有开关组件样式与三段式焦点环），onChange 同时
   `setGlassEnabled` + `glassPrefs.setEnabled`（即时生效）。
   checkbox 补 `aria-label={t('settings.glassEffect')}`（可见 `<label>` 是兄弟节点、无
   `htmlFor`；`.toggle` 内无文本 ⇒ 不补则无可访问名）。同一问题一并修掉「自动检查更新 /
   自动更新」两个既有开关（#600）。
4. **i18n**：`settings.glassEffect` / `settings.glassEffectHint`（中英双语）。

### 设计令牌（预计算，禁 color-mix）

> ⚠️ build target = chrome105(win) / safari13(其他)，`color-mix()` / `oklab()` /
> `oklch()` 不可用且 Vite 不降级（声明整条丢弃）⇒ 全部预计算 rgba/hex，浅深两套。

| 令牌 | 浅色 | 深色 | 说明 |
|---|---|---|---|
| `--glass-bg` | `rgba(255,255,255,0.82)` | `rgba(35,39,47,0.78)` | 表面半透明底 |
| `--glass-bg-strong` | `rgba(255,255,255,0.86)` | `rgba(35,39,47,0.84)` | sticky 头部（更不透明） |
| `--glass-blur` | `16px` | `16px`（沿用 `:root`） | 模糊半径 |
| `--glass-saturate` | `1.4` | `1.4`（沿用 `:root`） | 饱和度 |
| `--glass-border` | `rgba(16,20,28,0.16)` | `rgba(255,255,255,0.16)` | 面板描边（比 `--border` 略强） |
| `--glass-text-3` | `#5f6875` | `#9099a8` | 磨砂底三级文字（补偿，见下） |

### 文字对比度（WCAG AA ≥ 4.5:1，对混合后的实际底色）

磨砂底 = 遮罩 `--overlay` 压看板背景后，再叠半透明表面。逐层混合（REST 模型）实测：

| 层级 | 浅色（最暗混合底 `#ebebec`） | 深色（最暗混合底 `#1e2229`） |
|---|---|---|
| `--text` | **14.92** ✅ | **13.23** ✅ |
| `--text-2` | **5.55** ✅ | **7.14** ✅ |
| `--text-3`（原生 `#666e7b`） | 4.32 ❌ → 补偿 `#5f6875` = **4.73** ✅ | **5.55** ✅ |
| `--accent`（非文字，1.4.11 ≥3:1） | 3.83 ✅ | 5.79 ✅ |

**结论**：仅浅色 `--text-3` 需补偿 —— 磨砂底比实心面略暗 ⇒ 三级文字加深一档
（`--glass-text-3 #5f6875`）。用**作用域覆盖**（在门禁规则内 `--text-3: var(--glass-text-3)`）
而非改全局令牌，只影响该面板及其后代。`--accent` 是填充色 / 非文字指示（焦点环、色块），
按 1.4.11（≥3:1）达标；项目已约定文字用 `--info`，故不涉文字对比度。

> ⚠️ 深色**必须**单独定义 `--glass-text-3`（否则深色沿用浅色 `#5f6875` ⇒ 深底上看不见）；
> 深色磨砂底上原生 `--text-3` 已 5.55:1，取其值即可。

### 交互 / 焦点

- `backdrop-filter` 会创建新层，但 `outline` 画在元素自身边界、不受其影响 ⇒ 焦点环
  （不透明 `--accent`，三段式）在毛玻璃表面上仍可识别。
- `.detail-head` 是 sticky：sticky 定位与 backdrop-filter 创建的新包含块**无关**，
  钉住位置不受影响。

## 接口 / 行为变更

- **新偏好**：`localStorage["taskboard.glassEffect"]` ∈ `{缺失, "on"}`（默认关闭）。
- **新 DOM 属性**：开启时 `<html data-glass="on">`。
- **新设置项**：设置 → 基础 → 「毛玻璃效果」开关（即时生效，不点保存）。
- **行为**：开启后 `.modal` / `.detail` 半透明磨砂；关闭恢复实心。默认关闭 ⇒ **既有视觉零回归**。
- **零**：新依赖 / DB schema / Tauri command / API / 后端变更。

## 测试 / 验收

### 已跑检查（全部通过）

```bash
cd app
npm test            # 641 passed（38 files；含 glassPrefs 8 + 接线 5 + CSS 门禁 7）
npx tsc --noEmit
npm run i18n:check
npm run build       # vite build 成功
npm run lint
npx prettier --check "src/**/*.{ts,tsx,css}"
python3 scripts/check-doc-links.py
```

### 新增测试

| 文件 | 覆盖 |
|---|---|
| `app/src/glassPrefs.test.ts` | 默认关 / 只认显式 `on` / 脏值回落 / 门禁属性写入（开→`data-glass="on"`，关→移除）/ `applyGlass` 直调 / **模块加载即应用**（`vi.resetModules` + 动态 import，复现「首屏读持久化」路径） |
| `app/src/settings-groups.test.ts` | 开关接线：`handleGlassChange` 同时 setState + 写 glassPrefs；初值来自 `glassPrefs.getEnabled()`；渲染 `.toggle` + `.slider` + i18n label/hint + onChange；**三个 toggle 的 checkbox 均须有 `aria-label`**（#600） |
| `app/src/styles.test.ts` | 门禁**逐条规则**校验（`glassRule('.modal')` / `glassRule('.detail:not(.detail-window)')` 各自双前缀 + 令牌）；`.detail-window` 不被裸 `.detail` 命中；`.panel-page .modal` 复位实心面 / 去描边 / 禁模糊 / 还原 `--text-3`；`--glass-text-3` 浅深两套 + 门禁作用域覆盖；`--glass-bg` 深色块重定义；禁 `color-mix` |

> ⚠️ 断言纪律（见 `docs/methodology-assertion-strength-audit.md`）：CSS 门禁断言为
> **结构/存在性**断言（`?raw` 源码，剥注释），配合上方**对比度实测**（数学计算）与
> **Chrome 无头渲染冒烟**（开启：毛玻璃透底模糊、文字可读；关闭：实心）三方互证。
>
> #600 修掉一个**变异盲点**：原断言跑在「所有 `data-glass` 规则合并文本」上，
> `.detail-head` 的 `backdrop-filter` 会替 `.modal / .detail` 顶包 —— 删掉后者的
> `backdrop-filter` 测试仍绿。现改为 `glassRule(selector)` 按**选择器全等**取单条规则体，
> 并做了 4 组变异验证（删 backdrop-filter / 裸 `.detail` / 删 panel-page 复位 /
> 给 `.notes-scroll` 加回 max-height），全部按预期变红。

### 验收标准（逐项）

- [x] 设置面板出现「毛玻璃效果」开关，默认关闭
- [x] 开启立即生效（弹窗 / 详情呈半透明磨砂），关闭立即恢复实心
- [x] 重启后开关状态保持（localStorage 持久化）
- [x] 浅色 / 深色主题各自正确（深色不沿用浅色令牌）
- [x] 面板上 `--text-2` / `--text-3` 文字对比度 ≥4.5:1（实测 5.55 / 4.73 浅、7.14 / 5.55 深）
- [x] 键盘焦点环在毛玻璃表面上可见（不透明 `--accent` outline）
- [x] 默认关闭 ⇒ 既有视觉零回归
- [x] 零新依赖 / 零 DB / 零 API 变更
- [x] （#600）独立任务详情窗 `.detail.detail-window` 不被门禁命中：背景仍为 `--bg`、无描边、无模糊（Chrome 实测）
- [x] （#600）`.panel-page` 内嵌面板（设置 / 账号 / 同步日志）开启毛玻璃后仍为实心 `--surface` + 无描边 + 无模糊；`.confirm-modal` 保留毛玻璃（Chrome 实测）
- [x] （#600）三个 `.toggle` 的 checkbox 均有可访问名（`aria-label`）

## 相关链接

- Issue：[#600](https://github.com/ShawnLiuSZ/task-dashboard/issues/600)
- 同 issue 另一修复：[`issue-600-notes-fullscreen-scroll.md`](./issue-600-notes-fullscreen-scroll.md)
  （备忘录全屏列表只占半屏）
- 代码：`app/src/glassPrefs.ts`（新）· `app/src/styles.css`（令牌 + 门禁）·
  `app/src/components/SettingsPanel.tsx`（开关）
- 测试：`app/src/glassPrefs.test.ts`（新）· `app/src/settings-groups.test.ts` ·
  `app/src/styles.test.ts`
- 相关既有文档：`docs/v0.8.9-ui-visual-refresh.md`（设计令牌 / WCAG / 焦点环纪律）、
  `docs/methodology-assertion-strength-audit.md`（断言纪律）、
  `docs/ui-design-handoff.md`（R1–R10 红线：不新增 `--*-bg` 令牌系针对该交接单，
  本期 `--glass-*` 为功能所需、非背景类泛滥）
- CHANGELOG：`docs/CHANGELOG.md` / `docs/CHANGELOG.en.md`（未发布条目）

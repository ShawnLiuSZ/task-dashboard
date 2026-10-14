# Issue #444：可调界面字号 + 选择系统已安装字体

## 背景 / 动机

用户诉求：**「可以设置字体大小和选择系统安装的字体」**。

改造前的现状（v0.7.1）：

| 项| 状态 |
|---|---|
| 正文 `font-family` | 硬编码 `-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Helvetica Neue', sans-serif`（`styles.css` `body`） |
| 正文 `font-size` | 硬编码 `13px` |
| 等宽字体 | **8 处**散落硬编码 `font-family: 'SF Mono', Menlo, monospace` |
| `--font-mono` 变量 | 在 `.session-meta-value`（`:2282`）**被引用却从未定义** —— 一直靠 `font-family` 声明缺失时的 fallback 侥幸渲染 |

用户无法调整字号（13px 对高 DPI / 视力不佳者偏小），也无法换字体（中文用户若偏好思源、Noto 等需改系统字体名）。

## 关键技术约束：Web 平台无法枚举系统字体

**浏览器不允许读取「已安装字体列表」**（安全沙箱限制，`queryLocalFonts()` 至今未普及）。字体只能按名字交给 CSS 解析 ⇒ 判断「本机有没有某款字体」只能用**探测**。

因此实现方案是：**内置候选清单（覆盖中英常用 25 项）+ canvas 宽度探测过滤**，只把本机真实存在的字体列进下拉框。

### 为什么用 canvas 宽度差，而不是 `document.fonts.check()`

`document.fonts.check()` 对**系统字体**（非 `@font-face` 加载的 web font）**恒返回 true** —— 它只反映「该字体是否已加载完成」，而系统字体从不经过加载流程 ⇒ 用它会把全部 25 个候选都判为「可用」，探测形同虚设（用户选了没装的字体，界面毫无变化且无提示）。

`detectAvailableFonts()` 的判据：

```
设 ctx.font = "72px <候选名>, monospace" → 测宽 w1；基准 "72px monospace" = baseMono
设 ctx.font = "72px <候选名>, sans-serif" → 测宽 w2；基准 "72px sans-serif" = baseSans
命中 ⟺ |w1 - baseMono| > 0.5 且 |w2 - baseSans| > 0.5
```

**双基准与条件**是必要的：只测单一基准（或只用 `&&` 的一半）会把「碰巧在某宽度下与基准不同」的字体误列为可用。两条栈都产生宽度差异，才证明字体确实被采用。

## 设计 / 方案

### ① 独立模块 `fontPrefs.ts`（复用 `theme.ts` 范式）

模块单例 + `localStorage` + **模块加载时立即应用**（避免 FOUC）。与主题偏好（`taskboard.theme`）完全同构，无新依赖。

三个 CSS 变量（写在 `<html>` 内联样式上）：

| 变量 | 作用 |
|---|---|
| `--font-size-base` | 基准字号，档位预设 12/ 13 / 14 / 16 / 18px |
| `--font-ui` | 界面字体栈：所选字体在最前，后接跨平台兜底 |
| `--font-mono` | 等宽字体栈；「跟随界面」时把界面字体也纳入 |

### ② CSS 收编硬编码

- `body` 的 `font-family` / `font-size` 改走 `var(--font-ui)` / `var(--font-size-base)`。
- **8 处** `font-family: 'SF Mono', Menlo, monospace` → `var(--font-mono)`。
- 顺带修掉 `--font-mono` 未定义的既存缺陷。

### ③ 字号只转「主层级」，徽章/meta 保持 px

全站 `font-size` 共 83 处，分布 `10px×15 / 11px×29 / 12px×20 / 13px×12 / 14px×4 / 20 / 26 / 34`。

**只把 13px（10 处）与 14px（5 处）转为 rem**（`0.8125rem` / `0.875rem`），其余保持 px。理由：

- 10 / 11 / 12px 承担的是**与基线字号解耦**的语义——徽章角标、meta 行、图标文字、代码块。它们刻意比正文小，改成 rem 会连带改变徽章圆角、行高与列宽的配合关系，回归面远大于收益。
- 20 / 26 / 34px 是弹窗标题 / 空态插画等大字号，与用户调正文大小的意图无关。

### ④ 安全：字体名白名单（防CSS 注入）

`localStorage` 可被同源脚本写脏，而 `style.setProperty()` 的值直接进 CSS。若无校验，`"; background: url(evil)` 这类载荷会被注入。

`safeFamily()` 只接受**探测清单内**的名字，其余一律回落为空串（跟随默认）。

### ⑤ 设置面板 UI

- **字号**：5 档 chip（复用既有 `.presets` / `.chip` 样式）+ `aria-pressed`，**点击即生效**。
- **界面字体 / 等宽字体**：下拉，首项为「跟随系统默认」/「跟随界面字体」；探测未完成时显示提示而非空下拉。
- **预览行** `.font-preview`：用**所选字体本身**内联渲染（`previewStyle()`），所见即所得。
  ⚠️ 不能只依赖全局变量——那样在「选了A又切回跟随」这类边界值时会滞后一帧（应用与渲染不同批）。

### ⑥ 等宽字体默认「跟随界面」

用户只选一款字体时，分支名 / 路径 / session id 一并跟随，无需再选一次；需要单独指定时仍可覆盖。

## 接口 / 行为变更

### 新增模块

| 导出 | 说明 |
|---|---|
| `FONT_SIZE_PRESETS` / `FontSizePreset` | 字号档位 `[12, 13, 14, 16, 18]` |
| `DEFAULT_FONT_SIZE` | 基准13px（= v0.7.1 正文大小，**保证零偏好时像素级不变**） |
| `DEFAULT_FONT_FAMILY` / `DEFAULT_MONO_FAMILY` | 空串 = 跟随 |
| `getFontSize()` / `getFontFamily()` / `getMonoFamily()` | 读偏好（非法值回落默认） |
| `applyFontPrefs(size?, family?, mono?)` | 写 CSS 变量；传参时不读持久化 |
| `detectAvailableFonts()` | 探测本机可用候选子集 |
| `fontPrefs` | `setFontSize` / `setFontFamily` / `setMonoFamily` / `apply` |

### 持久化键

`taskboard.fontSize` / `taskboard.fontFamily` / `taskboard.monoFamily`（`localStorage`，**不进后端 Settings**）。

### 行为变更

| 项 | 变更 |
|---|---|
| 设置 → 基础 页签 | 新增 4 个区块（字号 / 界面字体 / 等宽字体 / 预览） |
| i18n | 新增 **9 键 × 2 语种**（401 → **410**） |
| 后端 / SQL / DB schema | **零改动** |
| 零偏好时的渲染 | **与 v0.7.1 逐字一致**（`:root` 默认值 = 原硬编码值） |

## 数据/ Schema 变更

无。偏好走 `localStorage`，不进 SQLite。

## 测试 / 验收

### 新增回归

| 文件 | 用例 | 覆盖 |
|---|---|---|
| `app/src/fontPrefs.test.ts` | **17** | 非法值回落 / CSS 变量写入 / **注入白名单** / 探测判别力 |
| `app/src/styles.test.ts` | +5 | 三变量有定义 / `body` 走变量 / 8 处硬编码清零 / rem-vs-px 边界 |
| `app/src/settings-groups.test.ts` | +5 | 三处理函数即时生效 / 探测时机 / 下拉只渲染探测结果 / 预览内联 |

### 反向验证（mutation，4/4 捕获）

| 注入变异 | 捕获 |
|---|---|
| `safeFamily` 移除白名单（CSS 注入面） | ✅ |
| 字号不再回落默认（非法值透传） | ✅ |
| 探测去掉双基准校验（只测 monospace） | ✅ |
| 等宽「跟随界面」时不再带界面字体 | ✅ |

### 全量

`vitest` **322 passed**（24 文件，+32）· `tsc` · `eslint --max-warnings 0` · `prettier` · `i18n:check` **410 key** · `npm run build` · `check-doc-links` 217 文件，全绿。

### 边界场景

| 场景 | 期望 |
|---|---|
| 无 canvas 环境（老旧WebView） | 返回空数组，面板只显示「跟随系统默认」，不崩 |
| 探测不到任何候选字体 | 同上，不显示空下拉 |
| localStorage 被写入非法字号 `abc` / `100` | 回落 13px，绝不透传到 CSS |
| localStorage 被注入 `"; background: url(...)` | 白名单挡下，回落跟随默认 |
| 用户选了本机没有的字体（探测竞态） | 跨平台兜底栈生效，不白屏、不变形 |
| 切换字号时正在看预览 | 预览与正文同步缩放（都用 rem） |

## 遗留 / 未来可做

- **候选清单外的字体无法选择**（如思源黑体、Noto 变体等小众字体）。受Web 平台限制无法枚举，若`queryLocalFonts()` 普及可平滑升级为真枚举。
- 候选清单可后续按需扩充（扩充只影响 `UI_FONT_CANDIDATES`，探测逻辑不变）。

## 相关链接

- 源issue：用户诉求「可以设置字体大小和选择系统安装的字体」
- 相关：#308（主题偏好，本功能复用其 `themeManager` 范式）、#441（会话面板刷新）、#418（会话 meta 换行）
- 代码：`app/src/fontPrefs.ts`、`app/src/components/SettingsPanel.tsx`、`app/src/styles.css`（`:root` / `body` / `.font-preview`）
- 回归：`app/src/fontPrefs.test.ts`、`app/src/styles.test.ts`、`app/src/settings-groups.test.ts`
- CHANGELOG：[`CHANGELOG.md`](./CHANGELOG.md)
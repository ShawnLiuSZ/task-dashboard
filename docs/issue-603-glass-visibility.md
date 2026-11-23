# 毛玻璃可见性修复：全界面彩色光斑底 + 玻璃层次增强（#603）

> 用户反馈「这个 app 没有做出毛玻璃效果来」。核查发现 #600 的实现**代码链路完整**，
> 但视觉上约等于一块半透明色板。本期修复其根因并保持「默认关闭」的零回归承诺。
> 纯前端，零新依赖 / 零 DB / 零 Tauri command / 零 API 变更。

## 背景 / 动机

#600 已交付毛玻璃开关（`app/src/glassPrefs.ts` + `styles.css` 门禁 + 设置面板开关），
测试、对比度计算、Chrome 冒烟一应俱全。但用户实测感受是「没做出效果」。
对照用户提供的参考图（音乐播放器玻璃卡片）与其"4 要素"配方，差距明确。

**根因诊断**（三层叠加）：

1. **无内容可糊（根因中的根因）**：`backdrop-filter` 只模糊「元素背后已绘制的内容」。
   TaskBoard 全界面是纯色令牌（`--bg #eef0f4`、列背景 `--surface-2`、遮罩 `--overlay`
   半透明黑），**没有彩色渐变或光斑**。模糊纯色与不模糊在视觉上几乎没有区别——
   这正是参考配方里那句「纯色背景上看不出玻璃感」。
2. **填充太不透明**：`--glass-bg` 为 `rgba(255,255,255,0.82)`，只透出 18%，
   而参考图填充透明度约 0.16–0.18（透出 82%）。
3. **缺层次**：原实现无 `inset` 高光、无外投影、描边仅 0.5px，玻璃"浮不起来"。
   叠加作用范围仅限 `.modal` / `.detail` 浮层，主看板/侧栏/顶栏完全没有玻璃质感。

## 设计 / 方案

### 三管齐下

| 改动 | 手段 | 解决的要素 |
|---|---|---|
| ① 彩色光斑底层 | `.app::before` 用 4 处 `radial-gradient`（紫/青/粉/橙），`position:fixed` + `pointer-events:none` + `z-index:var(--z-base)` | 提供可模糊内容；滚动时玻璃底不动 |
| ② 半透明表面采样 | 主界面（`.sidebar`/`.topbar`/`.column`）用 `--glass-surface` 0.72；浮层（`--glass-bg`）0.68，均补 `backdrop-filter` 双前缀 | 透出并柔化背景（要素 ①②） |
| ③ 层次增强 | 浮层 `border: 1px` + `inset 0 1px` 高光 + `0 12px 40px` 外投影 | 描边高光 + 内阴影 + 外投影（要素 ③④） |

### 关键决策

- **主界面纳入范围**：#600 曾判定侧栏/顶栏「背后无内容可模糊」而不启用；
  ① 的彩色底推翻了该前提，故 #603 纳入。选 `.column` 而非 `.card`，因卡片数量多、
  透明叠加会放大对比度风险；列级玻璃已足够呈现质感。
- **光斑用 fixed 伪元素而非改 `body` 背景**：滚动时玻璃底稳定；`pointer-events:none`
  保证不遮挡交互；`z-index:var(--z-base)` 走令牌（项目硬约束：z-index 不得有字面量）。
- **双主题各一套光斑与令牌**：深色块 `[data-theme='dark'][data-glass='on'] .app::before`
  单独定义（否则沿用浅色值产生亮斑），与 #600「深色覆盖块必须补全」纪律一致。
- **默认仍关闭**：延续 #600 的既有视觉零回归承诺。`main.tsx` 补
  `import './glassPrefs'` 兑现模块加载即应用——此前仅靠 `SettingsPanel` 间接 import，
  独立窗（about / task-detail）不挂设置面板，首屏不会应用已持久化的玻璃门禁。

### 令牌与对比度（真实层叠模型实测，WCAG AA ≥4.5:1）

按「彩色光斑 → 遮罩 `--overlay` → 半透明表面」逐层混合，取最坏底色：

| 令牌 | 浅色 | 深色 | 最坏混合底（浅/深） |
|---|---|---|---|
| `--glass-surface` | `rgba(255,255,255,0.72)` | `rgba(35,39,47,0.72)` | `rgb(241,238,253)` / `rgb(35,46,55)` |
| `--glass-bg` | `rgba(255,255,255,0.68)` | `rgba(35,39,47,0.68)` | `rgb(213,212,222)` / `rgb(29,35,42)` |
| `--glass-bg-strong` | `rgba(255,255,255,0.78)` | `rgba(35,39,47,0.78)` | sticky 头部 |
| `--glass-blur` | `20px` | 沿用 `:root` | — |
| `--glass-saturate` | `1.4` | 沿用 `:root` | — |
| `--glass-border` | `rgba(16,20,28,0.18)` | `rgba(255,255,255,0.18)` | 1px 描边 |
| `--glass-highlight` | `rgba(255,255,255,0.7)` | `rgba(255,255,255,0.12)` | inset 顶边高光 |
| `--glass-shadow` | `rgba(16,20,28,0.2)` | `rgba(0,0,0,0.5)` | 外投影 |
| `--glass-text-2` | `#4a505c` | `#a6aebc` | 浮层 --text-2 补偿 |
| `--glass-text-3` | `#525a67` | `#9099a8` | 浮层 --text-3 补偿 |

**四列字色矩阵**（浮层最坏底 `rgb(213,212,222)` / 主界面 `rgb(241,238,253)`，浅色）：

| 字色 | 值 | 浮层 | 主界面 | 判定 |
|---|---|---|---|---|
| `--text` | `#15181e` | 12.09:1 | 15.59:1 | ✅ |
| `--text-2` | 原生 `#565d6b` → 补偿 `#4a505c` | 4.50 ❌ → 5.51 ✅ | 5.80 ✅ | ✅ |
| `--text-3` | 原生 `#666e7b` → 补偿 `#525a67` | 3.50 ❌ → 4.73 ✅ | 4.51 ✅ | ✅ |
| `--accent` | `#0a6cff`（非文字，门槛 ≥3:1） | 3.10 ✅ | 4.00 ✅ | ✅ |

深色浮层 `rgb(29,35,42)` / 主界面 `rgb(35,46,55)`：`--text` 13.11/11.43、`--text-2`
7.08/6.17、`--text-3` 5.50/4.80、`--accent` 5.74/5.01，全部达标。
⚠️ 深色补偿色显式定义（取原生值），保持门禁作用域一致并防沿用浅色值。

> 全部预计算 rgba/hex，`color-mix()` / `oklch()` 在 `chrome105` / `safari13`
> build target 下不可用且 Vite 不降级（声明整条丢弃），故不使用。
> `backdrop-filter` 双前缀（`-webkit-` 供 Safari 15、标准供 Chrome 105+）。

## 接口 / 行为变更

- 无 API / Tauri command / DB / schema 变更；i18n 文案沿用 #600（开关语义未变）。
- 行为：开启后主界面（侧栏/顶栏/看板列）与浮层（弹窗/详情）均呈彩色磨砂玻璃；
  关闭恢复实心。默认仍关闭。
- 新增 DOM 副作用：`html[data-glass='on'] .app::before` 彩色光斑层（纯装饰、不接收事件）。
- 入口 `main.tsx` 新增 `import './glassPrefs'`（模块加载即应用，覆盖独立窗）。

## 测试 / 验收

### 已跑检查

```bash
cd app
npx vitest run src/styles.test.ts          # 92 passed（含 #603 新增 4 组门禁断言）
npx tsc --noEmit / npm test / npm run build / npm run i18n:check / npm run lint
npx prettier --check "src/**/*.{ts,tsx,css}"
python3 scripts/check-doc-links.py
```

### 新增/更新测试

| 文件 | 覆盖 |
|---|---|
| `styles.test.ts` | ① 光斑底层：`position:fixed` / `pointer-events:none` / ≥3 处 `radial-gradient` + **逐处锁定三色**（变异验证：删首处紫色光斑变红）；深色光斑块存在。② 主界面三表面逐个双前缀 + `--glass-surface`。③ 浮层 1px 描边 + inset 高光 + 外投影 + `--text-2/-3` 双补偿。④ `.detail-window` / `.panel-page .modal` 复位实心 + 去高光投影 + 还原双字色。⑤ 令牌表 0.68/0.72/20px + 深色全套重定义。 |

> ⚠️ 断言纪律（见 `docs/methodology-assertion-strength-audit.md`）：
> CSS 判据为「选择器全等取单条规则体」的结构断言 + **反向变异验证**
> （基线绿 → 删紫色光斑/改 0.5px 描边变红 → 还原全绿）+ Chrome 无头真实渲染互证。

### Chrome 无头渲染实测

- 主界面（无遮罩）：背景呈紫/青/粉彩色光斑，看板列半透明磨砂，文字清晰 ⇒ 接近参考图玻璃质感。
- 浮层（有遮罩）：弹窗半透明 + inset 高光 + 外投影 + 1px 描边，背景彩色可见。
- 计算样式注入读数：`.app::before` = `radial-gradient` / `fixed` / `z-index:var(--z-base)` /
  `pointer-events:none`；主界面与浮层 `backdrop-filter` = `blur(20px) saturate(1.4)`。

### 验收标准

- [x] 开启后主界面 + 浮层均可见玻璃质感（彩色底透出 + 模糊 + 高光 + 投影）
- [x] 默认关闭时既有视觉零回归
- [x] 浅/深主题四列字色对比度全部达标（≥4.5:1 文字 / ≥3:1 非文字）
- [x] 光斑层不遮挡交互 + z-index 走令牌
- [x] 独立窗 / 内嵌页面面板仍为实心（#600 排除保留）
- [x] 全套校验绿

## 相关链接

- Issue：[#603](https://github.com/ShawnLiuSZ/task-dashboard/issues/603)
- 关联：[#600](https://github.com/ShawnLiuSZ/task-dashboard/issues/600)（毛玻璃开关初始实现）
- 前序文档：[`glass-effect.md`](./glass-effect.md)（原始设计 / 令牌 / 对比度）
- 代码：`app/src/styles.css`（令牌 + 门禁）· `app/src/main.tsx`（入口 import）
- 测试：`app/src/styles.test.ts`
- CHANGELOG：`docs/CHANGELOG.md` / `docs/CHANGELOG.en.md`（未发布条目）

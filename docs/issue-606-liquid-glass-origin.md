# Liquid Glass 透明度可调（3 档）+ 照搬 macOS 27 玻璃层次（#606）

> 用户反馈 v0.8.12 的 modal 背景是**灰色**的，要求「透明度可以调整，然后完全照搬 macOS 27 的效果」。
> 本期把 #600/#603 的布尔开关升级为 3 档透明度（对应 macOS 27「设置-外观」的 Liquid Glass 滑块），
> 并重做玻璃材质层次。纯前端，零新依赖 / 零 DB / 零 Tauri command / 零 API 变更。

## 背景 / 动机

### 灰色根因（实测）

v0.8.12 的 modal 中心像素为 `rgb(221,222,223)`——三通道几乎相等的中性灰。用层叠模型复算确认是**两次去色**叠加：

| 层 | 颜色 | 效果 |
|---|---|---|
| ① 彩色光斑底 | `rgb(242,216,221)` 淡粉（跨度 26） | 彩色来源 |
| ② 中性黑遮罩 `--overlay rgba(12,16,22,0.42)` | → `rgb(145,132,138)` | 第一次去色，跨度腰斩 |
| ③ 白底 `--glass-bg rgba(255,255,255,0.68)` | → `rgb(220,216,217)` | 第二次去色，跨度剩 6 |

`backdrop-filter: saturate(1.4)` 只作用于第①层，被②③稀释后几乎归零。这是上一期为守 WCAG AA（0.82→0.68 不透明度折中）付出的视觉代价——**对比度约束与玻璃观感的直接冲突**。

### macOS 27 的做法（调研 2026-11）

检索确认 macOS 27 Golden Gate 的两项关键变化：
1. **透明度滑块**：「设置-外观」新增 Liquid Glass 透明度滑块，多档调节（通透玻璃 ↔ 偏不透明染色）；苹果明确表示"没有极致通透选项"，最清透档也达不到 WWDC 2025 首演示效果——说明**对比度是硬边界**。
2. **Liquid Glass 层次**：更暗的边缘 + 更亮的高光建立景深；强化复杂内容下的扩散处理保可读性；窗口圆角收敛、侧栏贴边。

## 设计 / 方案

### 三档透明度（照搬 macOS 27 滑块）

| 档位 | 语义 | 浮层 alpha | blur | saturate | 遮罩 alpha | 文字补偿 text-2 / text-3 | 彩色跨度 |
|---|---|---|---|---|---|---|---|
| 1 | 通透 | 0.56 | 28px | 1.75 | 0.30 | `#4c4c4c` / `#5a5a5a` | 15~26 |
| 2（默认） | 均衡 | 0.64 | 24px | 1.60 | 0.34 | `#4e4e4e` / `#5d5d5d` | 12~20 |
| 3 | 清晰 | 0.74 | 20px | 1.40 | 0.38 | `#545454` / `#636363` | 7~13 |

- **数字越小越通透**，与 macOS 27 滑块方向一致（左通透右磨砂）。
- 档位令牌定义在 `html[data-glass-level='1'|'3']` 覆盖块（放在 `:root` 与 `[data-theme='dark']` 之后确保顺序压过主题默认值）；档 2 是默认，无覆盖块。
- 每档浅/深两套都显式定义，深色不沿用浅色值（防亮斑，延续 #600 纪律）。

### 关键决策：遮罩去色问题的解方

不再用中性黑 `--overlay` 压暗（去色元凶），改用**带色调深紫** `--glass-mask: rgba(28,24,48,alpha)`：

- 深紫保留色相，彩色光斑透过遮罩后仍有紫/粉调（实测遮罩区 `rgb(174,175,184)` 带蓝紫倾向，原中性黑遮罩是纯灰）；
- 浮层底从纯白改为**淡染色白** `rgba(252,250,255,alpha)`，提亮同时注入冷色；
- `saturate` 从 1.4 提到 1.4~1.75（越强越通透档），补偿去色。

### Liquid Glass 层次（macOS 27）

- **不对称内阴影**：`inset 0 1px` 顶部亮高光 + `inset 0 -1px` 底部暗边（建立"有厚度"的玻璃弧度/景深）；
- **描边比填充亮一档**：`--glass-border rgba(255,255,255,0.55)`，边缘捕捉光；
- **外投影**：`0 18px 48px --glass-shadow`，让面板悬浮于彩色底之上；
- **圆角**：沿用 `--radius-lg`（项目已收敛为 4 档，符合 macOS 27「圆角不再过度圆润」）。

### 偏好升级与迁移

`glassPrefs.ts` 从布尔升级为 3 档：

| 项 | 旧 | 新 |
|---|---|---|
| localStorage key | `taskboard.glassEffect` = `'on'` | `taskboard.glassLevel` = `'1'/'2'/'3'` |
| DOM 门禁 | `<html data-glass="on">` | `<html data-glass-level="N">` |
| API | `getEnabled` / `setEnabled` | `getLevel` / `setLevel`；旧接口保留兼容 |

**迁移策略**：新 key 缺失时，旧 `on` → 档 2（均衡），不突然切到最通透档影响可读；新 key 存在但脏值时不迁移（用户显式改过）；`setLevel` 时清除旧 key。全部输入过 `GLASS_LEVELS = [1,2,3]` 白名单校验（无任意值面，不构成 CSS 注入面）。

## 接口 / 行为变更

- **新偏好**：`localStorage["taskboard.glassLevel"]` ∈ `{缺失, "1", "2", "3"}`；旧 `taskboard.glassEffect` 自动迁移并清理。
- **新 DOM 属性**：开启时 `<html data-glass-level="1|2|3">`；关闭移除。
- **UI**：设置 → 基础 → 「毛玻璃效果」开关下方，开启后出现「通透 / 均衡 / 清晰」三档分段控件，切换即时生效。
- **i18n**：新增 `settings.glassLevel` / `settings.glassLevel1|2|3`（中英双语）。
- **默认仍关闭**：延续零视觉回归承诺。
- 零新依赖 / DB / API / Tauri command 变更。

## 数据 / 对比度（真实层叠模型实测，WCAG AA）

按「彩色光斑 → 遮罩 → 半透明表面」逐层混合，取各档最坏底色：

| 档 | 最坏底（浮层） | `--text` | `--text-2` 补偿 | `--text-3` 补偿 | `--accent`（非文字 ≥3:1） |
|---|---|---|---|---|---|
| 1 | `rgb(223,208,217)` | ≥4.5 ✅ | `#4c4c4c` 5.81 | `#5a5a5a` 4.67 | 3.09 ✅ |
| 2 | `rgb(225,213,222)` | ≥4.5 ✅ | `#4e4e4e` 5.87 | `#5d5d5d` 4.65 | 3.22 ✅ |
| 3 | `rgb(230,223,229)` | ≥4.5 ✅ | `#545454` 5.80 | `#636363` 4.60 | 3.50 ✅ |

主界面（无遮罩，光斑 + surface 0.66/0.72/0.78）：`--text-3` 4.55~4.75 / `--text-2` 5.85~6.11 / `--accent` 4.04~4.21 全达标。

深色三档浮层最亮底 `rgb(26,44,53)`~`rgb(31,40,49)`：`--text` 12.00~12.37 / `--text-2` 6.48~6.68 / `--text-3` 5.04~5.19 全达标。

> 全部预计算 rgba/hex，`color-mix()` / `oklch()` 在 build target（chrome105/safari13）下不可用且 Vite 不降级。`backdrop-filter` 双前缀。

## 测试 / 验收

### 已跑检查

```bash
cd app
npm test                       # 655 passed（38 files）
npx tsc --noEmit / npm run build / npm run i18n:check / npm run lint
npx prettier --check "src/**/*.{ts,tsx,css}"
python3 scripts/check-doc-links.py
```

### 新增/更新测试

| 文件 | 覆盖 |
|---|---|
| `glassPrefs.test.ts` | 白名单 1/2/3（数字+字符串）/ 脏值关闭 / 旧 `on` 迁移档 2 / 新 key 脏值不迁移 / setLevel 写新 key 清旧 key / 越界挡下 / setEnabled 兼容 / applyGlass / 模块加载即应用（含迁移路径）/ **白名单 ↔ i18n 词条一一对应** |
| `settings-groups.test.ts` | 开关 + 档位切换都 setState + 写偏好 / 初值来自 getLevel / 分段控件渲染（GLASS_LEVELS.map + aria-pressed + 动态 i18n key） |
| `styles.test.ts` | 门禁迁移到 data-glass-level / 三档覆盖块存在且深色独立定义 / 模糊半径递变 / 遮罩带紫调且非 --overlay / 上亮下暗不对称内阴影 / 文字补偿按档位递变 |

> 反向变异验证（见 `docs/methodology-assertion-strength-audit.md`）：基线绿 → 删档 1 blur / 遮罩改中性黑均变红 → 还原全绿。

### Chrome 无头渲染实测

- 三档 modal 中心像素：档1 `(220,218,230)` 跨度 12 / 档2 `(223,221,231)` 跨度 10 / 档3 `(231,229,235)` 跨度 6——**灰色问题已解决**（v0.8.12 跨度仅 6），且三档递变明显。
- 淡紫粉玻璃 + 顶部高光 + 底部暗边 + 悬浮投影可见，文字清晰。

### 验收标准

- [x] 3 档透明度可调，差异可辨识
- [x] modal 透出明显彩色（不再是灰块）
- [x] 三档浅/深主题四列字色对比度全部达标
- [x] 默认关闭零回归；旧 `on` 偏好平滑迁移到档 2
- [x] 档位白名单 ↔ i18n 词条一一对应（防动态 key 显示到界面）
- [x] 全套校验绿 + 完整发版流程

## 相关链接

- Issue：[#606](https://github.com/ShawnLiuSZ/task-dashboard/issues/606)
- 关联：[#600](https://github.com/ShawnLiuSZ/task-dashboard/issues/600)（毛玻璃开关）· [#603](https://github.com/ShawnLiuSZ/task-dashboard/issues/603)（可见性修复 / 灰色根因铺垫）
- 前序文档：[`glass-effect.md`](./glass-effect.md) · [`issue-603-glass-visibility.md`](./issue-603-glass-visibility.md)
- 代码：`app/src/glassPrefs.ts` · `app/src/components/SettingsPanel.tsx` · `app/src/styles.css` · `app/src/i18n/locales/{zh-CN,en-US}.json`
- 测试：`app/src/{glassPrefs,settings-groups,styles}.test.*`
- CHANGELOG：`docs/CHANGELOG.md` / `docs/CHANGELOG.en.md`（未发布条目）

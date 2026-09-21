# Issue #308: 主题系统（护眼/深色/跟随系统）

## 背景

当前应用只有浅色背景，长时间看板浏览偏刺眼，无深色/护眼可选，更无法跟随操作系统主题。

## 实现

### 3 套主题

| 主题 | 说明 |
|------|------|
| `light` | 浅色（默认，与现状一致） |
| `sepia` | 护眼（低饱和米黄/sepia） |
| `dark` | 深色（深紫蓝底 + 浅色文字） |

### CSS 变量

在 `:root` 定义基础变量，`[data-theme="sepia"]` 和 `[data-theme="dark"]` 覆盖：

- 背景：`--bg`, `--surface`, `--surface-2`
- 文字：`--text`, `--text-2`, `--text-3`
- 边框：`--border`, `--border-strong`
- 强调色：`--accent`, `--accent-hover`
- 语义色：`--amber-*`, `--teal-*`, `--error*`, `--success*`, `--warning*`, `--danger*`
- 代码块：`--code-bg`, `--code-text`
- 阴影/遮罩：`--shadow`, `--shadow-strong`, `--overlay`

### 主题检测与持久化

- 存储：`localStorage['taskboard.theme']`，值 `auto|light|sepia|dark`
- 检测：`matchMedia('(prefers-color-scheme: dark)')`
- 监听：`auto` 模式下 `matchMedia` change 事件自动切换
- 防 FOUC：模块加载时立即应用主题

### 设置入口

SettingsPanel 基础设置 tab 新增「外观主题」下拉选择器，支持跟随系统/浅色/护眼/深色。

### 颜色转换

将硬编码颜色转换为 CSS 变量：

- `#a32d2d` → `var(--error)`
- `#c0392b` → `var(--danger)`
- `#fdecec` → `var(--error-bg)`
- `#eaf6ef` → `var(--success-bg)`
- `#1c7c3d` / `#157a58` → `var(--success)`
- `#fff7e6` → `var(--warning-bg)`
- `#8a5a00` → `var(--warning)`
- `#f5f5f5` → `var(--code-bg)`
- `#333333` → `var(--code-text)`
- `rgba(0,0,0,0.06)` → `var(--shadow)`
- `rgba(0,0,0,0.12)` → `var(--shadow-strong)`
- `rgba(0,0,0,0.2)` → `var(--overlay)`
- `#ffffff` / `#fff` → `var(--surface)`
- `#e6e7ea` → `var(--surface-2)`

## 验收

- [x] 3 套主题 CSS 变量定义
- [x] 主题检测 + localStorage 持久化
- [x] matchMedia 监听系统主题变化
- [x] 防 FOUC（模块加载时立即应用）
- [x] SettingsPanel 主题选择器
- [x] i18n 中英双语
- [x] 硬编码颜色转换
- [x] `npx tsc --noEmit` 通过
- [x] `npm run build` 通过
- [x] `npm test` 141 passed
- [x] `npm run i18n:check` 378 keys
- [x] `npx prettier --check` 通过
- [x] `check-mcp-columns.py` 通过
- [x] `check-doc-links.py` 通过

## 后续

- 状态徽章（`.gh-status-*`, `.repo-*`, `.column-status-*`）的 100+ 硬编码颜色尚未转换，这些颜色在深色/护眼模式下需要单独处理
- 可考虑为状态色添加明度调整函数或单独定义深色变体

## 关联

- Issue: #308
- PR: #310

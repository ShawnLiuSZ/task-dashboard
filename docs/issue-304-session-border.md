# Issue #304: 会话卡片彩色边框

## 背景

会话卡片底色与面板背景过于接近，整面墙缺乏区分度。需要每张卡片加边框，使用几种颜色随机区分，且上下左右相邻卡片颜色必须不同。

## 实现

### CSS 变量

在 `:root` 定义 4 种边框色：

- `--session-card-border-1: #3b82f6` (蓝)
- `--session-card-border-2: #10b981` (绿)
- `--session-card-border-3: #f59e0b` (橙)
- `--session-card-border-4: #8b5cf6` (紫)

### 着色公式

`color = palette[(row + col) % 4]`

- 水平相邻：col 差 1 → 颜色必不同
- 垂直相邻：row 差 1 → 颜色必不同

### 响应式列数

CSS grid 使用 `repeat(auto-fill, minmax(320px, 1fr))`，列数随窗口宽度变化。通过 `getComputedStyle` 读取 `gridTemplateColumns` 实测列数，窗口 resize 时重算。

### 静态断言

`styles.test.ts` 新增 5 条断言：调色板存在、border 声明、着色公式、列数实测、ref 挂载。

## 验收

- [x] 4 种边框色 CSS 变量定义
- [x] `.session-card` 有 border 声明
- [x] 着色公式 `(row + col) % 4`
- [x] 响应式列数实测
- [x] 静态断言测试
- [x] `npx tsc --noEmit` 通过
- [x] `npm run build` 通过
- [x] `npm test` 141 passed
- [x] `npx prettier --check` 通过
- [x] `check-mcp-columns.py` 通过
- [x] `check-doc-links.py` 通过

## 关联

- Issue: #304
- PR: #309

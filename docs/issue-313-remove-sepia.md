# Issue #313: 移除护眼模式，只保留浅色和深色

## 背景

用户反馈护眼模式（sepia）颜色偏黄，观感不佳，要求移除，只保留浅色（Light）和深色（Dark）两种主题。

## 实现

### 移除 sepia 主题块

`app/src/styles.css` 删除 `[data-theme='sepia']` 主题 CSS 块。

### 收窄主题枚举

`app/src/theme.ts` 的 `Theme` 类型从 `'auto' | 'light' | 'sepia' | 'dark'` 改为 `'auto' | 'light' | 'dark'`；相关默认值与持久化逻辑同步收敛。

### 移除设置项

`app/src/components/SettingsPanel.tsx` 外观下拉移除「护眼」选项。

### i18n

删除 `settings.themeSepia` key（中文 + 英文各 1 处）。

## 接口 / 行为变更

- 设置页「外观」下拉不再提供「护眼」；可选值仅 跟随系统 / 浅色 / 深色。
- 主题枚举去掉 `sepia`，已选过护眼的用户回落到默认（浅色）。
- **无 schema / 无后端 / 无 MCP 变更**：纯前端 CSS + TS + i18n 改动。

## 验收

- [x] `[data-theme='sepia']` 样式块已删除
- [x] 设置页无「护眼」选项
- [x] `theme.ts` 枚举不含 `sepia`
- [x] `settings.themeSepia` key 中英文均移除
- [x] `npx tsc --noEmit` 0 error
- [x] `npm test` 141 passed
- [x] `npm run build` 通过
- [x] `npm run i18n:check` 377 keys 一致
- [x] `npx prettier --check` 通过
- [x] `scripts/check-mcp-columns.py` 通过
- [x] `scripts/check-doc-links.py` 通过

## 关联

- Issue: #313
- PR: #313 合并提交（`8871274`）

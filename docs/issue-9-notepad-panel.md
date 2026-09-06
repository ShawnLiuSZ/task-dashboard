# Issue #9: 记事本面板（看板最左侧笔记列）

## 背景 / 动机

在看板的最左侧添加第 1 列 - **记事本功能**，用于快速记录任务相关的临时笔记。支持增删改功能，并显示记录时间。

## 设计 / 方案

### 数据库
- 新增 `notes` 表：`id`、`content`、`created_at`、`updated_at`

### 后端
- 新增 4 个 Tauri 命令：`list_notes`、`add_note`、`update_note`、`delete_note`
- 在 `db.rs` 中实现对应的 CRUD 函数

### 前端
- 新增 `NotesPanel.tsx` 组件
- 在 `App.tsx` 中将 NotesPanel 放在 Board 左侧
- 新增 `Note` 类型定义
- 新增 API 调用方法

### MCP Server
- 新增 4 个工具：`list_notes`、`add_note`、`update_note`、`delete_note`

## 接口 / 行为变更

### Tauri 命令
- `list_notes()` → `Note[]`
- `add_note(content: string)` → `Note`
- `update_note(id: number, content: string)` → `Note`
- `delete_note(id: number)` → `void`

### MCP 工具
- `list_notes()` → 列出所有记事
- `add_note(content)` → 新增记事
- `update_note(note_id, content)` → 更新记事
- `delete_note(note_id)` → 删除记事

### UI（v0.3.24 视觉重设计）

面板与看板列同构：`320px` 宽、`surface-2` 底、`10px` 圆角、`overflow: hidden`，
头部固定（图标 + 标题 + 计数胶囊），内容区独立滚动。

| 项 | 说明 |
|---|---|
| 图标 | 内联 SVG（stroke 1.8），移除 📝 / ✏️ / 🗑️ emoji，规避跨平台字形差异 |
| 标签 | 原生 `<select>` → 分段 chip 组（低 / 中 / 高 / 紧急）；卡片上点击标签循环切换 |
| 卡片层级 | 左侧 3px 色条表示标签，替代全彩大写徽章 |
| 时间 | 相对时间（刚刚 / N 分钟前 / N 天前），hover 显示完整时间戳 |
| 操作 | 编辑 / 删除按钮默认隐藏，hover 或键盘聚焦时浮现 |
| 删除确认 | 原生 `confirm()` → 卡片内联确认（删除 / 取消） |
| 编辑交互 | textarea 自适应高度（上限 260px），`⌘/Ctrl + Enter` 保存、`Esc` 取消 |
| 新建交互 | `⌘/Ctrl + Enter` 直接添加；空态为图标 + 引导文案 |
| 高度自适应 | 输入框空白时两行（42px），随文字增长至上限 260px；卡片不设固定高度，由文字行数自然撑开 |
| 冻结列 | 面板 `position: sticky; left: 16px` + `z-index: 2`，看板横向滚动时记事本列固定在最左侧（与 topbar 的 sticky 同一滚动容器 `.app`） |
| 收起 / 展开 | 头部右侧收起按钮 → 收成 36px 竖向导轨（展开图标 + 竖排「记事本」+ 条数），点击展开。收起时**列表内容完全不渲染**，避免旁人看到；状态存 `localStorage["notes.collapsed"]`，重启后保持 |

样式集中在 `app/src/styles.css` 的 `.notes-*` / `.note-*` / `.label-*` 段，
按钮补充尺寸为 `.btn.small{,.primary,.danger,.ghost}`。功能与 Tauri 命令、MCP 工具均未变更。

## 数据 / Schema 变更

`notes` 表新增 `label` 列（`TEXT NOT NULL DEFAULT 'low'`，取值 `low / medium / high / urgent`）。

**迁移方式**：`db.rs::open_db` 追加 `ALTER TABLE notes ADD COLUMN label ...`（列已存在时忽略）。

> 踩坑记录（2026-09-05）：早期版本的库里已存在无 `label` 列的 `notes` 表，
> 而 `CREATE TABLE IF NOT EXISTS` **不会给已存在的表补列**，导致 `list_notes`
> （`SELECT ... label`）与 `add_note`（`INSERT ... label`）全部失败；
> 前端又把异常吞进 `console.error`，表现为「点击添加无任何反应、也没有数据保存」。
> 现补了 ALTER 迁移，并将前端失败改为面板内红色错误条显式提示。

## 测试 / 验收

- [x] `cargo check` 通过
- [x] `npx tsc --noEmit` 通过
- [x] 旧库（notes 无 label 列）启动后自动补列，添加/列表恢复正常
- [x] 操作失败时面板内显示红色错误条（不再静默）
- [x] 空白输入框两行高，随输入增长至 260px 上限
- [ ] 前端 NotesPanel 组件正常渲染
- [ ] 输入框 + 添加按钮功能正常
- [ ] 能够编辑单条记事
- [ ] 能够删除单条记事（含确认对话）
- [ ] 时间显示格式正确（创建时间 + 编辑时间）
- [ ] 后端 SQLite 表创建成功
- [ ] 所有 4 个 Tauri 命令实现完毕
- [ ] MCP Server 中新增 4 个工具
- [ ] Agent 可通过 MCP 调用记事功能

## 相关链接

- Issue: https://github.com/ShawnLiuSZ/task-dashboard/issues/9

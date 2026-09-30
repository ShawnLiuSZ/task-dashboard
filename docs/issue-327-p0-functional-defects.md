# #327 — code review P0 批次：3 项功能缺陷 + 项目条目数取错字段

> 对应 issue：[#327](https://github.com/ShawnLiuSZ/task-dashboard/issues/327)
> 来源：`CODE-REVIEW-2026-09-30.md`（基线 `main @ f66f83f` / v0.6.5）深度审查的 P0 级发现

## 背景 / 动机

2026-09-30 对 `main @ f66f83f`（v0.6.5）做了全量代码审查，P0 级共 4 项：三项是**已发布版本中用户可感知的功能缺陷**，一项是**会让状态写回选错项目**的数据缺陷。四项均已本地实测复核，非静态推断。

其中第 4 项与用户反馈的「详情面板切换状态，API 日志成功但 GitHub 上状态不变」高度相关（见下文「为什么值得单独修」）。

## 设计 / 方案

### 1. About 小窗「确定」按钮失效（#325 功能实际未生效）

**根因是双重的**，只看一层会修不干净：

1. `capabilities/default.json` 的 `windows` 为 `["main"]`，而 `about` 是 `tauri.conf.json` 里独立定义的第二窗口（label `about`）。Tauri 2 的 capability 按窗口 label 匹配，`about` 不匹配任何 capability ⇒ **零 IPC 权限**。
2. 即便给上 `core:default`，其展开的 `core:window:default` 权限集（实测 28 项）**不含 `allow-close`** —— 该默认集只覆盖读取类命令（`is-*` / `scale-factor` / monitors / theme 等）。

**方案**：新增独立 capability 文件 `capabilities/about.json`，`windows: ["about"]` + `permissions: ["core:default", "core:window:allow-close"]`；同时把 `main` 上此前授予却从未使用的 `core:window:allow-show` / `allow-hide` 移除（前端只有 `.label` 与 `.close()` 两处调用，`about` 窗口的显示由 Rust 侧 `open_about_window()` 的 `w.show()` 完成，属 Rust API，不受 ACL 约束）。

### 2. 设置面板「界面语言」切换器丢失

`SettingsPanel.tsx` 的基础设置区分出现**两个完全相同**的「外观主题」下拉框（同 `value`、同 `onChange`、同选项）。证据链显示第二块原本是语言选择器：i18n 模块早已导出 `mode` / `setMode`，且 locale 里 `settings.language` / `langAuto` / `langZh` / `langEn` 四个 key 中英文都存在，但**全 `app/src` 零引用** —— 即 `setMode` 是死代码、语言切换入口整块丢失。

**方案**：第二块改回语言选择器（`value={langMode}` / `onChange={setLangMode}`），选项用上述 4 个 key；`SettingsPanel` 从 `useI18n()` 额外解构 `mode` / `setMode`（重命名避免与主题的 `themeMode` 混淆）。

### 3. 记事内容重复时抛原始 SQLite 错误

`notes.content` 上有唯一索引 `idx_notes_content`（`SCHEMA` 内定义，生产库生效）。`add_note` / `update_note` 直接 `INSERT` / `UPDATE` 且未捕获约束冲突，于是「复制一条记事改标签」这类自然操作会直接在 UI 与 MCP 返回体里暴露 `插入记事失败: UNIQUE constraint failed: notes.content`。

**方案**：新增 `is_unique_violation()` 判定（`SqliteFailure` 的 `extended_code == 2067`，即 `SQLITE_CONSTRAINT_UNIQUE`），在两个函数里把原始文案换成可读提示（「已存在相同内容的记事，未重复添加」/「已存在相同内容的记事，未保存」）。选择捕获而非「先查重」是因为后者需要额外一次查询且存在 TOCTOU 窗口。

### 4. `projects.number_of_items` 取错字段

`fetch_all_projects` 里两处（org 分支 / user 分支）都写成 `let num = n["number"]` —— `number` 是**项目编号**（如 `#20`），而注释与列名 `number_of_items` 表达的是**条目数**；查询串也从未请求 `items { totalCount }`。

实测对照：

| Project | 落库的 `number_of_items` | GitHub 真实 `items.totalCount` |
|---|---|---|
| OMS Kanban | 20（= 编号 #20） | **273** |
| @liming0521's untitled | 21（= 编号 #21） | **0** |

**为什么值得单独修**：`db.rs::resolve_project_write_target` 用

```sql
ORDER BY p.number_of_items DESC LIMIT 1
```

挑选「条目数最多的主项目」作为写回目标。字段存的是编号 ⇒ 该排序**退化成「按项目编号选」**。当一个 issue 同时属于多个 Project 时，会写回编号最大的那个而非用户实际在看的那个，表现正是**「API 日志成功、GitHub 上目标项目状态不变」**（用户反馈的症状）。

附带影响：`commands.rs::resolve_or_refresh` 的补拉顺序同样被这个排序带偏，实测会先对实际为空的项目（`@liming0521's`，编号 21 > 20）白发 2 次请求才命中 OMS Kanban。

**方案**：两处查询串补 `items { totalCount }`，并把「查询串构造」与「nodes 解析」抽成三个纯函数（`org_projects_query` / `user_projects_query` / `parse_projects_nodes`），使这条回归可以被单元测试直接锁住 —— 原实现内联在 `fetch_all_projects` 里，纯网络方法无法单测。

## 接口 / 行为变更

| 变更 | 说明 |
|---|---|
| 新增 capability `about` | 窗口 `about` 获得 `core:window:allow-close`；无 IPC 变更，仅权限声明 |
| `main` capability 收窄 | 移除未被使用的 `core:window:allow-show` / `allow-hide` |
| 设置面板新增语言选择器 | 用户可在「基础设置」切换 跟随系统 / 简体中文 / English（此前入口缺失） |
| 记事重复不再报原始 SQL 错 | 返回可读提示；`import_note` 的「跳过重复」行为不变 |
| `fetch_all_projects` 返回值语义修正 | 第 3 个元素由「项目编号」变为真实的「条目数」（`items.totalCount`） |
| 内部新增私有函数 | `GitHubClient::{org_projects_query, user_projects_query, parse_projects_nodes}`、`db::is_unique_violation`（均非命令、非 MCP 工具） |

无新增 Tauri command、无 MCP 工具变更、无 i18n key 增删（复用了既有 4 个语言 key）。

## 数据 / Schema 变更

**无 schema 变更。** `projects.number_of_items` 列已存在，本次只修正其**写入值**的语义。已落库的历史数据仍是旧的编号值，会在下一次成功同步时被 `upsert_projects` 覆盖为真实条目数（`ON CONFLICT DO UPDATE SET number_of_items = excluded.number_of_items`），无需迁移脚本。

## 测试 / 验收

| 验收项 | 对应测试 |
|---|---|
| about 窗口被 capability 覆盖且含 `allow-close` | `about-window.test.ts`「About 小窗能力权限（#327）」 |
| `main` 不再声明 show/hide；前端只用 `close()` | 同上（3 例） |
| 语言选择器存在，且「外观主题」只渲染一次 | `settings-groups.test.tsx`「基础设置：界面语言选择器（#327）」 |
| 记事重复返回可读文案（插入 + 更新两条路径） | `db.rs::tests::note_unique_content_conflict_is_readable` |
| 条目数取 `totalCount` 而非 `number`；closed 跳过；缺字段回落 0 | `github.rs::tests::parse_projects_nodes_uses_total_count_not_number` |
| 两处查询串都请求 `items { totalCount }` | `github.rs::tests::projects_queries_request_total_count` |

**反向验证**（按项目约定，静态断言测试必须验证「改回缺陷写法会失败」）：

| 反向操作 | 结果 |
|---|---|
| 删除 `about.json` 的 `allow-close` | ✅ 测试失败（exit 1） |
| 语言 label 改回 `settings.theme` | ✅ 测试失败（exit 1） |
| `parse_projects_nodes` 改回取 `n["number"]` | ✅ `FAILED` |
| 记事错误改回原始 `format!("插入记事失败: {e}")` | ✅ `FAILED` |

**已跑检查**：`npx tsc --noEmit` 0 error ✅ · `npm test` 155 passed（新增 4 例）✅ · `npm run i18n:check` 389 keys ✅ · `npm run lint` 18 warnings（无新增）✅ · `npx prettier --check` ✅ · `cargo clippy --lib -p taskboard -- -D warnings` ✅ · `cargo test --lib` 119 passed（新增 3 例）✅ · `scripts/check-doc-links.py` ✅ · `scripts/check-mcp-columns.py` 28 列 ✅ · `scripts/check-workflow-yaml.py` ✅ · `scripts` 单测 70 passed ✅。

## 相关链接

- Issue：[#327](https://github.com/ShawnLiuSZ/task-dashboard/issues/327)
- 审查报告：`CODE-REVIEW-2026-09-30.md`（仓库根）
- CHANGELOG：[`docs/CHANGELOG.md`](./CHANGELOG.md)（Unreleased 段）
- 同批后续：`#328`（P1 数据安全）、`#329`（P2 一致性）、`#330`（P3 规范与 CI）
- 上游相关：#325（About 小窗引入）、#215（Project 状态写回引入）

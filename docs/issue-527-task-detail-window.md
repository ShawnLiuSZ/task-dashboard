# 任务详情可在新窗口打开（完整信息）+ modal 去掉实时获取 — #527

> 用户的原话：「查看 task 任务时，现在是以 modal 框展示，希望实现：可以在新窗口打开详情，
> 这个详情中显示目前 modal 框中的所有信息，然后 modal 框中将实时获取任务详情的功能去掉。」

## 为什么拆成两种形态

原先详情面板**每次打开都实时拉一次 GitHub**（`fetch_task_detail_live`），
而详情里的信息**装不下**一个 720px 的弹窗（正文 + 时间线 + PR 提交历史 + 评论）。

⇒ 拆成两种形态，各取所需：

| | modal（主窗口） | 独立窗 |
|---|---|---|
| 实时获取（`fetch_task_detail_live`） | **去掉** ⇒ **零 GitHub 请求** | **保留** |
| 正文 / 时间线 / PR 提交历史 | 不显示 | **显示** |
| 评论 | 显示（本地 `list_task_comments`） | 显示（实时覆盖） |
| 状态行 / 指派 / 标签 / 会话 / 交接 | 显示 | 显示 |

⚠️ **modal 里看不到正文是预期行为，不是数据丢了**：本地库**没有** issue body /
timeline 列（`tasks` 表只有 `comments_count`）⇒ 正文只存在于实时拉取结果里。

## 实现

### 后端（Rust）

#### `get_task(issue_key, account_id)` —— 取单条任务

```rust
let rows = rows_to_tasks(&conn, None, Some(account_id))?;
Ok(pick_task_by_issue_key(rows, &issue_key))
```

⚠️ **为什么不在 SQL 里直接过滤**：复用既有查询 ⇒ **零 SQL 改动**，且详情窗与看板显示的
字段**完全同源**（不会出现「详情窗少一个字段」的分叉）。单账号几百行，内存过滤成本可忽略。

⚠️ **账号维度必需**：`issue_key` 形如 `repo#number`（**不含 owner**）⇒ 多账号下会重复
⇒ 只按 issue_key 取会拿到**别的账号**的同号 issue。

「挑哪一条」抽成纯函数 `pick_task_by_issue_key`（可单测，与生产命令共用同一份实现）。

#### `open_task_detail_window(issue_key, account_id)` —— 新开详情窗

```rust
let label = format!("task-detail-{}-{}", account_id, sanitize_window_label(&issue_key));
if let Some(w) = app.get_webview_window(&label) {   // 同一任务已开着 ⇒ 聚焦
    let _ = w.show(); let _ = w.set_focus(); return Ok(());
}
let payload = serde_json::json!({ "issueKey": issue_key, "accountId": account_id });
WebviewWindowBuilder::new(&app, &label, WebviewUrl::App("index.html".into()))
    .title(format!("{} · TaskBoard", issue_key))
    .initialization_script(&format!("window.__TASK_DETAIL__ = {};", payload))
    .build()?;
```

⚠️ **为什么用 `initialization_script` 注入任务标识**（而不是 URL query 或事件）：

| 方案 | 问题 |
|---|---|
| URL query | `WebviewUrl::App` 在 dev（dev server）与 prod（打包资源）下解析规则不同 ⇒ 要写两套 |
| 事件（`emit_to`） | **竞态**：新窗口的 `listen` 可能还没注册就收到了消息 ⇒ 丢参数 |
| **`initialization_script`** | 页面脚本执行**之前**注入 ⇒ **无竞态**，且与 dev/prod 无关 ✓ |

⚠️ **窗口 label 要清洗**：`issue_key` 含 `#` ⇒ `sanitize_window_label` 只保留
字母 / 数字 / `-` / `_`。

#### capability

新建 `app/src-tauri/capabilities/task-detail.json`：

```json
{ "windows": ["task-detail-*"], "permissions": ["core:default", "core:window:allow-close"] }
```

⚠️ capability 的 `windows` **支持 glob**（Tauri v2 用 `Pattern::new(window)` 匹配）
⇒ 一个 glob 覆盖所有动态 label 的详情窗。

### 前端

#### `DetailPanel` 加三个 prop

| prop | 默认 | 作用 |
|---|---|---|
| `live` | `true` | `false` ⇒ 实时拉取的 effect **直接早退**（不发请求） |
| `variant` | `'modal'` | `'window'` ⇒ 根元素加 `.detail-window`（去掉绝对定位 / 圆角 / 阴影 / 宽度上限） |
| `onOpenInNewWindow` | — | 传了才渲染「在新窗口打开」按钮（**只在 modal 形态**） |

⚠️ **effect 的依赖里必须带 `liveEnabled`** —— 否则从「不拉」切到「要拉」时 effect 不会重跑。

#### `TaskDetailWindow.tsx`（新组件）

读 `window.__TASK_DETAIL__` → `api.getTask` + `api.listProjectStatuses` ⇒ 渲染
`<DetailPanel live variant="window" />`；「关闭」按钮 ⇒ `getCurrentWindow().close()`。

#### `main.tsx` 三分支路由

```tsx
const isTaskDetailWindow = windowLabel.startsWith('task-detail');
```

⚠️ 用**前缀**匹配而不是全等 —— label 随任务动态变化（`task-detail-{账号}-{issueKey}`）。

## 验证

### 真机端到端（`tauri dev` + `screencapture`）

⚠️ 这一项**只有真 app 能验**：新窗口创建 / capability 放行 / 初始化脚本注入 / 路由
都不是 headless Chrome 能覆盖的。

实测（临时插一段自动开窗代码，验证后删除）：

| 检查项 | 结果 |
|---|---|
| 新窗口标题 | `fad-backend#551 · TaskBoard` ✓（= 传入的 issue_key） |
| 窗口形态 | **占满整个窗口**（不是居中小卡片）✓ |
| 「实时」徽标 + 时间戳 | ✓（`2026-11-03 14:52:04`）⇒ 实时数据到位 |
| GitHub 状态选项 / 中断会话 / 交接任务 / 业务背景与目标 | 全部渲染 ✓ |
| 用户自己点「新窗口打开」 | 也成功开出 `fad-backend#1198 · TaskBoard` ⇒ **真实用户路径**同样跑通 ✓ |

### 单测（+10 前端 / +1 Rust）

| 位置 | 内容 |
|---|---|
| `components/task-detail-window.test.tsx`（**新**） | 10 例：modal / window 两种根 class · 「在新窗口打开」按钮只在 modal 出现 · 没传回调不渲染 · **`live=false` 早退分支**（源码断言）· deps 含 `liveEnabled` · 主窗口传 `live={false}` + 回调带 issueKey+accountId · 独立窗读 `window.__TASK_DETAIL__` |
| `commands.rs`（Rust） | `pick_task_by_issue_key_matches_exactly` —— 走**真实落库 + 真实查询路径**（`mem_conn` + `seed_account_tasks` + `rows_to_tasks`）⇒ 能同时覆盖 issue_key 生成规则 / 账号过滤 / mapper 字段顺序；含「同号 issue 在别的账号下存在」的用例 |
| `components/about-window.test.ts`（改写） | 路由从二元变三元 ⇒ 断言改用正则按顺序匹配（Prettier 会折行 ⇒ 不能用连续子串） |
| `components/detail-panel-head.test.tsx`（改写） | 头部多了 `.detail-head-actions` 包装 ⇒ 正则允许这层包装，**但不变式不变**（#500 的守卫：issue id 行 → 按钮 → 标题行的嵌套顺序、标题仍在 `.detail-head` 内闭合） |

⚠️ **为什么有些断言只能落在源码上**：node 环境无 DOM ⇒ `renderToStaticMarkup` **不执行
effect** ⇒ 「`live=false` 时不发请求」这条**运行时**行为无法用渲染断言验证（SSR 下
`live` 本来就是 null）⇒ 该条走 `?raw` 源码断言（仓库既有范式）。

**反向验证**：删掉 `if (!liveEnabled) { … return; }` 早退分支 ⇒ 用例 **FAILED**；还原 ⇒ **ok**。

## 顺带修的状态行布局缺陷（#529）

用户在新窗口里看到「执行状态 / GitHub 状态」那一行**巨大且文字竖排**，报「怎么会有这么大状态」。

### 两个叠加的根因

| # | 根因 | 修法 |
|---|---|---|
| ① | `.seg`（flex 容器）**没有 `flex-wrap`**（默认 nowrap）⇒ 20+ 个状态项硬塞在一行；`.seg-btn` 又是 `flex: 1`（basis 0% ⇒ **均分**宽度）⇒ 每个只有 1/N 宽 ⇒ 「In Progress」「优先测试上线」被压成**竖排**文字（一个字符一行），整行高度被最长的那个撑到 ~90px | `.seg { flex-wrap: wrap; }` + `.seg-btn { flex: 0 0 auto; white-space: nowrap; }` ⇒ 按内容宽度、**放不下就换行**、文字不再竖排 |
| ② | `project_statuses` 表按 **(account, project, option)** 存 ⇒ 多个 GitHub Project 各有一套 Todo / In Progress / Done ⇒ 聚合起来**重复三遍**（实测某账号 21 项里 3 组同名） | `projectStatusOptions` **精确去重**（区分大小写） |

⚠️ **为什么同名去重是安全的**：写回目标是按**任务所属的 Project** 解析的
（后端 `resolve_project_write_target`）⇒ 状态名只作为「名字」传过去 ⇒
同名项在 UI 上**功能完全等价**（都写到本任务所属 Project 的那个 option）。

⚠️ **为什么必须区分大小写**：`In Progress` 与 `In progress` 是**两个不同 Project 的不同
option**（option_id 不同）⇒ 合并会写错 option_id ⇒ 精确匹配。

### 实测（复现页 + 真机）

| | 修复前 | 修复后 |
|---|---|---|
| 状态项数 | 21（含 3 组重复） | **14**（去重后） |
| 渲染行数 | 1 行（但被竖排文字撑到 ~90px 高） | **1 行、28px 高** |
| 按钮宽度 | 均分压缩 | 34~78px（按内容） |
| 文字 | **竖排**（一字符一行） | 横排单行 |

真机实测（`tauri dev` + `screencapture`）：状态行变成一行横排
`需求池 | 产品规划 | 排期 | 开发中 | 开发完成 | 开发完成评审中 | 测试通过评审上线 | 市场上线 | 设计稿`。

## 顺带修的状态选项不一致（#530）

用户在**同一个任务**的两处对比发现「执行状态」列表**不一致**：

| 界面 | 状态项 |
|---|---|
| 主窗口 modal | 8 项（`需求池 / 产品规划 / 待开发处理 / 开发中 / …`） |
| 独立窗 | **18 项**（上面 8 项 **+** 英文那套 `Todo / In Progress / Done / …`） |

### 根因：数据源相同，**筛选逻辑不同**

`listProjectStatuses(accountId)` 返回的是该账号**所有 Project** 的状态；
主窗口在**单账号视图**下会**只取「主项目」**的状态，而独立窗当时**直接用了全量**
（#527 实现时漏了这一步）⇒ 其它 Project 的状态也被列了出来。

### 修法：抽成**共用纯函数**（`app/src/utils/projectStatuses.ts`）

| 函数 | 用途 |
|---|---|
| `pickPrimaryProjectStatuses(all)` | 取「主项目」（**状态数最多**的那个 Project）的状态，按 `orderIndex` 升序 |
| `mergeProjectStatuses(lists)` | 跨账号合并 + 按**状态名**去重 + 按名排序（聚合视图） |

⇒ `App.tsx`（单账号 / 聚合两个分支）与 `TaskDetailWindow.tsx` **都改成调它们** ⇒ 不会再分叉。

⚠️ 「主项目」判据是**状态数最多**（状态表里没有条目数字段）；状态数相同时取先遇到的
（`Map` 插入序）—— 与主窗口原实现**逐字一致**（抽取时不改行为）。

### 真机实测

独立窗的状态行变成 `需求池 | 产品规划 | 待开发处理 | 开发中 | 开发完成/测试中 |
测试通过/待上线 | 完成/上线 | 取消` ⇒ **与 modal 完全一致**（8 项，英文那套被正确过滤）。

## 卡片上的「在新窗口打开」按钮（#531）

用户要求把这个功能**直接放到任务卡片上** ⇒ 看板卡片上直接开独立窗，不必先点开 modal。

### 放在哪

`.card-bottom`（日期 / 「N 条评论」那一行）—— 那里本来就是操作元素的位置。

⚠️ **必须 `stopPropagation`**：卡片本体是 `<article onClick={() => onSelectKey(...)}>`
⇒ 不拦住就会**同时**开出 modal 与独立窗。

### 接线：只在 `cardProps` 里带一次

⚠️ `Board` 里有**四处** `<TaskCard>`（project / unclassified / 四态 / 自定义列）
⇒ 回调**只在 `cardProps` 里带一次** ⇒ 四处自动都有，不会漏其中几个。

### 视觉

按钮 18×18、图标 12px、`--text-3` 淡灰、hover 才变深 ⇒ 卡片密度高，按钮抢眼会变成噪音。
图标与详情面板头部**同一个**（「外开」：方框 + 右上角箭头）⇒ 用户一眼认得。

### 实测（复现页：vite 直接 import **真实** `TaskCard` + 真实 `styles.css`）

| 探针 | 值 |
|---|---|
| 按钮存在 / 在 `.card-bottom` 内 | ✓ / ✓ |
| 按钮尺寸 / 图标尺寸 | 18×18 / 12×12 |
| `title` / `aria-label` | 「在新窗口打开」/「在新窗口打开」 |
| 贴右对齐 | ✓（`margin-left: auto`） |
| 与底栏其它元素（日期 / 评论链接）重叠 | **否** ✓ |

## 影响面

| 文件 | 改动 |
|---|---|
| `app/src-tauri/src/commands.rs` | `get_task` / `open_task_detail_window` / `pick_task_by_issue_key` / `sanitize_window_label` + 1 条单测 |
| `app/src-tauri/src/lib.rs` | 注册两个新命令 |
| `app/src-tauri/capabilities/task-detail.json` | **新增**（详情窗权限） |
| `app/src/components/DetailPanel.tsx` | `live` / `variant` / `onOpenInNewWindow` 三个 prop + 头部动作组 |
| `app/src/components/TaskDetailWindow.tsx` | **新增**（独立窗组件） |
| `app/src/main.tsx` | 三分支路由 |
| `app/src/App.tsx` | modal 传 `live={false}` + 打开新窗口回调 |
| `app/src/api.ts` | `getTask` / `openTaskDetailWindow` |
| `app/src/styles.css` | `.detail-head-actions` / `.detail-window` / `.detail-window-error` |
| i18n ×2 | `detail.openInNewWindow` + `detailWindow.*` ×3 |

**零 DB schema 改动** · 零新依赖。

## 已知边界

- 独立窗的「实时」内容**只在打开时拉一次**（与原 modal 行为一致）⇒ 不会自动刷新。
- 独立窗不参与主窗口的 `onChanged` 刷新链（状态写回后只刷新**该窗口内**的那条任务）。
- 窄窗口下详情窗有 `min_inner_size(520, 420)` 下限。

# 任务会话 meta 行完整显示（#420）

> 关联 issue：<https://github.com/ShawnLiuSZ/task-dashboard/issues/420>
> 分支：`fix/issue-420-sessions-meta-ellipsis`
> 影响面：纯前端样式，无schema / MCP / i18n 变更

---

## 背景 / 动机

任务会话面板（`SessionsPanel`）的每张卡片除标题外还有一组 meta 行，逐行展示
**创建时间 / 分支名 / 工作目录 / session id / agent / 时间**。

这些值此前全部被**单行省略号截断**：

```
分支    feature/lsz/418-fix-sessions-meta-ellipsis@main26100…
目录    /Users/liushizhao/dev/dashboard/app/src-tauri…
```

两个层面的问题：

1. **信息丢失且不可恢复** —— 这些节点**没有 `title` 属性**，悬停不显示全值，
   用户无法得知被截掉的内容。分支名是本项目「分支 ↔ issue ↔ 文档」三向追溯的关键
   信息（见 `AGENTS.md §6.1` 的分支命名规范），截断后基本不可用。
2. **覆盖不全** —— `.session-card-title` 早在 #287 已改为自动换行，但同一张卡片里的
   meta 行**从未被处理**，属遗漏而非有意设计。

## 设计 / 方案

### 改动范围

只改 `app/src/styles.css` 两个类：

| 类 | 改动 | 理由 |
|---|---|---|
| `.session-meta-value` | 去掉 `overflow: hidden` / `text-overflow: ellipsis` / `white-space: nowrap`，加 `white-space: normal` + `overflow-wrap: anywhere` | 核心修复：允许换行 |
| `.session-meta-row` | `align-items: center` → `flex-start` | 多行值的首行应与标签顶部对齐；`center` 会让换行后的值视觉下沉 |

### 为什么用 `overflow-wrap: anywhere` 而不是 `word-break: break-word`

`.session-meta-value` 里承载两类文本，**断行需求不同**：

- **分支名 / 工作目录**：含 `/`、`-` 等符号，但 `word-break: break-word` 只在
  合适的断点断，长路径在某些连续符号处仍可能顶出卡片。
- **session id / agent 名**：很可能是**完全无空格的长串**（如
  `taskboard-20261009-153212-abcdef`）。`break-word` 对这类串无能为力——
  它只在既有断点处断，没有断点就整段溢出。

`overflow-wrap: anywhere` 对两者都生效：既能在合适处断，也能在必要时**强制打断**
无空格长串。

同时保留 `font-family: var(--font-mono)` —— 分支名 / 路径 / session id 是代码类
文本，等宽字体是语义需求，不是装饰，不能因为「改成换行」而丢掉。

### 明确不动的部分

`.session-row .session code`（任务详情里分配人下方的 session 行）同样是省略号，
但那是 #197 的**有意设计**，注释写明「列窄时省略，全值放 `title`」，且**确实有**
`title` 兜底。两者缺陷性质不同（一个信息不可恢复，一个有兜底），本次不改。

### 权衡

「一律换行」的代价是卡片高度随内容增长。因`min-width: 0` 已保留、网格列宽
`minmax(320px, 1fr)`，换行不会改变列宽，只增加行高 —— 对看板类界面可接受，
换来的是分支名 / 路径永不被隐藏。

## 接口 / 行为变更

无 API、无 Tauri command、无 MCP tool 变更。

UI 行为变化：

- 任务会话卡片的分支名 / 目录名 / session id / agent / 时间从「单行 + `…`」变为
  「多行完整显示」
- 同一行内标签（`分支` / `目录` 等固定 40px 宽）位置不变，值的首行与标签顶对齐

## 数据 / Schema 变更

**无。** 纯样式改动，不涉及 SQLite、不涉及 `SELECT_COLS`、不涉及 MCP 双实现。

## 测试 / 验收

`app/src/styles.test.ts` 新增 `describe('任务会话 meta 行完整显示')`，4 例：

1. `.session-meta-value` 不含 `text-overflow: ellipsis` / `white-space: nowrap` / `overflow: hidden`
2. `.session-meta-value` 含 `white-space: normal` 且含 `overflow-wrap: anywhere`（或 `word-break: break-all`）
3. `.session-meta-row` 为 `align-items: flex-start`
4. `.session-meta-value` 仍引用 `var(--font-mono)`（防止改换行时误丢等宽字体）

vitest 跑在 node 环境、无布局引擎（§2.5 不引入 jsdom / testing-library），
沿用 `?raw` 静态断言。

### 反向验证

按 `docs/methodology-assertion-strength-audit.md` 纪律，把修复改回缺陷写法
（还原 `overflow: hidden` + `text-overflow: ellipsis` + `white-space: nowrap`，
并把 `align-items` 改回 `center`），跑测试：

```
MUTATION_TEST_EXIT=1   # 断言确实捕获缺陷
```

恢复修复后 `exit=0`，24 passed。

### 本地全量验证

| 项 | 结果 |
|---|---|
| `npx vitest run src/styles.test.ts` | 24 passed |
| `npm test -- --run` | 257→ 261 passed |
| `npm run lint` | 0 警告 |
| `npx prettier --check "src/**/*.{ts,tsx,css}"` | 通过 |
| `npx tsc --noEmit` | 通过 |
| `npm run i18n:check` | 397 key（无新增） |

Rust 侧无改动，`cargo test --lib` / `cargo fmt --check` / `clippy` 不受影响。

## 相关链接

- Issue：<https://github.com/ShawnLiuSZ/task-dashboard/issues/420>
- 前置工作：`docs/issue-287-sessions-panel.md`（`.session-card-title` 换行，本次对齐其口径）
- 反例（有意省略）：`styles.css` 的 `.session-row .session code`，#197 设计 + `title` 兜底
- 方法论：[`methodology-assertion-strength-audit.md`](./methodology-assertion-strength-audit.md)
- CHANGELOG：[`CHANGELOG.md`](./CHANGELOG.md) / [`CHANGELOG.en.md`](./CHANGELOG.en.md)
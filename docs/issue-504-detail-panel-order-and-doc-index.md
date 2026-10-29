# 详情面板区块重排 + 知识库文档索引迁到 CONTRIBUTING.md — #504

> 关联 issue：[#504](https://github.com/ShawnLiuSZ/task-dashboard/issues/504)

## 需求（两条）

1. 「将 body 信息，评论等信息放在**交接任务**下边」；
2. 「将知识库文档链接和说明从 **README** 中移动到 **CONTRIBUTING.md** 中」。

## 需求 ①：详情面板区块重排

### 改前

三块**实时拉取**的内容（#490 / #498 的产出）分散在面板上下：

```
头部（sticky） → 实时徽标 → 归属/时间 → **描述（body）** → 执行状态 → 会话 → 交接任务
→ GitHub → **评论链接** → 关联 issue → 报错 → **PR 提交历史**
```

⇒ 读的时候要来回跳：「描述」在最上、「评论」在中、「PR 提交历史」在最末。

### 改后

```
头部（sticky） → 实时徽标 → 归属/时间 → 执行状态 → 会话 → 交接任务
→ **描述（body）** → **评论链接** → **PR 提交历史** → GitHub → 关联 issue → 报错
```

⇒ 三块聚成一段连续的「远端实况」，紧跟「交接任务」（本地操作区）之后。

### 实现

只动 `app/src/components/DetailPanel.tsx` 的 JSX 顺序，**不改任何渲染条件**：

- 「描述」区块：从「执行状态」之前移到「交接任务」之后；
- `<TaskCommentsList>`：从「GitHub」区块之后移到「描述」之后；
- 「PR 提交历史」：从面板末尾（`liveError` 之后）移到评论之后。

### 断言落点：为什么是**源码顺序断言**而不是渲染断言

这三块都是**条件渲染**（正文非空 / 有评论 / 有 PR 才渲染），而前端测试跑在
node 环境（**无 DOM**）⇒ `useEffect` 不执行 ⇒ `live` 恒为 `null` ⇒
**SSR 渲染产物里根本没有这三块** ⇒ 渲染断言够不着。

⇒ 改用**源码顺序断言**（与仓库既有范式一致，见 `task-comments-list.test.tsx`）：
用**精确 JSX 片段**作锚点（`{t('detail.handoffTitle')}` / `{t('detail.bodyTitle')}` /
`<TaskCommentsList comments={shownComments}` / `{t('detail.prCommitsTitle'`），
两两比较 `indexOf` 的大小关系。

⚠️ 锚点必须用**精确片段**而不是裸词（如 `detail.bodyTitle`）—— 裸词会命中注释里的
同一字符串，断言就成了「恒真」。

## 需求 ②：知识库文档索引迁移

### 改前 / 改后

| 文件 | 改前 | 改后 |
|---|---|---|
| `README.md` | 358 行（其中 **181 行**是文档清单） | **181 行**（只留入口指针） |
| `README.en.md` | 190 行（其中 16 行是文档清单） | **178 行**（只留入口指针） |
| `CONTRIBUTING.md` | 120 行（只有「文档规范」三条） | **324 行**（新增「## 文档索引」章节，承接全部条目 + 英文小节） |

README 的「文档」段整体迁到 `CONTRIBUTING.md` 的新章节「## 文档索引」，
其中原有的「### 历史知识库文档」子节与说明文字**原样保留**（历史记录不动）。

### ⚠️ 关键连带改动：`check-doc-links.py` 的 `INDEX_FILES`

`docs/*.md` 必须被「索引文件」引用，否则报**孤岛文档**（#330 的规则）。原白名单是：

```python
INDEX_FILES = ("README.md", "README.en.md", "docs/CHANGELOG.md", "docs/CHANGELOG.en.md")
```

⇒ 索引一迁走，**所有** `docs/*.md` 立刻变成孤岛 ⇒ 必须把 `CONTRIBUTING.md` 加进白名单：

```python
INDEX_FILES = (
    "README.md", "README.en.md", "CONTRIBUTING.md",
    "docs/CHANGELOG.md", "docs/CHANGELOG.en.md",
)
```

同时更新脚本的提示文案（两处「须被 README / CHANGELOG 索引」）。

### 口径同步

- `AGENTS.md` §「新增文档后必须在 README.md / CHANGELOG.md / 涉及的 PRD 章节建立反向链接」
  ⇒ 补上 `CONTRIBUTING.md`，并写明「#504 起知识库文档索引在 CONTRIBUTING.md」。
- `CONTRIBUTING.md` 的「## 获取帮助」补一条指向本文档的「文档索引」。

## 验证

| 项 | 结果 |
|---|---|
| `scripts/check-doc-links.py` | ✓ 251 个 markdown，无断链 / 无孤岛文档 |
| `python3 -m unittest discover -s scripts` | ✓ 143 passed |
| `scripts/check-versions.py` | ✓（README 中英各 2 处版本引用未动） |
| 前端 `tsc` / `lint` / `prettier` / `build` / `i18n:check` | ✓ |
| `vitest` | ✓ 469 → **475**（新增 6 例区块顺序断言） |

**反向验证（1 处 mutation 被捕获）**：把「描述」区块挪回「执行状态」之前 ⇒
「交接任务 在 描述 之前」「三块实时内容都不在执行状态/会话之前」两条断言失败 ✓。

## 影响面

- 前端：`components/DetailPanel.tsx`（仅 JSX 顺序）、`components/detail-panel-head.test.tsx`（+6 例）；
- 文档：`README.md` / `README.en.md` / `CONTRIBUTING.md` / `AGENTS.md`；
- 工具：`scripts/check-doc-links.py`（`INDEX_FILES` + 提示文案）；
- **零后端 / 零 DB schema / 零 i18n 改动**。

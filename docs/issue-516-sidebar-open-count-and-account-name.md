# 顶栏计数移到左侧账号分组 + 账号名完整显示（不再截断） — #516

> 用户先问「**状态栏 logo 旁边的数字 19 是什么意思**」，解释完口径后决定**去掉那个数字**；
> 讨论「副作用（少了一个『还剩多少要做』的信号）如何补回」时，用户选定方案 ③
> （**放在左侧 Sidebar**），并追加要求：**账号要显示全，可以自动换行**。

## 背景：为什么顶栏那个数字该搬走

顶栏品牌名右侧的计数（v0.7.10 起，#484）口径是「未完成 issue 数」：
`countOpenIssues` 排除 `issueState === 'closed'`（GitHub 权威关闭）与
`status === 'done'`（看板标为已完成）。

问题在于**它的值依赖四重筛选**，而文案（「未完成 {n} 条」/「{n} open」）**不体现任何前提**：

| 维度 | 是否影响该数字 |
|---|---|
| 左侧仓库筛选 | ✅ |
| 顶部关键词搜索 | ✅ |
| 账号模式（单账号 / 全部账号） | ✅ |
| 归属筛选（分配给我 / 无人认领 / 分配给他人） | ✅（后端 `list_tasks` 按 ownership 过滤后才下发） |

看的人只能猜它是「总数」/「我的」/「当前筛选下的」—— 三种理解都合理，且数字本身无法自证。

⚠️ 还有一个**结构性**理由：它**本来就不等于看板各列之和**（看板「已完成」列仍然列出
GitHub 上已关闭的任务，#484 的注释里就写明了）⇒ 属于「有信息成本、无澄清收益」的展示。

## 为什么落在**账号分组标题行**

三个候选位置的对比：

| 位置 | 口径可解释性 | 结论 |
|---|---|---|
| 顶栏（品牌名右侧） | ❌ 离「哪个账号 / 哪种归属 / 搜了什么」都很远 | **搬走** |
| 看板区内 | ✅ 紧邻看板 | 可行，但与「哪个账号」无关 |
| **左侧账号分组标题行** | ✅ **紧邻账号列表** ⇒ 「这些账号下还剩多少」自明 | **采纳**（用户选定） |

⚠️ 关键前提：**账号名必须完整可辨认** —— 否则「紧邻账号列表」这个上下文优势不成立
（分不清是哪个账号，计数照样说不清）。⇒ 追加「账号显示全 + 自动换行」的要求。

## 实现

### 1. 计数从顶栏搬到账号分组标题行

```diff
- <span className="muted">{t('topbar.openCount', { n: openCount })}</span>   // 顶栏
+ <div className="sidebar-group-head">
+   <span className="sidebar-group-title">{t('sidebar.accountsTitle')}</span>
+   {openCount > 0 && (
+     <span className="sidebar-open-count muted small" title={t('sidebar.openCountTitle', { n: openCount })}>
+       {t('sidebar.openCount', { n: openCount })}
+     </span>
+   )}
+ </div>
```

- 计数 **> 0 才渲染**（不显示「未完成 0 条」这种噪音）；
- `title` 给出完整口径：「当前视图未完成 N 条（不含 GitHub 已关闭与看板已完成）」；
- **口径与位置一起改**：数字的**筛选前提**仍然全部生效（仓库 / 关键词 / 账号模式 / 归属），
  但现在**上下文本就在旁边** ⇒ 不用再靠文案解释「这是总数还是我的」。

### 2. 账号名完整显示 + 自动换行

**问题**（实测）：`.sidebar-item` 用 `white-space: nowrap` + `.sidebar-item-label` 用
`text-overflow: ellipsis` ⇒ 长 org 名被**单行截断**；而 `title` 写的是
「切换到该账号的看板」⇒ **截断后完全认不出是哪个账号**；
折叠态（56px 纯图标）下文字标签整个隐藏，更是只剩一个**匿名图标**。

**修法**（与仓库同型修复一致 —— `.session-card-title` / `.session-meta-value`）：

```css
.sidebar-group.accounts .sidebar-item {
  white-space: normal;
  align-items: flex-start;   /* 多行时图标不再垂直居中到整块文本的中线 */
  padding-top: 5px;
  padding-bottom: 5px;
}

.sidebar-group.accounts .sidebar-item-label {
  flex: 1 1 auto;
  min-width: 0;              /* flex 子项必须允许收缩，否则长串不换行而是顶出侧栏 */
  overflow: visible;
  text-overflow: clip;
  white-space: normal;
  overflow-wrap: anywhere;   /* 兜底**无空格**的长 org 名 */
  line-height: 1.35;
}

.sidebar-group.accounts .sidebar-icon {
  margin-top: 2px;           /* 图标与首行文字对齐 */
}
```

⚠️ `overflow-wrap: anywhere` 而非 `break-word`：`break-word` 只在合适断点断，
`AnExtremelyLongOrgName` 这类**无空格**长串仍会顶出侧栏。

### 3. `title` 改为**账号全名**

```diff
- title={t('sidebar.switchAccount')}
+ title={`${label} · ${t('sidebar.switchAccount')}`}
```

**折叠态下 title 是唯一能分辨账号的线索**（文字标签 `display:none`）⇒ 必须含账号全名。
原先只写「切换到该账号的看板」⇒ 折叠态下几个账号全是**同样的匿名图标**。

### 4. 折叠态（56px）处理

`.sidebar.collapsed .sidebar-group-head { display: none; }` —— 标题与计数都靠文字表达，
纯图标模式放不下。账号的辨认靠 §3 的 `title` ⇒ 折叠态仍可用。

### 5. 词条

| key | zh | en |
|---|---|---|
| `sidebar.openCount` | 未完成 {n} 条 | {n} open |
| `sidebar.openCountTitle` | 当前视图未完成 {n} 条（不含 GitHub 已关闭与看板已完成） | {n} unfinished in the current view (excluding issues closed on GitHub or marked done on the board) |

`topbar.openCount` **删除**（随顶栏展示一起下线 ⇒ 不留死词条）⇒ i18n key 数
449 → 448（删 1 加 2）⇒ **450**。

## 验证

### 可视化（Chrome 无头 + 真实 `styles.css`，复刻 Sidebar 的真实 DOM）

| 读数 | 值 | 判据 |
|---|---|---|
| `overflowing`（`scrollWidth > clientWidth` 的标签） | **[]** | 无截断 |
| `longLabelHeight` / `shortLabelHeight` | **70 / 18** | 长账号名确实换行（4 行） |
| `lastCharVisible` | **true** | 文本不超出侧栏 |
| `countRightOfTitle` / `countVisible` | **true / true** | 计数在标题右侧且可见 |
| `sidebarOverflowX` | **0** | 侧栏无横向溢出 |
| `iconTopDelta`（图标 top − 文字 top） | **2px** | 图标与首行对齐 |

### 单测（+17）

| 位置 | 例数 | 内容 |
|---|---|---|
| `components/sidebar.test.tsx`（**新**） | 7 | 计数在标题行内 / 为 0 不渲染 / 默认不渲染 / 位置在标题后、账号列表前 / `title` 含账号全名 / 账号名不被截断 / 折叠态 `title` 仍保留全名 |
| `styles.test.ts` | +4 | 账号项不再用省略截断 / 允许换行（含 `min-width:0`）/ 标题行横向排开 / 折叠态隐藏标题行 |
| `utils/openCount.test.ts` | 6（**恢复**） | 计数口径（closed / done 各排除、混合列表） |

⚠️ **一处断言范式的修正**：「折叠态隐藏标题行」是 **CSS 行为**（`display:none`），
SSR 的 DOM 里元素仍在 ⇒ 该断言归 `styles.test.ts`（`?raw` 静态断言），
组件测试只断言 DOM 层可验证的部分（折叠态 `title` 仍含全名）。

### 门禁

| 项 | 结果 |
|---|---|
| `cargo fmt --check` / `clippy --all-targets` / `test` | ✓（本次零 Rust 改动） |
| `npx tsc --noEmit` | ✓ |
| `npm run lint`（`--max-warnings 0`） | ✓ |
| `npx prettier --check "src/**/*.{ts,tsx,css}"` | ✓ |
| `npm run build` | ✓ |
| `npm run i18n:check` | ✓（中英各 **450** key） |
| `npx vitest run` | ✓ 33 文件 / **537** 例 |
| `python3 -m unittest discover -s scripts -p 'test_*.py'` | ✓ 143 例 |
| 四个 `scripts/check-*.py` | ✓ |

## 影响面

| 文件 | 改动 |
|---|---|
| `app/src/App.tsx` | 计数传给 Sidebar（`countOpenIssues` + `useMemo`），顶栏不再展示 |
| `app/src/components/Sidebar.tsx` | 新增 `openCount` prop + 标题行 + 账号 `title` 用全名 |
| `app/src/styles.css` | 账号项换行样式 + 标题行 / 计数样式 + 折叠态隐藏 |
| `app/src/utils/openCount.ts` + `.test.ts` | **保留**（口径不变，仍是纯函数 + 单测守着） |
| `app/src/i18n/locales/{zh-CN,en-US}.json` | 删 `topbar.openCount`，加 `sidebar.openCount` / `sidebar.openCountTitle` |

**零后端** · 零 DB schema · 零新依赖。

## 连带修的一处断链

`docs/issue-484-topbar-open-count.md`（v0.7.10 的历史设计文档）链接到
`app/src/utils/openCount.ts` ⇒ 该文件在本轮**保留**（不再删除），
但文档里「已于 #516 删除」的说法已不成立 ⇒ 按 AGENTS.md §5.5「旧文档若被新文档取代，
在文档顶部标注已被 `<new-doc>` 取代」更新了后续说明（口径描述改为
「**已移至左侧账号分组**」而非「已删除」）。

## 已知边界

- 折叠态（< 900px 窗口）下**不显示**计数（纯图标模式放不下文字），账号辨认靠 `title`。
- 计数**始终显示**（不随主区导航切换而隐藏）—— 它是账号列表的属性，与当前在看哪个页面无关。

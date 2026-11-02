# 移除顶栏的「未完成 N 条」计数 — #516

> 用户先问「状态栏 logo 旁边的数字 19 是什么意思」，解释完口径后决定**直接去掉这个数字**。

## 背景：这个数字为什么容易被误读

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
GitHub 上已关闭的任务，#484 的文案注释里就写明了这一点）⇒ 属于「有信息成本、无澄清收益」的展示。

## 改动

### 1. `App.tsx` —— 移除展示 + **随之失效的引用**

```diff
- import { countOpenIssues } from './utils/openCount';
- const openCount = useMemo(() => countOpenIssues(visible), [visible]);
- <span className="muted">{t('topbar.openCount', { n: openCount })}</span>
```

⚠️ **不能只删 JSX**：`app/tsconfig.json` 开了 `noUnusedLocals` / `noUnusedParameters`
⇒ 留着未用的 import 与未用的 `openCount` 变量会**直接编译失败**（`tsc --noEmit` 报错）。

### 2. 删除已成死代码的模块

`app/src/utils/openCount.ts` + `app/src/utils/openCount.test.ts` 移除调用后**全仓无引用**
⇒ 一并删除。

依据：本仓不留死代码 / 死词条 —— 同 #508 复查发现的 `detail.bodyEmpty`
（加了却全仓无引用的 i18n 词条）被当作 Low 缺陷处理，本次同理。

### 3. 删除死词条

`topbar.openCount` 从 `zh-CN.json` 与 `en-US.json` 各删一处 ⇒ i18n key 数 **449 → 448**。

## 验证

### 可视化（Chrome 无头 + 真实 CSS，真实应用外壳）

| 项 | 结果 |
|---|---|
| 顶栏左侧内容 | **只剩品牌名「TaskBoard」+ 备忘录按钮** ⇒ 数字已消失 |
| 残留空隙 | **无**（React 直接移除该节点；`.topbar-left` 是 `flex` + `gap:10px`，少一个子元素不会留空盒子） |
| 顶栏右侧 | 上次同步 / 账号选择 / 刷新按钮 **不受影响** |

### 门禁

| 项 | 结果 |
|---|---|
| `cargo fmt --check` / `clippy --all-targets` / `test` | ✓（本次零 Rust 改动） |
| `npx tsc --noEmit` | ✓（`noUnusedLocals` 生效 ⇒ 未用引用已清干净） |
| `npm run lint`（`--max-warnings 0`） | ✓ |
| `npx prettier --check "src/**/*.{ts,tsx,css}"` | ✓ |
| `npm run build` | ✓ |
| `npm run i18n:check` | ✓（中英各 **448** key，一致） |
| `npx vitest run` | ✓ 31 文件 / **520** 例（原 32 / 526 ⇒ 减去删掉的 `openCount.test.ts` 6 例） |
| `python3 -m unittest discover -s scripts -p 'test_*.py'` | ✓ 143 例 |
| 四个 `scripts/check-*.py` | ✓ |

### 全仓残留引用检查

`openCount` / `countOpenIssues` / `topbar.openCount` ⇒ **0 处**。

## 影响面

| 文件 | 改动 |
|---|---|
| `app/src/App.tsx` | 移除展示 + 未用的 import / useMemo |
| `app/src/utils/openCount.ts` | **删除**（死代码） |
| `app/src/utils/openCount.test.ts` | **删除**（随模块） |
| `app/src/i18n/locales/{zh-CN,en-US}.json` | 删死词条 `topbar.openCount`（449 → 448） |

**零后端** · 零 DB schema · 零新依赖。

## 历史记录（不改）

`docs/CHANGELOG.md` 的 **v0.7.10（#484）** 记录了当初把这个数字从「共 N 条」改成
「未完成 N 条」的理由 —— 那是**版本历史叙述**，刻意保留不动。
本次移除是**新的产品决定**（记录在 v0.8.2 块里），两者不冲突。

## 副作用

⚠️ 顶栏少了一个「当前还剩多少要做」的直观信号 —— 若之后想保留这个信息，
**更好的位置是左侧 Sidebar**（那里已经有归属 / 账号筛选的上下文，
同一个数字放在那儿口径自明），或改成**看板列头**上的计数（与列内容同源、不会自相矛盾）。

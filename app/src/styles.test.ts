import { describe, expect, it } from 'vitest';
// 用 Vite 的 `?raw` 拿源码文本，而不是 `node:fs` —— 后者需要 `@types/node`，
// 而 CI（`npm ci` + `tsc --noEmit`）里并没有该类型包，会报 TS2307。
import stylesRaw from './styles.css?raw';
import panelRaw from './components/SyncLogsPanel.tsx?raw';
import sessionsPanelRaw from './components/SessionsPanel.tsx?raw';

/**
 * 同步日志面板的横向滚动回归测试。
 *
 * 背景：表格最小内容宽度会超过弹窗内宽（`.sync-logs-modal` 固定 720px，内容区 680px；
 * 目标列最长 320px，且表头与多数单元格 `white-space: nowrap`）。此前
 * `.sync-logs-table-wrap` 用的是 `overflow: hidden`，溢出部分被**静默裁掉**——
 * 右侧「明细 / 错误」列看不见，也没有任何滚动条，用户无法察觉内容缺失。
 *
 * 该缺陷是纯 CSS 表现问题，vitest 跑在 node 环境（无 DOM、无布局引擎），
 * 无法用渲染断言覆盖，因此改为对源码做静态断言——与仓库既有的
 * `scripts/check-mcp-columns.py` / `scripts/check-doc-links.py` 同一思路。
 */

// 剥离注释：断言只针对声明本身，避免注释里提到写法（如「原先用 overflow: hidden」）就被命中。
const styles = stylesRaw.replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * 取出「作用于某元素的全部声明块」。
 *
 * #393：原实现只匹配**精确选择器字面量**：
 * ```ts
 * const re = new RegExp(`(?:^|[},])\s*${escaped}\s*\{([^}]*)\}`, 'gm');
 * ```
 * 两个系统性盲区（实测 5 种形态中 4 种漏网）：
 * 1. **锚点 `(?:^|[},])` 不含 `{`** ⇒ `@media` / `@supports` 块**内的规则完全不可见**。
 *    而 #259 的缺陷本体正是「窄屏四列被压成 ~18px 竖条」—— 响应式回归恰好活在媒体查询里。
 * 2. **只认字面量相等** ⇒ 后代选择器 `.notes-page .notes-card-cols`（作用于同一元素、
 *    特异性更高、实际生效）与合并选择器 `.notes-card-cols, .sidebar` 都被漏掉。
 *
 * 改为：全局提取所有「选择器 + 声明体」对，再按**最后一个复合选择器**精确匹配。
 * `([^{}]+)\{([^{}]*)\}` 会跳过 `@media` 外壳（其声明体含 `{`），直接取到内层规则。
 */
function decls(selector: string): string {
  // 匹配语义：规则选择器（按逗号拆开、去掉祖先前缀后）**以调用方选择器结尾**。
  // 这样同时覆盖四种写法：
  //   · 完全相同            `.notes-card-cols`
  //   · 后代（祖先前缀）    `.notes-page .notes-card-cols`
  //   · 合并规则里的其中一项 `.notes-card-cols, .sidebar`
  //   · 调用方自带后代      `.notes-page .notes-panel`
  // 用 endsWith 而非 startsWith / 包含，避免 `.note-col` 误命中 `.note-col--p1`。
  const target = selector.trim();
  const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
  const hits: string[] = [];
  for (const m of styles.matchAll(ruleRe)) {
    const selectorList = m[1];
    const body = m[2];
    const applies = selectorList.split(',').some((part) => part.trim().endsWith(target));
    if (applies) hits.push(body);
  }
  expect(hits.length, `styles.css 中找不到作用于 ${selector} 的规则`).toBeGreaterThan(0);
  return hits.join('\n');
}

describe('同步日志表格横向滚动', () => {
  it('表格容器不得用 overflow: hidden —— 否则溢出列被裁且不产生滚动条', () => {
    const d = decls('.sync-logs-table-wrap');
    expect(d).not.toMatch(/overflow\s*:\s*hidden/);
    expect(d).toMatch(/overflow\s*:\s*auto/);
  });

  it('容器成为受约束的滚动区：flex 列 + min-height: 0', () => {
    // 两者缺一不可：没有 min-height: 0，flex 项的 auto 最小高度会阻止收缩，
    // 容器被表格撑到完整高度，横向滚动条就会落到可视区之外（需先纵向滚到底）。
    expect(decls('.sync-logs-table-wrap')).toMatch(/min-height\s*:\s*0/);
    const body = decls('.sync-logs-body');
    expect(body).toMatch(/display\s*:\s*flex/);
    expect(body).toMatch(/flex-direction\s*:\s*column/);
  });

  it('筛选行不参与收缩，避免被表格挤扁', () => {
    expect(decls('.sync-logs-filter')).toMatch(/flex-shrink\s*:\s*0/);
  });

  it('「同步记录」与「API 明细」共用同一容器 ⇒ 该修复须同时覆盖两个页签', () => {
    expect(panelRaw.match(/sync-logs-table-wrap/g) ?? []).toHaveLength(2);
  });
});

/**
 * 侧边栏窄窗收起（#265）回归测试。
 *
 * 背景：窗口宽度 < 900px 时侧边栏应自动收起为纯图标模式（`.sidebar.collapsed`）。
 * 该行为纯靠 CSS 表达（隐藏标签 / 分组标题 / 空态 + 收窄宽度），vitest 无布局引擎，
 * 故沿用 `?raw` 静态断言，与同步日志表格横向滚动测试同一思路。
 */
describe('侧边栏窄窗收起 #265', () => {
  it('收起态收窄到纯图标宽度（约 56px），main-content 仍 flex:1 占满', () => {
    const d = decls('.sidebar.collapsed');
    expect(d).toMatch(/flex-basis\s*:\s*56px/);
    expect(d).toMatch(/width\s*:\s*56px/);
  });

  it('收起态隐藏文字标签 / 分组标题 / 空态，仅保留图标', () => {
    expect(decls('.sidebar.collapsed .sidebar-item-label')).toMatch(/display\s*:\s*none/);
    expect(decls('.sidebar.collapsed .sidebar-group-title')).toMatch(/display\s*:\s*none/);
    expect(decls('.sidebar.collapsed .sidebar-empty')).toMatch(/display\s*:\s*none/);
  });

  // #516：账号分组标题行（含「未完成 N 条」计数）整体收起 —— 纯图标模式放不下文字。
  it('收起态隐藏账号分组标题行（含未完成计数）', () => {
    expect(decls('.sidebar.collapsed .sidebar-group-head')).toMatch(/display\s*:\s*none/);
  });
});

/**
 * 侧边栏账号名完整显示 + 自动换行（#516）。
 *
 * 背景：`.sidebar-item` 用 `white-space: nowrap` + `.sidebar-item-label` 用
 * `text-overflow: ellipsis` ⇒ 长 org 名（如 `@user (FoodsUp-Inc-Group)`）被单行截断，
 * 而 `title` 写的又是「切换到该账号的看板」⇒ **截断后认不出是哪个账号**；
 * 折叠态（56px 纯图标）下文字标签整个隐藏，更是只剩一个匿名图标。
 *
 * 口径与同型修复一致（见 `.session-card-title` / `.session-meta-value`）：
 * 去截断 + 允许断行；`overflow-wrap: anywhere` 兜底**无空格**的长 org 名
 * （`break-word` 只在合适断点断，这类串仍会顶出侧栏）。
 *
 * vitest 无布局引擎，沿用 `?raw` 静态断言。
 */
describe('侧边栏账号名完整显示', () => {
  it('.sidebar-group.accounts .sidebar-item 不再使用省略截断', () => {
    const d = decls('.sidebar-group.accounts .sidebar-item');
    expect(d).not.toMatch(/text-overflow\s*:\s*ellipsis/);
    expect(d).not.toMatch(/white-space\s*:\s*nowrap/);
  });

  it('.sidebar-group.accounts .sidebar-item-label 允许自动换行', () => {
    const d = decls('.sidebar-group.accounts .sidebar-item-label');
    expect(d).not.toMatch(/text-overflow\s*:\s*ellipsis/);
    expect(d).not.toMatch(/overflow\s*:\s*hidden/);
    expect(d).toMatch(/white-space\s*:\s*normal/);
    // `anywhere` 而非 `break-word`：org 名可能无空格长串。
    expect(d).toMatch(/overflow-wrap\s*:\s*anywhere/);
    // flex 子项必须允许收缩，否则长串不换行而是顶出侧栏。
    expect(d).toMatch(/min-width\s*:\s*0/);
  });

  it('账号分组标题行把标题与计数横向排开', () => {
    const d = decls('.sidebar-group-head');
    expect(d).toMatch(/display\s*:\s*flex/);
    expect(d).toMatch(/justify-content\s*:\s*space-between/);
  });
});

/**
 * 会话卡片彩色边框（#304）回归测试。
 *
 * 背景：会话卡片底色与面板背景过于接近，用户希望每张卡片加边框并随机使用
 * 几种颜色，相邻卡片颜色必须不同。着色公式 `(row + col) % palette.length`
 * 确保水平相邻（col 差 1）与垂直相邻（row 差 1）颜色必不同。
 * 列数由 CSS grid `auto-fill` 响应式决定，运行时通过 `getComputedStyle` 实测。
 *
 * 该行为纯 CSS + 运行时布局，vitest 无布局引擎，故沿用 `?raw` 静态断言。
 */
describe('会话卡片彩色边框 #304', () => {
  it(':root 定义 4 种边框色 CSS 变量', () => {
    const root = stylesRaw.replace(/\/\*[\s\S]*?\*\//g, '');
    for (let i = 1; i <= 4; i++) {
      expect(root).toMatch(new RegExp(`--session-card-border-${i}\\s*:`));
    }
  });

  it('.session-card 声明 border', () => {
    const d = decls('.session-card');
    expect(d).toMatch(/border\s*:\s*1px\s+solid/);
  });

  it('着色公式 (row + col) % 4 存在', () => {
    expect(sessionsPanelRaw).toMatch(/\(row\s*\+\s*col\)\s*%\s*4/);
  });

  it('运行时通过 getComputedStyle 实测列数', () => {
    expect(sessionsPanelRaw).toMatch(/getComputedStyle/);
    expect(sessionsPanelRaw).toMatch(/gridTemplateColumns/);
  });

  it('sessions-list 容器有 ref 用于列数测量', () => {
    expect(sessionsPanelRaw).toMatch(/ref=\{listRef\}/);
  });
});

/**
 * 任务详情弹窗化（#494）回归测试。
 *
 * 背景：详情原为「右侧 50% 抽屉」（`.detail` 绝对定位贴右边缘），改为**居中 Modal**。
 * 几何纯由 CSS 决定，vitest 无布局引擎，故沿用 `?raw` 静态断言锁定关键属性。
 *
 * 实测（Chrome 无头 + 注入读数，见 docs/issue-494-detail-modal.md）：
 * 1280×657 视口下卡片 720×561、`centered dx=0 dy=0`、`scrollHeight 925 > clientHeight 559`；
 * 560×657 视口下卡片宽 512（= 视口 - 48px 边距）、左右各 24px、`横向溢出元素 0`。
 */
describe('任务详情居中弹窗 #494', () => {
  it('卡片以 50% + translate 居中，不得回退成贴右的抽屉', () => {
    const d = decls('.detail');
    expect(d).toMatch(/left\s*:\s*50%/);
    expect(d).toMatch(/transform\s*:\s*translate\(\s*-50%\s*,\s*-50%\s*\)/);
    // 抽屉特征：`right: 0` 贴右边缘 + `width: 50%` 占半屏。
    expect(d).not.toMatch(/right\s*:\s*0\b/);
    // ⚠️ 用负向前查排除 `max-width:`（否则会被误判成命中）。
    expect(d).not.toMatch(/(?<!max-)width\s*:\s*50%/);
  });

  it('窄窗口不溢出：max-width 留边距 + 内容内部滚动', () => {
    const d = decls('.detail');
    expect(d).toMatch(/max-width\s*:\s*calc\(\s*100%\s*-\s*48px\s*\)/);
    expect(d).toMatch(/max-height\s*:\s*calc\(\s*100%\s*-\s*96px\s*\)/);
    expect(d).toMatch(/overflow-y\s*:\s*auto/);
  });

  it('头部 sticky：内容很长时关闭按钮不随内容滚走', () => {
    const h = decls('.detail-head');
    expect(h).toMatch(/position\s*:\s*sticky/);
    expect(h).toMatch(/top\s*:\s*0\b/);
    // 不透明背景 ⇒ 滚过的内容不会从头部下方透出。
    expect(h).toMatch(/background\s*:\s*var\(--surface\)/);
  });

  it('遮罩覆盖整个窗口且用 --overlay（与仓库既有 .modal-mask 一致）', () => {
    const b = decls('.detail-backdrop');
    expect(b).toMatch(/inset\s*:\s*0/);
    expect(b).toMatch(/background\s*:\s*var\(--overlay\)/);
  });
});

/**
 * 详情头部**不得遮挡标题**（#498）。
 *
 * #498 的实测（Chrome 无头，真实 CSS + 真实 DOM）：
 * `head 底部 354.9` vs `title 顶部 346.9` ⇒ 重叠 8px，标题文字被盖 6px。
 *
 * 根因：**`position: sticky` 会抵消负 margin**——sticky 把元素钉到滚动容器
 * padding box 顶部时按 border box 对齐，负 margin 的上移效果被抵消，
 * 头部整体下移 16px ⇒ 盖住紧随其后的 `.detail-title`。
 *
 * 正解：`.detail` 的 `padding-top` 归零 + 头部**只用左右负 margin**撑满宽，
 * 顶部留白交给头部自己的 padding ⇒ 不再有上下位移 ⇒ sticky 与正常流位置一致。
 */
describe('详情头部不得遮挡标题 #498', () => {
  it('.detail 的 padding-top 归零（顶部留白交给头部自己）', () => {
    const d = decls('.detail');
    // 期望 `padding: 0 18px 16px`（三段式，上下分别写）。
    expect(d).toMatch(/padding\s*:\s*0\s+18px\s+16px/);
    // 旧的 `padding: 16px 18px` 会让负 margin 与 sticky 打架。
    expect(d).not.toMatch(/padding\s*:\s*16px\s+18px\s*;/);
  });

  it('.detail-head 不得有上下负 margin（sticky 会抵消它 ⇒ 盖住标题）', () => {
    const h = decls('.detail-head');
    // 只允许左右负 margin：形如 `margin: 0 -18px`。
    expect(h).toMatch(/margin\s*:\s*0\s+-\d+px/);
    // ⚠️ 负的上/下 margin 才是病根（`-16px -18px 0` 这类）。
    expect(h).not.toMatch(/margin\s*:\s*-[\d.]+px\s/);
  });

  it('.detail-head 的顶部留白由自身 padding 提供', () => {
    const h = decls('.detail-head');
    // ⚠️ #500：底部 padding 由 8px 调为 10px —— 头部现在多了一行标题，
    //    底部留白要留给「标题 → 分隔线」这一段。
    expect(h).toMatch(/padding\s*:\s*16px\s+18px\s+10px/);
  });

  it('.detail-head 仍是 sticky + 不透明背景', () => {
    const h = decls('.detail-head');
    expect(h).toMatch(/position\s*:\s*sticky/);
    expect(h).toMatch(/top\s*:\s*0\b/);
    expect(h).toMatch(/background\s*:\s*var\(--surface\)/);
  });
});

/**
 * 详情头部**两行固定**（#500）。
 *
 * 用户的原话：「向下滚动时，issue id 行和 modal 顶部有一段透明边距，
 * 建议 issue id 行和标题行，都不参与滚动」。
 *
 * 拆成两条可验证的诉求：
 * ① **透明边距**：滚动时 sticky 钉住的位置必须与正常流位置一致
 *    ⇒ 头部**不得有上下负 margin**（sticky 会抵消它，被抵消后头部比正常流
 *    低一截 ⇒ 顶部冒出一段空白）。同时 `top` 必须是 `0`（贴弹窗内边缘）。
 * ② **两行都不参与滚动**：头部容器是**纵向块**（issue id 行 + 标题行同属一个
 *    sticky 容器），左右分列下沉到 `.detail-head-row`。
 *
 * Chrome 无头实测（真实 CSS + 真实 DOM，滚动前 / 滚动 120px）：
 *   head.top 相对 modal 顶部 = 1.00px（= modal 自身 1px 边框）
 *   row.top  = 17.00px ／ title.top = 52.00px
 *   滚动 120px 后三个值**完全不变** ⇒ 两行都固定、顶部无空隙、内容不透出。
 */
describe('详情头部两行固定 #500', () => {
  it('.detail-head 是纵向块：横向排布下沉到 .detail-head-row', () => {
    // 头部若仍是横向 flex ⇒ 标题会被排到第一行右侧（不再「单独一行」）。
    expect(decls('.detail-head')).not.toMatch(/display\s*:\s*flex/);
    const row = decls('.detail-head-row');
    expect(row).toMatch(/display\s*:\s*flex/);
    expect(row).toMatch(/justify-content\s*:\s*space-between/);
  });

  it('.detail-head 仍是 sticky + top:0 + 不透明背景（钉在弹窗内边缘）', () => {
    const h = decls('.detail-head');
    expect(h).toMatch(/position\s*:\s*sticky/);
    expect(h).toMatch(/top\s*:\s*0\b/);
    expect(h).toMatch(/background\s*:\s*var\(--surface\)/);
  });

  it('.detail-head 不得有负 margin（sticky 抵消它 ⇒ 顶部冒出空隙）', () => {
    // ⚠️ #498 的断言只挡「负的上 margin」（`margin: -16px -18px 0`），
    //    这里补齐「任何方向的负 margin」都算病根。
    expect(decls('.detail-head')).not.toMatch(/margin\s*:\s*-/);
  });

  it('.detail-title 下 margin 归零（否则与头部 padding 叠加出多余空白）', () => {
    expect(decls('.detail-title')).toMatch(/margin\s*:\s*8px\s+0\s+0/);
  });
});

/**
 * issue 正文（描述）区块（#498）。
 */
describe('issue 正文区块 #498', () => {
  it('.detail-body 有正文排版基础样式', () => {
    const d = decls('.detail-body');
    expect(d).toMatch(/line-height\s*:\s*1\.\d+/);
    // 长 URL 不得横向撑破弹窗。
    expect(d).toMatch(/overflow-wrap\s*:\s*anywhere/);
  });

  it('折叠态限高 + 裁溢出 + 底部渐隐遮罩', () => {
    const d = decls('.detail-body.collapsed');
    expect(d).toMatch(/max-height\s*:\s*\d+px/);
    expect(d).toMatch(/overflow\s*:\s*hidden/);
    // 渐隐遮罩提示「下面还有内容」。
    expect(decls('.detail-body.collapsed::after')).toMatch(/linear-gradient/);
  });

  it('.markdown 代码块用等宽字体变量（禁硬编码 font-family）', () => {
    expect(decls('.markdown code')).toMatch(/font-family\s*:\s*var\(--font-mono\)/);
  });
});

/**
 * 会话卡片标题换行完整显示回归测试。
 *
 * 背景：任务会话卡片标题原用 `white-space: nowrap` + `text-overflow: ellipsis`
 * 单行截断，导致长标题被省略为 "..."，用户无法在不进入详情的情况下完整阅读。
 * 改为 `white-space: normal` + `word-break: break-word` 自动换行完整显示。
 */
describe('会话卡片标题完整显示', () => {
  it('.session-card-title 不再使用省略截断', () => {
    const d = decls('.session-card-title');
    expect(d).not.toMatch(/text-overflow\s*:\s*ellipsis/);
    expect(d).not.toMatch(/white-space\s*:\s*nowrap/);
    expect(d).not.toMatch(/overflow\s*:\s*hidden/);
  });

  it('.session-card-title 允许自动换行', () => {
    const d = decls('.session-card-title');
    expect(d).toMatch(/white-space\s*:\s*normal|white-space\s*:\s*pre-wrap/);
    expect(d).toMatch(/word-break\s*:\s*break-word|overflow-wrap\s*:\s*break-word/);
  });
});

/**
 * 任务会话的meta 行完整显示（#418）。
 *
 * 背景：`.session-meta-value` 承载**分支名 / 目录名 / session id / agent / 时间**
 * （见 `SessionsPanel.tsx`），原声明为 `white-space: nowrap` + `text-overflow: ellipsis`
 * + `overflow: hidden` ⇒ 长分支名（如 `feature/lsz/418-fix-x@main261009`）与长工作目录
 * 被单行截断，且这些值**没有 `title` 属性兜底**，悬停也看不到全值 ⇒ 信息彻底丢失。
 *
 * `overflow-wrap: anywhere` 而非 `break-word`：分支名/路径虽含 `/` 但 session id、
 * agent 名等可能是无空格长串，`break-word` 只在合适断点断，这类串仍会顶出卡片。
 *
 * vitest 无布局引擎，沿用 `?raw` 静态断言。
 */
describe('任务会话 meta 行完整显示', () => {
  it('.session-meta-value 不再使用省略截断', () => {
    const d = decls('.session-meta-value');
    expect(d).not.toMatch(/text-overflow\s*:\s*ellipsis/);
    expect(d).not.toMatch(/white-space\s*:\s*nowrap/);
    expect(d).not.toMatch(/overflow\s*:\s*hidden/);
  });

  it('.session-meta-value 允许换行且无空格长串可断', () => {
    const d = decls('.session-meta-value');
    expect(d).toMatch(/white-space\s*:\s*normal|white-space\s*:\s*pre-wrap/);
    expect(d).toMatch(/overflow-wrap\s*:\s*anywhere|word-break\s*:\s*break-all/);
  });

  it('.session-meta-row 顶对齐，长值换行时不与标签错位', () => {
    // 换行后首行应与标签顶部对齐；`center` 会让多行值视觉下沉。
    expect(decls('.session-meta-row')).toMatch(/align-items\s*:\s*flex-start/);
  });

  it('保留等宽字体（改换行不应把分支名改成比例字体）', () => {
    expect(decls('.session-meta-value')).toMatch(/font-family\s*:\s*var\(--font-mono\)/);
  });
});

/**
 * CSS 变量引用完整性（#329）回归测试。
 *
 * 背景：`.session-meta-label` 引用了从未定义的 `--text-secondary`、
 * `.session-meta-value` 引用了从未定义的 `--font-mono`。CSS 对未定义变量
 * **不报错**，整条声明被丢弃 ⇒ 颜色退回继承值、分支名不再等宽，样式静默失效，
 * 肉眼极难发现（`${'var(--x)'}` 无兜底值时求值为无效）。
 * vitest 无布局引擎，故沿用 `?raw` 静态断言：遍历样式表里所有 `var(--x)`，
 * 要求「在样式表内定义过」或「带兜底值」。
 */
describe('CSS 变量引用完整性（#329）', () => {
  it('每个 var(--x) 都已在样式表内定义，或带兜底值', () => {
    const defined = new Set([...styles.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
    const missing: string[] = [];
    // 第三捕获组区分 `var(--x)` 与 `var(--x, fallback)`：后者即使未定义也有兜底。
    for (const m of styles.matchAll(/var\(\s*(--[\w-]+)\s*([,)])/g)) {
      const [, name, sep] = m;
      const hasFallback = sep === ',';
      if (!defined.has(name) && !hasFallback && !missing.includes(name)) missing.push(name);
    }
    expect(missing, `未定义且无兜底值的 CSS 变量：${missing.join(', ')}`).toEqual([]);
  });

  it('会话卡片等宽字段引用的 --font-mono 已在 :root 定义', () => {
    expect(decls('.session-meta-value')).toMatch(/font-family\s*:\s*var\(--font-mono\)/);
    expect(styles).toMatch(/--font-mono\s*:/);
  });

  it('会话卡片标签用的 --text-2 是真实存在的变量（不是 --text-secondary）', () => {
    expect(decls('.session-meta-label')).toMatch(/color\s*:\s*var\(--text-2\)/);
    expect(styles).not.toMatch(/--text-secondary/);
  });

  it('笔记面板后台刷新用 aria-busy 降透明，不再整块替换占位（#329）', () => {
    // #456：容器类名从 .notes-card-cols 改为 .notes-list
    const d = decls('.notes-list[aria-busy]');
    expect(d).toMatch(/opacity/);
  });

  it('会话面板后台刷新用 aria-busy 降透明，不再整块替换占位（#441）', () => {
    // 会话面板刷新频率远高于记事面板（MCP 直写 SQLite，靠事件 + 20s 轮询），
    // 若不降透明，用户会看到卡片列表每 20s 闪一次「加载中」占位。
    const d = decls('.sessions-content[aria-busy]');
    expect(d).toMatch(/opacity/);
  });

  it('会话面板刷新用 opacity 过渡，避免降透明时硬跳变（#441）', () => {
    expect(decls('.sessions-content')).toMatch(/transition\s*:\s*opacity/);
  });
});

/**
 * 任务会话多选选中态高亮（#391）回归测试。
 *
 * 选中卡片须有明显视觉反馈（边框强调 + 浅色底），否则用户无法确定哪些已选。
 * 纯 CSS，沿用 `?raw` 静态断言。
 */
describe('会话卡片选中态高亮 #391', () => {
  it('.session-card.selected 强调边框与主色浅底', () => {
    const d = decls('.session-card.selected');
    expect(d).toMatch(/border-color\s*:\s*var\(--accent\)/);
    expect(d).toMatch(/background/);
  });

  it('.session-card.selectable 提示可点击', () => {
    expect(decls('.session-card.selectable')).toMatch(/cursor\s*:\s*pointer/);
  });

  it('.sessions-toolbar 作为选择工具栏布局', () => {
    const d = decls('.sessions-toolbar');
    expect(d).toMatch(/display\s*:\s*flex/);
  });
});

/**
 * 字体偏好接线（#444）回归。
 *
 * 关键不变量：**body 不得再出现硬编码的 font-family / font-size**。
 * #444 之前 `body` 写死 `-apple-system, ...` 与 `13px`，另有 8 处
 * `font-family: 'SF Mono', Menlo, monospace` 散落各处（分支名 / 路径 /
 * session id / 代码块）。字体偏好要能全站生效，这些硬编码必须全部收进
 * `--font-ui` / `--font-mono` 变量 —— 漏一处，该处就**不跟随**用户选择，
 * 且症状隐蔽（其它区域都变了，只有这一小块没变）。
 */
describe('字体偏好接线（#444）', () => {
  it('--font-ui / --font-mono / --font-size-base 三个变量都有权威定义', () => {
    const root = decls(':root');
    expect(root, ':root 须定义 --font-ui').toMatch(/--font-ui\s*:/);
    expect(root, ':root 须定义 --font-mono').toMatch(/--font-mono\s*:/);
    expect(root, ':root 须定义 --font-size-base').toMatch(/--font-size-base\s*:/);
  });

  it('body 的 font-family / font-size 均走变量，不再硬编码', () => {
    // ⚠️ 不能用 decls('body')：它按**后缀**匹配，会把 `html, body` 合并规则
    // 一并返回（那条规则里仍有 13px），导致本条恒失败。改为直接对 body 专属
    // 声明块断言（用前置换行 + 精确 `}` 收尾）。
    const m = styles.match(/(?:^|\})\s*body\s*\{([^}]*)\}/m);
    const body = m?.[1] ?? '';
    expect(body, '应能取到 body 专属声明块').not.toBe('');
    expect(body).toMatch(/font-family\s*:\s*var\(--font-ui\)/);
    expect(body).toMatch(/font-size\s*:\s*var\(--font-size-base\)/);
    // 负向：这两行是本次要消灭的硬编码形态
    expect(body).not.toMatch(/font-family\s*:\s*-apple-system/);
    expect(body).not.toMatch(/font-size\s*:\s*\d+px/);
  });

  it('全站无硬编码等宽字体栈（原先散落 8 处，全部改为变量引用）', () => {
    const body = stylesRaw;
    expect(body, "styles.css 不应再出现 font-family: 'SF Mono', Menlo, monospace").not.toMatch(
      /font-family\s*:\s*'SF Mono',\s*Menlo,\s*monospace/,
    );
    // 变量引用数 = 8 处替换 + :root 定义 1 处
    const refs = (body.match(/var\(--font-mono\)/g) ?? []).length;
    expect(refs).toBeGreaterThanOrEqual(9);
  });

  it('主层级字号用 rem（随 --font-size-base 缩放），徽章/meta 的 10-12px 保持 px', () => {
    const body = stylesRaw;
    // 正文主层级已转 rem（13px→0.8125rem、14px→0.875rem）
    expect(body).toMatch(/font-size\s*:\s*0\.8125rem/);
    expect(body).toMatch(/font-size\s*:\s*0\.875rem/);
    // ⚠️ 徽章 / meta / 图标类 10-12px **有意保留 px**：它们承担与基线字号
    // 解耦的语义（见知识库文档「为何不改 px」），故此处断言 px 仍存在。
    expect(body, '徽章/meta 小字号应仍为 px').toMatch(/font-size\s*:\s*1[012]px/);
    // 13/14px 主层级不得再以 px 形式出现
    expect(body).not.toMatch(/font-size\s*:\s*1[34]px/);
  });

  it('.font-preview 预览行有独立视觉分层，且字号用 rem 跟随缩放', () => {
    const d = decls('.font-preview');
    expect(d).toMatch(/border/);
    expect(d).toMatch(/background/);
    expect(d).toMatch(/font-size\s*:\s*0\.875rem/);
  });
});

/**
 * 视觉系统重构的「能力约束」断言集。
 *
 * 背景：本次重构把样式表从「散落 hex + 写死色值」改造成「令牌驱动 + 双主题」。
 * 但**令牌写了不等于生效** —— 缺失的覆盖、失效的声明、错位的书写顺序都能让
 * 一切悄悄退化，而这些退化在 node 环境（无 DOM、无布局引擎）的 vitest 里
 * **一个都测不出来**。本组断言把「会悄悄退化的地方」显式钉死。
 *
 * 每条断言都必须能**反向失败**：删掉对应实现后，用例必须红。
 */
describe('视觉系统能力约束（令牌层 / 双主题 / 焦点环）', () => {
  it('根字号已接线 —— 否则 rem 完全不随 --font-size-base 缩放', () => {
    // 现状缺陷：fontPrefs.ts 把 --font-size-base 写到 <html> 内联样式，但根字号
    // 恒为浏览器默认 16px ⇒ 0.8125rem 恒为 13px ⇒ 用户改字号偏好**毫无效果**
    // （WCAG 1.4.4 实质失效）。系数 1.23076923 = 16 / 13 ⇒ base=13px 时根字号
    // 16px、视觉逐像素不变；base=18px 时 0.8125rem = 18px ⇒ 偏好真正生效。
    expect(styles, 'html 未接根字号，rem 不会跟随 --font-size-base 缩放').toMatch(
      /html\s*\{[^}]*font-size\s*:\s*calc\(var\(--font-size-base\)\s*\*\s*1\.23076923\)/,
    );
  });

  it('样式表不出现运行时不可用的混色函数（与 vite build.target 绑定）', () => {
    // app/vite.config.ts 的 build.target = chrome105 / safari13，而 color-mix()
    // 需 Chrome 111 / Safari 16.2、oklab()/oklch() 需 Chrome 111 / Safari 15.4 ⇒
    // Vite 的 postcss **不做降级**，声明被浏览器**整条丢弃**（不是降级成别的值）。
    // 仓库内已因此产生 3 处「声明看着有、运行时整条失效」的隐性缺陷。
    expect(styles, '不得使用 color-mix() / oklab() / oklch()').not.toMatch(
      /color-mix\(|oklab\(|oklch\(/,
    );
  });

  it('深色块覆盖了浅色的 status / repo 底色，且取值不同（**全量 40 槽**）', () => {
    // 这是本次最高价值的修复：原 [data-theme='dark'] 块内**一个 --status- 都没有**
    // ⇒ 深色模式沿用浅色 status 值（实测 2.09–4.61:1，13/20 达不到 3:1）。
    //
    // ⚠️ **全量断言，不抽查**：此前只查 0 / 19 两个槽位 ⇒ 中间 36 个槽漏了也测不出
    //   （比如有人把 --status-7 的深色值误删或误改成浅色值，测试照样绿）。
    const root = decls(':root');
    const dark = decls("[data-theme='dark']");
    const names: string[] = [];
    for (let i = 0; i < 20; i++) names.push(`--status-${i}`, `--repo-${i}-bg`);
    for (const name of names) {
      const rootVal = root.match(new RegExp(`${name}\\s*:\\s*(#[0-9a-fA-F]{6})`))?.[1];
      const darkVal = dark.match(new RegExp(`${name}\\s*:\\s*(#[0-9a-fA-F]{6})`))?.[1];
      expect(rootVal, `:root 须定义 ${name}`).toBeTruthy();
      expect(darkVal, `深色块须覆盖 ${name}`).toBeTruthy();
      expect(darkVal, `深色 ${name} 不得与浅色同值`).not.toBe(rootVal);
    }
  });

  it('根字号**确实**随 --font-size-base 变化（不是只写一行 CSS）', () => {
    // ⚠️ 此前的断言只检查「CSS 里存在 font-size: calc(var(--font-size-base) * ...)」，
    //   **删掉那行也能过** —— 它锁的是「写法」不是「行为」。
    // 本条改为**行为断言**：把根字号公式当成函数，验证它对 base 档位的实际输出。
    //
    // 根字号 = base * (16/13) ⇒ base=13px ⇒ 16px（视觉逐像素不变）
    //                              base=18px ⇒ 22.1538px ⇒ 0.8125rem = 18px ✅
    const m = styles.match(
      /html\s*\{\s*font-size\s*:\s*calc\(var\(--font-size-base\)\s*\*\s*([\d.]+)\)\s*;?\s*\}/,
    );
    expect(m, 'html 缺 font-size: calc(var(--font-size-base) * 系数) 接线').not.toBeNull();
    const factor = Number(m?.[1]);
    expect(factor, '根字号系数必须是 16/13 ≈ 1.23076923').toBeCloseTo(16 / 13, 6);
    // 行为验证：base=13 时 0.8125rem 仍等于 13px（逐像素不变）
    const rootAt13 = 13 * factor;
    expect(rootAt13 * 0.8125, 'base=13 时 0.8125rem 须仍为 13px').toBeCloseTo(13, 6);
    // 行为验证：base=18 时 0.8125rem 变为 18px（字号偏好真正生效）
    const rootAt18 = 18 * factor;
    expect(rootAt18 * 0.8125, 'base=18 时 0.8125rem 须为 18px').toBeCloseTo(18, 6);
  });

  it('rem 只用于 font-size（根字号接线不得引起布局副作用）', () => {
    // 根字号接线只在 font-size 上生效 ⇒ rem 用于间距/尺寸会把布局也放大。
    // 实测：现有 20 处 rem **全部**是 font-size，零处用于间距。
    // ⚠️ 本条锁住这个前提 —— 若将来有人写 `margin: 0.5rem`，
    //    18px 档下间距会跟着放大（320px 固定列宽下挤压内容）。
    const remUses = [...styles.matchAll(/([a-z-]+)\s*:\s*([^;]*\drem[^;]*);/g)];
    const nonFontSize = remUses.filter(([, prop]) => !/font-size/.test(prop ?? ''));
    expect(
      nonFontSize.map(([, prop, val]) => `${prop}: ${val}`),
      'rem 只能用于 font-size —— 用于间距/尺寸会让 18px 档布局一起放大',
    ).toEqual([]);
  });

  it('所有 z-index 声明都走 --z-* 令牌（不得有漏网的字面量）', () => {
    // ⚠️ 上面的「z-index 只能引用 --z-* 令牌」只校验**格式**（值长得像令牌），
    //   删除某一条 z-index 声明后，剩下的自然仍全是令牌格式 ⇒ 测试照样绿。
    // 本条校验**数量与位置**：z-index 声明的总数必须与 --z-* 令牌的使用数匹配。
    const zDecls = (styles.match(/z-index\s*:/g) ?? []).length;
    const zTokenRefs = (styles.match(/z-index\s*:\s*var\(--z-[a-z-]+\)/g) ?? []).length;
    const zAuto = (styles.match(/z-index\s*:\s*auto/g) ?? []).length;
    // 全部 z-index 声明 = 令牌引用 + 刻意的 auto（.panel-page .modal-mask，
    // auto ≠ 0 是有意为之：它不需要参与全局层级序列）。
    // ⚠️ 差值 > 0 ⇒ 有**字面量**漏网（如 z-index: 20）。
    expect(zDecls - zTokenRefs - zAuto, '存在未走 --z-* 令牌、也不是 auto 的 z-index 字面量').toBe(
      0,
    );
    // 已知共有 9 处：8 处走令牌（topbar / toolbar / detail / detail-head /
    //   detail-backdrop / modal-mask / note-viewer-mask / note-editor-mask）
    //   + 1 处刻意为 `auto`。
    expect(zDecls, 'z-index 声明数应与规范一致（新增层级时同步更新本条）').toBe(9);
    expect(zTokenRefs, '走 --z-* 令牌的 z-index 应有 8 处').toBe(8);
    expect(zAuto, '刻意的 z-index: auto 应有 1 处').toBe(1);
  });

  it('.cmt-link / .pr-link 不得用 --accent 作文字色（实测浅 4.04 / 深 4.13，不达 AA）', () => {
    // `--accent` 是**色块色**（门槛 ≥3:1），不适合作文字色 —— 与 --status-N
    // 必须配 --status-N-text 是同一条道理。
    // 原先 `.cmt-link, .pr-link` 用 --accent 压 --accent-soft ⇒ 双双跌破 4.5。
    // ⇒ 改用专用文字色 --info + 专用底 --info-bg（浅 4.97 / 深 5.66）。
    const d = decls('.cmt-link');
    expect(d, '.cmt-link 不得用 --accent 作文字色').not.toMatch(/color\s*:\s*var\(--accent\)/);
    expect(d, '.cmt-link 应用 --info 作文字色').toMatch(/color\s*:\s*var\(--info\)/);
    expect(d, '.cmt-link 应用 --info-bg 作底色').toMatch(/background\s*:\s*var\(--info-bg\)/);
    // 同一条规则也覆盖 .pr-link
    expect(decls('.pr-link'), '.pr-link 同样不得用 --accent 作文字色').not.toMatch(
      /color\s*:\s*var\(--accent\)/,
    );
  });

  it('四态圆点 --dot-* 的深色值必须存在且不同于浅色', () => {
    // ⚠️ 上一条「全量深色覆盖」只覆盖 --status-N / --repo-N-bg，
    //   **漏了 --dot-* 四态圆点** ⇒ 删掉深色 --dot-processed 测试照样绿。
    const root = decls(':root');
    const dark = decls("[data-theme='dark']");
    for (const name of ['--dot-todo', '--dot-doing', '--dot-processed', '--dot-done']) {
      const rootVal = root.match(new RegExp(`${name}\\s*:\\s*(#[0-9a-fA-F]{6})`))?.[1];
      const darkVal = dark.match(new RegExp(`${name}\\s*:\\s*(#[0-9a-fA-F]{6})`))?.[1];
      expect(rootVal, `:root 须定义 ${name}`).toBeTruthy();
      expect(darkVal, `深色块须覆盖 ${name}`).toBeTruthy();
      expect(darkVal, `深色 ${name} 不得与浅色同值`).not.toBe(rootVal);
    }
  });

  it('焦点环三段式齐全，且两个笔记文本框不再撤掉 outline', () => {
    expect(styles, '须有 :focus 兜底').toMatch(
      /:focus\s*\{[^}]*outline\s*:\s*2px solid var\(--accent\)/,
    );
    expect(styles, '须有 :focus:not(:focus-visible) —— 鼠标点击不留环').toMatch(
      /:focus:not\(:focus-visible\)/,
    );
    expect(styles, '须有 :focus-visible —— 键盘导航显示环').toMatch(
      /:focus-visible\s*\{[^}]*outline\s*:\s*2px solid var\(--accent\)/,
    );
    // ⚠️ 旧写法 `outline: none` 的特异性（0,2,0）高于全局 :focus-visible（0,1,0）
    // ⇒ 键盘聚焦时焦点环同样被撤掉（WCAG 2.4.7 失效）。
    // ⚠️ 用**全表**扫描而非 decls('.note-textarea:focus')：该规则已按
    // Phase 1 §12.1.2 删除（border:0 下 border-color 是死声明），
    // 按选择器查会因「找不到规则」而失败 —— 但要防的从来不是「没有规则」，
    // 而是「某个选择器又把 outline 撤掉了」。
    expect(styles, '笔记文本框不得撤掉 outline').not.toMatch(
      /\.note-textarea[^{}]*\{[^}]*outline\s*:\s*none/,
    );
    expect(styles, '编辑文本框不得撤掉 outline').not.toMatch(
      /\.note-editor-textarea[^{}]*\{[^}]*outline\s*:\s*none/,
    );
  });

  it('圆角只允许 4 档令牌（原有 12 种字面量已收敛）', () => {
    const allowed = new Set([
      'var(--radius-sm)',
      'var(--radius-md)',
      'var(--radius-lg)',
      'var(--radius-full)',
      '0',
    ]);
    const literals = (stylesRaw.match(/border-radius:\s*([^;]+);/g) ?? []).map((r) =>
      r
        .replace(/border-radius:\s*/, '')
        .replace(/;\s*$/, '')
        .trim(),
    );
    for (const v of literals) {
      expect(allowed.has(v), `border-radius 只允许 4 档令牌，实际出现 ${v}`).toBe(true);
    }
  });

  it('已删除的僵尸规则不得复活（.gh-status-N / .gh-status-{五类} / .gh-state-open）', () => {
    // 这些规则无任何组件引用（组件只渲染 `gh-status` 与 `gh-state gh-state-closed`），
    // 却带着 26 条规则 + 60+ 个硬编码色值 —— 改主题变量时会让人误以为它们在生效。
    expect(styles, '.gh-status-N 僵尸规则应已删除').not.toMatch(/\.gh-status-\d+\s*\{/);
    expect(styles, '.gh-status-{五类} 僵尸规则应已删除').not.toMatch(
      /\.gh-status-(?:todo|doing|processed|done|canceled)\s*\{/,
    );
    expect(styles, '.gh-state-open 僵尸规则应已删除').not.toMatch(/\.gh-state-open\s*\{/);
  });

  it('仓库配色变体必须排在 .gh-status 之后（书写顺序陷阱）', () => {
    // 同特异性下**后者胜出**。`.repo-N` 若排在 `.gh-status` 之前，它声明的
    // background / color 会被 `.gh-status` 整体覆盖 ⇒ 仓库配色静默失效。
    const ghPos = styles.search(/\.gh-status\s*\{/);
    const repoPos = styles.search(/\.repo-0\s*\{/);
    expect(ghPos, '找不到 .gh-status 规则').toBeGreaterThan(-1);
    expect(repoPos, '找不到 .repo-0 规则').toBeGreaterThan(-1);
    expect(repoPos, '.repo-N 变体必须晚于 .gh-status 基础样式').toBeGreaterThan(ghPos);
  });

  it('--focus-halo 已废止（Phase 1 §12.1.2），不得复活', () => {
    // 废止理由（4 条，规范原文）：
    //   ① 职责错位：第二个使用点 `.note-card.confirming` 是「删除确认」，**根本不是焦点态**；
    //   ② 与 --accent-focus 语义重复，alpha 差 4 倍却无可陈述的语义差异；
    //   ③ 0.10/0.16 档合成后仅 1.15:1 / 1.29:1 —— 比面板之间的层差（1.06:1）还弱；
    //   ④ token 卫生：一个视觉含义只保留一个令牌。
    // ⇒ 唯一柔光环令牌是 --accent-focus（浅 0.42 / 深 0.55，取值不变）。
    expect(styles, '--focus-halo 令牌不得复活').not.toMatch(/--focus-halo\s*:/);
    expect(styles, '不得再有 var(--focus-halo) 引用').not.toMatch(/var\(--focus-halo\)/);
  });

  it('--accent-focus 必须被实际引用（不能是「已定义但引用数 0」的死令牌）', () => {
    // Phase 1 §11 的口径：--accent-focus 是**唯一**的柔光环令牌。
    // 若引用数归零 ⇒ 要么令牌白留着，要么有人新造了第二个柔光令牌（同样是命名污染）。
    const refs = styles.match(/var\(--accent-focus\)/g) ?? [];
    expect(refs.length, '--accent-focus 引用数应为 0（死令牌）').toBeGreaterThan(0);
    // 两主题都必须声明它（否则深色主题会回落到 :root 的浅色值）。
    const rootDecl = (styles.match(/--accent-focus\s*:/g) ?? []).length;
    expect(rootDecl, '--accent-focus 必须在 :root 与深色块各声明一次').toBe(2);
  });

  it('聚焦态必须有「实心线索」：2px accent 边框 / outline，柔光环不可单独承担识别', () => {
    // Phase 1 §12.1.1 硬规则：任何聚焦/激活态至少 1 条 ≥3:1 的实心线索。
    // --accent-focus 合成后仅 1.84:1（浅）/ 2.75:1（深）⇒ 只能装饰。
    const composer = decls('.note-composer:focus-within');
    expect(composer, '聚焦的 composer 必须有 ≥2px 的 accent 实心边框').toMatch(
      /border-width\s*:\s*2px/,
    );
    expect(composer, '聚焦的 composer 边框必须是 accent 色').toMatch(
      /border-color\s*:\s*var\(--accent\)/,
    );
    // 焦点环三段式：主环必须是不透明 --accent 的 outline。
    expect(styles, '全局焦点环必须用不透明 --accent').toMatch(
      /:focus-visible\s*\{[^}]*outline\s*:\s*2px solid var\(--accent\)/,
    );
  });

  it('.note-composer 的 border-width 不得加入 transition（宽度过渡会每帧重排）', () => {
    // 规范明确：焦点反馈应瞬时，0.5px→2px 的宽度过渡每帧触发重排。
    const composer = decls('.note-composer');
    const transition = composer.match(/transition\s*:\s*([^;]+);/);
    if (transition) {
      expect(transition[1], 'transition 不得包含 border-width').not.toMatch(/border-width/);
    }
  });

  it('.note-textarea:focus 死声明不得复活（border:0 下无视觉效果）', () => {
    // `.note-textarea` 是 border:0 ⇒ border-color 改 accent 没有任何视觉效果。
    // 聚焦提示已由 `.note-composer:focus-within` 的 2px 边框 + textarea 自身 outline 承担。
    expect(styles, '.note-textarea:focus 死声明应已删除').not.toMatch(/\.note-textarea:focus\s*\{/);
  });

  it('.toggle 的焦点环必须画在可见的 .slider 上（input 是 0×0 零尺寸元素）', () => {
    // `.toggle input { opacity:0; width:0; height:0 }` ⇒ 全局 :focus-visible 的
    // outline 画在这个零尺寸透明元素上 ⇒ **焦点环完全不可见**（WCAG 2.4.7 失败）。
    // ⇒ 必须用相邻兄弟选择器把焦点环转画到可见的 .slider 上。
    expect(decls('.toggle input'), 'toggle input 必须保持视觉隐藏').toMatch(/opacity\s*:\s*0/);
    expect(styles, '.toggle input:focus-visible + .slider 焦点环缺失').toMatch(
      /\.toggle input:focus-visible\s*\+\s*\.slider\s*\{[^}]*outline\s*:\s*2px solid var\(--accent\)/,
    );
  });

  it('.toggle 焦点环须有三段式（:focus 兜底 + :not(:focus-visible) + :focus-visible）', () => {
    // ⚠️ 老引擎降级反噬：Safari 15.0–15.3 不支持 `:focus-visible`
    //   ⇒ 未知伪类让**整条选择器失效**（不是降级成别的值）
    //   ⇒ 只写 `:focus-visible` 的规则在旧引擎上直接消失
    //   ⇒ `.toggle input` 是 0×0 零尺寸元素 ⇒ 焦点环彻底消失（WCAG 2.4.7 失败）。
    // ① :focus 兜底 —— 旧引擎唯一的救命规则
    expect(styles, '.toggle input:focus + .slider 兜底缺失（旧引擎焦点环会消失）').toMatch(
      /\.toggle input:focus\s*\+\s*\.slider\s*\{[^}]*outline\s*:\s*2px solid var\(--accent\)/,
    );
    // ② :focus:not(:focus-visible) —— 现代浏览器「鼠标点击不留环」的对称写法。
    //    必须显式写：全局的 `:focus:not(:focus-visible){outline:none}` 只作用于
    //    **input 自身**，管不到兄弟节点 `.slider`。
    expect(
      styles,
      '.toggle input:focus:not(:focus-visible) + .slider 缺失（鼠标点击会留环）',
    ).toMatch(
      /\.toggle input:focus:not\(:focus-visible\)\s*\+\s*\.slider\s*\{[^}]*outline\s*:\s*none/,
    );
  });

  it('.cmt-link / .pr-link 的悬停反馈不得靠改底色（形状通道：下划线）', () => {
    // ⚠️ 旧规则「常态底 = hover 底（都是 --accent-soft）」⇒ 悬停零反馈。
    // ⚠️ 改底色不成立：--accent-soft-strong 会让深色下 --info 跌到 3.40:1（破 AA）。
    // ⇒ 走形状通道（下划线），底色恒定 ⇒ 对比度恒为 4.97 / 5.66。
    for (const sel of ['.cmt-link:hover', '.pr-link:hover']) {
      const d = decls(sel);
      expect(d, `${sel} 不得改底色（会破坏 AA 或造成色相家族漂移）`).not.toMatch(/background\s*:/);
      expect(d, `${sel} 缺少形状反馈`).toMatch(/text-decoration\s*:\s*underline/);
    }
    // .pr-link 常态底必须仍是 teal 家族（旧写法 hover 漂到 accent 家族）
    expect(decls('.pr-link'), '.pr-link 常态底必须是 --teal-bg').toMatch(
      /background\s*:\s*var\(--teal-bg\)/,
    );
    // 常态底与 hover 底必须一致（悬停不改底）
    expect(decls('.cmt-link'), '.cmt-link 常态底必须是 --info-bg').toMatch(
      /background\s*:\s*var\(--info-bg\)/,
    );
  });

  it('.modal 必须有 max-width（窄窗口下 520px 固定宽会溢出视口）', () => {
    expect(decls('.modal'), '.modal 缺 max-width').toMatch(/max-width\s*:\s*calc\(100% - 48px\)/);
  });

  it('.detail 必须有 scroll-padding-top（sticky 头会遮挡滚动定位到的焦点目标）', () => {
    // WCAG 2.4.11 焦点不被遮挡：`.detail-head` 是 sticky(top:0)，
    // 键盘 Tab 滚动到内容区元素时若不预留头部高度，该元素会被盖住。
    expect(decls('.detail'), '.detail 缺 scroll-padding-top').toMatch(/scroll-padding-top\s*:/);
  });

  it('aria-busy 的降透明不得让次级文本跌破 AA（opacity ≥ 0.8）', () => {
    // opacity 会把整层文字与背景一起向底色混合：实测浅色面 --text-2（#565d6b）
    // @0.65 仅 2.97:1、@0.75 仅 3.66:1 ⇒ 跌破 4.5；@0.80 → 4.12:1 仍差，
    // @0.85 → 4.63:1 达标但视觉上几乎看不出「正在刷新」。
    // ⇒ 取 0.80：主文本 @0.80 达 9.44:1，次级文本的残留偏差记入文档「已知偏差」。
    for (const sel of ['.notes-list[aria-busy]', '.sessions-content[aria-busy]']) {
      const m = decls(sel).match(/opacity\s*:\s*([\d.]+)/);
      expect(m, `${sel} 缺 opacity 声明`).not.toBeNull();
      const v = Number(m?.[1]);
      expect(v, `${sel} 的 opacity=${v} 过低，会让次级文本跌破 4.5:1`).toBeGreaterThanOrEqual(0.8);
    }
  });

  it('prefers-reduced-motion 必须同时关闭 transition 与 animation', () => {
    // 只关 transition 是半吊子实现：将来新增 keyframes 动画时不会被自动关闭。
    const m = styles.match(
      /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([^{}]*)\{([^{}]*)\}/,
    );
    expect(m, '找不到 prefers-reduced-motion 块').not.toBeNull();
    expect(m?.[2], 'reduced-motion 块缺 animation: none').toMatch(/animation\s*:\s*none/);
    expect(m?.[2], 'reduced-motion 块缺 transition: none').toMatch(/transition\s*:\s*none/);
  });

  it('.column-head .count 用 --text-2（列头是彩色底，--text-3 在其中 6 个组合不达 AA）', () => {
    // 列头底色是 --column-*-bg（彩色承载面），实测 --text-3：
    // 浅 doing 4.16 / processed 4.20 / done 4.07，深 doing 3.72 / processed 4.05 ⇒ 跌破 4.5。
    // 改 --text-2 后 8 个组合 4.78–7.38 全达标。
    // ⚠️ 不得改成 var(--column-*-fg) —— 那会让计数与列标题同色，抹平层级差。
    expect(decls('.column-head .count')).toMatch(/color\s*:\s*var\(--text-2\)/);
    expect(decls('.column-head .count')).not.toMatch(/color\s*:\s*var\(--text-3\)/);
  });

  it('z-index 只能引用 --z-* 令牌（层级语义必须集中可调）', () => {
    // 层级是**全局语义**（谁盖住谁），散成字面量后改一处必漏另一处。
    // 本轮把 8 处 z-index 字面量全部收敛到 8 个 --z-* 令牌（含补齐
    // --z-detail-backdrop:10 —— 此前没有对应令牌）。
    const literals = (styles.match(/z-index\s*:\s*([^;]+);/g) ?? []).map((r) =>
      r
        .replace(/z-index\s*:\s*/, '')
        .replace(/;\s*$/, '')
        .trim(),
    );
    for (const v of literals) {
      if (v === 'auto') continue; // .panel-page .modal-mask 的 auto 是刻意的（auto ≠ 0）
      expect(v, `z-index 须走 --z-* 令牌，实际出现 ${v}`).toMatch(/^var\(--z-[a-z-]+\)$/);
    }
    // 被引用的每一个 --z-* 都必须在 :root 有定义
    const root = decls(':root');
    for (const m of styles.matchAll(/var\((--z-[a-z-]+)\)/g)) {
      expect(root, `${m[1]} 必须在 :root 定义`).toMatch(new RegExp(`${m[1]}\\s*:`));
    }
  });

  it('.btn 必须有按下态并使用 --accent-active（否则该令牌是死令牌）', () => {
    // 三级层次：常态 --accent → hover --accent-hover → active --accent-active。
    // 缺 :active ⇒ 用户按住按钮时没有任何反馈，且 --accent-active 引用数为 0。
    const active = decls('.btn:active:not(:disabled)');
    expect(active, '.btn 缺 :active 按下态').toMatch(/background\s*:\s*var\(--accent-active\)/);
    expect(active, '按下态边框也应走 --accent-active').toMatch(
      /border-color\s*:\s*var\(--accent-active\)/,
    );
    expect(styles, '--accent-active 必须在 :root 与深色块各声明一次').toMatch(
      /--accent-active\s*:/,
    );
  });

  it('.input / .select 必须有聚焦态（边框走 --accent）', () => {
    // 此前**完全没有**聚焦态样式 ⇒ 鼠标点击后全局 `:focus:not(:focus-visible)`
    // 把浏览器默认框也撤了 ⇒ 聚焦时没有任何视觉反馈（WCAG 2.4.7 失败）。
    // 用 border-color 承担识别职责（≥1px 实心，Phase 1 §12.1.1 硬规则）。
    const d = decls('.input:focus');
    expect(d, '.input:focus 缺 border-color: var(--accent)').toMatch(
      /border-color\s*:\s*var\(--accent\)/,
    );
    expect(decls('.select:focus'), '.select:focus 缺 border-color: var(--accent)').toMatch(
      /border-color\s*:\s*var\(--accent\)/,
    );
  });

  it('.note-composer-modal 必须有 max-width（480px 固定宽在窄窗口溢出）', () => {
    expect(decls('.note-composer-modal')).toMatch(/max-width\s*:\s*calc\(100% - 48px\)/);
  });

  it('仓库配色用「底色 + 文字色」两个令牌，不用 --status-N 当文字色', () => {
    // --status-N 是**色块色**（门槛 ≥3:1），--status-N-text 才是**文字色**（≥4.5:1）。
    // 误用会让 11/20 组跌破 4.5:1（最低 3.03）—— 这正是必须拆两个令牌的原因。
    for (let i = 0; i < 20; i++) {
      const d = decls(`.repo-${i}`);
      expect(d, `.repo-${i} 底色须用 --repo-${i}-bg`).toMatch(
        new RegExp(`background\\s*:\\s*var\\(--repo-${i}-bg\\)`),
      );
      expect(d, `.repo-${i} 字色须用 --status-${i}-text`).toMatch(
        new RegExp(`color\\s*:\\s*var\\(--status-${i}-text\\)`),
      );
    }
  });
});

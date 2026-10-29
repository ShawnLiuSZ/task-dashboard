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

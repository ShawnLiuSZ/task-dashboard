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
    const d = decls('.notes-card-cols[aria-busy]');
    expect(d).toMatch(/opacity/);
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

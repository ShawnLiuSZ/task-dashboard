import { describe, expect, it } from 'vitest';
// 用 Vite 的 `?raw` 读源码文本，而不是 `node:fs` —— 后者需要 `@types/node`，
// 而 CI（`npm ci` + `tsc --noEmit`）里并没有该类型包，会报 TS2307。
import stylesRaw from '../styles.css?raw';
import panelRaw from './NotesPanel.tsx?raw';

/**
 * 记事本列表布局回归测试（#259 建立，#456 改列表）。
 *
 * 演进（2026-09-16 两轮 + 2026-10-19 一轮）：
 * 1. 初版按「四列等宽可收缩」实现，但真机四列被压成 ~18px 竖条 —— 根因是
 *    `NotesPanel` 在面板元素上挂了行内 `style={{flex:'0 0 25%', width:'25%'}}`（#202 遗留），
 *    行内样式优先级高于样式表，`.notes-page .notes-panel` 的「撑满」覆盖从未生效。
 * 2. 移除宽度机制 + 面板整页化后定为**看板列模式**：四列固定宽度、放不下出横向滚动条。
 * 3. **#456**：改为**列表展示** —— 网格参数与「任务会话」面板的 `.sessions-list` 完全同参
 *    （`auto-fill minmax(320px, 1fr)`），不再分列、不再有列头/列体/列宽变量。
 *    优先级从「分列依据」降级为「卡片边框 + 标签色点」的**颜色标记**。
 * 4. **#462**：再改为**瀑布流**（CSS multi-column）—— 卡片高度自适应内容，
 *    不再被同行拉齐。布局机制从 grid 换成多列流（`column-count` + `column-gap`
 *    + `column-fill: balance`），列数由 `@media` 断点写死（`column-count` 是精确值，
 *    不像 grid 的 auto-fill 会随容器宽度自动降列）。
 *
 * 判定口径（最终）：面板撑满主区且不挂行内宽度；列表区是受约束的纵向滚动区；
 * 卡片与 `.session-card` 同构且可收缩；旧的分列结构零残留；
 * 瀑布流参数（`column-fill: balance`、无 `column-width`、`break-inside: avoid`、
 * 卡片 `margin-bottom` 间距、`@media` 列数断点）逐条锁定。
 *
 * ⚠️ 本仓库约定：改被静态断言覆盖的源码必须**同步改这里**（#444 / #450 / #452 / #456 / #460 均踩过）。
 *
 * vitest 跑在 node 环境（无 DOM、无布局引擎），无法用渲染断言覆盖，
 * 因此改为对源码做静态断言——与 `styles.test.ts`、`scripts/check-*.py` 同一思路。
 */

// 剥离注释：断言只针对声明本身，避免注释里提到写法（如「曾用 flex-wrap: wrap」）就被命中。
const styles = stylesRaw.replace(/\/\*[\s\S]*?\*\//g, '');
// TSX 同理：注释里提到 addColCollapsed 不应算作「四列依赖创建列状态」。
const panel = panelRaw.replace(/\/\*[\s\S]*?\*\//g, '');

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

describe('记事本列表（网格布局，#456；原 #259 四列）', () => {
  it('网格参数与「任务会话」面板的 .sessions-list 完全同参', () => {
    // #462：改为**瀑布流**（CSS multi-column）—— 不再是 grid。
    // 原「与 .sessions-list 用同一套网格」的判定已失效：瀑布流是多列流，
    // 与会话面板的 grid 是**两套不同的布局机制**。
    const list = decls('.notes-list');
    expect(list, '瀑布流不应再用 grid 布局').not.toMatch(/display\s*:\s*grid/);
    expect(list, '瀑布流不应再有 grid-template-columns').not.toMatch(/grid-template-columns/);
    expect(list).toMatch(/column-count\s*:\s*3/);
    expect(list).toMatch(/column-gap\s*:\s*10px/);
  });

  it('瀑布流关键参数：column-fill: balance 必留，且不得用 column-width', () => {
    // ⚠️ 两条都是**实测得出**的，勿凭直觉改：
    // · `column-fill: auto` 会让内容退化成**单列**（多列容器不产生纵向滚动，
    //   而是把内容横向铺开）⇒ 瀑布流完全失效。必须用默认的 `balance`。
    // · `column-width` 是「建议」值，浏览器会压缩它以塞进更多列
    //   （实测 1154px 容器里 `column-count: 3` + `column-width: 320px` 仍排 3 列
    //   但卡宽 378px —— `column-width` 根本没约束住列宽）⇒ 加了也没用，别加。
    const list = decls('.notes-list');
    expect(list, '必须显式写 column-fill: balance').toMatch(/column-fill\s*:\s*balance/);
    expect(list, 'column-width 无法约束列宽，别加').not.toMatch(/column-width/);
  });

  it('列数随窗口宽度降级：@media 断点写死（column-count 不随容器自动变）', () => {
    // `column-count` 是**精确值**，不像 grid 的 auto-fill 会随容器宽度自动降列。
    // 因此必须用 @media 断点显式改列数，否则窄窗口下仍是 3 列、卡片被挤扁。
    // 断点参照 Tauri 窗口默认 1180×760 与 minWidth 900。
    expect(styles, '缺少 ≤1400px 的两列断点').toMatch(
      /@media\s*\(max-width:\s*1400px\)\s*\{[^}]*\.notes-list\s*\{[^}]*column-count\s*:\s*2/,
    );
    expect(styles, '缺少 ≤900px 的单列断点').toMatch(
      /@media\s*\(max-width:\s*900px\)\s*\{[^}]*\.notes-list\s*\{[^}]*column-count\s*:\s*1/,
    );
  });

  it('卡片是多列流的子项：break-inside avoid + margin-bottom 间距', () => {
    // · `break-inside: avoid` —— 多列流默认会把元素跨列断开，卡片会被切成两半。
    // · `margin-bottom` —— 多列流里 `column-gap` 只管**列**间距，卡片之间的
    //   **纵向**间距得靠 margin（原先由 grid 的 `gap: 10px` 承担）。
    const card = decls('.note-card');
    expect(card, '卡片可能被切成两半').toMatch(/break-inside\s*:\s*avoid/);
    expect(card, '卡片纵向间距缺失').toMatch(/margin\s*:\s*0 0 10px/);
  });

  it('卡片不得用 width: 100% —— 多列流里它相对整个容器而非列宽', () => {
    // ⚠️ 实测踩过的坑：`width: 100%` 在多列流里解析为相对**整个容器**，
    // 单列时卡片直接撑到 2688px（容器 900px）⇒ 横向溢出。
    // 块级子项在多列流里自动占满列宽，用 `width: auto` 即可。
    const card = decls('.note-card');
    expect(card, 'width:100% 会撑破容器（多列流里相对整个容器）').not.toMatch(/width\s*:\s*100%/);
    expect(card).toMatch(/width\s*:\s*auto/);
  });

  it('列表容器是受约束的纵向滚动区（flex + min-height 0 + overflow-y auto）', () => {
    // flex 子项的 auto 最小高度会阻止收缩 ⇒ 没有 min-height:0 时滚动条会落到可视区之外。
    //
    // #465：滚动宿主已从 `.notes-list` **拆到 `.notes-scroll`** ——
    // 多列容器若同时限高 + 滚动，列高会被锁死 ⇒ `break-inside: avoid` 失效
    // （同一条备忘录被劈成两列）且纵向根本不滚动（只横向铺开）。
    const d = decls('.notes-scroll');
    expect(d).toMatch(/flex\s*:\s*1\s+1\s+auto/);
    expect(d).toMatch(/min-height\s*:\s*0/);
    expect(d).toMatch(/overflow-y\s*:\s*auto/);
    // 滚到头后不再向父级链式滚动
    expect(d).toMatch(/overscroll-behavior\s*:\s*contain/);
    // 「看板固定最大高度」：滚动区有明确上限
    expect(d).toMatch(/max-height\s*:\s*520px/);
  });

  it('多列容器（.notes-list）不得限高、不得自带滚动（#465 核心约束）', () => {
    // ⚠️ 这条是 #465 的技术核心，改动前务必读 styles.css 里 `.notes-list` 的注释。
    //
    // 若 `.notes-list`（多列容器）自己带 `max-height` 或 `overflow-y: auto`：
    // ① 列高 = 容器高度被锁死 ⇒ 卡片比列高更高时浏览器只能跨列断开
    //    （用户截图：一条备忘录被劈成左右两半）；
    // ② 多列容器在确定高度下只把内容**横向**铺开 ⇒ 纵向根本不滚动
    //    （实测 1440px 视口：横向溢出 3338px、scrollable=false）。
    const d = decls('.notes-list');
    expect(d, '多列容器不得限高（列高被锁死 ⇒ 卡片跨列断开）').not.toMatch(/max-height/);
    expect(d, '多列容器不得自带滚动（会退化成横向铺开）').not.toMatch(/overflow-y/);
    expect(d, '多列容器不得横向滚动').not.toMatch(/overflow-x/);
    // 高度自适应内容 —— 列高由内容自然决定 ⇒ break-inside: avoid 恒生效
    expect(d).toMatch(/height\s*:\s*auto/);
  });

  it('滚动宿主与多列容器是两层（组件里必须有 .notes-scroll 包裹 .notes-list）', () => {
    // 结构断言：`.notes-scroll` 必须**包住** `.notes-list`（滚动在外、列容器在内）。
    // 若两者合一（只留 .notes-list），会同时踩中上面两条缺陷。
    const scrollIdx = panel.indexOf('className="notes-scroll"');
    const listIdx = panel.indexOf('className="notes-list"');
    expect(scrollIdx, 'NotesPanel.tsx 中找不到 .notes-scroll').toBeGreaterThan(-1);
    expect(listIdx, 'NotesPanel.tsx 中找不到 .notes-list').toBeGreaterThan(-1);
    expect(scrollIdx, '.notes-scroll 应在 .notes-list 之前（外层）').toBeLessThan(listIdx);
  });

  it('旧的分列结构已彻底移除（.notes-card-cols / .note-col* 一族）', () => {
    // 这类「僵尸 CSS + 僵尸类名」是分列改列表后最容易留下的残留：
    // 规则还在、但没人用，日后改主题变量会以为它在生效。
    expect(panel, '组件仍在用 .notes-card-cols').not.toContain('notes-card-cols');
    expect(panel, '组件仍在用 note-col').not.toContain('note-col');
    expect(styles, 'styles.css 仍残留 .notes-card-cols 规则').not.toMatch(/\.notes-card-cols\s*\{/);
    expect(styles, 'styles.css 仍残留 .note-col 规则').not.toMatch(/\.note-col\s*\{/);
    // 列宽变量随之失效：#462 起列数由 column-count + @media 断点决定
    expect(styles, '--notes-col-w 已随分列移除').not.toMatch(/--notes-col-w/);
  });

  it('卡片与 .session-card 同构：背景 / 圆角 / 内边距 / column 布局', () => {
    // #462：卡片**几何**仍与 `.session-card` 同构（视觉统一），但**布局机制**
    // 已分家 —— 会话面板是 grid 卡片流，备忘录是多列流瀑布流。
    const card = decls('.note-card');
    const session = decls('.session-card');
    expect(card).toMatch(/display\s*:\s*flex/);
    expect(card).toMatch(/flex-direction\s*:\s*column/);
    expect(card).toMatch(/border-radius\s*:\s*10px/);
    expect(card).toMatch(/padding\s*:\s*12px 14px/);
    // 逐项比对会话卡片，防止两者漂移
    expect(card).toMatch(session.match(/border-radius[^;]*;/)![0]);
    expect(card).toMatch(session.match(/padding\s*:\s*12px 14px/)![0]);
    expect(card).toMatch(session.match(/gap\s*:\s*8px/)![0]);
  });

  it('优先级颜色改由卡片承载：边框染色 + 标签色点', () => {
    // #456：网格里没有列头做视觉锚点，优先级只能靠卡片自身传达。
    // 边框染成优先级色（--note-accent 由组件按标签注入）比仅靠一个小色点更易扫视。
    const card = decls('.note-card');
    expect(card).toMatch(/border\s*:\s*1px solid var\(--note-accent/);
    // 组件必须真的注入 --note-accent（否则全部落 var(--border) 兜底，四色全同）
    expect(panel).toContain("'--note-accent': opt.color");
    // 标签色点保留并加强
    const dot = decls('.note-dot');
    expect(dot).toMatch(/background\s*:\s*var\(--note-accent/);
    expect(dot).toMatch(/width\s*:\s*7px/);
    expect(dot).toMatch(/box-shadow\s*:[^;]*color-mix/);
  });

  it('卡片仍无左侧色条（#259 用户明确要求，不得借改版之机加回来）', () => {
    expect(styles).not.toMatch(/\.note-card::before/);
  });

  it('卡片可收缩 ⇒ 网格内不会长出横向滚动条', () => {
    // 若卡片保持 min-width: auto，其子元素（.note-foot 的标签 + 时间 + 操作按钮）
    // 的 min-content 会把卡片撑宽，进而让 .notes-list（overflow-y: auto ⇒
    // overflow-x 计算成 auto）出现横向滚动条。
    expect(decls('.note-card')).toMatch(/min-width\s*:\s*0/);
    expect(decls('.note-foot')).toMatch(/flex-wrap\s*:\s*wrap/);
  });

  it('卡片底色与面板底色不同 ⇒ 卡片边界可见（#259 踩过的坑）', () => {
    expect(decls('.notes-panel')).toMatch(/background\s*:\s*var\(--bg\)/);
    expect(decls('.note-card')).toMatch(/background\s*:\s*var\(--surface-2\)/);
  });

  it('排序只用创建时间倒序，优先级不参与排序也不参与分列', () => {
    // #456：优先级只决定颜色，不再是组织维度。
    const m = panel.match(/const sortedNotes = useMemo\([\s\S]*?\);/);
    expect(m, '应能取到 sortedNotes').not.toBeNull();
    expect(m![0]).toMatch(/b\.createdAt\s*-\s*a\.createdAt/);
    // 依赖数组必须跟着变（notes 变化才重排）
    expect(m![0]).toMatch(/\[notes\]/);
    // 不得残留按优先级排序的权重表
    expect(panel).not.toMatch(/prio\s*:/);
    // 容器直接渲染 sortedNotes，不再有分列 map
    expect(panel).toContain('sortedNotes.map(renderNoteCard)');
    expect(panel, '不得再有分列渲染').not.toMatch(/\.map\(\(col\)/);
  });

  it('空列表有占位提示（原来只有 loading 分支，空列表会渲染空白）', () => {
    expect(panel).toContain('sortedNotes.length === 0');
  });
});

describe('备忘录折叠 + 查看全文按钮（#465）', () => {
  /**
   * 需求（用户截图）：
   * ① 同一条备忘录不能被劈成两列；
   * ② 看板固定最大高度 + 滚动条；
   * ③ 每张卡片右上角加「查看」按钮，弹 Modal 看全文。
   *
   * ① 由布局机制解决（多列容器高度自适应 ⇒ `break-inside: avoid` 恒生效），
   *    见上一组「多列容器不得限高」断言。
   * ③ 由「正文折叠 + 右上角按钮 + Modal」实现。
   */
  it('正文折叠：line-clamp + 省略号（不是硬切）', () => {
    // `-webkit-line-clamp` 必须配合 `display: -webkit-box` +
    // `-webkit-box-orient: vertical` 三件套，缺一个就不生效。
    // 不用 `max-height` + `overflow: hidden`：那是硬切（第 N 行被切成半行，
    // 无任何提示，用户以为内容就这么多）。
    const c = decls('.note-content');
    expect(c).toMatch(/display\s*:\s*-webkit-box/);
    expect(c).toMatch(/-webkit-box-orient\s*:\s*vertical/);
    expect(c).toMatch(/-webkit-line-clamp\s*:\s*9/);
    expect(c).toMatch(/overflow\s*:\s*hidden/);
  });

  it('正文右侧为查看按钮预留 30px（按钮恒不压住正文文字）', () => {
    // 实测：按钮绝对定位在卡片右上角，正文若顶到最右会被压住
    // （20 张卡中 1 张压字）⇒ 正文整体右侧留白，按钮落在留白里。
    expect(decls('.note-content')).toMatch(/padding-right\s*:\s*30px/);
  });

  it('查看按钮在卡片右上角且绝对定位（不占布局高度）', () => {
    const b = decls('.note-view-btn');
    expect(b).toMatch(/position\s*:\s*absolute/);
    expect(b).toMatch(/top\s*:\s*8px/);
    expect(b).toMatch(/right\s*:\s*10px/);
    // 卡片是定位祖先（否则按钮会相对更外层定位）
    expect(decls('.note-card')).toMatch(/position\s*:\s*relative/);
  });

  it('组件渲染了查看按钮并绑定查看态（点击 → 打开 Modal）', () => {
    expect(panel).toContain('className="note-view-btn"');
    expect(panel).toContain('setViewingId(note.id)');
    // 查看态派生：找不到该条（被删/刷新后）就不渲染 Modal
    expect(panel).toContain('notes.find((n) => n.id === viewingId)');
    // Modal 挂在面板内部（面板是 position:relative 的遮罩宿主）
    expect(panel).toContain('<NoteViewerModal');
    expect(panel).toContain('note={viewingNote}');
  });

  it('查看 Modal 存在且展示完整正文（不折叠）', () => {
    // Modal 正文与卡片正文的折叠规则相反：这里必须完整呈现。
    expect(decls('.note-viewer-content')).not.toMatch(/-webkit-line-clamp/);
    expect(decls('.note-viewer-content')).not.toMatch(/max-height/);
    // 保留换行
    expect(decls('.note-viewer-content')).toMatch(/white-space\s*:\s*pre-wrap/);
  });
});

describe('卡片页脚永远沉底（#460）', () => {
  /**
   * 缺陷本体：`.note-card` 是 flex column，但页脚没有 `margin-top: auto` ⇒
   * 它作为普通 flow 元素紧跟正文。列表布局（`auto-fill minmax(320px,1fr)`）
   * 让同一行卡片**等高对齐**，于是正文短的卡片下方留出空白，
   * 而空隙恰好落在页脚**下面** —— 页脚悬在半空（用户截图实测）。
   *
   * `margin-top: auto` 在 flex column 下把剩余空间吸收到该元素之前 ⇒ 页脚贴底；
   * 空间不足时 auto 解析为 0，不产生额外间隙。
   */
  it('三态的底部区都有 margin-top: auto（切换时页脚不跳位）', () => {
    // 普通态页脚 / 编辑态操作区 / 删除确认态按钮区 —— 三者都是 .note-card 的
    // 直接子元素，必须**同时**沉底，否则三态之间切换时页脚位置会跳变。
    for (const sel of ['.note-foot', '.note-edit-foot', '.note-confirm-actions']) {
      expect(decls(sel), `${sel} 缺 margin-top: auto，页脚不会沉底（#460）`).toMatch(
        /margin-top\s*:\s*auto/,
      );
    }
  });

  it('沉底靠 margin-top: auto，不靠固定 margin（auto 在空间不足时归0）', () => {
    // 固定 margin（如原来的 margin-top: 6px）会让**长内容**卡片也多出这段间隙，
    // 与父级 gap 叠加后间距不一致。
    expect(decls('.note-foot')).toMatch(/margin-top\s*:\s*auto/);
    expect(decls('.note-edit-foot')).not.toMatch(/margin-top\s*:\s*\d/);
  });

  it('前提：.note-card 必须是 flex column —— auto margin 依赖该上下文', () => {
    // margin-top: auto 只在 flex/grid 容器里吸收剩余空间。若日后把
    // .note-card 改成 block，该声明静默失效 ⇒ 页脚重新浮在中间。
    // #462：改瀑布流后卡片不再被拉伸（无剩余空间），这条声明暂时空转，
    // 但保留它 —— 若回退到 grid 等高布局，它立刻重新生效。
    const card = decls('.note-card');
    expect(card).toMatch(/display\s*:\s*flex/);
    expect(card).toMatch(/flex-direction\s*:\s*column/);
  });

  it('三态底部区都是 .note-card 的直接子元素（否则 margin-top:auto 无效）', () => {
    // 静态断言：确认这些类名直接出现在 .note-card 的 article 内，
    // 而不是被包在中间层 div 里。
    for (const cls of ['note-edit-foot', 'note-confirm-actions', 'note-foot']) {
      const re = new RegExp(
        `<article[^>]*className="note-card[^"]*"[^>]*>[\\s\\S]*?className="${cls}"`,
      );
      expect(re.test(panel), `${cls} 应为 .note-card 的直接子元素`).toBe(true);
    }
  });
});

describe('记事本面板撑满主区（#259）', () => {
  it('面板元素不得挂行内 flex / width —— 行内样式会盖掉样式表的撑满规则', () => {
    // 这是「四列被压成竖条 + 容器横向滚动条」的真正根因：组件曾写
    // style={{ flex: `0 0 25%`, width: `25%` }}，行内样式优先级高于
    // `.notes-page .notes-panel { flex: 1 1 auto; width: 100% }`，
    // 于是 .notes-panel 只有 245px（视口 1180），比创建列自己的 280px 还窄，
    // 右侧 .notes-card-cols 只剩 20px（overflow-x 计算成 auto ⇒ 横向滚动条）。
    expect(panel, 'NotesPanel 面板元素上又出现了行内宽度').not.toMatch(
      /className="notes-panel"[^>]*style=/,
    );
    // 宽度调节机制（#202 侧栏拖宽）已随整页化整体移除，不能借它把行内样式带回来
    expect(panel).not.toContain('notes-resizer');
    expect(panel).not.toContain('widthPct');
    expect(styles).not.toMatch(/\.notes-resizer/);
  });

  it('面板自身是撑满形态：flex: 1 1 auto + min-width/min-height: 0', () => {
    const d = decls('.notes-panel');
    expect(d).toMatch(/flex\s*:\s*1\s+1\s+auto/);
    expect(d).toMatch(/min-width\s*:\s*0/);
    expect(d).toMatch(/min-height\s*:\s*0/);
    // 侧栏形态（固定 320px / 粘性定位 / 50% 硬锁）必须消失，否则整页下会被压窄
    expect(d).not.toMatch(/flex\s*:\s*0\s+0\s+\d+px/);
    expect(d).not.toMatch(/position\s*:\s*sticky/);
    expect(d).not.toMatch(/max-width\s*:\s*50%/);
  });

  it('.notes-page 把面板拉满（width/height 100%）', () => {
    const d = decls('.notes-page .notes-panel');
    expect(d).toMatch(/width\s*:\s*100%/);
    expect(d).toMatch(/height\s*:\s*100%/);
  });
});

describe('整行页头移除，导入/导出保留在面板工具行（#447）', () => {
  it('页头（记事本 + 计数 + 工具行）已从组件与样式表中移除', () => {
    // 页头与侧边栏标题重复，白占一行纵向空间
    expect(panel).not.toContain('notes-head');
    // .notes-head-icon 仍被 AgentPanel 复用，故只禁止「.notes-head 规则本身」（后面跟空格或 {）
    expect(styles).not.toMatch(/\.notes-head[ {]/);
    // .notes-tools 是旧页头专用（卡片的 hover 操作区是 .note-tools），不得残留
    expect(panel).not.toContain('className="notes-tools"');
    expect(styles).not.toMatch(/\.notes-tools\s*\{/);
  });

  it('导入/导出按钮在面板工具行内（#447）', () => {
    const toolbarStart = panel.indexOf('className="notes-toolbar"');
    // #456：列表容器类名从 .notes-card-cols 改为 .notes-list
    const listStart = panel.indexOf('className="notes-list"');
    expect(toolbarStart, 'NotesPanel.tsx 中找不到 .notes-toolbar').toBeGreaterThan(-1);
    expect(listStart, 'NotesPanel.tsx 中找不到 .notes-list').toBeGreaterThan(-1);
    expect(toolbarStart, '工具行不在列表区之前').toBeLessThan(listStart);
    const toolbarBlock = panel.slice(toolbarStart, listStart);
    expect(toolbarBlock).toContain('handleExport');
    expect(toolbarBlock).toContain('handleImport');
    expect(toolbarBlock).toContain('fileInputRef');
  });

  it('看板的裸 .empty 规则仍限定在 .board 作用域（不得漏进记事本）', () => {
    // 历史缺陷（#259）：记事本曾复用看板的裸 .empty 类，其 padding: 8px 4px
    // 会命中容器、造成纵向偏移。改列表后虽然不再有列，但这条作用域约束要继续守住 ——
    // 将来若再引入空态元素，很容易顺手复用这个类名。
    expect(styles).not.toMatch(/(?:^|[},])\s*\.empty\s*\{/);
    expect(styles).toMatch(/\.board \.empty\s*\{/);
  });
});

describe('记事本编辑文本框自适应高度（#322）', () => {
  // vitest 无布局引擎，scrollHeight 恒为 0，无法用渲染断言覆盖；沿用「源码静态断言」。
  it('useAutoSize 用 useLayoutEffect 做高度测量（绘制前同步，修复进入编辑态不撑高）', () => {
    const m = panel.match(/function useAutoSize[\s\S]*?\n\}/);
    expect(m, 'NotesPanel.tsx 中找不到 useAutoSize 定义').toBeTruthy();
    // 进入编辑态时 textarea 与 editDraft 同帧挂载，被动 useEffect 的初始测量会被
    // overflow-y:auto 列容器的滚动/绘制时序干扰，框体停在 min-height(42px)。
    // 必须在 DOM 变更后、绘制前用 useLayoutEffect 同步量高。
    expect(m![0]).toContain('useLayoutEffect');
    // 不得再用被动 useEffect 测高——否则回归 #322（useLayoutEffect 不含子串 useEffect）。
    expect(m![0], 'useAutoSize 不得再用被动 useEffect 测高（防回归 #322）').not.toContain(
      'useEffect',
    );
  });

  it('进入编辑态主动测量：useAutoSize 接收 active 参数且依赖 editingId', () => {
    const m = panel.match(/function useAutoSize[\s\S]*?\n\}/);
    // active 标志让 hook 在进入编辑态那一帧（而非仅 value 变化时）重测，
    // 确保「挂载即预填长内容」也能被量到。
    expect(m![0]).toContain('active: boolean');
    expect(m![0]).toContain('active');
    // 编辑 textarea 把 editingId !== null 作为 active 传入，并把返回的 ref 挂上
    expect(panel).toContain('useAutoSize(editDraft, editingId !== null)');
    expect(panel).toContain('ref={editRef.ref}');
  });
});

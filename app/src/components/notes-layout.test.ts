import { describe, expect, it } from 'vitest';
// 用 Vite 的 `?raw` 读源码文本，而不是 `node:fs` —— 后者需要 `@types/node`，
// 而 CI（`npm ci` + `tsc --noEmit`）里并没有该类型包，会报 TS2307。
import stylesRaw from '../styles.css?raw';
import panelRaw from './NotesPanel.tsx?raw';

/**
 * 记事本「四列」布局回归测试（#259）。
 *
 * 演进（2026-09-16，两轮）：
 * 1. 初版按「四列等宽可收缩」实现，但真机四列被压成 ~18px 竖条 —— 根因是
 *    `NotesPanel` 在面板元素上挂了行内 `style={{flex:'0 0 25%', width:'25%'}}`（#202 遗留），
 *    行内样式优先级高于样式表，`.notes-page .notes-panel` 的「撑满」覆盖从未生效。
 * 2. 移除宽度机制 + 面板整页化后，用户把交互定为**看板列模式**：
 *    四列**固定宽度**（与最左侧创建列同宽，`--notes-col-w`）、放不下时出**有意**的
 *    横向滚动条、卡片不再用左侧色条区分优先级。
 *
 * 判定口径（最终）：面板必须撑满主区且不得再挂行内宽度；四列与创建列共用同一宽度变量；
 * 容器是受约束的横向滚动区（overflow-x: auto + overflow-y: hidden，不换行）；
 * 纵向滚动下沉到每列内部；卡片/页脚可收缩。
 *
 * vitest 跑在 node 环境（无 DOM、无布局引擎），无法用渲染断言覆盖，
 * 因此改为对源码做静态断言——与 `styles.test.ts`、`scripts/check-*.py` 同一思路。
 */

// 剥离注释：断言只针对声明本身，避免注释里提到写法（如「曾用 flex-wrap: wrap」）就被命中。
const styles = stylesRaw.replace(/\/\*[\s\S]*?\*\//g, '');
// TSX 同理：注释里提到 addColCollapsed 不应算作「四列依赖创建列状态」。
const panel = panelRaw.replace(/\/\*[\s\S]*?\*\//g, '');

/** 取出某选择器的全部声明块（同一选择器可能出现在分组合并规则中，故返回数组）。 */
function decls(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?:^|[},])\\s*${escaped}\\s*\\{([^}]*)\\}`, 'gm');
  const hits = [...styles.matchAll(re)].map((m) => m[1]);
  expect(hits.length, `styles.css 中找不到规则 ${selector}`).toBeGreaterThan(0);
  return hits.join('\n');
}

describe('记事本四列（看板列模式，#259）', () => {
  it('容器不换行：flex-wrap 不得为 wrap', () => {
    expect(decls('.notes-card-cols')).not.toMatch(/flex-wrap\s*:\s*wrap/);
  });

  it('容器是受约束的横向滚动区：列宽固定后，横向滚动是「有意」的', () => {
    const d = decls('.notes-card-cols');
    // overflow-x 显式声明（而不是靠 overflow-y 隐式带出），纵向交给每列自己
    expect(d).toMatch(/overflow-x\s*:\s*auto/);
    expect(d).toMatch(/overflow-y\s*:\s*hidden/);
    expect(d).toMatch(/min-width\s*:\s*0/);
  });

  it('四列有最小宽度（--notes-col-w）且宽窗口下撑满、不留死空间', () => {
    // flex: 1 1 0 + min-width ⇒ 宽窗口四列等分撑满（与面板同宽），
    // 窄窗口不低于 --notes-col-w（不会被压成竖条，超出部分横向滚动）
    const col = decls('.note-col');
    expect(col).toMatch(/flex\s*:\s*1\s+1\s+0/);
    expect(col).toMatch(/min-width\s*:\s*var\(--notes-col-w\)/);
    // 变量必须定义在 .notes-panel 上
    expect(decls('.notes-panel')).toMatch(/--notes-col-w\s*:\s*\d+px/);
  });

  it('列有「明显的包围框」：页面底 --bg 上放 --surface-2 列（同色则包围框不可见）', () => {
    // 曾因 .notes-panel 与 .note-col 同为 --surface-2，四列的框完全看不见
    expect(decls('.notes-panel')).toMatch(/background\s*:\s*var\(--bg\)/);
    const col = decls('.note-col');
    expect(col).toMatch(/background\s*:\s*var\(--surface-2\)/);
    expect(col).toMatch(/border-radius\s*:\s*10px/);
  });

  it('创建列与四列同款包围框（surface-2 圆角块，不再用 border-right 分隔）', () => {
    const add = decls('.notes-add-col');
    expect(add).toMatch(/background\s*:\s*var\(--surface-2\)/);
    expect(add).toMatch(/border-radius\s*:\s*10px/);
    expect(add).not.toMatch(/border-right/);
  });

  it('空列提示与看板 .empty 同款（灰色文字，不用虚线框）', () => {
    const d = decls('.note-col-empty');
    expect(d).toMatch(/color\s*:\s*var\(--text-3\)/);
    expect(d).not.toMatch(/border/);
  });

  it('记事卡片不再有左侧色条（优先级由列分组 + 卡片底部标签表达）', () => {
    expect(styles).not.toMatch(/\.note-card::before/);
    // 色条没了，左侧内边距也不再为色条留位（原来左 13px / 右 12px）
    expect(decls('.note-card')).toMatch(/padding\s*:\s*8px 12px 6px/);
  });

  it('窄列下卡片与页脚可收缩 ⇒ 列内不会长出横向滚动条', () => {
    // 若卡片保持 min-width: auto，其子元素（.note-foot 的标签 + 时间 + 操作按钮）
    // 的 min-content 会把卡片撑宽，进而让 .note-col-body（overflow-y: auto ⇒
    // overflow-x 计算成 auto）出现横向滚动条。
    expect(decls('.note-card')).toMatch(/min-width\s*:\s*0/);
    expect(decls('.note-foot')).toMatch(/flex-wrap\s*:\s*wrap/);
  });

  it('列内纵向滚动：.note-col-body 是受约束的滚动区', () => {
    const d = decls('.note-col-body');
    expect(d).toMatch(/overflow-y\s*:\s*auto/);
    // 没有 min-height: 0，flex 项的 auto 最小高度会阻止收缩，滚动条会落到可视区之外
    expect(d).toMatch(/min-height\s*:\s*0/);
  });

  it('创建列的 textarea 撑满列高（不得受 260px 上限约束）', () => {
    const d = decls('.note-textarea-full');
    expect(d).toMatch(/flex\s*:\s*1\s+1\s+auto/);
    expect(d).toMatch(/max-height\s*:\s*none/);
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

describe('整行页头移除，导入/导出挪进创建列（#259）', () => {
  it('页头（记事本 + 计数 + 工具行）已从组件与样式表中移除', () => {
    // 页头与侧边栏标题重复，白占一行纵向空间
    expect(panel).not.toContain('notes-head');
    // .notes-head-icon 仍被 AgentPanel 复用，故只禁止「.notes-head 规则本身」（后面跟空格或 {）
    expect(styles).not.toMatch(/\.notes-head[ {]/);
    // .notes-tools 是旧页头专用（卡片的 hover 操作区是 .note-tools），不得残留
    expect(panel).not.toContain('className="notes-tools"');
    expect(styles).not.toMatch(/\.notes-tools\s*\{/);
  });

  it('导入/导出与收起按钮在创建列的工具行内（列收起时随列隐藏）', () => {
    const addStart = panel.indexOf('className="notes-add-col"');
    const cardStart = panel.indexOf('className="notes-card-cols"');
    const toolsIdx = panel.indexOf('notes-add-col-tools');
    expect(addStart).toBeGreaterThan(-1);
    expect(cardStart).toBeGreaterThan(addStart);
    // 工具行必须落在创建列内部（add-col 开标签之后、四列区之前）——
    // 用「位置区间」断言而不是子串包含，避免挪到别处时误判为通过
    expect(toolsIdx, '工具行不在创建列内部').toBeGreaterThan(addStart);
    expect(toolsIdx).toBeLessThan(cardStart);
    const toolsBlock = panel.slice(toolsIdx, cardStart);
    expect(toolsBlock).toContain('handleExport');
    expect(toolsBlock).toContain('handleImport');
    expect(toolsBlock).toContain('fileInputRef');
    expect(toolsBlock).toContain('setAddColCollapsed(true)');
  });

  it('列头到内容间距统一：列头 margin-bottom 归零，间距由列体 padding-top 提供', () => {
    // 旧值 head margin-bottom 2px + body padding-top 0 ⇒ 有记录的列上边距只有 2px，
    // 与空列（提示自带 padding）观感不一致
    expect(decls('.note-col-head')).toMatch(/margin\s*:\s*10px 10px 0/);
    expect(decls('.note-col-body')).toMatch(/padding\s*:\s*8px 10px 10px/);
    // 空列提示不得再带自己的上边距/虚线框
    expect(decls('.note-col-empty')).toMatch(/padding\s*:\s*0 4px/);
  });
});

describe('创建列收起只影响创建列（#259）', () => {
  it('面板整体收起态已移除（记事本是主区整页，无 36px 导轨）', () => {
    expect(panel).not.toContain('notes-panel collapsed');
    expect(styles).not.toMatch(/\.notes-panel\.collapsed/);
  });

  it('四列区块内不得引用创建列收起状态 ⇒ 收起创建列不会动四列', () => {
    const idx = panel.indexOf('className="notes-card-cols"');
    expect(idx, 'NotesPanel.tsx 中找不到 .notes-card-cols').toBeGreaterThan(-1);
    const cardColsBlock = panel.slice(idx);
    expect(cardColsBlock).not.toContain('addColCollapsed');
    expect(cardColsBlock).not.toContain('notes-add-col');
  });

  it('创建列与四列区共用同一父容器（.notes-body）⇒ 二者互为兄弟而非嵌套', () => {
    expect((panel.match(/className="notes-card-cols"/g) ?? []).length).toBe(1);
    expect((panel.match(/className="notes-add-col"/g) ?? []).length).toBe(1);
    expect(panel).toContain('className="notes-add-rail"');
    expect(panel).toContain('className="notes-body"');
  });
});

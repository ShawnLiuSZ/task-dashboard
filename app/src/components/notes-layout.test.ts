import { describe, expect, it } from 'vitest';
// 用 Vite 的 `?raw` 读源码文本，而不是 `node:fs` —— 后者需要 `@types/node`，
// 而 CI（`npm ci` + `tsc --noEmit`）里并没有该类型包，会报 TS2307。
import stylesRaw from '../styles.css?raw';
import panelRaw from './NotesPanel.tsx?raw';

/**
 * 记事本「四列」布局回归测试（#259）。
 *
 * 背景：`.notes-card-cols` 曾是 `flex-wrap: wrap` + 固定 260px 的 `.note-col`，
 * 于是四列在真实窗口下从来不是并排的——实测 1180×760 窗口（`tauri.conf.json`
 * 的默认尺寸）下紧急/高在第一行、中/低被挤到第二行；1440 下变成 3+1；
 * 900 下直接竖着叠成 4 行。同时容器靠 `overflow-y: auto` 隐式获得
 * `overflow-x: auto`，一旦内容超宽就出现内部横向滚动条。
 *
 * 判定口径（与看板 `.column` 同构）：四列等宽可收缩（`flex: 1 1 0` + `min-width: 0`）
 * → 结构上不可能换行、也不可能横向溢出；纵向滚动下沉到每列内部。
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

describe('记事本四列并排（#259）', () => {
  it('容器不换行：flex-wrap 不得为 wrap', () => {
    expect(decls('.notes-card-cols')).not.toMatch(/flex-wrap\s*:\s*wrap/);
  });

  it('容器自身不得滚动（否则 overflow-y 会隐式带出 overflow-x，出现横向滚动条）', () => {
    const d = decls('.notes-card-cols');
    expect(d).not.toMatch(/overflow(-\w)?\s*:\s*(auto|scroll)/);
    expect(d).toMatch(/overflow\s*:\s*hidden/);
  });

  it('列必须可收缩且等宽：flex: 1 1 0 + min-width: 0，且不得退回固定宽度', () => {
    const d = decls('.note-col');
    expect(d).toMatch(/flex\s*:\s*1\s+1\s+0/);
    expect(d).toMatch(/min-width\s*:\s*0/);
    // 固定宽度（flex-basis 像素值 / max-width 像素值）会让列在窄窗口下换行或溢出
    expect(d).not.toMatch(/flex\s*:\s*0\s+0\s+\d+px/);
    expect(d).not.toMatch(/max-width\s*:\s*\d+px/);
  });

  it('列内纵向滚动：.note-col-body 是受约束的滚动区', () => {
    const d = decls('.note-col-body');
    expect(d).toMatch(/overflow-y\s*:\s*auto/);
    // 没有 min-height: 0，flex 项的 auto 最小高度会阻止收缩，滚动条会落到可视区之外
    expect(d).toMatch(/min-height\s*:\s*0/);
  });

  it('窄列下卡片与页脚可收缩 ⇒ 列内不会长出横向滚动条', () => {
    // 900px 窗口（minWidth）+ 创建列展开时每列仅 ~90px：若卡片保持 min-width: auto，
    // 其子元素（.note-foot 的标签 + 时间 + 操作按钮）的 min-content 会把卡片撑宽，
    // 进而让 .note-col-body（overflow-y: auto ⇒ overflow-x 计算成 auto）出现横向滚动条。
    expect(decls('.note-card')).toMatch(/min-width\s*:\s*0/);
    expect(decls('.note-foot')).toMatch(/flex-wrap\s*:\s*wrap/);
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

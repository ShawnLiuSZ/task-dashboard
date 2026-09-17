import { describe, expect, it } from 'vitest';
// 用 Vite 的 `?raw` 拿源码文本，而不是 `node:fs` —— 后者需要 `@types/node`，
// 而 CI（`npm ci` + `tsc --noEmit`）里并没有该类型包，会报 TS2307。
import stylesRaw from './styles.css?raw';
import panelRaw from './components/SyncLogsPanel.tsx?raw';

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

/** 取出某选择器的全部声明块（同一选择器可能出现在分组合并规则中，故返回数组）。 */
function decls(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?:^|[},])\\s*${escaped}\\s*\\{([^}]*)\\}`, 'gm');
  const hits = [...styles.matchAll(re)].map((m) => m[1]);
  expect(hits.length, `styles.css 中找不到规则 ${selector}`).toBeGreaterThan(0);
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

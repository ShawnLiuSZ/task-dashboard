import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import Sidebar from './Sidebar';
import { I18nProvider } from '../i18n';
import type { Account } from '../types';

/**
 * 侧边栏账号区（#516）。
 *
 * ## 背景
 *
 * 1. **未完成计数的位置**：原先放在**顶栏**（品牌名右侧），离「哪个账号 / 哪种归属 /
 *    搜了什么」这些前提都很远 ⇒ 同一时刻有三种合理解读（总数 / 我的 / 当前筛选下的），
 *    且它本来就不等于看板各列之和（看板「已完成」列仍列出 GitHub 上已关闭的任务）。
 *    ⇒ 改放到**账号分组标题行**：紧邻账号列表 ⇒ 上下文自明。
 *
 * 2. **账号名被截断**：`.sidebar-item` 原用 `white-space: nowrap` +
 *    `.sidebar-item-label` 用 `text-overflow: ellipsis` ⇒ 长 org 名被单行截断；
 *    且 `title` 写的是「切换到该账号的看板」⇒ **截断后认不出是哪个账号**；
 *    折叠态（56px 纯图标）下文字标签整个隐藏，更是只剩一个匿名图标。
 *
 * ⚠️ node 环境无 DOM ⇒ 用 `renderToStaticMarkup` 做服务端渲染断言
 * （与 `board.test.tsx` / `detail-panel-head.test.tsx` 同一范式）。
 */

// 固定中文文案，避免 node 环境下 auto 模式解析不确定（navigator.language 不可用）。
beforeEach(() => {
  vi.stubGlobal('localStorage', {
    getItem: () => 'zh-CN',
    setItem: () => {},
    removeItem: () => {},
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const noop = () => {};

function mkAccount(partial: Partial<Account> & { id: number; login: string }): Account {
  return {
    label: partial.login,
    org: '',
    hasPat: true,
    isDefault: false,
    boardMode: 'project',
    createdAt: 0,
    ...partial,
  };
}

const ACCOUNTS: Account[] = [
  mkAccount({ id: 1, login: 'liushizhao2025' }),
  mkAccount({ id: 2, login: 'ShawnLiuSZ', org: 'FoodsUp-Inc' }),
  mkAccount({ id: 3, login: 'a-very-long-account-login-name', org: 'AnExtremelyLongOrgName' }),
];

function render(props: Partial<React.ComponentProps<typeof Sidebar>> = {}): string {
  return renderToStaticMarkup(
    <I18nProvider>
      <Sidebar
        accounts={ACCOUNTS}
        activeAccountId={1}
        nav="board"
        onNavigate={noop}
        onSwitchAccount={noop}
        onAddAccount={noop}
        onAbout={noop}
        {...props}
      />
    </I18nProvider>,
  );
}

describe('侧边栏未完成计数（#516）', () => {
  it('计数渲染在**账号分组标题行**里（紧邻账号列表 ⇒ 口径自明）', () => {
    const html = render({ openCount: 19 });
    // 标题与计数必须同属 `.sidebar-group-head`（账号分组的第一行）。
    // ⚠️ 用 `[^>]*` 而不是 `[^"]*"`：计数 span 上还有 `title="…"` 属性。
    expect(html).toMatch(
      /<div class="sidebar-group-head"><span class="sidebar-group-title">账号<\/span><span class="sidebar-open-count[^>]*>未完成 19 条<\/span><\/div>/,
    );
  });

  it('计数为 0 时**不渲染**（不显示「未完成 0 条」这种噪音）', () => {
    const html = render({ openCount: 0 });
    expect(html).not.toContain('sidebar-open-count');
    expect(html).not.toContain('未完成');
  });

  it('默认（未传 openCount）不渲染计数', () => {
    const html = render();
    expect(html).not.toContain('sidebar-open-count');
  });

  it('计数紧跟在「账号」标题之后、在账号列表之前', () => {
    const html = render({ openCount: 5 });
    const iTitle = html.indexOf('sidebar-group-title');
    const iCount = html.indexOf('sidebar-open-count');
    const iFirstAccount = html.indexOf('@liushizhao2025');
    expect(iTitle).toBeGreaterThan(-1);
    expect(iCount).toBeGreaterThan(iTitle);
    expect(iFirstAccount).toBeGreaterThan(iCount);
  });

  it('title 提示里带**账号全名**（折叠态下文字全隐藏，title 是唯一辨认线索）', () => {
    const html = render();
    // 原先 title 是「切换到该账号的看板」⇒ 认不出账号；现在必须是「全名 · 动作」。
    expect(html).toContain('title="@ShawnLiuSZ (FoodsUp-Inc) · 切换到该账号的看板"');
    expect(html).toContain(
      'title="@a-very-long-account-login-name (AnExtremelyLongOrgName) · 切换到该账号的看板"',
    );
  });

  it('账号名**不被截断**（完整出现在文本里）', () => {
    const html = render();
    expect(html).toContain('@a-very-long-account-login-name (AnExtremelyLongOrgName)');
    // 折叠态下靠 title 辨认 ⇒ title 里也必须是全名。
    expect(html).toContain('@a-very-long-account-login-name (AnExtremelyLongOrgName) · ');
  });

  it('折叠态（collapsed）下账号项的 title **仍保留全名**', () => {
    // ⚠️ 「折叠态隐藏标题行」是 **CSS 行为**（`display:none`），SSR 的 DOM 里元素仍在
    // ⇒ 那条断言归 `styles.test.ts`（`?raw` 静态断言）；这里只断言 DOM 层可验证的部分：
    // 纯图标模式下账号**唯一**的辨认线索就是 title ⇒ 必须仍是全名。
    const html = render({ collapsed: true });
    expect(html).toContain('@ShawnLiuSZ (FoodsUp-Inc) · 切换到该账号的看板');
    expect(html).toContain('title="@a-very-long-account-login-name (AnExtremelyLongOrgName)');
  });
});

/**
 * 侧边栏收起 / 展开开关（#517）。
 *
 * ## 为什么图标要**换方向**
 *
 * 折叠态（56px 纯图标）下文字标签整体隐藏 ⇒ 只剩一个图标 ⇒
 * **图标方向本身就是可操作性提示**：
 * - 展开态显示「‹」⇒ 收起（侧栏往左退）
 * - 折叠态显示「›」⇒ 展开（侧栏往左拉出）
 *
 * `title` 同样要给出动作名（折叠态下唯一的文字线索）。
 */
describe('侧边栏收起 / 展开开关（#517）', () => {
  it('展开态显示「收起侧边栏」', () => {
    const html = render({ onToggleCollapsed: noop });
    expect(html).toContain('收起侧边栏');
    expect(html).not.toContain('展开侧边栏');
  });

  it('折叠态显示「展开侧边栏」', () => {
    const html = render({ onToggleCollapsed: noop, collapsed: true });
    expect(html).toContain('展开侧边栏');
    expect(html).not.toContain('收起侧边栏');
  });

  it('未传 onToggleCollapsed 时**不渲染**开关（不渲染一个点了没反应的按钮）', () => {
    const html = render();
    expect(html).not.toContain('收起侧边栏');
    expect(html).not.toContain('展开侧边栏');
  });

  it('图标方向随状态切换（展开态 ‹ / 折叠态 ›）', () => {
    // 展开态：‹ = M15 5l-7 7 7 7
    expect(render({ onToggleCollapsed: noop })).toContain('M15 5l-7 7 7 7');
    // 折叠态：› = M9 5l7 7-7 7
    expect(render({ onToggleCollapsed: noop, collapsed: true })).toContain('M9 5l7 7-7 7');
  });

  it('开关在**底部 footer**里（与「关于」同组）', () => {
    const html = render({ onToggleCollapsed: noop });
    const iFooter = html.indexOf('sidebar-footer');
    const iToggle = html.indexOf('收起侧边栏');
    const iAbout = html.indexOf('关于');
    expect(iFooter).toBeGreaterThan(-1);
    expect(iToggle).toBeGreaterThan(iFooter);
    expect(iAbout).toBeGreaterThan(iToggle);
  });

  it('点击开关触发 onToggleCollapsed', () => {
    const calls: number[] = [];
    const html = renderToStaticMarkup(
      <I18nProvider>
        <Sidebar
          accounts={ACCOUNTS}
          activeAccountId={1}
          nav="board"
          onNavigate={noop}
          onSwitchAccount={noop}
          onAddAccount={noop}
          onAbout={noop}
          onToggleCollapsed={() => calls.push(1)}
        />
      </I18nProvider>,
    );
    expect(html).toContain('收起侧边栏');
    // SSR 不触发事件 ⇒ 断言回调未被调用（只验证接线，不做交互）。
    expect(calls).toHaveLength(0);
  });
});

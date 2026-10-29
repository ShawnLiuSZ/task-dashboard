import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import TaskCommentsList from './TaskCommentsList';
import { I18nProvider } from '../i18n';
import type { TaskComment } from '../types';
// 源码文本（`?raw`）—— 只读字符串，**不执行模块** ⇒ node 环境无 DOM 也能用。
import detailPanelRaw from './DetailPanel.tsx?raw';

/**
 * 「评论链接列表」的渲染回归（#472）。
 *
 * 覆盖点：
 * ① **倒序**：最新的评论排在最前（本功能的核心语义）；
 * ② **全部列出**：多条评论一条都不丢（改造前只有最新一条能留下）；
 * ③ 作者与时间戳呈现；
 * ④ 空列表 ⇒ 整节不渲染（不显示空标题）；
 * ⑤ 加载态 ⇒ 显示占位文案。
 *
 * ⚠️ node 环境无 DOM ⇒ 用 `renderToStaticMarkup` 做服务端渲染断言，
 *    与 `note-viewer-modal.test.tsx` 同一思路。
 *
 * ⚠️ 列表是**按需拉取**的（`useEffect`），node 环境下不会执行 ⇒ 拉取逻辑
 *    不在本文件覆盖；本文件只覆盖「给定数据 ⇒ 渲染成什么样」。
 */

// 固定中文文案，避免 node 环境下 auto 模式解析不确定。
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

/** 后端已按倒序返回：最新在前。 */
const COMMENTS: TaskComment[] = [
  {
    id: 3,
    url: 'https://github.com/o/r/issues/1#issuecomment-3',
    author: 'carol',
    createdAt: 1760000300,
  },
  {
    id: 2,
    url: 'https://github.com/o/r/issues/1#issuecomment-2',
    author: 'bob',
    createdAt: 1760000200,
  },
  {
    id: 1,
    url: 'https://github.com/o/r/issues/1#issuecomment-1',
    author: 'alice',
    createdAt: 1760000100,
  },
];

function render(comments: TaskComment[] = COMMENTS, loading = false) {
  return renderToStaticMarkup(
    <I18nProvider>
      <TaskCommentsList comments={comments} loading={loading} />
    </I18nProvider>,
  );
}

describe('TaskCommentsList（#472）', () => {
  it('倒序呈现：最新的评论在最前', () => {
    const html = render();
    const iCarol = html.indexOf('@carol');
    const iBob = html.indexOf('@bob');
    const iAlice = html.indexOf('@alice');
    expect(iCarol).toBeGreaterThan(-1);
    expect(iBob).toBeGreaterThan(-1);
    expect(iAlice).toBeGreaterThan(-1);
    // ⚠️ 核心断言：顺序必须是 carol → bob → alice（最新在前）。
    expect(iCarol, '最新的一条必须排在最前').toBeLessThan(iBob);
    expect(iBob, '次新的必须排在最旧的前面').toBeLessThan(iAlice);
  });

  it('全部评论一条都不丢（3 条 = 3 个列表项）', () => {
    const html = render();
    const items = html.match(/class="link-line"/g) ?? [];
    expect(items.length, '三条评论必须渲染出三个列表项').toBe(3);
  });

  it('每条都带「在浏览器打开」入口', () => {
    const html = render();
    const buttons = html.match(/btn ghost small inline/g) ?? [];
    expect(buttons.length, '每条评论都要有一个跳转按钮').toBe(3);
    expect(html).toContain('在浏览器打开');
  });

  it('标题带评论条数', () => {
    const html = render();
    expect(html).toContain('评论链接（3）');
  });

  it('空列表且不在加载 ⇒ 整节不渲染（不显示空标题）', () => {
    const html = render([], false);
    expect(html, '没有评论时不应渲染任何内容').toBe('');
    expect(html).not.toContain('评论链接');
  });

  it('加载中 ⇒ 显示占位文案', () => {
    const html = render([], true);
    expect(html).toContain('正在加载评论链接');
  });

  it('作者未知时不显示空的 @ 符号', () => {
    const html = render([{ id: 1, url: 'u1', author: '', createdAt: 1760000100 }]);
    expect(html).not.toContain('@');
  });

  it('时间未知时显示占位符而不是 1970 年', () => {
    const html = render([{ id: 1, url: 'u1', author: 'alice', createdAt: 0 }]);
    expect(html).not.toContain('1970');
  });
});

/**
 * DetailPanel 的**评论拉取接线**（#472 审查修复后的回归防线）。
 *
 * ⚠️ 为什么用源码静态断言：拉取逻辑在 `useEffect` 里，而本仓前端测试跑在
 * node 环境（**无 DOM / 无 jsdom**）⇒ `useEffect` 不会执行 ⇒ 渲染断言
 * 覆盖不到「依赖数组对不对」。静态断言是本仓既有的做法
 * （见 `notes-layout.test.ts` 对 `utils/useAutoSize.ts` 的同类断言）。
 */
describe('DetailPanel 的评论拉取接线（#472）', () => {
  /** 取出评论拉取 effect 的依赖数组内容。 */
  function depsOfCommentEffect(): string {
    const at = detailPanelRaw.indexOf('listTaskComments');
    expect(at, 'DetailPanel 应调用 listTaskComments').toBeGreaterThan(-1);
    const m = detailPanelRaw.slice(at).match(/\}, \[([^\]]*)\]\);/);
    expect(m, '应能定位到评论拉取 effect 的依赖数组').not.toBeNull();
    return m![1];
  }

  it('依赖必须含 latestCommentUrl（否则同步后评论列表不刷新）', () => {
    // 缺陷形态：依赖只有 [issueKey, accountId] ⇒ 同步后 App 重查任务列表，
    // 但这两个值不变 ⇒ effect 不重跑 ⇒ 评论列表停在打开那一刻
    // （面板其它字段会刷新 ⇒ 只有评论这块陈旧）。
    const deps = depsOfCommentEffect();
    expect(deps).toContain('latestCommentUrl');
  });

  it('依赖必须含 issueKey 与 accountId（换任务 / 换账号要重取）', () => {
    const deps = depsOfCommentEffect();
    expect(deps).toContain('issueKey');
    // ⚠️ 必须带账号：issueKey 是 `repo#number`（不含 owner），多账号下会重复
    // ⇒ 只按 issueKey 取会拿到别的账号的评论。
    expect(deps).toContain('accountId');
  });

  it('拉取必须带 accountId（多账号不串号）', () => {
    expect(detailPanelRaw).toContain('listTaskComments(task.issueKey, task.accountId)');
  });
});

/**
 * DetailPanel 的**实时拉取接线**（#490）。
 *
 * 与前一块同理：拉取逻辑在 `useEffect` 内，node 环境不执行 ⇒ 用源码静态断言锁定
 * 「打开即拉、零落库、覆盖评论区、PR 提交历史按需渲染」这几条关键接线，防止回归。
 */
describe('DetailPanel 的实时拉取接线（#490）', () => {
  it('打开详情即调用 fetchTaskDetailLive（实时、零落库）', () => {
    expect(detailPanelRaw).toContain('fetchTaskDetailLive');
  });

  it('实时拉取必须带 issueKey 与 accountId（多账号不串号）', () => {
    expect(detailPanelRaw).toContain('fetchTaskDetailLive(task.issueKey, task.accountId');
  });

  it('实时评论覆盖本地库评论（shownComments 优先用 live.comments）', () => {
    expect(detailPanelRaw).toContain('live ? live.comments : comments');
  });

  it('关联 PR 提交历史仅在确实有时渲染', () => {
    expect(detailPanelRaw).toContain('live.prCommits.length > 0');
  });

  it('实时拉取失败只做轻量提示，不阻断详情面板', () => {
    expect(detailPanelRaw).toContain('detail.liveError');
  });
});

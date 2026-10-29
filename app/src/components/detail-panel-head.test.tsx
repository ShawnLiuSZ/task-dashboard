import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import DetailPanel from './DetailPanel';
// 源码文本（`?raw`）—— 只读字符串，**不执行模块** ⇒ node 环境无 DOM 也能用。
import detailPanelRaw from './DetailPanel.tsx?raw';
import { I18nProvider } from '../i18n';
import type { Task } from '../types';

/**
 * 任务详情**头部结构**回归（#500）。
 *
 * 用户的原话：「向下滚动时，issue id 行和 modal 顶部有一段透明边距，
 * 建议 issue id 行和标题行，都不参与滚动」。
 *
 * 「两行都不参与滚动」这件事**只靠 CSS 做不到** —— 标题原本是头部的**兄弟节点**
 * （`.detail-head` 之后），它必然随内容滚走，滚动到一半还会被 sticky 头部盖住上半截
 * （#498 的现象之一）。只有把标题**移进头部容器**，两行才会一起被钉住。
 *
 * ⚠️ node 环境无 DOM ⇒ 用 `renderToStaticMarkup` 做**服务端渲染**断言：
 *    断言落在**真实渲染产物**上（而不是源码文本），标题一旦挪回头部之外即失败。
 */
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

const TASK: Task = {
  issueKey: 'fad-backend#1630',
  owner: 'FoodsUp-Inc',
  repo: 'fad-backend',
  number: 1630,
  title: '[Epic] 牛奶罐按司机结算：欠抵扣款 / 多还奖励、司机端可查',
  url: 'https://github.com/FoodsUp-Inc/fad-backend/issues/1630',
  issueState: 'open',
  ownership: 'notassignee',
  status: 'todo',
  projectStatus: 'unclassified',
  assignees: '',
  author: 'someone',
  mentioned: false,
  latestCommentUrl: '',
  prNumber: 0,
  prUrl: '',
  prState: '',
  prs: [],
  branch: '',
  workBranch: '',
  workDir: '',
  parentIssue: null,
  subIssues: [],
  sessionId: null,
  sessionAgent: null,
  sessionAt: null,
  candidateDone: false,
  handoff: '',
  updatedAt: 1760000000,
  createdAt: 1760000000,
  accountId: 1,
};

function render(): string {
  return renderToStaticMarkup(
    <I18nProvider>
      <DetailPanel task={TASK} onClose={() => {}} onChanged={() => {}} />
    </I18nProvider>,
  );
}

/**
 * 头部整块的结构（真实渲染产物）：
 * `<div class="detail-head"><div class="detail-head-row">…</div><h2 class="detail-title">…</h2></div>`
 *
 * ⚠️ 这条正则同时锁住三件事：
 * ① 标题在 `.detail-head` **内部**（不是兄弟节点）；
 * ② 标题紧跟在 `.detail-head-row` **之后**（issue id 行在上、标题行在下）；
 * ③ 头部容器在标题**之后**闭合（标题没有被挪到头部外面）。
 */
const HEAD_BLOCK_RE =
  /<div class="detail-head"><div class="detail-head-row"><div><span class="repo">[^<]*<\/span><span class="num">[^<]*<\/span><\/div><button[^>]*>[^<]*<\/button><\/div><h2 class="detail-title">[^<]*<\/h2><\/div>/;

describe('任务详情头部结构（#500）', () => {
  it('「issue id 行」与「标题行」必须同属一个 sticky 头部容器', () => {
    expect(render(), '标题必须渲染在 .detail-head 内部').toMatch(HEAD_BLOCK_RE);
  });

  it('「关闭」按钮与 issue id 行同处第一行（.detail-head-row）', () => {
    expect(render()).toMatch(
      /<div class="detail-head-row"><div><span class="repo">fad-backend<\/span><span class="num">#1630<\/span><\/div><button class="btn ghost"/,
    );
  });

  it('标题行渲染的是 issue 标题本身', () => {
    expect(render()).toContain(
      '<h2 class="detail-title">[Epic] 牛奶罐按司机结算：欠抵扣款 / 多还奖励、司机端可查</h2>',
    );
  });
});

/**
 * 详情面板**区块顺序**（#504）。
 *
 * 用户的诉求：「将 body 信息，评论等信息放在『交接任务』下边」。
 *
 * ⇒ 三块**实时拉取**的内容（#490 / #498 的产出）必须聚在「交接任务」之后，
 *    形成一段连续的「远端实况」；原先它们分散在面板上下（描述在最上、评论在中、
 *    PR 提交历史在最末），读的时候要来回跳。
 *
 * ⚠️ 这三块都是**条件渲染**（正文非空 / 有评论 / 有 PR 才渲染），
 *    node 环境的 SSR 不会执行 `useEffect` ⇒ `live` 恒为 null ⇒ **渲染断言够不着**
 *    ⇒ 只能用源码顺序断言（与仓库既有范式一致）。
 *    锚点一律用**精确 JSX 片段**，避免命中注释里的同名字符串。
 */
describe('详情面板区块顺序（#504）', () => {
  /** 源码里某段 JSX 片段的首次出现位置。 */
  function at(fragment: string): number {
    const i = detailPanelRaw.indexOf(fragment);
    expect(i, `源码里应能找到 ${fragment}`).toBeGreaterThan(-1);
    return i;
  }

  it('「交接任务」在「描述」之前', () => {
    expect(at("{t('detail.handoffTitle')}")).toBeLessThan(at("{t('detail.bodyTitle')}"));
  });

  it('「描述」在评论区块之前', () => {
    expect(at("{t('detail.bodyTitle')}")).toBeLessThan(
      at('<TaskCommentsList comments={shownComments}'),
    );
  });

  it('评论区块在「PR 提交历史」之前', () => {
    expect(at('<TaskCommentsList comments={shownComments}')).toBeLessThan(
      at("{t('detail.prCommitsTitle'"),
    );
  });

  it('三块实时内容都排在 GitHub 区块之前（聚成一段「远端实况」）', () => {
    const iGitHub = at('<div className="block-title">GitHub</div>');
    expect(at("{t('detail.bodyTitle')}")).toBeLessThan(iGitHub);
    expect(at('<TaskCommentsList comments={shownComments}')).toBeLessThan(iGitHub);
    expect(at("{t('detail.prCommitsTitle'")).toBeLessThan(iGitHub);
  });

  it('三块实时内容都不在「执行状态 / 会话」之前（它们是本地操作区，应在前）', () => {
    const iStatus = at("{t('detail.statusTitle')}");
    const iSession = at("{t('detail.sessionTitle')}");
    expect(iStatus).toBeLessThan(at("{t('detail.bodyTitle')}"));
    expect(iSession).toBeLessThan(at("{t('detail.bodyTitle')}"));
  });

  it('描述区块仍然只在正文非空时渲染（顺序调整不得改变条件）', () => {
    expect(detailPanelRaw).toContain('liveBody.trim() &&');
  });
});

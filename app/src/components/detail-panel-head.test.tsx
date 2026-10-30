import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import DetailPanel from './DetailPanel';
// 源码文本（`?raw`）—— 只读字符串，**不执行模块** ⇒ node 环境无 DOM 也能用。
import detailPanelRaw from './DetailPanel.tsx?raw';
// i18n 词条原文（`?raw`）—— 用于校验「事件白名单 ↔ 词条」一一对应。
import zhRaw from '../i18n/locales/zh-CN.json?raw';
import enRaw from '../i18n/locales/en-US.json?raw';
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

/**
 * Activity 时间线（#506）的**事件白名单 ↔ i18n 词条一致性**。
 *
 * ⚠️ 为什么必须锁：`t()` 对**缺失 key 会返回 key 本身**（还会打 warning）
 * ⇒ 若组件里直接拼 `detail.ev.${item.event}`，一个未知事件就会把
 * `detail.ev.whatever` 这种字符串**显示在界面上**。
 *
 * ⇒ 组件里用**白名单** `TIMELINE_EVENT_KEYS` 决定是否走专用词条，
 *   清单外的统一走 `detail.ev.generic`。
 *   这条用例锁死「白名单与 zh-CN 词条**一一对应**」——
 *   少一个 ⇒ 界面上出现 `detail.ev.xxx`；多一个 ⇒ 死词条。
 */
describe('Activity 时间线事件白名单（#506）', () => {
  /** 从源码里取出白名单里的事件名。 */
  function whitelist(): string[] {
    const m = detailPanelRaw.match(/const TIMELINE_EVENT_KEYS = new Set\(\[([\s\S]*?)\]\)/);
    expect(m, '源码里应能找到 TIMELINE_EVENT_KEYS 白名单').not.toBeNull();
    return (m![1].match(/'([^']+)'/g) ?? []).map((s) => s.replace(/'/g, ''));
  }

  /** zh-CN 里所有 `detail.ev.*` 词条（去掉前缀）。 */
  function evWords(): string[] {
    const dict = JSON.parse(zhRaw) as Record<string, string>;
    return Object.keys(dict)
      .filter((k) => k.startsWith('detail.ev.'))
      .map((k) => k.slice('detail.ev.'.length));
  }

  it('白名单里的每个事件都有 zh-CN 词条', () => {
    const words = new Set(evWords());
    for (const e of whitelist()) {
      expect(words.has(e), `白名单里的「${e}」缺少 detail.ev.${e} 词条`).toBe(true);
    }
  });

  it('zh-CN 的每个 detail.ev.* 词条都在白名单里（无死词条）', () => {
    const set = new Set(whitelist());
    for (const w of evWords()) {
      if (w === 'generic') continue; // 通用兜底，不对应具体事件
      expect(set.has(w), `词条 detail.ev.${w} 没有对应的白名单事件`).toBe(true);
    }
  });

  it('通用兜底词条存在（未知事件走它）', () => {
    const dict = JSON.parse(zhRaw) as Record<string, string>;
    expect(dict['detail.ev.generic']).toBeTruthy();
    expect(dict['detail.timelineTitle']).toBeTruthy();
  });

  it('en-US 与 zh-CN 的事件词条**完全一致**（i18n:check 之外的第二道防线）', () => {
    const en = JSON.parse(enRaw) as Record<string, string>;
    const zh = JSON.parse(zhRaw) as Record<string, string>;
    const enKeys = Object.keys(en)
      .filter((k) => k.startsWith('detail.ev.'))
      .sort();
    const zhKeys = Object.keys(zh)
      .filter((k) => k.startsWith('detail.ev.'))
      .sort();
    expect(enKeys).toEqual(zhKeys);
  });

  it('组件渲染事件短语时**必须**先过白名单（否则未知事件会把 key 显示在界面上）', () => {
    // ⚠️ 结构断言：白名单判断必须出现在 `t(detail.ev.<event>)` 调用**之前**
    //    （白名单分支内本来就有这个调用，所以不能断言「不出现」）。
    expect(detailPanelRaw).toMatch(
      /TIMELINE_EVENT_KEYS\.has\(item\.event\)[\s\S]{0,300}?t\(`detail\.ev\.\$\{item\.event\}`/,
    );
    // 未知事件必须走通用兜底（否则界面出现 `detail.ev.whatever`）。
    expect(detailPanelRaw).toContain("t('detail.ev.generic'");
  });

  it('需要目标数据却取不到时退回 generic（#506 复查，不泄漏悬空占位）', () => {
    // ⚠️ 旧写法用 `text.includes('{')` 判守卫 —— 但 `t()` 会把 `{what}` 替换成空串，
    // 占位符根本不会留在结果里 ⇒ 守卫**永不触发** ⇒ 「在 中被引用」「请求 <发起人> 审查」
    // 这类残缺文案泄漏到界面。守卫必须基于「目标是否为空」判断。
    expect(detailPanelRaw).toMatch(
      /EVENTS_NEEDING_TARGET\.has\(item\.event\) && !target[\s\S]{0,200}?t\('detail\.ev\.generic'/,
    );
    // 旧写法不得再出现。
    expect(detailPanelRaw).not.toContain("text.includes('{')");
    // EVENTS_NEEDING_TARGET 必须覆盖这些「取不到目标」的事件。
    expect(detailPanelRaw).toContain("'milestoned'");
    expect(detailPanelRaw).toContain("'review_requested'");
  });

  it('时间线区块确实渲染在详情面板里（源码锚点）', () => {
    expect(detailPanelRaw).toContain("t('detail.timelineTitle')");
    expect(detailPanelRaw).toContain('className="timeline-list"');
    // 评论正文走 markdown 渲染（零依赖 + 安全白名单）；整体 memo 后源码里是 `it.body`。
    expect(detailPanelRaw).toContain('renderMarkdown(it.body)');
  });
});

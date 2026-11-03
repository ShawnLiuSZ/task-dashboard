import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import DetailPanel from './DetailPanel';
import TaskDetailWindow from './TaskDetailWindow';
// 源码文本（`?raw`）—— 只读字符串，**不执行模块** ⇒ node 环境无 DOM 也能用。
import detailPanelRaw from './DetailPanel.tsx?raw';
import appRaw from '../App.tsx?raw';
import taskDetailWindowRaw from './TaskDetailWindow.tsx?raw';
import taskCardRaw from './TaskCard.tsx?raw';
import boardRaw from './Board.tsx?raw';
import TaskCard from './TaskCard';
import { I18nProvider } from '../i18n';
import type { ProjectStatus, Task } from '../types';

/**
 * 任务详情**独立窗口**（#526）。
 *
 * ## 需求
 *
 * 「查看 task 任务时，现在是以 modal 框展示，希望实现：可以在新窗口打开详情，
 * 这个详情中显示目前 modal 框中的所有信息，然后 modal 框中将实时获取任务详情的
 * 功能去掉。」
 *
 * ⇒ 拆成两种形态：
 * - **modal**（主窗口）：`live={false}` ⇒ **不发任何 GitHub 请求**；
 * - **独立窗**：`live`（默认 true）⇒ **完整信息**（正文 / 时间线 / PR 提交 / 实时评论）。
 *
 * ## 为什么有些断言只能落在源码上
 *
 * node 环境无 DOM ⇒ `renderToStaticMarkup` **不执行 effect** ⇒ 「`live=false` 时
 * 不发 `fetch_task_detail_live`」这条**运行时**行为无法用渲染断言验证
 * （SSR 下 `live` 本来就是 null）⇒ 该条走 `?raw` 源码断言（仓库既有范式：
 * `panel-wiring.test.ts` / `detail-panel-head.test.tsx` 都是这么锁接线的）。
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
  title: '[Epic] 牛奶罐按司机结算',
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

function renderPanel(
  props: Partial<React.ComponentProps<typeof DetailPanel>> = {},
  taskPatch: Partial<Task> = {},
): string {
  return renderToStaticMarkup(
    <I18nProvider>
      <DetailPanel
        task={{ ...TASK, ...taskPatch }}
        onClose={() => {}}
        onChanged={() => {}}
        {...props}
      />
    </I18nProvider>,
  );
}

describe('详情独立窗的两种形态（#526）', () => {
  it('modal 形态：根 class 是 `detail`（居中弹窗）', () => {
    expect(renderPanel()).toContain('<aside class="detail"');
  });

  it('window 形态：根 class 是 `detail detail-window`（占满窗口）', () => {
    const html = renderPanel({ variant: 'window' });
    expect(html).toContain('<aside class="detail detail-window"');
    // 独立窗不是「模态」⇒ 不该再声明 aria-modal。
    expect(html).not.toContain('aria-modal="true"');
  });

  it('「在新窗口打开」按钮**只在 modal 形态**出现', () => {
    const modal = renderPanel({ onOpenInNewWindow: () => {} });
    expect(modal).toContain('aria-label="在新窗口打开"');
    // 独立窗里再开同款窗没有意义 ⇒ 不渲染该按钮。
    const win = renderPanel({ onOpenInNewWindow: () => {}, variant: 'window' });
    expect(win).not.toContain('aria-label="在新窗口打开"');
  });

  it('没传 `onOpenInNewWindow` 时**不渲染**该按钮（不做死按钮）', () => {
    expect(renderPanel()).not.toContain('aria-label="在新窗口打开"');
  });
});

describe('modal 不再实时获取任务详情（#526）', () => {
  it('实时拉取的 effect 在 `liveEnabled === false` 时**直接早退**（不发请求）', () => {
    // ⚠️ 源码断言（SSR 不跑 effect ⇒ 运行时行为无法用渲染断言验证）。
    expect(detailPanelRaw).toMatch(/if \(!liveEnabled\) \{[\s\S]*?return;/);
    // 早退分支必须把加载态/错误态复位（否则切回 live 时会残留上一次的 loading）。
    expect(detailPanelRaw).toMatch(/if \(!liveEnabled\) \{[\s\S]*?setLive\(null\);/);
  });

  it('effect 的依赖里含 `liveEnabled`（否则从「不拉」切到「要拉」时不会重跑）', () => {
    expect(detailPanelRaw).toMatch(
      /}, \[task\.issueKey, task\.accountId, livePrNumber, liveEnabled\]\);/,
    );
  });

  it('主窗口的 modal 传 `live={false}`', () => {
    expect(appRaw).toMatch(/<DetailPanel[\s\S]*?live=\{false\}/);
  });

  it('主窗口的 modal 传了「在新窗口打开」回调', () => {
    expect(appRaw).toMatch(/onOpenInNewWindow=\{\(\) => \{/);
    // ⚠️ Prettier 会把 `api.openTaskDetailWindow(...)` 折行 ⇒ 用正则而非连续子串。
    expect(appRaw).toMatch(/\.openTaskDetailWindow\(/);
    // 必须带上 issueKey + accountId（多账号下 issue_key 会重复 ⇒ 只传 key 会开错任务的窗）。
    expect(appRaw).toMatch(
      /\.openTaskDetailWindow\(selectedTask\.issueKey, selectedTask\.accountId\)/,
    );
  });
});

describe('GitHub 状态行不再挤成竖排（#529）', () => {
  it('同名状态**去重**（精确匹配，区分大小写）', () => {
    // ⚠️ 多个 GitHub Project 各有一套 Todo / In Progress / Done ⇒ 聚合起来重复三遍。
    // 去重**安全**：写回目标是按**任务所属的 Project** 解析的（后端
    // `resolve_project_write_target`）⇒ 状态名只作为名字传过去 ⇒ 同名项功能等价。
    const statuses = [
      { name: 'Todo', orderIndex: 0 },
      { name: 'In Progress', orderIndex: 1 },
      { name: 'Done', orderIndex: 2 },
      { name: 'Todo', orderIndex: 3 },
      { name: 'In Progress', orderIndex: 4 },
      { name: 'Done', orderIndex: 5 },
    ];
    // ⚠️ 当前状态设为 'Todo'（在列表里）⇒ 不触发「当前值不在列表则前置」分支
    // ⇒ 按钮总数就等于去重后的状态数，断言更干净。
    const html = renderPanel(
      { projectStatuses: statuses as ProjectStatus[] },
      { projectStatus: 'Todo' },
    );
    // 数「按钮内容恰为该状态名」的次数（按钮内容后面紧跟 `</button>`）。
    const countOf = (name: string) => html.split(`>${name}</button>`).length - 1;
    expect(countOf('Todo')).toBe(1);
    expect(countOf('In Progress')).toBe(1);
    expect(countOf('Done')).toBe(1);
    // 三个不同名各一个 ⇒ 总共 3 个按钮（去重前是 6 个）。
    expect(html.split('class="seg-btn').length - 1).toBe(3);
    // 且「未标注」（不在列表的当前值）**没有**被前置进来。
    expect(html).not.toContain('未标注');
  });

  it('**大小写不同**的状态不去重（`In Progress` 与 `In progress` 是不同 option）', () => {
    // 合并它们会写错 option_id ⇒ 必须精确匹配。
    const html = renderPanel({
      projectStatuses: [
        { name: 'In Progress', orderIndex: 0 },
        { name: 'In progress', orderIndex: 1 },
      ] as ProjectStatus[],
    });
    expect(html).toContain('>In Progress<');
    expect(html).toContain('>In progress<');
  });

  it('当前状态不在列表里时仍**前置可见**（不被去重逻辑吞掉）', () => {
    const html = renderPanel({
      projectStatuses: [{ name: 'Todo', orderIndex: 0 }] as ProjectStatus[],
    });
    // 当前值 = 'unclassified'（不在列表）⇒ 必须出现在第一个（`detail.unlabeled`）。
    // ⚠️ 按钮上还有 `disabled` / `title` 属性 ⇒ 正则用 `[^>]*` 而不是直接 `>`。
    expect(html).toMatch(/class="seg-btn on"[^>]*>未标注<\/button>/);
  });
});

/** 渲染一张任务卡片（#531 的按钮在其底部）。 */
function renderCard(props: Partial<React.ComponentProps<typeof TaskCard>> = {}): string {
  return renderToStaticMarkup(
    <I18nProvider>
      {/* ⚠️ `active` 是必填 prop ⇒ 不能靠 Partial<> 省略（TS 会报 undefined 不兼容）。 */}
      <TaskCard task={TASK} active={false} onSelectKey={() => {}} {...props} />
    </I18nProvider>,
  );
}

describe('任务卡片上的「在新窗口打开」按钮（#531）', () => {
  it('按钮渲染在卡片底部，带可访问名', () => {
    const html = renderCard({ onOpenInNewWindow: () => {} });
    expect(html).toContain('class="card-open-window"');
    expect(html).toContain('aria-label="在新窗口打开"');
  });

  it('没传回调时**不渲染**该按钮（不做死按钮）', () => {
    const html = renderCard();
    expect(html).not.toContain('card-open-window');
  });

  it('⚠️ 必须 `stopPropagation`（卡片本体 onClick 会打开 modal）', () => {
    // ⚠️ 源码断言：SSR 不跑事件 ⇒ 「点击不冒泡」只能在源码层锁。
    expect(taskCardRaw).toMatch(
      /className="card-open-window"[\s\S]*?onClick=\{\(e\) => \{\s*e\.stopPropagation\(\);\s*onOpenInNewWindow\(task\);/,
    );
  });

  it('看板的 `cardProps` 带了该回调 ⇒ 四处 <TaskCard> 自动都有', () => {
    // ⚠️ 只在 cardProps 里带一次（否则四处 <TaskCard> 会漏掉其中几个）。
    expect(boardRaw).toMatch(/const cardProps = \(task: Task\) => \(\{[\s\S]*?onOpenInNewWindow,/);
  });
});

describe('独立窗组件（#526）', () => {
  it('无任务标识时给出错误态而不是白屏', () => {
    // ⚠️ SSR 不跑 effect ⇒ 只能断言「挂载不崩」且渲染出加载态。
    const html = renderToStaticMarkup(
      <I18nProvider>
        <TaskDetailWindow />
      </I18nProvider>,
    );
    expect(html).toContain('detail-window-error');
    expect(html).toContain('正在加载任务详情');
  });

  it('任务标识来自 `window.__TASK_DETAIL__`（Rust 用 initialization_script 注入）', () => {
    // 独立窗组件读全局注入的标识 ⇒ 窗口一加载就能拿到（无竞态）。
    expect(taskDetailWindowRaw).toContain('window.__TASK_DETAIL__');
    // ⚠️ 主窗口**不该**读它（主窗口走 App 分支）。
    expect(appRaw).not.toContain('__TASK_DETAIL__');
  });
});

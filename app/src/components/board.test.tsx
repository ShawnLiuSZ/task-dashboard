import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import Board, { groupTasksByCustomColumns, resolveBoardView } from './Board';
import TaskCard from './TaskCard';
import { I18nProvider } from '../i18n';
import type { AccountColumn, PrRef, ProjectStatus, Task } from '../types';

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

function mkTask(partial: Partial<Task> & { issueKey: string }): Task {
  return {
    owner: 'ShawnLiuSZ',
    repo: 'task-dashboard',
    number: 1,
    title: '',
    url: '',
    issueState: 'open',
    ownership: 'notassignee',
    status: 'todo',
    projectStatus: '',
    assignees: '',
    author: '',
    mentioned: false,
    latestCommentUrl: '',
    prNumber: 0,
    prUrl: '',
    prState: '', // #435
    prs: [], // #467
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
    updatedAt: null,
    createdAt: 0,
    accountId: 1,
    ...partial,
  };
}

const cols: AccountColumn[] = [
  { id: 1, accountId: 1, colKey: 'Todo', colName: '待办', matchRules: '["待办"]', orderIndex: 0 },
  {
    id: 2,
    accountId: 1,
    colKey: 'In Progress',
    colName: '进行中',
    matchRules: '["进行中"]',
    orderIndex: 1,
  },
];

describe('resolveBoardView (#159)', () => {
  it('custom 模式未配置自定义列时回退到 project 视图', () => {
    expect(resolveBoardView('custom', undefined)).toBe('project');
    expect(resolveBoardView('custom', [])).toBe('project');
  });

  it('custom 模式配置了自定义列时使用 custom 视图', () => {
    expect(resolveBoardView('custom', cols)).toBe('custom');
  });

  it('project / status 模式始终为 project 视图', () => {
    expect(resolveBoardView('project', undefined)).toBe('project');
    expect(resolveBoardView('status', undefined)).toBe('project');
  });

  it('未知模式保留四态列兜底', () => {
    expect(resolveBoardView('unknown' as Task['status'] as never, undefined)).toBe('fourstate');
  });
});

describe('groupTasksByCustomColumns (#438)', () => {
  it('projectStatus 命中列 matchRules 的任务归入对应组，未命中进 unmatched', () => {
    // #438：分组依据是 projectStatus 命中列的 matchRules（project status 原文），
    // 而非 task.status（四态）。cols[0].matchRules=["待办"]、cols[1].matchRules=["进行中"]。
    const tasks = [
      mkTask({ issueKey: 'a', projectStatus: '待办' }),
      mkTask({ issueKey: 'b', projectStatus: '进行中' }),
      mkTask({ issueKey: 'c', projectStatus: 'Done' }),
    ];
    const { groups, unmatched } = groupTasksByCustomColumns(tasks, cols);
    expect(groups.get('Todo')).toEqual([tasks[0]]);
    expect(groups.get('In Progress')).toEqual([tasks[1]]);
    expect(unmatched).toEqual([tasks[2]]);
  });

  it('未配置列时全部任务进 unmatched', () => {
    const tasks = [mkTask({ issueKey: 'a', status: 'todo' })];
    const { groups, unmatched } = groupTasksByCustomColumns(tasks, []);
    expect(groups.size).toBe(0);
    expect(unmatched).toEqual(tasks);
  });

  it('accountColumns 为 undefined 时视为空配置', () => {
    const { groups, unmatched } = groupTasksByCustomColumns([], undefined);
    expect(groups.size).toBe(0);
    expect(unmatched).toEqual([]);
  });
});

/**
 * #405：`projectKeys` 回落分支的**列顺序**此前零覆盖。
 *
 * **背景**：`Board.tsx:49` 的 `sortProjectStatusKeys(keys, projectStatuses?)` 有两条路径：
 *
 * ```ts
 * // 有 project_statuses 时：主路径，keys 直接取表顺序，**不经过本函数**
 * if (projectStatuses && projectStatuses.length > 0) { ... }
 * // 回落：唯一调用点在此，且**第二个参数从未被传入**
 * return sortProjectStatusKeys(Array.from(grouped.keys()).filter(...));
 * ```
 *
 * 审计实测 5 个变异**全部存活**（排序方向反转 / 表内列排末尾 / 回落不排序 /
 * orderMap 键错用 id / 空表判定反转）。原因有二，**都必须记录**：
 *
 * 1. `board.test.tsx` 只传 **1 个** projectStatus 且 `tasks={[]}` ⇒ 没有任何
 *    「两列以上 + 需要重排」的输入；
 * 2. 更根本：**唯一调用点不传 `projectStatuses`** ⇒ 函数内的 `orderMap` 分支
 *    （按 `orderIndex` 排序）是**死代码**，对 `orderIndex` 的 4 个变异天然无效。
 *
 * 因此本例锁住**真实可达行为**：回落路径下列按**字母序**（因为没有 orderIndex 可用）。
 * 死分支本身**不改代码** —— 它是「签名承诺了但调用点用不上」的 API 表面，
 * 是否清理属产品判断，见 KB 文档。
 */
describe('Board 列顺序：projectStatuses 缺失时的回落（#405）', () => {
  /** 取渲染出的列头顺序。 */
  const colOrder = (html: string): string[] =>
    [...html.matchAll(/class="[^"]*column-title[^"]*"[^>]*>([^<]+)</g)].map((m) => m[1].trim());

  it('回落路径下列按字母序排列（无 orderIndex 可用，只能字母序）', () => {
    // 三个 projectStatus，**故意让遍历顺序与字母序相反**
    const tasks = [
      mkTask({ issueKey: 'o/r#1', projectStatus: 'Zebra' }),
      mkTask({ issueKey: 'o/r#2', projectStatus: 'Alpha' }),
      mkTask({ issueKey: 'o/r#3', projectStatus: 'Mango' }),
    ];
    const html = renderToStaticMarkup(
      <I18nProvider>
        <Board tasks={tasks} selected={null} onSelect={noop} projectStatuses={[]} />
      </I18nProvider>,
    );
    const order = colOrder(html);
    // 反向契约：必须真的渲染出了 3 列，否则本例会退化为「什么都没断言」
    expect(order.filter((c) => ['Alpha', 'Mango', 'Zebra'].includes(c))).toEqual([
      'Alpha',
      'Mango',
      'Zebra',
    ]);
    // 字母序（localeCompare 在此环境下的稳定结果），而非输入遍历序 Zebra→Alpha→Mango
    expect(order.indexOf('Alpha')).toBeLessThan(order.indexOf('Mango'));
    expect(order.indexOf('Mango')).toBeLessThan(order.indexOf('Zebra'));
  });

  it('回落路径下列顺序不依赖 tasks 的传入顺序（渲染稳定）', () => {
    const a = [
      mkTask({ issueKey: 'o/r#1', projectStatus: 'Zebra' }),
      mkTask({ issueKey: 'o/r#2', projectStatus: 'Alpha' }),
    ];
    const b = [...a].reverse();
    const render = (ts: typeof a) =>
      colOrder(
        renderToStaticMarkup(
          <I18nProvider>
            <Board tasks={ts} selected={null} onSelect={noop} projectStatuses={[]} />
          </I18nProvider>,
        ),
      );
    // 同样的数据、不同传入顺序 ⇒ 列顺序必须一致（否则刷新一次顺序就跳变）
    expect(render(b)).toEqual(render(a));
  });

  it('已关闭任务落入 done 列、且 done 列排在 unclassified 之后（列存在性）', () => {
    // 上一轮审计发现「主路径漏掉 done 列」的变异存活 —— 本例补上**列存在性**覆盖。
    const tasks = [
      mkTask({ issueKey: 'o/r#1', projectStatus: 'Alpha' }),
      mkTask({ issueKey: 'o/r#2', issueState: 'closed', projectStatus: 'Alpha' }),
      mkTask({ issueKey: 'o/r#3', projectStatus: '' }), // 无 projectStatus → unclassified
    ];
    const statuses: ProjectStatus[] = [
      { id: 1, accountId: 1, projectGithubId: 'PVT_x', name: 'Alpha', orderIndex: 0 },
    ];
    const html = renderToStaticMarkup(
      <I18nProvider>
        <Board tasks={tasks} selected={null} onSelect={noop} projectStatuses={statuses} />
      </I18nProvider>,
    );
    const order = colOrder(html);
    // 三列都必须出现：表内列 Alpha + 合成列 done + 合成列 unclassified
    expect(order).toContain('Alpha');
    // 反向契约：必须真的找到这两列（找不到时上面那些断言会假通过）
    // 合成列的列头走 i18n（zh-CN 下 `done` → `已完成`、`unclassified` → `未标注`），
    // 故按**渲染出来的文案**断言，而不是内部 key。
    const doneAt = order.findIndex((c) => c === '已完成' || /^done$/i.test(c));
    const unclassifiedAt = order.findIndex((c) => c === '未标注' || /unclassified|未分类/i.test(c));
    expect(doneAt, `应渲染出 done 列（已完成），实际列序 ${JSON.stringify(order)}`).toBeGreaterThan(
      -1,
    );
    expect(
      unclassifiedAt,
      `应渲染出 unclassified 列（未标注），实际列序 ${JSON.stringify(order)}`,
    ).toBeGreaterThan(-1);
    // 表内列在前（orderIndex 序），合成列在后
    expect(order.indexOf('Alpha')).toBeLessThan(doneAt);
  });

  it('回落路径过滤空列（无任务的列不得渲染出来）', () => {
    // 「回落分支不过滤空列」的变异此前存活 —— groupByProjectStatus 会为所有出现过的
    // key 建桶，回落分支必须再过滤一次 `length > 0`。
    const tasks = [
      mkTask({ issueKey: 'o/r#1', projectStatus: 'Alpha' }),
      mkTask({ issueKey: 'o/r#2', projectStatus: 'Beta' }),
    ];
    const html = renderToStaticMarkup(
      <I18nProvider>
        <Board tasks={tasks} selected={null} onSelect={noop} projectStatuses={[]} />
      </I18nProvider>,
    );
    const order = colOrder(html);
    expect(order.filter((c) => ['Alpha', 'Beta'].includes(c))).toEqual(['Alpha', 'Beta']);
    // 不应出现任何「有名字但无任务」的列：done / unclassified 桶此时都是空的
    const emptyBuckets = order.filter(
      (c) => /已完成|未标注|^done$/i.test(c) || /unclassified|未分类/i.test(c),
    );
    expect(emptyBuckets, `空桶不应渲染成列，实际列序 ${JSON.stringify(order)}`).toEqual([]);
  });

  it('projectStatuses 非空时列顺序取自表顺序（主路径不受回落影响）', () => {
    const statuses: ProjectStatus[] = [
      { id: 2, accountId: 1, projectGithubId: 'PVT_x', name: 'Zebra', orderIndex: 0 },
      { id: 1, accountId: 1, projectGithubId: 'PVT_x', name: 'Alpha', orderIndex: 1 },
    ];
    const html = renderToStaticMarkup(
      <I18nProvider>
        <Board tasks={[]} selected={null} onSelect={noop} projectStatuses={statuses} />
      </I18nProvider>,
    );
    const order = colOrder(html);
    // 主路径**按 orderIndex**（Zebra=0 在前），与回落路径的字母序相反 —— 两条路径的
    // 差异必须被显式区分，否则有人误以为回落也尊重 orderIndex。
    expect(order.indexOf('Zebra')).toBeLessThan(order.indexOf('Alpha'));
  });
});

describe('Board 渲染（#159）', () => {
  const projectStatuses: ProjectStatus[] = [
    { id: 1, accountId: 1, projectGithubId: 'PVT_x', name: 'In Progress', orderIndex: 0 },
  ];

  it('custom 模式无自定义列时渲染 project 列，而非四态列', () => {
    const html = renderToStaticMarkup(
      <I18nProvider>
        <Board
          tasks={[]}
          selected={null}
          onSelect={noop}
          boardMode="custom"
          accountColumns={[]}
          projectStatuses={projectStatuses}
        />
      </I18nProvider>,
    );
    expect(html).toContain('In Progress');
    expect(html).not.toContain('待处理');
  });

  it('custom 模式有自定义列时渲染自定义列头', () => {
    const html = renderToStaticMarkup(
      <I18nProvider>
        <Board
          tasks={[]}
          selected={null}
          onSelect={noop}
          boardMode="custom"
          accountColumns={cols}
          projectStatuses={[]}
        />
      </I18nProvider>,
    );
    expect(html).toContain('待办');
    expect(html).toContain('进行中');
    expect(html).not.toContain('待处理');
  });

  it('project 模式渲染 project 状态列', () => {
    const html = renderToStaticMarkup(
      <I18nProvider>
        <Board
          tasks={[]}
          selected={null}
          onSelect={noop}
          boardMode="project"
          accountColumns={[]}
          projectStatuses={projectStatuses}
        />
      </I18nProvider>,
    );
    expect(html).toContain('In Progress');
    expect(html).not.toContain('待处理');
  });

  it('project 模式无状态数据时任务归入未标注列（不出现四态列）', () => {
    const html = renderToStaticMarkup(
      <I18nProvider>
        <Board
          tasks={[mkTask({ issueKey: 'a', status: 'todo' })]}
          selected={null}
          onSelect={noop}
          boardMode="project"
          accountColumns={[]}
          projectStatuses={[]}
        />
      </I18nProvider>,
    );
    expect(html).toContain('未标注');
    expect(html).not.toContain('待处理');
  });
});

describe('TaskCard session 行（#197）', () => {
  it('有 session 时分配人下一行展示会话，且底部仍显示时间', () => {
    const html = renderToStaticMarkup(
      <I18nProvider>
        <TaskCard
          task={mkTask({ issueKey: 'a', sessionId: 'sess-123', updatedAt: 1725926400 })}
          active={false}
          onSelectKey={noop}
        />
      </I18nProvider>,
    );
    expect(html).toContain('session-row');
    expect(html).toContain('sess-123');
    expect(html).toContain('2024-09-10');
  });

  it('无 session 时不渲染会话行，底部显示时间', () => {
    const html = renderToStaticMarkup(
      <I18nProvider>
        <TaskCard
          task={mkTask({ issueKey: 'a', updatedAt: 1725926400 })}
          active={false}
          onSelectKey={noop}
        />
      </I18nProvider>,
    );
    expect(html).not.toContain('session-row');
    expect(html).toContain('2024-09-10');
  });
});

describe('TaskCard PR 行与合并状态（#435）', () => {
  const prCard = (prState: string, extra = {}) =>
    renderToStaticMarkup(
      <I18nProvider>
        <TaskCard
          task={mkTask({
            issueKey: 'a',
            prNumber: 321,
            prUrl: 'https://github.com/o/r/pull/321',
            prState,
            assignees: 'alice',
            ...extra,
          })}
          active={false}
          onSelectKey={noop}
        />
      </I18nProvider>,
    );

  it('PR 行位于「分配人」下方独立成行（不在底部时间行里）', () => {
    const html = prCard('merged');
    // 独立行
    expect(html).toContain('pr-row');
    // 位置契约：PR 行在分配人**之后**（用户明确要求的布局）
    const iAssignee = html.indexOf('分配人');
    const iPr = html.indexOf('pr-row');
    expect(iAssignee).toBeGreaterThanOrEqual(0);
    expect(iPr).toBeGreaterThan(iAssignee);
    // 且不再出现在底部 card-bottom 行里
    const iBottom = html.indexOf('card-bottom');
    expect(iBottom).toBeGreaterThan(iPr);
  });

  it('已合并显示绿色徽章', () => {
    const html = prCard('merged');
    expect(html).toContain('pr-state-merged');
    expect(html).toContain('已合并');
  });

  it('进行中 / 已关闭各显示对应徽章', () => {
    expect(prCard('open')).toContain('pr-state-open');
    expect(prCard('open')).toContain('进行中');
    expect(prCard('closed')).toContain('pr-state-closed');
    expect(prCard('closed')).toContain('已关闭');
  });

  it('状态未知（空串）时仍渲染 PR 链接，但不显示徽章', () => {
    // ⚠️ 空串是**常态**而非异常：存量行在 #435 之前没有该值，
    // 且 `state=all` 只拉 3 页 ⇒ 超大仓库的老 PR 拉不到。
    const html = prCard('');
    expect(html).toContain('pr-row');
    expect(html).toContain('PR #321');
    expect(html).not.toContain('pr-state-');
  });

  it('无 PR（prNumber=0）时不渲染 PR 行', () => {
    const html = renderToStaticMarkup(
      <I18nProvider>
        <TaskCard task={mkTask({ issueKey: 'a' })} active={false} onSelectKey={noop} />
      </I18nProvider>,
    );
    expect(html).not.toContain('pr-row');
  });
});

describe('TaskCard 多 PR 关联（#467）', () => {
  const multiPrCard = (prs: PrRef[]) =>
    renderToStaticMarkup(
      <I18nProvider>
        <TaskCard
          task={mkTask({
            issueKey: 'a',
            prNumber: prs[0]?.number ?? 0,
            prUrl: prs[0]?.url ?? '',
            prState: prs[0]?.state ?? '',
            prs,
            assignees: 'alice',
          })}
          active={false}
          onSelectKey={noop}
        />
      </I18nProvider>,
    );

  it('同一 issue 的多个 PR 全部渲染（改造前只保留第一个）', () => {
    const html = multiPrCard([
      { number: 101, url: 'https://github.com/o/r/pull/101', state: 'open' },
      { number: 102, url: 'https://github.com/o/r/pull/102', state: 'merged' },
      { number: 103, url: 'https://github.com/o/r/pull/103', state: 'closed' },
    ]);
    expect(html).toContain('PR #101');
    expect(html).toContain('PR #102');
    expect(html).toContain('PR #103');
    // 三个状态徽章各一份
    expect(html).toContain('pr-state-open');
    expect(html).toContain('pr-state-merged');
    expect(html).toContain('pr-state-closed');
    // 三个链接都在同一行里
    expect(html.match(/pr-item/g) ?? []).toHaveLength(3);
  });

  it('每个 PR 的链接指向各自的 URL（不串号）', () => {
    const html = multiPrCard([
      { number: 101, url: 'https://github.com/o/r/pull/101', state: 'open' },
      { number: 102, url: 'https://github.com/o/r/pull/102', state: 'merged' },
    ]);
    expect(html).toContain('href="https://github.com/o/r/pull/101"');
    expect(html).toContain('href="https://github.com/o/r/pull/102"');
  });

  it('状态未知的 PR 仍渲染链接但不显示徽章', () => {
    const html = multiPrCard([
      { number: 101, url: 'https://github.com/o/r/pull/101', state: '' },
      { number: 102, url: 'https://github.com/o/r/pull/102', state: 'merged' },
    ]);
    expect(html).toContain('PR #101');
    // 只有第二个 PR 有徽章
    expect(html.match(/pr-state-/g) ?? []).toHaveLength(1);
  });

  it('prs 为空但单值字段有值时回退渲染主 PR（存量行不丢徽章）', () => {
    // ⚠️ `prs: []` + `prNumber > 0` 的组合：若实现按「字段存在」判断，
    // 会渲染出空的 PR 行，把原本可见的 PR 链接弄丢。
    const html = renderToStaticMarkup(
      <I18nProvider>
        <TaskCard
          task={mkTask({
            issueKey: 'a',
            prNumber: 321,
            prUrl: 'https://github.com/o/r/pull/321',
            prState: 'merged',
            prs: [],
          })}
          active={false}
          onSelectKey={noop}
        />
      </I18nProvider>,
    );
    expect(html).toContain('PR #321');
    expect(html).toContain('pr-state-merged');
  });

  it('无任何 PR 关联时不渲染 PR 行', () => {
    const html = multiPrCard([]);
    expect(html).not.toContain('pr-row');
  });
});

describe('TaskCard 认领按钮（#214）', () => {
  it('未认领任务渲染可点认领按钮', () => {
    const html = renderToStaticMarkup(
      <I18nProvider>
        <TaskCard
          task={mkTask({ issueKey: 'a', ownership: 'notassignee' })}
          active={false}
          onSelectKey={noop}
        />
      </I18nProvider>,
    );
    expect(html).toContain('claim-btn');
    expect(html).toContain('无人认领');
    // 确认框只在点击后出现，SSR 无点击故不存在
    expect(html).not.toContain('confirm-modal');
  });

  it('已分配任务无认领按钮', () => {
    const html = renderToStaticMarkup(
      <I18nProvider>
        <TaskCard
          task={mkTask({ issueKey: 'a', ownership: 'assigned', assignees: 'me' })}
          active={false}
          onSelectKey={noop}
        />
      </I18nProvider>,
    );
    expect(html).not.toContain('claim-btn');
  });
});

describe('TaskCard 创建人行与顶部账号行（#237）', () => {
  const renderCard = (partial: Partial<Task> & { issueKey: string }) =>
    renderToStaticMarkup(
      <I18nProvider>
        <TaskCard task={mkTask(partial)} active={false} onSelectKey={noop} />
      </I18nProvider>,
    );

  it('有创建人时渲染「创建人」行，并位于「分配人」行之前', () => {
    const html = renderCard({ issueKey: 'a', author: 'alice', assignees: 'bob' });
    expect(html).toContain('creator-row');
    expect(html).toContain('@alice');
    expect(html).toContain('创建人');
    // DOM 顺序：创建人 必须排在 分配人 之前
    expect(html.indexOf('创建人')).toBeGreaterThan(-1);
    expect(html.indexOf('创建人')).toBeLessThan(html.indexOf('分配人'));
  });

  it('创建人为空时不渲染该行（不留空标签行）', () => {
    const html = renderCard({ issueKey: 'a', author: '' });
    expect(html).not.toContain('creator-row');
    expect(html).not.toContain('创建人');
  });

  it('创建人为纯空白同样不渲染', () => {
    expect(renderCard({ issueKey: 'a', author: '   ' })).not.toContain('creator-row');
  });

  it('不再渲染顶部归属账号徽章行', () => {
    const html = renderCard({ issueKey: 'a', author: 'alice' });
    expect(html).not.toContain('account-row-top');
    expect(html).not.toContain('account-badge');
  });

  it('repo#编号 行仍完整渲染（放大字号不影响结构）', () => {
    const html = renderCard({ issueKey: 'a', repo: 'fad-backend', number: 1170 });
    expect(html).toContain('fad-backend');
    expect(html).toContain('#1170');
    expect(html).toContain('card-top');
  });
});

/**
 * #485：任务按 `projectStatus` **原文**分组，而 project 视图的列键原本只来自
 * `project_statuses` 表 ⇒ 选项改名（Planned → Planing）或跨项目状态会把任务送进
 * 永不渲染的分组：列头之和 < 任务总数，且既不进任何列也不进「未标注」。
 * 实测本机 567 条只渲染 558（差 9 条 `Planned`）。
 */
describe('Board 表外状态值兜底成列（#485）', () => {
  const colOrder = (html: string): string[] =>
    [...html.matchAll(/class="[^"]*column-title[^"]*"[^>]*>([^<]+)</g)].map((m) => m[1].trim());

  /** 所有列头 count 之和 —— 「不丢任务」的不变量：必须等于任务总数。 */
  const countSum = (html: string): number =>
    [...html.matchAll(/class="count">(\d+)</g)].reduce((s, m) => s + Number(m[1]), 0);

  const render = (tasks: Task[], statuses: ProjectStatus[]) =>
    renderToStaticMarkup(
      <I18nProvider>
        <Board tasks={tasks} selected={null} onSelect={noop} projectStatuses={statuses} />
      </I18nProvider>,
    );

  const statuses: ProjectStatus[] = [
    { id: 1, accountId: 1, projectGithubId: 'PVT_x', name: 'Alpha', orderIndex: 0 },
  ];

  it('project_status 不在表里的任务必须成列（修复前静默消失）', () => {
    const tasks = [
      mkTask({ issueKey: 'o/r#1', projectStatus: 'Alpha', title: 'IN-TABLE' }),
      mkTask({ issueKey: 'o/r#2', projectStatus: 'Planned', title: 'OUT-OF-TABLE' }),
    ];
    const html = render(tasks, statuses);
    const order = colOrder(html);
    expect(order, `实际列序 ${JSON.stringify(order)}`).toContain('Planned');
    // 反向契约：任务卡片真的渲染出来了（而不是只多了一个空列）
    expect(html).toContain('OUT-OF-TABLE');
    // 不变量：列头数字之和 == 任务总数（修复前为 1 < 2）
    expect(countSum(html), `列头之和应等于任务数，实际列序 ${JSON.stringify(order)}`).toBe(2);
    // 表外兜底列排在已配置列之后
    expect(order.indexOf('Alpha')).toBeLessThan(order.indexOf('Planned'));
  });

  it('表外状态无任务时不建空列（避免列噪音）', () => {
    const tasks = [mkTask({ issueKey: 'o/r#1', projectStatus: 'Alpha' })];
    expect(colOrder(render(tasks, statuses))).not.toContain('Planned');
  });

  it('多个表外状态按名称排序，且不随任务传入顺序变化（渲染稳定）', () => {
    const a = [
      mkTask({ issueKey: 'o/r#1', projectStatus: 'Zeta' }),
      mkTask({ issueKey: 'o/r#2', projectStatus: 'Eta' }),
    ];
    const extraOrder = (ts: Task[]) =>
      colOrder(render(ts, statuses)).filter((c) => ['Eta', 'Zeta'].includes(c));
    expect(extraOrder(a)).toEqual(['Eta', 'Zeta']);
    expect(extraOrder([...a].reverse())).toEqual(['Eta', 'Zeta']);
  });

  it('已关闭任务仍归 done 列，不因兜底逻辑重复成列', () => {
    // 关闭任务按 issueState 先归 done；其 projectStatus 即便表外，也不该再单独成列
    const tasks = [
      mkTask({ issueKey: 'o/r#1', projectStatus: 'Alpha' }),
      mkTask({ issueKey: 'o/r#2', issueState: 'closed', projectStatus: 'Planned' }),
    ];
    const html = render(tasks, statuses);
    const order = colOrder(html);
    expect(order).toContain('已完成');
    expect(order).not.toContain('Planned');
    expect(countSum(html)).toBe(2);
  });
});

import { describe, expect, it } from 'vitest';
import type { Task } from '../types';
import { taskListSignature } from './taskSig';

function mkTask(partial: Partial<Task> & { issueKey: string }): Task {
  return {
    owner: 'ShawnLiuSZ',
    repo: 'task-dashboard',
    number: 1,
    title: 't',
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

describe('taskListSignature (#181)', () => {
  it('相同列表指纹稳定', () => {
    const a = [mkTask({ issueKey: 'a#1' }), mkTask({ issueKey: 'a#2' })];
    const b = [mkTask({ issueKey: 'a#1' }), mkTask({ issueKey: 'a#2' })];
    expect(taskListSignature(a)).toBe(taskListSignature(b));
  });

  it('本地写入会碰的字段变化时指纹变化', () => {
    const base = [mkTask({ issueKey: 'a#1' })];
    const sig = taskListSignature(base);
    // set_task_status
    expect(taskListSignature([{ ...base[0], status: 'doing' }])).not.toBe(sig);
    // touch_session 三件套
    expect(
      taskListSignature([{ ...base[0], sessionId: 's1', sessionAgent: 'opencode', sessionAt: 7 }]),
    ).not.toBe(sig);
    // record_task_handoff
    expect(taskListSignature([{ ...base[0], handoff: '交接' }])).not.toBe(sig);
    // touch_session 带工作分支（#193 workBranch 纳入指纹）
    expect(taskListSignature([{ ...base[0], workBranch: 'feat/x' }])).not.toBe(sig);
    // #220：同步镜像字段变化（updated_at 不变）指纹也变化，否则写回后不刷新
    expect(taskListSignature([{ ...base[0], projectStatus: 'Done' }])).not.toBe(sig);
    expect(taskListSignature([{ ...base[0], branch: 'feat/y' }])).not.toBe(sig);
    // clear_session（有值变无值）
    const withSession = [{ ...base[0], sessionId: 's1', sessionAgent: 'opencode' }];
    expect(taskListSignature(base)).not.toBe(taskListSignature(withSession));
  });

  // #376：把「契约字段清单」变成可测的表驱动断言。
  //
  // 此前用例按**字段组**断言（如 session 三件套一次改三个），只要组内任意一个字段
  // 仍在签名里，指纹就会变 ⇒ 断言通过 ⇒ **单独**删掉某个字段测不出来。
  // 实测 15 个字段里有 8 个可被单独删除而无任何测试失败，其中 updatedAt 与
  // workDir 是真实 bug（前者 → TaskCard 日期不刷新；后者 → agent 设的工作目录
  // 不刷新），而 taskSig.ts 的注释逐个点名了必须纳入的字段 —— 这是一份显式契约，
  // 却没有测试在守。
  //
  // **反向验证**：逐个删除下面任一字段，本用例必须失败。
  const CONTRACT_FIELDS: [string, Partial<Task>][] = [
    ['issueKey', { issueKey: 'other#9' }],
    ['accountId', { accountId: 99 }],
    ['status', { status: 'done' }],
    ['ownership', { ownership: 'assigned' }],
    ['title', { title: '改了标题' }],
    ['sessionId', { sessionId: 'sess-x' }],
    ['sessionAgent', { sessionAgent: 'opencode' }],
    ['sessionAt', { sessionAt: 4242 }],
    ['handoff', { handoff: '交接内容' }],
    ['workBranch', { workBranch: 'feat/z' }],
    ['workDir', { workDir: '/Users/me/proj' }],
    ['projectStatus', { projectStatus: 'In Progress' }],
    ['branch', { branch: 'feat/q' }],
    ['updatedAt', { updatedAt: 1_700_000_000 }],
    ['candidateDone', { candidateDone: true }],
  ];

  it('#376：契约字段逐个变化时指纹都必须变化（表驱动）', () => {
    const base = mkTask({ issueKey: 'a#1' });
    const sig = taskListSignature([base]);
    for (const [field, patch] of CONTRACT_FIELDS) {
      expect(
        taskListSignature([{ ...base, ...patch }]),
        `字段 ${field} 变化时指纹必须变化（漏掉它 ⇒ applyTasks 会跳过 setTasks ⇒ UI 不刷新）`,
      ).not.toBe(sig);
    }
  });

  it('#376：契约字段清单与签名实际覆盖一致（新增字段时须同时登记）', () => {
    const base = mkTask({ issueKey: 'a#1' });
    const sig = taskListSignature([base]);
    // 逐字段确认：任何未登记进 CONTRACT_FIELDS 的 Task 字段，若单独变化仍会改变
    // 指纹，说明它也进了签名 —— 此时应补进契约清单，避免「契约」与实现漂移。
    const UNCOVERED_SAMPLE: [string, Partial<Task>][] = [
      ['owner', { owner: 'someone-else' }],
      ['repo', { repo: 'other-repo' }],
      ['assignees', { assignees: 'x' }],
      ['author', { author: 'x' }],
    ];
    for (const [field, patch] of UNCOVERED_SAMPLE) {
      const changed = taskListSignature([{ ...base, ...patch }]) !== sig;
      expect(
        changed,
        `字段 ${field} 竟会改变指纹 —— 它在签名里，请补进 CONTRACT_FIELDS 或从签名移除后说明理由`,
      ).toBe(false);
    }
  });

  it('增删任务时指纹变化', () => {
    const one = [mkTask({ issueKey: 'a#1' })];
    const two = [...one, mkTask({ issueKey: 'a#2', number: 2 })];
    expect(taskListSignature(two)).not.toBe(taskListSignature(one));
    expect(taskListSignature([])).not.toBe(taskListSignature(one));
  });

  it('#329：聚合视图下同一 issue 来自两个账号时指纹必须不同', () => {
    const acct1 = [mkTask({ issueKey: 'a#1', accountId: 1 })];
    const acct2 = [mkTask({ issueKey: 'a#1', accountId: 2 })];
    expect(taskListSignature(acct1)).not.toBe(taskListSignature(acct2));
    // 两条记录互换账号归属也要能识别（否则「换账号」不会刷新看板）
    const both = [
      mkTask({ issueKey: 'a#1', accountId: 1 }),
      mkTask({ issueKey: 'a#1', accountId: 2 }),
    ];
    const swapped = [both[1], both[0]];
    expect(taskListSignature(both)).not.toBe(taskListSignature(swapped));
  });
});

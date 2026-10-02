import { describe, expect, it } from 'vitest';
// 仓库约定（见 styles.test.ts）：vitest 跑在 node 环境，无 DOM / 无布局引擎，
// 组件接线类回归用 `?raw` 读源码做静态断言，而不是引入 jsdom / testing-library
// （§2.5 不引入新依赖）。
import aboutRaw from './components/AboutPanel.tsx?raw';
import accountsRaw from './components/AccountsPanel.tsx?raw';
import agentRaw from './components/AgentPanel.tsx?raw';
import appRaw from './App.tsx?raw';
import boardRaw from './components/Board.tsx?raw';
import confirmRaw from './components/ConfirmDialog.tsx?raw';
import detailRaw from './components/DetailPanel.tsx?raw';
import notesRaw from './components/NotesPanel.tsx?raw';
import sessionsRaw from './components/SessionsPanel.tsx?raw';
import settingsRaw from './components/SettingsPanel.tsx?raw';
import logsRaw from './components/SyncLogsPanel.tsx?raw';
import escHookRaw from './utils/useEscLayer.ts?raw';
import taskCardRaw from './components/TaskCard.tsx?raw';
import { taskIdentity } from './utils/taskIdentity';

/**
 * #329 前端一致性批次的接线守卫。
 *
 * 这些缺陷的共同点是「接线错了但类型/单测都过得去」，纯逻辑已抽成
 * `utils/escLayer.ts` / `utils/taskIdentity.ts` 单测（见各自 .test.ts），
 * 此处只锁住「组件有没有正确接上」。
 */

describe('Esc 分层接线（#329）', () => {
  it('ConfirmDialog 注册为 Esc 层，且只在最上层响应', () => {
    // #344：层注册下沉到 useWindowEscLayer —— `onCancel` 每次渲染都是新引用，
    // 放进 effect 依赖会让层级在父重渲染时被父子整体重排而**颠倒**
    // （一次 Esc 直接关掉整个面板，而非取消对话框）。
    expect(confirmRaw).toMatch(/useWindowEscLayer\(/);
  });

  it('#344 层级注册只发生一次：不在带不稳定回调依赖的 effect 里注册 Esc 层', () => {
    // 组件侧：不再自己注册，也不再把 onClose/onCancel 放进 Esc effect 依赖
    for (const [name, raw] of [
      ['ConfirmDialog', confirmRaw],
      ['SyncLogsPanel', logsRaw],
    ] as [string, string][]) {
      expect(raw, `${name} 不应自己注册 Esc 层`).not.toMatch(/registerEscLayer\(/);
      expect(raw, `${name} 不得把 onClose/onCancel 放进 Esc effect 依赖`).not.toMatch(
        /\}, \[on(Close|Cancel)\]\)/,
      );
    }
    // hook 侧：层注册与 window 监听都只在挂载时做一次（依赖恒为 []）
    expect(escHookRaw).toMatch(/export function useWindowEscLayer/);
    expect(escHookRaw).toMatch(/handler\.current = onEsc/);
    const effect = escHookRaw.match(/const layer = registerEscLayer\(\);[\s\S]*?\}, \[\]\);/)?.[0];
    expect(effect, '应能取到 useWindowEscLayer 里注册层的 effect').not.toBe('');
  });

  const escHolders: [string, string][] = [
    ['DetailPanel', detailRaw],
    ['SyncLogsPanel', logsRaw],
    ['SettingsPanel', settingsRaw],
    ['AccountsPanel', accountsRaw],
    ['AboutPanel', aboutRaw],
    ['App 的更新提示弹框', appRaw],
  ];

  for (const [name, raw] of escHolders) {
    it(`${name} 的 Esc 处理前先问层级（否则会与确认框一起关闭）`, () => {
      // #344：window 级面板改为经 useWindowEscLayer 走分层，元素级仍用 isEscTop()
      expect(raw).toMatch(/(isEscTop|isTop)\(\)|useWindowEscLayer\(/);
    });
  }

  it('NotesPanel 的 Esc 是「取消行内编辑」的局部语义，不参与分层', () => {
    expect(notesRaw).toMatch(/note-textarea/);
    expect(notesRaw).not.toMatch(/isTop\(\)/);
  });
});

describe('任务身份跨账号唯一（#329）', () => {
  it('Board 卡片 key 与选中态判定都用 taskIdentity（4 卡片 × 2 处）', () => {
    expect(boardRaw).not.toMatch(/key=\{task\.issueKey\}/);
    expect(boardRaw).not.toMatch(/task\.issueKey === selected/);
    expect(boardRaw.match(/taskIdentity\(task\)/g) ?? []).toHaveLength(8);
  });

  it('App 用身份查找选中任务，详情面板 key 也按身份（跨账号切换需重挂载）', () => {
    expect(appRaw).toMatch(/tasks\.find\(\(t\) => taskIdentity\(t\) === selected\)/);
    expect(appRaw).toMatch(/key=\{taskIdentity\(selectedTask\)\}/);
  });

  it('SessionsPanel 会话卡片 key 用身份（聚合视图下同一 issue 有两个 session）', () => {
    expect(sessionsRaw).toMatch(/key=\{taskIdentity\(task\)\}/);
  });

  it('指纹纳入 accountId（否则换账号不刷新）', () => {
    expect(appRaw).toMatch(/taskListSignature/);
  });
});

describe('任务身份生产端与消费端同口径（#339）', () => {
  // #339：`TaskCard` 未跟进 #329，仍发裸 `issueKey`，而消费端全用 `taskIdentity` ⇒
  // 点击后 `App` 查不回任务，详情面板彻底不可达。上面那组断言只查消费端，正是漏网之处，
  // 故这里必须把**生产端**也锁住。
  it('TaskCard 的点击与键盘路径都传身份，而非裸 issueKey', () => {
    // 两处调用点（onClick / Enter-Space）都必须是 taskIdentity(task)
    expect(taskCardRaw).not.toMatch(/onSelectKey\(task\.issueKey\)/);
    expect(taskCardRaw.match(/onSelectKey\(taskIdentity\(task\)\)/g) ?? []).toHaveLength(2);
  });

  it('写操作仍用 issueKey（后端按 issue_key 定位，不可换成身份）', () => {
    // claimIssue 是写路径，必须保持裸键
    expect(taskCardRaw).toMatch(/claimIssue\(task\.issueKey\)/);
  });

  it('身份实参能被 App 的查找式命中（端到端契约）', () => {
    const task = { issueKey: 'ShawnLiuSZ/task-dashboard#329', accountId: 1 };
    // 复刻 App.tsx:487 的查找
    const emitted = taskIdentity(task);
    expect(emitted).toBe('ShawnLiuSZ/task-dashboard#329@1');
    expect([task].find((t) => taskIdentity(t) === emitted) ?? null).not.toBeNull();
    // 旧生产端发出的裸键查不回 —— 这正是 #339 的缺陷本体
    expect([task].find((t) => taskIdentity(t) === task.issueKey) ?? null).toBeNull();
  });
});

describe('AgentPanel 项目目录提交（#329）', () => {
  it('输入框失焦 / 回车才提交', () => {
    expect(agentRaw).toMatch(/onBlur=\{commitTargetDir\}/);
    expect(agentRaw).toMatch(/if \(e\.key === 'Enter'\) commitTargetDir\(\)/);
  });

  it('自动查询依赖已提交值，不再依赖实时输入（旧实现逐键 2 次 IPC）', () => {
    expect(agentRaw).toMatch(/committedTargetDir, refreshHooksStatus, runScan\]\)/);
    expect(agentRaw).not.toMatch(/\}, \[tab, hooksScope, hooksBusy, targetDir, refreshAll\]\)/);
  });

  it('显式动作（安装 / 卸载 / 手动刷新）仍用实时值', () => {
    expect(agentRaw).toMatch(/await op\(hooksScope, hooksTarget\(\), agents\)/);
    expect(agentRaw).toMatch(/await refreshHooksStatus\(hooksTarget\(\)\)/);
  });
});

describe('NotesPanel 首屏 / 后台刷新分离（#329）', () => {
  it('首屏才用 loading 占位，后续重查只置 refreshing', () => {
    expect(notesRaw).toMatch(/if \(loadedOnce\.current\) setRefreshing\(true\)/);
    expect(notesRaw).toMatch(/else setLoading\(true\)/);
  });

  it('后台刷新用 aria-busy 做轻量反馈而非整块替换', () => {
    expect(notesRaw).toMatch(/aria-busy=\{refreshing \|\| undefined\}/);
  });
});

describe('SettingsPanel 列编辑草稿不被重置（#329）', () => {
  it('账号列配置 effect 依赖账号 id 指纹，而非每次都是新引用的 accounts 数组', () => {
    expect(settingsRaw).toMatch(
      /const accountIdsKey = settings\.accounts\.map\(\(a\) => a\.id\)\.join\(','\)/,
    );
    expect(settingsRaw).toMatch(/\}, \[accountIdsKey\]\)/);
    expect(settingsRaw).not.toMatch(/\}, \[settings\.accounts\]\)/);
  });
});

describe('App 列表查询统一走合并器（#329）', () => {
  // 注释里会提到被禁止的写法（如「原实现直连 api.listTasks」），负向断言前先剥离注释。
  const stripComments = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

  it('clearAllFilters 不得绕过合并器直连 listTasks（会与在途查询竞态）', () => {
    const fn =
      appRaw.match(
        /const clearAllFilters = useCallback\(async \(\) => \{[\s\S]*?\n {2}\}, \[[^\]]*\]\);/,
      )?.[0] ?? '';
    expect(fn, '应从 App.tsx 中取到 clearAllFilters 函数体').not.toBe('');
    expect(fn).toMatch(/await loadWith\('', accountFilter\)/);
    expect(stripComments(fn)).not.toMatch(/api\.listTasks/);
  });

  it('quarantine 提示拉取有 .catch，不再静默产生未处理拒绝', () => {
    const block = appRaw.match(/getQuarantineNotice\(\)[\s\S]*?\.catch\([^)]*\)/)?.[0] ?? '';
    expect(block, '应能取到 getQuarantineNotice 的调用链').not.toBe('');
    expect(block).toMatch(/\.catch\(reportError\)/);
  });
});

describe('SessionsPanel 复制按钮（#329）', () => {
  it('handleCopy 有 try/catch，且定时器在卸载时清理', () => {
    const fn =
      sessionsRaw.match(/const handleCopy = useCallback\(async[\s\S]*?\n {2}\}, \[\]\);/)?.[0] ??
      '';
    expect(fn).not.toBe('');
    expect(fn).toMatch(/try \{[\s\S]*await navigator\.clipboard\.writeText/);
    expect(fn).toMatch(/catch \(e\)/);
    expect(sessionsRaw).toMatch(/copiedTimer\.current !== null\) window\.clearTimeout/);
  });
});

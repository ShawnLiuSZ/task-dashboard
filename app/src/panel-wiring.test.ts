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
import apiRaw_ from './api.ts?raw';
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
    // ⚠️ 必须用 `?? ''` 兜底，不能只写 `?.[0]`：无匹配时 `?.[0]` 是 `undefined`，
    // 而 `expect(undefined).not.toBe('')` **会通过**（undefined !== ''）⇒ 守卫失效、
    // 断言永不失败。下方已用「破坏注册层」的注入实测过该失效。
    const effect =
      escHookRaw.match(/const layer = registerEscLayer\(\);[\s\S]*?\}, \[\]\);/)?.[0] ?? '';
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

describe('写路径的乐观更新必须可回滚且有错误出口（#374）', () => {
  // AccountCard 的 handleBoardModeChange 原先既无 try/catch、也不回滚乐观更新：
  // 保存失败时 `<select>` 仍显示新值（看起来成功），刷新后跳回旧值。
  // 同文件其他写路径（saveSettings / saveColumns）都有可见出口，只有它漏了 ——
  // 因为 AccountCard 没有自己的 err 状态，外层 SettingsPanel 的那个它拿不到。
  it('handleBoardModeChange 必须同时具备 try/catch、reportError 与回滚', () => {
    const fn =
      settingsRaw.match(
        /const handleBoardModeChange = async \(mode: BoardMode\) => \{[\s\S]*?\n {2}\};/,
      )?.[0] ?? '';
    expect(fn, '应能取到 handleBoardModeChange 函数体').not.toBe('');
    expect(fn).toMatch(/try \{/);
    expect(fn).toMatch(/catch \(e\)/);
    // 失败必须可见
    expect(fn).toMatch(/reportError\(/);
    // 失败必须回滚乐观更新（setBoardMode(prev)），否则 UI 与后端不一致
    expect(fn).toMatch(/setBoardMode\(prev\)/);
    // 成功路径仍是乐观更新
    expect(fn).toMatch(/setBoardMode\(mode\)/);
  });

  it('AccountCard 自身持有错误出口时优先用它（若将来给 AccountCard 加 err 状态）', () => {
    // 本断言只锁定「不得退回无出口」：函数体里既没有 reportError 也没有 setErr 就失败。
    const fn = settingsRaw.match(/const handleBoardModeChange[\s\S]*?\n {2}\};/)?.[0] ?? '';
    expect(fn).toMatch(/reportError\(|setErr\(/);
  });
});

describe('聚合视图加载失败必须可见（#372）', () => {
  // 「全部账号视图」下 `listProjectStatuses` / `listAccountColumns` 的单账号失败被
  // 隔离成空数组（#145 有意为之），但此前**只落 console.warn** ⇒
  //   · projectStatuses 为空 → `sortProjectStatusKeys` 退化为字母序（看板列静默错序）
  //   · accountColumns 为空 → `resolveBoardView` 从 'custom' **退回 'project'**
  //     （Board.tsx:91），即看板静默换了列模式
  // 两条后果都是「用户看到界面变了却不知原因」，故必须经 reportError 上抛。
  it('聚合视图不得用 console.warn 作为加载失败的唯一出口', () => {
    // 注意：projectStatuses 与 accountColumns 的聚合分支在**两个不同函数**里，
    // 各自有一个 `if (s.viewMode === 'all')` ⇒ 必须逐个匹配AllOf，不能只取第一个。
    const blocks = [...appRaw.matchAll(/if \(s\.viewMode === 'all'\) \{([\s\S]*?)\n {8}\}/g)];
    expect(blocks.length, '应能匹配到两个聚合分支（projectStatuses / accountColumns）').toBe(2);

    for (const [, allView] of blocks) {
      // 聚合分支内不得残留 console.warn 作为错误出口
      expect(allView, '聚合分支不得用 console.warn 作为唯一错误出口').not.toMatch(/console\.warn/);
    }

    // 两处列表加载各自的 .catch 内都须有 reportError。
    // 用「catch 开头 → 其后 800 字符内出现 reportError」限定归属，避免 `[\s\S]*?`
    // 一路跨到另一个 catch（第一版正是这么写错的：段长限制写死成 `{0,600}` 且假定了
    // 一个并不存在的缩进 —— 实际那个 catch 里塞了 4 行注释，长度超限）。
    for (const fn of ['listProjectStatuses', 'listAccountColumns']) {
      const at = appRaw.indexOf(`${fn}(a.id)`);
      expect(at, `应能找到 ${fn} 调用`).toBeGreaterThan(-1);
      const after = appRaw.slice(at, at + 1200);
      const catchAt = after.indexOf('.catch(');
      expect(catchAt, `${fn} 应带 .catch 隔离`).toBeGreaterThan(-1);
      expect(
        after.slice(catchAt, catchAt + 800),
        `${fn} 加载失败必须经 reportError 上抛（不得只落 console）`,
      ).toMatch(/reportError\(/);
    }
  });

  it('单账号视图的失败已走 setError（可见），不得被改回 console-only', () => {
    // 单账号路径本就调 setError，此断言防回退
    expect(appRaw).toMatch(/加载项目状态选项失败[\s\S]*?setError\(/);
    expect(appRaw).toMatch(/加载自定义列配置失败[\s\S]*?setError\(/);
  });
});

describe('外链打开统一走 openExternal（#370）', () => {
  // `void api.openInBrowser(...)` 只丢弃 Promise、**不会**吞掉 rejection ⇒ 命令失败
  // （validate_browser_url 拒绝 / spawn 失败）时界面毫无反应也不报错。
  // `openExternal` 内部 `.catch(reportError)`，是全仓唯一正确形态。
  // #329 批量替换时漏了 SessionsPanel 一处，本组断言防它再次漏网。
  const panels: [string, string][] = [
    ['TaskCard', taskCardRaw],
    ['DetailPanel', detailRaw],
    ['AboutPanel', aboutRaw],
    ['AccountsPanel', accountsRaw],
    ['SessionsPanel', sessionsRaw],
    ['App', appRaw],
  ];

  it('**所有**组件都不再直接裸调 api.openInBrowser（须走 openExternal）', () => {
    for (const [name, raw] of panels) {
      expect(raw, `${name} 不得裸调 api.openInBrowser`).not.toMatch(/api\.openInBrowser\s*\(/);
    }
  });

  // #389：上一条只遍历**手写的 6 项枚举**，新增组件（或当时不在清单里的组件）
  // 引入裸调用时守卫完全不响。实测往 `AgentPanel` / `SettingsPanel` 各注入一处
  // `api.openInBrowser(` —— panel-wiring 全套**仍然全绿**，而往清单内的
  // `SessionsPanel` 注入才会失败。
  //
  // 这是「只改了一半」模式的第 5 次实例（#339 TaskCard / #345 MCP 分帧 /
  // #357 get_opt / #370 openExternal / 本项）：**每次都是「修复处有守卫、
  // 守卫本身有盲区」**。
  //
  // 修法与 #376 / #380 同源：把「手写枚举」换成**从目录自动枚举**，
  // 让新增组件天然落在守卫范围内，无需记得同步维护清单。
  it('自动枚举：新增组件若裸调 api.openInBrowser 也会被守卫抓到', () => {
    // `import.meta.glob` 在 vitest 下按字面量静态展开 —— 组件目录里的每个
    // .tsx 都自动进入这张表，新增文件无需改本测试。
    // 注意要同时枚举 `./App.tsx` —— 它在 src 根目录、不在 components/ 下，
    // 而手写清单里一直有它。只写 './components/*.tsx' 会漏掉（本人第一版就漏了，
    // 由下一条的反向契约当场抓出，见该条注释）。
    const allComponents = {
      ...(import.meta.glob('./components/*.tsx', {
        query: '?raw',
        import: 'default',
        eager: true,
      }) as Record<string, string>),
      ...(import.meta.glob('./App.tsx', {
        query: '?raw',
        import: 'default',
        eager: true,
      }) as Record<string, string>),
    };
    const names = Object.keys(allComponents).sort();
    // 守卫若因路径写错而静默匹配到 0 个文件，就会变成恒真断言（#367 的教训）
    expect(names.length).toBeGreaterThan(10);

    const offenders = names.filter((name) => /api\.openInBrowser\s*\(/.test(allComponents[name]));
    expect(
      offenders,
      `这些组件裸调了 api.openInBrowser（须走 openExternal）：${offenders.join(', ')}`,
    ).toEqual([]);
  });

  it('自动枚举确实覆盖了手写清单之外的组件（否则上一条形同虚设）', () => {
    const allComponents = {
      ...(import.meta.glob('./components/*.tsx', {
        query: '?raw',
        import: 'default',
        eager: true,
      }) as Record<string, string>),
      ...(import.meta.glob('./App.tsx', {
        query: '?raw',
        import: 'default',
        eager: true,
      }) as Record<string, string>),
    };
    const autoNames = Object.keys(allComponents).map((p) => p.split('/').pop());
    // 反向契约：自动枚举的范围必须是手写清单的**超集**。
    // 若有人后来把手写清单当成唯一来源，这里会因「清单里有自动枚举没有的」而失败。
    const listed = panels.map(([name]) => `${name}.tsx`);
    const missing = listed.filter((f) => !autoNames.includes(f));
    expect(missing, `手写清单里有自动枚举未覆盖的文件：${missing.join(', ')}`).toEqual([]);
    // 并显式确认「清单外组件确实存在且已被自动枚举覆盖」——否则这条守卫只是
    // 在一个很小的目录上打转（当前 components/ 下共 14 个组件，清单只有 6 个）。
    expect(autoNames.length).toBeGreaterThan(panels.length);
  });

  it('openExternal 自身必须带 .catch（否则收口形同虚设）', () => {
    const apiRaw = apiRaw_;
    expect(apiRaw).toMatch(
      /export function openExternal\(url: string\): void \{[\s\S]*?api\.openInBrowser\(url\)\.catch\(reportError\)/,
    );
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

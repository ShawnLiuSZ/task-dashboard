import { describe, expect, it } from 'vitest';
// 仓库约定（见 panel-wiring.test.ts / styles.test.ts）：vitest 跑在 node 环境，
// 不引入 jsdom / testing-library（§2.5 不引入新依赖），组件交互类回归用 `?raw`
// 读源码做静态断言，锁定「接线是否正确」。
import sessionsRaw from './components/SessionsPanel.tsx?raw';
import apiRaw from './api.ts?raw';
import libRaw from '../src-tauri/src/lib.rs?raw';

/**
 * 任务会话多选删除（#391）回归测试。
 *
 * 后端批量逻辑（`clear_task_sessions` 累加 affected、部分不存在不阻断）
 * 由 commands.rs 单元测试覆盖；前端只负责把选中的 issueKey 集合传给
 * `api.clearSessions`。此处静态锁定：API 接线、后端命令注册、组件交互接线。
 */

describe('多选删除后端命令接线（#391）', () => {
  it('api.ts 暴露 clearSessions，调用 clear_sessions 命令并传 keys 数组', () => {
    expect(apiRaw).toMatch(
      /clearSessions:\s*\(keys:\s*string\[\]\)\s*=>\s*invoke<void>\('clear_sessions',\s*\{\s*keys\s*\}\)/,
    );
  });

  it('lib.rs 注册 commands::clear_sessions', () => {
    expect(libRaw).toMatch(/commands::clear_sessions/);
  });
});

describe('SessionsPanel 多选 UI 接线（#391）', () => {
  it('非选择模式渲染「选择」入口（进入选择模式）', () => {
    expect(sessionsRaw).toMatch(/onClick=\{\(\) => setSelectMode\(true\)\}/);
    expect(sessionsRaw).toMatch(/t\('sessions\.select'\)/);
  });

  it('选择模式工具栏含全选/计数/删除选中/取消', () => {
    // 全选按钮文案切换（selectAll / cancelSelectAll）
    expect(sessionsRaw).toMatch(/t\('sessions\.selectAll'\)/);
    expect(sessionsRaw).toMatch(/t\('sessions\.cancelSelectAll'\)/);
    // 已选计数
    expect(sessionsRaw).toMatch(
      /t\('sessions\.selectedCount',\s*\{\s*n:\s*selectedKeys\.size\s*\}\)/,
    );
    // 删除选中按钮
    expect(sessionsRaw).toMatch(/t\('sessions\.deleteSelected'\)/);
    // 退出选择
    expect(sessionsRaw).toMatch(/t\('sessions\.cancelSelect'\)/);
  });

  it('全选逻辑：选中全部 issueKey，再次点击清空', () => {
    const fn =
      sessionsRaw.match(
        /const toggleSelectAll = useCallback\(\(\) => \{[\s\S]*?\n {2}\}, \[sessions\]\);/,
      )?.[0] ?? '';
    expect(fn, '应能取到 toggleSelectAll 函数体').not.toBe('');
    expect(fn).toMatch(
      /prev\.size === sessions\.length \? new Set\(\) : new Set\(sessions\.map\(\(s\) => taskIdentity\(s\)\)\)/,
    );
  });

  it('退出选择模式时清空已选集合', () => {
    const fn =
      sessionsRaw.match(
        /const exitSelectMode = useCallback\(\(\) => \{[\s\S]*?\n {2}\}, \[\]\);/,
      )?.[0] ?? '';
    expect(fn, '应能取到 exitSelectMode 函数体').not.toBe('');
    expect(fn).toMatch(/setSelectMode\(false\)/);
    expect(fn).toMatch(/setSelectedKeys\(new Set\(\)\)/);
  });

  it('批量删除：确认后调用 api.clearSessions 并传选中 keys', () => {
    const fn =
      sessionsRaw.match(
        /const handleClearMulti = useCallback\(async \(\) => \{[\s\S]*?\n {2}\}, \[[^\]]*\]\);/,
      )?.[0] ?? '';
    expect(fn, '应能取到 handleClearMulti 函数体').not.toBe('');
    // #438：selectedKeys 存 taskIdentity，但传给后端的必须是 issue_key
    // （后端 clear_sessions 按 issue_key 定位）⇒ 删除前映射并去重。
    expect(fn).toMatch(
      /sessions\.filter\(\(s\) => selectedKeys\.has\(taskIdentity\(s\)\)\)\.map\(\(s\) => s\.issueKey\)/,
    );
    expect(fn).toMatch(/await api\.clearSessions\(keys\)/);
  });

  it('批量删除确认框使用 clearMultiConfirm 并接 handleClearMulti', () => {
    expect(sessionsRaw).toMatch(
      /t\('sessions\.clearMultiConfirm',\s*\{\s*n:\s*selectedKeys\.size\s*\}\)/,
    );
    expect(sessionsRaw).toMatch(/onConfirm=\{\(\) => void handleClearMulti\(\)\}/);
  });

  it('选择模式下隐藏单卡删除按钮（避免与批量删除重复入口）', () => {
    // trash 按钮被 `{!selectMode && (` 包裹
    const block =
      sessionsRaw.match(/\{!selectMode && \([\s\S]*?title=\{t\('sessions\.clear'\)\}/)?.[0] ?? '';
    expect(block, '单卡删除按钮应被 !selectMode 条件包裹').not.toBe('');
  });

  it('选择模式下卡片可点切换选中，并渲染受控复选框', () => {
    // 卡片整卡 onClick 调 toggleSelect（仅 selectMode）
    expect(sessionsRaw).toMatch(
      /onClick=\{\s*selectMode \? \(\) => toggleSelect\(taskIdentity\(task\)\) : undefined\s*\}/,
    );
    // selectable / selected class
    expect(sessionsRaw).toMatch(/session-card\$\{selectMode \? ' selectable' : ''\}/);
    expect(sessionsRaw).toMatch(/isSelected \? ' selected' : ''/);
    // 复选框受控
    expect(sessionsRaw).toMatch(/type="checkbox"/);
    expect(sessionsRaw).toMatch(/checked=\{selectedKeys\.has\(taskIdentity\(task\)\)\}/);
    expect(sessionsRaw).toMatch(/onChange=\{\(\) => toggleSelect\(taskIdentity\(task\)\)\}/);
  });

  it('卡片内功能按钮（打开/复制）阻止事件冒泡，避免误触卡片选中切换', () => {
    // 打开任务按钮 stopPropagation
    expect(sessionsRaw).toMatch(/e\.stopPropagation\(\);\s*handleOpenTask\(task\)/);
  });
});

/**
 * #441 会话面板「打开后永不刷新」回归。
 *
 * 缺陷本体：SessionsPanel 只在挂载时查一次库，此后不订阅任何刷新来源。
 * MCP 是**独立进程直写 SQLite**、发不出 Tauri 事件，于是 agent 开工
 * （record_session）/ 收工（clear_session）后面板毫无反应 —— 用户只能切走
 * 再切回，靠组件重新挂载才看到新数据。
 *
 * 三路刷新缺一不可，逐一断言（任一路被删掉都会失败）：
 *   ① onSynced        —— 本进程触发的同步完成
 *   ② onTasksChanged  —— 本进程 GUI 写入（详情页记会话 / 清会话）
 *   ③ focus / visibilitychange / 20s 轮询 —— MCP 外部写入的唯一兜底
 */
describe('SessionsPanel 打开后保持刷新（#441）', () => {
  it('① 订阅 onSynced 与 onTasksChanged 两路事件', () => {
    expect(sessionsRaw).toMatch(/import \{[^}]*\bonSynced\b[^}]*\} from '\.\.\/api'/);
    expect(sessionsRaw).toMatch(/import \{[^}]*\bonTasksChanged\b[^}]*\} from '\.\.\/api'/);
    expect(sessionsRaw).toMatch(/void onSynced\(refresh\)/);
    expect(sessionsRaw).toMatch(/void onTasksChanged\(refresh\)/);
  });

  it('① 事件订阅的 unlisten 在 cleanup 里释放（否则快速重订阅会双订阅）', () => {
    const effect =
      sessionsRaw.match(
        /useEffect\(\(\) => \{\n {4}const refresh = \(\) => \{[\s\S]*?\n {2}\}, \[loadSessions\]\);/,
      )?.[0] ?? '';
    expect(effect, '应能取到刷新订阅 effect').not.toBe('');
    // listen 返回 Promise<unlisten>，cleanup 不能返回 Promise ⇒ 用 cancelled 标记。
    expect(effect).toMatch(/let cancelled = false/);
    expect(effect).toMatch(/unlistenSynced\?\.\(\)/);
    expect(effect).toMatch(/unlistenTasks\?\.\(\)/);
  });

  it('② 事件回调真正触发重查（不是只订阅不刷新）', () => {
    expect(sessionsRaw).toMatch(
      /const refresh = \(\) => \{\n {6}if \(!document\.hidden\) void loadSessions\(\);/,
    );
    expect(sessionsRaw).toMatch(/const onFocus = \(\) => void loadSessions\(\)/);
    expect(sessionsRaw).toMatch(/window\.addEventListener\('focus', onFocus\)/);
    expect(sessionsRaw).toMatch(/document\.addEventListener\('visibilitychange', refresh\)/);
  });

  it('③ MCP 外部写入靠 20s 轮询兜底，且监听器在 cleanup 中全部移除', () => {
    // 与 App.tsx 的 load() 同频（#181），保证 MCP 直写 SQLite 最迟 20s 内可见。
    expect(sessionsRaw).toMatch(/window\.setInterval\(refresh, 20000\)/);
    // ⚠️ 漏移除 ⇒ 面板反复挂载会累积 N 个定时器与 N 组监听，查询量线性放大。
    expect(sessionsRaw).toMatch(/window\.removeEventListener\('focus', onFocus\)/);
    expect(sessionsRaw).toMatch(/document\.removeEventListener\('visibilitychange', refresh\)/);
    expect(sessionsRaw).toMatch(/window\.clearInterval\(timer\)/);
  });

  it('④ 后台刷新不整块替换成「加载中」占位（否则卡片列表反复闪白）', () => {
    expect(sessionsRaw).toMatch(/if \(loadedOnce\.current\) setRefreshing\(true\)/);
    expect(sessionsRaw).toMatch(/else setLoading\(true\)/);
    expect(sessionsRaw).toMatch(/loadedOnce\.current = true/);
    expect(sessionsRaw).toMatch(
      /<div className="panel-content sessions-content" aria-busy=\{refreshing \|\| undefined\}>/,
    );
  });

  it('⑤ 刷新依赖 loadSessions —— 账号切换后新订阅用的是新闭包，不持有旧 accountId', () => {
    // 依赖写成 [] 会让订阅永久捕获首次渲染的 accountId ⇒ 切账号后面板恒按旧账号查。
    const effect =
      sessionsRaw.match(
        /useEffect\(\(\) => \{\n {4}const refresh = \(\) => \{[\s\S]*?\n {2}\}, \[loadSessions\]\);/,
      )?.[0] ?? '';
    expect(effect, '应能取到刷新订阅 effect').not.toBe('');
    expect(effect).toMatch(/\}, \[loadSessions\]\);$/);
    expect(effect).not.toMatch(/\}, \[\]\);$/);
  });
});

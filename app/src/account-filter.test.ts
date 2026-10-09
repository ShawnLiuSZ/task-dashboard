import { describe, expect, it } from 'vitest';
// 仓库约定（见 panel-wiring.test.ts / styles.test.ts）：vitest 跑在 node 环境，
// 不引入 jsdom / testing-library（§2.5 不引入新依赖），组件交互类回归用 `?raw`
// 读源码做静态断言，锁定「接线是否正确」。
import appRaw from './App.tsx?raw';
import apiRaw from './api.ts?raw';
import sidebarRaw from './components/Sidebar.tsx?raw';
import sessionsRaw from './components/SessionsPanel.tsx?raw';
import commandsRaw from '../src-tauri/src/commands.rs?raw';

/**
 * 账号视图筛选（#422）回归测试。
 *
 * 缺陷：`handleSwitchAccount` 只写 `active_account_id`，**从不重置 `view_mode`**。
 * 而 `accountFilter` 由 `viewMode` 决定：
 *
 * ```ts
 * settings.viewMode === 'all' ? 0 : settings.activeAccountId
 * ```
 *
 * 于是切换账号后 `filterRef.current.accountId` 被刷成 `0`，20s 定时刷新 /
 * 窗口聚焦 / `onSynced` 触发 `load()` → 后端 `rows_to_tasks` 把 `Some(0)` 解析为
 * `None` ⇒ 不加 `account_id` 条件 ⇒ 返回**所有账号**的任务；
 * `loadProjectStatuses` 的聚合分支又逐账号拉取后合并 ⇒ project.status 跨账号混合。
 *
 * 本组测试锁定四处接线：①切换账号必须脱离聚合视图；②`accountFilter` 不得把
 * `activeAccountId <= 0` 当成 0（否则单账号视图静默退化）；③Sidebar 不在聚合
 * 模式下高亮单个账号；④任务会话面板遵守同一套账号语义。
 */
describe('切换账号脱离聚合视图（#422）', () => {
  it('handleSwitchAccount 在 setActiveAccount 之后调用 setViewMode("single")', () => {
    // 顺序敏感：必须先切视图模式，再 loadSettings/loadWith。
    const m = appRaw.match(
      /handleSwitchAccount[\s\S]*?setActiveAccount\(id\)[\s\S]*?setViewMode\('single'\)[\s\S]*?loadSettings\(\)/,
    );
    expect(m).not.toBeNull();
  });

  it('切视图的判断用 settings?.viewMode（不是无条件写）', () => {
    // 无条件写虽幂等，但会多一次 IPC；此处断言保留幂等短路。
    expect(appRaw).toMatch(/settings\?\.viewMode\s*!==\s*'single'/);
  });

  it('handleSwitchView 切回 single 时不把 activeAccountId <= 0 传成 0', () => {
    const m = appRaw.match(/handleSwitchView[\s\S]*?loadWith\(ownership,\s*accountId\)/);
    expect(m).not.toBeNull();
    // 该函数体内不得出现 `?? 0` 这种把空值变聚合的写法。
    const body = m![0];
    expect(body).not.toMatch(/activeAccountId\s*\?\?\s*0/);
    expect(body).toMatch(/activeAccountId\s*>\s*0/);
  });
});

describe('accountFilter 不得静默退化为聚合（#422）', () => {
  it('viewMode==="all" 才返回 0，单账号分支返回 activeAccountId 或 null', () => {
    expect(appRaw).toMatch(/settings\.viewMode\s*===\s*'all'\s*\)\s*return\s*0/);
  });

  it('单账号分支对 activeAccountId 做 > 0 校验，非法值回传 null 而非 0', () => {
    const m = appRaw.match(/const accountFilter[\s\S]*?\n\s*\}, \[settings\]\);/);
    expect(m).not.toBeNull();
    expect(m![0]).toMatch(
      /settings\.activeAccountId\s*>\s*0\s*\?\s*settings\.activeAccountId\s*:\s*null/,
    );
  });

  it('后端 Some(0) 仍是「聚合全部」的语义（前端据此对齐口径）', () => {
    // 若这条变了，前端 accountFilter 的 0/null 编码方式必须同步改；此处作为口径锚点。
    expect(commandsRaw).toMatch(/match account_filter\s*\{[\s\S]*?Some\(0\)\s*=>\s*None/);
  });
});

describe('聚合视图下不高亮单个账号（#422）', () => {
  it('Sidebar 接收 viewMode prop 并有默认值', () => {
    expect(sidebarRaw).toMatch(/viewMode\?:\s*'single'\s*\|\s*'all'/);
    expect(sidebarRaw).toMatch(/viewMode\s*=\s*'single'/);
  });

  it('账号项高亮条件排除聚合视图', () => {
    expect(sidebarRaw).toMatch(
      /showAccountActive\s*=\s*nav\s*===\s*'board'\s*&&\s*viewMode\s*!==\s*'all'/,
    );
    expect(sidebarRaw).toMatch(
      /const active\s*=\s*showAccountActive\s*&&\s*a\.id\s*===\s*activeAccountId/,
    );
  });

  it('App.tsx 把 viewMode 传给 Sidebar', () => {
    expect(appRaw).toMatch(/viewMode=\{settings\?\.viewMode\}/);
  });
});

describe('任务会话面板遵守同一套账号语义（#422）', () => {
  it('api.listActiveSessions 接受 accountId 并传给后端命令', () => {
    expect(apiRaw).toMatch(
      /listActiveSessions:\s*\(accountId\?:\s*number\s*\|\s*null\)[\s\S]*?invoke<Task\[\]>\('list_active_sessions',\s*\{\s*accountId:\s*accountId\s*\?\?\s*null\s*\}\)/,
    );
  });

  it('SessionsPanel 接收 accountId prop 并传入 api 调用', () => {
    expect(sessionsRaw).toMatch(/export default function SessionsPanel\(\{\s*accountId\s*\}/);
    expect(sessionsRaw).toMatch(/api\.listActiveSessions\(accountId\)/);
  });

  it('loadSessions 的依赖含 accountId（切换账号会重查）', () => {
    const m = sessionsRaw.match(
      /const loadSessions = useCallback\([\s\S]*?\n\s*\}, \[([^\]]*)\]\);/,
    );
    expect(m).not.toBeNull();
    expect(m![1]).toMatch(/accountId/);
  });

  it('App.tsx 把 accountFilter 传给 SessionsPanel', () => {
    expect(appRaw).toMatch(/<SessionsPanel accountId=\{accountFilter\}/);
  });

  it('后端 list_active_sessions 按 account_id 过滤，Some(0)⇒聚合', () => {
    const m = commandsRaw.match(/pub fn list_active_sessions\([\s\S]*?\n\}/);
    expect(m).not.toBeNull();
    expect(m![0]).toMatch(/account_id:\s*Option<i64>/);
    expect(m![0]).toMatch(/Some\(0\)\s*=>\s*None/);
    expect(m![0]).toMatch(/t\.account_id\s*==\s*id/);
  });

  it('后端语义与 list_tasks 一致：都把 Some(0) 视作聚合', () => {
    // 两处口径必须一致，否则会出现「列表按账号、会话不按账号」的错位。
    const sessions = commandsRaw.match(/pub fn list_active_sessions\([\s\S]*?\n\}/)![0];
    expect(sessions).toMatch(/Some\(0\)\s*=>\s*None/);
  });
});

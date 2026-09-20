import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { api, onSynced, onTasksChanged, onUpdateAvailable, TASKBOARD_ERROR_EVENT } from './api';
import { taskListSignature } from './utils/taskSig';
import { coalescedLoad, createLoadCoalescer } from './utils/coalescedLoad';
import { countHiddenChanged, snapshotTasks } from './utils/syncHint';
import { fmtTime, I18nProvider, useI18n } from './i18n';
import Board from './components/Board';
import DetailPanel from './components/DetailPanel';
import SettingsPanel from './components/SettingsPanel';
import AboutPanel from './components/AboutPanel';
import AccountsPanel from './components/AccountsPanel';
import SyncLogsPanel from './components/SyncLogsPanel';
import NotesPanel from './components/NotesPanel';
import SessionsPanel from './components/SessionsPanel';
import Sidebar, { type NavKey } from './components/Sidebar';
import AgentPanel from './components/AgentPanel';
import type {
  Account,
  AccountColumn,
  BoardMode,
  ProjectStatus,
  Settings as SettingsT,
  Task,
  ViewMode,
} from './types';

export default function App() {
  return (
    <I18nProvider>
      <BoardApp />
    </I18nProvider>
  );
}
function BoardApp() {
  const { lang, t } = useI18n();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [settings, setSettings] = useState<SettingsT | null>(null);
  // #259：主区视图由左侧 Sidebar 驱动；「关于」保留为互斥弹窗。
  const [nav, setNav] = useState<NavKey>('board');
  const [showAbout, setShowAbout] = useState(false);
  const [ownership, setOwnership] = useState('');
  const [query, setQuery] = useState('');
  const [repo, setRepo] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<string | null>(null);
  const [lastWarning, setLastWarning] = useState<string | null>(null);
  // #265：窗口宽度 < 900px 时侧边栏自动收起为纯图标模式（响应式，不持久化）。
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    typeof window !== 'undefined' ? window.innerWidth < 900 : false,
  );
  // #258：部分失败 warning 与成功结果互斥展示（琥珀色 warn vs 绿色 ok）。
  // #178：上次同步中新变、但被当前筛选藏住的任务数（>0 时给提示+一键清除）。
  const [hiddenAfterSync, setHiddenAfterSync] = useState(0);
  const [projectStatuses, setProjectStatuses] = useState<ProjectStatus[]>([]);
  const [accountColumns, setAccountColumns] = useState<AccountColumn[]>([]);
  // #101：macOS quarantine 清除一次性提示（启动时后端存入 AppState，前端轮询读取后清空）。
  const [quarantineNotice, setQuarantineNotice] = useState<string | null>(null);
  // #276：每日自动检查发现新版本时的弹框提醒。
  const [updateAvailable, setUpdateAvailable] = useState<string | null>(null);

  // v0.3.28+：监听全局错误上报（如 openExternal 失败），统一在错误 banner 显示，
  // 避免无 UI 上下文的异步失败只落在 console 里造成「点了没反应」。
  useEffect(() => {
    const handler = (e: Event) => setError((e as CustomEvent<string>).detail);
    window.addEventListener(TASKBOARD_ERROR_EVENT, handler);
    return () => window.removeEventListener(TASKBOARD_ERROR_EVENT, handler);
  }, []);

  // #101：启动时轮询读取 quarantine 清除消息（一次性，后端读取后自动清空）。
  useEffect(() => {
    void api.getQuarantineNotice().then((msg) => {
      if (msg) setQuarantineNotice(msg);
    });
  }, []);

  // #276：监听每日自动检查发现新版本的提醒。
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void onUpdateAvailable((p) => {
      if (p.version) setUpdateAvailable(p.version);
    }).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, []);

  // 同步结果 / 部分失败 banner 4 秒后自动消失（错误 banner 不受影响，由下次操作覆盖）。
  useEffect(() => {
    if (!lastResult && !lastWarning) return;
    const t = setTimeout(() => {
      setLastResult(null);
      setLastWarning(null);
    }, 4000);
    return () => clearTimeout(t);
  }, [lastResult, lastWarning]);

  // #265：监听窗口尺寸变化，窗口 < 900px 时自动收起侧边栏为纯图标模式。
  // 状态值与上次相同（同为 false / true）时 setState 为 no-op，不会触发多余重渲染，无需手抖防抖。
  useEffect(() => {
    const onResize = () => setSidebarCollapsed(window.innerWidth < 900);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // #258：同步结果分级展示——warning 非空（部分账号/数据源失败）走琥珀色 warn
  // banner，不再混进绿色成功 banner；两者互斥展示。
  const showSyncResult = (base: string, warning: string) => {
    if (warning) {
      setLastResult(null);
      setLastWarning(`${base} · ⚠️ ${warning}`);
    } else {
      setLastWarning(null);
      setLastResult(base);
    }
  };

  // v0.3.16+：根据当前 viewMode + activeAccountId 计算 listTasks 用的 accountId 参数。
  // - 'single' → activeAccountId（单账号视图）
  // - 'all'    → 0（聚合全部账号）
  const accountFilter = useMemo<number | null>(() => {
    if (!settings) return null;
    return settings.viewMode === 'all' ? 0 : settings.activeAccountId;
  }, [settings]);

  // #181：无变化跳过 setState。本地写入不更新 updated_at，
  // 指纹覆盖 status / session / handoff 等字段（见 utils/taskSig）。
  const tasksSig = useRef('');
  const loadCoalescer = useRef(createLoadCoalescer());
  // 最新筛选快照（供定时/事件触发的重查使用，避免闭包过期）。
  const filterRef = useRef({ ownership, accountId: accountFilter });
  useEffect(() => {
    filterRef.current = { ownership, accountId: accountFilter };
  }, [ownership, accountFilter]);
  const applyTasks = useCallback((fresh: Task[]) => {
    const sig = taskListSignature(fresh);
    if (sig === tasksSig.current) return;
    tasksSig.current = sig;
    setTasks(fresh);
  }, []);

  // #221：并发查询合并——忙时记下最新参数，完成后重跑，保证最新请求总被执行。
  // （旧逻辑忙则直接丢弃：切换账号时新筛选请求被旧请求吞掉，看板长期停留旧账号。）
  const loadWith = useCallback(
    (ow: string, af: number | null) =>
      coalescedLoad(loadCoalescer.current, { ownership: ow, accountId: af }, async (a) => {
        try {
          applyTasks(await api.listTasks(a.ownership || undefined, a.accountId));
          setError(null);
        } catch (e) {
          setError(String(e));
        }
      }),
    [applyTasks],
  );

  const load = useCallback(() => {
    const f = filterRef.current;
    return loadWith(f.ownership, f.accountId);
  }, [loadWith]);

  const loadSettings = useCallback(async () => {
    try {
      setSettings(await api.getSettings());
    } catch (e) {
      setError(String(e));
    }
  }, []);

  // #285：可显式传入 settings 快照。同步会刷新 settings（activeAccountId /
  // viewMode 变更），doSync 里 await 后闭包内的 settings 还是旧值，必须显式传。
  const loadProjectStatuses = useCallback(
    async (s: SettingsT | null = settings) => {
      try {
        if (!s) return;
        const activeId = s.activeAccountId;
        if (!activeId) return;

        // viewMode="all" 时聚合所有账号的 project_statuses，按字母序合并去重
        // （聚合视图下每个账号可能属于不同项目，无法用单一 order_index）
        // v0.3.49 (#145)：并行拉取 + 单账号失败隔离（该账号列缺失不断整板）。
        if (s.viewMode === 'all') {
          const accounts = s.accounts ?? [];
          const results = await Promise.all(
            accounts
              .filter((a) => a.id)
              .map((a) =>
                api.listProjectStatuses(a.id).catch((e) => {
                  console.warn(`加载账号 @${a.login} 的项目状态失败:`, e);
                  return [] as ProjectStatus[];
                }),
              ),
          );
          const merged = new Map<string, ProjectStatus>();
          for (const list of results) {
            for (const ps of list) {
              // 去重：同名状态只保留第一个（按首次出现顺序）
              if (!merged.has(ps.name)) merged.set(ps.name, ps);
            }
          }
          setProjectStatuses([...merged.values()].sort((a, b) => a.name.localeCompare(b.name)));
          return;
        }

        // 单账号视图：取条目数最多的项目（主项目）的状态，按 order_index 排序
        const all = await api.listProjectStatuses(activeId);
        const byProject = new Map<string, typeof all>();
        for (const ps of all) {
          const arr = byProject.get(ps.projectGithubId) ?? [];
          arr.push(ps);
          byProject.set(ps.projectGithubId, arr);
        }
        let best: typeof all = [];
        for (const arr of byProject.values()) {
          if (arr.length > best.length) best = arr;
        }
        // 确保按 order_index 正序（后端已按此排序，但重新过滤后可能丢失）
        best.sort((a, b) => a.orderIndex - b.orderIndex);
        setProjectStatuses(best);
      } catch (e) {
        // 项目状态决定看板列，失败必须可见，否则列静默缺失用户无从判断。
        console.warn('加载项目状态选项失败:', e);
        setError(String(e));
      }
    },
    [settings],
  );

  // v0.3.28+：加载自定义列配置。#285：同 loadProjectStatuses，可显式传 settings。
  const loadAccountColumns = useCallback(
    async (s: SettingsT | null = settings) => {
      try {
        if (!s) return;
        const activeId = s.activeAccountId;
        if (!activeId) {
          setAccountColumns([]);
          return;
        }

        if (s.viewMode === 'all') {
          // 聚合视图：合并所有账号的自定义列（按 col_key 去重）
          // v0.3.49 (#145)：并行拉取 + 单账号失败隔离。
          const accounts = (s.accounts ?? []).filter((a) => a.id);
          const results = await Promise.all(
            accounts.map((a) =>
              api.listAccountColumns(a.id).catch((e) => {
                console.warn(`加载账号 @${a.login} 的自定义列失败:`, e);
                return [] as AccountColumn[];
              }),
            ),
          );
          const merged = new Map<string, AccountColumn>();
          for (const list of results) {
            for (const col of list) {
              if (!merged.has(col.colKey)) merged.set(col.colKey, col);
            }
          }
          setAccountColumns([...merged.values()].sort((a, b) => a.orderIndex - b.orderIndex));
          return;
        }

        // 单账号视图
        const cols = await api.listAccountColumns(activeId);
        setAccountColumns(cols.sort((a, b) => a.orderIndex - b.orderIndex));
      } catch (e) {
        console.warn('加载自定义列配置失败:', e);
        // 同上：自定义列缺失会让看板列不完整，失败需可见。
        setError(String(e));
      }
    },
    [settings],
  );

  useEffect(() => {
    void load();
    void loadSettings();
    // onSynced 返回 Promise<unlisten>：cleanup 不能返回 Promise，否则 React
    // 无法等待，快速重订阅时会短暂双订阅。用 cancelled + 变量持有解决。
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    void onSynced((r) => {
      void load();
      void loadSettings();
      // loadProjectStatuses 依赖 settings，下面的 useEffect 会在 settings 变化时自动触发
      const prune = r.pruned > 0 ? ` · ${t('sync.pruned', { n: r.pruned })}` : '';
      const scope =
        r.accountsSynced > 1 ? ` · ${t('sync.accountsSynced', { n: r.accountsSynced })}` : '';
      showSyncResult(
        `${t('sync.result', { added: r.added, updated: r.updated, done: r.candidateDone })}${scope}${prune}`,
        r.warning,
      );
    }).then((f) => {
      if (cancelled) {
        f();
        return;
      }
      unlisten = f;
    });
    // #181：App 内写入（他窗口的详情页改状态等）即时跟进，无变化时 load 内部跳过。
    let unlistenTasks: (() => void) | null = null;
    void onTasksChanged(() => {
      void load();
    }).then((f) => {
      if (cancelled) {
        f();
        return;
      }
      unlistenTasks = f;
    });
    return () => {
      cancelled = true;
      unlisten?.();
      unlistenTasks?.();
    };
  }, [load, loadSettings, t]);

  // #181：外部写入（MCP 独立进程直写 SQLite，发不出事件）靠这个跟进：
  // 窗口聚焦 / 可见性恢复即时重查 + 20s 轮询兜底；后台隐藏时跳过，不占资源。
  useEffect(() => {
    const refresh = () => {
      if (!document.hidden) void load();
    };
    const onFocus = () => void load();
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', refresh);
    const timer = window.setInterval(refresh, 20000);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', refresh);
      window.clearInterval(timer);
    };
  }, [load]);

  // settings 就绪（activeAccountId / viewMode / accounts 任一变化）后拉取项目 Status 选项和自定义列
  useEffect(() => {
    if (!settings) return;
    void loadProjectStatuses();
    void loadAccountColumns();
  }, [settings, loadProjectStatuses, loadAccountColumns]);

  // 仓库列表（去重排序），用于仓库筛选下拉。
  const repos = useMemo(() => [...new Set(tasks.map((t) => t.repo))].sort(), [tasks]);

  // v0.3.16+：账号 id → Account 的映射，传给 Board 在卡片上显示账号徽章。
  const accountMap = useMemo(() => {
    const m = new Map<number, Account>();
    for (const a of settings?.accounts ?? []) {
      m.set(a.id, a);
    }
    return m;
  }, [settings]);

  // v0.3.43+：看板列展示方式为「每账号」配置。单账号视图取激活账号的 boardMode；
  // 聚合视图（暂隐藏，未配置按账号展开）与账号缺失时回退到 project（默认）。
  const boardMode = useMemo<BoardMode>(() => {
    if (!settings) return 'project';
    if (settings.viewMode === 'all') return 'project';
    return accountMap.get(settings.activeAccountId)?.boardMode ?? 'project';
  }, [settings, accountMap]);

  // 前端实时过滤：归属由后端 list_tasks 已筛；此处叠加 仓库 + 关键词（仓库/编号/标题）。
  // v0.3.49 (#145)：搜索输入经 useDeferredValue 防抖，快速按键不再每键全板重排。
  const deferredQuery = useDeferredValue(query);
  const visible = useMemo(() => {
    const q = deferredQuery.trim().toLowerCase();
    return tasks.filter((t) => {
      if (repo && t.repo !== repo) return false;
      if (!q) return true;
      const hay = `${t.repo}#${t.number} ${t.title}`.toLowerCase();
      return hay.includes(q);
    });
  }, [tasks, repo, deferredQuery]);

  const doSync = async () => {
    setSyncing(true);
    setError(null);
    setHiddenAfterSync(0);
    // #285：点击瞬间快照筛选。同步会刷新 settings（activeAccountId / viewMode），
    // ownership / accountFilter 靠渲染周期传播，同步返回后再读闭包值是过期的。
    const ow = ownership;
    const af = accountFilter;
    // #178：同步前快照。归属筛选是后端维度——生效时用无归属全量做 diff 基准，
    // 否则后端筛掉的旧任务会被误判为“新增”。
    const beforePool = ow ? await api.listTasks(undefined, af).catch(() => tasks) : tasks;
    const before = snapshotTasks(beforePool);
    try {
      const r = await api.syncNow();
      const prune = r.pruned > 0 ? ` · ${t('sync.pruned', { n: r.pruned })}` : '';
      const scope =
        r.accountsSynced > 1 ? ` · ${t('sync.accountsSynced', { n: r.accountsSynced })}` : '';
      showSyncResult(
        `${t('sync.result', { added: r.added, updated: r.updated, done: r.candidateDone })}${scope}${prune}`,
        r.warning,
      );
      // #285：同步会先清空、再按 GraphQL 结果重写该账号的 project_statuses
      // （sync.rs::clear_project_statuses → upsert_project_statuses）。项目状态列
      // 可能整体换掉，沿用旧列渲染就会让新状态的任务落到任何列之外——
      // 表现为「同步后看板为空、重启恢复」（重启会重拉列）。
      const freshSettings = await api.getSettings().catch(() => settings);
      setSettings(freshSettings);
      await Promise.all([loadProjectStatuses(freshSettings), loadAccountColumns(freshSettings)]);
      // #19：刷新走合并器，不直连 listTasks + applyTasks——onSynced 事件会并发
      // 触发 load()，直连写 state 可能被并发的 coalesced load 覆盖回旧数据。
      await loadWith(ow, af);
      // #178：被新筛选隐藏的数量（diff 基准恒为无归属全量）。
      const pool = await api.listTasks(undefined, af).catch(() => []);
      setHiddenAfterSync(
        pool.length ? countHiddenChanged(before, pool, { repo, query, ownership: ow }) : 0,
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setSyncing(false);
    }
  };

  // #178：一键清除全部筛选（含后端归属维度，需重查；旧工具栏重置漏了这步）。
  const clearAllFilters = useCallback(async () => {
    setQuery('');
    setRepo('');
    setOwnership('');
    setHiddenAfterSync(0);
    try {
      applyTasks(await api.listTasks(undefined, accountFilter));
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, [accountFilter]);

  // 筛选被手动改动后，同步提示即过期（用户正在自行处理）。
  useEffect(() => {
    setHiddenAfterSync(0);
  }, [query, repo, ownership]);

  // v0.3.16+：切换激活账号（单账号视图）。#259：同时切回看板视图。
  // #286：切换账号时重置搜索与仓库筛选——搜索词在新账号下无匹配会导致看板为空。
  const handleSwitchAccount = async (id: number) => {
    setError(null);
    setNav('board');
    setQuery('');
    setRepo('');
    setHiddenAfterSync(0);
    try {
      await api.setActiveAccount(id);
      await loadSettings();
      // #221：显式传新账号 id——闭包里的 accountFilter 还是旧值，靠它会查出旧账号。
      await loadWith(ownership, id);
    } catch (e) {
      setError(String(e));
    }
  };

  // #262：切换前端「展示视图模式」（单账号 / 全部账号聚合）。仅影响展示范围，
  // 不决定同步范围——同步恒覆盖全部账号（见 sync.rs::run）。撤回 597840b 删掉的 UI 入口，
  // 让 set_view_mode 命令与残留 i18n key 重新接回 UI（消除「有实现、无入口」死代码）。
  const handleSwitchView = async (mode: ViewMode) => {
    setError(null);
    try {
      await api.setViewMode(mode);
      await loadSettings();
      // M3：显式传新 accountFilter——filterRef 由被动 effect 刷新，
      // await loadSettings() 后仍可能读到旧值（与 handleSwitchAccount 同款修复）。
      const accountId = mode === 'all' ? 0 : (settings?.activeAccountId ?? 0);
      await loadWith(ownership, accountId);
    } catch (e) {
      setError(String(e));
    }
  };

  const selectedTask = useMemo(
    () => tasks.find((t) => t.issueKey === selected) ?? null,
    [tasks, selected],
  );

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-left">
          {/* #259：品牌 + 当前视图条数；账号切换移到左侧 Sidebar。 */}
          <span className="app-title">{t('app.title')}</span>
          <span className="muted">{t('topbar.totalCount', { n: visible.length })}</span>
        </div>

        <div className="topbar-right">
          <span className="muted small">
            {t('topbar.lastSync', { time: fmtTime(settings?.lastSyncAt ?? 0, lang) })}
          </span>
          {/* #262：展示视图模式切换（单账号 / 全部账号聚合）。仅影响展示，不决定同步范围。 */}
          <select
            className="select"
            value={settings?.viewMode ?? 'single'}
            onChange={(e) => void handleSwitchView(e.target.value as ViewMode)}
            title={t('topbar.viewModeTitle')}
          >
            <option value="single">{t('topbar.singleAccount')}</option>
            <option value="all">{t('topbar.allAccounts')}</option>
          </select>
          <button
            className="btn primary"
            onClick={doSync}
            disabled={syncing}
            title={syncing ? t('btn.syncing') : t('btn.syncNow')}
          >
            <svg
              className="btn-icon"
              viewBox="0 0 24 24"
              width="16"
              height="16"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M21 12a9 9 0 1 1-2.64-6.36" />
              <path d="M21 3v6h-6" />
            </svg>
            <span className="btn-label">{syncing ? t('btn.syncing') : t('btn.syncNow')}</span>
          </button>
        </div>
      </header>

      {(error || lastResult || lastWarning || quarantineNotice) && (
        <div className="banner-row">
          {error && <div className="banner error">{error}</div>}
          {!error && quarantineNotice && (
            <div className="banner warn" onClick={() => setQuarantineNotice(null)}>
              {quarantineNotice}
            </div>
          )}
          {!error && !quarantineNotice && lastWarning && (
            <div className="banner warn">{lastWarning}</div>
          )}
          {!error && !quarantineNotice && !lastWarning && lastResult && (
            <div className="banner ok">{lastResult}</div>
          )}
        </div>
      )}
      {!error && hiddenAfterSync > 0 && (query || repo || ownership) && (
        <div className="banner-row">
          <div className="banner warn">
            {t('sync.filterHidesNew', { n: hiddenAfterSync })}{' '}
            <button className="btn ghost small" onClick={() => void clearAllFilters()}>
              {t('btn.reset')}
            </button>
          </div>
        </div>
      )}

      <div className="app-shell">
        <Sidebar
          accounts={settings?.accounts ?? []}
          activeAccountId={settings?.activeAccountId ?? null}
          nav={nav}
          collapsed={sidebarCollapsed}
          onNavigate={setNav}
          onSwitchAccount={(id) => void handleSwitchAccount(id)}
          onAddAccount={() => setNav('accounts')}
          onAbout={() => setShowAbout(true)}
        />
        <main className="main-content">
          {nav === 'board' && (
            <>
              <div className="toolbar">
                <input
                  className="input"
                  placeholder={t('search.placeholder')}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
                <select
                  className="select"
                  value={repo}
                  onChange={(e) => setRepo(e.target.value)}
                  title={t('filter.byRepo')}
                >
                  <option value="">{t('filter.allRepos')}</option>
                  {repos.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
                <select
                  className="select"
                  value={ownership}
                  onChange={(e) => {
                    // #221：load 已稳定化（不再随筛选变身份），归属变化需显式重查。
                    const v = e.target.value;
                    setOwnership(v);
                    void loadWith(v, accountFilter);
                  }}
                  title={t('filter.byOwnership')}
                >
                  <option value="">{t('filter.allOwnership')}</option>
                  <option value="assigned">{t('ownership.assigned')}</option>
                  <option value="notassignee">{t('ownership.notassignee')}</option>
                  <option value="assigned-others">{t('ownership.assigned-others')}</option>
                  <option value="my-created">{t('filter.myCreated')}</option>
                </select>
                {(query || repo || ownership) && (
                  <button
                    className="btn ghost"
                    onClick={() => {
                      void clearAllFilters();
                    }}
                    title={t('filter.clear')}
                  >
                    {t('btn.reset')}
                  </button>
                )}
              </div>
              <div className="board-wrap">
                <Board
                  tasks={visible}
                  selected={selected}
                  onSelect={setSelected}
                  boardMode={boardMode}
                  projectStatuses={projectStatuses}
                  accountColumns={accountColumns}
                />
              </div>
            </>
          )}
          {nav === 'notes' && (
            <div className="notes-page">
              <NotesPanel />
            </div>
          )}
          {nav === 'sessions' && <SessionsPanel />}
          {nav === 'settings' && settings && (
            <div className="panel-page">
              <SettingsPanel
                settings={settings}
                onSaved={(s) => {
                  setSettings(s);
                  void load();
                }}
                onClose={() => {
                  setNav('board');
                  // v0.3.43+：展示方式在设置面板按账号修改，关闭后重载 settings 使看板即时生效。
                  void loadSettings();
                }}
              />
            </div>
          )}
          {nav === 'agents' && <AgentPanel onClose={() => setNav('board')} />}
          {nav === 'synclogs' && (
            <div className="panel-page">
              <SyncLogsPanel onClose={() => setNav('board')} />
            </div>
          )}
          {nav === 'accounts' && settings && (
            <div className="panel-page">
              <AccountsPanel
                settings={settings}
                onClose={() => setNav('board')}
                onAccountsChanged={() => {
                  void loadSettings();
                }}
              />
            </div>
          )}
        </main>
      </div>

      {selectedTask && (
        <>
          <div
            className="detail-backdrop"
            onClick={() => setSelected(null)}
            title={t('detail.clickBackdropClose')}
          />
          <DetailPanel
            key={selectedTask.issueKey}
            task={selectedTask}
            projectStatuses={projectStatuses}
            onClose={() => setSelected(null)}
            onChanged={() => {
              void load();
            }}
          />
        </>
      )}

      {showAbout && <AboutPanel onClose={() => setShowAbout(false)} />}

      {/* #276：每日自动检查发现新版本的弹框提醒 */}
      {updateAvailable && (
        <div className="modal-mask" onClick={() => setUpdateAvailable(null)}>
          <div
            className="modal"
            style={{ maxWidth: 420 }}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setUpdateAvailable(null);
            }}
          >
            <h3 className="modal-title">{t('about.updateAvailableTitle')}</h3>
            <p className="muted" style={{ margin: '12px 0' }}>
              {t('about.updateAvailableMsg', { version: updateAvailable })}
            </p>
            <div className="modal-actions">
              <button className="btn" onClick={() => setUpdateAvailable(null)}>
                {t('about.updateLater')}
              </button>
              <button
                className="btn primary"
                onClick={async () => {
                  setUpdateAvailable(null);
                  try {
                    await api.installAppUpdate();
                    await api.restartApp();
                  } catch (e) {
                    setError(String(e));
                  }
                }}
              >
                {t('about.updateNow')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

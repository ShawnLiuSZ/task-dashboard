import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { api, onSynced, onTasksChanged, TASKBOARD_ERROR_EVENT } from "./api";
import { taskListSignature } from "./utils/taskSig";
import { countHiddenChanged, snapshotTasks } from "./utils/syncHint";
import { fmtTime, I18nProvider, useI18n } from "./i18n";
import Board from "./components/Board";
import DetailPanel from "./components/DetailPanel";
import SettingsPanel from "./components/SettingsPanel";
import AboutPanel from "./components/AboutPanel";
import AccountsPanel from "./components/AccountsPanel";
import SyncLogsPanel from "./components/SyncLogsPanel";
import NotesPanel from "./components/NotesPanel";
import type { Account, AccountColumn, BoardMode, ProjectStatus, Settings as SettingsT, Task } from "./types";

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
  // 互斥弹窗状态：同一时刻仅显示一个（设置/关于/账号/同步日志）。
  const [activeModal, setActiveModal] = useState<"settings" | "about" | "accounts" | "synclogs" | null>(null);
  const [ownership, setOwnership] = useState("");
  const [query, setQuery] = useState("");
  const [repo, setRepo] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<string | null>(null);
  // #178：上次同步中新变、但被当前筛选藏住的任务数（>0 时给提示+一键清除）。
  const [hiddenAfterSync, setHiddenAfterSync] = useState(0);
  const [projectStatuses, setProjectStatuses] = useState<ProjectStatus[]>([]);
  const [accountColumns, setAccountColumns] = useState<AccountColumn[]>([]);

  // v0.3.28+：监听全局错误上报（如 openExternal 失败），统一在错误 banner 显示，
  // 避免无 UI 上下文的异步失败只落在 console 里造成「点了没反应」。
  useEffect(() => {
    const handler = (e: Event) => setError((e as CustomEvent<string>).detail);
    window.addEventListener(TASKBOARD_ERROR_EVENT, handler);
    return () => window.removeEventListener(TASKBOARD_ERROR_EVENT, handler);
  }, []);

  // 同步结果 banner 4 秒后自动消失（错误 banner 不受影响，由下次操作覆盖）。
  useEffect(() => {
    if (!lastResult) return;
    const t = setTimeout(() => setLastResult(null), 4000);
    return () => clearTimeout(t);
  }, [lastResult]);

  // v0.3.16+：根据当前 viewMode + activeAccountId 计算 listTasks 用的 accountId 参数。
  // - 'single' → activeAccountId（单账号视图）
  // - 'all'    → 0（聚合全部账号）
  const accountFilter = useMemo<number | null>(() => {
    if (!settings) return null;
    return settings.viewMode === "all" ? 0 : settings.activeAccountId;
  }, [settings]);

  // #181：无变化跳过 setState。本地写入不更新 updated_at，
  // 指纹覆盖 status / session / handoff 等字段（见 utils/taskSig）。
  const tasksSig = useRef("");
  const loadingRef = useRef(false);
  const applyTasks = useCallback((fresh: Task[]) => {
    const sig = taskListSignature(fresh);
    if (sig === tasksSig.current) return;
    tasksSig.current = sig;
    setTasks(fresh);
  }, []);

  const load = useCallback(async () => {
    // #181：轮询/聚焦/多事件并发时防重入（本地 SQLite 查询快，跳过一次无影响）。
    if (loadingRef.current) return;
    loadingRef.current = true;
    try {
      applyTasks(await api.listTasks(ownership || undefined, accountFilter));
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      loadingRef.current = false;
    }
  }, [ownership, accountFilter, applyTasks]);

  const loadSettings = useCallback(async () => {
    try {
      setSettings(await api.getSettings());
    } catch (e) {
      setError(String(e));
    }
  }, []);

  const loadProjectStatuses = useCallback(async () => {
    try {
      if (!settings) return;
      const activeId = settings.activeAccountId;
      if (!activeId) return;

      // viewMode="all" 时聚合所有账号的 project_statuses，按字母序合并去重
      // （聚合视图下每个账号可能属于不同项目，无法用单一 order_index）
      // v0.3.49 (#145)：并行拉取 + 单账号失败隔离（该账号列缺失不断整板）。
      if (settings.viewMode === "all") {
        const accounts = settings.accounts ?? [];
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
      console.warn("加载项目状态选项失败:", e);
      setError(String(e));
    }
  }, [settings]);

  // v0.3.28+：加载自定义列配置
  const loadAccountColumns = useCallback(async () => {
    try {
      if (!settings) return;
      const activeId = settings.activeAccountId;
      if (!activeId) {
        setAccountColumns([]);
        return;
      }

      if (settings.viewMode === "all") {
        // 聚合视图：合并所有账号的自定义列（按 col_key 去重）
        // v0.3.49 (#145)：并行拉取 + 单账号失败隔离。
        const accounts = (settings.accounts ?? []).filter((a) => a.id);
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
      console.warn("加载自定义列配置失败:", e);
      // 同上：自定义列缺失会让看板列不完整，失败需可见。
      setError(String(e));
    }
  }, [settings]);

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
      const warn = r.warning ? ` · ⚠️ ${r.warning}` : "";
      const prune = r.pruned > 0 ? ` · ${t("sync.pruned", { n: r.pruned })}` : "";
      setLastResult(
        `${t("sync.result", { added: r.added, updated: r.updated, done: r.candidateDone })}${prune}${warn}`,
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
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", refresh);
    const timer = window.setInterval(refresh, 20000);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", refresh);
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
  const repos = useMemo(
    () => [...new Set(tasks.map((t) => t.repo))].sort(),
    [tasks],
  );

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
    if (!settings) return "project";
    if (settings.viewMode === "all") return "project";
    return accountMap.get(settings.activeAccountId)?.boardMode ?? "project";
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
    // #178：同步前快照。归属筛选是后端维度——生效时用无归属全量做 diff 基准，
    // 否则后端筛掉的旧任务会被误判为“新增”。
    const needPool = Boolean(ownership);
    const beforePool = needPool
      ? await api.listTasks(undefined, accountFilter).catch(() => tasks)
      : tasks;
    const before = snapshotTasks(beforePool);
    try {
      const r = await api.syncNow();
      const warn = r.warning ? ` · ⚠️ ${r.warning}` : "";
      const prune = r.pruned > 0 ? ` · ${t("sync.pruned", { n: r.pruned })}` : "";
      setLastResult(
        `${t("sync.result", { added: r.added, updated: r.updated, done: r.candidateDone })}${prune}${warn}`,
      );
      const fresh = await api.listTasks(ownership || undefined, accountFilter);
      applyTasks(fresh);
      await loadSettings();
      const pool = needPool
        ? await api.listTasks(undefined, accountFilter).catch(() => fresh)
        : fresh;
      setHiddenAfterSync(countHiddenChanged(before, pool, { repo, query, ownership }));
    } catch (e) {
      setError(String(e));
    } finally {
      setSyncing(false);
    }
  };

  // #178：一键清除全部筛选（含后端归属维度，需重查；旧工具栏重置漏了这步）。
  const clearAllFilters = useCallback(async () => {
    setQuery("");
    setRepo("");
    setOwnership("");
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, repo, ownership]);

  // v0.3.16+：切换激活账号（单账号视图）。
  const handleSwitchAccount = async (id: number) => {
    setError(null);
    try {
      await api.setActiveAccount(id);
      // v0.3.49 (#145)：两路加载无依赖，并行。
      await Promise.all([loadSettings(), load()]);
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
          {/* v0.3.16+：账号下拉。v0.3.x：暂隐藏「全部账号」视图模式，
              待 project status map 功能落地后再恢复。 */}
          <select
            className="select"
            value={settings?.activeAccountId ?? 0}
            onChange={(e) => void handleSwitchAccount(Number(e.target.value))}
            title={
              settings?.viewMode === "all"
                ? t("topbar.switchAccountAll")
                : t("topbar.switchAccount")
            }
            disabled={settings?.viewMode === "all"}
          >
            {(settings?.accounts ?? []).length === 0 && (
              <option value={0}>{t("topbar.noAccounts")}</option>
            )}
            {(settings?.accounts ?? []).map((a) => (
              <option key={a.id} value={a.id}>
                @{a.login}
                {a.org ? ` (${a.org})` : ""}
              </option>
            ))}
          </select>
          <span className="muted">
            {t("topbar.totalCount", { n: visible.length })}
          </span>
        </div>

        <div className="topbar-right">
          <span className="muted small">
            {t("topbar.lastSync", { time: fmtTime(settings?.lastSyncAt ?? 0, lang) })}
          </span>
<button className="btn" onClick={() => setActiveModal(activeModal === "about" ? null : "about")} title={t("btn.about")}>
            <svg className="btn-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>
            <span className="btn-label">{t("btn.about")}</span>
          </button>
          <button className="btn" onClick={() => setActiveModal(activeModal === "settings" ? null : "settings")} title={t("btn.settings")}>
            <svg className="btn-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"/></svg>
            <span className="btn-label">{t("btn.settings")}</span>
          </button>
          <button className="btn" onClick={() => setActiveModal(activeModal === "accounts" ? null : "accounts")} title={t("btn.accounts")}>
            <svg className="btn-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
            <span className="btn-label">{t("btn.accounts")}</span>
          </button>
          <button className="btn" onClick={() => setActiveModal(activeModal === "synclogs" ? null : "synclogs")} title={t("syncLogs.title")}>
            <svg className="btn-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/><path d="M16 13H8"/><path d="M16 17H8"/><path d="M10 9H8"/></svg>
            <span className="btn-label">{t("syncLogs.title")}</span>
          </button>
          <button className="btn primary" onClick={doSync} disabled={syncing} title={syncing ? t("btn.syncing") : t("btn.syncNow")}>
            <svg className="btn-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>
            <span className="btn-label">{syncing ? t("btn.syncing") : t("btn.syncNow")}</span>
          </button>
        </div>
      </header>

      <div className="toolbar">
        <input
          className="input"
          placeholder={t("search.placeholder")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select
          className="select"
          value={repo}
          onChange={(e) => setRepo(e.target.value)}
          title={t("filter.byRepo")}
        >
          <option value="">{t("filter.allRepos")}</option>
          {repos.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
        <select
          className="select"
          value={ownership}
          onChange={(e) => setOwnership(e.target.value)}
          title={t("filter.byOwnership")}
        >
          <option value="">{t("filter.allOwnership")}</option>
          <option value="assigned">{t("ownership.assigned")}</option>
          <option value="notassignee">{t("ownership.notassignee")}</option>
          <option value="assigned-others">{t("ownership.assigned-others")}</option>
        </select>
        {(query || repo || ownership) && (
          <button
            className="btn ghost"
            onClick={() => {
              void clearAllFilters();
            }}
            title={t("filter.clear")}
          >
            {t("btn.reset")}
          </button>
        )}

        {/* v0.3.43+：看板列展示方式已改为「每账号」在设置面板配置，此处不再提供切换下拉。 */}

      </div>

      {(error || lastResult) && (
        <div className="banner-row">
          {error && <div className="banner error">{error}</div>}
          {!error && lastResult && <div className="banner ok">{lastResult}</div>}
        </div>
      )}
      {!error && hiddenAfterSync > 0 && (query || repo || ownership) && (
        <div className="banner-row">
          <div className="banner warn">
            {t("sync.filterHidesNew", { n: hiddenAfterSync })}{" "}
            <button className="btn ghost small" onClick={() => void clearAllFilters()}>
              {t("btn.reset")}
            </button>
          </div>
        </div>
      )}

      <div className="main-layout">
        <NotesPanel />
        <div className="board-wrap">
          <Board
            tasks={visible}
            selected={selected}
            onSelect={setSelected}
            accounts={accountMap}
            boardMode={boardMode}
            projectStatuses={projectStatuses}
            accountColumns={accountColumns}
          />
        </div>
      </div>

      {selectedTask && (
        <>
          <div
            className="detail-backdrop"
            onClick={() => setSelected(null)}
            title={t("detail.clickBackdropClose")}
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

      {activeModal === "settings" && settings && (
        <SettingsPanel
          settings={settings}
          onSaved={(s) => {
            setSettings(s);
            setActiveModal(null);
            void load();
          }}
          onClose={() => {
            setActiveModal(null);
            // v0.3.43+：展示方式在设置面板按账号修改，关闭后重载 settings 使看板即时生效。
            void loadSettings();
          }}
        />
      )}

      {activeModal === "accounts" && settings && (
        <AccountsPanel
          settings={settings}
          onClose={() => setActiveModal(null)}
          onAccountsChanged={() => {
            void loadSettings();
          }}
        />
      )}

{activeModal === "about" && (
        <AboutPanel
          onClose={() => setActiveModal(null)}
        />
      )}

      {activeModal === "synclogs" && (
        <SyncLogsPanel
          onClose={() => setActiveModal(null)}
        />
      )}
    </div>
  );
}

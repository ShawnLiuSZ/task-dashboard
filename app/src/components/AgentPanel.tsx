import { useCallback, useEffect, useMemo, useState } from 'react';
import { buildMcpSnippet } from './AboutPanel';
import { api } from '../api';
import { AGENTS, HOOK_SUPPORTED_AGENTS, MANUAL_PATH_HINTS, agentLabel } from '../agents';
import {
  deviceDetail,
  deviceStateOf,
  groupOf,
  GROUP_ORDER,
  type DeviceState,
} from '../agent-groups';
import type { AgentScanResult } from '../types';
import { useT } from '../i18n';

interface Props {
  onClose: () => void;
}

/* ---------- 图标（内联 SVG，与 Sidebar 风格一致） ---------- */

function Icon({ d, size = 15 }: { d: string; size?: number }) {
  return (
    <svg
      className="sidebar-icon"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={d} />
    </svg>
  );
}

const ICON = {
  plug: 'M9 2v6 M15 2v6 M5 8h14v4a7 7 0 0 1-14 0z M12 19v3',
  tools:
    'M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z',
  guide:
    'M4 19.5A2.5 2.5 0 0 1 6.5 17H20 V4H6.5A2.5 2.5 0 0 0 4 6.5z M4 19.5A2.5 2.5 0 0 0 6.5 22H20 V8',
};

/* ---------- 工具表数据（与 mcp_server/AGENT_INSTRUCTIONS.md §1 保持一致） ---------- */

const TOOLS: { name: string; params: string; key: string }[] = [
  { name: 'list_my_tasks', params: 'status? / ownership?', key: 'list' },
  { name: 'get_task_status', params: 'issue', key: 'get' },
  { name: 'update_task_status', params: 'issue, status', key: 'update' },
  { name: 'record_session', params: 'issue, session_id, agent?, branch?', key: 'session' },
  { name: 'record_handoff', params: 'issue, text', key: 'handoff' },
  { name: 'clear_session', params: 'issue', key: 'clear' },
];

/* ---------- 触发时机 → 动作（与 mcp_server/AGENT_INSTRUCTIONS.md §2 保持一致） ---------- */

const TRIGGERS: { when: string; action: string }[] = [
  { when: 'start', action: 'start' },
  { when: 'interrupt', action: 'interrupt' },
  { when: 'handoff', action: 'handoff' },
  { when: 'done', action: 'done' },
];

/** #263：设备状态 → i18n key（徽标文案）。 */
const DEVICE_LABEL_KEY: Record<DeviceState, string> = {
  cli: 'settings.hooks.device.cli',
  app: 'settings.hooks.device.app',
  'config-only': 'settings.hooks.device.configOnly',
  none: 'settings.hooks.device.none',
  'suspected-removed': 'settings.hooks.device.suspectedRemoved',
};

/** 扫描时间的 HH:MM（本地时区）。 */
function clockOf(secs: number): string {
  const d = new Date(secs * 1000);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

type AgentTab = 'hooks' | 'mcp';

export default function AgentPanel({ onClose }: Props) {
  const t = useT();
  const [tab, setTab] = useState<AgentTab>('hooks');

  /* ---------- #177：agent 看板 hooks（从 SettingsPanel 搬过来） ---------- */
  type HooksScope = 'project' | 'global';
  interface AgentStatus {
    agent: string;
    installed: boolean;
    hooksOk: boolean;
    commandsOk: boolean;
    settingsOk: boolean;
    hostPresent: boolean;
  }
  const [hooksScope, setHooksScope] = useState<HooksScope>('global');
  const [targetDir, setTargetDir] = useState('');
  const [hooksBusy, setHooksBusy] = useState(false);
  const [hooksMsg, setHooksMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [hooksNotices, setHooksNotices] = useState<string[]>([]);
  const [hooksStatus, setHooksStatus] = useState<AgentStatus[] | null>(null);
  // #263：设备扫描结果（本机装了哪些 agent / 哪些已卸载），与 hooks 状态独立获取。
  const [scan, setScan] = useState<AgentScanResult | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>(() => {
    try {
      const raw = localStorage.getItem('agents.hooks.groupsCollapsed');
      return raw ? (JSON.parse(raw) as Record<string, boolean>) : {};
    } catch {
      return {};
    }
  });
  useEffect(() => {
    localStorage.setItem('agents.hooks.groupsCollapsed', JSON.stringify(collapsedGroups));
  }, [collapsedGroups]);

  const allAgentIds = useMemo(() => AGENTS.map((a) => a.value), []);
  const hooksTarget = () => (hooksScope === 'global' ? null : targetDir.trim() || null);

  const refreshHooksStatus = useCallback(async () => {
    const s = await api.getAgentHooksStatus(hooksScope, hooksTarget(), allAgentIds);
    setHooksStatus(s.agents);
    setHooksNotices(s.notices);
  }, [hooksScope, allAgentIds]);

  // #263：设备扫描。与 hooks 状态一起刷新，保证「设备安装/卸载」与「接入状态」同源同刻。
  const runScan = useCallback(async () => {
    setScan(await api.scanAgentHosts());
  }, []);

  const refreshAll = useCallback(
    () => Promise.all([refreshHooksStatus(), runScan()]),
    [refreshHooksStatus, runScan],
  );

  // 打开 Hooks tab / 切换作用域时自动查询
  useEffect(() => {
    if (tab !== 'hooks' || hooksBusy) return;
    setHooksMsg(null);
    refreshAll().catch((e) => setHooksMsg({ ok: false, text: String(e) }));
  }, [tab, hooksScope]); // eslint-disable-line react-hooks/exhaustive-deps

  const runHooksOp = async (
    op: (scope: HooksScope, target: string | null, agents: string[]) => Promise<unknown>,
    agents: string[],
  ) => {
    if (hooksBusy || agents.length === 0) return;
    if (hooksScope === 'project' && !targetDir.trim()) return;
    setHooksBusy(true);
    setHooksMsg(null);
    try {
      await op(hooksScope, hooksTarget(), agents);
      await refreshHooksStatus();
    } catch (e) {
      setHooksMsg({ ok: false, text: String(e) });
    } finally {
      setHooksBusy(false);
    }
  };

  const installSingle = (a: string) =>
    runHooksOp(
      async (scope, target, agents) => {
        const r = await api.installAgentHooks(scope, target, agents);
        setHooksNotices(r.notices);
        setHooksMsg({
          ok: true,
          text:
            r.filesWritten.length === 0
              ? t('settings.hooks.upToDate')
              : t('settings.hooks.doneFiles', { n: r.filesWritten.length }),
        });
      },
      [a],
    );

  const uninstallSingle = (a: string) =>
    runHooksOp(
      async (scope, target, agents) => {
        const r = await api.uninstallAgentHooks(scope, target, agents);
        setHooksNotices(r.notices);
        const kept =
          r.filesKept.length > 0 ? t('settings.hooks.keptFiles', { n: r.filesKept.length }) : '';
        setHooksMsg({
          ok: true,
          text: t('settings.hooks.removedFiles', { n: r.filesRemoved.length }) + kept,
        });
      },
      [a],
    );

  const supportedHere = (v: string) =>
    HOOK_SUPPORTED_AGENTS.includes(v) &&
    (hooksScope === 'global' || v === 'claude-code' || v === 'opencode');

  const installAllAvailable = () => {
    const list = (hooksStatus ?? [])
      .filter((st) => supportedHere(st.agent) && st.hostPresent && !st.installed)
      .map((st) => st.agent);
    if (list.length === 0) return;
    void runHooksOp(async (scope, target, agents) => {
      const r = await api.installAgentHooks(scope, target, agents);
      setHooksNotices(r.notices);
      setHooksMsg({
        ok: true,
        text:
          r.filesWritten.length === 0
            ? t('settings.hooks.upToDate')
            : t('settings.hooks.doneFiles', { n: r.filesWritten.length }),
      });
    }, list);
  };

  return (
    <div className="panel-page agent-page">
      <header className="panel-page-head">
        <span className="notes-head-icon">
          <Icon d={ICON.plug} size={15} />
        </span>
        <span className="panel-page-title">{t('agent.title')}</span>
        <button className="btn ghost small" onClick={onClose} title={t('btn.cancel')}>
          ✕
        </button>
      </header>

      {/* tab 切换 */}
      <div style={{ display: 'flex', gap: 6, margin: '0 14px 14px', flexWrap: 'wrap' }}>
        {(['hooks', 'mcp'] as AgentTab[]).map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => setTab(k)}
            className={`chip${tab === k ? ' on' : ''}`}
            style={{ padding: '4px 12px', cursor: 'pointer' }}
          >
            {t(`agent.tab.${k}`)}
          </button>
        ))}
      </div>

      <div className="agent-body">
        {/* Tab: Agent 接入（hooks） */}
        {tab === 'hooks' && (
          <div>
            <div className="field">
              <label>{t('settings.hooks.title')}</label>
              <div className="muted small">{t('settings.hooks.desc')}</div>
            </div>
            <div className="field">
              <label>{t('settings.hooks.scope')}</label>
              <div className="row" style={{ gap: 6 }}>
                {(['global', 'project'] as HooksScope[]).map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => {
                      setHooksScope(s);
                      setHooksStatus(null);
                    }}
                    className={`chip${hooksScope === s ? ' on' : ''}`}
                    style={{ padding: '4px 12px', cursor: 'pointer' }}
                  >
                    {t(`settings.hooks.scope.${s}`)}
                  </button>
                ))}
              </div>
              <div className="muted small" style={{ marginTop: 4 }}>
                {t('settings.hooks.scopeHint')}
              </div>
            </div>
            {hooksScope === 'project' && (
              <div className="field">
                <label>{t('settings.hooks.targetLabel')}</label>
                <input
                  className="input wide"
                  placeholder={t('settings.hooks.targetPlaceholder')}
                  value={targetDir}
                  onChange={(e) => setTargetDir(e.target.value)}
                />
              </div>
            )}
            <div className="field">
              <label>{t('settings.hooks.agents')}</label>
              {GROUP_ORDER.map((group) => {
                const title = t(`settings.hooks.group.${group}`);
                const rows = AGENTS.map((a) => a.value).filter((v) => {
                  const st = hooksStatus?.find((s) => s.agent === v);
                  return (
                    groupOf({
                      supported: supportedHere(v),
                      status: st,
                      device: deviceStateOf(v, scan),
                    }) === group
                  );
                });
                if (rows.length === 0) return null;
                const collapsed = collapsedGroups[group] === true;
                return (
                  <div key={group} style={{ marginTop: 8 }}>
                    <button
                      type="button"
                      className="hook-group-toggle muted small"
                      aria-expanded={!collapsed}
                      onClick={() => setCollapsedGroups((m) => ({ ...m, [group]: !m[group] }))}
                      style={{ fontWeight: 600 }}
                    >
                      <span aria-hidden="true">{collapsed ? '▸' : '▾'}</span>
                      <span className={`hook-group-dot hook-group-dot-${group}`} />
                      {title}（{rows.length}）
                    </button>
                    {!collapsed &&
                      rows.map((v) => {
                        const st = hooksStatus?.find((s) => s.agent === v);
                        const supported = supportedHere(v);
                        const device = deviceStateOf(v, scan);
                        const detail = !supported
                          ? (MANUAL_PATH_HINTS[v] ?? t('settings.hooks.manual'))
                          : st
                            ? `hooks ${st.hooksOk ? '✓' : '✗'} · commands ${st.commandsOk ? '✓' : '✗'} · ${v === 'opencode' ? 'mcp' : 'settings'} ${st.settingsOk ? '✓' : '✗'}`
                            : '…';
                        // 「疑似已卸载」行显式给出残留路径，便于用户核对后再清理。
                        const residue = group === 'uninstalled' ? deviceDetail(v, scan) : '';
                        return (
                          <div
                            key={v}
                            className="row"
                            style={{ alignItems: 'center', gap: 6, padding: '3px 0' }}
                          >
                            <span
                              style={{ minWidth: 130 }}
                              className={
                                group === 'installed'
                                  ? 'hook-row-installed'
                                  : group === 'available'
                                    ? 'hook-row-available'
                                    : group === 'uninstalled'
                                      ? 'hook-row-uninstalled'
                                      : undefined
                              }
                            >
                              {agentLabel(v, t)}
                            </span>
                            {scan && (
                              <span className={`agent-device agent-device-${device}`}>
                                {t(DEVICE_LABEL_KEY[device])}
                              </span>
                            )}
                            <span className="muted small">{detail}</span>
                            {residue && (
                              <span className="small agent-scan-path" title={residue}>
                                {residue}
                              </span>
                            )}
                            <span style={{ marginLeft: 'auto' }}>
                              {supported && st?.installed && (
                                <button
                                  className="btn ghost small"
                                  disabled={hooksBusy}
                                  onClick={() => void uninstallSingle(v)}
                                >
                                  {t('settings.hooks.uninstall')}
                                </button>
                              )}
                              {supported && (!st || (st.hostPresent && !st.installed)) && (
                                <button
                                  className="btn ghost small"
                                  disabled={hooksBusy}
                                  onClick={() => void installSingle(v)}
                                >
                                  {t('settings.hooks.install')}
                                </button>
                              )}
                            </span>
                          </div>
                        );
                      })}
                  </div>
                );
              })}
              <div className="muted small" style={{ marginTop: 4 }}>
                {t('settings.hooks.manualHint')}
              </div>
              {scan &&
              (scan.newlyRemoved.length > 0 ||
                scan.agents.some((a) => a.kind === 'config-only' && supportedHere(a.agent))) ? (
                <div className="muted small" style={{ marginTop: 4 }}>
                  {t('settings.hooks.uninstalledHint')}
                </div>
              ) : null}
            </div>
            <div className="row" style={{ gap: 6 }}>
              <button
                className="btn"
                onClick={() => {
                  if (hooksBusy) return;
                  if (hooksScope === 'project' && !targetDir.trim()) return;
                  setHooksBusy(true);
                  setHooksMsg(null);
                  refreshAll()
                    .catch((e) => setHooksMsg({ ok: false, text: String(e) }))
                    .finally(() => setHooksBusy(false));
                }}
                disabled={hooksBusy || (hooksScope === 'project' && !targetDir.trim())}
                title={t('settings.hooks.scanHint')}
              >
                {hooksBusy ? t('settings.hooks.working') : t('settings.hooks.refresh')}
              </button>
              <button className="btn primary" onClick={installAllAvailable} disabled={hooksBusy}>
                {t('settings.hooks.installAll')}
              </button>
            </div>
            {/* #263：设备扫描摘要 —— 已安装 / 新发现 / 疑似已卸载 / 仅残留配置。 */}
            {scan && (
              <div className="muted small agent-scan-summary">
                <div>
                  {t('settings.hooks.scanSummary', {
                    time: clockOf(scan.scannedAt),
                    n: scan.agents.filter((a) => a.present).length,
                    x: scan.newlyInstalled.length,
                    y: scan.newlyRemoved.length,
                    z: scan.agents.filter((a) => a.kind === 'config-only').length,
                  })}
                </div>
                {!scan.hasPrevious && <div>{t('settings.hooks.scanFirst')}</div>}
              </div>
            )}
            {hooksNotices.length > 0 && (
              <div className="muted small" style={{ marginTop: 6, whiteSpace: 'pre-line' }}>
                {hooksNotices.map((n, i) => (
                  <div key={i}>· {n}</div>
                ))}
              </div>
            )}
            {hooksMsg && (
              <div className={`banner ${hooksMsg.ok ? 'ok' : 'error'} inline diag-banner`}>
                {hooksMsg.text}
              </div>
            )}
          </div>
        )}

        {/* Tab: MCP 接入 */}
        {tab === 'mcp' && (
          <>
            <section className="agent-section">
              <h4 className="agent-section-title">
                <Icon d={ICON.plug} size={13} /> {t('agent.mcpTitle')}
              </h4>
              <p className="muted small">{t('agent.mcpDesc')}</p>
              <pre className="about-code">{buildMcpSnippet()}</pre>
              <p className="muted small">{t('agent.mcpFallback')}</p>
            </section>

            <section className="agent-section">
              <h4 className="agent-section-title">
                <Icon d={ICON.tools} size={13} /> {t('agent.toolsTitle')}
              </h4>
              <p className="muted small">{t('agent.toolsDesc')}</p>
              <table className="agent-tools-table">
                <thead>
                  <tr>
                    <th>{t('agent.tools.name')}</th>
                    <th>{t('agent.tools.params')}</th>
                    <th>{t('agent.tools.desc')}</th>
                  </tr>
                </thead>
                <tbody>
                  {TOOLS.map((tool) => (
                    <tr key={tool.name}>
                      <td className="mono nowrap">{tool.name}</td>
                      <td className="mono nowrap">{tool.params}</td>
                      <td>{t(`agent.tools.${tool.key}`)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>

            <section className="agent-section">
              <h4 className="agent-section-title">
                <Icon d={ICON.guide} size={13} /> {t('agent.guideTitle')}
              </h4>
              <p className="muted small">{t('agent.guideDesc')}</p>
              <table className="agent-trigger-table">
                <tbody>
                  {TRIGGERS.map((row) => (
                    <tr key={row.when}>
                      <td className="nowrap">{t(`agent.guide.${row.when}.when`)}</td>
                      <td className="mono">{t(`agent.guide.${row.when}.action`)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          </>
        )}
      </div>
    </div>
  );
}

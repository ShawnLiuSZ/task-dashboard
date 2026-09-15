import { buildMcpSnippet } from './AboutPanel';
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
  tools: 'M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z',
  guide: 'M4 19.5A2.5 2.5 0 0 1 6.5 17H20 V4H6.5A2.5 2.5 0 0 0 4 6.5z M4 19.5A2.5 2.5 0 0 0 6.5 22H20 V8',
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

/** #259：Agent 接入面板（主区内嵌）：MCP 配置 + 可用工具 + 接入指引。 */
export default function AgentPanel({ onClose }: Props) {
  const t = useT();

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

      <div className="agent-body">
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
      </div>
    </div>
  );
}

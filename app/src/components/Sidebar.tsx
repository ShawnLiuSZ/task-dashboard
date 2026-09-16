import { useT } from '../i18n';
import type { Account } from '../types';

/** 主区视图键：由侧边栏选中项驱动。 */
export type NavKey = 'notes' | 'board' | 'settings' | 'agents' | 'synclogs' | 'accounts';

interface Props {
  accounts: Account[];
  activeAccountId: number | null;
  /** 当前视图：board 时高亮激活账号项，其余高亮对应导航项。 */
  nav: NavKey;
  onNavigate: (nav: NavKey) => void;
  onSwitchAccount: (id: number) => void;
  onAddAccount: () => void;
  onAbout: () => void;
}

/* ---------- 图标（内联 SVG，与 App 顶栏风格一致） ---------- */

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
  notes: 'M5 4.5A1.5 1.5 0 0 1 6.5 3H18a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H6.5A1.5 1.5 0 0 1 5 19.5z M5 16.5h14 M9 8h6 M9 11.5h6',
  user: 'M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2 M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z',
  plus: 'M12 5v14 M5 12h14',
  settings:
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z',
  agent: 'M12 2l8 4v6c0 5-3.5 8.5-8 10-4.5-1.5-8-5-8-10V6z M12 8v4 M9 11h.01 M15 11h.01 M9 14c1.5 1.2 4.5 1.2 6 0',
  synclogs:
    'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z M14 2v6h6 M16 13H8 M16 17H8 M10 9H8',
  about: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z M12 16v-4 M12 8h.01',
};

/* ---------- 导航项 ---------- */

function NavItem({
  icon,
  label,
  title,
  active,
  onClick,
}: {
  icon: string;
  label: string;
  title?: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`sidebar-item${active ? ' active' : ''}`}
      title={title ?? label}
      onClick={onClick}
    >
      <Icon d={icon} />
      <span className="sidebar-item-label">{label}</span>
    </button>
  );
}

/** #259：左侧固定导航。分组：记事本 | 账号列表 | 设置/Agent/同步日志/账号登录 | 底部关于。 */
export default function Sidebar({
  accounts,
  activeAccountId,
  nav,
  onNavigate,
  onSwitchAccount,
  onAddAccount,
  onAbout,
}: Props) {
  const t = useT();

  return (
    <nav className="sidebar" aria-label={t('sidebar.title')}>
      <div className="sidebar-group">
        <NavItem
          icon={ICON.notes}
          label={t('sidebar.notes')}
          active={nav === 'notes'}
          onClick={() => onNavigate('notes')}
        />
      </div>

      <div className="sidebar-group accounts">
        <div className="sidebar-group-title">{t('sidebar.accountsTitle')}</div>
        {accounts.length === 0 && (
          <div className="sidebar-empty muted small">{t('sidebar.noAccounts')}</div>
        )}
        {accounts.map((a) => {
          const active = nav === 'board' && a.id === activeAccountId;
          const label = `@${a.login}${a.org ? ` (${a.org})` : ''}`;
          return (
            <NavItem
              key={a.id}
              icon={ICON.user}
              label={label}
              title={t('sidebar.switchAccount')}
              active={active}
              onClick={() => onSwitchAccount(a.id)}
            />
          );
        })}
        <NavItem
          icon={ICON.plus}
          label={t('sidebar.addAccount')}
          active={nav === 'accounts'}
          onClick={onAddAccount}
        />
      </div>

      <div className="sidebar-group">
        <NavItem
          icon={ICON.settings}
          label={t('sidebar.settings')}
          active={nav === 'settings'}
          onClick={() => onNavigate('settings')}
        />
        <NavItem
          icon={ICON.agent}
          label={t('sidebar.agents')}
          active={nav === 'agents'}
          onClick={() => onNavigate('agents')}
        />
        <NavItem
          icon={ICON.synclogs}
          label={t('sidebar.synclogs')}
          active={nav === 'synclogs'}
          onClick={() => onNavigate('synclogs')}
        />
      </div>

      <div className="sidebar-footer">
        <NavItem
          icon={ICON.about}
          label={t('sidebar.about')}
          active={false}
          onClick={onAbout}
        />
      </div>
    </nav>
  );
}

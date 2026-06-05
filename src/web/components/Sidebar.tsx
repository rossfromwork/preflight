import { Home, Clock, TrendingUp, ShieldCheck, Sun, Moon } from 'lucide-react';
import { StatusIndicator } from './StatusIndicator';
import { useLiveAlerts } from '../hooks/useLiveAlerts';
import type { AlertEvent } from '../store/liveStore';
import type { Theme } from '../hooks/useTheme';

const NAV_OBSERVE = [
  { path: '/', label: 'Today', Icon: Home },
  { path: '/sessions', label: 'Sessions', Icon: Clock },
] as const;

const NAV_ANALYZE = [
  { path: '/history', label: 'History', Icon: TrendingUp },
  { path: '/audit', label: 'Audit', Icon: ShieldCheck },
] as const;

const BADGE_TONE: Record<AlertEvent['severity'], string> = {
  info: 'bg-bg-line text-ink-base',
  warning: 'bg-accent-amber/20 text-accent-amber',
  critical: 'bg-accent-red/20 text-accent-red',
};

export interface SidebarProps {
  readonly currentPath: string;
  readonly onNavigate: (path: string) => void;
  readonly connected: boolean;
  readonly theme: Theme;
  readonly onToggleTheme: () => void;
}

export function Sidebar({
  currentPath,
  onNavigate,
  connected,
  theme,
  onToggleTheme,
}: SidebarProps): JSX.Element {
  const { count: alertCount, maxSeverity } = useLiveAlerts();

  function renderNavItem({
    path,
    label,
    Icon,
  }: {
    path: string;
    label: string;
    Icon: typeof Home;
  }) {
    const active = currentPath === path;
    const showBadge = path === '/' && alertCount > 0;
    return (
      <button
        key={path}
        type="button"
        aria-current={active ? 'page' : undefined}
        onClick={() => onNavigate(path)}
        className={
          'flex items-center gap-2.5 px-3 py-2 rounded-xl text-xs text-left transition-all duration-150 ' +
          (active
            ? 'border-l-[3px] border-l-accent-green bg-[rgba(28,231,131,0.06)] text-ink-base font-medium pl-2.5'
            : 'border-l-[3px] border-l-transparent text-ink-subtle hover:text-ink-base hover:bg-surface-3')
        }
      >
        <Icon size={14} aria-hidden="true" focusable="false" />
        <span>{label}</span>
        {showBadge && (
          <span
            data-testid="alert-badge"
            data-severity={maxSeverity ?? 'info'}
            aria-label={`${alertCount > 99 ? '99+' : alertCount} firing ${alertCount === 1 ? 'alert' : 'alerts'}`}
            className={
              `ml-auto px-1.5 rounded text-[10px] font-semibold tabular-nums ` +
              BADGE_TONE[maxSeverity ?? 'info']
            }
          >
            {alertCount > 99 ? '99+' : alertCount}
          </span>
        )}
      </button>
    );
  }

  return (
    <aside className="w-52 bg-bg-deep border-r border-border-subtle p-4 flex flex-col">
      {/* Logo + brand */}
      <div className="flex items-center gap-2 mb-1">
        <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
          <path
            d="M2 10 L6 4 L10 14 L14 6 L18 10"
            stroke="currentColor"
            strokeWidth="2"
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="text-accent-green"
          />
        </svg>
        <span className="text-ink-base font-semibold text-sm tracking-tight">observatory</span>
      </div>
      <div className="text-ink-muted text-[10px] tracking-wide mb-6">
        local &middot; single-user
      </div>

      {/* OBSERVE section */}
      <div className="text-[10px] font-medium text-ink-muted uppercase tracking-wider mb-2 px-2">
        Observe
      </div>
      <nav aria-label="Observe" className="flex flex-col gap-0.5 mb-4">
        {NAV_OBSERVE.map((item) => renderNavItem(item))}
      </nav>

      {/* ANALYZE section */}
      <div className="text-[10px] font-medium text-ink-muted uppercase tracking-wider mb-2 px-2">
        Analyze
      </div>
      <nav aria-label="Analyze" className="flex flex-col gap-0.5">
        {NAV_ANALYZE.map((item) => renderNavItem(item))}
      </nav>

      {/* Footer */}
      <div className="mt-auto pt-4 border-t border-border-subtle flex items-center justify-between">
        {connected ? (
          <StatusIndicator tone="good" label="connected" />
        ) : (
          <StatusIndicator tone="warn" label="reconnecting" />
        )}
        <button
          type="button"
          onClick={onToggleTheme}
          aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          className="p-1.5 rounded-lg text-ink-muted hover:text-ink-base hover:bg-surface-5 transition-colors"
        >
          {theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
        </button>
      </div>
    </aside>
  );
}

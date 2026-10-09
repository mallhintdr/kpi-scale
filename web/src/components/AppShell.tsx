import clsx from 'clsx';
import {
  Bell, BarChart3, CheckSquare, ClipboardEdit, Home, LayoutGrid, LogOut, Medal, MapPinned, PanelLeftClose, PanelLeftOpen,
  Crosshair, FileSpreadsheet, GitCompareArrows, Network, ShieldCheck, SlidersHorizontal, Table2, Target, Upload, UserCog, Workflow,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { get } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useCaps, useMeta } from '../lib/rev';
import { useViewMode } from '../lib/mode';
import { ApiError } from '../lib/api';
import { Avatar, Card, Empty, GovLogo, IconButton, Spinner } from './ui';

type Caps = ReturnType<typeof useCaps>;
export interface NavItem {
  to: string;
  label: string;
  icon: typeof Home;
  show?: (c: Caps) => boolean;
  group?: 'main' | 'admin';
}

export const NAV: NavItem[] = [
  { to: '/', label: 'Home', icon: Home },
  { to: '/explore', label: 'Performance', icon: BarChart3 },
  { to: '/assigned', label: 'Assigned targets', icon: Crosshair },
  { to: '/staff', label: 'Staff performance', icon: Table2 },
  { to: '/league', label: 'League tables', icon: Medal },
  { to: '/compare', label: 'Compare areas', icon: GitCompareArrows, show: (c) => c.canCompare },
  { to: '/reports', label: 'Report builder', icon: FileSpreadsheet },
  { to: '/entry', label: 'Enter figures', icon: ClipboardEdit, show: (c) => c.canEnter },
  { to: '/verify', label: 'Verify', icon: ShieldCheck, show: (c) => c.canVerify && !c.isAdmin },
  { to: '/targets', label: 'Annual targets', icon: Target, show: (c) => c.canSetTargets && !c.isAdmin },
  { to: '/tasks', label: 'Tasks', icon: CheckSquare },
  { to: '/notifications', label: 'Alerts', icon: Bell },
  { to: '/admin/org', label: 'Organisation setup', icon: Workflow, show: (c) => c.isAdmin, group: 'admin' },
  { to: '/admin/units', label: 'Hierarchy', icon: Network, show: (c) => c.isAdmin, group: 'admin' },
  { to: '/admin/people', label: 'People', icon: UserCog, show: (c) => c.isAdmin, group: 'admin' },
  { to: '/admin/postings', label: 'Postings', icon: MapPinned, show: (c) => c.isAdmin, group: 'admin' },
  { to: '/admin/scoring', label: 'Scoring weights', icon: SlidersHorizontal, show: (c) => c.isAdmin, group: 'admin' },
  { to: '/admin/import', label: 'Bulk import', icon: Upload, show: (c) => c.isAdmin, group: 'admin' },
];
export const visibleNav = (c: Caps) => NAV.filter((n) => !n.show || n.show(c));

export const useUnread = () =>
  useQuery({ queryKey: ['notifications', 'count'], queryFn: () => get<{ count: number }>('/notifications/unread-count'), refetchInterval: 60_000, select: (d) => d.count });

const COLLAPSE_KEY = 'sidebar-collapsed';

export function AppShell() {
  const { session, logout } = useAuth();
  const caps = useCaps();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { data: unread = 0 } = useUnread();
  const items = visibleNav(caps);
  const meta = useMeta();
  const t = session!.tenant;
  const orgLine = t.branding?.tagline ?? t.name;
  const orgShort = t.branding?.shortName ?? t.name;

  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(COLLAPSE_KEY) === '1';
    } catch {
      return false;
    }
  });
  const toggleCollapsed = () =>
    setCollapsed((c) => {
      try {
        localStorage.setItem(COLLAPSE_KEY, c ? '0' : '1');
      } catch {
        /* storage unavailable */
      }
      return !c;
    });

  // Bottom bar: 4 primary destinations + "More"
  const byPath = (to: string) => NAV.find((n) => n.to === to)!;
  const tabs = [
    byPath('/'),
    byPath('/explore'),
    caps.canEnter ? { ...byPath('/entry'), label: 'Entry' } : { ...byPath('/league'), label: 'League' },
    byPath('/tasks'),
    { to: '/more', label: 'More', icon: LayoutGrid },
  ];
  const isActive = (to: string) => (to === '/' ? pathname === '/' : pathname.startsWith(to));

  return (
    <div className="min-h-dvh lg:flex">
      {/* Desktop sidebar: collapses to an icon rail */}
      <aside className={clsx('sticky top-0 hidden h-dvh shrink-0 flex-col bg-brand-800 text-white transition-[width] duration-200 lg:flex print:!hidden', collapsed ? 'w-[60px]' : 'w-52')}>
        <div className={clsx('flex border-b border-white/10', collapsed ? 'flex-col items-center gap-0.5 py-1.5' : 'h-[59px] items-center gap-2 pl-2.5 pr-1.5')}>
          <Link to="/" title={t.name} className="flex min-w-0 flex-1 items-center gap-2.5">
            <GovLogo className="size-[42px] shrink-0" />
            {!collapsed && (
              <div className="min-w-0 leading-tight">
                <div className="line-clamp-2 text-[11px] font-bold uppercase leading-tight tracking-wide">{orgLine}</div>
              </div>
            )}
          </Link>
          <button
            onClick={toggleCollapsed}
            aria-label={collapsed ? 'Expand menu' : 'Collapse menu'}
            aria-expanded={!collapsed}
            title={collapsed ? 'Expand menu' : 'Collapse menu'}
            className="grid size-8 shrink-0 place-items-center rounded-md text-brand-100 hover:bg-white/15 hover:text-white"
          >
            {collapsed ? <PanelLeftOpen className="size-5" /> : <PanelLeftClose className="size-5" />}
          </button>
        </div>

        <nav className={clsx('flex-1 space-y-px overflow-hidden py-2', collapsed ? 'px-1.5' : 'px-2')}>
          {items.filter((i) => i.group !== 'admin').map((i) => (
            <SideLink key={i.to} item={i} collapsed={collapsed} badge={i.to === '/notifications' ? unread : 0} />
          ))}
          {items.some((i) => i.group === 'admin') &&
            (collapsed ? (
              <div className="mx-2 my-1.5 border-t border-white/15" />
            ) : (
              <div className="px-2.5 pb-0.5 pt-2 text-[10px] font-semibold uppercase tracking-wider text-gold-400">Manage</div>
            ))}
          {items.filter((i) => i.group === 'admin').map((i) => <SideLink key={i.to} item={i} collapsed={collapsed} />)}
        </nav>

      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Government header band */}
        <div className="pt-safe sticky top-0 z-30 border-b-[3px] border-gold-500 bg-brand-700 text-white print:hidden">
          <div className="flex h-14 items-center gap-2 px-3 lg:px-4">
            <GovLogo className="size-9 shrink-0 lg:hidden" />
            <div className="min-w-0 flex-1 leading-tight">
              <div className="truncate text-[10px] font-semibold uppercase tracking-wide text-gold-400 sm:text-[11px] lg:hidden">{orgShort}</div>
              <div className="truncate text-[14px] font-semibold leading-tight sm:text-base"><span className="sm:hidden">Dashboard</span><span className="hidden sm:inline">Employee Performance Dashboard</span></div>
              <div className="hidden truncate text-xs text-brand-100 sm:block">{session!.tenant.name}</div>
            </div>

            {/* Top-right actions */}
            <ModeSwitch />
            <Link to="/notifications" aria-label={`Notifications${unread ? ` (${unread} unread)` : ''}`} title="Notifications" className="relative grid size-10 place-items-center rounded-lg hover:bg-white/15">
              <Bell className="size-[22px]" />
              {unread > 0 && (
                <span className="absolute right-0.5 top-0.5 min-w-[18px] rounded-full bg-rose-500 px-1 text-center text-[10px] font-semibold leading-[18px] ring-2 ring-brand-700">
                  {unread > 9 ? '9+' : unread}
                </span>
              )}
            </Link>
            <Link to="/profile" title={session!.user.name} className="hidden items-center gap-2 rounded-lg p-1 hover:bg-white/15 sm:flex">
              <Avatar name={session!.user.name} size={34} />
              <div className="hidden max-w-36 leading-tight md:block">
                <div className="truncate text-sm font-medium">{session!.user.name}</div>
                <div className="truncate text-[11px] text-brand-100">{session!.user.designation ?? session!.user.role}</div>
              </div>
            </Link>
            <IconButton label="Sign out" onClick={() => logout().then(() => navigate('/login'))} className="hidden size-10 text-white hover:bg-white/15 lg:grid dark:text-white dark:hover:bg-white/15">
              <LogOut className="size-[18px]" />
            </IconButton>
          </div>
        </div>
        <main className="mx-auto w-full max-w-[1600px] flex-1 px-3 pb-24 sm:px-4 lg:pb-5">
          {meta.isLoading ? (
            <div className="py-16 text-center"><Spinner /></div>
          ) : meta.error ? (
            <Card className="mt-6">
              <Empty
                title={meta.error instanceof ApiError && meta.error.status === 409 ? 'Organisation not set up yet' : 'Could not load your organisation'}
                body={(meta.error as Error).message}
              />
            </Card>
          ) : (
            <Outlet />
          )}
        </main>
        <footer className="mx-auto hidden w-full max-w-[1600px] print:!hidden border-t border-slate-200 px-4 py-2.5 text-[11px] text-slate-500 lg:block dark:border-slate-800">
          © {new Date().getFullYear()} {orgLine} · Employee Performance Dashboard
        </footer>
      </div>

      {/* Mobile bottom tab bar */}
      <nav className="pb-safe fixed inset-x-0 bottom-0 z-40 border-t border-slate-200 bg-white/95 backdrop-blur-lg lg:hidden print:hidden dark:border-slate-800 dark:bg-slate-900/95">
        <div className="mx-auto grid max-w-lg grid-cols-5">
          {tabs.map((t) => {
            const active = isActive(t.to);
            const badge = t.to === '/notifications' ? unread : 0;
            return (
              <Link key={t.to} to={t.to} className={clsx('relative flex h-16 flex-col items-center justify-center gap-1 text-[11px] font-medium', active ? 'text-brand-700 dark:text-brand-200' : 'text-slate-500')}>
                <span className={clsx('grid h-7 w-14 place-items-center rounded-full transition', active && 'bg-brand-100 dark:bg-brand-500/20')}>
                  <t.icon className="size-[22px]" strokeWidth={active ? 2.4 : 2} />
                </span>
                {t.label}
                {badge > 0 && <span className="absolute right-[22%] top-2 min-w-4 rounded-full bg-rose-500 px-1 text-center text-[10px] leading-4 text-white">{badge > 9 ? '9+' : badge}</span>}
              </Link>
            );
          })}
        </div>
      </nav>
    </div>
  );
}

function SideLink({ item, badge = 0, collapsed }: { item: NavItem; badge?: number; collapsed: boolean }) {
  return (
    <NavLink
      to={item.to}
      end={item.to === '/'}
      title={collapsed ? item.label : undefined}
      aria-label={collapsed ? item.label : undefined}
      className={({ isActive }) =>
        clsx(
          'relative flex h-8 items-center gap-2.5 rounded-md text-[13px] font-medium transition',
          collapsed ? 'justify-center' : 'px-2.5',
          isActive
            ? 'bg-white/15 text-white before:absolute before:inset-y-2 before:left-0 before:w-[3px] before:rounded-full before:bg-gold-400'
            : 'text-brand-100 hover:bg-white/10 hover:text-white',
        )
      }
    >
      <item.icon className="size-[18px] shrink-0" />
      {!collapsed && <span className="flex-1 truncate">{item.label}</span>}
      {badge > 0 &&
        (collapsed ? (
          <span className="absolute right-3 top-2 size-2 rounded-full bg-rose-500" />
        ) : (
          <span className="rounded-full bg-rose-500 px-1.5 text-[11px] text-white">{badge}</span>
        ))}
    </NavLink>
  );
}

/** Performance (default) vs KPI evaluation, shown in the green header band. */
function ModeSwitch() {
  const [mode, setMode] = useViewMode();
  const opt = (m: 'performance' | 'targets' | 'kpi', long: string, short: string) => (
    <button
      onClick={() => setMode(m)}
      aria-pressed={mode === m}
      title={m === 'performance' ? 'Achievement against annual demand' : m === 'targets' ? 'Assigned short-term targets: target vs achievement' : 'Weighted KPI scores, bands and rankings'}
      className={clsx('rounded-md px-2 py-1 text-[11px] font-semibold transition sm:px-2.5 sm:text-xs', mode === m ? 'bg-white text-brand-800 shadow-sm' : 'text-brand-100 hover:text-white')}
    >
      <span className="hidden sm:inline">{long}</span>
      <span className="sm:hidden">{short}</span>
    </button>
  );
  return (
    <div className="flex shrink-0 rounded-lg bg-white/15 p-0.5" role="group" aria-label="View mode">
      {opt('performance', 'Performance', 'Perf')}
      {opt('targets', 'Targets', 'Tgt')}
      {opt('kpi', 'KPI evaluation', 'KPI')}
    </div>
  );
}

/** Page header: title with optional back link and actions. Includes the bell on mobile. */
export function PageHeader({ title, subtitle, back, actions }: { title: string; subtitle?: ReactNode; back?: string; actions?: ReactNode }) {
  const navigate = useNavigate();
  return (
    <header className="flex flex-wrap items-end justify-between gap-x-3 gap-y-2 pb-3 pt-3 lg:pt-4 print:hidden">
      <div className="min-w-0 flex-1 basis-52">
        {back && (
          <button onClick={() => (history.length > 1 ? navigate(-1) : navigate(back))} className="-ml-1 mb-1 flex h-8 items-center text-sm font-medium text-brand-600">
            ‹ Back
          </button>
        )}
        <h1 className="line-clamp-2 break-words border-l-4 border-gold-500 pl-2.5 text-lg font-bold leading-snug text-brand-800 sm:text-xl lg:text-2xl dark:text-white">{title}</h1>
        {subtitle && <div className="mt-0.5 pl-3.5 text-[13px] text-slate-500">{subtitle}</div>}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {actions}
      </div>
    </header>
  );
}

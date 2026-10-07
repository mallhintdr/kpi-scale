import clsx from 'clsx';
import {
  Bell, BarChart3, CheckSquare, ClipboardEdit, Home, LayoutGrid, ListChecks, LogOut, Medal, MapPinned, PanelLeftClose, PanelLeftOpen,
  ShieldCheck, SlidersHorizontal, Table2, Target, UserCog,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { get } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useCaps } from '../lib/rev';
import { Avatar, GovLogo, IconButton } from './ui';

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
  { to: '/staff', label: 'Staff performance', icon: Table2, show: (c) => c.isOfficer },
  { to: '/league', label: 'League tables', icon: Medal, show: (c) => c.isOfficer },
  { to: '/entry', label: 'Enter figures', icon: ClipboardEdit, show: (c) => c.canEnter },
  { to: '/verify', label: 'Verify', icon: ShieldCheck, show: (c) => c.isWasilBaqi && !c.isAdmin },
  { to: '/targets', label: 'Targets & demand', icon: Target, show: (c) => c.isWasilBaqi && !c.isAdmin },
  { to: '/audit-paras', label: 'Audit paras', icon: ListChecks },
  { to: '/tasks', label: 'Tasks', icon: CheckSquare },
  { to: '/notifications', label: 'Alerts', icon: Bell },
  { to: '/admin/people', label: 'People', icon: UserCog, show: (c) => c.isAdmin, group: 'admin' },
  { to: '/admin/postings', label: 'Postings', icon: MapPinned, show: (c) => c.isAdmin, group: 'admin' },
  { to: '/admin/scoring', label: 'Scoring weights', icon: SlidersHorizontal, show: (c) => c.isAdmin, group: 'admin' },
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
    caps.canEnter ? { ...byPath('/entry'), label: 'Entry' } : caps.isOfficer ? { ...byPath('/league'), label: 'League' } : byPath('/audit-paras'),
    byPath('/tasks'),
    { to: '/more', label: 'More', icon: LayoutGrid },
  ];
  const isActive = (to: string) => (to === '/' ? pathname === '/' : pathname.startsWith(to));

  return (
    <div className="min-h-dvh lg:flex">
      {/* Desktop sidebar: collapses to an icon rail */}
      <aside className={clsx('sticky top-0 hidden h-dvh shrink-0 flex-col bg-brand-800 text-white transition-[width] duration-200 lg:flex', collapsed ? 'w-[76px]' : 'w-64')}>
        <div className={clsx('flex border-b border-white/10', collapsed ? 'flex-col items-center gap-1 py-2' : 'h-[75px] items-center gap-2 pl-3 pr-2')}>
          <Link to="/" title="Government of the Punjab" className="flex min-w-0 flex-1 items-center gap-2.5">
            <GovLogo className="size-[51px] shrink-0" />
            {!collapsed && (
              <div className="min-w-0 leading-tight">
                <div className="text-[12.5px] font-bold uppercase tracking-wide">Government of the Punjab</div>
              </div>
            )}
          </Link>
          <button
            onClick={toggleCollapsed}
            aria-label={collapsed ? 'Expand menu' : 'Collapse menu'}
            aria-expanded={!collapsed}
            title={collapsed ? 'Expand menu' : 'Collapse menu'}
            className="grid size-9 shrink-0 place-items-center rounded-lg text-brand-100 hover:bg-white/15 hover:text-white"
          >
            {collapsed ? <PanelLeftOpen className="size-5" /> : <PanelLeftClose className="size-5" />}
          </button>
        </div>

        <nav className={clsx('flex-1 space-y-0.5 overflow-hidden py-3', collapsed ? 'px-2' : 'px-3')}>
          {items.filter((i) => i.group !== 'admin').map((i) => (
            <SideLink key={i.to} item={i} collapsed={collapsed} badge={i.to === '/notifications' ? unread : 0} />
          ))}
          {items.some((i) => i.group === 'admin') &&
            (collapsed ? (
              <div className="mx-3 my-2 border-t border-white/15" />
            ) : (
              <div className="px-3 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wider text-gold-400">Manage</div>
            ))}
          {items.filter((i) => i.group === 'admin').map((i) => <SideLink key={i.to} item={i} collapsed={collapsed} />)}
        </nav>

      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Government header band */}
        <div className="pt-safe sticky top-0 z-30 border-b-[3px] border-gold-500 bg-brand-700 text-white">
          <div className="flex h-[72px] items-center gap-2 px-3 sm:px-5">
            <GovLogo className="size-[46px] shrink-0 lg:hidden" />
            <div className="min-w-0 flex-1 leading-tight">
              <div className="truncate text-[11px] font-semibold uppercase tracking-wide text-gold-400 lg:hidden">Government of the Punjab</div>
              <div className="truncate text-[15px] font-semibold sm:text-base">Employee Performance Dashboard</div>
              <div className="truncate text-xs text-brand-100">{session!.tenant.name}</div>
            </div>

            {/* Top-right actions */}
            <Link to="/notifications" aria-label={`Notifications${unread ? ` (${unread} unread)` : ''}`} title="Notifications" className="relative grid size-10 place-items-center rounded-lg hover:bg-white/15">
              <Bell className="size-[22px]" />
              {unread > 0 && (
                <span className="absolute right-0.5 top-0.5 min-w-[18px] rounded-full bg-rose-500 px-1 text-center text-[10px] font-semibold leading-[18px] ring-2 ring-brand-700">
                  {unread > 9 ? '9+' : unread}
                </span>
              )}
            </Link>
            <Link to="/profile" title={session!.user.name} className="flex items-center gap-2 rounded-lg p-1 hover:bg-white/15">
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
        <main className="mx-auto w-full max-w-6xl flex-1 px-4 pb-28 sm:px-6 lg:pb-8">
          <Outlet />
        </main>
        <footer className="mx-auto hidden w-full max-w-6xl border-t border-slate-200 px-6 py-4 text-xs text-slate-500 lg:block dark:border-slate-800">
          © {new Date().getFullYear()} Government of the Punjab · Employee Performance Dashboard
        </footer>
      </div>

      {/* Mobile bottom tab bar */}
      <nav className="pb-safe fixed inset-x-0 bottom-0 z-40 border-t border-slate-200 bg-white/95 backdrop-blur-lg lg:hidden dark:border-slate-800 dark:bg-slate-900/95">
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
          'relative flex h-9 items-center gap-3 rounded-lg text-sm font-medium transition',
          collapsed ? 'justify-center' : 'px-3',
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

/** Page header: title with optional back link and actions. Includes the bell on mobile. */
export function PageHeader({ title, subtitle, back, actions }: { title: string; subtitle?: ReactNode; back?: string; actions?: ReactNode }) {
  const navigate = useNavigate();
  return (
    <header className="flex items-end justify-between gap-3 pb-4 pt-5 lg:pt-7">
      <div className="min-w-0">
        {back && (
          <button onClick={() => (history.length > 1 ? navigate(-1) : navigate(back))} className="-ml-1 mb-1 flex h-8 items-center text-sm font-medium text-brand-600">
            ‹ Back
          </button>
        )}
        <h1 className="truncate border-l-4 border-gold-500 pl-3 text-2xl font-bold text-brand-800 lg:text-[28px] dark:text-white">{title}</h1>
        {subtitle && <div className="mt-1 pl-4 text-sm text-slate-500">{subtitle}</div>}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {actions}
      </div>
    </header>
  );
}

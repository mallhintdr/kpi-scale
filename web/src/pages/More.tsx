import { ChevronRight, LogOut } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { PageHeader, useUnread, visibleNav } from '../components/AppShell';
import { useCaps } from '../lib/rev';
import { Avatar, Card, SectionTitle } from '../components/ui';
import { useAuth } from '../lib/auth';

export default function More() {
  const { session, logout } = useAuth();
  const caps = useCaps();
  const navigate = useNavigate();
  const { data: unread = 0 } = useUnread();
  const items = visibleNav(caps).filter((n) => n.to !== '/');
  const main = items.filter((i) => i.group !== 'admin');
  const admin = items.filter((i) => i.group === 'admin');

  const Row = ({ to, label, icon: Icon, badge }: { to: string; label: string; icon: typeof ChevronRight; badge?: number }) => (
    <Link to={to} className="flex h-14 items-center gap-3 px-4 active:bg-slate-50 dark:active:bg-slate-800">
      <span className="grid size-9 place-items-center rounded-xl bg-brand-50 text-brand-600 dark:bg-brand-500/15"><Icon className="size-[18px]" /></span>
      <span className="flex-1 font-medium">{label}</span>
      {!!badge && <span className="rounded-full bg-rose-500 px-2 text-xs font-semibold text-white">{badge}</span>}
      <ChevronRight className="size-4 text-slate-300" />
    </Link>
  );

  return (
    <>
      <PageHeader title="More" />
      <Link to="/profile">
        <Card className="flex items-center gap-3 p-4">
          <Avatar name={session!.user.name} size={52} />
          <div className="min-w-0 flex-1">
            <div className="truncate font-semibold">{session!.user.name}</div>
            <div className="truncate text-sm text-slate-500">{session!.user.email}</div>
            <div className="truncate text-xs capitalize text-slate-400">{session!.user.role} · {session!.tenant.name}</div>
          </div>
          <ChevronRight className="size-4 text-slate-300" />
        </Card>
      </Link>
      <SectionTitle>Navigate</SectionTitle>
      <Card className="divide-y divide-slate-100 dark:divide-slate-800">
        {main.map((i) => <Row key={i.to} {...i} badge={i.to === '/notifications' ? unread : 0} />)}
      </Card>
      {admin.length > 0 && (
        <>
          <SectionTitle>Manage</SectionTitle>
          <Card className="divide-y divide-slate-100 dark:divide-slate-800">{admin.map((i) => <Row key={i.to} {...i} />)}</Card>
        </>
      )}
      <Card className="mt-6">
        <button onClick={() => logout().then(() => navigate('/login'))} className="flex h-14 w-full items-center gap-3 px-4 font-medium text-rose-600">
          <LogOut className="size-5" />Sign out
        </button>
      </Card>
    </>
  );
}

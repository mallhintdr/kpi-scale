import { useQuery } from '@tanstack/react-query';
import { ChevronRight, MapPin } from 'lucide-react';
import { Link } from 'react-router-dom';
import { PageHeader, useUnread, visibleNav } from '../components/AppShell';
import { BlockBars, FyPicker, RevBandBadge } from '../components/rev';
import { Card, Empty, ErrorState, Loading, SectionTitle } from '../components/ui';
import { Bullet, ScoreGauge } from '../components/charts';
import { get } from '../lib/api';
import { useMe } from '../lib/auth';
import { UNIT_LABEL, fmtPKR, useCaps, useFy, type Block, type RevBand } from '../lib/rev';
import { UnitBody, useUnit, type UnitData } from './UnitView';

interface MyScore { post: string; postLabel: string; score: number | null; band: RevBand; blocks: Record<Block, number | null>; target: number; collected: number; units: number }

export default function Home() {
  const { user } = useMe();
  const caps = useCaps();
  const [fy] = useFy();
  const myScore = useQuery({ queryKey: ['rev', 'my-score', fy], queryFn: () => get<{ items: MyScore[] }>(`/rev/my-score?fy=${fy}`), enabled: !!fy });
  const pendingVerify = useQuery({ queryKey: ['rev', 'verify'], queryFn: () => get<unknown[]>('/rev/verify'), enabled: caps.isWasilBaqi && !caps.isAdmin });
  const openTasks = useQuery({ queryKey: ['rev', 'tasks', 'mine', 'open'], queryFn: () => get<unknown[]>('/rev/tasks?box=mine&status=open') });
  const primary = caps.roots[0];
  const unit = useUnit(primary?._id, fy);
  const { data: unread = 0 } = useUnread();
  const modules = visibleNav(caps).filter((n) => n.to !== '/');
  const counts: Record<string, number | undefined> = { '/verify': pendingVerify.data?.length, '/tasks': openTasks.data?.length, '/notifications': unread };

  const h = new Date().getHours();
  const greet = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';

  return (
    <>
      <PageHeader
        title={`${greet}, ${user.name.split(' ')[0]}`}
        subtitle={caps.charges.length ? caps.charges.map((c) => `${c.postLabel}, ${c.unit.name}`).slice(0, 2).join(' · ') + (caps.charges.length > 2 ? ` +${caps.charges.length - 2}` : '') : user.designation}
        actions={<FyPicker />}
      />

      {/* Every module this officer can use, same list as the menu */}
      <div className="mb-2 grid grid-cols-2 gap-2.5 sm:grid-cols-3 xl:grid-cols-5">
        {modules.map((m) => (
          <Action key={m.to} to={m.to === '/explore' && primary ? `/units/${primary._id}` : m.to} icon={m.icon} label={m.label} count={counts[m.to]} />
        ))}
      </div>

      {/* Personal scores */}
      {myScore.data?.items.length ? (
        <>
          <SectionTitle>My performance · FY {fy}</SectionTitle>
          <div className={`grid gap-3 ${myScore.data.items.length > 1 ? '2xl:grid-cols-2' : ''}`}>
            {myScore.data.items.map((s) => (
              <Card key={s.post} className="overflow-hidden">
                <div className="h-1.5 bg-gradient-to-r from-brand-700 via-brand-500 to-gold-400" />
                <div className="p-5">
                  <div className="mb-4 flex items-center gap-4">
                    <ScoreGauge value={s.score} size={132} label={s.postLabel} />
                    <div className="min-w-0 flex-1 space-y-2">
                      <RevBandBadge band={s.band} size="md" />
                      <div className="text-xs text-slate-500">Revenue collected</div>
                      <div className="text-lg font-bold text-slate-900 dark:text-white">Rs {fmtPKR(s.collected)} <span className="text-xs font-normal text-slate-400">of {fmtPKR(s.target)}</span></div>
                      <Bullet value={s.target ? (s.collected / s.target) * 100 : null} height={8} />
                      <div className="text-[11px] text-slate-400">{s.units} unit{s.units === 1 ? '' : 's'} in charge</div>
                    </div>
                  </div>
                  <BlockBars blocks={s.blocks} />
                </div>
              </Card>
            ))}
          </div>
        </>
      ) : myScore.isLoading ? <Loading /> : null}

      {/* Every KPI head across the jurisdiction */}
      {unit.data && <KpiHeads data={unit.data} canDrill={caps.isOfficer} />}

      {/* Jurisdiction */}
      {caps.roots.length > 1 && (
        <>
          <SectionTitle>My jurisdiction</SectionTitle>
          <Card className="divide-y divide-slate-100 dark:divide-slate-800">
            {caps.roots.map((r) => (
              <Link key={r._id} to={`/units/${r._id}`} className="flex items-center gap-3 px-4 py-3 hover:bg-slate-50 dark:hover:bg-slate-800">
                <MapPin className="size-4 text-brand-600" />
                <span className="flex-1 font-medium">{r.name}</span>
                <span className="text-xs text-slate-500">{UNIT_LABEL[r.type]}</span>
              </Link>
            ))}
          </Card>
        </>
      )}
      {primary && (
        <>
          <SectionTitle action={<Link to={`/units/${primary._id}`} className="text-sm font-medium text-brand-600">Open</Link>}>
            {primary.name} · {UNIT_LABEL[primary.type]}
          </SectionTitle>
          {unit.isLoading ? <Loading /> : unit.error ? <ErrorState error={unit.error} retry={unit.refetch} /> : unit.data && <UnitBody data={unit.data} />}
        </>
      )}
      {caps.loaded && !caps.roots.length && (
        <Card><Empty title="No posting assigned" body="Ask the administrator to post you to a division, district, tehsil, qanungoi or patwar circle." /></Card>
      )}
    </>
  );
}

/** One tile per KPI head (plus arrears, audit paras and tasks) for the officer's jurisdiction. */
function KpiHeads({ data, canDrill }: { data: UnitData; canDrill: boolean }) {
  const tiles: { code: string; name: string; group: string; pct: number | null; detail: string; pace?: number | null }[] = [];
  for (const r of data.revenue) {
    if (!(r.target > 0)) continue;
    tiles.push({ code: r.code, name: r.name, group: 'Revenue', pct: r.pct, detail: `Rs ${fmtPKR(r.collected)} of ${fmtPKR(r.target)}`, pace: r.crop ? null : data.elapsed });
  }
  const ad = data.arrears.total;
  if (ad.demand > 0) tiles.push({ code: 'ARREARS', name: 'Arrears (all heads)', group: 'Revenue', pct: Math.min(100, (ad.collected / ad.demand) * 100), detail: `Rs ${fmtPKR(ad.collected)} of ${fmtPKR(ad.demand)}` });
  for (const c of data.cases) {
    const load = c.opening + c.received;
    if (!(load > 0)) continue;
    tiles.push({ code: c.code, name: c.name, group: 'Cases', pct: c.pct, detail: `${c.disposed.toLocaleString()} of ${load.toLocaleString()} disposed` });
  }
  if (data.audit.n) tiles.push({ code: 'AUDIT', name: 'Audit paras', group: 'Other', pct: data.audit.amt ? Math.min(100, (data.audit.rec / data.audit.amt) * 100) : null, detail: `${data.audit.settled} of ${data.audit.n} settled` });
  if (data.tasks.due) tiles.push({ code: 'TASKS', name: 'Tasks on time', group: 'Other', pct: (data.tasks.onTime / data.tasks.due) * 100, detail: `${data.tasks.onTime} of ${data.tasks.due}${data.tasks.overdue ? ` · ${data.tasks.overdue} overdue` : ''}` });
  if (!tiles.length) return null;

  return (
    <>
      <SectionTitle>KPIs · {data.unit.name}</SectionTitle>
      <div className="grid grid-cols-2 gap-2.5 md:grid-cols-3 xl:grid-cols-4">
        {tiles.map((t) => {
          const body = (
            <Card className="group h-full p-3.5 transition hover:ring-brand-200">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">{t.group}</div>
                  <div className="truncate text-sm font-medium text-slate-800 dark:text-slate-100" title={t.name}>{t.name}</div>
                </div>
                <span className="text-lg font-bold text-slate-900 tabular-nums dark:text-white">{t.pct == null ? '—' : `${Math.round(t.pct)}%`}</span>
              </div>
              <div className="my-2"><Bullet value={t.pct} pace={t.pace} height={7} /></div>
              <div className="flex items-center justify-between gap-1 text-[11px] text-slate-500">
                <span className="truncate">{t.detail}</span>
                {canDrill && <ChevronRight className="size-3.5 shrink-0 text-slate-300 group-hover:text-brand-600" />}
              </div>
            </Card>
          );
          return canDrill ? <Link key={t.code} to={`/staff?head=${t.code}`} title={`See every officer's ${t.name}`}>{body}</Link> : <div key={t.code}>{body}</div>;
        })}
      </div>
      {canDrill && <p className="mt-1.5 px-1 text-[11px] text-slate-400">Tap a KPI to see every subordinate ranked on it.</p>}
    </>
  );
}

function Action({ to, icon: Icon, label, count }: { to: string; icon: typeof MapPin; label: string; count?: number }) {
  return (
    <Link to={to}>
      <Card className="flex items-center gap-3 p-3.5 transition hover:ring-brand-200">
        <span className="grid size-10 place-items-center rounded-xl bg-brand-50 text-brand-700 dark:bg-brand-500/15 dark:text-brand-200"><Icon className="size-5" /></span>
        <span className="min-w-0 flex-1 text-sm font-medium leading-tight">{label}</span>
        {!!count && <span className="rounded-full bg-rose-500 px-2 text-xs font-semibold text-white">{count}</span>}
      </Card>
    </Link>
  );
}

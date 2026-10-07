import { useQuery } from '@tanstack/react-query';
import { ChevronRight, MapPin } from 'lucide-react';
import { Link } from 'react-router-dom';
import { PageHeader, useUnread, visibleNav } from '../components/AppShell';
import { BlockBars, FyPicker, RevBandBadge } from '../components/rev';
import { Card, Empty, Loading, SectionTitle } from '../components/ui';
import { Bullet, MetricCard, ScoreGauge, type MetricCardProps } from '../components/charts';
import { useViewMode } from '../lib/mode';
import { get } from '../lib/api';
import { useMe } from '../lib/auth';
import { MILLIONS, UNIT_LABEL, fmtPKR, useCaps, useFy, type Block, type RevBand } from '../lib/rev';
import { useUnit, type UnitData } from './UnitView';

interface MyScore { post: string; postLabel: string; score: number | null; band: RevBand; blocks: Record<Block, number | null>; target: number; collected: number; units: number }

export default function Home() {
  const { user } = useMe();
  const caps = useCaps();
  const [fy] = useFy();
  const elapsed = (() => { const y = Number(fy.slice(0, 4)); const st = new Date(y, 6, 1).getTime(); return Math.max(0, Math.min(100, ((Date.now() - st) / (new Date(y + 1, 6, 1).getTime() - st)) * 100)); })();
  const [mode] = useViewMode();
  const perf = mode === 'performance';
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
      <div className="grid grid-cols-4 gap-1.5 sm:grid-cols-3 sm:gap-2 lg:grid-cols-4 xl:grid-cols-6">
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
                <div className="h-1 bg-gradient-to-r from-brand-700 via-brand-500 to-gold-400" />
                <div className="p-4">
                  <div className={perf ? '' : 'mb-4 flex items-center gap-4'}>
                    {!perf && <ScoreGauge value={s.score} size={132} label={s.postLabel} />}
                    <div className="min-w-0 flex-1 space-y-2">
                      {!perf && <RevBandBadge band={s.band} size="md" />}
                      <MetricCard
                        title="Revenue — current year" achieved={s.collected} total={s.target} fmt={fmtPKR} unit={MILLIONS} compact
                        pace={elapsed}
                      />
                      <div className="text-[11px] text-slate-400">{s.postLabel} · {s.units} unit{s.units === 1 ? '' : 's'} in charge</div>
                    </div>
                  </div>
                  {!perf && <BlockBars blocks={s.blocks} />}
                </div>
              </Card>
            ))}
          </div>
        </>
      ) : myScore.isLoading ? <Loading /> : null}

      {/* Every KPI head across the jurisdiction */}
      {unit.data && <KpiHeads data={unit.data} canDrill />}

      {caps.loaded && !caps.roots.length && (
        <Card><Empty title="No posting assigned" body="Ask the administrator to post you to a division, district, tehsil, qanungoi or patwar circle." /></Card>
      )}
    </>
  );
}

/** One card per KPI head (plus arrears, audit paras and tasks) for the officer's jurisdiction. */
function KpiHeads({ data, canDrill }: { data: UnitData; canDrill: boolean }) {
  const count = (v: number) => v.toLocaleString();
  const cards: (MetricCardProps & { code: string })[] = [];
  for (const r of data.revenue) {
    if (!(r.target > 0)) continue;
    cards.push({
      code: r.code, eyebrow: 'Revenue', title: r.name, achieved: r.collected, total: r.target, fmt: fmtPKR, unit: MILLIONS,
      pace: r.crop ? null : data.elapsed,
      extras: r.pendingVerification > 0 ? [{ label: 'Unverified', value: fmtPKR(r.pendingVerification), tone: 'warn' }] : [],
    });
  }
  const ad = data.arrears.total;
  if (ad.demand > 0) cards.push({ code: 'ARREARS', eyebrow: 'Revenue', title: 'Arrears (all heads)', achieved: ad.collected, total: ad.demand, fmt: fmtPKR, labels: { total: 'Arrears' }, unit: MILLIONS });
  for (const c of data.cases) {
    const load = c.opening + c.received;
    if (!(load > 0)) continue;
    cards.push({
      code: c.code, eyebrow: 'Cases', title: c.name, achieved: c.disposed, total: load, fmt: count,
      labels: { total: 'Total', achieved: 'Disposed', balance: 'Pending' }, unit: '(Cases)',
      extras: [{ label: 'Opening', value: count(c.opening) }, { label: 'Received', value: count(c.received) }],
    });
  }
  if (data.audit.n) cards.push({
    code: 'AUDIT', eyebrow: 'Other', title: 'Audit paras', achieved: data.audit.rec, total: data.audit.amt, fmt: fmtPKR, labels: { total: 'Amount' }, unit: MILLIONS,
    extras: [{ label: 'Paras settled', value: `${data.audit.settled} / ${data.audit.n}` }],
  });
  if (data.tasks.due) cards.push({
    code: 'TASKS', eyebrow: 'Other', title: 'Tasks', achieved: data.tasks.onTime, total: data.tasks.due, fmt: count,
    labels: { total: 'Due', achieved: 'On time', balance: 'Late / open' }, unit: '(Tasks)',
    extras: [{ label: 'Open', value: count(data.tasks.open) }, ...(data.tasks.overdue ? [{ label: 'Overdue', value: count(data.tasks.overdue), tone: 'bad' as const }] : [])],
  });
  if (!cards.length) return null;

  return (
    <>
      <SectionTitle action={<Link to={`/units/${data.unit._id}`} className="text-[13px] font-medium text-brand-600 hover:underline">Full performance →</Link>}>KPIs · {data.unit.name} · {UNIT_LABEL[data.unit.type]}</SectionTitle>
      {/* Phones: one compact row per KPI */}
      <Card className="divide-y divide-slate-100 sm:hidden dark:divide-slate-800">
        {cards.map(({ code, ...c }) => {
          const p = c.total > 0 ? Math.min(100, (c.achieved / c.total) * 100) : null;
          const row = (
            <div className="px-3 py-2.5">
              <div className="flex items-baseline justify-between gap-2">
                <span className="min-w-0 truncate text-[13px] font-medium text-slate-800 dark:text-slate-100">{c.title}</span>
                <span className="shrink-0 text-sm font-bold text-slate-900 tabular-nums dark:text-white">{p == null ? '—' : `${Math.round(p)}%`}</span>
              </div>
              <div className="my-1.5"><Bullet value={p} pace={c.pace} height={6} /></div>
              <div className="flex justify-between gap-2 text-[11px] text-slate-600 tabular-nums dark:text-slate-300">
                <span>{c.fmt(c.achieved)} / {c.fmt(c.total)}</span>
                <span>{c.labels?.balance ?? 'Balance'} {c.fmt(Math.max(0, c.total - c.achieved))}</span>
              </div>
            </div>
          );
          return canDrill ? <Link key={code} to={`/staff?head=${code}`} className="block active:bg-slate-50 dark:active:bg-slate-800">{row}</Link> : <div key={code}>{row}</div>;
        })}
        <div className="py-1.5 text-center text-[10px] font-medium text-slate-400">Revenue {MILLIONS} · cases, paras and tasks as counts</div>
      </Card>
      <div className="hidden grid-cols-1 gap-2 sm:grid sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
        {cards.map(({ code, ...c }) =>
          canDrill ? (
            <Link key={code} to={`/staff?head=${code}`} title={`See every officer's ${c.title}`} className="group block rounded-xl transition hover:-translate-y-px hover:shadow-md">
              <MetricCard {...c} compact action={<ChevronRight className="size-4 text-slate-300 group-hover:text-brand-600" />} />
            </Link>
          ) : (
            <MetricCard key={code} {...c} compact />
          ),
        )}
      </div>
      {canDrill && <p className="mt-1.5 px-1 text-[11px] text-slate-400">Tap a KPI to see every subordinate ranked on it.</p>}
    </>
  );
}

function Action({ to, icon: Icon, label, count }: { to: string; icon: typeof MapPin; label: string; count?: number }) {
  return (
    <Link to={to}>
      {/* Phones: icon tile with a short label. Larger screens: icon + label row. */}
      <Card className="relative flex h-full flex-col items-center gap-1 p-2 text-center transition hover:ring-brand-200 sm:flex-row sm:gap-2.5 sm:p-2.5 sm:text-left">
        <span className="grid size-9 place-items-center rounded-lg bg-brand-50 text-brand-700 sm:size-8 dark:bg-brand-500/15 dark:text-brand-200"><Icon className="size-[18px] sm:size-4" /></span>
        <span className="min-w-0 flex-1 text-[11px] font-medium leading-tight sm:text-sm">{label}</span>
        {!!count && <span className="absolute right-1 top-1 rounded-full bg-rose-500 px-1.5 text-[10px] font-semibold text-white sm:static sm:px-2 sm:text-xs">{count}</span>}
      </Card>
    </Link>
  );
}

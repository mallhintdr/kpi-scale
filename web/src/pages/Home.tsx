import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { PageHeader } from '../components/AppShell';
import { BlockBars, FyPicker, RevBandBadge } from '../components/rev';
import { Card, Empty, Loading, SectionTitle } from '../components/ui';
import { MetricCard, ScoreGauge, type MetricCardProps } from '../components/charts';
import { useViewMode } from '../lib/mode';
import { TargetCard, useAssigned } from '../components/targets';
import { TargetSummary } from './Assigned';
import { get } from '../lib/api';
import { useMe } from '../lib/auth';
import { fmtPKR, getOrg, MILLIONS, T, UNIT_LABEL, useCaps, useFy, type Block, type RevBand } from '../lib/rev';
import { useUnit, type UnitData } from './UnitView';

interface MyScore { post: string; postLabel: string; score: number | null; band: RevBand; blocks: Record<Block, number | null>; target: number; collected: number; units: number }

export default function Home() {
  const { user } = useMe();
  const caps = useCaps();
  const [fy] = useFy();
  const elapsed = (() => { const y = Number(fy.slice(0, 4)); const st = new Date(y, 6, 1).getTime(); return Math.max(0, Math.min(100, ((Date.now() - st) / (new Date(y + 1, 6, 1).getTime() - st)) * 100)); })();
  const [mode] = useViewMode();
  const perf = mode !== 'kpi';
  const tmode = mode === 'targets';
  const myScore = useQuery({ queryKey: ['rev', 'my-score', fy], queryFn: () => get<{ items: MyScore[] }>(`/rev/my-score?fy=${fy}`), enabled: !!fy });
  const primary = caps.roots[0];
  const unit = useUnit(primary?._id, fy);

  const h = new Date().getHours();
  const greet = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';

  return (
    <>
      <PageHeader
        title={`${greet}, ${user.name.split(' ')[0]}`}
        subtitle={caps.charges.length ? caps.charges.map((c) => `${c.postLabel}, ${c.unit.name}`).slice(0, 2).join(' · ') + (caps.charges.length > 2 ? ` +${caps.charges.length - 2}` : '') : user.designation}
        actions={<FyPicker />}
      />

      {/* Personal scores */}
      {tmode && <MyTargets />}

      {!tmode && myScore.data?.items.length ? (
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
                        title={`${T.money} — current year`} achieved={s.collected} total={s.target} fmt={fmtPKR} unit={MILLIONS} compact
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
        <Card><Empty title="No posting assigned" body="Ask your administrator to post you to a unit." /></Card>
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
      code: r.code, eyebrow: 'Revenue', title: r.name, achieved: r.collected, total: r.target, fmt: r.unit === 'money' ? fmtPKR : (v: number) => v.toLocaleString(), unit: r.unit === 'money' ? MILLIONS : '(count)', labels: { achieved: T.achieved },
      pace: r.crop ? null : data.elapsed,
      extras: r.pendingVerification > 0 ? [{ label: 'Unverified', value: fmtPKR(r.pendingVerification), tone: 'warn' }] : [],
    });
  }
  const ad = data.arrears.total;
  if (ad.demand > 0) cards.push({ code: 'ARREARS', eyebrow: 'Revenue', title: 'Arrears (all KPIs)', achieved: ad.collected, total: ad.demand, fmt: fmtPKR, labels: { total: 'Arrears' }, unit: MILLIONS });
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
    code: 'AUDIT', eyebrow: 'Other', title: getOrg()?.registers.map((x) => x.label).join(' / ') || 'Registers', achieved: data.audit.rec, total: data.audit.amt, fmt: fmtPKR, labels: { total: 'Amount' }, unit: MILLIONS,
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
              <div className="flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-medium text-slate-800 dark:text-slate-100">{c.title}</div>
                  <div className="mt-0.5 flex flex-wrap gap-x-3 text-[11px] text-slate-600 tabular-nums dark:text-slate-300">
                    <span>{c.fmt(c.achieved)} / {c.fmt(c.total)}</span>
                    <span>{c.labels?.balance ?? 'Balance'} {c.fmt(Math.max(0, c.total - c.achieved))}</span>
                  </div>
                </div>
                <span className="shrink-0 text-base font-bold text-slate-900 tabular-nums dark:text-white">{p == null ? '—' : `${Math.round(p)}%`}</span>
              </div>
            </div>
          );
          return canDrill ? <Link key={code} to={`/staff?head=${code}`} className="block active:bg-slate-50 dark:active:bg-slate-800">{row}</Link> : <div key={code}>{row}</div>;
        })}
        <div className="py-1.5 text-center text-[10px] font-medium text-slate-400">{T.money} {MILLIONS} · other KPIs as counts</div>
      </Card>
      <KpiTable cards={cards} canDrill={canDrill} />
      {canDrill && <p className="mt-1.5 px-1 text-[11px] text-slate-400">Tap a KPI to see every subordinate ranked on it.</p>}
    </>
  );
}

type KpiRowData = MetricCardProps & { code: string };
const GROUPS: { key: string; label: string }[] = [
  { key: 'Revenue', label: `${T.money} · ${MILLIONS}` },
  { key: 'Cases', label: 'Case registers · (cases)' },
  { key: 'Other', label: 'Registers & tasks' },
];

/** Desktop / tablet KPI view: one aligned table, grouped by category, one KPI per row. */
function KpiTable({ cards, canDrill }: { cards: KpiRowData[]; canDrill: boolean }) {
  const navigate = useNavigate();
  const th = 'border-b border-r border-white/50 px-3 py-2.5 text-center font-semibold';
  const td = 'border-b border-r border-b-slate-200 border-r-slate-300 px-3 py-2 text-right tabular-nums dark:border-slate-700';
  let n = 0;
  return (
    <Card className="hidden overflow-hidden sm:block">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] border-separate border-spacing-0 text-[13px]">
          <thead className="bg-brand-700 text-center text-[12.5px] uppercase tracking-wide text-white">
            <tr>
              <th className="w-10 border-b border-r border-white/50 px-1 py-2.5 text-center font-semibold">#</th>
              <th className="border-b border-r border-white/50 px-3 py-2.5 text-center font-semibold">KPI</th>
              <th className={th}>Target</th>
              <th className={th}>Achieved</th>
              <th className={th}>Balance</th>
              <th className={th}>Expected by now</th>
              <th className={th}>Ahead / short</th>
              <th className="w-16 border-b border-white/50 px-3 py-2.5 text-center font-semibold">%</th>
            </tr>
          </thead>
          <tbody>
            {GROUPS.map((g) => {
              const rows = cards.filter((c) => c.eyebrow === g.key);
              if (!rows.length) return null;
              return [
                <tr key={g.key}>
                  <td colSpan={8} className="border-b border-slate-300 bg-brand-50 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-brand-800 dark:border-slate-600 dark:bg-brand-500/10 dark:text-brand-200">{g.label}</td>
                </tr>,
                ...rows.map((c) => {
                  n += 1;
                  const p = c.total > 0 ? Math.min(100, (c.achieved / c.total) * 100) : null;
                  const expected = c.pace != null && c.total > 0 ? (c.total * c.pace) / 100 : null;
                  const gap = expected != null ? c.achieved - expected : null;
                  return (
                    <tr key={c.code} onClick={canDrill ? () => navigate(`/staff?head=${c.code}`) : undefined}
                      title={canDrill ? `See every officer's ${c.title}` : undefined}
                      className={canDrill ? 'group cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/60' : ''}>
                      <td className="border-b border-r border-b-slate-200 border-r-slate-300 text-center text-xs font-semibold text-slate-500 tabular-nums dark:border-slate-700">{n}</td>
                      <td className="border-b border-r border-b-slate-200 border-r-slate-300 px-3 py-2 dark:border-slate-700">
                        <span className="font-medium text-slate-900 decoration-2 underline-offset-2 group-hover:underline dark:text-white">{c.title}</span>
                        {c.extras?.filter((e) => e.label === 'Unverified').map((e) => <span key={e.label} className="ml-2 text-[11px] font-medium text-amber-700">+{e.value} unverified</span>)}
                      </td>
                      <td className={td}>{c.fmt(c.total)}</td>
                      <td className={`${td} font-semibold text-slate-900 dark:text-white`}>{c.fmt(c.achieved)}</td>
                      <td className={td}>{c.fmt(Math.max(0, c.total - c.achieved))}</td>
                      <td className={`${td} text-slate-500`}>{expected == null ? '—' : c.fmt(expected)}</td>
                      <td className={`${td} font-medium ${gap == null ? 'text-slate-400' : gap >= 0 ? 'text-emerald-700 dark:text-emerald-400' : 'text-rose-700 dark:text-rose-400'}`}>
                        {gap == null ? '—' : `${gap >= 0 ? '+' : '−'}${c.fmt(Math.abs(gap))}`}
                      </td>
                      <td className="border-b border-b-slate-200 px-3 py-2 text-right font-bold text-slate-900 tabular-nums dark:border-slate-700 dark:text-white">{p == null ? '—' : `${Math.round(p)}%`}</td>
                    </tr>
                  );
                }),
              ];
            })}
          </tbody>
        </table>
      </div>
      <div className="border-t border-slate-200 px-3 py-1.5 text-center text-[10px] font-medium text-slate-400 dark:border-slate-700">
        "Expected by now" assumes an even pace through the year; tagged (seasonal) KPIs show "—".
      </div>
    </Card>
  );
}

/** Targets mode on Home: targets assigned to me (and, for officers, the ones I assigned). */
function MyTargets() {
  const { user } = useMe();
  const caps = useCaps();
  const mine = useAssigned('mine', undefined, 'all');
  const byMe = useAssigned('assigned', undefined, 'all');
  const open = (mine.data ?? []).filter((t) => t.state === 'running' || t.state === 'upcoming');
  return (
    <>
      <SectionTitle action={<Link to="/assigned" className="text-[13px] font-medium text-brand-600 hover:underline">All targets →</Link>}>My assigned targets</SectionTitle>
      {mine.isLoading ? <Loading /> : !mine.data?.length ? (
        <Card><Empty title="No targets assigned to you yet" /></Card>
      ) : (
        <>
          <TargetSummary items={mine.data} />
          <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {(open.length ? open : mine.data.slice(0, 3)).map((t) => <TargetCard key={t._id} t={t} viewer={user.id} compact />)}
          </div>
        </>
      )}
      {caps.isOfficer && !!byMe.data?.length && (
        <>
          <SectionTitle action={<Link to="/assigned?box=assigned" className="text-[13px] font-medium text-brand-600 hover:underline">Manage →</Link>}>Targets I assigned</SectionTitle>
          <TargetSummary items={byMe.data} />
        </>
      )}
    </>
  );
}

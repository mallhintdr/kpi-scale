import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { PageHeader } from '../components/AppShell';
import { FyPicker, RevBandBadge } from '../components/rev';
import { Card, Empty, Loading, SectionTitle } from '../components/ui';
import { type MetricCardProps } from '../components/charts';
import { useViewMode } from '../lib/mode';
import { TargetCard, useAssigned } from '../components/targets';
import { TargetSummary } from './Assigned';
import { get } from '../lib/api';
import { useMe } from '../lib/auth';
import { BLOCK_LABEL, fmtPKR, getOrg, MILLIONS, T, UNIT_LABEL, useCaps, useFy, type Block, type RevBand } from '../lib/rev';
import { useUnit, type UnitData } from './UnitView';

interface MyScore { post: string; postLabel: string; score: number | null; band: RevBand; blocks: Record<Block, number | null>; weights?: Record<Block, number>; target: number; collected: number; units: number }

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
          <MyPerformanceTable items={myScore.data.items} perf={perf} elapsed={elapsed} />
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

/** The official's own position, one row per post held: target, achieved, balance, pace and (KPI mode) score. */
function MyPerformanceTable({ items, perf, elapsed }: { items: MyScore[]; perf: boolean; elapsed: number }) {
  const th = 'border-b border-r border-white/50 px-1.5 py-2 text-center font-semibold sm:px-3 sm:py-2.5';
  const td = 'border-b border-r border-b-slate-200 border-r-slate-300 px-1.5 py-2 text-right tabular-nums sm:px-3 dark:border-slate-700';
  const wide = 'hidden md:table-cell';
  const blocks = getOrg()?.blocks ?? [];
  return (
    <Card className="overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full border-separate border-spacing-0 text-[12px] sm:text-[13px]">
          <thead className="bg-brand-700 text-center text-[11px] uppercase tracking-wide text-white sm:text-[12.5px]">
            <tr>
              <th className={th}>Post</th>
              <th className={th}>Target</th>
              <th className={th}>{T.achieved}</th>
              <th className={th}>Balance</th>
              <th className={`${th} ${wide}`}>Expected by Now</th>
              <th className={`${th} ${wide}`}>Ahead / Short</th>
              <th className={th}>%</th>
              {!perf && <th className={th}>Score</th>}
              {!perf && <th className="border-b border-white/50 px-1.5 py-2 text-center font-semibold sm:px-3">Band</th>}
            </tr>
          </thead>
          <tbody>
            {items.map((s) => {
              const pct = s.target > 0 ? Math.min(100, (s.collected / s.target) * 100) : null;
              const expected = s.target > 0 ? (s.target * elapsed) / 100 : null;
              const gap = expected != null ? s.collected - expected : null;
              return (
                <tr key={s.post}>
                  <td className="border-b border-r border-b-slate-200 border-r-slate-300 px-1.5 py-2 sm:px-3 dark:border-slate-700">
                    <div className="font-medium text-slate-900 dark:text-white">{s.postLabel}</div>
                    <div className="text-[11px] text-slate-500">{s.units} unit{s.units === 1 ? '' : 's'} in charge</div>
                  </td>
                  <td className={td}>{fmtPKR(s.target)}</td>
                  <td className={`${td} font-semibold text-slate-900 dark:text-white`}>{fmtPKR(s.collected)}</td>
                  <td className={td}>{fmtPKR(Math.max(0, s.target - s.collected))}</td>
                  <td className={`${td} ${wide} text-slate-500`}>{expected == null ? '—' : fmtPKR(expected)}</td>
                  <td className={`${td} ${wide} font-medium ${gap == null ? 'text-slate-400' : gap >= 0 ? 'text-emerald-700 dark:text-emerald-400' : 'text-rose-700 dark:text-rose-400'}`}>{gap == null ? '—' : `${gap >= 0 ? '+' : '−'}${fmtPKR(Math.abs(gap))}`}</td>
                  <td className={`${td} font-bold text-slate-900 dark:text-white`}>{pct == null ? '—' : `${Math.round(pct)}%`}</td>
                  {!perf && <td className={`${td} font-bold text-slate-900 dark:text-white`}>{s.score == null ? '—' : Math.round(s.score)}</td>}
                  {!perf && <td className="border-b border-b-slate-200 px-1.5 py-2 text-center sm:px-3 dark:border-slate-700"><RevBandBadge band={s.band} /></td>}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {/* KPI evaluation: the score broken down by block, as a table too */}
      {!perf && (
        <div className="overflow-x-auto border-t border-slate-200 dark:border-slate-700">
          <table className="w-full border-separate border-spacing-0 text-[12px] sm:text-[13px]">
            <thead className="bg-brand-600 text-center text-[11px] text-brand-50">
              <tr>
                <th className="border-b border-r border-white/30 px-2 py-1.5">Block</th>
                {items.map((s) => <th key={s.post} className="border-b border-r border-white/30 px-2 py-1.5">{s.postLabel}</th>)}
              </tr>
            </thead>
            <tbody>
              {blocks.map((b) => (
                <tr key={b.key}>
                  <td className="border-b border-r border-b-slate-200 border-r-slate-300 px-2 py-1.5 dark:border-slate-700">{BLOCK_LABEL[b.key]}</td>
                  {items.map((s) => (
                    <td key={s.post} className="border-b border-r border-b-slate-200 border-r-slate-300 px-2 py-1.5 text-right tabular-nums dark:border-slate-700">
                      {s.blocks[b.key] == null ? <span className="text-slate-400">Not applicable</span> : <><b>{Math.round(s.blocks[b.key] as number)}</b>{s.weights?.[b.key] != null && <span className="ml-1 text-[11px] text-slate-500">(weight {s.weights[b.key]}%)</span>}</>}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="border-t border-slate-200 px-3 py-1.5 text-center text-[10px] font-medium text-slate-400 dark:border-slate-700">{MILLIONS} · {Math.round(elapsed)}% of the year gone</div>
    </Card>
  );
}

/** One row per KPI head (plus arrears, registers and tasks) for the officer's jurisdiction. */
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
  if (ad.demand > 0) cards.push({ code: 'ARREARS', eyebrow: 'Revenue', title: 'Arrears (All KPIs)', achieved: ad.collected, total: ad.demand, fmt: fmtPKR, labels: { total: 'Arrears' }, unit: MILLIONS });
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
    labels: { total: 'Due', achieved: 'On Time', balance: 'Late / open' }, unit: '(Tasks)',
    extras: [{ label: 'Open', value: count(data.tasks.open) }, ...(data.tasks.overdue ? [{ label: 'Overdue', value: count(data.tasks.overdue), tone: 'bad' as const }] : [])],
  });
  if (!cards.length) return null;

  return (
    <>
      <SectionTitle action={<Link to={`/units/${data.unit._id}`} className="text-[13px] font-medium text-brand-600 hover:underline">Full Performance →</Link>}>KPIs · {data.unit.name} · {UNIT_LABEL[data.unit.type]}</SectionTitle>
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
  const th = 'border-b border-r border-white/50 px-1.5 py-2 text-center font-semibold sm:px-3 sm:py-2.5';
  const td = 'border-b border-r border-b-slate-200 border-r-slate-300 px-1.5 py-2 text-right tabular-nums sm:px-3 dark:border-slate-700';
  // Shown from tablets up; phones keep KPI · Target · Achieved · Balance · %
  const wide = 'hidden md:table-cell';
  let n = 0;
  return (
    <Card className="overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full border-separate border-spacing-0 text-[12px] sm:text-[13px]">
          <thead className="bg-brand-700 text-center text-[11px] uppercase tracking-wide text-white sm:text-[12.5px]">
            <tr>
              <th className="hidden w-10 border-b border-r border-white/50 px-1 py-2.5 text-center font-semibold sm:table-cell">#</th>
              <th className="border-b border-r border-white/50 px-1.5 py-2 text-center font-semibold sm:px-3 sm:py-2.5">KPI</th>
              <th className={th}>Target</th>
              <th className={th}>Achieved</th>
              <th className={th}>Balance</th>
              <th className={`${th} ${wide}`}>Expected by Now</th>
              <th className={`${th} ${wide}`}>Ahead / Short</th>
              <th className="w-12 border-b border-white/50 px-1.5 py-2 text-center font-semibold sm:w-16 sm:px-3 sm:py-2.5">%</th>
            </tr>
          </thead>
          <tbody>
            {GROUPS.map((g) => {
              const rows = cards.filter((c) => c.eyebrow === g.key);
              if (!rows.length) return null;
              return [
                <tr key={g.key}>
                  <td colSpan={8} className="border-b border-slate-300 bg-brand-50 px-2 py-1.5 sm:px-3 text-[11px] font-semibold uppercase tracking-wide text-brand-800 dark:border-slate-600 dark:bg-brand-500/10 dark:text-brand-200">{g.label}</td>
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
                      <td className="hidden border-b border-r border-b-slate-200 border-r-slate-300 text-center text-xs font-semibold text-slate-500 tabular-nums sm:table-cell dark:border-slate-700">{n}</td>
                      <td className="border-b border-r border-b-slate-200 border-r-slate-300 px-1.5 py-2 sm:px-3 dark:border-slate-700">
                        <span className="font-medium leading-tight text-slate-900 decoration-2 underline-offset-2 group-hover:underline dark:text-white">{c.title}</span>
                        {c.extras?.filter((e) => e.label === 'Unverified').map((e) => <span key={e.label} className="block text-[10.5px] font-medium text-amber-700 sm:ml-2 sm:inline sm:text-[11px]">+{e.value} unverified</span>)}
                      </td>
                      <td className={td}>{c.fmt(c.total)}</td>
                      <td className={`${td} font-semibold text-slate-900 dark:text-white`}>{c.fmt(c.achieved)}</td>
                      <td className={td}>{c.fmt(Math.max(0, c.total - c.achieved))}</td>
                      <td className={`${td} ${wide} text-slate-500`}>{expected == null ? '—' : c.fmt(expected)}</td>
                      <td className={`${td} ${wide} font-medium ${gap == null ? 'text-slate-400' : gap >= 0 ? 'text-emerald-700 dark:text-emerald-400' : 'text-rose-700 dark:text-rose-400'}`}>
                        {gap == null ? '—' : `${gap >= 0 ? '+' : '−'}${c.fmt(Math.abs(gap))}`}
                      </td>
                      <td className="border-b border-b-slate-200 px-1.5 py-2 text-right font-bold sm:px-3 text-slate-900 tabular-nums dark:border-slate-700 dark:text-white">{p == null ? '—' : `${Math.round(p)}%`}</td>
                    </tr>
                  );
                }),
              ];
            })}
          </tbody>
        </table>
      </div>
      <div className="border-t border-slate-200 px-3 py-1.5 text-center text-[10px] font-medium text-slate-400 dark:border-slate-700">
        {MILLIONS} for money KPIs · "Expected by now" assumes an even pace through the year; seasonal KPIs show "—"
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

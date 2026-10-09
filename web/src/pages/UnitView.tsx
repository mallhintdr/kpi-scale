import { useQuery } from '@tanstack/react-query';
import { ArrowDownRight, ArrowUpRight, ChevronRight, Phone, Timer } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { PageHeader } from '../components/AppShell';
import { BandChip, Bullet, CaseBars, CollectionTrend, MetricCard, RankBars, Ring, ScoreGauge, type TrendData } from '../components/charts';
import { BlockBars, FyPicker } from '../components/rev';
import { achievement, useViewMode } from '../lib/mode';
import { TargetCard, useAssigned } from '../components/targets';
import { TargetSummary } from './Assigned';
import { useMe } from '../lib/auth';
import { Badge, Card, Empty, ErrorState, Loading, Segmented, UnitCaption } from '../components/ui';
import { get } from '../lib/api';
import { fmtPct, fmtPKR, fmtValue, getOrg, MILLIONS, staffedLevel, T, tagLabel, UNIT_LABEL, useFy, type Block, type RevBand, type UnitRef } from '../lib/rev';

export interface UnitData {
  fy: string;
  elapsed: number;
  unit: UnitRef;
  path: UnitRef[];
  level: string;
  score: number | null;
  band: RevBand;
  blocks: Record<Block, number | null>;
  weights: Record<Block, number>;
  configSource: string | null;
  revenue: { code: string; name: string; group: string; crop: string | null; tag: string | null; unit: 'money' | 'count' | 'number'; block: string; target: number; collected: number; pct: number | null; arrearDemand: number; arrearCollected: number; arrearPct: number | null; pendingVerification: number }[];
  cases: { code: string; name: string; block: string; unit?: string; level: string; opening: number; received: number; disposed: number; pending: number; pct: number | null }[];
  arrears: Record<'total' | 'rabi' | 'kharif' | 'other', { demand: number; collected: number }>;
  totals: { target: number; collected: number; pending: number; untargeted: number; headsWithTarget: number };
  audit: { amt: number; rec: number; n: number; settled: number };
  registers?: { key: string; label: string; block: string; amt: number; rec: number; n: number; settled: number }[];
  tasks: { due: number; onTime: number; open: number; overdue: number };
  children: (UnitRef & { score: number | null; band: RevBand; rank: number | null; target: number; collected: number; blocks: Record<Block, number | null> })[];
  holders: Holder[];
  childHolders: Holder[];
  trend: TrendData;
}
interface Holder { unitId: string; post: string; postLabel: string; chargeType: string; user: { _id: string; name: string; designation?: string; bps?: number; phone?: string } }

export const useUnit = (id: string | undefined, fy: string) =>
  useQuery({ queryKey: ['rev', 'unit', id, fy], queryFn: () => get<UnitData>(`/rev/units/${id}?fy=${fy}`), enabled: !!id && !!fy });


export default function UnitView() {
  const { id } = useParams();
  const [fy] = useFy();
  const { data, isLoading, error, refetch } = useUnit(id, fy);
  return (
    <>
      <PageHeader title={data?.unit.name ?? 'Performance'} subtitle={data && <Breadcrumb path={data.path} />} actions={<FyPicker />} />
      {isLoading ? <Loading /> : error ? <ErrorState error={error} retry={refetch} /> : data && <UnitBody data={data} />}
    </>
  );
}

export function Breadcrumb({ path }: { path: UnitRef[] }) {
  return (
    <span className="flex flex-wrap items-center gap-x-1">
      {path.slice(0, -1).map((p) => (
        <span key={p._id} className="flex items-center gap-1">
          <Link to={`/units/${p._id}`} className="hover:text-brand-600 hover:underline">{p.name}</Link>
          <ChevronRight className="size-3" />
        </span>
      ))}
      <span>{path.length ? UNIT_LABEL[path[path.length - 1].type] : ''}</span>
    </span>
  );
}

const pct = (a: number, b: number) => (b > 0 ? Math.min(100, (a / b) * 100) : null);

/* ================================================================== */

export function UnitBody({ data }: { data: UnitData }) {
  const [tab, setTab] = useState<'heads' | 'ranking' | 'arrears' | 'officers'>('heads');
  const childType = data.children[0]?.type;
  const collectedPct = pct(data.totals.collected, data.totals.target);
  const gap = collectedPct == null ? null : collectedPct - data.elapsed;
  const cases = data.cases.reduce((a, c) => ({ load: a.load + c.opening + c.received, disp: a.disp + c.disposed }), { load: 0, disp: 0 });
  const [mode] = useViewMode();
  const perf = mode !== 'kpi';
  const tmode = mode === 'targets';
  // Plain achievement per area (Performance mode) — not weighted, not capped by scoring rules
  // Performance mode: plain achievement per scoring block (no weights)
  const achieved: Record<Block, number | null> = Object.fromEntries((getOrg()?.blocks ?? []).map((b) => {
    if (b.kind === 'target') {
      const rows = data.revenue.filter((r) => r.block === b.key && r.target > 0);
      if (!rows.length) return [b.key, null];
      // Same-unit money KPIs add up; otherwise average each KPI's achievement
      if (rows.every((r) => r.unit === 'money')) return [b.key, achievement(rows.reduce((x, r) => x + r.collected, 0), rows.reduce((x, r) => x + r.target, 0))];
      return [b.key, rows.reduce((x, r) => x + (achievement(r.collected, r.target) ?? 0), 0) / rows.length];
    }
    if (b.kind === 'arrears') return [b.key, achievement(data.arrears.total.collected, data.arrears.total.demand)];
    if (b.kind === 'flow') {
      const rows = data.cases.filter((c) => c.block === b.key);
      return [b.key, achievement(rows.reduce((x, c) => x + c.disposed, 0), rows.reduce((x, c) => x + c.opening + c.received, 0))];
    }
    if (b.kind === 'register') {
      const regs = (data.registers ?? []).filter((r) => r.block === b.key && r.n > 0);
      return [b.key, regs.length ? achievement(regs.reduce((x, r) => x + r.rec, 0), regs.reduce((x, r) => x + r.amt, 0)) : null];
    }
    return [b.key, achievement(data.tasks.onTime, data.tasks.due)];
  }));

  return (
    <div className="space-y-3">
      {/* ---------- Hero ---------- */}
      <Card className="overflow-hidden">
        <div className="h-1.5 bg-gradient-to-r from-brand-700 via-brand-500 to-gold-400" />
        <div className="grid gap-4 p-4 lg:grid-cols-[auto_1fr] lg:gap-6">
          <div className="flex items-center gap-5 lg:flex-col lg:items-center lg:gap-2">
            <ScoreGauge value={perf ? collectedPct : data.score} size={148} label={perf ? 'Achievement %' : 'Overall score'} />
            <div className="space-y-2 lg:text-center">
              {!perf && <BandChip band={data.band} size="md" />}
              {gap != null && (
                <div className={`flex items-center gap-1 text-xs font-medium lg:justify-center ${gap >= 0 ? 'text-emerald-700 dark:text-emerald-400' : 'text-rose-700 dark:text-rose-400'}`}>
                  {gap >= 0 ? <ArrowUpRight className="size-3.5" /> : <ArrowDownRight className="size-3.5" />}
                  {Math.abs(Math.round(gap))} pts {gap >= 0 ? 'ahead of' : 'behind'} pace
                </div>
              )}
              <div className="flex items-center gap-1 text-[11px] text-slate-500 lg:justify-center"><Timer className="size-3" />{data.elapsed}% of FY {data.fy} elapsed</div>
            </div>
          </div>
          {perf ? <BlockBars blocks={achieved} note={false} /> : <BlockBars blocks={data.blocks} weights={data.weights} />}
        </div>
      </Card>

      {/* ---------- Headline tiles ---------- */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          title={`${T.money} — current year`} achieved={data.totals.collected} total={data.totals.target} fmt={fmtPKR} pace={data.elapsed}
          extras={[
            ...(data.totals.pending > 0 ? [{ label: 'Unverified', value: fmtPKR(data.totals.pending), tone: 'warn' as const }] : []),
            ...(data.totals.untargeted > 0 ? [{ label: `${T.achieved} without target (not counted)`, value: fmtPKR(data.totals.untargeted), tone: 'muted' as const }] : []),
          ]} unit={MILLIONS}
        />
        <MetricCard title="Arrears — earlier years" achieved={data.arrears.total.collected} total={data.arrears.total.demand} fmt={fmtPKR} labels={{ total: 'Arrears' }} unit={MILLIONS} />
        <MetricCard title={T.flowGroup} achieved={cases.disp} total={cases.load} fmt={(v) => v.toLocaleString()} labels={{ total: 'Total', achieved: T.disposed, balance: T.pending }} unit={`(${T.items[0].toUpperCase()}${T.items.slice(1)})`} />
        <MetricCard
          title={getOrg()?.registers.map((x) => x.label).join(' / ') || 'Registers'} achieved={data.audit.rec} total={data.audit.amt} fmt={fmtPKR} labels={{ total: 'Amount' }}
          action={<Link to="/audit-paras" className="text-[12px] font-medium text-brand-600 hover:underline">Details</Link>}
          extras={data.audit.n ? [{ label: 'Items settled', value: `${data.audit.settled} / ${data.audit.n}` }] : []} unit={data.audit.n ? MILLIONS : '(None recorded)'}
        />
      </div>

      {tmode && <AreaTargets unitId={data.unit._id} />}

      {/* ---------- Trend ---------- */}
      <ChartCard title={`${T.money} trend`} subtitle="Verified achievement against the year's target">
        <CollectionTrend trend={data.trend} target={data.totals.target} />
      </ChartCard>

      <Segmented
        value={tab}
        onChange={setTab}
        options={[
          { value: 'heads', label: 'Heads' },
          ...(data.children.length ? [{ value: 'ranking' as const, label: childType ? `${UNIT_LABEL[childType]}s` : 'Units' }] : []),
          { value: 'arrears', label: 'Arrears' },
          ...(data.holders.length + data.childHolders.length ? [{ value: 'officers' as const, label: 'Officers' }] : []),
        ]}
      />
      {tab === 'heads' && <Heads data={data} />}
      {tab === 'ranking' && <Ranking data={data} />}
      {tab === 'arrears' && <Arrears data={data} />}
      {tab === 'officers' && <Officers data={data} />}
    </div>
  );
}

export function ChartCard({ title, subtitle, children, action }: { title: string; subtitle?: string; children: ReactNode; action?: ReactNode }) {
  return (
    <Card className="p-3.5 sm:p-4">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h3 className="text-[15px] font-semibold text-slate-900 dark:text-white">{title}</h3>
          {subtitle && <p className="text-xs text-slate-500">{subtitle}</p>}
        </div>
        {action}
      </div>
      {children}
    </Card>
  );
}

/* ---------- Heads: bullet bars grouped by head family ---------- */
function Heads({ data }: { data: UnitData }) {
  const rows = data.revenue.filter((r) => r.target > 0 || r.collected > 0);
  const groups = [...new Set(rows.map((r) => r.group))];
  const cases = data.cases.filter((c) => c.opening + c.received > 0);
  return (
    <div className="grid gap-3 xl:grid-cols-2">
      <ChartCard
        title={`${T.money} by KPI`}
        subtitle="Current-year demand · bar = collected, tick = where an even pace would be today"
      >
        {!rows.length ? <Empty title="No demand set for this year" /> : (
          <div className="space-y-4">
            {groups.map((g) => (
              <div key={g}>
                <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-400">{g}</div>
                <div className="space-y-3">
                  {rows.filter((r) => r.group === g).map((r) => (
                    <div key={r.code}>
                      <div className="mb-1 flex items-baseline justify-between gap-2 text-sm">
                        <span className="truncate text-slate-700 dark:text-slate-200">{r.tag && rows.filter((x) => x.group === g).length > 1 ? tagLabel(r.tag) : r.name}</span>
                        <span className="shrink-0 text-xs text-slate-500">
                          <b className="text-sm text-slate-900 tabular-nums dark:text-white">{fmtPct(r.pct == null ? null : Math.round(r.pct))}</b>
                          <span className="ml-1.5 tabular-nums">{fmtValue(r.collected, r.unit)} / {fmtValue(r.target, r.unit)}</span>
                        </span>
                      </div>
                      <Bullet value={r.pct} pace={r.tag ? null : data.elapsed} height={10} />
                    </div>
                  ))}
                </div>
              </div>
            ))}
            <p className="text-[11px] text-slate-400">Crop heads (Rabi, Kharif) are seasonal, so they show no even-pace tick.</p>
            <UnitCaption>{MILLIONS}</UnitCaption>
          </div>
        )}
      </ChartCard>

      <ChartCard title="Case registers" subtitle="Opening + received this year · disposed vs still pending">
        {cases.length ? <CaseBars items={cases} /> : <Empty title="No cases recorded" />}
      </ChartCard>
    </div>
  );
}

/* ---------- Ranking ---------- */
function Ranking({ data }: { data: UnitData }) {
  const navigate = useNavigate();
  const [mode] = useViewMode();
  const perf = mode !== 'kpi';
  const value = (c: UnitData['children'][number]) => (perf ? achievement(c.collected, c.target) : c.score);
  const ordered = [...data.children].sort((a, b) => (value(b) ?? -1) - (value(a) ?? -1));
  const holderOf = (unitId: string) => data.childHolders.filter((h) => h.unitId === unitId && !['wasilbaqi', 'sci'].includes(h.post));
  return (
    <div className="grid gap-4 xl:grid-cols-[3fr_2fr]">
      <ChartCard title={`${data.children[0] ? UNIT_LABEL[data.children[0].type] : 'Unit'} ${perf ? 'achievement %' : 'scores'}`} subtitle={perf ? `${T.money} ${T.achieved.toLowerCase()} against target` + ' · click a bar to drill down' : 'Weighted KPI score · click a bar to drill down'}>
        <RankBars
          items={ordered.map((c) => ({ id: c._id, name: c.name, score: value(c), sub: c.target ? `${fmtPKR(c.collected)} / ${fmtPKR(c.target)} ${MILLIONS}` : undefined }))}
          onPick={(id) => navigate(`/units/${id}`)}
        />
      </ChartCard>
      <Card className="divide-y divide-slate-200 self-start overflow-hidden dark:divide-slate-700">
        <div className="flex bg-brand-700 text-[11px] font-semibold uppercase tracking-wide text-white">
          <span className="w-10 shrink-0 border-r border-white/20 py-2.5 text-center">#</span>
          <span className="flex-1 px-3 py-2.5">{data.children[0] ? UNIT_LABEL[data.children[0].type] : 'Unit'} · officers</span>
          <span className="px-3 py-2.5">{perf ? 'Achieved' : 'Band'}</span>
        </div>
        {ordered.map((c, i) => {
          const h = holderOf(c._id);
          const v = value(c);
          return (
            <Link key={c._id} to={`/units/${c._id}`} className="flex items-stretch hover:bg-slate-50 dark:hover:bg-slate-800">
              <span className="flex w-10 shrink-0 items-center justify-center border-r border-slate-200 text-xs font-bold text-slate-500 tabular-nums dark:border-slate-700">{v == null ? '–' : i + 1}</span>
              <div className="flex min-w-0 flex-1 items-center gap-3 px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{c.name}</div>
                <div className="truncate text-[11px] text-slate-500">
                  {h.length ? h.map((x) => x.user.name).join(', ') : staffedLevel(c.type) ? <span className="text-amber-600">Vacant</span> : '—'}
                </div>
              </div>
              {perf ? <span className="text-sm font-bold text-slate-900 tabular-nums dark:text-white">{v == null ? '—' : `${Math.round(v)}%`}</span> : <BandChip band={c.band} />}
              </div>
            </Link>
          );
        })}
      </Card>
    </div>
  );
}

/* ---------- Arrears ---------- */
function Arrears({ data }: { data: UnitData }) {
  const a = data.arrears;
  const rows = data.revenue.filter((r) => r.arrearDemand > 0);
  const tiles = [
    { k: 'total' as const, label: 'All heads' },
    { k: 'rabi' as const, label: 'Rabi crop' },
    { k: 'kharif' as const, label: 'Kharif crop' },
    { k: 'other' as const, label: 'Non-crop heads' },
  ];
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {tiles.map((t) => {
          const p = pct(a[t.k].collected, a[t.k].demand);
          return (
            <Card key={t.k} className="flex items-center gap-3 p-4">
              <Ring value={p} size={64} stroke={7}><span className="text-xs">{p == null ? '—' : `${Math.round(p)}%`}</span></Ring>
              <div className="min-w-0">
                <div className="text-xs font-medium text-slate-500">{t.label}</div>
                <div className="text-base font-bold text-slate-900 tabular-nums dark:text-white">{fmtPKR(a[t.k].collected)}</div>
                <div className="text-[11px] text-slate-400 tabular-nums">/ {fmtPKR(a[t.k].demand)}</div>
                <div className="text-[10px] text-slate-400">{MILLIONS}</div>
              </div>
            </Card>
          );
        })}
      </div>
      <ChartCard title="Arrears by KPI" subtitle="Uncollected demand from earlier years">
        <div className="space-y-3">
          {rows.map((r) => (
            <div key={r.code}>
              <div className="mb-1 flex items-baseline justify-between gap-2 text-sm">
                <span className="truncate text-slate-700 dark:text-slate-200">{r.name}</span>
                <span className="shrink-0 text-xs text-slate-500">
                  <b className="text-sm text-slate-900 tabular-nums dark:text-white">{fmtPct(r.arrearPct == null ? null : Math.round(r.arrearPct))}</b>
                  <span className="ml-1.5 tabular-nums">{fmtPKR(r.arrearCollected)} / {fmtPKR(r.arrearDemand)}</span>
                </span>
              </div>
              <Bullet value={r.arrearPct} height={10} />
            </div>
          ))}
        </div>
        <UnitCaption>{MILLIONS}</UnitCaption>
      </ChartCard>
    </div>
  );
}

/* ---------- Officers ---------- */
function Officers({ data }: { data: UnitData }) {
  const all = [...data.holders, ...data.childHolders];
  const unitName = (id: string) => (id === data.unit._id ? data.unit.name : data.children.find((c) => c._id === id)?.name);
  if (!all.length) return <Card><Empty title="No officers posted" /></Card>;
  return (
    <Card className="divide-y divide-slate-100 dark:divide-slate-800">
      {all.map((h, i) => (
        <div key={i} className="flex items-center gap-3 px-4 py-3">
          <div className="min-w-0 flex-1">
            <Link to={`/officers/${h.user._id}`} className="block truncate font-medium hover:text-brand-700 hover:underline">{h.user.name}{h.user.bps && <span className="ml-1.5 text-xs text-slate-400">BPS-{h.user.bps}</span>}</Link>
            <div className="truncate text-xs text-slate-500">{h.postLabel} · {unitName(h.unitId)}</div>
          </div>
          {h.chargeType !== 'regular' && <Badge>{h.chargeType === 'additional' ? 'Addl. charge' : 'Look after'}</Badge>}
          {h.user.phone && <a href={`tel:${h.user.phone}`} aria-label="Call" className="grid size-10 place-items-center rounded-lg text-brand-600 hover:bg-brand-50"><Phone className="size-4" /></a>}
        </div>
      ))}
    </Card>
  );
}

/** Targets mode: assigned short-term targets running in this area. */
function AreaTargets({ unitId }: { unitId: string }) {
  const { user } = useMe();
  const { data, isLoading } = useAssigned('unit', unitId, 'all');
  if (isLoading) return <Loading />;
  if (!data?.length) return <Card><Empty title="No assigned targets in this area" body="Supervisory officers can assign weekly, 15-day or monthly targets from “Assigned targets”." /></Card>;
  return (
    <ChartCard title="Assigned targets" subtitle="Short-term targets set by supervisory officers in this area">
      <TargetSummary items={data} />
      <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {data.slice(0, 12).map((t) => <TargetCard key={t._id} t={t} viewer={user.id} compact />)}
      </div>
      {data.length > 12 && <p className="mt-2 text-center text-xs text-slate-500">Showing 12 of {data.length} · see League tables in Targets mode for the full ranking</p>}
    </ChartCard>
  );
}

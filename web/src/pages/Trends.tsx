/**
 * Trends — pre-computed statistics for any area by week, 15 days, month, quarter, 6 months or year.
 * Every view reads ready-made rollups, so it stays instant however large the organisation is.
 */
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Bar, BarChart, CartesianGrid, Line, ComposedChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { PageHeader } from '../components/AppShell';
import { LegendKey } from '../components/charts';
import { FyPicker, UnitField } from '../components/rev';
import { Card, Empty, ErrorState, Loading, SectionTitle, Segmented, Spinner, UnitCaption } from '../components/ui';
import { get } from '../lib/api';
import { MILLIONS, T, UNIT_LABEL, fmtPKR, fmtValue, parentLevels, useCaps, useFy, useMeta, type UnitRef } from '../lib/rev';

type Period = 'w' | 'f' | 'm' | 'q' | 'h' | 'y';
interface Cell { done: number; of: number | null; pct: number | null; pend?: number; tp?: number }
interface Row {
  key: string; label: string; start: string; end: string;
  heads: Record<string, Cell>;
  money: { done: number; of: number; pct: number | null };
  arrears: { done: number; of: number | null; pct: number | null };
  tasks: { due: number; onTime: number; pct: number | null };
  progress: number;
}
interface Series { fy: string; period: Period; unit: UnitRef; building: boolean; builtAt: string | null; basis: 'verified' | 'month'; rows: Row[] }
interface ChildRow extends Omit<Row, 'key' | 'label' | 'start' | 'end'> { _id: string; name: string; type: string }

// Short labels on phones so all six fit on one line
const P = (short: string, long: string) => <span className="whitespace-nowrap"><span className="sm:hidden">{short}</span><span className="hidden sm:inline">{long}</span></span>;
const PERIODS: { value: Period; label: ReactNode }[] = [
  { value: 'w', label: P('Wk', 'Week') },
  { value: 'f', label: P('15d', '15 days') },
  { value: 'm', label: P('Mon', 'Month') },
  { value: 'q', label: P('Qtr', 'Quarter') },
  { value: 'h', label: P('6M', '6 months') },
  { value: 'y', label: P('Yr', 'Year') },
];
const th = 'border-b border-r border-white/50 px-2.5 py-2';
const sub = (i: number) => clsx('whitespace-nowrap border-b border-b-slate-200 px-2.5 py-1.5 text-right tabular-nums dark:border-slate-700', i === 2 ? 'border-r-2 border-r-slate-500' : 'border-r border-r-slate-200 dark:border-r-slate-700');
const Pct = ({ v }: { v: number | null | undefined }) => (v == null ? <span className="text-slate-300">—</span> : <b className="text-slate-900 dark:text-white">{Math.round(v)}%</b>);

export default function Trends() {
  const caps = useCaps();
  const { data: meta } = useMeta();
  const [fy] = useFy();
  const [unit, setUnit] = useState<UnitRef | null>(null);
  const [period, setPeriod] = useState<Period>('m');
  const [picked, setPicked] = useState<string | null>(null);
  useEffect(() => {
    if (!unit && caps.viewRoot) setUnit(caps.viewRoot);
  }, [caps.viewRoot, unit]);
  useEffect(() => setPicked(null), [unit, period, fy]);

  const series = useQuery({
    queryKey: ['rev', 'stats', unit?._id, period, fy],
    queryFn: () => get<Series>(`/rev/stats?unitId=${unit!._id}&period=${period}&fy=${fy}`),
    enabled: !!unit && !!fy,
    refetchInterval: (q) => (q.state.data?.building ? 3000 : false),
  });
  const rows = series.data?.rows ?? [];
  // Default to the latest period that has figures (the current one is often still empty)
  const selected = picked ?? (rows.find((r) => r.money.done > 0 || Object.values(r.heads).some((c) => c.done > 0)) ?? rows[0])?.key ?? null;
  const children = useQuery({
    queryKey: ['rev', 'stats', 'children', unit?._id, period, selected, fy],
    queryFn: () => get<{ label: string; items: ChildRow[] }>(`/rev/stats/children?unitId=${unit!._id}&period=${period}&key=${selected}&fy=${fy}`),
    enabled: !!unit && !!selected && !series.data?.building,
  });

  // KPI columns: those with figures in any period shown
  const kpis = useMemo(() => (meta?.heads ?? []).filter((h) => rows.some((r) => r.heads[h.code])), [meta, rows]);
  const chart = rows.slice().reverse().map((r) => ({ label: r.label.split(' · ')[0], done: r.money.done / (meta?.money.scale ?? 1e6), of: r.money.of / (meta?.money.scale ?? 1e6) }));
  const fmtCell = (c: Cell | undefined, unitKind: string, which: 'of' | 'done') => (c == null || c[which] == null ? <span className="text-slate-300">—</span> : fmtValue(c[which] as number, unitKind));
  const subLabels = (kind: 'revenue' | 'case') => (kind === 'revenue' ? ['Target', T.achieved] : ['Total', T.disposed]);

  return (
    <>
      <PageHeader title="Trends" subtitle="Achievement by week, 15 days, month, quarter, half year and year" actions={<FyPicker />} />
      <Card className="mb-3 space-y-3 p-3">
        <div className="grid gap-3 sm:grid-cols-[minmax(0,20rem)_1fr] sm:items-center">
          <UnitField value={unit} onChange={setUnit} accept={[...parentLevels(), ...(meta?.levels.slice(-2, -1).map((l) => l.key) ?? [])]} />
          <div className="overflow-x-auto"><Segmented value={period} onChange={setPeriod} options={PERIODS} /></div>
        </div>
        {series.data?.basis === 'verified' && (
          <p className="text-[11px] text-slate-500">Week and 15-day figures count what was <b>verified</b> in that period, plus verified progress on assigned targets. Monthly figures use the month they belong to. Targets are spread evenly over the year; seasonal KPIs are compared against their target only for the full year.</p>
        )}
      </Card>

      {series.isLoading ? <Loading /> : series.error ? <ErrorState error={series.error} retry={series.refetch} /> : series.data?.building ? (
        <Card className="flex items-center gap-3 p-6"><Spinner />Preparing statistics for FY {fy} — this takes a few seconds the first time.</Card>
      ) : !rows.length ? (
        <Card><Empty title="No periods yet in this year" /></Card>
      ) : (
        <>
          {/* Chart: money achieved vs pro-rated target */}
          <Card className="mb-3 p-3">
            <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
              <div className="text-sm font-semibold">{T.money} · {unit?.name}</div>
              <div className="flex gap-3"><LegendKey color="var(--viz-s1)" label={T.achieved} /><LegendKey color="var(--viz-s2)" label="Target" line /></div>
            </div>
            <div className="h-56">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={chart} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
                  <CartesianGrid vertical={false} stroke="var(--viz-grid)" />
                  <XAxis dataKey="label" tick={{ fontSize: 11 }} interval="preserveStartEnd" tickLine={false} />
                  <YAxis tick={{ fontSize: 11 }} tickLine={false} axisLine={false} width={48} />
                  <Tooltip formatter={(v: number) => v.toLocaleString(undefined, { maximumFractionDigits: 2 })} />
                  <Bar dataKey="done" name={T.achieved} fill="var(--viz-s1)" radius={[3, 3, 0, 0]} isAnimationActive={false} />
                  <Line dataKey="of" name="Target" stroke="var(--viz-s2)" strokeWidth={2} dot={false} isAnimationActive={false} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
            <UnitCaption>{MILLIONS}</UnitCaption>
          </Card>

          {/* Period × KPI table */}
          <Card className="overflow-hidden">
            <div className="max-h-[60vh] overflow-auto">
              <table className="w-max min-w-full border-separate border-spacing-0 text-[13px]">
                <thead className="sticky top-0 z-20 bg-brand-700 text-center text-[12.5px] font-semibold text-white">
                  <tr>
                    <th rowSpan={2} className={clsx(th, 'sticky left-0 z-30 bg-brand-700')}>Period</th>
                    <th colSpan={3} className="border-b border-r-2 border-b-white/30 border-r-white/80 px-2 py-2">{T.money} {MILLIONS}</th>
                    {kpis.map((h) => <th key={h.code} colSpan={3} className="border-b border-r-2 border-b-white/30 border-r-white/80 px-2 py-2">{h.name}</th>)}
                    <th rowSpan={2} className={th}>Tasks on Time</th>
                  </tr>
                  <tr className="bg-brand-600 text-[11.5px] font-medium text-brand-50">
                    {['Target', T.achieved, '%'].map((l, i) => <th key={`m${l}`} className={clsx('border-b border-white/30 px-2.5 py-1.5', i === 2 ? 'border-r-2 border-r-white/80' : 'border-r border-r-white/25')}>{l}</th>)}
                    {kpis.flatMap((h) => [...subLabels(h.kind), '%'].map((l, i) => <th key={h.code + l} className={clsx('border-b border-white/30 px-2.5 py-1.5', i === 2 ? 'border-r-2 border-r-white/80' : 'border-r border-r-white/25')}>{l}</th>))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const on = r.key === selected;
                    return (
                      <tr key={r.key} onClick={() => setPicked(r.key)} className={clsx('cursor-pointer', on ? 'bg-amber-100 dark:bg-amber-500/25' : 'hover:bg-slate-50 dark:hover:bg-slate-800/60')}>
                        <td className={clsx('sticky left-0 z-10 whitespace-nowrap border-b border-r border-b-slate-200 border-r-slate-400 px-3 py-1.5 font-medium dark:border-slate-700', on ? 'bg-amber-100 dark:bg-amber-900' : 'bg-white dark:bg-slate-900')}>{r.label}</td>
                        <td className={sub(0)}>{r.money.of ? fmtPKR(r.money.of) : '—'}</td>
                        <td className={clsx(sub(1), 'font-semibold')}>{fmtPKR(r.money.done)}</td>
                        <td className={sub(2)}><Pct v={r.money.pct} /></td>
                        {kpis.map((h) => {
                          const c = r.heads[h.code];
                          return [
                            <td key={h.code + 'o'} className={sub(0)}>{fmtCell(c, h.unit, 'of')}</td>,
                            <td key={h.code + 'd'} className={clsx(sub(1), 'font-semibold')} title={c?.pend ? `+${fmtValue(c.pend, h.unit)} awaiting verification` : undefined}>{fmtCell(c, h.unit, 'done')}{c?.pend ? <span className="ml-1 text-[10px] text-amber-600">*</span> : null}</td>,
                            <td key={h.code + 'p'} className={sub(2)}><Pct v={c?.pct} /></td>,
                          ];
                        })}
                        <td className="whitespace-nowrap border-b border-b-slate-200 px-2.5 py-1.5 text-right tabular-nums dark:border-slate-700">{r.tasks.due ? `${r.tasks.onTime}/${r.tasks.due} · ` : ''}<Pct v={r.tasks.pct} /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="border-t border-slate-200 px-3 py-1.5 text-[11px] text-slate-500 dark:border-slate-700">
              Tap a period to rank the {children.data?.items[0] ? UNIT_LABEL[children.data.items[0].type].toLowerCase() : 'units'}s below for it · <span className="text-amber-600">*</span> more awaiting verification
              {series.data?.builtAt && <> · updated {new Date(series.data.builtAt).toLocaleString()}</>}
            </div>
          </Card>

          {/* Sub-units for the selected period */}
          <SectionTitle>{children.data ? `${children.data.items[0] ? UNIT_LABEL[children.data.items[0].type] : 'Units'} · ${children.data.label}` : 'Units below'}</SectionTitle>
          {children.isLoading ? <Loading /> : !children.data?.items.length ? <Card><Empty title="Nothing below this level" /></Card> : (
            <div className="grid gap-3 lg:grid-cols-[1fr_minmax(0,22rem)]">
              <Card className="overflow-x-auto">
                <table className="w-full min-w-[480px] border-separate border-spacing-0 text-[13px]">
                  <thead className="bg-brand-700 text-center text-[12.5px] text-white">
                    <tr><th className={clsx(th, 'w-10')}>#</th><th className={th}>Name</th><th className={th}>Target</th><th className={th}>{T.achieved}</th><th className={th}>%</th><th className="border-b border-white/50 px-2.5 py-2">Tasks</th></tr>
                  </thead>
                  <tbody>
                    {children.data.items.map((c, i) => (
                      <tr key={c._id}>
                        <td className="border-b border-r border-b-slate-200 border-r-slate-300 text-center text-xs text-slate-500 dark:border-slate-700">{c.money.pct == null ? '–' : i + 1}</td>
                        <td className="border-b border-r border-b-slate-200 border-r-slate-300 px-3 py-1.5 font-medium dark:border-slate-700">{c.name}</td>
                        <td className={sub(0)}>{c.money.of ? fmtPKR(c.money.of) : '—'}</td>
                        <td className={clsx(sub(1), 'font-semibold')}>{fmtPKR(c.money.done)}</td>
                        <td className={sub(2)}><Pct v={c.money.pct} /></td>
                        <td className="border-b border-b-slate-200 px-2.5 py-1.5 text-right dark:border-slate-700"><Pct v={c.tasks.pct} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <UnitCaption>{MILLIONS}</UnitCaption>
              </Card>
              <Card className="p-3">
                <div className="mb-1 text-sm font-semibold">{T.achieved} % · {children.data.label}</div>
                <div style={{ height: Math.max(160, children.data.items.length * 28) }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart layout="vertical" data={children.data.items.map((c) => ({ name: c.name.replace(' (test)', ''), pct: c.money.pct ?? 0 }))} margin={{ left: 8, right: 16 }}>
                      <XAxis type="number" domain={[0, 100]} tick={{ fontSize: 11 }} />
                      <YAxis type="category" dataKey="name" width={110} tick={{ fontSize: 11 }} />
                      <Tooltip formatter={(v: number) => `${v}%`} />
                      <Bar dataKey="pct" fill="var(--viz-s1)" radius={[0, 3, 3, 0]} isAnimationActive={false} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </Card>
            </div>
          )}
        </>
      )}
    </>
  );
}

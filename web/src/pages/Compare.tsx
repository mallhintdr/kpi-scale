import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { BarChart3 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { PageHeader } from '../components/AppShell';
import { FyPicker, UnitField } from '../components/rev';
import { Card, Empty, ErrorState, Field, Loading, Select } from '../components/ui';
import { get } from '../lib/api';
import { fmtPKR, useCaps, useFy, useMeta, type UnitRef } from '../lib/rev';

interface Cell { pct: number | null; done: number; of: number }
interface CompareData { root: UnitRef; type: string; items: { _id: string; name: string; parent?: string; heads: Record<string, Cell> }[] }

const LEVELS: Record<string, { value: 'district' | 'tehsil' | 'qanungoi'; label: string }[]> = {
  division: [{ value: 'district', label: 'Districts' }, { value: 'tehsil', label: 'Tehsils' }, { value: 'qanungoi', label: 'Qanungois' }],
  district: [{ value: 'tehsil', label: 'Tehsils' }, { value: 'qanungoi', label: 'Qanungois' }],
  tehsil: [{ value: 'qanungoi', label: 'Qanungois' }],
};
const MAX = 6; // series cap: colours stay distinguishable
const COLORS = Array.from({ length: 8 }, (_, i) => `var(--cat-${i + 1})`);

export default function Compare() {
  const caps = useCaps();
  const { data: meta } = useMeta();
  const [fy] = useFy();
  const [area, setArea] = useState<UnitRef | null>(null);
  useEffect(() => {
    if (!area && caps.browseRoots[0]) setArea(caps.browseRoots[0]);
  }, [caps.browseRoots, area]);
  const levels = LEVELS[area?.type ?? ''] ?? [];
  const [level, setLevel] = useState<'district' | 'tehsil' | 'qanungoi'>('district');
  useEffect(() => {
    if (levels.length && !levels.some((l) => l.value === level)) setLevel(levels[0].value);
  }, [area]); // eslint-disable-line react-hooks/exhaustive-deps

  const params = useMemo(() => [
    { code: 'REVENUE', name: 'Overall revenue', money: true },
    { code: 'SCORE', name: 'KPI score', money: false },
    ...(meta?.heads ?? []).filter((h) => h.kind === 'revenue').map((h) => ({ code: h.code, name: h.name, money: true })),
    { code: 'ARREARS', name: 'Arrears', money: true },
    ...(meta?.heads ?? []).filter((h) => h.kind === 'case').map((h) => ({ code: h.code, name: h.name, money: false })),
    { code: 'AUDIT', name: 'Audit paras (recovery)', money: true },
    { code: 'TASKS', name: 'Tasks on time', money: false },
  ], [meta]);
  const [picked, setPicked] = useState<string[]>(['REVENUE', 'WR_KHARIF', 'AIT_LAND']);
  const toggle = (code: string) =>
    setPicked((p) => (p.includes(code) ? p.filter((c) => c !== code) : p.length >= MAX ? p : [...p, code]));
  const [sortBy, setSortBy] = useState('REVENUE');

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['rev', 'compare', area?._id, level, fy],
    queryFn: () => get<CompareData>(`/rev/compare?unitId=${area!._id}&type=${level}&fy=${fy}`),
    enabled: !!area && levels.some((l) => l.value === level) && !!fy,
  });

  const chosen = params.filter((p) => picked.includes(p.code)).sort((a, b) => picked.indexOf(a.code) - picked.indexOf(b.code));
  const sortKey = picked.includes(sortBy) ? sortBy : picked[0];
  const items = useMemo(
    () => (data?.items ?? []).slice().sort((a, b) => (b.heads[sortKey]?.pct ?? -1) - (a.heads[sortKey]?.pct ?? -1)),
    [data, sortKey],
  );
  const chartData = items.map((u) => ({ name: u.name, parent: u.parent, _id: u._id, ...Object.fromEntries(chosen.map((p) => [p.code, u.heads[p.code]?.pct ?? 0])) }));
  const rowH = Math.max(22, chosen.length * 9 + 12);

  if (caps.loaded && !caps.canCompare) {
    return <><PageHeader title="Compare" /><Card><Empty title="Available to Commissioner, DC and ADC (Revenue)" /></Card></>;
  }

  return (
    <>
      <PageHeader title="Compare areas" subtitle="Districts, tehsils or qanungois side by side · % achieved" actions={<FyPicker />} />

      <div className="grid gap-3 xl:grid-cols-[1fr_320px]">
        <Card className="p-4">
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">Parameters · up to {MAX}</span>
            <button className="text-xs font-medium text-brand-600 hover:underline" onClick={() => setPicked([])}>Clear</button>
          </div>
          <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 lg:grid-cols-3">
            {params.map((p) => {
              const on = picked.includes(p.code);
              const idx = picked.indexOf(p.code);
              const disabled = !on && picked.length >= MAX;
              return (
                <label key={p.code} className={clsx('flex min-h-8 cursor-pointer items-center gap-2 rounded-md px-1 text-[13px] hover:bg-slate-50 dark:hover:bg-slate-800', disabled && 'cursor-not-allowed opacity-40')}>
                  <input type="checkbox" className="size-4 shrink-0 accent-brand-600" checked={on} disabled={disabled} onChange={() => toggle(p.code)} />
                  {on && <span className="size-2.5 shrink-0 rounded-sm" style={{ background: COLORS[idx] }} />}
                  <span className="leading-tight">{p.name}</span>
                </label>
              );
            })}
          </div>
        </Card>
        <Card className="grid content-start gap-3 p-4">
          <Field label="Area">{() => <UnitField value={area} onChange={setArea} accept={['division', 'district', 'tehsil']} />}</Field>
          <Field label="Compare">{(id) => <Select id={id} value={level} onChange={(e) => setLevel(e.target.value as typeof level)}>{levels.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}</Select>}</Field>
          <Field label="Sort by">{(id) => <Select id={id} value={sortKey} onChange={(e) => setSortBy(e.target.value)}>{chosen.map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}</Select>}</Field>
        </Card>
      </div>

      {!levels.length ? <Card className="mt-3"><Empty title="Choose a division, district or tehsil" /></Card>
        : !chosen.length ? <Card className="mt-3"><Empty icon={BarChart3} title="Tick at least one parameter" /></Card>
        : isLoading ? <div className="mt-3"><Loading /></div>
        : error ? <ErrorState error={error} retry={refetch} />
        : (
          <>
            <Card className="mt-3 p-3 sm:p-4">
              <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="text-[15px] font-semibold text-slate-900 dark:text-white">{levels.find((l) => l.value === level)?.label} of {data?.root.name} · % achieved</h3>
                <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-slate-600 dark:text-slate-300">
                  {chosen.map((p, i) => <span key={p.code} className="inline-flex items-center gap-1.5"><span className="size-2.5 rounded-sm" style={{ background: COLORS[i] }} />{p.name}</span>)}
                </div>
              </div>
              <ResponsiveContainer width="100%" height={items.length * rowH + 40}>
                <BarChart data={chartData} layout="vertical" margin={{ top: 0, right: 16, left: 0, bottom: 0 }} barCategoryGap={6} barGap={1}>
                  <CartesianGrid horizontal={false} stroke="var(--viz-grid)" />
                  <XAxis type="number" domain={[0, 100]} ticks={[0, 25, 50, 75, 100]} tickFormatter={(v) => `${v}%`} tick={{ fontSize: 11, fill: 'var(--viz-axis)' }} tickLine={false} axisLine={false} orientation="top" />
                  <YAxis type="category" dataKey="name" width={118} tick={{ fontSize: 11, fill: 'currentColor' }} tickLine={false} axisLine={false} className="text-slate-700 dark:text-slate-200"
                    tickFormatter={(n: string) => { const s = n.replace(' (test)', ''); return s.length > 18 ? `${s.slice(0, 17)}…` : s; }} />
                  <Tooltip
                    cursor={{ fill: 'var(--viz-grid)', opacity: 0.5 }}
                    content={({ active, payload }) => {
                      if (!active || !payload?.length) return null;
                      const row = items.find((u) => u._id === (payload[0].payload as { _id: string })._id)!;
                      return (
                        <div className="min-w-52 rounded-xl border border-slate-200 bg-white/95 px-3 py-2.5 text-xs shadow-xl dark:border-slate-700 dark:bg-slate-900/95">
                          <div className="font-semibold text-slate-900 dark:text-white">{row.name}</div>
                          {row.parent && <div className="mb-1.5 text-[11px] text-slate-500">{row.parent}</div>}
                          {chosen.map((p, i) => {
                            const c = row.heads[p.code];
                            return (
                              <div key={p.code} className="flex items-center justify-between gap-3 py-0.5">
                                <span className="flex items-center gap-1.5 text-slate-500"><span className="size-2 rounded-sm" style={{ background: COLORS[i] }} />{p.name}</span>
                                <span className="font-semibold tabular-nums text-slate-900 dark:text-white">
                                  {c?.pct == null ? '—' : `${Math.round(c.pct)}%`}
                                  {c && p.code !== 'SCORE' && <span className="ml-1 font-normal text-slate-400">({p.money ? `${fmtPKR(c.done)}/${fmtPKR(c.of)}` : `${c.done.toLocaleString()}/${c.of.toLocaleString()}`})</span>}
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      );
                    }}
                  />
                  {chosen.map((p, i) => (
                    <Bar key={p.code} dataKey={p.code} fill={COLORS[i]} barSize={8} radius={[0, 3, 3, 0]} isAnimationActive={false} />
                  ))}
                </BarChart>
              </ResponsiveContainer>
              <div className="text-center text-[10px] font-medium text-slate-400">% achieved against target · KPI score out of 100 · hover a row for figures (Rs in Millions)</div>
            </Card>

            {/* Same data as a table */}
            <Card className="mt-3 overflow-hidden">
              <div className="max-h-[60vh] overflow-auto">
                <table className="w-max min-w-full border-separate border-spacing-0 text-[13px]">
                  <thead className="sticky top-0 z-20 bg-brand-700 text-[11px] font-semibold text-white">
                    <tr>
                      <th className="sticky left-0 z-30 w-10 min-w-10 border-r border-white/20 bg-brand-700 px-1 py-2.5 text-center">#</th>
                      <th className="sticky left-10 z-30 border-r border-white/20 bg-brand-700 px-3 py-2.5 text-left">{levels.find((l) => l.value === level)?.label.slice(0, -1)}</th>
                      {chosen.map((p, i) => (
                        <th key={p.code} className="border-r border-white/20 px-3 py-2.5 text-right">
                          <span className="mr-1 inline-block size-2 rounded-sm align-middle" style={{ background: COLORS[i] }} />{p.name}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((u, idx) => (
                      <tr key={u._id}>
                        <td className="sticky left-0 z-10 w-10 min-w-10 border-b border-r border-slate-200 bg-white text-center text-xs font-semibold text-slate-500 tabular-nums dark:border-slate-700 dark:bg-slate-900">{idx + 1}</td>
                        <td className="sticky left-10 z-10 border-b border-r border-slate-200 bg-white px-3 py-1.5 dark:border-slate-700 dark:bg-slate-900">
                          <Link to={`/units/${u._id}`} className="font-medium text-slate-900 hover:text-brand-700 hover:underline dark:text-white">{u.name}</Link>
                          {u.parent && <div className="text-[11px] text-slate-500">{u.parent}</div>}
                        </td>
                        {chosen.map((p) => {
                          const c = u.heads[p.code];
                          return (
                            <td key={p.code} className="whitespace-nowrap border-b border-r border-slate-200 px-3 py-1.5 text-right tabular-nums dark:border-slate-700">
                              <b className="text-slate-900 dark:text-white">{c?.pct == null ? '—' : `${Math.round(c.pct)}%`}</b>
                              {c && p.code !== 'SCORE' && <div className="text-[11px] text-slate-500">{p.money ? `${fmtPKR(c.done)} / ${fmtPKR(c.of)}` : `${c.done.toLocaleString()} / ${c.of.toLocaleString()}`}</div>}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          </>
        )}
    </>
  );
}

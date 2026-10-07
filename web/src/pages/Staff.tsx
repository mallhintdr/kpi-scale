import { useQuery } from '@tanstack/react-query';
import { ChevronRight, Download, Search } from 'lucide-react';
import { useDeferredValue, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { achievement, useViewMode } from '../lib/mode';
import { PageHeader } from '../components/AppShell';
import { BandChip } from '../components/charts';
import { FyPicker, UnitField } from '../components/rev';
import { Card, Empty, ErrorState, Field, Input, Loading, Select } from '../components/ui';
import { get } from '../lib/api';
import { fmtPKR, revColor, useCaps, useFy, useMeta, type Block, type Post, type RevBand, type UnitRef } from '../lib/rev';
import { POSTS_BY_UNIT } from './League';

interface Cell { pct: number | null; done: number; of: number }
interface StaffRow {
  user: { _id: string; name: string; designation?: string; bps?: number; phone?: string };
  charges: string[]; context: string; score: number | null; band: RevBand; blocks: Record<Block, number | null>;
  rank: number | null; target: number; collected: number; heads: Record<string, Cell>;
}

const EXTRA: { code: string; name: string; money?: boolean }[] = [
  { code: 'ARREARS', name: 'Arrears (all heads)', money: true },
  { code: 'AUDIT', name: 'Audit paras' },
  { code: 'TASKS', name: 'Tasks on time' },
];

export default function Staff() {
  const caps = useCaps();
  const { data: meta } = useMeta();
  const [fy] = useFy();
  const [unit, setUnit] = useState<UnitRef | null>(null);
  const [post, setPost] = useState<Post>('patwari');
  const [search, setSearch] = useState('');
  const [params, setParams] = useSearchParams();
  const focus = params.get('head');
  const term = useDeferredValue(search.trim().toLowerCase());
  useEffect(() => {
    if (!unit && caps.viewRoot) setUnit(caps.viewRoot);
  }, [caps.viewRoot, unit]);
  const options = POSTS_BY_UNIT[unit?.type ?? 'tehsil'] ?? [];
  useEffect(() => {
    if (options.length && !options.some((o) => o.code === post)) setPost(options[options.length - 1].code);
  }, [unit]); // eslint-disable-line react-hooks/exhaustive-deps

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['rev', 'league', unit?._id, post, fy],
    queryFn: () => get<{ items: StaffRow[]; postLabel: string }>(`/rev/league?unitId=${unit!._id}&post=${post}&fy=${fy}`),
    enabled: !!unit && !!fy && options.some((o) => o.code === post),
  });

  // Columns: every head that has data for at least one officer in this list
  const columns = useMemo(() => {
    const present = new Set((data?.items ?? []).flatMap((r) => Object.keys(r.heads)));
    const heads = (meta?.heads ?? []).filter((h) => present.has(h.code)).map((h) => ({ code: h.code, name: h.name, group: h.kind === 'revenue' ? 'Revenue' : 'Cases', money: h.kind === 'revenue' }));
    return [...heads, ...EXTRA.filter((e) => present.has(e.code)).map((e) => ({ ...e, group: 'Other', money: !!e.money }))];
  }, [data, meta]);
  const [mode] = useViewMode();
  const perf = mode === 'performance';
  // Overall column: revenue achievement (Performance) or weighted KPI score (KPI evaluation)
  const overall = (r: StaffRow) => {
    if (!perf) return r.score;
    const rev = Object.entries(r.heads).filter(([k]) => meta?.heads.some((h) => h.code === k && h.kind === 'revenue'));
    return achievement(rev.reduce((s, [, c]) => s + c.done, 0), rev.reduce((s, [, c]) => s + c.of, 0));
  };
  const rows = (data?.items ?? [])
    .map((r) => ({ ...r, overall: overall(r) }))
    .sort((a, b) => (b.overall ?? -1) - (a.overall ?? -1))
    .map((r, i) => ({ ...r, rank: r.overall == null ? null : i + 1 }))
    .filter((r) => !term || r.user.name.toLowerCase().includes(term) || r.charges.join(' ').toLowerCase().includes(term))
    .sort((a, b) => (focus ? (b.heads[focus]?.pct ?? -1) - (a.heads[focus]?.pct ?? -1) : 0));
  const focusName = focus && columns.find((c) => c.code === focus)?.name;

  const exportCsv = () => {
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const header = ['Rank', 'Name', 'BPS', 'Charge', 'Area', perf ? 'Revenue achievement %' : 'KPI score', ...columns.flatMap((c) => [`${c.name} %`, `${c.name} done`, `${c.name} of`])];
    const lines = rows.map((r) => [r.rank, r.user.name, r.user.bps, r.charges.join(' + '), r.context, r.overall == null ? '' : Math.round(r.overall * 10) / 10, ...columns.flatMap((c) => [r.heads[c.code]?.pct, r.heads[c.code]?.done, r.heads[c.code]?.of])].map(esc).join(','));
    const url = URL.createObjectURL(new Blob([[header.map(esc).join(','), ...lines].join('\n')], { type: 'text/csv' }));
    Object.assign(document.createElement('a'), { href: url, download: `staff-${post}-${unit?.name}-${fy}.csv` }).click();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      <PageHeader title="Staff performance" subtitle="Every subordinate, every head" actions={<FyPicker />} />
      <Card className="mb-4 grid gap-3 p-4 md:grid-cols-[1fr_1fr_1fr_auto] md:items-end">
        <Field label="Area">{() => <UnitField value={unit} onChange={setUnit} accept={['division', 'district', 'tehsil', 'qanungoi']} />}</Field>
        <Field label="Staff">{(id) => <Select id={id} value={post} onChange={(e) => setPost(e.target.value as Post)}>{options.map((o) => <option key={o.code} value={o.code}>{o.label}</option>)}</Select>}</Field>
        <Field label="Search">
          {(id) => (
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
              <Input id={id} type="search" placeholder="Name or circle" value={search} onChange={(e) => setSearch(e.target.value)} className="pl-9" />
            </div>
          )}
        </Field>
        <button onClick={exportCsv} disabled={!rows.length} className="flex h-11 items-center justify-center gap-2 rounded-xl px-4 text-sm font-medium text-slate-700 ring-1 ring-slate-200 hover:bg-slate-50 disabled:opacity-50 dark:text-slate-200 dark:ring-slate-700 dark:hover:bg-slate-800">
          <Download className="size-4" />CSV
        </button>
      </Card>

      {!options.length ? <Card><Empty title="Choose a division, district, tehsil or qanungoi" /></Card> : isLoading ? <Loading /> : error ? <ErrorState error={error} retry={refetch} /> : !rows.length ? (
        <Card><Empty title="No staff found" /></Card>
      ) : (
        <>
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2 px-1 text-xs text-slate-500">
            <span>
              {rows.length} {data?.postLabel ?? 'officers'} · revenue figures (Rs in Millions) · tap a name for the full profile
              {focusName && (
                <> · sorted by <b className="text-slate-700 dark:text-slate-200">{focusName}</b>{' '}
                  <button className="font-medium text-brand-600 hover:underline" onClick={() => setParams({}, { replace: true })}>clear</button>
                </>
              )}
            </span>
            <span className="flex items-center gap-3">
              {[95, 80, 65, 50, 20].map((v, i) => (
                <span key={v} className="inline-flex items-center gap-1"><span className="size-2.5 rounded-sm" style={{ background: revColor(v) }} />{['≥90', '75–89', '60–74', '40–59', '<40'][i]}</span>
              ))}
            </span>
          </div>
          <Card className="overflow-hidden">
            <div className="max-h-[70vh] overflow-auto">
              <table className="w-max min-w-full border-separate border-spacing-0 text-sm">
                <thead className="sticky top-0 z-20 bg-brand-700 text-left text-[11px] font-semibold uppercase tracking-wide text-white">
                  <tr>
                    <th className="sticky left-0 z-30 w-10 min-w-10 border-r border-white/20 bg-brand-700 px-1 py-2.5 text-center">#</th>
                    <th className="sticky left-10 z-30 border-r border-white/20 bg-brand-700 px-3 py-2.5">Officer</th>
                    <th className="border-r border-white/20 px-3 py-2.5 text-center">{perf ? 'Revenue achieved' : 'KPI score'}</th>
                    {columns.map((c) => (
                      <th
                        key={c.code}
                        ref={c.code === focus ? (el) => el?.scrollIntoView({ inline: 'center', block: 'nearest' }) : undefined}
                        onClick={() => setParams({ head: c.code }, { replace: true })}
                        className={`max-w-28 cursor-pointer border-r border-white/20 px-2 py-2.5 text-center normal-case leading-tight tracking-normal hover:bg-brand-600 ${c.code === focus ? 'bg-brand-900 text-gold-400' : ''}`}
                        title={`Sort by ${c.name}`}
                      >
                        {c.name.replace('Water Rate — ', 'WR ').replace('Tawan — ', 'Tawan ').replace(' (State Land)', '')}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.user._id} className="group">
                      <td className="sticky left-0 z-10 w-10 min-w-10 border-b border-r border-slate-200 bg-white px-1 py-2 text-center text-xs font-bold text-slate-500 tabular-nums group-hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:group-hover:bg-slate-800">{r.rank ?? '–'}</td>
                      <td className="sticky left-10 z-10 border-b border-r border-slate-200 bg-white px-3 py-2 group-hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:group-hover:bg-slate-800">
                        <Link to={`/officers/${r.user._id}?fy=${fy}`} className="flex items-center gap-2.5">
                          <div className="min-w-0 max-w-[6.5rem] sm:max-w-44">
                            <div className="truncate font-medium text-slate-900 dark:text-white">{r.user.name}</div>
                            <div className="truncate text-[11px] text-slate-500">{r.charges.join(', ')}</div>
                          </div>
                          <ChevronRight className="hidden size-3.5 text-slate-300 sm:block" />
                        </Link>
                      </td>
                      <td className="border-b border-r border-slate-200 px-3 py-2 text-center dark:border-slate-700">
                        {perf ? (
                          <div className="min-w-[8rem] text-left">
                            <div className="flex items-baseline justify-between gap-3">
                              <span className="text-[12px] font-medium text-slate-800 tabular-nums dark:text-slate-100">{fmtPKR(r.collected)} / {fmtPKR(r.target)}</span>
                              <span className="text-sm font-bold text-slate-900 tabular-nums dark:text-white">{r.overall == null ? '—' : `${Math.round(r.overall)}%`}</span>
                            </div>
                            <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full" style={{ background: 'var(--viz-track)' }}><div className="h-full rounded-full" style={{ width: `${r.overall ?? 0}%`, background: revColor(r.overall) }} /></div>
                          </div>
                        ) : (
                          <div className="flex items-center justify-center gap-2">
                            <span className="text-sm font-bold text-slate-900 tabular-nums dark:text-white">{r.overall == null ? '—' : Math.round(r.overall)}</span>
                            <BandChip band={r.band} />
                          </div>
                        )}
                      </td>
                      {columns.map((c) => <HeadCell key={c.code} cell={r.heads[c.code]} money={c.money} name={c.name} focus={c.code === focus} />)}
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

function HeadCell({ cell, money, name, focus }: { cell?: Cell; money?: boolean; name: string; focus?: boolean }) {
  const hl = focus ? 'bg-brand-50/60 dark:bg-brand-500/10' : '';
  if (!cell) return <td className={`border-b border-r border-slate-200 px-2 py-2 text-center text-xs text-slate-300 dark:border-slate-700 ${hl}`}>—</td>;
  const v = cell.pct;
  const detail = money ? `${fmtPKR(cell.done)} / ${fmtPKR(cell.of)}` : `${cell.done.toLocaleString()} / ${cell.of.toLocaleString()}`;
  return (
    <td className={`whitespace-nowrap border-b border-r border-slate-200 px-2.5 py-1.5 dark:border-slate-700 ${hl}`} title={`${name}: ${detail}`}>
      {/* Figures on top (achieved / target · %), bar underneath */}
      <div className="min-w-[7.5rem]">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-[12px] font-medium text-slate-800 tabular-nums dark:text-slate-100">{detail}</span>
          <span className="text-[13px] font-bold text-slate-900 tabular-nums dark:text-white">{v == null ? '—' : `${Math.round(v)}%`}</span>
        </div>
        <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full" style={{ background: 'var(--viz-track)' }}>
          <div className="h-full rounded-full" style={{ width: `${Math.min(100, v ?? 0)}%`, background: revColor(v) }} />
        </div>
      </div>
    </td>
  );
}

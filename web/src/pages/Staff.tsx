import { useQuery } from '@tanstack/react-query';
import { Download, Search, Printer, LayoutList, Table2 } from 'lucide-react';
import { exportTableXlsx } from '../lib/xlsx';
import { useDeferredValue, useEffect, useMemo, useState, useRef } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { achievement, useViewMode } from '../lib/mode';
import { useTargetSummary } from '../components/targets';
import { PageHeader } from '../components/AppShell';
import { BandChip } from '../components/charts';
import { FyPicker, UnitField } from '../components/rev';
import { Card, Empty, ErrorState, Field, Input, Loading, Select, Segmented } from '../components/ui';
import { get } from '../lib/api';
import { fmtPKR, getOrg, groupLevels, MILLIONS, parentLevels, T, UNIT_LABEL, useCaps, useFy, useMeta, type Block, type Post, type RevBand, type UnitRef } from '../lib/rev';
import { POSTS_BY_UNIT } from './League';
import { OfficerWise } from './Reports';

interface Cell { pct: number | null; done: number; of: number }
interface StaffRow {
  user: { _id: string; name: string; designation?: string; bps?: number; phone?: string };
  charges: string[]; context: string; score: number | null; band: RevBand; blocks: Record<Block, number | null>;
  rank: number | null; target: number; collected: number; heads: Record<string, Cell>;
  unitId: string; chargeType: string; chargeCount: number; areas?: Record<string, string>;
}

const EXTRA: { code: string; name: string; money?: boolean }[] = [
  { code: 'ARREARS', name: 'Arrears (all heads)', money: true },
  { code: 'AUDIT', name: getOrg()?.registers.map((r) => r.label).join(' / ') || 'Registers' },
  { code: 'TASKS', name: 'Tasks on Time' },
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
    const heads = (meta?.heads ?? []).filter((h) => present.has(h.code)).map((h) => ({ code: h.code, name: h.name, group: h.kind === 'revenue' ? 'Revenue' : 'Cases', money: h.unit === 'money' }));
    return [...heads, ...EXTRA.filter((e) => present.has(e.code)).map((e) => ({ ...e, group: 'Other', money: !!e.money }))];
  }, [data, meta]);
  const [mode] = useViewMode();
  const perf = mode !== 'kpi';
  const tmode = mode === 'targets';
  const tsum = useTargetSummary(unit?._id, post, fy, tmode);
  // Overall column: revenue achievement (Performance), assigned-target achievement (Targets) or KPI score
  const overall = (r: StaffRow) => {
    if (tmode) return tsum.get(`${r.user._id}|${r.unitId}`)?.pct ?? null;
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
  // Show District / Tehsil columns only when the list spans more than one of them
  // Hierarchy columns (e.g. District, Tehsil) appear only when the list spans more than one of them
  const groupCols = groupLevels().filter((l) => new Set(rows.map((r) => r.areas?.[l])).size > 1);
  // Clicked row stays highlighted so the officer's figures can be read across the whole table
  const [selected, setSelected] = useState<string | null>(null);

  const tableRef = useRef<HTMLTableElement>(null);
  // Layout: officer-wise (a block per officer, a row per KPI) or the wide table; officer-wise above 3 KPIs
  const [layout, setLayout] = useState<'officer' | 'table' | null>(null);
  const view = layout ?? (columns.length > 3 ? 'officer' : 'table');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggleOfficer = (k: string) => setCollapsed((c) => { const n = new Set(c); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const cellValue = (c: Cell | undefined, m: 'target' | 'achieved' | 'balance' | 'pct', money: boolean) => {
    if (!c) return '';
    const f = (v: number) => (money ? fmtPKR(v) : v.toLocaleString());
    return m === 'target' ? f(c.of) : m === 'achieved' ? f(c.done) : m === 'balance' ? f(Math.max(0, c.of - c.done)) : c.pct == null ? '' : `${Math.round(c.pct)}%`;
  };
  const exportXlsx = () => exportTableXlsx(tableRef.current, {
    filename: `staff-${post}-${unit?.name}-${fy}`, sheet: 'Staff performance', freezeCols: view === 'officer' ? 1 : 3 + groupCols.length,
    title: `Staff performance · ${unit?.name ?? ''} · FY ${fy}`, subtitle: `Generated ${new Date().toLocaleString()}`,
  });
  const exportCsv = () => {
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const header = ['S.No', ...groupCols.map((l) => UNIT_LABEL[l]), 'Name', 'Area', 'BPS', perf ? `${T.money} achievement %` : 'KPI score', ...columns.flatMap((c) => [`${c.name} %`, `${c.name} done`, `${c.name} of`])];
    const lines = rows.map((r) => [r.rank, ...groupCols.map((l) => r.areas?.[l] ?? ''), r.user.name, r.charges.join(' + '), r.user.bps, r.overall == null ? '' : Math.round(r.overall * 10) / 10, ...columns.flatMap((c) => [r.heads[c.code]?.pct, r.heads[c.code]?.done, r.heads[c.code]?.of])].map(esc).join(','));
    const url = URL.createObjectURL(new Blob([[header.map(esc).join(','), ...lines].join('\n')], { type: 'text/csv' }));
    Object.assign(document.createElement('a'), { href: url, download: `staff-${post}-${unit?.name}-${fy}.csv` }).click();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      <PageHeader title="Staff performance" subtitle="Every subordinate, every KPI" actions={<FyPicker />} />
      <Card className="mb-4 grid gap-3 p-4 md:grid-cols-[1fr_1fr_1fr_auto] md:items-end print:hidden">
        <Field label="Area">{() => <UnitField value={unit} onChange={setUnit} accept={parentLevels()} />}</Field>
        <Field label="Staff">{(id) => <Select id={id} value={post} onChange={(e) => setPost(e.target.value as Post)}>{options.map((o) => <option key={o.code} value={o.code}>{o.label}</option>)}</Select>}</Field>
        <Field label="Search">
          {(id) => (
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
              <Input id={id} type="search" placeholder="Name or unit" value={search} onChange={(e) => setSearch(e.target.value)} className="pl-9" />
            </div>
          )}
        </Field>
        <div className="flex gap-2">
          <button onClick={exportXlsx} disabled={!rows.length} className="flex h-11 items-center justify-center gap-2 rounded-xl px-4 text-sm font-medium text-slate-700 ring-1 ring-slate-200 hover:bg-slate-50 disabled:opacity-50 dark:text-slate-200 dark:ring-slate-700 dark:hover:bg-slate-800">
            <Download className="size-4" />Excel
          </button>
          <button onClick={() => window.print()} disabled={!rows.length} className="flex h-11 items-center justify-center gap-2 rounded-xl px-4 text-sm font-medium text-slate-700 ring-1 ring-slate-200 hover:bg-slate-50 disabled:opacity-50 dark:text-slate-200 dark:ring-slate-700 dark:hover:bg-slate-800">
            <Printer className="size-4" />Print
          </button>
          <button onClick={exportCsv} disabled={!rows.length} className="h-11 px-2 text-xs text-slate-500 hover:underline disabled:opacity-50">CSV</button>
        </div>
      </Card>

      {!options.length ? <Card><Empty title="Choose an area" /></Card> : isLoading ? <Loading /> : error ? <ErrorState error={error} retry={refetch} /> : !rows.length ? (
        <Card><Empty title="No staff found" /></Card>
      ) : (
        <>
          <div className="hidden print:mb-2 print:block">
            <div className="text-lg font-bold">Staff Performance · {data?.postLabel} · {unit?.name} · FY {fy}</div>
            <div className="text-xs">{rows.length} {data?.postLabel ?? 'officers'} · money figures {MILLIONS} · generated <span className="font-semibold">{new Date().toLocaleString()}</span></div>
          </div>
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2 px-1 text-xs text-slate-500 print:hidden">
            <span className="flex flex-wrap items-center gap-2">
              <Segmented value={view} onChange={(v) => setLayout(v)} options={[
                { value: 'officer', label: <span className="flex items-center gap-1 whitespace-nowrap" title="One block per officer, a row per KPI"><LayoutList className="size-4" />Officer-wise</span> },
                { value: 'table', label: <span className="flex items-center gap-1 whitespace-nowrap" title="KPIs across, officers down"><Table2 className="size-4" />Table</span> },
              ]} />
              {view === 'officer' && <>
                <button className="font-medium text-brand-700 hover:underline" onClick={() => setCollapsed(new Set())}>Expand all</button>
                <button className="font-medium text-brand-700 hover:underline" onClick={() => setCollapsed(new Set(rows.map((x) => `${x.user._id}-${x.unitId}`)))}>Collapse all</button>
              </>}
            </span>
            <span>
              {rows.length} {data?.postLabel ?? 'officers'} · money figures {MILLIONS} · tap a row to highlight it · tap a name for the profile
              {focusName && (
                <> · sorted by <b className="text-slate-700 dark:text-slate-200">{focusName}</b>{' '}
                  <button className="font-medium text-brand-600 hover:underline" onClick={() => setParams({}, { replace: true })}>clear</button>
                </>
              )}
            </span>
          </div>
          {view === 'officer' ? (
            <Card className="overflow-hidden">
              <div className="max-h-[70vh] overflow-auto print:max-h-none print:overflow-visible">
                <OfficerWise rows={rows} heads={columns} measures={[{ key: 'target', label: 'Target' }, { key: 'achieved', label: 'Achieved' }, { key: 'balance', label: 'Balance' }, { key: 'pct', label: '%' }]}
                  details={[{ key: 'rank', label: 'Rank' }, { key: 'overall', label: 'Overall' }, { key: 'bps', label: 'BPS' }]} perf={perf}
                  areaOf={(r) => r.charges.join(', ').replace(/ \(test\)/g, '') + (r.chargeType && r.chargeType !== 'regular' ? (r.chargeType === 'additional' ? ' (Addl. charge)' : ' (Look after)') : '')}
                  detailValue={(r, d) => (d === 'bps' ? (r.user.bps ? `BPS-${r.user.bps}` : '') : '')} value={cellValue}
                  groupCols={groupCols} collapsed={collapsed} toggle={toggleOfficer} tableRef={tableRef} />
              </div>
            </Card>
          ) : (
          <Card className="overflow-hidden">
            <div className="max-h-[70vh] overflow-auto">
              <table ref={tableRef} className="w-max min-w-full border-separate border-spacing-0 text-sm">
                {/* Two header rows: group (head) on top, its sub-columns below. Headers ~15% larger, centred. */}
                <thead className="sticky top-0 z-20 bg-brand-700 text-center text-[12.5px] font-semibold text-white">
                  <tr>
                    <th rowSpan={2} className="sticky left-0 z-30 w-10 min-w-10 border-b border-r border-white/60 bg-brand-700 px-1 py-2.5">#</th>
                    {groupCols.map((l) => <th key={l} rowSpan={2} className="border-b border-r border-white/60 px-3 py-2.5">{UNIT_LABEL[l]}</th>)}
                    <th rowSpan={2} className="sticky left-10 z-30 border-b border-r border-white/60 bg-brand-700 px-3 py-2.5">Name</th>
                    <th rowSpan={2} className="border-b border-r border-white/60 px-3 py-2.5">Area</th>
                    {perf ? (
                      <th colSpan={4} className="border-b border-r-2 border-b-white/30 border-r-white/80 px-3 py-2">{tmode ? 'Assigned Targets' : `${T.money} (all KPIs)`}</th>
                    ) : (
                      <th rowSpan={2} className="border-b border-r-2 border-white/60 border-r-white/80 px-3 py-2.5">KPI score</th>
                    )}
                    {columns.map((c) => (
                      <th
                        key={c.code}
                        colSpan={4}
                        ref={c.code === focus ? (el) => el?.scrollIntoView({ inline: 'center', block: 'nearest' }) : undefined}
                        onClick={() => setParams({ head: c.code }, { replace: true })}
                        className={`cursor-pointer border-b border-r-2 border-b-white/30 border-r-white/80 px-2 py-2 leading-tight hover:bg-brand-600 ${c.code === focus ? 'bg-brand-900 text-gold-400' : ''}`}
                        title={`Sort by ${c.name}`}
                      >
                        {c.name}
                      </th>
                    ))}
                  </tr>
                  <tr className="bg-brand-600 text-[11.5px] font-medium text-brand-50">
                    {perf && (tmode ? ['Assigned', 'Met', 'Not Met', '%'] : ['Target', T.achieved, 'Balance', '%']).map((l, i) => (
                      <th key={`o${l}`} className={`border-b border-white/30 px-2.5 py-1.5 ${i === 3 ? 'border-r-2 border-r-white/80' : 'border-r border-r-white/25'}`}>{l}</th>
                    ))}
                    {columns.flatMap((c) => subLabels(c.code, c.money).map((l, i) => (
                      <th key={c.code + l} className={`border-b border-white/30 px-2.5 py-1.5 ${i === 3 ? 'border-r-2 border-r-white/80' : 'border-r border-r-white/25'}`}>{l}</th>
                    )))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const key = `${r.user._id}-${r.unitId}`;
                    const on = selected === key;
                    const stickyBg = on ? 'bg-amber-100 dark:bg-amber-500/25' : 'bg-inherit';
                    const ts = tsum.get(`${r.user._id}|${r.unitId}`);
                    return (
                    <tr key={key} onClick={() => setSelected(on ? null : key)} aria-selected={on}
                      className={`group cursor-pointer ${on ? 'bg-amber-100 outline outline-2 -outline-offset-2 outline-amber-400 dark:bg-amber-500/25' : 'hover:bg-slate-50 dark:hover:bg-slate-800/60'}`}>
                      <td className={`sticky left-0 z-10 w-10 min-w-10 border-b border-r border-b-slate-300 border-r-slate-400 px-1 py-2 text-center text-xs font-bold text-slate-500 tabular-nums dark:border-slate-700 ${stickyBg}`}>{r.rank ?? '–'}</td>
                      {groupCols.map((l) => <td key={l} className="whitespace-nowrap border-b border-r border-b-slate-300 border-r-slate-400 px-3 py-2 text-[13px] dark:border-slate-700">{r.areas?.[l]}</td>)}
                      <td className={`sticky left-10 z-10 border-b border-r border-b-slate-300 border-r-slate-400 px-3 py-2 dark:border-slate-700 ${stickyBg}`}>
                        <Link to={`/officers/${r.user._id}?fy=${fy}`} onClick={(e) => e.stopPropagation()} title={`Open ${r.user.name}'s profile`}
                          className={`block max-w-[7.5rem] truncate font-bold text-slate-900 sm:max-w-48 dark:text-white decoration-2 underline-offset-2 hover:text-brand-700 hover:underline focus-visible:underline ${on ? 'underline' : ''}`}>
                          {r.user.name}
                        </Link>
                      </td>
                      <td className="whitespace-nowrap border-b border-r border-b-slate-300 border-r-slate-400 px-3 py-2 text-[12px] text-slate-700 dark:border-slate-700 dark:text-slate-300">
                        {r.charges.join(', ').replace(' (test)', '')}
                        {r.chargeType !== 'regular' && <span className="ml-1.5 rounded bg-amber-100 px-1 text-[10px] font-semibold text-amber-800">{r.chargeType === 'additional' ? 'Addl. charge' : 'Look after'}</span>}
                      </td>
                      {perf ? (
                        tmode ? (
                          <Quad values={ts ? [String(ts.targets), String(ts.met), String(ts.targets - ts.met), null] : ['—', '—', '—', null]} pct={ts ? ts.pct : null} />
                        ) : (
                          <Quad values={[fmtPKR(r.target), fmtPKR(r.collected), fmtPKR(Math.max(0, r.target - r.collected)), null]} pct={r.overall} strong={1} />
                        )
                      ) : (
                        <td className="border-b border-r-2 border-b-slate-300 border-r-slate-500 px-3 py-2 text-center dark:border-slate-700">
                          <div className="flex items-center justify-center gap-2">
                            <span className="text-sm font-bold text-slate-900 tabular-nums dark:text-white">{r.overall == null ? '—' : Math.round(r.overall)}</span>
                            <BandChip band={r.band} />
                          </div>
                        </td>
                      )}
                      {columns.map((c) => <HeadCells key={c.code} cell={r.heads[c.code]} money={c.money} focus={c.code === focus && !on} />)}
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
          )}
        </>
      )}
    </>
  );
}

/** Sub-column labels for a head group. */
function subLabels(code: string, money: boolean) {
  if (code === 'AUDIT') return ['Paras', 'Settled', 'Pending', '% Rec.'];
  if (code === 'TASKS') return ['Due', 'On Time', 'Late', '%'];
  if (code === 'ARREARS') return ['Arrears', T.achieved, 'Balance', '%'];
  return money ? ['Target', T.achieved, 'Balance', '%'] : ['Total', T.disposed, T.pending, '%'];
}

const subTd = (i: number, extra = '') =>
  `whitespace-nowrap border-b border-b-slate-300 px-2.5 py-2 text-center tabular-nums dark:border-slate-700 ${i === 3 ? 'border-r-2 border-r-slate-500' : 'border-r border-r-slate-200 dark:border-r-slate-700'} ${extra}`;

/** % with a small status dot (text stays in ink). */
const Pct = ({ v }: { v: number | null | undefined }) =>
  v == null ? <span className="text-slate-300">—</span> : (
    <span className="font-bold text-slate-900 dark:text-white">{Math.round(v)}%</span>
  );

/** Four cells: three figures and the %. */
function Quad({ values, pct, strong }: { values: (string | null)[]; pct: number | null | undefined; strong?: number }) {
  return (
    <>
      {values.slice(0, 3).map((v, i) => (
        <td key={i} className={subTd(i, i === strong ? 'font-semibold text-slate-900 dark:text-white' : 'text-slate-700 dark:text-slate-300')}>{v}</td>
      ))}
      <td className={subTd(3)}><Pct v={pct} /></td>
    </>
  );
}

function HeadCells({ cell, money, focus }: { cell?: Cell; money?: boolean; focus?: boolean }) {
  const hl = focus ? 'bg-brand-50/60 dark:bg-brand-500/10' : '';
  if (!cell) return <>{[0, 1, 2, 3].map((i) => <td key={i} className={subTd(i, `text-center text-slate-300 ${hl}`)}>—</td>)}</>;
  const f = (v: number) => (money ? fmtPKR(v) : v.toLocaleString());
  return (
    <>
      <td className={subTd(0, `text-slate-700 dark:text-slate-300 ${hl}`)}>{f(cell.of)}</td>
      <td className={subTd(1, `font-semibold text-slate-900 dark:text-white ${hl}`)}>{f(cell.done)}</td>
      <td className={subTd(2, `text-slate-700 dark:text-slate-300 ${hl}`)}>{f(Math.max(0, cell.of - cell.done))}</td>
      <td className={subTd(3, hl)}><Pct v={cell.pct} /></td>
    </>
  );
}

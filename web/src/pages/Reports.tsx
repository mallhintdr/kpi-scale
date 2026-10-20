import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { ChevronDown, ChevronRight, FileSpreadsheet, LayoutList, Maximize2, Minimize2, Printer, Sheet as SheetIcon, Table2 } from 'lucide-react';
import { exportTableXlsx } from '../lib/xlsx';
import { useEffect, useMemo, useState, useRef } from 'react';
import { Link } from 'react-router-dom';
import { PageHeader } from '../components/AppShell';
import { FyPicker, UnitField } from '../components/rev';
import { Button, Card, Empty, ErrorState, Field, Loading, Segmented, Select } from '../components/ui';
import { get } from '../lib/api';
import { useAuth } from '../lib/auth';
import { achievement, useViewMode } from '../lib/mode';
import { fmtPKR, groupLevels, MILLIONS, parentLevels, T, UNIT_LABEL, useCaps, useFy, useMeta, type Post, type UnitRef } from '../lib/rev';
import { POSTS_BY_UNIT } from './League';

interface Cell { pct: number | null; done: number; of: number }
interface Row {
  user: { _id: string; name: string; designation?: string; bps?: number; phone?: string };
  unitId: string; chargeType: string; areas?: Record<string, string>;
  charges: string[]; context: string; score: number | null; target: number; collected: number; heads: Record<string, Cell>;
}

type Measure = 'target' | 'achieved' | 'balance' | 'pct';
type Detail = 'rank' | 'designation' | 'bps' | 'phone' | 'overall';

const MEASURES: { key: Measure; label: string }[] = [
  { key: 'target', label: 'Target' },
  { key: 'achieved', label: 'Achieved' },
  { key: 'balance', label: 'Balance' },
  { key: 'pct', label: '% achieved' },
];
const DETAILS: { key: Detail; label: string }[] = [
  { key: 'rank', label: 'Rank' },
  { key: 'overall', label: 'Overall (achievement % or KPI score)' },
  { key: 'designation', label: 'Designation' },
  { key: 'bps', label: 'BPS' },
  { key: 'phone', label: 'Phone' },
];
const EXTRA_HEADS = [
  { code: 'ARREARS', name: 'Arrears (All KPIs)', group: 'Revenue', money: true },
  { code: 'AUDIT', name: 'Registers (settled / total)', group: 'Other', money: false },
  { code: 'TASKS', name: 'Tasks (on time / due)', group: 'Other', money: false },
];

/** Checkbox list with select-all, used for every parameter group. */
function CheckGroup<T extends string>({ title, items, value, onChange, cols = 1 }: {
  title: string; items: { key: T; label: string }[]; value: Set<T>; onChange: (v: Set<T>) => void; cols?: number;
}) {
  const all = items.every((i) => value.has(i.key));
  const toggle = (k: T) => { const n = new Set(value); n.has(k) ? n.delete(k) : n.add(k); onChange(n); };
  return (
    <fieldset>
      <div className="mb-1.5 flex items-center justify-between">
        <legend className="text-xs font-semibold uppercase tracking-wide text-slate-500">{title}</legend>
        <button type="button" className="text-xs font-medium text-brand-600 hover:underline" onClick={() => onChange(all ? new Set() : new Set(items.map((i) => i.key)))}>
          {all ? 'Clear' : 'Select all'}
        </button>
      </div>
      <div className={clsx('grid gap-x-3 gap-y-0.5', cols === 2 && 'sm:grid-cols-2', cols === 3 && 'grid-cols-2 xl:grid-cols-3')}>
        {items.map((i) => (
          <label key={i.key} className="flex min-h-8 cursor-pointer items-center gap-2 rounded-md px-1 text-sm hover:bg-slate-50 dark:hover:bg-slate-800">
            <input type="checkbox" className="size-4 shrink-0 accent-brand-600" checked={value.has(i.key)} onChange={() => toggle(i.key)} />
            <span className="text-[13px] leading-tight sm:text-sm">{i.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export default function Reports() {
  const { session } = useAuth();
  const caps = useCaps();
  const { data: meta } = useMeta();
  const [fy] = useFy();
  const [mode] = useViewMode();
  const perf = mode !== 'kpi';

  const [unit, setUnit] = useState<UnitRef | null>(null);
  const [post, setPost] = useState<Post>('patwari');
  useEffect(() => {
    if (!unit && caps.viewRoot) setUnit(caps.viewRoot);
  }, [caps.viewRoot, unit]);
  const options = POSTS_BY_UNIT[unit?.type ?? 'tehsil'] ?? [];
  useEffect(() => {
    if (options.length && !options.some((o) => o.code === post)) setPost(options[options.length - 1].code);
  }, [unit]); // eslint-disable-line react-hooks/exhaustive-deps

  const headItems = useMemo(() => {
    const heads = (meta?.heads ?? []).map((h) => ({ code: h.code, name: h.name, group: h.kind === 'revenue' ? 'Revenue' : 'Cases', money: h.unit === 'money' }));
    return [...heads.filter((h) => h.group === 'Revenue'), EXTRA_HEADS[0], ...heads.filter((h) => h.group === 'Cases'), ...EXTRA_HEADS.slice(1)];
  }, [meta]);

  const [heads, setHeads] = useState<Set<string>>(new Set(['WR_RABI', 'WR_KHARIF', 'AIT_LAND']));
  const [measures, setMeasures] = useState<Set<Measure>>(new Set(['target', 'achieved', 'balance', 'pct']));
  const [details, setDetails] = useState<Set<Detail>>(new Set(['rank', 'overall']));
  const [sortBy, setSortBy] = useState('overall');
  // unit: one row per unit held (an officer with 3 qanungois = 3 rows); aggregate: one combined row per officer
  const [rowMode, setRowMode] = useState<'unit' | 'aggregate'>('unit');
  const [generated, setGenerated] = useState<{ unitId: string; post: Post; fy: string; mode: 'unit' | 'aggregate' } | null>(null);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['rev', 'league', generated?.unitId, generated?.post, generated?.fy, generated?.mode],
    queryFn: () => get<{ items: Row[]; postLabel: string }>(`/rev/league?unitId=${generated!.unitId}&post=${generated!.post}&fy=${generated!.fy}&mode=${generated!.mode}`),
    enabled: !!generated,
  });

  const chosenHeads = headItems.filter((h) => heads.has(h.code));
  const chosenMeasures = MEASURES.filter((m) => measures.has(m.key));
  const overall = (r: Row) => (perf ? achievement(r.collected, r.target) : r.score);
  const rows = useMemo(() => {
    const ranked = (data?.items ?? [])
      .map((r) => ({ ...r, overall: overall(r) }))
      .sort((a, b) => (b.overall ?? -1) - (a.overall ?? -1))
      .map((r, i) => ({ ...r, rank: r.overall == null ? null : i + 1 }));
    if (sortBy === 'overall') return ranked;
    if (sortBy === 'name') return ranked.slice().sort((a, b) => a.user.name.localeCompare(b.user.name));
    return ranked.slice().sort((a, b) => (b.heads[sortBy]?.pct ?? -1) - (a.heads[sortBy]?.pct ?? -1));
  }, [data, sortBy, perf]); // eslint-disable-line react-hooks/exhaustive-deps

  const value = (c: Cell | undefined, m: Measure, money: boolean) => {
    if (!c) return '';
    const fmt = (v: number) => (money ? fmtPKR(v) : v.toLocaleString());
    if (m === 'target') return fmt(c.of);
    if (m === 'achieved') return fmt(c.done);
    if (m === 'balance') return fmt(Math.max(0, c.of - c.done));
    return c.pct == null ? '' : `${Math.round(c.pct)}%`;
  };
  const detailValue = (r: (typeof rows)[number], d: Detail) => {
    switch (d) {
      case 'rank': return r.rank ?? '';
      case 'overall': return r.overall == null ? '' : perf ? `${Math.round(r.overall)}%` : Math.round(r.overall);
      case 'designation': return r.user.designation ?? '';
      case 'bps': return r.user.bps ?? '';
      case 'phone': return r.user.phone ?? '';
    }
  };
  const chosenDetails = DETAILS.filter((d) => details.has(d.key));
  // District / Tehsil columns only when the list spans more than one
  // Hierarchy columns (e.g. District, Tehsil) appear only when the list spans more than one of them
  const groupCols = groupLevels().filter((l) => new Set(rows.map((r) => r.areas?.[l])).size > 1);
  const areaOf = (r: (typeof rows)[number]) => r.charges.join(', ').replace(/ \(test\)/g, '') + (r.chargeType && r.chargeType !== 'regular' ? (r.chargeType === 'additional' ? ' (Addl. charge)' : ' (Look after)') : '');
  const [selected, setSelected] = useState<string | null>(null);
  const anyMoney = chosenHeads.some((h) => h.money);

  const tableRef = useRef<HTMLTableElement>(null);
  // Layout: officer-wise (one block per officer, a row per KPI — width stays the same however many KPIs)
  // or table (KPIs across, for comparing officers side by side). Officer-wise by default above 3 KPIs.
  const [layout, setLayout] = useState<'officer' | 'table' | null>(null);
  const view = layout ?? (chosenHeads.length > 3 ? 'officer' : 'table');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggleOfficer = (k: string) => setCollapsed((c) => { const n = new Set(c); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  // Full screen: the report fills the window; Esc or "Exit Full Screen" returns to the normal view
  const [full, setFull] = useState(false);
  useEffect(() => {
    if (!full) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setFull(false);
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = prev; };
  }, [full]);
  const exportXlsx = () => exportTableXlsx(tableRef.current, {
    filename: `report-${data?.postLabel ?? post}-${unit?.name}-${fy}`, sheet: data?.postLabel ?? 'Report', freezeCols: view === 'officer' ? 1 : 2 + groupCols.length,
    title: `${data?.postLabel} report · ${unit?.name} · FY ${generated?.fy ?? fy}`,
    subtitle: `Generated ${new Date().toLocaleString()} · ${generated?.mode === 'aggregate' ? 'Aggregated per officer' : 'Unit-wise'} · ${view === 'officer' ? 'Officer-wise layout' : 'Table layout'} · ${perf ? 'Performance mode' : 'KPI evaluation mode'}${anyMoney ? ` · amounts ${MILLIONS}` : ''}`,
  });
  const exportCsv = () => {
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const header = ['S.No', ...groupCols.map((l) => UNIT_LABEL[l]), 'Name', 'Area', ...chosenDetails.map((d) => (d.key === 'overall' ? (perf ? `${T.money} achievement %` : 'KPI score') : d.label)),
      ...chosenHeads.flatMap((h) => chosenMeasures.map((m) => `${h.name} — ${m.label}${h.money && m.key !== 'pct' ? ` ${MILLIONS}` : ''}`))];
    const lines = rows.map((r, i) => [i + 1, ...groupCols.map((l) => r.areas?.[l] ?? ''), r.user.name, areaOf(r), ...chosenDetails.map((d) => detailValue(r, d.key)), ...chosenHeads.flatMap((h) => chosenMeasures.map((m) => value(r.heads[h.code], m.key, h.money).replace(/,/g, '')))].map(esc).join(','));
    const url = URL.createObjectURL(new Blob([[header.map(esc).join(','), ...lines].join('\n')], { type: 'text/csv' }));
    Object.assign(document.createElement('a'), { href: url, download: `report-${data?.postLabel ?? post}-${unit?.name}-${fy}.csv` }).click();
    URL.revokeObjectURL(url);
  };

  const canGenerate = !!unit && options.some((o) => o.code === post) && (chosenHeads.length > 0 || chosenDetails.length > 0) && (chosenHeads.length === 0 || chosenMeasures.length > 0);

  return (
    <>
      <PageHeader title="Report builder" subtitle="Tick the parameters, then generate a list of employees with their figures" actions={<FyPicker />} />

      <div className="grid gap-3 print:hidden xl:grid-cols-[1fr_340px]">
        <Card className="p-4">
          <CheckGroup
            title="KPI heads"
            cols={3}
            items={headItems.map((h) => ({ key: h.code, label: h.name }))}
            value={heads}
            onChange={setHeads}
          />
        </Card>
        <div className="grid gap-3">
          <Card className="p-4"><CheckGroup title="Figures per KPI" items={MEASURES} value={measures} onChange={setMeasures} /></Card>
          <Card className="p-4"><CheckGroup title="Employee details" items={DETAILS} value={details} onChange={setDetails} /></Card>
        </div>
      </div>

      <Card className="mt-3 grid gap-3 p-4 print:hidden md:grid-cols-[1fr_1fr_1fr_auto_auto] md:items-end">
        <Field label="Area">{() => <UnitField value={unit} onChange={setUnit} accept={parentLevels()} />}</Field>
        <Field label="Employees">{(id) => <Select id={id} value={post} onChange={(e) => setPost(e.target.value as Post)}>{options.map((o) => <option key={o.code} value={o.code}>{o.label}</option>)}</Select>}</Field>
        <Field label="Sort by">
          {(id) => (
            <Select id={id} value={sortBy} onChange={(e) => setSortBy(e.target.value)}>
              <option value="overall">{perf ? 'Overall achievement %' : 'KPI score'}</option>
              <option value="name">Name (A–Z)</option>
              {chosenHeads.map((h) => <option key={h.code} value={h.code}>{h.name} %</option>)}
            </Select>
          )}
        </Field>
        <Field label="Rows">
          {() => (
            <div title="Unit-wise: an officer holding several units gets one row per unit. Aggregated: one row per officer, all units combined.">
              <Segmented value={rowMode} onChange={setRowMode} options={[{ value: 'unit', label: 'Unit-wise' }, { value: 'aggregate', label: 'Aggregated' }]} />
            </div>
          )}
        </Field>
        <Button disabled={!canGenerate} onClick={() => setGenerated({ unitId: unit!._id, post, fy, mode: rowMode })}>
          <FileSpreadsheet className="size-4" />Generate
        </Button>
      </Card>

      {!generated ? (
        <Card className="mt-3 print:hidden"><Empty icon={FileSpreadsheet} title="Choose parameters and press Generate" body="Your list will appear here, ready to print or export." /></Card>
      ) : isLoading ? <div className="mt-3"><Loading /></div> : error ? <ErrorState error={error} retry={refetch} /> : !rows.length ? (
        <Card className="mt-3"><Empty title="No employees found" /></Card>
      ) : (
        <div className={clsx('mt-3', full && 'fixed inset-0 z-50 !mt-0 flex flex-col bg-slate-50 p-3 dark:bg-slate-950 print:static print:block print:bg-white print:p-0')}>
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2 print:hidden">
            <span className="text-sm text-slate-600 dark:text-slate-300">
              <b>{rows.length}</b> {data?.postLabel} · {unit?.name} · FY {generated.fy}
              {anyMoney && <span className="ml-1 text-xs text-slate-400">· amounts {MILLIONS}</span>}
            </span>
            <div className="flex flex-wrap items-center gap-2">
              <Segmented value={view} onChange={(v) => setLayout(v)} options={[
                { value: 'officer', label: <span className="flex items-center gap-1 whitespace-nowrap" title="One block per officer, a row per KPI"><LayoutList className="size-4" />Officer-wise</span> },
                { value: 'table', label: <span className="flex items-center gap-1" title="KPIs across, officers down"><Table2 className="size-4" />Table</span> },
              ]} />
              {view === 'officer' && (
                <>
                  <Button variant="ghost" size="sm" onClick={() => setCollapsed(new Set())}>Expand All</Button>
                  <Button variant="ghost" size="sm" onClick={() => setCollapsed(new Set(rows.map((x) => `${x.user._id}-${x.unitId}`)))}>Collapse All</Button>
                </>
              )}
              {full
                ? <Button size="sm" onClick={() => setFull(false)} title="Back to the normal view (Esc)"><Minimize2 className="size-4" />Exit Full Screen</Button>
                : <Button variant="secondary" size="sm" onClick={() => setFull(true)}><Maximize2 className="size-4" />Full Screen</Button>}
              <Button variant="secondary" size="sm" onClick={() => window.print()}><Printer className="size-4" />Print</Button>
              <Button variant="secondary" size="sm" onClick={exportXlsx}><SheetIcon className="size-4" />Excel</Button>
              <Button variant="ghost" size="sm" onClick={exportCsv}>CSV</Button>
            </div>
          </div>

          {/* Printable report */}
          <div className="hidden print:block print:mb-3">
            <div className="text-xs font-bold uppercase tracking-wide">{[session?.tenant.branding?.tagline, session?.tenant.name].filter(Boolean).join(' · ')}</div>
            <div className="text-lg font-bold">{data?.postLabel} report · {unit?.name} · FY {generated.fy}</div>
            <div className="text-xs">Generated <span className="font-semibold">{new Date().toLocaleString()}</span> · {generated.mode === 'aggregate' ? 'Aggregated per officer' : 'Unit-wise'} · {perf ? 'Performance mode' : 'KPI evaluation mode'}{anyMoney && ` · amounts ${MILLIONS}`}</div>
          </div>

          <Card className={clsx('overflow-hidden print:rounded-none print:shadow-none print:ring-0', full && 'flex min-h-0 flex-1 flex-col')}>
            <div className={clsx('overflow-auto print:max-h-none print:overflow-visible', full ? 'min-h-0 flex-1' : 'max-h-[70vh]')}>
              {view === 'officer' ? (
                <OfficerWise rows={rows} heads={chosenHeads} measures={chosenMeasures} details={chosenDetails} perf={perf} areaOf={areaOf} detailValue={detailValue} value={value}
                  groupCols={groupCols} collapsed={collapsed} toggle={toggleOfficer} tableRef={tableRef} />
              ) : (
              <table ref={tableRef} className="w-max min-w-full border-separate border-spacing-0 text-[13px]">
                <thead className="sticky top-0 z-20 bg-brand-700 text-center text-[12.5px] font-semibold text-white print:static">
                  <tr>
                    <th rowSpan={2} className="sticky left-0 z-30 w-10 min-w-10 border-b border-r border-white/60 bg-brand-700 px-1 py-2 text-center print:static">#</th>
                    {groupCols.map((l) => <th key={l} rowSpan={2} className="border-b border-r border-white/60 px-2.5 py-2">{UNIT_LABEL[l]}</th>)}
                    <th rowSpan={2} className="sticky left-10 z-30 border-b border-r border-white/60 bg-brand-700 px-3 py-2 print:static">Name</th>
                    <th rowSpan={2} className="border-b border-r border-white/60 px-2.5 py-2">Area</th>
                    {chosenDetails.map((d) => (
                      <th key={d.key} rowSpan={2} className="border-b border-r border-white/60 px-2.5 py-2">
                        {d.key === 'overall' ? (perf ? 'Achieved' : 'KPI score') : d.label.replace(' (circle / qanungoi)', '').replace(' (achievement % or KPI score)', '')}
                      </th>
                    ))}
                    {chosenHeads.map((h) => (
                      <th key={h.code} colSpan={chosenMeasures.length} className="border-b border-r-2 border-b-white/30 border-r-white/80 px-2 py-1.5 text-center">
                        {h.name}{h.money && <span className="block text-[10.5px] font-normal text-brand-100">{MILLIONS}</span>}
                      </th>
                    ))}
                  </tr>
                  <tr>
                    {chosenHeads.flatMap((h) => chosenMeasures.map((m, i) => (
                      <th key={h.code + m.key} className={clsx('border-b border-white/30 bg-brand-600 px-2 py-1 text-center text-[11.5px] font-medium uppercase tracking-wide text-brand-50', i === chosenMeasures.length - 1 ? 'border-r-2 border-r-white/80' : 'border-r border-r-white/25')}>
                        {m.key === 'achieved' ? (h.group === 'Cases' ? T.disposed : h.code === 'AUDIT' ? 'Settled' : h.code === 'TASKS' ? 'On Time' : T.achieved) : m.key === 'pct' ? '%' : m.label}
                      </th>
                    )))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, idx) => {
                    const key = `${r.user._id}-${r.unitId}`;
                    const on = selected === key;
                    const stickyBg = on ? 'bg-amber-100 dark:bg-amber-500/25' : 'bg-inherit';
                    return (
                    <tr key={key} onClick={() => setSelected(on ? null : key)} aria-selected={on}
                      className={clsx('cursor-pointer', on ? 'bg-amber-100 outline outline-2 -outline-offset-2 outline-amber-400 dark:bg-amber-500/25' : idx % 2 ? 'bg-slate-50/50 hover:bg-slate-100 dark:bg-slate-800/30' : 'hover:bg-slate-50')}>
                      <td className={clsx('sticky left-0 z-10 w-10 min-w-10 border-b border-r border-b-slate-200 border-r-slate-500 px-1 py-1.5 text-center text-xs font-semibold text-slate-500 tabular-nums dark:border-slate-700 print:static', stickyBg)}>{idx + 1}</td>
                      {groupCols.map((l) => <td key={l} className="whitespace-nowrap border-b border-r border-b-slate-200 border-r-slate-500 px-2.5 py-1.5 dark:border-slate-700">{r.areas?.[l]}</td>)}
                      <td className={clsx('sticky left-10 z-10 border-b border-r border-b-slate-200 border-r-slate-500 px-3 py-1.5 dark:border-slate-700 print:static', stickyBg)}>
                        <Link to={`/officers/${r.user._id}`} onClick={(e) => e.stopPropagation()} title={`Open ${r.user.name}'s profile`}
                          className={clsx('whitespace-nowrap font-bold text-slate-900 dark:text-white decoration-2 underline-offset-2 hover:text-brand-700 hover:underline focus-visible:underline', on && 'underline')}>
                          {r.user.name}
                        </Link>
                      </td>
                      <td className="whitespace-nowrap border-b border-r border-b-slate-200 border-r-slate-500 px-2.5 py-1.5 text-slate-700 dark:border-slate-700 dark:text-slate-300">{areaOf(r)}</td>
                      {chosenDetails.map((d) => (
                        <td key={d.key} className="whitespace-nowrap border-b border-r border-b-slate-200 border-r-slate-500 px-2.5 py-1.5 text-slate-700 tabular-nums dark:border-slate-800 dark:text-slate-300">{d.key === 'overall' && perf && r.overall != null ? <span className="font-bold text-slate-900 dark:text-white">{Math.round(r.overall)}%</span> : detailValue(r, d.key)}</td>
                      ))}
                      {chosenHeads.flatMap((h) => chosenMeasures.map((m, i) => {
                        const c = r.heads[h.code];
                        return (
                          <td key={h.code + m.key} className={clsx('whitespace-nowrap border-b border-b-slate-200 px-2 py-1.5 text-center tabular-nums dark:border-b-slate-800', i === chosenMeasures.length - 1 ? 'border-r-2 border-r-slate-500' : 'border-r border-r-slate-200 dark:border-r-slate-700', m.key === 'pct' ? 'font-semibold text-slate-900 dark:text-white' : 'text-slate-700 dark:text-slate-300')}>
                            {m.key === 'pct'
                              ? (c?.pct != null ? `${Math.round(c.pct)}%` : <span className="text-slate-300">—</span>)
                              : (value(c, m.key, h.money) || <span className="text-slate-300">—</span>)}
                          </td>
                        );
                      }))}
                    </tr>
                    );
                  })}
                </tbody>
                {/* Totals for amount/count columns */}
                <tfoot className="bg-slate-50 font-semibold dark:bg-slate-800">
                  <tr>
                    <td className="sticky left-0 w-10 min-w-10 border-t-2 border-r border-slate-200 bg-slate-50 dark:border-slate-700 dark:bg-slate-800 print:static" />
                    {groupCols.map((l) => <td key={l} className="border-t-2 border-r border-t-slate-300 border-r-slate-500" />)}
                    <td className="sticky left-10 border-t-2 border-r border-slate-200 bg-slate-50 px-3 py-2 dark:border-slate-700 dark:bg-slate-800 print:static">Total · {rows.length}</td>
                    <td className="border-t-2 border-r border-t-slate-300 border-r-slate-500" />
                    {chosenDetails.map((d) => <td key={d.key} className="border-t-2 border-r border-t-slate-300 border-r-slate-500 dark:border-slate-700" />)}
                    {chosenHeads.flatMap((h) => {
                      const of = rows.reduce((s, r) => s + (r.heads[h.code]?.of ?? 0), 0);
                      const done = rows.reduce((s, r) => s + (r.heads[h.code]?.done ?? 0), 0);
                      const tot: Cell = { of, done, pct: achievement(done, of) };
                      return chosenMeasures.map((m, i) => (
                        <td key={h.code + m.key} className={clsx('whitespace-nowrap border-t-2 border-t-slate-300 px-2 py-2 text-center tabular-nums dark:border-t-slate-700', i === chosenMeasures.length - 1 ? 'border-r-2 border-r-slate-500' : 'border-r border-r-slate-200 dark:border-r-slate-700')}>
                          {h.code === 'AUDIT' && m.key === 'pct' ? '' : m.key === 'pct' && tot.pct != null ? `${Math.round(tot.pct)}%` : value(tot, m.key, h.money)}
                        </td>
                      ));
                    })}
                  </tr>
                </tfoot>
              </table>
              )}
            </div>
          </Card>
          <p className="mt-1.5 text-[11px] text-slate-400 print:hidden">Registers: figures are items settled / total; % is the amount recovered. Money amounts are {MILLIONS}.</p>
        </div>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ *
 *  Officer-wise layout: one block per officer — the officer's row, then a row per KPI with
 *  Target / Achieved / Balance / % and a bar. The width stays the same however many KPIs are chosen.
 * ------------------------------------------------------------------ */
export type HeadItem = { code: string; name: string; group: string; money: boolean };
type RowX = Pick<Row, 'user' | 'unitId' | 'areas' | 'charges' | 'heads'> & { overall: number | null; rank: number | null; chargeType?: string };
export type OfficerMeasure = Measure;
export type OfficerDetail = Detail;
export function OfficerWise<R extends RowX>({ rows, heads, measures, details, perf, areaOf, detailValue, value, groupCols, collapsed, toggle, tableRef }: {
  rows: R[]; heads: HeadItem[]; measures: { key: Measure; label: string }[]; details: { key: Detail; label: string }[]; perf: boolean;
  areaOf: (r: R) => string; detailValue: (r: R, d: Detail) => string | number; value: (c: Cell | undefined, m: Measure, money: boolean) => string;
  groupCols: string[]; collapsed: Set<string>; toggle: (k: string) => void; tableRef: React.RefObject<HTMLTableElement | null>;
}) {
  const cols = 1 + measures.length + 1; // KPI, measures, progress bar
  const bar = (pct: number | null | undefined) => {
    if (pct == null) return <span className="text-slate-300">—</span>;
    const w = Math.max(2, Math.min(100, pct));
    const tone = pct >= 100 ? 'bg-emerald-600' : pct >= 60 ? 'bg-brand-600' : pct >= 30 ? 'bg-amber-500' : 'bg-rose-500';
    return <div className="h-2.5 w-32 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700"><div className={clsx('h-full rounded-full', tone)} style={{ width: `${w}%` }} /></div>;
  };
  const totals = heads.map((h) => {
    const of = rows.reduce((a, r) => a + (r.heads[h.code]?.of ?? 0), 0);
    const done = rows.reduce((a, r) => a + (r.heads[h.code]?.done ?? 0), 0);
    return { h, c: { of, done, pct: achievement(done, of) } as Cell };
  });
  const kpiRows = (cells: { h: HeadItem; c?: Cell }[]) => cells.map(({ h, c }) => (
    <tr key={h.code}>
      <td className="border-b border-r border-slate-200 py-1.5 pl-2 pr-1.5 leading-tight sm:whitespace-nowrap sm:pl-8 sm:pr-3 dark:border-slate-700">{h.name}{h.money && <span className="ml-1 hidden text-[10.5px] text-slate-400 sm:inline">{MILLIONS}</span>}</td>
      {measures.map((m) => (
        <td key={m.key} className={clsx('whitespace-nowrap border-b border-r border-slate-200 px-1 py-1.5 text-center tabular-nums sm:px-3 dark:border-slate-700', m.key === 'pct' ? 'font-bold text-slate-900 dark:text-white' : 'text-slate-700 dark:text-slate-300')}>
          {m.key === 'pct' ? (c?.pct != null ? `${Math.round(c.pct)}%` : <span className="text-slate-300">—</span>) : (value(c, m.key, h.money) || <span className="text-slate-300">—</span>)}
        </td>
      ))}
      <td className="hidden border-b border-slate-200 px-3 py-1.5 sm:table-cell dark:border-slate-700 print:hidden">{bar(c?.pct)}</td>
    </tr>
  ));
  return (
    <table ref={tableRef} className="w-full border-separate border-spacing-0 text-[12px] sm:min-w-[640px] sm:text-[13px]">
      <thead className="sticky top-0 z-30 bg-brand-700 text-center text-[12.5px] text-white print:static">
        <tr>
          <th className="border-b border-r border-white/50 px-2 py-2 text-left sm:px-3">KPI</th>
          {measures.map((m) => <th key={m.key} className="border-b border-r border-white/50 px-1 py-2 leading-tight sm:px-3">{m.key === 'achieved' ? <><span className="sm:hidden">Done</span><span className="hidden sm:inline">{`${T.achieved} / ${T.disposed}`}</span></> : m.key === 'pct' ? '%' : m.key === 'balance' ? <><span className="sm:hidden">Bal.</span><span className="hidden sm:inline">Balance</span></> : m.label}</th>)}
          <th className="hidden border-b border-white/50 px-3 py-2 sm:table-cell print:hidden">Progress</th>
        </tr>
      </thead>
      {rows.map((r, idx) => {
        const key = `${r.user._id}-${r.unitId}`;
        const open = !collapsed.has(key);
        const facts = [
          ...groupCols.map((l) => r.areas?.[l]).filter(Boolean),
          areaOf(r),
          ...details.filter((d) => d.key !== 'rank' && d.key !== 'overall').map((d) => detailValue(r, d.key)).filter(Boolean),
        ];
        return (
          <tbody key={key} className="break-inside-avoid">
            <tr className="cursor-pointer !bg-brand-50 hover:!bg-brand-100 dark:!bg-brand-900/40" onClick={() => toggle(key)}>
              <td colSpan={cols} className="sticky top-[37px] z-20 border-b border-t-2 border-b-brand-200 border-t-brand-600 bg-inherit px-3 py-2 print:static">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
                  <span className="print:hidden">{open ? <ChevronDown className="size-4 text-brand-700" /> : <ChevronRight className="size-4 text-brand-700" />}</span>
                  <span className="w-8 text-xs font-bold text-slate-500 tabular-nums">{details.some((d) => d.key === 'rank') && r.rank != null ? `#${r.rank}` : idx + 1}</span>
                  <Link to={`/officers/${r.user._id}`} onClick={(e) => e.stopPropagation()} className="font-bold text-slate-900 hover:text-brand-700 hover:underline dark:text-white">{r.user.name}</Link>
                  <span className="text-xs text-slate-600 dark:text-slate-300">{facts.join(' · ')}</span>
                  {details.some((d) => d.key === 'overall') && r.overall != null && (
                    <span className="ml-auto text-sm">{perf ? 'Achieved' : 'KPI score'} <b className="text-slate-900 dark:text-white">{perf ? `${Math.round(r.overall)}%` : Math.round(r.overall)}</b></span>
                  )}
                </div>
              </td>
            </tr>
            {open && kpiRows(heads.map((h) => ({ h, c: r.heads[h.code] })))}
          </tbody>
        );
      })}
      <tbody className="break-inside-avoid">
        <tr className="!bg-slate-100 dark:!bg-slate-800">
          <td colSpan={cols} className="border-b border-t-2 border-b-slate-300 border-t-slate-500 px-3 py-2 font-bold">Total · {rows.length} officer(s)</td>
        </tr>
        {kpiRows(totals)}
      </tbody>
    </table>
  );
}

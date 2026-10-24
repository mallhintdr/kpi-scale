/**
 * Comparing financial years.
 *  - YearsPicker: tick the years to compare (two or more).
 *  - UnitYears: one area or official — every KPI across the chosen years (Performance pages).
 *  - LeagueYears: a list of officials — a block per official, every KPI across the years (Report builder, Staff).
 */
import { useQueries } from '@tanstack/react-query';
import clsx from 'clsx';
import { ArrowDownRight, ArrowUpRight, CalendarRange, ChevronDown, ChevronRight, Minus } from 'lucide-react';
import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { get } from '../lib/api';
import { achievement } from '../lib/mode';
import { mergeByOfficer, type OfficerRowLike } from '../lib/officerRows';
import { Location } from './Location';
import { fmtValue, MILLIONS, T, useMeta } from '../lib/rev';
import { Card, Empty, ErrorState, Loading } from './ui';
import { useCollapse } from './reportTools';
import { useProgressive } from '../lib/progressive';
import type { UnitData } from '../pages/UnitView';

/** Most recent years first, as offered by the organisation's calendar. */
export function YearsPicker({ value, onChange, max = 5 }: { value: string[]; onChange: (v: string[]) => void; max?: number }) {
  const { data: meta } = useMeta();
  const fys = (meta?.fys ?? []).slice(0, max);
  const toggle = (f: string) => onChange(value.includes(f) ? value.filter((x) => x !== f) : [...value, f].sort());
  return (
    <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Financial years to compare">
      {fys.map((f) => {
        const on = value.includes(f);
        return (
          <button key={f} type="button" aria-pressed={on} onClick={() => toggle(f)}
            className={clsx('h-9 rounded-lg px-2.5 text-sm font-medium ring-1 transition', on ? 'bg-indigo-600 text-white ring-indigo-600' : 'bg-white text-slate-700 ring-slate-200 hover:bg-slate-50 dark:bg-slate-900 dark:text-slate-200 dark:ring-slate-700')}>
            FY {f}
          </button>
        );
      })}
    </div>
  );
}

/** Change from the first to the last year, in percentage points. */
function Delta({ from, to }: { from: number | null | undefined; to: number | null | undefined }) {
  if (from == null || to == null) return <span className="text-slate-300">—</span>;
  const d = Math.round(to - from);
  const Icon = d > 0 ? ArrowUpRight : d < 0 ? ArrowDownRight : Minus;
  return (
    <span className={clsx('inline-flex items-center gap-0.5 whitespace-nowrap font-semibold tabular-nums', d > 0 ? 'text-emerald-600' : d < 0 ? 'text-rose-600' : 'text-slate-500')}>
      <Icon className="size-3.5" />{d > 0 ? '+' : ''}{d}<span className="hidden sm:inline">&nbsp;pts</span>
    </span>
  );
}
const pctText = (v: number | null | undefined) => (v == null ? '—' : `${Math.round(v)}%`);

interface YearCell { done: number; of: number; pct: number | null }
interface KpiLine { code: string; name: string; unit?: string; group: string }

function YearsTable({ fys, lines, cell, overall }: {
  fys: string[]; lines: KpiLine[]; cell: (fy: string, code: string) => YearCell | undefined; overall?: (fy: string) => number | null;
}) {
  const th = 'border-b border-r border-white/40 px-2 py-1.5 text-center font-semibold whitespace-nowrap';
  const td = 'border-b border-r border-slate-200 px-2 py-1 text-right tabular-nums whitespace-nowrap dark:border-slate-700';
  return (
    <table className="w-full border-separate border-spacing-0 text-[13px]">
      <thead className="bg-brand-700 text-[12.5px] text-white">
        <tr>
          <th rowSpan={2} className={`${th} text-left`}>KPI</th>
          {fys.flatMap((f) => [
            <th key={`${f}m`} className={`${th} sm:hidden`}>{f.slice(2)}</th>,
            <th key={`${f}d`} colSpan={2} className={`${th} hidden sm:table-cell`}>FY {f}</th>,
          ])}
          <th rowSpan={2} className="border-b border-white/40 px-2 py-1.5 text-center font-semibold">Δ</th>
        </tr>
        <tr className="bg-brand-600 text-[11.5px]">
          {fys.flatMap((f) => [<th key={`${f}a`} className={`${th} hidden sm:table-cell`}>{T.achieved}</th>, <th key={`${f}p`} className={th}>%</th>])}
        </tr>
      </thead>
      <tbody>
        {overall && (
          <tr className="bg-brand-50 font-semibold dark:bg-brand-900/30">
            <td className="border-b border-r border-slate-200 px-2 py-1 dark:border-slate-700">Overall</td>
            {fys.flatMap((f) => [<td key={`${f}a`} className={`${td} hidden sm:table-cell`} />, <td key={`${f}p`} className={td}>{pctText(overall(f))}</td>])}
            <td className="border-b border-slate-200 px-2 py-1 text-center dark:border-slate-700"><Delta from={overall(fys[0])} to={overall(fys[fys.length - 1])} /></td>
          </tr>
        )}
        {lines.map((l) => (
          <tr key={l.code} className="hover:bg-slate-50 dark:hover:bg-slate-800/50">
            <td className="border-b border-r border-slate-200 px-2 py-1 leading-tight dark:border-slate-700">{l.name}{l.unit === 'money' && <span className="ml-1 hidden text-[11px] text-slate-400 sm:inline">{MILLIONS}</span>}</td>
            {fys.flatMap((f) => {
              const c = cell(f, l.code);
              return [
                <td key={`${f}a`} className={clsx(td, 'hidden text-slate-700 sm:table-cell dark:text-slate-300')}>{c ? fmtValue(c.done, l.unit) : '—'}</td>,
                <td key={`${f}p`} className={clsx(td, 'font-semibold text-slate-900 dark:text-white')}>{pctText(c?.pct)}</td>,
              ];
            })}
            <td className="border-b border-slate-200 px-2 py-1 text-center dark:border-slate-700"><Delta from={cell(fys[0], l.code)?.pct} to={cell(fys[fys.length - 1], l.code)?.pct} /></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/* ---------- One area or official across years ---------- */
export function UnitYears({ urlFor, fys }: { urlFor: (fy: string) => string; fys: string[] }) {
  const results = useQueries({ queries: fys.map((fy) => ({ queryKey: ['rev', 'years', urlFor(fy)], queryFn: () => get<UnitData>(urlFor(fy)) })) });
  if (fys.length < 2) return <Card><Empty icon={CalendarRange} title="Choose two or more years" body="Tick the financial years above to compare them side by side." /></Card>;
  if (results.some((r) => r.isLoading)) return <Loading />;
  const failed = results.find((r) => r.error);
  if (failed) return <ErrorState error={failed.error} />;
  const byFy = new Map(fys.map((f, i) => [f, results[i].data!]));
  const lines: KpiLine[] = [];
  const seen = new Set<string>();
  for (const d of byFy.values()) {
    for (const r of d.revenue) if (!seen.has(r.code)) { seen.add(r.code); lines.push({ code: r.code, name: r.name, unit: r.unit, group: 'rev' }); }
    for (const c of d.cases) if (!seen.has(c.code)) { seen.add(c.code); lines.push({ code: c.code, name: c.name, unit: c.unit ?? 'count', group: 'case' }); }
  }
  const cell = (fy: string, code: string): YearCell | undefined => {
    const d = byFy.get(fy);
    const r = d?.revenue.find((x) => x.code === code);
    if (r) return { done: r.collected, of: r.target, pct: achievement(r.collected, r.target) };
    const c = d?.cases.find((x) => x.code === code);
    return c ? { done: c.disposed, of: c.opening + c.received, pct: c.pct } : undefined;
  };
  return (
    <Card className="overflow-x-auto">
      <YearsTable fys={fys} lines={lines} cell={cell} overall={(f) => achievement(byFy.get(f)!.totals.collected, byFy.get(f)!.totals.target)} />
    </Card>
  );
}

/* ---------- A list of officials across years ---------- */
type LeagueItem = OfficerRowLike & { unitList?: { name: string; chargeType: string }[] };

export function LeagueYears({ unitId, post, fys, scopeType, merge, heads }: {
  unitId: string; post: string; fys: string[]; scopeType?: string; merge: boolean;
  heads: { code: string; name: string; money: boolean }[];
}) {
  const results = useQueries({
    queries: fys.map((fy) => ({ queryKey: ['rev', 'league', unitId, post, fy], queryFn: () => get<{ items: LeagueItem[] }>(`/rev/league?unitId=${unitId}&post=${post}&fy=${fy}`) })),
  });
  const loading = results.some((r) => r.isLoading);
  const failed = results.find((r) => r.error);
  // Officials keyed by person + area, so each year's figures line up
  const officers = useMemo(() => {
    if (loading || failed) return [];
    const keyOf = (r: LeagueItem) => `${r.user._id}|${(r.unitList ?? [{ name: r.charges.join(',') }]).map((u) => u.name).join(',')}`;
    const map = new Map<string, { row: LeagueItem; byFy: Map<string, LeagueItem> }>();
    fys.forEach((fy, i) => {
      const items = results[i].data?.items ?? [];
      for (const r of merge ? mergeByOfficer(items) : items) {
        const k = keyOf(r);
        const e = map.get(k) ?? { row: r, byFy: new Map() };
        e.byFy.set(fy, r);
        map.set(k, e);
      }
    });
    const latest = fys[fys.length - 1];
    const overall = (r?: LeagueItem) => (r ? achievement(r.collected, r.target) : null);
    return [...map.entries()]
      .map(([key, e]) => ({ key, ...e, overall: (fy: string) => overall(e.byFy.get(fy)) }))
      .sort((a, b) => (b.overall(latest) ?? -1) - (a.overall(latest) ?? -1));
  }, [results, fys, merge, loading, failed]);
  const blocks = useCollapse(officers.map((o) => o.key));
  const prog = useProgressive(officers.length, 20, `${unitId}|${post}|${fys.join()}`);

  if (fys.length < 2) return <Card><Empty icon={CalendarRange} title="Choose two or more years" /></Card>;
  if (loading) return <Loading />;
  if (failed) return <ErrorState error={failed.error} />;
  if (!officers.length) return <Card><Empty title="No officials found" /></Card>;
  const lines: KpiLine[] = heads.map((h) => ({ code: h.code, name: h.name, unit: h.money ? 'money' : 'count', group: '' }));

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm text-slate-600 dark:text-slate-300"><b>{officers.length}</b> officials · FY {fys.join(', ')}</span>
        <button type="button" onClick={blocks.toggleAll} className="h-9 rounded-xl px-3 text-sm font-medium ring-1 ring-slate-200 hover:bg-slate-50 dark:ring-slate-700 dark:hover:bg-slate-800">
          {blocks.allOpen ? 'Collapse All' : 'Expand All'}
        </button>
      </div>
      {officers.slice(0, prog.shown).map((o, i) => {
        const open = !blocks.collapsed.has(o.key);
        const first = o.overall(fys[0]);
        const last = o.overall(fys[fys.length - 1]);
        return (
          <Card key={o.key} className="overflow-hidden">
            <button type="button" onClick={() => blocks.toggle(o.key)} aria-expanded={open}
              className="block w-full border-l-[6px] border-l-indigo-500 bg-brand-100 px-2 py-1.5 text-left hover:bg-brand-200 sm:px-3 dark:bg-brand-900/70">
              <div className="flex items-center gap-2">
                {open ? <ChevronDown className="size-4 shrink-0 text-brand-700" /> : <ChevronRight className="size-4 shrink-0 text-brand-700" />}
                <span className="shrink-0 text-xs font-bold text-slate-500">{i + 1}</span>
                <Link to={`/officers/${o.row.user._id}`} onClick={(e) => e.stopPropagation()} className="min-w-0 flex-1 truncate font-bold text-slate-900 hover:underline dark:text-white">{o.row.user.name}</Link>
                <span className="shrink-0 text-sm tabular-nums">{pctText(first)} → <b>{pctText(last)}</b></span>
              </div>
              <div className="mt-0.5 flex items-center justify-between gap-2 pl-6 text-xs text-slate-600 dark:text-slate-300">
                <Location row={o.row} scopeType={scopeType} />
                <Delta from={first} to={last} />
              </div>
            </button>
            {open && (
              <div className="overflow-x-auto">
                <YearsTable fys={fys} lines={lines} cell={(fy, code) => o.byFy.get(fy)?.heads[code]} overall={o.overall} />
              </div>
            )}
          </Card>
        );
      })}
      {prog.more && <div ref={prog.sentinel} className="py-3 text-center text-xs text-slate-400">Loading more…</div>}
    </div>
  );
}

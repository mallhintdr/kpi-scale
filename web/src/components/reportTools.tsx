/**
 * Shared by the Report builder and Staff performance:
 *  - ReportToolbar: Officer-wise / Table switch, Expand ↔ Collapse toggle, Full screen, Print, Excel, CSV
 *  - OfficerWise: one block per officer (name and % on one row), then a row per KPI
 *  - useFullScreen: the report fills the window; Esc returns
 */
import clsx from 'clsx';
import { ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, FileText, LayoutList, Maximize2, Minimize2, Printer, Sheet as SheetIcon, Table2 } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode, type RefObject } from 'react';
import { Link } from 'react-router-dom';
import { achievement } from '../lib/mode';
import { MILLIONS, T } from '../lib/rev';
import { Button, Segmented } from './ui';

export interface Cell { pct: number | null; done: number; of: number }
export type Measure = 'target' | 'achieved' | 'balance' | 'pct';
export type HeadItem = { code: string; name: string; group: string; money: boolean };
export type Layout = 'officer' | 'table';

export function useFullScreen() {
  const [full, setFull] = useState(false);
  useEffect(() => {
    if (!full) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setFull(false);
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [full]);
  return [full, setFull] as const;
}

/**
 * Collapsed officer blocks, with a single toggle for all of them. Long lists (more than `autoOver`
 * officers) start collapsed — one row per officer — so thousands of KPI rows are not drawn up front.
 */
export function useCollapse(keys: string[], autoOver = 25) {
  const big = keys.length > autoOver;
  // `open` = everything open except the listed keys; otherwise everything closed except them
  const [state, setState] = useState<{ open: boolean; except: Set<string>; big: boolean }>({ open: !big, except: new Set(), big });
  // A list that grows past the threshold (data arrived) switches to collapsed once
  useEffect(() => {
    if (big !== state.big) setState({ open: !big, except: new Set(), big });
  }, [big]); // eslint-disable-line react-hooks/exhaustive-deps -- react to size class only
  const keyStr = keys.join('|');
  const collapsed = useMemo(
    () => (state.open ? state.except : new Set(keys.filter((k) => !state.except.has(k)))),
    [state, keyStr], // eslint-disable-line react-hooks/exhaustive-deps -- keyStr tracks keys
  );
  const toggle = (k: string) => setState((st) => { const e = new Set(st.except); if (e.has(k)) e.delete(k); else e.add(k); return { ...st, except: e }; });
  const allOpen = collapsed.size === 0;
  const toggleAll = () => setState((st) => ({ ...st, open: !allOpen, except: new Set() }));
  return { collapsed, toggle, allOpen, toggleAll };
}

/** Container classes for the report area, normal or full screen. */
export const fullWrap = (full: boolean) => clsx(full && 'fixed inset-0 z-50 flex flex-col bg-slate-50 p-3 dark:bg-slate-950 print:static print:block print:bg-white print:p-0');
export const fullCard = (full: boolean) => clsx('overflow-hidden print:rounded-none print:shadow-none print:ring-0', full && 'flex min-h-0 flex-1 flex-col');
export const fullScroll = (full: boolean) => clsx('overflow-auto print:max-h-none print:overflow-visible', full ? 'min-h-0 flex-1' : 'max-h-[70vh]');

export function ReportToolbar({ info, view, onView, allOpen, onToggleAll, full, onFull, onExcel, onCsv, onPrint }: {
  info: ReactNode; view: Layout; onView: (v: Layout) => void; allOpen: boolean; onToggleAll: () => void;
  full: boolean; onFull: (v: boolean) => void; onExcel: () => void; onCsv: () => void; onPrint?: () => void;
}) {
  return (
    <div className="mb-2 flex flex-wrap items-center justify-between gap-2 print:hidden">
      <span className="text-sm text-slate-600 dark:text-slate-300">{info}</span>
      <div className="flex flex-wrap items-center gap-1.5 [&_button]:px-2.5 sm:[&_button]:px-3">
        <Segmented value={view} onChange={onView} options={[
          { value: 'officer', label: <span className="flex items-center gap-1 whitespace-nowrap" title="One block per officer, a row per KPI"><LayoutList className="size-4 text-violet-600" />Officer-wise</span> },
          { value: 'table', label: <span className="flex items-center gap-1 whitespace-nowrap" title="KPIs across, officers down"><Table2 className="size-4 text-sky-600" />Table</span> },
        ]} />
        {view === 'officer' && (
          <Button variant="secondary" size="sm" onClick={onToggleAll} aria-pressed={!allOpen}>
            {allOpen ? <><ChevronsDownUp className="size-4 text-indigo-600" />Collapse all</> : <><ChevronsUpDown className="size-4 text-indigo-600" />Expand all</>}
          </Button>
        )}
        {full
          ? <Button size="sm" onClick={() => onFull(false)} title="Back to the normal view (Esc)"><Minimize2 className="size-4" /><span className="hidden sm:inline">Exit full screen</span></Button>
          : <Button variant="secondary" size="sm" onClick={() => onFull(true)} title="Full screen" aria-label="Full screen"><Maximize2 className="size-4 text-brand-600" /><span className="hidden sm:inline">Full screen</span></Button>}
        <Button variant="secondary" size="sm" onClick={onPrint ?? (() => window.print())} title="Print" aria-label="Print"><Printer className="size-4 text-slate-700 dark:text-slate-200" /><span className="hidden sm:inline">Print</span></Button>
        <Button variant="secondary" size="sm" onClick={onExcel} title="Excel" aria-label="Excel"><SheetIcon className="size-4 text-emerald-600" /><span className="hidden sm:inline">Excel</span></Button>
        <Button variant="secondary" size="sm" onClick={onCsv} title="CSV" aria-label="CSV"><FileText className="size-4 text-amber-600" /><span className="hidden sm:inline">CSV</span></Button>
      </div>
    </div>
  );
}

export interface OfficerRow {
  key: string;
  userId: string;
  name: string;
  /** Rank or serial shown before the name. */
  serial: string | number;
  /** Lines shown under the name: location (two lines), then any other details. */
  facts: string[];
  /** Headline figure on the right of the name row, e.g. "82%". */
  headline?: { label: string; value: string } | null;
  heads: Record<string, Cell | undefined>;
}

/** Ribbon / tint for the officer row, by achievement. */
const tone = (pct: number | null | undefined) =>
  pct == null ? 'border-l-slate-400' : pct >= 100 ? 'border-l-emerald-600' : pct >= 60 ? 'border-l-brand-600' : pct >= 30 ? 'border-l-amber-500' : 'border-l-rose-500';

export function OfficerWise({ rows, heads, measures, value, collapsed, toggle, tableRef, linkSuffix = '', toneOf, shown, sentinel }: {
  rows: OfficerRow[]; heads: HeadItem[]; measures: { key: Measure; label: string }[];
  value: (c: Cell | undefined, m: Measure, money: boolean) => string;
  collapsed: Set<string>; toggle: (k: string) => void; tableRef: RefObject<HTMLTableElement | null>;
  linkSuffix?: string; toneOf?: (r: OfficerRow) => number | null | undefined;
  /** Draw only the first `shown` officers (more are added on scroll); totals still use every row. */
  shown?: number; sentinel?: (el: Element | null) => void;
}) {
  const cols = 1 + measures.length + 1;
  const bar = (pct: number | null | undefined) => {
    if (pct == null) return <span className="text-slate-300">—</span>;
    const w = Math.max(2, Math.min(100, pct));
    const c = pct >= 100 ? 'bg-emerald-600' : pct >= 60 ? 'bg-brand-600' : pct >= 30 ? 'bg-amber-500' : 'bg-rose-500';
    return <div className="h-2.5 w-32 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700"><div className={clsx('h-full rounded-full', c)} style={{ width: `${w}%` }} /></div>;
  };
  const totals = heads.map((h) => {
    const of = rows.reduce((a, r) => a + (r.heads[h.code]?.of ?? 0), 0);
    const done = rows.reduce((a, r) => a + (r.heads[h.code]?.done ?? 0), 0);
    return { h, c: { of, done, pct: achievement(done, of) } as Cell };
  });
  const kpiRows = (cells: { h: HeadItem; c?: Cell }[]) => cells.map(({ h, c }) => (
    <tr key={h.code} className="hover:bg-slate-50 dark:hover:bg-slate-800/50">
      <td className="border-b border-r border-slate-200 py-1 pl-3 pr-1.5 leading-tight sm:whitespace-nowrap sm:pl-8 sm:pr-3 dark:border-slate-700">{h.name}{h.money && <span className="ml-1 hidden text-[11.5px] text-slate-400 sm:inline">{MILLIONS}</span>}</td>
      {measures.map((m) => (
        <td key={m.key} className={clsx('whitespace-nowrap border-b border-r border-slate-200 px-1 py-1 text-center tabular-nums sm:px-3 dark:border-slate-700', m.key === 'pct' ? 'font-bold text-slate-900 dark:text-white' : 'text-slate-700 dark:text-slate-300')}>
          {m.key === 'pct' ? (c?.pct != null ? `${Math.round(c.pct)}%` : <span className="text-slate-300">—</span>) : (value(c, m.key, h.money) || <span className="text-slate-300">—</span>)}
        </td>
      ))}
      <td className="hidden border-b border-slate-200 px-3 py-1 sm:table-cell dark:border-slate-700 print:hidden">{bar(c?.pct)}</td>
    </tr>
  ));
  return (
    <table ref={tableRef} className="w-full border-separate border-spacing-0 text-[13px] sm:min-w-[640px] sm:text-[14px]">
      <thead className="sticky top-0 z-30 bg-brand-700 text-center text-[13.5px] text-white print:static">
        <tr>
          <th className="border-b border-r border-white/50 px-2 py-2 text-left sm:px-3">KPI</th>
          {measures.map((m) => (
            <th key={m.key} className="border-b border-r border-white/50 px-1 py-2 leading-tight sm:px-3">
              {m.key === 'achieved' ? <><span className="sm:hidden">Done</span><span className="hidden sm:inline">{`${T.achieved} / ${T.disposed}`}</span></> : m.key === 'pct' ? '%' : m.key === 'balance' ? <><span className="sm:hidden">Bal.</span><span className="hidden sm:inline">Balance</span></> : m.label}
            </th>
          ))}
          <th className="hidden border-b border-white/50 px-3 py-2 sm:table-cell print:hidden">Progress</th>
        </tr>
      </thead>
      {rows.slice(0, shown ?? rows.length).map((r) => {
        const open = !collapsed.has(r.key);
        return (
          <tbody key={r.key} className="break-inside-avoid">
            <tr className="cursor-pointer" onClick={() => toggle(r.key)} aria-expanded={open}>
              <td colSpan={cols} className={clsx('sticky top-[37px] z-20 border-b border-l-[6px] border-t border-b-brand-300 border-t-brand-300 bg-brand-100 px-2 py-1.5 hover:bg-brand-200 sm:px-3 dark:border-b-brand-800 dark:border-t-brand-800 dark:bg-brand-900/70 dark:hover:bg-brand-900 print:static', tone(toneOf?.(r)))}>
                {/* Name on the left, headline % on the right — always one row */}
                <div className="flex items-center gap-2">
                  <span className="print:hidden">{open ? <ChevronDown className="size-4 text-brand-700 dark:text-brand-300" /> : <ChevronRight className="size-4 text-brand-700 dark:text-brand-300" />}</span>
                  <span className="shrink-0 text-xs font-bold text-slate-500 tabular-nums dark:text-slate-400">{r.serial}</span>
                  <Link to={`/officers/${r.userId}${linkSuffix}`} onClick={(e) => e.stopPropagation()} className="min-w-0 flex-1 truncate font-bold text-slate-900 hover:text-brand-700 hover:underline dark:text-white">{r.name}</Link>
                  {r.headline && (
                    <span className="shrink-0 whitespace-nowrap text-sm"><span className="hidden text-slate-600 sm:inline dark:text-slate-300">{r.headline.label} </span><b className="text-slate-900 tabular-nums dark:text-white">{r.headline.value}</b></span>
                  )}
                </div>
                {r.facts.map((f, i) => <div key={i} className="w-0 min-w-full break-words pl-6 text-xs leading-snug text-slate-600 dark:text-slate-300">{f}</div>)}
              </td>
            </tr>
            {open && kpiRows(heads.map((h) => ({ h, c: r.heads[h.code] })))}
          </tbody>
        );
      })}
      {shown != null && shown < rows.length && <tbody><tr ref={sentinel}><td colSpan={cols} className="py-3 text-center text-xs text-slate-400">Loading more…</td></tr></tbody>}
      <tbody className="break-inside-avoid">
        <tr>
          <td colSpan={cols} className="border-b border-l-[6px] border-t-2 border-b-slate-300 border-l-slate-600 border-t-slate-500 bg-slate-200 px-3 py-1.5 font-bold dark:bg-slate-800">Total · {rows.length} officer(s)</td>
        </tr>
        {kpiRows(totals)}
      </tbody>
    </table>
  );
}

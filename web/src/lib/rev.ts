import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import { get } from './api';

export type UnitType = 'division' | 'district' | 'tehsil' | 'qanungoi' | 'circle' | 'mouza';
export type Post = 'commissioner' | 'dc' | 'adc_rev' | 'ac' | 'tehsildar' | 'naib_tehsildar' | 'girdawar' | 'patwari' | 'wasilbaqi' | 'sci';
export type Block = 'revenue' | 'arrears' | 'cases' | 'audit' | 'tasks';
export type RevBand = 'outstanding' | 'good' | 'satisfactory' | 'below' | 'poor' | 'n/a';

export interface HeadDef {
  code: string; name: string; group: string; kind: 'revenue' | 'case'; crop?: 'rabi' | 'kharif';
  enteredBy: 'patwari' | 'wasilbaqi' | 'sci' | 'ro'; level: 'circle' | 'ro'; weight: number;
}
export interface Meta { heads: HeadDef[]; posts: { code: Post; label: string }[]; auditCategories: string[]; currentFy: string; fys: string[] }
export interface UnitRef { _id: string; type: UnitType; name: string; code?: string }
export interface RevMe {
  isAdmin: boolean;
  roots: UnitRef[];
  charges: { _id: string; post: Post; postLabel: string; chargeType: string; unit: UnitRef; path: string[] }[];
}

export const BLOCK_LABEL: Record<Block, string> = {
  revenue: 'Revenue recovery', arrears: 'Arrears recovery', cases: 'Case disposal', audit: 'Audit paras', tasks: 'Tasks on time',
};
export const UNIT_LABEL: Record<UnitType, string> = {
  division: 'Division', district: 'District', tehsil: 'Tehsil', qanungoi: 'Qanungoi', circle: 'Patwar Circle', mouza: 'Mouza',
};
export const LEVEL_LABEL: Record<string, string> = {
  patwari: 'Patwari', girdawar: 'Girdawar', ro: 'Tehsildar / Naib Tehsildar', tehsil: 'Tehsil / AC', district: 'District / DC / ADC(R)', division: 'Division / Commissioner',
};

/** Score bands map onto the status palette; badges always pair the colour with an icon + label. */
export const REV_BAND: Record<RevBand, { label: string; tone: string; color: string }> = {
  outstanding: { label: 'Outstanding', tone: 'bg-emerald-50 text-emerald-800 ring-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-500/30', color: 'var(--st-good)' },
  good: { label: 'Good', tone: 'bg-sky-50 text-sky-800 ring-sky-200 dark:bg-sky-500/10 dark:text-sky-300 dark:ring-sky-500/30', color: 'var(--st-ok)' },
  satisfactory: { label: 'Satisfactory', tone: 'bg-amber-50 text-amber-800 ring-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-500/30', color: 'var(--st-warning)' },
  below: { label: 'Below par', tone: 'bg-orange-50 text-orange-800 ring-orange-200 dark:bg-orange-500/10 dark:text-orange-300 dark:ring-orange-500/30', color: 'var(--st-serious)' },
  poor: { label: 'Poor', tone: 'bg-rose-50 text-rose-800 ring-rose-200 dark:bg-rose-500/10 dark:text-rose-300 dark:ring-rose-500/30', color: 'var(--st-critical)' },
  'n/a': { label: 'No data', tone: 'bg-slate-50 text-slate-600 ring-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:ring-slate-700', color: 'var(--st-none)' },
};
export const bandOf = (v: number | null | undefined): RevBand =>
  v == null ? 'n/a' : v >= 90 ? 'outstanding' : v >= 75 ? 'good' : v >= 60 ? 'satisfactory' : v >= 40 ? 'below' : 'poor';
/** Mark colour (fills, strokes) for a 0–100 value. Never use for text. */
export const revColor = (v: number | null | undefined) => REV_BAND[bandOf(v)].color;

/** Pakistani number formatting: lakh / crore. */
export const fmtPKR = (v: number | null | undefined, opts: { short?: boolean } = { short: true }) => {
  if (v == null) return '—';
  const abs = Math.abs(v);
  if (opts.short && abs >= 1e7) return `${(v / 1e7).toLocaleString(undefined, { maximumFractionDigits: 2 })} Cr`;
  if (opts.short && abs >= 1e5) return `${(v / 1e5).toLocaleString(undefined, { maximumFractionDigits: 2 })} Lac`;
  return v.toLocaleString('en-PK', { maximumFractionDigits: 0 });
};
export const fmtPct = (v: number | null | undefined) => (v == null ? '—' : `${Math.round(v * 10) / 10}%`);

export const monthLabel = (m: string) => new Date(`${m}-15`).toLocaleDateString(undefined, { month: 'short', year: 'numeric' });

export const useMeta = () => useQuery({ queryKey: ['rev', 'meta'], queryFn: () => get<Meta>('/rev/meta'), staleTime: Infinity });
export const useRevMe = () => useQuery({ queryKey: ['rev', 'me'], queryFn: () => get<RevMe>('/rev/me'), staleTime: 300_000 });

/** What the signed-in officer can do, derived from their postings. */
export function useCaps() {
  const { data } = useRevMe();
  const posts = new Set(data?.charges.map((c) => c.post) ?? []);
  return {
    loaded: !!data,
    isAdmin: !!data?.isAdmin,
    isWasilBaqi: posts.has('wasilbaqi') || !!data?.isAdmin,
    isPatwari: posts.has('patwari'),
    isSci: posts.has('sci'),
    isRO: posts.has('tehsildar') || posts.has('naib_tehsildar'),
    canEnter: posts.has('patwari') || posts.has('wasilbaqi') || posts.has('sci') || posts.has('tehsildar') || posts.has('naib_tehsildar'),
    isOfficer: [...posts].some((p) => !['patwari', 'wasilbaqi', 'sci'].includes(p)) || !!data?.isAdmin,
    roots: data?.roots ?? [],
    charges: data?.charges ?? [],
  };
}

/** Selected fiscal year, remembered per device. */
export function useFy() {
  const { data: meta } = useMeta();
  const [fy, setFyState] = useState<string | null>(() => {
    try {
      return localStorage.getItem('fy');
    } catch {
      return null;
    }
  });
  useEffect(() => {
    if (meta && (!fy || !meta.fys.includes(fy))) setFyState(meta.currentFy);
  }, [meta, fy]);
  const setFy = useCallback((v: string) => {
    setFyState(v);
    try {
      localStorage.setItem('fy', v);
    } catch {
      /* storage unavailable */
    }
  }, []);
  return [fy ?? meta?.currentFy ?? '', setFy, meta?.fys ?? []] as const;
}

/** Months of a fiscal year up to the current month, latest first. */
export const fyMonthsUpToNow = (fy: string) => {
  const y = Number(fy.slice(0, 4));
  const now = new Date();
  const cur = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  return Array.from({ length: 12 }, (_, i) => {
    const m = (6 + i) % 12;
    return `${m < 6 ? y + 1 : y}-${String(m + 1).padStart(2, '0')}`;
  })
    .filter((m) => m <= cur)
    .reverse();
};

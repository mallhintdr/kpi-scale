/**
 * Organisation adapter: everything the screens need to know about the signed-in organisation —
 * its hierarchy, posts, KPIs, scoring blocks, money format and financial year — comes from the
 * organisation's blueprint (/rev/meta). Nothing here is specific to one department.
 */
import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import { get } from './api';

export type UnitType = string;
export type Post = string;
export type Block = string;
export type RevBand = string;

export interface HeadDef {
  code: string; name: string; group: string; block: string; unit: 'money' | 'count' | 'number';
  kind: 'revenue' | 'case'; crop?: string; tag?: string; perHolder: boolean; level: string; weight: number; arrears: boolean;
  enterPosts: string[]; verifyPosts: string[]; holderPosts: string[];
}
export interface LevelDef { key: string; label: string; plural?: string; profile?: string }
export interface PostDef {
  key: string; label: string; levels: string[]; single: boolean; scored: boolean; profile?: string; widenTo?: string;
  oversightAt: string[]; exclusiveWith: string[]; caps: string[];
}
export interface BlockDef { key: string; label: string; kind: 'target' | 'arrears' | 'flow' | 'register' | 'tasks' }
export interface RegisterDef { key: string; label: string; block: string; levels: string[]; enterPosts: string[]; categories: string[]; amountLabel: string }
export interface Meta {
  version: number; name: string; industry?: string;
  levels: LevelDef[]; posts: PostDef[]; blocks: BlockDef[]; metrics: unknown[]; registers: RegisterDef[];
  profiles: { key: string; label: string; weights: Record<string, number> }[];
  tags: { key: string; label: string }[];
  bands: { key: string; label: string; min: number }[];
  calendar: { fyStartMonth: number };
  money: { currency: string; symbol: string; scale: number; scaleLabel: string; decimals: number };
  terms: Terms;
  heads: HeadDef[]; auditCategories: string[]; currentFy: string; fys: string[];
}
export interface Terms { money: string; achieved: string; flowGroup: string; disposed: string; pending: string; items: string; reference: string }
export interface UnitRef { _id: string; type: UnitType; name: string; code?: string }
export interface RevMe {
  isAdmin: boolean;
  roots: UnitRef[];
  browseRoots: UnitRef[];
  canCompare: boolean;
  caps: { canEnter: boolean; canVerify: boolean; canSetTargets: boolean; canAssign: boolean; canCompare: boolean; canManageRegisters: boolean; registers: string[]; isScored: boolean };
  charges: { _id: string; post: Post; postLabel: string; chargeType: string; unit: UnitRef; path: string[] }[];
  /** Rights granted to this person directly, on a unit and everything below it. */
  grants: { _id: string; unitId: string; rights: string[]; metrics: string[]; unit: (UnitRef & { anc: string[] }) | null }[];
}

/* ------------------------------------------------------------------ *
 *  Current organisation (set when /rev/meta loads). Lookups fall back to the key.
 * ------------------------------------------------------------------ */
let org: Meta | null = null;
const titleCase = (k: string) => k.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
const lookup = (pick: (m: Meta, key: string) => string | undefined) =>
  new Proxy({} as Record<string, string>, { get: (_t, key: string) => (org && pick(org, key)) ?? (typeof key === 'string' ? titleCase(key) : key) });

/** Level label by key, e.g. UNIT_LABEL.circle → "Patwar Circle". */
export const UNIT_LABEL = lookup((m, k) => m.levels.find((l) => l.key === k)?.label);
export const UNIT_PLURAL = lookup((m, k) => {
  const l = m.levels.find((x) => x.key === k);
  return l ? (l.plural ?? `${l.label}s`) : undefined;
});
/** Weight profile label by key. */
export const LEVEL_LABEL = lookup((m, k) => m.profiles.find((p) => p.key === k)?.label);
/** Scoring block label by key. */
export const BLOCK_LABEL = lookup((m, k) => m.blocks.find((b) => b.key === k)?.label);
export const POST_LABEL = lookup((m, k) => m.posts.find((p) => p.key === k)?.label);
export const postPlural = (k: string) => {
  const l = POST_LABEL[k];
  return /s$/i.test(l) ? l : l.replace(/^(\S+)(.*)$/, (_m, a, b) => (b && /^\s*\(/.test(b) ? `${a}s${b}` : `${l}s`));
};

const DEFAULT_TERMS: Terms = { money: 'Revenue', achieved: 'Achieved', flowGroup: 'Workload', disposed: 'Disposed', pending: 'Pending', items: 'items', reference: 'Reference no.' };
/** The organisation's own words, e.g. T.achieved → "Recovered" (Revenue) or "Achieved" (Sales). */
export const T = new Proxy({} as Terms, { get: (_t, k: keyof Terms) => org?.terms?.[k] ?? DEFAULT_TERMS[k] });
/** Currency symbol, e.g. "Rs". */
export const sym = () => org?.money.symbol ?? 'Rs';
/** "(Rs)" style caption for full-amount inputs. */
export const symCaption = () => `(${sym()})`;
/** Money with its symbol in full, e.g. "Rs 12,500". */
export const fmtFull = (v: number) => `${sym()} ${v.toLocaleString()}`;

/** Organisation money caption shown once per card/chart, e.g. "(Rs in Millions)". Live binding. */
export let MILLIONS = '(Rs in Millions)';

export function setOrg(m: Meta) {
  org = m;
  MILLIONS = m.money.scale === 1 ? `(${m.money.symbol})` : `(${m.money.symbol} in ${m.money.scaleLabel})`;
}
export const getOrg = () => org;

/** Levels from the top of the hierarchy down. */
export const levels = () => org?.levels ?? [];
export const levelIndex = (k: string) => levels().findIndex((l) => l.key === k);
export const leafLevel = () => levels()[levels().length - 1]?.key;
/** Levels strictly below `k`. */
export const levelsBelow = (k: string) => levels().slice(levelIndex(k) + 1);
/** Levels that hold other units (everything but the lowest). */
export const parentLevels = () => levels().slice(0, -1).map((l) => l.key);
/** Deepest level where KPIs are recorded. */
const deepestMetricLevel = () => Math.max(-1, ...(org?.heads ?? []).map((h) => levelIndex(h.level)));
/** Levels worth comparing side by side under an area: below it, above the level KPIs are recorded at. */
export const compareLevelsUnder = (k: string) => levels().filter((_l, i) => i > levelIndex(k) && i < deepestMetricLevel());
/** Areas from which a comparison makes sense. */
export const compareAreaLevels = () => levels().filter((_l, i) => i < deepestMetricLevel() - 1).map((l) => l.key);
/** Scored posts that sit below a unit of level `k` (for leagues and staff lists). */
export const postsUnder = (k: string) =>
  (org?.posts ?? []).filter((p) => p.scored && p.levels.some((l) => levelIndex(l) > levelIndex(k))).map((p) => ({ code: p.key, label: postPlural(p.key) }));
/** Hierarchy columns shown in lists (e.g. District, Tehsil): levels below the top, above the KPI units' parents. */
export const groupLevels = () => levels().slice(1, Math.max(2, deepestMetricLevel() - 1)).map((l) => l.key);
/** Scored posts with holders at this level (a unit there with none is "vacant"). */
export const staffedLevel = (k: string) => (org?.posts ?? []).some((p) => p.scored && p.levels.includes(k));
export const tagLabel = (k?: string | null) => (k ? (org?.tags.find((t) => t.key === k)?.label ?? titleCase(k)) : '');

/* ------------------------------------------------------------------ *
 *  Bands (thresholds from the blueprint; colours fixed by rank)
 * ------------------------------------------------------------------ */
const TONES = [
  { tone: 'bg-emerald-50 text-emerald-800 ring-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-500/30', color: 'var(--st-good)' },
  { tone: 'bg-sky-50 text-sky-800 ring-sky-200 dark:bg-sky-500/10 dark:text-sky-300 dark:ring-sky-500/30', color: 'var(--st-ok)' },
  { tone: 'bg-amber-50 text-amber-800 ring-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-500/30', color: 'var(--st-warning)' },
  { tone: 'bg-orange-50 text-orange-800 ring-orange-200 dark:bg-orange-500/10 dark:text-orange-300 dark:ring-orange-500/30', color: 'var(--st-serious)' },
  { tone: 'bg-rose-50 text-rose-800 ring-rose-200 dark:bg-rose-500/10 dark:text-rose-300 dark:ring-rose-500/30', color: 'var(--st-critical)' },
];
const NA = { label: 'No data', tone: 'bg-slate-50 text-slate-600 ring-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:ring-slate-700', color: 'var(--st-none)' };
const DEFAULT_BANDS = [
  { key: 'outstanding', label: 'Outstanding', min: 90 },
  { key: 'good', label: 'Good', min: 75 },
  { key: 'satisfactory', label: 'Satisfactory', min: 60 },
  { key: 'below', label: 'Below par', min: 40 },
  { key: 'poor', label: 'Poor', min: 0 },
];
const bands = () => [...(org?.bands ?? DEFAULT_BANDS)].sort((a, b) => b.min - a.min);
/** Badge styling per band key; colours run best → worst across however many bands the organisation has. */
export const REV_BAND = new Proxy({} as Record<string, { label: string; tone: string; color: string }>, {
  get: (_t, key: string) => {
    if (key === 'n/a') return NA;
    const list = bands();
    const i = list.findIndex((b) => b.key === key);
    if (i < 0) return NA;
    const t = TONES[Math.round((i / Math.max(1, list.length - 1)) * (TONES.length - 1))];
    return { label: list[i].label, ...t };
  },
});
export const bandOf = (v: number | null | undefined): RevBand => (v == null ? 'n/a' : (bands().find((b) => v >= b.min)?.key ?? bands()[bands().length - 1].key));
/** Mark colour (fills, strokes) for a 0–100 value. Never use for text. */
export const revColor = (v: number | null | undefined) => REV_BAND[bandOf(v)].color;

/* ------------------------------------------------------------------ *
 *  Formatting
 * ------------------------------------------------------------------ */
/**
 * Money in the organisation's display scale (e.g. millions) with no unit text; each card/chart carries
 * a single MILLIONS caption instead. Pass { exact: true } for full amounts (verification).
 */
export const fmtPKR = (v: number | null | undefined, opts: { exact?: boolean } = {}) => {
  if (v == null) return '—';
  if (opts.exact) return v.toLocaleString('en-PK', { maximumFractionDigits: 0 });
  const m = org?.money ?? { scale: 1e6, decimals: 2 };
  return (v / m.scale).toLocaleString('en-PK', { minimumFractionDigits: m.decimals, maximumFractionDigits: m.decimals });
};
export const fmtMoney = fmtPKR;
/** A KPI value in its own unit (money scaled, counts as integers). */
export const fmtValue = (v: number | null | undefined, unit: string | undefined) => (unit === 'money' ? fmtPKR(v) : v == null ? '—' : v.toLocaleString());

export const fmtPct = (v: number | null | undefined) => (v == null ? '—' : `${Math.round(v * 10) / 10}%`);
export const monthLabel = (m: string) => new Date(`${m}-15`).toLocaleDateString(undefined, { month: 'short', year: 'numeric' });

/* ------------------------------------------------------------------ *
 *  Queries
 * ------------------------------------------------------------------ */
export const useMeta = () =>
  useQuery({
    queryKey: ['rev', 'meta'],
    queryFn: async () => {
      const m = await get<Meta>('/rev/meta');
      setOrg(m);
      return m;
    },
    staleTime: 300_000,
  });
export const useRevMe = () => useQuery({ queryKey: ['rev', 'me'], queryFn: () => get<RevMe>('/rev/me'), staleTime: 300_000 });

/** What the signed-in person can do, derived on the server from their postings and the blueprint. */
export function useCaps() {
  const { data } = useRevMe();
  const c = data?.caps;
  const admin = !!data?.isAdmin;
  return {
    loaded: !!data,
    isAdmin: admin,
    canEnter: !!c?.canEnter,
    canVerify: !!c?.canVerify,
    canSetTargets: !!c?.canSetTargets,
    canAssign: !!c?.canAssign,
    canManageRegisters: !!c?.canManageRegisters,
    registers: c?.registers ?? [],
    isScored: !!c?.isScored,
    // Older names kept so screens read naturally
    isOfficer: !!c?.canAssign,
    isWasilBaqi: !!c?.canSetTargets,
    roots: data?.roots ?? [],
    browseRoots: data?.browseRoots ?? [],
    canCompare: !!data?.canCompare,
    /** Best starting unit for read-only lists: own jurisdiction if it has staff below it, else the organisation. */
    viewRoot: (data?.roots ?? []).find((r) => parentLevels().slice(0, -1).includes(r.type) || (org && levelIndex(r.type) < levels().length - 2)) ?? data?.browseRoots?.[0] ?? null,
    charges: data?.charges ?? [],
    grants: data?.grants ?? [],
  };
}

/** Selected financial year, remembered per device. */
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

/** Months of a financial year up to the current month, latest first. */
export const fyMonthsUpToNow = (fy: string) => {
  const sm = (org?.calendar.fyStartMonth ?? 7) - 1;
  const y = Number(fy.slice(0, 4));
  const now = new Date();
  const cur = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  return Array.from({ length: 12 }, (_, i) => {
    const m = (sm + i) % 12;
    return `${sm + i >= 12 ? y + 1 : y}-${String(m + 1).padStart(2, '0')}`;
  })
    .filter((m) => m <= cur)
    .reverse();
};

import type { Band, Unit } from './types';

export const fmtNum = (v: number | null | undefined, digits = 1) =>
  v == null ? '—' : Number(v).toLocaleString(undefined, { maximumFractionDigits: digits });

export const fmtUnit = (v: number | null | undefined, unit: Unit, currency = 'PKR') => {
  if (v == null) return '—';
  switch (unit) {
    case 'percent': return `${fmtNum(v)}%`;
    case 'currency': return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 0 }).format(v);
    case 'hours': return `${fmtNum(v)} h`;
    case 'rating': return `${fmtNum(v)} ★`;
    default: return fmtNum(v);
  }
};

export const fmtDate = (d?: string | Date | null, opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short' }) =>
  d ? new Date(d).toLocaleDateString(undefined, opts) : '—';

export const timeAgo = (d: string) => {
  const s = (Date.now() - new Date(d).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 604800) return `${Math.floor(s / 86400)}d ago`;
  return fmtDate(d);
};

export const initials = (name: string) =>
  name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join('');

export const BAND: Record<Band, { label: string; tone: string; hex: string }> = {
  outstanding: { label: 'Outstanding', tone: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300', hex: '#059669' },
  exceeds: { label: 'Exceeds', tone: 'bg-teal-100 text-teal-800 dark:bg-teal-500/15 dark:text-teal-300', hex: '#0d9488' },
  meets: { label: 'Meets', tone: 'bg-sky-100 text-sky-800 dark:bg-sky-500/15 dark:text-sky-300', hex: '#0284c7' },
  below: { label: 'Below', tone: 'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300', hex: '#d97706' },
  poor: { label: 'Needs focus', tone: 'bg-rose-100 text-rose-800 dark:bg-rose-500/15 dark:text-rose-300', hex: '#e11d48' },
  'n/a': { label: 'No data', tone: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400', hex: '#94a3b8' },
};

/** Colour for an achievement percentage. */
export const scoreColor = (v: number | null | undefined) =>
  v == null ? '#94a3b8' : v >= 100 ? '#059669' : v >= 85 ? '#0284c7' : v >= 60 ? '#d97706' : '#e11d48';

/** yyyy-mm-dd in the user's local time zone (toISOString would shift to UTC). */
export const toDateInput = (d: Date = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

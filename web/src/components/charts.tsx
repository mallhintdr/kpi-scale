/**
 * Chart primitives for the revenue dashboards.
 * Specs: marks ≤24px with 4px rounded data-ends, 2px lines, ≥8px markers with a surface ring,
 * hairline recessive grid, text in ink tokens (never the data colour), hover tooltip on every chart.
 * Palette: --viz-s1 (green) / --viz-s2 (blue), validated for CVD in light and dark.
 */
import clsx from 'clsx';
import { AlertTriangle, Award, CheckCircle2, CircleDashed, TrendingDown, XCircle } from 'lucide-react';
import { useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import {
  Area, Bar, BarChart, CartesianGrid, Cell, ComposedChart, LabelList, Line, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { MILLIONS, REV_BAND, bandOf, fmtPKR, monthLabel, revColor, type RevBand } from '../lib/rev';

/* ------------------------------------------------------------------ */
/*  Band badge: colour + icon + label (never colour alone)              */
/* ------------------------------------------------------------------ */
const BAND_ICON: Record<RevBand, typeof Award> = {
  outstanding: Award, good: CheckCircle2, satisfactory: AlertTriangle, below: TrendingDown, poor: XCircle, 'n/a': CircleDashed,
};
export function BandChip({ band, size = 'sm' }: { band: RevBand; size?: 'sm' | 'md' }) {
  const Icon = BAND_ICON[band];
  return (
    <span className={clsx('inline-flex items-center gap-1 whitespace-nowrap rounded-full font-semibold ring-1 ring-inset', REV_BAND[band].tone, size === 'md' ? 'px-2.5 py-1 text-xs' : 'px-2 py-0.5 text-[11px]')}>
      <Icon className={size === 'md' ? 'size-3.5' : 'size-3'} />
      {REV_BAND[band].label}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/*  Score gauge: 240° arc, hero number                                  */
/* ------------------------------------------------------------------ */
export function ScoreGauge({ value, size = 168, label = 'Overall score' }: { value: number | null; size?: number; label?: string }) {
  const id = useId();
  const stroke = size * 0.085;
  const r = (size - stroke) / 2;
  const cx = size / 2;
  const cy = size / 2;
  const sweep = 240;
  const start = 150; // degrees, clockwise from +x
  const pt = (deg: number) => [cx + r * Math.cos((deg * Math.PI) / 180), cy + r * Math.sin((deg * Math.PI) / 180)];
  const arc = (from: number, to: number) => {
    const [x1, y1] = pt(from);
    const [x2, y2] = pt(to);
    return `M ${x1} ${y1} A ${r} ${r} 0 ${to - from > 180 ? 1 : 0} 1 ${x2} ${y2}`;
  };
  const pct = Math.max(0, Math.min(100, value ?? 0)) / 100;
  const end = start + sweep * pct;
  const color = revColor(value);
  // Band thresholds as subtle ticks on the track
  const ticks = [40, 60, 75, 90].map((t) => start + (sweep * t) / 100);
  return (
    <div className="relative shrink-0" style={{ width: size, height: size * 0.86 }}>
      <svg width={size} height={size} className="overflow-visible" aria-hidden>
        <defs>
          <linearGradient id={`g${id}`} x1="0" x2="1" y1="0" y2="0">
            <stop offset="0%" stopColor={color} stopOpacity={0.55} />
            <stop offset="100%" stopColor={color} />
          </linearGradient>
        </defs>
        <path d={arc(start, start + sweep)} fill="none" stroke="var(--viz-track)" strokeWidth={stroke} strokeLinecap="round" />
        {ticks.map((t) => {
          const [x1, y1] = [cx + (r - stroke / 2) * Math.cos((t * Math.PI) / 180), cy + (r - stroke / 2) * Math.sin((t * Math.PI) / 180)];
          const [x2, y2] = [cx + (r + stroke / 2) * Math.cos((t * Math.PI) / 180), cy + (r + stroke / 2) * Math.sin((t * Math.PI) / 180)];
          return <line key={t} x1={x1} y1={y1} x2={x2} y2={y2} stroke="var(--viz-surface)" strokeWidth={2} />;
        })}
        {value != null && pct > 0 && (
          <path d={arc(start, Math.max(start + 0.5, end))} fill="none" stroke={`url(#g${id})`} strokeWidth={stroke} strokeLinecap="round" className="transition-all duration-700" />
        )}
        {value != null && (() => {
          const [x, y] = pt(end);
          return <circle cx={x} cy={y} r={stroke * 0.42} fill="var(--viz-surface)" stroke={color} strokeWidth={3} />;
        })()}
      </svg>
      <div className="absolute inset-x-0 top-[30%] text-center">
        <div className="font-bold leading-none tracking-tight text-slate-900 dark:text-white" style={{ fontSize: size * 0.27 }}>
          {value == null ? '—' : Math.round(value)}
        </div>
        <div className="mt-1 text-[11px] font-medium uppercase tracking-wider text-slate-500">{label}</div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Ring stat: small circular meter                                      */
/* ------------------------------------------------------------------ */
export function Ring({ value, size = 56, stroke = 6, children }: { value: number | null; size?: number; stroke?: number; children?: ReactNode }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const pct = Math.min(100, Math.max(0, value ?? 0)) / 100;
  return (
    <div className="relative grid shrink-0 place-items-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90" aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke} stroke="var(--viz-track)" />
        {value != null && (
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke} stroke={revColor(value)} strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - pct)} className="transition-[stroke-dashoffset] duration-700" />
        )}
      </svg>
      <div className="absolute text-center text-sm font-bold text-slate-800 dark:text-slate-100">{children ?? (value == null ? '—' : Math.round(value))}</div>
    </div>
  );
}

/** Compact donut for table cells: coloured arc for the %, the % itself in the middle. */
export function MiniRing({ value, size = 38 }: { value: number | null | undefined; size?: number }) {
  const stroke = Math.max(3.5, size * 0.11);
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const pct = Math.min(100, Math.max(0, value ?? 0)) / 100;
  return (
    <div className="relative grid shrink-0 place-items-center" style={{ width: size, height: size }} role="img" aria-label={value == null ? 'No data' : `${Math.round(value)}%`}>
      <svg width={size} height={size} className="-rotate-90" aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke} stroke="var(--viz-track)" />
        {value != null && pct > 0 && (
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke} stroke={revColor(value)} strokeLinecap={pct >= 1 ? 'butt' : 'round'} strokeDasharray={c} strokeDashoffset={c * (1 - pct)} />
        )}
      </svg>
      <span className="absolute font-bold text-slate-900 tabular-nums dark:text-white" style={{ fontSize: size * 0.27 }}>
        {value == null ? '—' : Math.round(value)}
        {value != null && <span style={{ fontSize: size * 0.18 }}>%</span>}
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Bullet bar: fill = achieved, track = remainder, tick = expected pace */
/* ------------------------------------------------------------------ */
export function Bullet({ value, pace, height = 10 }: { value: number | null; pace?: number | null; height?: number }) {
  const v = Math.min(100, Math.max(0, value ?? 0));
  return (
    <div className="relative w-full" style={{ height }}>
      <div className="absolute inset-0 rounded-full" style={{ background: 'var(--viz-track)' }} />
      {value != null && v > 0 && (
        <div className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-700" style={{ width: `${v}%`, background: revColor(value) }} />
      )}
      {pace != null && pace > 0 && pace < 100 && (
        <div className="absolute -inset-y-1 w-[2px] rounded-full bg-slate-800 dark:bg-white" style={{ left: `calc(${pace}% - 1px)` }} title={`Expected by now: ${Math.round(pace)}%`} />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Metric card: target / achieved / balance at equal weight            */
/* ------------------------------------------------------------------ */
export interface MetricCardProps {
  title: string;
  /** Short group label above the title, e.g. "Revenue" */
  eyebrow?: string;
  achieved: number;
  total: number;
  fmt: (v: number) => string;
  labels?: { total?: string; achieved?: string; balance?: string };
  pace?: number | null; // % of the period elapsed → "Expected by now"
  extras?: { label: string; value: string; tone?: 'warn' | 'bad' | 'muted' }[];
  unit: string;
  compact?: boolean;
  action?: ReactNode;
}

export function MetricCard({ title, eyebrow, achieved, total, fmt, labels = {}, pace, extras = [], unit, compact, action }: MetricCardProps) {
  const pct = total > 0 ? Math.min(100, (achieved / total) * 100) : null;
  const balance = Math.max(0, total - achieved);
  const expected = pace != null && total > 0 ? (total * pace) / 100 : null;
  const gap = expected != null ? achieved - expected : null;
  const allExtras = [
    ...(expected != null ? [{ label: 'Expected by now', value: fmt(expected), tone: 'muted' as const }] : []),
    ...(gap != null ? [{ label: gap >= 0 ? 'Ahead by' : 'Short by', value: fmt(Math.abs(gap)), tone: (gap >= 0 ? 'muted' : 'bad') as 'muted' | 'bad' }] : []),
    ...extras,
  ];
  const fig = compact ? 'text-sm' : 'text-base sm:text-lg';
  return (
    <div className={clsx('flex h-full flex-col rounded-xl bg-white ring-1 ring-slate-200/80 dark:bg-slate-900 dark:ring-slate-800', compact ? 'p-3' : 'p-3.5')}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          {eyebrow && <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">{eyebrow}</div>}
          <div className={clsx('truncate font-semibold text-slate-800 dark:text-slate-100', compact ? 'text-[13px]' : 'text-sm')} title={title}>{title}</div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <span className="rounded-lg px-2 py-0.5 text-lg font-bold leading-tight text-slate-900 tabular-nums dark:text-white" style={{ boxShadow: `inset 0 -3px 0 ${revColor(pct)}` }}>
            {pct == null ? '—' : `${Math.round(pct)}%`}
          </span>
          {action}
        </div>
      </div>

      <div className="mt-2.5 grid grid-cols-3 divide-x divide-slate-100 rounded-lg bg-slate-50 py-2 text-center dark:divide-slate-800 dark:bg-slate-800/50">
        {[
          { l: labels.total ?? 'Target', v: total },
          { l: labels.achieved ?? 'Recovered', v: achieved },
          { l: labels.balance ?? 'Balance', v: balance },
        ].map((c) => (
          <div key={c.l} className="min-w-0 px-1">
            <div className="truncate text-[10px] font-medium uppercase tracking-wide text-slate-500">{c.l}</div>
            <div className={clsx('truncate font-bold text-slate-900 tabular-nums dark:text-white', fig)}>{fmt(c.v)}</div>
          </div>
        ))}
      </div>

      <div className="mt-2.5"><Bullet value={pct} pace={pace} height={8} /></div>

      {allExtras.length > 0 && (
        <div className="mt-2 flex flex-wrap justify-between gap-x-3 gap-y-0.5 text-[11px]">
          {allExtras.map((e) => (
            <span key={e.label} className="tabular-nums text-slate-500">
              {e.label}{' '}
              <b className={clsx(e.tone === 'bad' ? 'text-rose-700 dark:text-rose-400' : e.tone === 'warn' ? 'text-amber-700 dark:text-amber-400' : 'text-slate-800 dark:text-slate-200')}>{e.value}</b>
            </span>
          ))}
        </div>
      )}
      <div className="mt-auto pt-2 text-center text-[10px] font-medium tracking-wide text-slate-400">{unit}</div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Shared tooltip shell                                                 */
/* ------------------------------------------------------------------ */
function TipShell({ title, rows }: { title: string; rows: { key: string; label: string; value: string; swatch?: string; line?: boolean }[] }) {
  return (
    <div className="min-w-44 rounded-xl border border-slate-200 bg-white/95 px-3 py-2.5 text-xs shadow-xl backdrop-blur dark:border-slate-700 dark:bg-slate-900/95">
      <div className="mb-1.5 font-semibold text-slate-900 dark:text-white">{title}</div>
      {rows.map((r) => (
        <div key={r.key} className="flex items-center justify-between gap-4 py-0.5">
          <span className="flex items-center gap-1.5 text-slate-500 dark:text-slate-400">
            {r.swatch && (r.line ? <span className="h-0.5 w-3 rounded-full" style={{ background: r.swatch }} /> : <span className="size-2 rounded-full" style={{ background: r.swatch }} />)}
            {r.label}
          </span>
          <span className="font-semibold tabular-nums text-slate-900 dark:text-white">{r.value}</span>
        </div>
      ))}
    </div>
  );
}

const axisTick = { fontSize: 11, fill: 'var(--viz-axis)' };

/** True on phone-width screens (re-evaluated on resize). */
function useNarrow(bp = 640) {
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && window.innerWidth < bp);
  useEffect(() => {
    const on = () => setNarrow(window.innerWidth < bp);
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, [bp]);
  return narrow;
}

/* ------------------------------------------------------------------ */
/*  Collection trend: cumulative this FY vs last FY vs expected pace     */
/* ------------------------------------------------------------------ */
export interface TrendData {
  fy: string; prevFy: string; prevTarget: number;
  current: { month: string; current: number; arrear: number }[];
  previous: { month: string; current: number; arrear: number }[];
}

export function CollectionTrend({ trend, target }: { trend: TrendData; target: number }) {
  const [mode, setMode] = useState<'cumulative' | 'monthly'>('cumulative');
  const narrow = useNarrow();
  const nowKey = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;
  const data = useMemo(() => {
    let a = 0;
    let b = 0;
    return trend.current.map((m, i) => {
      const p = trend.previous[i];
      a += m.current;
      b += p?.current ?? 0;
      const future = m.month >= nowKey;
      return {
        label: new Date(`${m.month}-15`).toLocaleDateString(undefined, { month: 'short' }),
        month: m.month,
        thisFy: future ? null : mode === 'cumulative' ? a : m.current,
        lastFy: mode === 'cumulative' ? b : p?.current ?? 0,
        pace: mode === 'cumulative' ? Math.round((target * (i + 1)) / 12) : Math.round(target / 12),
      };
    });
  }, [trend, target, mode, nowKey]);
  const last = [...data].reverse().find((d) => d.thisFy != null);

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-600 dark:text-slate-300">
          <LegendKey color="var(--viz-s1)" label={`FY ${trend.fy}`} />
          <LegendKey color="var(--viz-s2)" label={`FY ${trend.prevFy}`} />
          <LegendKey color="var(--viz-pace)" label="Even pace to target" line />
        </div>
        <div className="flex rounded-lg bg-slate-100 p-0.5 text-xs dark:bg-slate-800">
          {(['cumulative', 'monthly'] as const).map((m) => (
            <button key={m} onClick={() => setMode(m)} className={clsx('rounded-md px-2.5 py-1 font-medium capitalize transition', mode === m ? 'bg-white shadow-sm dark:bg-slate-900' : 'text-slate-500')}>{m}</button>
          ))}
        </div>
      </div>
      <ResponsiveContainer width="100%" height={240}>
        <ComposedChart data={data} margin={{ top: 8, right: narrow ? 40 : 56, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="trendFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--viz-s1)" stopOpacity={0.22} />
              <stop offset="100%" stopColor="var(--viz-s1)" stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} stroke="var(--viz-grid)" />
          <XAxis dataKey="label" tick={axisTick} tickLine={false} axisLine={{ stroke: 'var(--viz-grid)' }} interval="preserveStartEnd" minTickGap={6} />
          <YAxis tick={axisTick} tickLine={false} axisLine={false} width={56} tickFormatter={(v) => (v / 1e6).toLocaleString('en-PK', { maximumFractionDigits: 0 })} />
          <Tooltip
            cursor={{ stroke: 'var(--viz-axis)', strokeWidth: 1 }}
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const d = payload[0].payload as (typeof data)[number];
              return (
                <TipShell
                  title={monthLabel(d.month)}
                  rows={[
                    ...(d.thisFy != null ? [{ key: 'a', label: `FY ${trend.fy}`, value: fmtPKR(d.thisFy), swatch: 'var(--viz-s1)' }] : []),
                    { key: 'b', label: `FY ${trend.prevFy}`, value: fmtPKR(d.lastFy), swatch: 'var(--viz-s2)' },
                    { key: 'c', label: 'Even pace', value: fmtPKR(d.pace), swatch: 'var(--viz-pace)', line: true },
                  ]}
                />
              );
            }}
          />
          <Line type="linear" dataKey="pace" stroke="var(--viz-pace)" strokeWidth={1.5} dot={false} activeDot={false} isAnimationActive={false} />
          <Line isAnimationActive={false} type="monotone" dataKey="lastFy" stroke="var(--viz-s2)" strokeWidth={2} dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: 'var(--viz-surface)' }} />
          <Area
            isAnimationActive={false}
            type="monotone" dataKey="thisFy" stroke="var(--viz-s1)" strokeWidth={2.5} fill="url(#trendFill)" connectNulls={false}
            dot={false} activeDot={{ r: 5, strokeWidth: 2, stroke: 'var(--viz-surface)', fill: 'var(--viz-s1)' }}
          >
            {/* End label on the latest point only */}
            <LabelList
              dataKey="thisFy"
              content={(p: any) =>
                last && p.index === data.indexOf(last) && p.value != null ? (
                  <g>
                    <circle cx={p.x} cy={p.y} r={5} fill="var(--viz-s1)" stroke="var(--viz-surface)" strokeWidth={2} />
                    <text x={p.x + 9} y={p.y + 4} fontSize={12} fontWeight={700} className="fill-slate-800 dark:fill-white">{fmtPKR(p.value)}</text>
                  </g>
                ) : null
              }
            />
          </Area>
        </ComposedChart>
      </ResponsiveContainer>
      <div className="text-center text-[10px] font-medium tracking-wide text-slate-400">{MILLIONS}</div>
    </div>
  );
}

export const LegendKey = ({ color, label, line }: { color: string; label: string; line?: boolean }) => (
  <span className="inline-flex items-center gap-1.5">
    {line ? <span className="h-0.5 w-4 rounded-full" style={{ background: color }} /> : <span className="size-2.5 rounded-full" style={{ background: color }} />}
    {label}
  </span>
);

/* ------------------------------------------------------------------ */
/*  Ranking bars: one bar per child unit, coloured by band               */
/* ------------------------------------------------------------------ */
export function RankBars({ items, onPick }: { items: { id: string; name: string; score: number | null; sub?: string }[]; onPick?: (id: string) => void }) {
  const narrow = useNarrow();
  const data = items.map((i) => ({ ...i, v: i.score ?? 0 }));
  const height = Math.max(120, data.length * 34 + 24);
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} layout="vertical" margin={{ top: 4, right: 40, left: 0, bottom: 4 }} barCategoryGap={8}>
        <CartesianGrid horizontal={false} stroke="var(--viz-grid)" />
        <XAxis type="number" domain={[0, 100]} ticks={[0, 25, 50, 75, 100]} tick={axisTick} tickLine={false} axisLine={false} />
        <YAxis type="category" dataKey="name" width={narrow ? 104 : 150} tick={{ ...axisTick, fill: 'currentColor' }} tickLine={false} axisLine={false}
          tickFormatter={(n: string) => (n.length > (narrow ? 15 : 22) ? `${n.slice(0, narrow ? 14 : 21)}…` : n)} className="text-slate-700 dark:text-slate-200" />
        <Tooltip
          cursor={{ fill: 'var(--viz-grid)', opacity: 0.5 }}
          content={({ active, payload }) => {
            if (!active || !payload?.length) return null;
            const d = payload[0].payload as (typeof data)[number];
            return <TipShell title={d.name} rows={[{ key: 's', label: 'Score', value: d.score == null ? 'No data' : String(Math.round(d.score)), swatch: revColor(d.score) }, ...(d.sub ? [{ key: 'x', label: 'Collected', value: d.sub }] : [])]} />;
          }}
        />
        <Bar isAnimationActive={false} dataKey="v" barSize={18} radius={[0, 4, 4, 0]} onClick={(d: any) => onPick?.(d.id)} className={onPick ? 'cursor-pointer' : ''}>
          {data.map((d) => <Cell key={d.id} fill={revColor(d.score)} />)}
          <LabelList dataKey="score" position="right" formatter={(v: any) => (v == null ? '—' : Math.round(v))} className="fill-slate-700 text-xs font-semibold dark:fill-slate-200" />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

/* ------------------------------------------------------------------ */
/*  Case registers: disposed vs still pending, as responsive HTML rows   */
/* ------------------------------------------------------------------ */
export function CaseBars({ items }: { items: { code: string; name: string; disposed: number; pending: number; pct: number | null }[] }) {
  const max = Math.max(1, ...items.map((i) => i.disposed + Math.max(0, i.pending)));
  return (
    <div>
      <div className="mb-3 flex gap-4 text-xs text-slate-600 dark:text-slate-300">
        <LegendKey color="var(--viz-s1)" label="Disposed" />
        <LegendKey color="var(--viz-pending)" label="Still pending" />
      </div>
      <div className="space-y-3.5">
        {items.map((i) => {
          const pend = Math.max(0, i.pending);
          return (
            <div key={i.code} title={`${i.name}: ${i.disposed.toLocaleString()} disposed, ${pend.toLocaleString()} pending`}>
              <div className="mb-1 flex items-baseline justify-between gap-2 text-sm">
                <span className="truncate text-slate-700 dark:text-slate-200">{i.name}</span>
                <span className="shrink-0 text-xs text-slate-500">
                  <b className="text-sm text-slate-900 tabular-nums dark:text-white">{i.pct == null ? '—' : `${Math.round(i.pct)}%`}</b>
                  <span className="ml-1.5 tabular-nums">{i.disposed.toLocaleString()} / {(i.disposed + pend).toLocaleString()}</span>
                </span>
              </div>
              {/* Bar length is relative to the largest register so volumes compare; 2px surface gap between segments */}
              <div className="flex h-3 gap-[2px] overflow-hidden rounded-[4px]" style={{ width: `${Math.max(6, ((i.disposed + pend) / max) * 100)}%` }}>
                {i.disposed > 0 && <div className="h-full" style={{ flex: i.disposed, background: 'var(--viz-s1)' }} />}
                {pend > 0 && <div className="h-full" style={{ flex: pend, background: 'var(--viz-pending)' }} />}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export { bandOf };

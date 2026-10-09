/**
 * Period statistics from pre-computed rollups: a series of weeks / 15-day periods / months /
 * quarters / half years / years for one area, and its sub-units ranked for one period.
 * Every response is a handful of indexed reads — no aggregation over raw entries.
 */
import { Router } from 'express';
import { z } from 'zod';
import { badRequest } from '../../lib/errors.js';
import { enqueue } from '../../lib/queue.js';
import { requireRole } from '../../middleware/auth.js';
import { objectId, q, validate } from '../../middleware/validate.js';
import { Rollup, Unit } from '../../models/index.js';
import type { BP } from '../org/blueprint.js';
import { bpOf } from '../org/service.js';
import { assertCanRead } from './access.js';
import { PERIODS, dayPeriods, monthPeriods, type Period } from './rollup.js';

const router = Router();
const DAY = 86_400_000;
const r1 = (v: number | null) => (v == null ? null : Math.round(v * 10) / 10);
const pct = (d: number, o: number | null) => (o && o > 0 ? r1(Math.min(100, (d / o) * 100)) : null);
const fmtD = (d: Date, opts: Intl.DateTimeFormatOptions) => d.toLocaleDateString('en-GB', opts);

/** Every period of a kind from the start of the year up to today (empty ones included), newest first. */
function periodList(bp: BP, fy: string, period: Period) {
  const now = new Date();
  const out: { key: string; start: Date; end: Date }[] = [];
  if (period === 'y') return [{ key: fy, start: bp.fy.start(fy), end: bp.fy.end(fy) }];
  if (period === 'm' || period === 'q' || period === 'h') {
    const seen = new Set<string>();
    for (const [, p] of monthPeriods(bp, fy)) {
      const key = p[period];
      const range = p.ranges[period];
      if (range.start > now || seen.has(key)) continue;
      seen.add(key);
      out.push({ key, ...range });
    }
  } else {
    const seen = new Set<string>();
    const stop = Math.min(now.getTime(), bp.fy.end(fy).getTime() - 1);
    for (let t = bp.fy.start(fy).getTime(); t <= stop; t += DAY) {
      const d = new Date(t);
      const p = dayPeriods(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`)[period];
      if (seen.has(p.key)) continue;
      seen.add(p.key);
      out.push(p);
    }
  }
  return out.reverse();
}

function label(period: Period, key: string, start: Date, end: Date) {
  const last = new Date(end.getTime() - DAY);
  if (period === 'm') return fmtD(start, { month: 'short', year: 'numeric' });
  if (period === 'y') return `FY ${key}`;
  if (period === 'w') return `Wk ${key.slice(-2)} · ${fmtD(start, { day: 'numeric', month: 'short' })}–${fmtD(last, { day: 'numeric', month: 'short' })}`;
  const range = `${fmtD(start, { day: period === 'f' ? 'numeric' : undefined, month: 'short' })}–${fmtD(last, { day: period === 'f' ? 'numeric' : undefined, month: 'short', year: 'numeric' })}`;
  return period === 'f' ? range : `${key.slice(-2)} · ${range}`;
}

/** Share of the year a period covers (for pro-rating annual targets). */
const share = (period: Period, start: Date, end: Date, bp: BP, fy: string) =>
  period === 'y' ? 1 : (end.getTime() - start.getTime()) / (bp.fy.end(fy).getTime() - bp.fy.start(fy).getTime());

type Annual = Record<string, { t?: number; ad?: number; open?: number }>;

/** Cells for one period: achieved vs the pro-rated target per KPI, money total, tasks. */
function cells(bp: BP, period: Period, frac: number, heads: Record<string, any>, annual: Annual, tasks?: { due?: number | null; onTime?: number | null } | null, progress = 0) {
  const out: Record<string, { done: number; of: number | null; pct: number | null; pend?: number; tp?: number }> = {};
  let mDone = 0, mOf = 0;
  for (const m of bp.metrics) {
    const h = heads[m.code] ?? {};
    const a = annual[m.code] ?? {};
    if (bp.kindOf(m.code) === 'target') {
      // Seasonal (tagged) KPIs are not spread evenly: their target is compared at year level only
      const of = a.t ? (m.tag ? (period === 'y' ? a.t : null) : a.t * frac) : null;
      const done = h.cur ?? 0;
      if (!done && !of && !h.pend && !h.tp) continue;
      out[m.code] = { done, of: of == null ? null : Math.round(of), pct: pct(done, of), ...(h.pend ? { pend: h.pend } : {}), ...(h.tp ? { tp: h.tp } : {}) };
      if (m.unit === 'money' && of) { mDone += done; mOf += of; }
    } else {
      const of = (h.rec ?? 0) + (period === 'y' ? (a.open ?? 0) : 0);
      const done = h.disp ?? 0;
      if (!done && !of && !h.tp) continue;
      out[m.code] = { done, of, pct: pct(done, of), ...(h.tp ? { tp: h.tp } : {}) };
    }
  }
  const arrDemand = period === 'y' ? Object.entries(annual).reduce((s, [c, x]) => s + (bp.metric.get(c)?.arrears ? x.ad ?? 0 : 0), 0) : 0;
  const arrDone = Object.entries(heads).reduce((s, [c, x]) => s + (bp.metric.get(c)?.arrears ? x.arr ?? 0 : 0), 0);
  return {
    heads: out,
    money: { done: Math.round(mDone), of: Math.round(mOf), pct: pct(mDone, mOf) },
    arrears: { done: arrDone, of: arrDemand || null, pct: arrDemand ? pct(arrDone, arrDemand) : null },
    tasks: { due: tasks?.due ?? 0, onTime: tasks?.onTime ?? 0, pct: pct(tasks?.onTime ?? 0, tasks?.due ?? 0) },
    progress,
  };
}

const periodQ = z.object({ unitId: objectId, period: z.enum(PERIODS as [Period, ...Period[]]), fy: z.string().optional() });

/* Series for one area */
router.get('/stats', validate({ query: periodQ }), async (req, res) => {
  const bp = bpOf(req);
  const { unitId, period } = q<{ unitId: string; period: Period }>(req);
  const fy = q<{ fy?: string }>(req).fy ?? bp.fy.of(new Date());
  if (!bp.fy.valid(fy)) throw badRequest('Invalid financial year');
  const unit = await assertCanRead(req.user!, unitId);
  const [docs, year] = await Promise.all([
    Rollup.find({ unitId: unit._id, period, fy }).lean(),
    Rollup.findOne({ unitId: unit._id, period: 'y', fy }).lean(),
  ]);
  const anyBuilt = year ?? (await Rollup.exists({ fy }));
  if (!anyBuilt) await enqueue('rollup', { tenantId: req.user!.tenantId, fy }, { jobId: `rollup-${req.user!.tenantId}-${fy}-ondemand` });
  const annual = ((year?.heads ?? {}) as Annual);
  const byKey = new Map(docs.map((d) => [d.key, d]));
  const rows = periodList(bp, fy, period).map((p) => {
    const d = byKey.get(p.key);
    return { key: p.key, label: label(period, p.key, p.start, p.end), start: p.start, end: p.end, ...cells(bp, period, share(period, p.start, p.end, bp, fy), (d?.heads ?? {}) as any, annual, d?.tasks, d?.progress ?? 0) };
  });
  res.json({
    fy, period, unit: { _id: unit._id, name: unit.name, type: unit.type },
    building: !anyBuilt,
    builtAt: year?.builtAt ?? null,
    basis: period === 'w' || period === 'f' ? 'verified' : 'month',
    rows,
  });
});

/* Sub-units of an area ranked for one period */
router.get('/stats/children', validate({ query: periodQ.extend({ key: z.string().max(20) }) }), async (req, res) => {
  const bp = bpOf(req);
  const { unitId, period, key } = q<{ unitId: string; period: Period; key: string }>(req);
  const fy = q<{ fy?: string }>(req).fy ?? bp.fy.of(new Date());
  const unit = await assertCanRead(req.user!, unitId);
  const children = await Unit.find({ parentId: unit._id }).select('name type').lean();
  const ids = children.map((c) => c._id);
  const [docs, years] = await Promise.all([
    Rollup.find({ unitId: { $in: ids }, period, key }).lean(),
    Rollup.find({ unitId: { $in: ids }, period: 'y', fy }).select('unitId heads').lean(),
  ]);
  const p = periodList(bp, fy, period).find((x) => x.key === key);
  if (!p) throw badRequest('Unknown period');
  const frac = share(period, p.start, p.end, bp, fy);
  const doc = new Map(docs.map((d) => [String(d.unitId), d]));
  const year = new Map(years.map((y) => [String(y.unitId), y.heads as Annual]));
  const items = children
    .map((c) => {
      const d = doc.get(String(c._id));
      return { _id: c._id, name: c.name, type: c.type, ...cells(bp, period, frac, (d?.heads ?? {}) as any, year.get(String(c._id)) ?? {}, d?.tasks, d?.progress ?? 0) };
    })
    .sort((a, b) => (b.money.pct ?? -1) - (a.money.pct ?? -1) || a.name.localeCompare(b.name));
  res.json({ fy, period, key, label: label(period, key, p.start, p.end), unit: { _id: unit._id, name: unit.name, type: unit.type }, items });
});

/* Rebuild now (admins) */
router.post('/stats/rebuild', requireRole('admin'), validate({ body: z.object({ fy: z.string().optional() }) }), async (req, res) => {
  const bp = bpOf(req);
  const fy = req.body.fy ?? bp.fy.of(new Date());
  await enqueue('rollup', { tenantId: req.user!.tenantId, fy }, { jobId: `rollup-${req.user!.tenantId}-${fy}-manual-${Date.now()}` });
  res.status(202).json({ queued: true, fy });
});

export default router;

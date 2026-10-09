/**
 * Period statistics: week, 15 days, month, quarter, half year and year, per unit, per KPI.
 *
 * A "rollup" job rebuilds one organisation-year from raw data in a handful of aggregations, rolls
 * every figure up the hierarchy (each unit = its whole subtree) and writes only documents whose
 * numbers changed (a content signature is compared), so a typical rebuild after a few entries
 * touches a few hundred documents. It runs:
 *   - after data changes (coalesced: at most one rebuild per organisation per minute)
 *   - nightly for every organisation (current and previous year)
 *   - on demand when a year has never been built
 */
import { createHash } from 'node:crypto';
import { Types } from 'mongoose';
import { onDataChange } from '../../lib/dataVersion.js';
import { logger } from '../../lib/logger.js';
import { defineJob, enqueue, schedule } from '../../lib/queue.js';
import { redis } from '../../lib/redis.js';
import { runUnscoped } from '../../lib/tenantContext.js';
import { AssignedTarget, RevEntry, RevTarget, Rollup, Task, Tenant, Unit } from '../../models/index.js';
import type { BP } from '../org/blueprint.js';
import { getBlueprint } from '../org/service.js';

export type Period = 'w' | 'f' | 'm' | 'q' | 'h' | 'y';
export const PERIODS: Period[] = ['w', 'f', 'm', 'q', 'h', 'y'];

interface HeadAcc { cur?: number; arr?: number; rec?: number; disp?: number; pend?: number; tp?: number; t?: number; ad?: number; open?: number }
interface Doc { unitId: string; period: Period; key: string; start: Date; end: Date; heads: Record<string, HeadAcc>; tasks: { due: number; onTime: number }; progress: number }

const pad = (n: number) => String(n).padStart(2, '0');
const DAY = 86_400_000;

/* ---------- period keys ---------- */
export function monthPeriods(bp: BP, fy: string) {
  const months = bp.fy.months(fy);
  const range = (from: number, to: number) => {
    const [y1, m1] = months[from].split('-').map(Number);
    const [y2, m2] = months[to].split('-').map(Number);
    return { start: new Date(y1, m1 - 1, 1), end: new Date(y2, m2, 1) };
  };
  const out = new Map<string, { m: string; q: string; h: string; ranges: Record<'m' | 'q' | 'h', { start: Date; end: Date }> }>();
  months.forEach((m, i) => {
    const qi = Math.floor(i / 3);
    const hi = Math.floor(i / 6);
    out.set(m, {
      m,
      q: `${fy}-Q${qi + 1}`,
      h: `${fy}-H${hi + 1}`,
      ranges: { m: range(i, i), q: range(qi * 3, qi * 3 + 2), h: range(hi * 6, hi * 6 + 5) },
    });
  });
  return out;
}

/** ISO week (Monday start) and half-month for a calendar day "YYYY-MM-DD". */
export function dayPeriods(day: string) {
  const [y, m, d] = day.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const dow = (date.getUTCDay() + 6) % 7; // Monday = 0
  const monday = new Date(date.getTime() - dow * DAY);
  const thursday = new Date(monday.getTime() + 3 * DAY);
  const isoYear = thursday.getUTCFullYear();
  const week1 = new Date(Date.UTC(isoYear, 0, 4));
  const wk = 1 + Math.round((monday.getTime() - (week1.getTime() - ((week1.getUTCDay() + 6) % 7) * DAY)) / (7 * DAY));
  const local = (t: Date) => new Date(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate());
  const first = d <= 15;
  return {
    w: { key: `${isoYear}-W${pad(wk)}`, start: local(monday), end: local(new Date(monday.getTime() + 7 * DAY)) },
    f: { key: `${y}-${pad(m)}-F${first ? 1 : 2}`, start: new Date(y, m - 1, first ? 1 : 16), end: first ? new Date(y, m - 1, 16) : new Date(y, m, 1) },
  };
}

/* ---------- build ---------- */
export async function buildRollups(tenantId: string, fy: string, bp: BP) {
  const runStart = new Date();
  const tenant = await runUnscoped(() => Tenant.findById(tenantId).select('settings').lean());
  const tz = tenant?.settings?.timezone ?? 'Asia/Karachi';
  const fyStart = bp.fy.start(fy);
  const fyEnd = bp.fy.end(fy);
  const months = monthPeriods(bp, fy);

  const units = new Map((await Unit.find().select('anc').lean()).map((u) => [String(u._id), u.anc.map(String)]));
  const docs = new Map<string, Doc>();
  const doc = (unitId: string, period: Period, key: string, start: Date, end: Date) => {
    const k = `${unitId}|${period}|${key}`;
    let x = docs.get(k);
    if (!x) {
      x = { unitId, period, key, start, end, heads: {}, tasks: { due: 0, onTime: 0 }, progress: 0 };
      docs.set(k, x);
    }
    return x;
  };
  const add = (h: HeadAcc, v: Partial<HeadAcc>) => {
    for (const [k, n] of Object.entries(v)) if (n) (h as any)[k] = ((h as any)[k] ?? 0) + n;
  };
  /** Add to every ancestor's month, quarter, half and year. */
  const toMonthly = (unitId: string, month: string, fn: (d: Doc) => void) => {
    const p = months.get(month);
    const anc = units.get(unitId);
    if (!p || !anc) return;
    for (const a of anc) {
      fn(doc(a, 'm', p.m, p.ranges.m.start, p.ranges.m.end));
      fn(doc(a, 'q', p.q, p.ranges.q.start, p.ranges.q.end));
      fn(doc(a, 'h', p.h, p.ranges.h.start, p.ranges.h.end));
      fn(doc(a, 'y', fy, fyStart, fyEnd));
    }
  };
  /** Add to every ancestor's week and 15-day period. */
  const toDaily = (unitId: string, day: string, fn: (d: Doc) => void) => {
    const anc = units.get(unitId);
    if (!anc) return;
    const p = dayPeriods(day);
    for (const a of anc) {
      fn(doc(a, 'w', p.w.key, p.w.start, p.w.end));
      fn(doc(a, 'f', p.f.key, p.f.start, p.f.end));
    }
  };
  const tid = new Types.ObjectId(tenantId);

  const [byMonth, byDay, targets, tasksByMonth, tasksByDay, progress] = await Promise.all([
    // Figures by the month they belong to
    RevEntry.aggregate([
      { $match: { fy, status: { $ne: 'rejected' } } },
      { $group: { _id: { u: '$unitId', m: '$month', h: '$head', v: { $eq: ['$status', 'verified'] } }, cur: { $sum: '$current' }, arr: { $sum: '$arrear' }, rec: { $sum: '$received' }, disp: { $sum: '$disposed' } } },
    ]).allowDiskUse(true),
    // Figures by the day they were verified (week / 15-day activity)
    RevEntry.aggregate([
      { $match: { status: 'verified', verifiedAt: { $gte: fyStart, $lt: fyEnd } } },
      { $group: { _id: { u: '$unitId', d: { $dateToString: { format: '%Y-%m-%d', date: '$verifiedAt', timezone: tz } }, h: '$head' }, cur: { $sum: '$current' }, arr: { $sum: '$arrear' }, rec: { $sum: '$received' }, disp: { $sum: '$disposed' } } },
    ]).allowDiskUse(true),
    RevTarget.aggregate([{ $match: { fy } }, { $group: { _id: { u: '$unitId', h: '$head' }, t: { $sum: '$target' }, ad: { $sum: '$arrearDemand' }, open: { $sum: '$opening' } } }]),
    Task.aggregate([
      { $match: { dueDate: { $gte: fyStart, $lt: fyEnd, $lte: runStart } } },
      { $group: { _id: { u: '$unitId', m: { $dateToString: { format: '%Y-%m', date: '$dueDate', timezone: tz } } }, due: { $sum: 1 }, onTime: { $sum: { $cond: [{ $and: [{ $eq: ['$status', 'done'] }, { $lte: ['$completedAt', '$dueDate'] }] }, 1, 0] } } } },
    ]),
    Task.aggregate([
      { $match: { dueDate: { $gte: fyStart, $lt: fyEnd, $lte: runStart } } },
      { $group: { _id: { u: '$unitId', d: { $dateToString: { format: '%Y-%m-%d', date: '$dueDate', timezone: tz } } }, due: { $sum: 1 }, onTime: { $sum: { $cond: [{ $and: [{ $eq: ['$status', 'done'] }, { $lte: ['$completedAt', '$dueDate'] }] }, 1, 0] } } } },
    ]),
    AssignedTarget.aggregate([
      { $match: { status: { $in: ['active', 'stopped'] } } },
      { $unwind: '$progress' },
      { $match: { 'progress.status': 'verified', 'progress.date': { $gte: fyStart, $lt: fyEnd } } },
      { $group: { _id: { u: '$unitId', d: { $dateToString: { format: '%Y-%m-%d', date: '$progress.date', timezone: tz } }, h: '$head' }, v: { $sum: '$progress.value' } } },
    ]),
  ]);

  for (const r of byMonth) {
    const kind = bp.kindOf(r._id.h);
    if (!kind) continue;
    const v: Partial<HeadAcc> = kind === 'target' ? (r._id.v ? { cur: r.cur, arr: r.arr } : { pend: r.cur + r.arr }) : { rec: r.rec, disp: r.disp };
    toMonthly(String(r._id.u), r._id.m, (d) => add((d.heads[r._id.h] ??= {}), v));
  }
  for (const r of byDay) {
    const kind = bp.kindOf(r._id.h);
    if (!kind) continue;
    const v: Partial<HeadAcc> = kind === 'target' ? { cur: r.cur, arr: r.arr } : { rec: r.rec, disp: r.disp };
    toDaily(String(r._id.u), r._id.d, (d) => add((d.heads[r._id.h] ??= {}), v));
  }
  for (const r of targets) {
    if (!bp.kindOf(r._id.h)) continue;
    const anc = units.get(String(r._id.u));
    for (const a of anc ?? []) add((doc(a, 'y', fy, fyStart, fyEnd).heads[r._id.h] ??= {}), { t: r.t, ad: r.ad, open: r.open });
  }
  for (const r of tasksByMonth) toMonthly(String(r._id.u), r._id.m, (d) => { d.tasks.due += r.due; d.tasks.onTime += r.onTime; });
  for (const r of tasksByDay) toDaily(String(r._id.u), r._id.d, (d) => { d.tasks.due += r.due; d.tasks.onTime += r.onTime; });
  for (const r of progress) {
    toDaily(String(r._id.u), r._id.d, (d) => {
      d.progress += r.v;
      add((d.heads[r._id.h] ??= {}), { tp: r.v });
    });
  }

  // Write only what changed
  // Order-independent signature: aggregation output order (and so key order) varies between runs
  const canon = (v: any): any =>
    v instanceof Date ? v.getTime()
      : typeof v === 'number' ? Math.round(v * 100) / 100
      : v && typeof v === 'object' ? Object.keys(v).sort().filter((k) => v[k] !== 0 && v[k] != null).map((k) => [k, canon(v[k])])
      : v;
  const sig = (d: Doc) => createHash('sha1').update(JSON.stringify(canon([d.heads, d.tasks, d.progress, d.start, d.end]))).digest('base64').slice(0, 16);
  const existing = new Map(
    (await Rollup.find({ fy }).select('unitId period key heads tasks progress start end').lean()).map((e) => [
      `${e.unitId}|${e.period}|${e.key}`,
      { _id: e._id, sig: sig({ unitId: String(e.unitId), period: e.period as Period, key: e.key, start: e.start, end: e.end, heads: e.heads as any, tasks: { due: e.tasks?.due ?? 0, onTime: e.tasks?.onTime ?? 0 }, progress: e.progress ?? 0 }) },
    ]),
  );
  const ops: any[] = [];
  for (const [k, d] of docs) {
    const prev = existing.get(k);
    existing.delete(k);
    if (prev && prev.sig === sig(d)) continue;
    ops.push({
      updateOne: {
        filter: { tenantId: tid, unitId: new Types.ObjectId(d.unitId), period: d.period, key: d.key },
        update: { $set: { fy, start: d.start, end: d.end, heads: d.heads, tasks: d.tasks, progress: d.progress, builtAt: runStart }, $setOnInsert: { tenantId: tid } },
        upsert: true,
      },
    });
  }
  for (let i = 0; i < ops.length; i += 2000) await Rollup.bulkWrite(ops.slice(i, i + 2000), { ordered: false });
  const stale = [...existing.values()].map((e) => e._id);
  if (stale.length) await Rollup.deleteMany({ _id: { $in: stale } });
  const ms = Date.now() - runStart.getTime();
  logger.info({ tenantId, fy, docs: docs.size, written: ops.length, removed: stale.length, ms }, 'rollups built');
  return { docs: docs.size, written: ops.length, removed: stale.length, ms };
}

/* ---------- jobs & triggers ---------- */
defineJob('rollup', async (d) => {
  const bp = await getBlueprint(String(d.tenantId));
  if (!bp) return;
  const fy = String(d.fy ?? bp.fy.of(new Date()));
  // One build per organisation-year at a time (across workers); a busy one is retried shortly
  const r = redis();
  const lock = 'lock:rollup:' + d.tenantId + ':' + fy;
  if (r && !(await r.set(lock, '1', 'EX', 300, 'NX'))) {
    await enqueue('rollup', { tenantId: String(d.tenantId), fy }, { jobId: 'rollup-' + d.tenantId + '-' + fy + '-retry-' + Math.floor(Date.now() / 30_000), delay: 30_000 });
    return { skipped: 'busy' };
  }
  try {
    return await buildRollups(String(d.tenantId), fy, bp);
  } finally {
    if (r) await r.del(lock);
  }
});

/** Nightly: every active organisation, current and previous year. */
defineJob('rollup-all', async () => {
  const tenants = await runUnscoped(() => Tenant.find({ status: 'active', isPlatform: { $ne: true } }).select('_id').lean());
  for (const t of tenants) {
    const bp = await getBlueprint(String(t._id));
    if (!bp) continue;
    const fy = bp.fy.of(new Date());
    for (const y of [fy, bp.fy.prev(fy)]) await enqueue('rollup', { tenantId: String(t._id), fy: y }, { jobId: `rollup-${t._id}-${y}-nightly-${new Date().toISOString().slice(0, 10)}` });
  }
});
schedule('rollup-all', '0 2 * * *');

/** After data changes: one rebuild per organisation per minute, a minute after the first change. */
const last = new Map<string, number>();
onDataChange((tenantId) => {
  const slot = Math.floor(Date.now() / 60_000);
  if (last.get(tenantId) === slot) return;
  last.set(tenantId, slot);
  enqueue('rollup', { tenantId }, { jobId: `rollup-${tenantId}-${slot}`, delay: 60_000 }).catch((err) => logger.warn({ err }, 'rollup enqueue failed'));
});

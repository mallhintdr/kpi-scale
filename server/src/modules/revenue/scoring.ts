import { Types } from 'mongoose';
import { AuditPara, RevEntry, RevTarget, ScoreConfig, Task, Unit } from '../../models/index.js';
import {
  BLOCKS, CASE_HEADS, DEFAULT_BLOCK_WEIGHTS, DEFAULT_HEAD_WEIGHTS, REVENUE_HEADS, fyStartYear,
  type Block, type BlockWeights, type Level,
} from './catalog.js';

/* ------------------------------------------------------------------ *
 *  Facts: raw sums per "fact key" (a circle, a tehsil, or an RO@tehsil)
 * ------------------------------------------------------------------ */
export interface RevFact { t: number; cur: number; ad: number; arr: number; pending: number }
export interface CaseFact { open: number; rec: number; disp: number }
export interface Facts {
  rev: Record<string, RevFact>;
  cases: Record<string, CaseFact>;
  audit: { amt: number; rec: number; n: number; settled: number };
  tasks: { due: number; onTime: number; open: number; overdue: number };
}
const emptyFacts = (): Facts => ({ rev: {}, cases: {}, audit: { amt: 0, rec: 0, n: 0, settled: 0 }, tasks: { due: 0, onTime: 0, open: 0, overdue: 0 } });

interface FactRow { unitId: string; roUserId: string | null; anc: string[]; f: Facts }

export interface FactSet {
  rows: FactRow[];
  units: Map<string, { _id: Types.ObjectId; type: string; name: string; anc: Types.ObjectId[]; parentId?: Types.ObjectId }>;
}

const key = (u: unknown, ro: unknown) => `${u}|${ro ?? ''}`;

/** Load every fact under `rootId` for a fiscal year in five aggregations. */
export async function loadFacts(rootId: Types.ObjectId | string, fy: string): Promise<FactSet> {
  const root = new Types.ObjectId(String(rootId));
  const fyStart = new Date(fyStartYear(fy), 6, 1);
  const fyEnd = new Date(fyStartYear(fy) + 1, 6, 1);
  const now = new Date();

  const [units, targets, entries, paras, tasks] = await Promise.all([
    Unit.find({ anc: root }).select('type name anc parentId').lean(),
    RevTarget.find({ fy, anc: root }).select('head unitId roUserId target arrearDemand opening').lean(),
    RevEntry.aggregate([
      { $match: { fy, anc: root, status: { $ne: 'rejected' } } },
      {
        $group: {
          _id: { u: '$unitId', ro: '$roUserId', h: '$head', v: { $eq: ['$status', 'verified'] } },
          cur: { $sum: '$current' }, arr: { $sum: '$arrear' }, rec: { $sum: '$received' }, disp: { $sum: '$disposed' },
        },
      },
    ]),
    AuditPara.aggregate([
      { $match: { anc: root } },
      {
        $group: {
          _id: '$unitId', amt: { $sum: '$amount' }, rec: { $sum: '$recovered' }, n: { $sum: 1 },
          settled: { $sum: { $cond: [{ $eq: ['$status', 'settled'] }, 1, 0] } },
        },
      },
    ]),
    Task.aggregate([
      { $match: { anc: root, dueDate: { $gte: fyStart, $lt: fyEnd } } },
      {
        $group: {
          _id: '$unitId',
          due: { $sum: { $cond: [{ $or: [{ $eq: ['$status', 'done'] }, { $lt: ['$dueDate', now] }] }, 1, 0] } },
          onTime: { $sum: { $cond: [{ $and: [{ $eq: ['$status', 'done'] }, { $lte: ['$completedAt', '$dueDate'] }] }, 1, 0] } },
          open: { $sum: { $cond: [{ $eq: ['$status', 'open'] }, 1, 0] } },
          overdue: { $sum: { $cond: [{ $and: [{ $eq: ['$status', 'open'] }, { $lt: ['$dueDate', now] }] }, 1, 0] } },
        },
      },
    ]),
  ]);

  const unitMap = new Map(units.map((u) => [String(u._id), u as any]));
  const rows = new Map<string, FactRow>();
  const row = (u: unknown, ro: unknown): FactRow | null => {
    const k = key(u, ro);
    let r = rows.get(k);
    if (!r) {
      const unit = unitMap.get(String(u));
      if (!unit) return null;
      r = { unitId: String(u), roUserId: ro ? String(ro) : null, anc: unit.anc.map(String), f: emptyFacts() };
      rows.set(k, r);
    }
    return r;
  };

  for (const t of targets) {
    const r = row(t.unitId, t.roUserId);
    if (!r) continue;
    if (REVENUE_HEADS.some((h) => h.code === t.head)) {
      const rf = (r.f.rev[t.head] ??= { t: 0, cur: 0, ad: 0, arr: 0, pending: 0 });
      rf.t += t.target ?? 0;
      rf.ad += t.arrearDemand ?? 0;
    } else {
      const cf = (r.f.cases[t.head] ??= { open: 0, rec: 0, disp: 0 });
      cf.open += t.opening ?? 0;
    }
  }
  for (const e of entries) {
    const r = row(e._id.u, e._id.ro);
    if (!r) continue;
    const h = e._id.h as string;
    if (REVENUE_HEADS.some((x) => x.code === h)) {
      const rf = (r.f.rev[h] ??= { t: 0, cur: 0, ad: 0, arr: 0, pending: 0 });
      if (e._id.v) {
        rf.cur += e.cur;
        rf.arr += e.arr;
      } else rf.pending += e.cur + e.arr; // only verified money counts towards the score
    } else {
      const cf = (r.f.cases[h] ??= { open: 0, rec: 0, disp: 0 });
      cf.rec += e.rec;
      cf.disp += e.disp;
    }
  }
  for (const p of paras) {
    const r = row(p._id, null);
    if (r) r.f.audit = { amt: p.amt, rec: p.rec, n: p.n, settled: p.settled };
  }
  for (const t of tasks) {
    const r = row(t._id, null);
    if (r) r.f.tasks = { due: t.due, onTime: t.onTime, open: t.open, overdue: t.overdue };
  }
  return { rows: [...rows.values()], units: unitMap };
}

/** Sum facts for the rows matching a predicate. */
export function rollup(rows: FactRow[], pick: (r: FactRow) => boolean): Facts {
  const out = emptyFacts();
  for (const r of rows) {
    if (!pick(r)) continue;
    for (const [h, v] of Object.entries(r.f.rev)) {
      const o = (out.rev[h] ??= { t: 0, cur: 0, ad: 0, arr: 0, pending: 0 });
      o.t += v.t; o.cur += v.cur; o.ad += v.ad; o.arr += v.arr; o.pending += v.pending;
    }
    for (const [h, v] of Object.entries(r.f.cases)) {
      const o = (out.cases[h] ??= { open: 0, rec: 0, disp: 0 });
      o.open += v.open; o.rec += v.rec; o.disp += v.disp;
    }
    out.audit.amt += r.f.audit.amt; out.audit.rec += r.f.audit.rec; out.audit.n += r.f.audit.n; out.audit.settled += r.f.audit.settled;
    out.tasks.due += r.f.tasks.due; out.tasks.onTime += r.f.tasks.onTime; out.tasks.open += r.f.tasks.open; out.tasks.overdue += r.f.tasks.overdue;
  }
  return out;
}

/** Rows inside a unit's subtree. RO-register rows are included only where `includeRo` allows. */
export const inUnit = (unitId: string, includeRo: (ro: string) => boolean = () => true) => (r: FactRow) =>
  r.anc.includes(unitId) && (!r.roUserId || includeRo(r.roUserId));

/* ------------------------------------------------------------------ *
 *  Configuration
 * ------------------------------------------------------------------ */
export interface EffectiveConfig { blocks: Record<Level, BlockWeights>; heads: Record<string, number>; sourceUnitId: string | null }

export interface ConfigResolver { (anc: string[]): EffectiveConfig }

/** Loads all scoring configs once; resolves the nearest one along a unit's ancestor chain. */
export async function configResolver(): Promise<ConfigResolver> {
  const all = await ScoreConfig.find().lean();
  const byScope = new Map(all.map((c) => [c.scopeUnitId ? String(c.scopeUnitId) : 'default', c]));
  const merge = (base: EffectiveConfig, c: any, src: string | null): EffectiveConfig => {
    const blocks = structuredClone(base.blocks);
    for (const lvl of Object.keys(blocks) as Level[]) {
      const b = c?.blocks?.[lvl];
      if (b) for (const k of BLOCKS) if (typeof b[k] === 'number') blocks[lvl][k] = b[k];
    }
    const heads = { ...base.heads };
    if (c?.heads) for (const [k, v] of Object.entries(c.heads instanceof Map ? Object.fromEntries(c.heads) : c.heads)) heads[k] = v as number;
    return { blocks, heads, sourceUnitId: src };
  };
  const base = merge({ blocks: structuredClone(DEFAULT_BLOCK_WEIGHTS), heads: { ...DEFAULT_HEAD_WEIGHTS }, sourceUnitId: null }, byScope.get('default'), null);
  return (anc: string[]) => {
    // Apply from root down so the nearest (deepest) scope wins.
    let cfg = base;
    for (const a of anc) {
      const c = byScope.get(a);
      if (c) cfg = merge(cfg, c, a);
    }
    return cfg;
  };
}

/* ------------------------------------------------------------------ *
 *  Scoring
 * ------------------------------------------------------------------ */
export interface Score {
  score: number | null;
  blocks: Record<Block, number | null>;
  weights: BlockWeights;
}

const pct = (num: number, den: number) => (den > 0 ? Math.min(100, (num / den) * 100) : null);
const round1 = (v: number | null) => (v == null ? null : Math.round(v * 10) / 10);

export function scoreFacts(f: Facts, level: Level, cfg: EffectiveConfig): Score {
  const hw = cfg.heads;

  // Revenue (current-year demand, verified collections, capped at 100% per head)
  let rs = 0, rw = 0;
  for (const h of REVENUE_HEADS) {
    const v = f.rev[h.code];
    const p = v ? pct(v.cur, v.t) : null;
    if (p == null) continue;
    rs += p * (hw[h.code] ?? 0);
    rw += hw[h.code] ?? 0;
  }
  const revenue = rw ? rs / rw : null;

  // Arrears: aggregated across all heads
  // Only heads that actually carry arrears demand count; recoveries in a head without demand
  // must not inflate the percentage.
  let ad = 0, arr = 0;
  for (const v of Object.values(f.rev)) if (v.ad > 0) { ad += v.ad; arr += v.arr; }
  const arrears = pct(arr, ad);

  // Case registers: disposal rate, weighted per head
  let cs = 0, cw = 0;
  for (const h of CASE_HEADS) {
    const v = f.cases[h.code];
    if (!v) continue;
    const p = pct(v.disp, v.open + v.rec);
    if (p == null) continue;
    cs += p * (hw[h.code] ?? 1);
    cw += hw[h.code] ?? 1;
  }
  const cases = cw ? cs / cw : null;

  // Audit paras: half amount recovered, half paras settled. N/A when the unit has none.
  const a = f.audit;
  const audit = a.n > 0 ? (((a.amt > 0 ? Math.min(100, (a.rec / a.amt) * 100) : 100) + (a.settled / a.n) * 100) / 2) : null;

  const tasks = pct(f.tasks.onTime, f.tasks.due);

  const blocks: Record<Block, number | null> = { revenue, arrears, cases, audit, tasks };
  const weights = cfg.blocks[level];
  let s = 0, w = 0;
  for (const b of BLOCKS) {
    if (blocks[b] == null || !weights[b]) continue; // missing block → its weight is redistributed
    s += (blocks[b] as number) * weights[b];
    w += weights[b];
  }
  return {
    score: w ? round1(s / w) : null,
    blocks: Object.fromEntries(BLOCKS.map((b) => [b, round1(blocks[b])])) as Record<Block, number | null>,
    weights,
  };
}

export function band(score: number | null) {
  if (score == null) return 'n/a';
  if (score >= 90) return 'outstanding';
  if (score >= 75) return 'good';
  if (score >= 60) return 'satisfactory';
  if (score >= 40) return 'below';
  return 'poor';
}

/** Per-head breakdown for display. Arrears are reported both per head (crop-wise) and in aggregate. */
export function breakdown(f: Facts) {
  const revenue = REVENUE_HEADS.map((h) => {
    const v = f.rev[h.code] ?? { t: 0, cur: 0, ad: 0, arr: 0, pending: 0 };
    return {
      code: h.code, name: h.name, group: h.group, crop: h.crop ?? null, enteredBy: h.enteredBy,
      target: v.t, collected: v.cur, pct: round1(pct(v.cur, v.t)),
      arrearDemand: v.ad, arrearCollected: v.arr, arrearPct: round1(pct(v.arr, v.ad)),
      pendingVerification: v.pending,
    };
  });
  const cases = CASE_HEADS.map((h) => {
    const v = f.cases[h.code] ?? { open: 0, rec: 0, disp: 0 };
    return { code: h.code, name: h.name, level: h.level, opening: v.open, received: v.rec, disposed: v.disp, pending: v.open + v.rec - v.disp, pct: round1(pct(v.disp, v.open + v.rec)) };
  });
  const sum = (sel: (r: (typeof revenue)[number]) => number, filter: (r: (typeof revenue)[number]) => boolean = () => true) =>
    revenue.filter(filter).reduce((s, r) => s + sel(r), 0);
  // Achievement only counts against heads that HAVE a target/demand. Money recovered in a head
  // with no target is reported separately ("untargeted") and never raises the % achieved.
  const hasArr = (r: (typeof revenue)[number]) => r.arrearDemand > 0;
  const arrears = {
    total: { demand: sum((r) => r.arrearDemand), collected: sum((r) => r.arrearCollected, hasArr) },
    rabi: { demand: sum((r) => r.arrearDemand, (r) => r.crop === 'rabi'), collected: sum((r) => r.arrearCollected, (r) => r.crop === 'rabi' && hasArr(r)) },
    kharif: { demand: sum((r) => r.arrearDemand, (r) => r.crop === 'kharif'), collected: sum((r) => r.arrearCollected, (r) => r.crop === 'kharif' && hasArr(r)) },
    other: { demand: sum((r) => r.arrearDemand, (r) => !r.crop), collected: sum((r) => r.arrearCollected, (r) => !r.crop && hasArr(r)) },
    untargeted: sum((r) => r.arrearCollected, (r) => !hasArr(r)),
  };
  const hasTarget = (r: (typeof revenue)[number]) => r.target > 0;
  const totals = {
    target: sum((r) => r.target),
    collected: sum((r) => r.collected, hasTarget),
    untargeted: sum((r) => r.collected, (r) => !hasTarget(r)),
    headsWithTarget: revenue.filter(hasTarget).length,
    pending: sum((r) => r.pendingVerification, hasTarget),
  };
  return { revenue, cases, arrears, totals, audit: f.audit, tasks: f.tasks };
}

import { Types } from 'mongoose';
import { cached, dataVersion } from '../../lib/cache.js';
import { getContext } from '../../lib/tenantContext.js';
import { AuditPara, RevEntry, RevTarget, ScoreConfig, Task, Unit } from '../../models/index.js';
import type { BP } from '../org/blueprint.js';

/* ------------------------------------------------------------------ *
 *  Facts: raw sums per "fact key" (a unit, or a person@unit for per-holder KPIs)
 * ------------------------------------------------------------------ */
export interface RevFact { t: number; cur: number; ad: number; arr: number; pending: number }
export interface CaseFact { open: number; rec: number; disp: number }
export interface RegFact { amt: number; rec: number; n: number; settled: number }
export interface Facts {
  /** Target KPIs (revenue-style): target, verified achievement, arrears. */
  rev: Record<string, RevFact>;
  /** Flow KPIs (case-style): opening + received vs disposed. */
  cases: Record<string, CaseFact>;
  /** Itemised registers (audit paras …), per register key. */
  reg: Record<string, RegFact>;
  tasks: { due: number; onTime: number; open: number; overdue: number };
}
const emptyFacts = (): Facts => ({ rev: {}, cases: {}, reg: {}, tasks: { due: 0, onTime: 0, open: 0, overdue: 0 } });
const emptyReg = (): RegFact => ({ amt: 0, rec: 0, n: 0, settled: 0 });

export interface FactRow { unitId: string; roUserId: string | null; anc: string[]; f: Facts }
export interface FactUnit { _id: string; type: string; name: string; anc: string[]; parentId?: string }
export interface FactSet {
  rows: FactRow[];
  units: Map<string, FactUnit>;
}

const key = (u: unknown, ro: unknown) => `${u}|${ro ?? ''}`;

/**
 * Every fact under `rootId` for a fiscal year (five aggregations), cached per organisation data
 * version: repeated views of the same area cost one Redis read until something changes.
 */
export async function loadFacts(rootId: Types.ObjectId | string, fy: string, bp: BP): Promise<FactSet> {
  const tenantId = String(getContext()?.tenantId ?? '');
  const dv = await dataVersion(tenantId);
  return cached(`facts:${tenantId}:${rootId}:${fy}:${dv}:${bp.version}`, 900, () => computeFacts(rootId, fy, bp), {
    encode: (fs) => ({ rows: fs.rows, units: [...fs.units.values()] }),
    decode: (x) => ({ rows: x.rows, units: new Map((x.units as FactUnit[]).map((u) => [u._id, u])) }),
  });
}

async function computeFacts(rootId: Types.ObjectId | string, fy: string, bp: BP): Promise<FactSet> {
  const root = new Types.ObjectId(String(rootId));
  const fyStart = bp.fy.start(fy);
  const fyEnd = bp.fy.end(fy);
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
          _id: { u: '$unitId', r: { $ifNull: ['$register', 'audit'] } }, amt: { $sum: '$amount' }, rec: { $sum: '$recovered' }, n: { $sum: 1 },
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

  const unitMap = new Map<string, FactUnit>(
    units.map((u) => [String(u._id), { _id: String(u._id), type: u.type, name: u.name, anc: u.anc.map(String), parentId: u.parentId ? String(u.parentId) : undefined }]),
  );
  const rows = new Map<string, FactRow>();
  const row = (u: unknown, ro: unknown): FactRow | null => {
    const k = key(u, ro);
    let r = rows.get(k);
    if (!r) {
      const unit = unitMap.get(String(u));
      if (!unit) return null;
      r = { unitId: String(u), roUserId: ro ? String(ro) : null, anc: unit.anc, f: emptyFacts() };
      rows.set(k, r);
    }
    return r;
  };

  for (const t of targets) {
    const kind = bp.kindOf(t.head);
    if (!kind) continue; // KPI removed from the blueprint
    const r = row(t.unitId, t.roUserId);
    if (!r) continue;
    if (kind === 'target') {
      const rf = (r.f.rev[t.head] ??= { t: 0, cur: 0, ad: 0, arr: 0, pending: 0 });
      rf.t += t.target ?? 0;
      rf.ad += t.arrearDemand ?? 0;
    } else {
      const cf = (r.f.cases[t.head] ??= { open: 0, rec: 0, disp: 0 });
      cf.open += t.opening ?? 0;
    }
  }
  for (const e of entries) {
    const h = e._id.h as string;
    const kind = bp.kindOf(h);
    if (!kind) continue;
    const r = row(e._id.u, e._id.ro);
    if (!r) continue;
    if (kind === 'target') {
      const rf = (r.f.rev[h] ??= { t: 0, cur: 0, ad: 0, arr: 0, pending: 0 });
      if (e._id.v) {
        rf.cur += e.cur;
        rf.arr += e.arr;
      } else rf.pending += e.cur + e.arr; // only verified figures count towards the score
    } else {
      const cf = (r.f.cases[h] ??= { open: 0, rec: 0, disp: 0 });
      cf.rec += e.rec;
      cf.disp += e.disp;
    }
  }
  for (const p of paras) {
    const r = row(p._id.u, null);
    if (r) r.f.reg[p._id.r] = { amt: p.amt, rec: p.rec, n: p.n, settled: p.settled };
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
    for (const [k, v] of Object.entries(r.f.reg)) {
      const o = (out.reg[k] ??= emptyReg());
      o.amt += v.amt; o.rec += v.rec; o.n += v.n; o.settled += v.settled;
    }
    out.tasks.due += r.f.tasks.due; out.tasks.onTime += r.f.tasks.onTime; out.tasks.open += r.f.tasks.open; out.tasks.overdue += r.f.tasks.overdue;
  }
  return out;
}

/** Rows indexed once per fact set: by every ancestor unit, and per-holder rows by person (positions kept for stable sum order). */
interface RowIndex { byUnit: Map<string, number[]>; byRo: Map<string, number[]> }
const rowIndexes = new WeakMap<FactRow[], RowIndex>();
function indexOf(rows: FactRow[]): RowIndex {
  let ix = rowIndexes.get(rows);
  if (!ix) {
    ix = { byUnit: new Map(), byRo: new Map() };
    rows.forEach((r, i) => {
      for (const a of r.anc) { const l = ix!.byUnit.get(a); if (l) l.push(i); else ix!.byUnit.set(a, [i]); }
      if (r.roUserId) { const l = ix!.byRo.get(r.roUserId); if (l) l.push(i); else ix!.byRo.set(r.roUserId, [i]); }
    });
    rowIndexes.set(rows, ix);
  }
  return ix;
}
/** Same as rollup(rows, inUnit(unitId)) using the index. */
export function rollupUnit(rows: FactRow[], unitId: string): Facts {
  const ids = indexOf(rows).byUnit.get(unitId) ?? [];
  return rollup(ids.map((i) => rows[i]), () => true);
}
/** Same as rollup(rows, pick) where pick only accepts rows under `unitIds` or per-holder rows of `roUserId`; `pick` is still applied. */
export function rollupWithin(rows: FactRow[], unitIds: string[], roUserId: string | null, pick: (r: FactRow) => boolean): Facts {
  const ix = indexOf(rows);
  const set = new Set<number>();
  for (const u of unitIds) for (const i of ix.byUnit.get(u) ?? []) set.add(i);
  if (roUserId) for (const i of ix.byRo.get(roUserId) ?? []) set.add(i);
  return rollup([...set].sort((a, b) => a - b).map((i) => rows[i]), pick);
}

/** Rows inside a unit's subtree. Per-holder rows are included only where `includeRo` allows. */
export const inUnit = (unitId: string, includeRo: (ro: string) => boolean = () => true) => (r: FactRow) =>
  r.anc.includes(unitId) && (!r.roUserId || includeRo(r.roUserId));

/* ------------------------------------------------------------------ *
 *  Configuration: blueprint weights, overridden per area by ScoreConfig
 * ------------------------------------------------------------------ */
export type Weights = Record<string, number>;
export interface EffectiveConfig { profiles: Record<string, Weights>; heads: Record<string, number>; sourceUnitId: string | null }
export interface ConfigResolver { (anc: string[]): EffectiveConfig }

export async function configResolver(bp: BP): Promise<ConfigResolver> {
  const tenantId = String(getContext()?.tenantId ?? '');
  const dv = await dataVersion(tenantId);
  const all: any[] = tenantId ? await cached(`scorecfg:${tenantId}:${dv}`, 900, () => ScoreConfig.find().lean() as Promise<any[]>) : await ScoreConfig.find().lean();
  const byScope = new Map(all.map((c) => [c.scopeUnitId ? String(c.scopeUnitId) : 'default', c]));
  const blockKeys = bp.blocks.map((b) => b.key);
  const merge = (base: EffectiveConfig, c: any, src: string | null): EffectiveConfig => {
    const profiles = structuredClone(base.profiles);
    for (const p of Object.keys(profiles)) {
      const b = c?.blocks?.[p];
      if (b) for (const k of blockKeys) if (typeof b[k] === 'number') profiles[p][k] = b[k];
    }
    const heads = { ...base.heads };
    if (c?.heads) for (const [k, v] of Object.entries(c.heads instanceof Map ? Object.fromEntries(c.heads) : c.heads)) heads[k] = v as number;
    return { profiles, heads, sourceUnitId: src };
  };
  const base = merge(
    {
      profiles: Object.fromEntries(bp.raw.profiles.map((p) => [p.key, Object.fromEntries(blockKeys.map((k) => [k, p.weights[k] ?? 0]))])),
      heads: Object.fromEntries(bp.raw.metrics.map((m) => [m.code, m.weight])),
      sourceUnitId: null,
    },
    byScope.get('default'),
    null,
  );
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
  blocks: Record<string, number | null>;
  weights: Weights;
}

const pct = (num: number, den: number) => (den > 0 ? Math.min(100, (num / den) * 100) : null);
const round1 = (v: number | null) => (v == null ? null : Math.round(v * 10) / 10);

/** Register score: half the amount recovered, half the items settled. N/A when there are none. */
const regScore = (a: RegFact) => (a.n > 0 ? ((a.amt > 0 ? Math.min(100, (a.rec / a.amt) * 100) : 100) + (a.settled / a.n) * 100) / 2 : null);

export function scoreFacts(f: Facts, profile: string, cfg: EffectiveConfig, bp: BP): Score {
  const hw = cfg.heads;
  const blocks: Record<string, number | null> = {};
  for (const b of bp.blocks) {
    if (b.kind === 'target') {
      // Achievement per KPI (capped at 100%), weighted; KPIs without a target do not count.
      let s = 0, w = 0;
      for (const m of bp.targetMetrics) {
        if (m.block !== b.key) continue;
        const v = f.rev[m.code];
        const p = v ? pct(v.cur, v.t) : null;
        if (p == null) continue;
        s += p * (hw[m.code] ?? 0);
        w += hw[m.code] ?? 0;
      }
      blocks[b.key] = w ? s / w : null;
    } else if (b.kind === 'arrears') {
      // Aggregated across KPIs that carry arrears demand; recoveries without demand never inflate it.
      let ad = 0, arr = 0;
      for (const m of bp.targetMetrics) {
        const v = f.rev[m.code];
        if (m.arrears && v && v.ad > 0) { ad += v.ad; arr += v.arr; }
      }
      blocks[b.key] = pct(arr, ad);
    } else if (b.kind === 'flow') {
      let s = 0, w = 0;
      for (const m of bp.flowMetrics) {
        if (m.block !== b.key) continue;
        const v = f.cases[m.code];
        if (!v) continue;
        const p = pct(v.disp, v.open + v.rec);
        if (p == null) continue;
        s += p * (hw[m.code] ?? 1);
        w += hw[m.code] ?? 1;
      }
      blocks[b.key] = w ? s / w : null;
    } else if (b.kind === 'register') {
      const a = emptyReg();
      for (const r of bp.registers) {
        if (r.block !== b.key) continue;
        const v = f.reg[r.key];
        if (v) { a.amt += v.amt; a.rec += v.rec; a.n += v.n; a.settled += v.settled; }
      }
      blocks[b.key] = regScore(a);
    } else {
      blocks[b.key] = pct(f.tasks.onTime, f.tasks.due);
    }
  }
  const weights = cfg.profiles[profile] ?? Object.values(cfg.profiles)[0] ?? {};
  let s = 0, w = 0;
  for (const b of bp.blocks) {
    const v = blocks[b.key];
    if (v == null || !weights[b.key]) continue; // missing block → its weight is redistributed
    s += v * weights[b.key];
    w += weights[b.key];
  }
  return {
    score: w ? round1(s / w) : null,
    blocks: Object.fromEntries(bp.blocks.map((b) => [b.key, round1(blocks[b.key])])),
    weights,
  };
}

/** Per-KPI breakdown for display. Arrears are reported in aggregate and per tag (e.g. crop-wise). */
export function breakdown(f: Facts, bp: BP) {
  const revenue = bp.targetMetrics.map((m) => {
    const v = f.rev[m.code] ?? { t: 0, cur: 0, ad: 0, arr: 0, pending: 0 };
    return {
      code: m.code, name: m.name, group: m.group, block: m.block, unit: m.unit, tag: m.tag ?? null, crop: m.tag ?? null, arrears: m.arrears,
      target: v.t, collected: v.cur, pct: round1(pct(v.cur, v.t)),
      arrearDemand: v.ad, arrearCollected: v.arr, arrearPct: round1(pct(v.arr, v.ad)),
      pendingVerification: v.pending,
    };
  });
  const cases = bp.flowMetrics.map((m) => {
    const v = f.cases[m.code] ?? { open: 0, rec: 0, disp: 0 };
    return {
      code: m.code, name: m.name, block: m.block, unit: m.unit, perHolder: m.perHolder, level: m.level,
      opening: v.open, received: v.rec, disposed: v.disp, pending: v.open + v.rec - v.disp, pct: round1(pct(v.disp, v.open + v.rec)),
    };
  });
  type Row = (typeof revenue)[number];
  const sum = (sel: (r: Row) => number, filter: (r: Row) => boolean = () => true) => revenue.filter(filter).reduce((s, r) => s + sel(r), 0);
  // Achievement only counts against KPIs that HAVE a target/demand. Amounts achieved without a target are
  // reported separately ("untargeted") and never raise the % achieved.
  const arrRows = (r: Row) => r.arrears;
  const hasArr = (r: Row) => r.arrearDemand > 0;
  const arrearsFor = (pick: (r: Row) => boolean) => ({
    demand: sum((r) => r.arrearDemand, (r) => arrRows(r) && pick(r)),
    collected: sum((r) => r.arrearCollected, (r) => arrRows(r) && pick(r) && hasArr(r)),
  });
  const arrears: Record<string, any> = {
    total: arrearsFor(() => true),
    other: arrearsFor((r) => !r.tag),
    untargeted: sum((r) => r.arrearCollected, (r) => arrRows(r) && !hasArr(r)),
  };
  for (const t of bp.raw.tags) arrears[t.key] = arrearsFor((r) => r.tag === t.key);

  // Totals add up money KPIs only (counts and money never mix).
  const money = (r: Row) => r.unit === 'money';
  const hasTarget = (r: Row) => r.target > 0;
  const totals = {
    target: sum((r) => r.target, money),
    collected: sum((r) => r.collected, (r) => money(r) && hasTarget(r)),
    untargeted: sum((r) => r.collected, (r) => money(r) && !hasTarget(r)),
    headsWithTarget: revenue.filter((r) => money(r) && hasTarget(r)).length,
    pending: sum((r) => r.pendingVerification, (r) => money(r) && hasTarget(r)),
  };
  const registers = bp.registers.map((r) => ({ key: r.key, label: r.label, block: r.block, ...(f.reg[r.key] ?? emptyReg()) }));
  const audit = registers.reduce((a, r) => ({ amt: a.amt + r.amt, rec: a.rec + r.rec, n: a.n + r.n, settled: a.settled + r.settled }), emptyReg());
  return { revenue, cases, arrears, totals, registers, audit, tasks: f.tasks };
}

/** Compact per-KPI figures used by lists, leagues, reports and comparisons. */
export function headCells(b: ReturnType<typeof breakdown>, bp: BP) {
  const r1 = (v: number) => Math.round(v * 10) / 10;
  const heads: Record<string, { pct: number | null; done: number; of: number }> = {};
  for (const r of b.revenue) if (r.target > 0) heads[r.code] = { pct: r.pct, done: r.collected, of: r.target };
  for (const c of b.cases) if (c.opening + c.received > 0) heads[c.code] = { pct: c.pct, done: c.disposed, of: c.opening + c.received };
  const ad = b.arrears.total;
  if (ad.demand > 0) heads.ARREARS = { pct: r1(Math.min(100, (ad.collected / ad.demand) * 100)), done: ad.collected, of: ad.demand };
  // 'AUDIT' = all registers combined; with several registers each also gets its own REG_<key> cell
  if (bp.registers.length > 1) {
    for (const reg of b.registers) {
      if (reg.n > 0) heads[`REG_${reg.key}`] = { pct: reg.amt ? r1(Math.min(100, (reg.rec / reg.amt) * 100)) : null, done: reg.settled, of: reg.n };
    }
  }
  if (b.audit.n > 0) heads.AUDIT = { pct: b.audit.amt ? r1(Math.min(100, (b.audit.rec / b.audit.amt) * 100)) : null, done: b.audit.settled, of: b.audit.n };
  if (b.tasks.due > 0) heads.TASKS = { pct: r1((b.tasks.onTime / b.tasks.due) * 100), done: b.tasks.onTime, of: b.tasks.due };
  return heads;
}

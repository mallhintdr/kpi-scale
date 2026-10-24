import type { NextFunction, Request, Response } from 'express';
import { bumpData, cached, invalidate } from '../../lib/cache.js';
import { AppError, badRequest } from '../../lib/errors.js';
import { getContext } from '../../lib/tenantContext.js';
import { AssignedTarget, AuditPara, Blueprint, BlueprintHistory, Charge, RevEntry, RevTarget, TargetDrive, Unit } from '../../models/index.js';
import { blueprintSchema, compile, type BP, type Blueprint as BlueprintDoc } from './blueprint.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      bp?: BP;
    }
  }
}

/** The organisation's compiled blueprint (cached; invalidated across instances on save). */
export async function getBlueprint(tenantId: string): Promise<BP | null> {
  return cached<BP | null>(
    `bp:${tenantId}`,
    600,
    async () => {
      const row = await Blueprint.findOne({ tenantId }).lean();
      return row ? compile(blueprintSchema.parse(row.doc), row.version) : null;
    },
    {
      encode: (bp) => (bp ? { raw: bp.raw, version: bp.version } : null),
      decode: (x) => (x ? compile(x.raw, x.version) : null),
    },
  );
}

/** Attaches req.bp; organisation routes need a configured blueprint. */
export async function withBlueprint(req: Request, _res: Response, next: NextFunction) {
  const bp = req.user ? await getBlueprint(req.user.tenantId) : null;
  if (!bp) throw new AppError(409, 'This organisation has not been set up yet. Ask its administrator to configure the hierarchy and KPIs.', 'NOT_CONFIGURED');
  req.bp = bp;
  next();
}

/** Blueprint for the current request (routes mounted behind withBlueprint). */
export const bpOf = (req: Request) => req.bp!;

/** Keys that existing data still refers to: they cannot be removed from the blueprint, only retired. */
async function keysInUse() {
  const [levels, posts, heads, entryHeads, registers, assignedHeads, driveHeads] = await Promise.all([
    Unit.distinct('type'),
    Charge.distinct('post', { $or: [{ to: null }, { to: { $gt: new Date() } }] }),
    RevTarget.distinct('head'),
    RevEntry.distinct('head'),
    AuditPara.distinct('register'),
    AssignedTarget.distinct('head'),
    TargetDrive.distinct('head'),
  ]);
  return { levels: levels as string[], posts: posts as string[], metrics: [...new Set([...heads, ...entryHeads, ...assignedHeads, ...driveHeads] as string[])], registers: registers as string[] };
}

export interface SaveResult {
  version: number;
  warnings: string[];
}

/** Validate and save a new version of the organisation's blueprint. */
export async function saveBlueprint(tenantId: string, input: unknown, opts: { userId?: string; note?: string; template?: string; skipUsageCheck?: boolean } = {}): Promise<SaveResult> {
  const parsed = blueprintSchema.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 25).map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new AppError(400, `The configuration has ${parsed.error.issues.length} problem(s)`, 'INVALID_BLUEPRINT', issues);
  }
  const doc: BlueprintDoc = parsed.data;
  const warnings: string[] = [];

  const current = await Blueprint.findOne({ tenantId });
  if (!opts.skipUsageCheck) {
    const used = await keysInUse();
    const old = current?.doc as BlueprintDoc | undefined;
    const missing = (list: string[], have: Set<string>, what: string) => list.filter((k) => !have.has(k)).map((k) => `${what} "${k}" is still in use and cannot be removed`);
    const problems = [
      ...missing(used.levels, new Set(doc.levels.map((l) => l.key)), 'Level'),
      ...missing(used.posts, new Set(doc.posts.map((p) => p.key)), 'Post'),
      ...missing(used.metrics, new Set(doc.metrics.map((m) => m.code)), 'KPI').map((s) => `${s} (mark it inactive instead)`),
      ...missing(used.registers, new Set(doc.registers.map((r) => r.key)), 'Register'),
    ];
    if (old) {
      // Units are typed by their position in the hierarchy, and figures were recorded at a KPI's level
      // and scored by its block kind: these cannot change under existing data
      const oldIdx = new Map(old.levels.map((l, i) => [l.key, i]));
      const newIdx = new Map(doc.levels.map((l, i) => [l.key, i]));
      for (const k of used.levels) if (oldIdx.has(k) && newIdx.has(k) && oldIdx.get(k) !== newIdx.get(k)) problems.push(`Level "${k}" is in use and cannot be moved to another position in the hierarchy`);
      const kindOf = (d: BlueprintDoc, block: string) => d.blocks.find((b) => b.key === block)?.kind;
      const oldMetric = new Map(old.metrics.map((m) => [m.code, m]));
      for (const m of doc.metrics) {
        const o = oldMetric.get(m.code);
        if (!o || !used.metrics.includes(m.code)) continue;
        if (o.level !== m.level) problems.push(`KPI "${m.code}" has recorded data at level "${o.level}"; its level cannot change (add a new KPI instead)`);
        const ok = kindOf(old, o.block);
        const nk = kindOf(doc, m.block);
        if (ok && nk && ok !== nk) problems.push(`KPI "${m.code}" has recorded data scored as "${ok}"; it cannot move to a "${nk}" block (add a new KPI instead)`);
      }
    }
    if (problems.length) throw new AppError(409, 'Some items are still used by existing data', 'IN_USE', problems);
    const totals = doc.profiles.filter((p) => Object.values(p.weights).reduce((s, w) => s + w, 0) !== 100);
    for (const p of totals) warnings.push(`Weights of profile "${p.label}" add up to ${Object.values(p.weights).reduce((s, w) => s + w, 0)}, not 100 — they are applied proportionally`);
  }

  const version = (current?.version ?? 0) + 1;
  const conflict = () => new AppError(409, 'The configuration was changed by someone else meanwhile; reload it and try again', 'VERSION_CONFLICT');
  if (current) {
    // Conditional on the version read above, so two concurrent saves cannot both become version N
    const set: Record<string, unknown> = { version, doc };
    if (opts.userId) set.updatedBy = opts.userId;
    const ok = await Blueprint.updateOne({ tenantId, version: current.version }, { $set: set });
    if (!ok.modifiedCount) throw conflict();
  } else {
    try {
      await Blueprint.create({ tenantId, version, doc, template: opts.template, updatedBy: opts.userId });
    } catch (err) {
      if ((err as { code?: number }).code === 11000) throw conflict();
      throw err;
    }
  }
  await BlueprintHistory.create({ tenantId, version, doc, note: opts.note, updatedBy: opts.userId });
  await invalidate('bp', tenantId);
  await bumpData(tenantId); // weights / KPI changes alter every score
  return { version, warnings };
}

/** Throws unless a tenant context exists (helper for jobs/scripts). */
export const currentTenant = () => {
  const t = getContext()?.tenantId;
  if (!t) throw badRequest('No organisation in context');
  return String(t);
};

import type { NextFunction, Request, Response } from 'express';
import { bumpData, cached, invalidate } from '../../lib/cache.js';
import { AppError, badRequest } from '../../lib/errors.js';
import { getContext } from '../../lib/tenantContext.js';
import { AuditPara, Blueprint, BlueprintHistory, Charge, RevEntry, RevTarget, Unit } from '../../models/index.js';
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
  const [levels, posts, heads, entryHeads, registers] = await Promise.all([
    Unit.distinct('type'),
    Charge.distinct('post', { $or: [{ to: null }, { to: { $gt: new Date() } }] }),
    RevTarget.distinct('head'),
    RevEntry.distinct('head'),
    AuditPara.distinct('register'),
  ]);
  return { levels: levels as string[], posts: posts as string[], metrics: [...new Set([...heads, ...entryHeads] as string[])], registers: registers as string[] };
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

  if (!opts.skipUsageCheck) {
    const used = await keysInUse();
    const missing = (list: string[], have: Set<string>, what: string) => list.filter((k) => !have.has(k)).map((k) => `${what} "${k}" is still in use and cannot be removed`);
    const problems = [
      ...missing(used.levels, new Set(doc.levels.map((l) => l.key)), 'Level'),
      ...missing(used.posts, new Set(doc.posts.map((p) => p.key)), 'Post'),
      ...missing(used.metrics, new Set(doc.metrics.map((m) => m.code)), 'KPI').map((s) => `${s} (mark it inactive instead)`),
      ...missing(used.registers, new Set(doc.registers.map((r) => r.key)), 'Register'),
    ];
    if (problems.length) throw new AppError(409, 'Some items are still used by existing data', 'IN_USE', problems);
    const totals = doc.profiles.filter((p) => Object.values(p.weights).reduce((s, w) => s + w, 0) !== 100);
    for (const p of totals) warnings.push(`Weights of profile "${p.label}" add up to ${Object.values(p.weights).reduce((s, w) => s + w, 0)}, not 100 — they are applied proportionally`);
  }

  const current = await Blueprint.findOne({ tenantId });
  const version = (current?.version ?? 0) + 1;
  if (current) {
    current.version = version;
    current.doc = doc;
    if (opts.userId) current.updatedBy = opts.userId as any;
    current.markModified('doc');
    await current.save();
  } else {
    await Blueprint.create({ tenantId, version, doc, template: opts.template, updatedBy: opts.userId });
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

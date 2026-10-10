/**
 * Organisation administration (owner / admin of one organisation):
 *   blueprint (hierarchy, posts, KPIs, scoring) — edit any time, every version kept
 *   settings and branding
 *   the unit hierarchy
 *   bulk CSV imports
 */
import express, { Router } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import { badRequest, notFound } from '../../lib/errors.js';
import { audit } from '../../lib/notify.js';
import { enqueue } from '../../lib/queue.js';
import { requireRole } from '../../middleware/auth.js';
import { idParam, objectId, q, validate } from '../../middleware/validate.js';
import {
  AssignedTarget, AuditPara, Blueprint, BlueprintHistory, Charge, ImportRun, RevEntry, RevTarget, TargetDrive, Task, Tenant, Unit, User,
} from '../../models/index.js';
import { publicBlueprint } from './blueprint.js';
import { parseCsv } from './imports.js';
import { getBlueprint, saveBlueprint } from './service.js';
import { TEMPLATES } from './templates.js';

const router = Router();
router.use(requireRole('admin'));

/* ---------------- Blueprint ---------------- */
router.get('/blueprint', async (req, res) => {
  const row = await Blueprint.findOne().lean();
  const bp = await getBlueprint(req.user!.tenantId);
  res.json({ version: row?.version ?? 0, template: row?.template, updatedAt: row?.updatedAt, doc: row?.doc ?? null, compiled: bp ? publicBlueprint(bp) : null });
});

router.put('/blueprint', validate({ body: z.object({ doc: z.unknown(), note: z.string().max(300).optional() }) }), async (req, res) => {
  const result = await saveBlueprint(req.user!.tenantId, req.body.doc, { userId: req.user!.id, note: req.body.note });
  await audit('blueprint.save', 'Blueprint', undefined, { version: result.version, note: req.body.note });
  res.json(result);
});

/** Validate without saving (live feedback in the editor). */
router.post('/blueprint/validate', validate({ body: z.object({ doc: z.unknown() }) }), async (req, res) => {
  const { blueprintSchema } = await import('./blueprint.js');
  const r = blueprintSchema.safeParse(req.body.doc);
  res.json(r.success ? { ok: true, issues: [] } : { ok: false, issues: r.error.issues.slice(0, 50).map((i) => ({ path: i.path.join('.'), message: i.message })) });
});

router.get('/blueprint/history', async (_req, res) => {
  res.json(await BlueprintHistory.find().select('version note updatedBy createdAt').populate('updatedBy', 'name').sort({ version: -1 }).limit(100).lean());
});

router.post('/blueprint/rollback/:version', validate({ params: z.object({ version: z.coerce.number().int().min(1) }) }), async (req, res) => {
  const v = Number(req.params.version);
  const old = await BlueprintHistory.findOne({ version: v }).lean();
  if (!old) throw notFound('Version');
  res.json(await saveBlueprint(req.user!.tenantId, old.doc, { userId: req.user!.id, note: `Rolled back to version ${v}` }));
});

router.get('/templates', (_req, res) => {
  res.json(Object.entries(TEMPLATES).map(([key, t]) => ({ key, label: t.label, category: t.category, description: t.description, blueprint: t.blueprint })));
});

/* ---------------- Settings & branding ---------------- */
router.get('/settings', async (req, res) => {
  const [t, users, units] = await Promise.all([Tenant.findById(req.user!.tenantId).lean(), User.countDocuments({ status: 'active' }), Unit.countDocuments()]);
  res.json({ ...t, usage: { users, units } });
});

router.patch(
  '/settings',
  validate({
    body: z.object({
      name: z.string().trim().min(2).max(120).optional(),
      branding: z.object({ shortName: z.string().max(40).optional(), tagline: z.string().max(120).optional(), logoUrl: z.string().url().max(500).optional().or(z.literal('')) }).optional(),
      settings: z.object({ timezone: z.string().max(60).optional() }).optional(),
    }),
  }),
  async (req, res) => {
    const set: Record<string, unknown> = {};
    if (req.body.name) set.name = req.body.name;
    for (const [k, v] of Object.entries(req.body.branding ?? {})) set[`branding.${k}`] = v;
    for (const [k, v] of Object.entries(req.body.settings ?? {})) set[`settings.${k}`] = v;
    const t = await Tenant.findByIdAndUpdate(req.user!.tenantId, { $set: set }, { new: true }).lean();
    await audit('org.settings', 'Tenant', req.user!.tenantId);
    res.json(t);
  },
);

/* ---------------- Units (hierarchy) ---------------- */
router.get('/units', validate({ query: z.object({ parentId: objectId.optional(), search: z.string().max(60).optional() }) }), async (req, res) => {
  const bp = (await getBlueprint(req.user!.tenantId))!;
  const { parentId, search } = q<{ parentId?: string; search?: string }>(req);
  const filter: Record<string, unknown> = search
    ? { name: new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }
    : parentId ? { parentId: new Types.ObjectId(parentId) } : { type: bp.topLevel };
  const items = await Unit.find(filter).select('type name code parentId active anc').sort({ name: 1 }).limit(500).lean();
  const ids = items.map((u) => u._id);
  const [kids, holders] = await Promise.all([
    Unit.aggregate([{ $match: { parentId: { $in: ids } } }, { $group: { _id: '$parentId', n: { $sum: 1 } } }]),
    Charge.aggregate([{ $match: { unitId: { $in: ids }, to: null } }, { $group: { _id: '$unitId', n: { $sum: 1 } } }]),
  ]);
  const k = new Map(kids.map((x) => [String(x._id), x.n]));
  const h = new Map(holders.map((x) => [String(x._id), x.n]));
  res.json(items.map((u) => ({ ...u, children: k.get(String(u._id)) ?? 0, postings: h.get(String(u._id)) ?? 0, levelLabel: bp.level.get(u.type)?.label ?? u.type })));
});

router.post('/units', validate({ body: z.object({ name: z.string().trim().min(1).max(120), code: z.string().trim().max(40).optional(), parentId: objectId.nullish() }) }), async (req, res) => {
  const bp = (await getBlueprint(req.user!.tenantId))!;
  const t = await Tenant.findById(req.user!.tenantId).select('limits').lean();
  if ((await Unit.countDocuments()) >= (t?.limits?.maxUnits ?? 50000)) throw badRequest('Unit limit reached for this organisation');
  let type = bp.topLevel;
  let anc: Types.ObjectId[] = [];
  if (req.body.parentId) {
    const parent = await Unit.findById(req.body.parentId).lean();
    if (!parent) throw notFound('Parent unit');
    const pi = bp.levelIndex.get(parent.type);
    if (pi == null || pi >= bp.levels.length - 1) throw badRequest(`${bp.level.get(parent.type)?.label ?? parent.type} is the lowest level; nothing can sit under it`);
    type = bp.levels[pi + 1].key;
    anc = parent.anc as Types.ObjectId[];
  }
  if (req.body.code && (await Unit.exists({ code: req.body.code }))) throw badRequest(`Code "${req.body.code}" is already used`);
  const _id = new Types.ObjectId();
  const unit = await Unit.create({ _id, type, name: req.body.name, code: req.body.code, parentId: req.body.parentId ?? null, anc: [...anc, _id] });
  await audit('unit.create', 'Unit', unit._id, { type });
  res.status(201).json(unit);
});

router.patch('/units/:id', validate({ params: idParam, body: z.object({ name: z.string().trim().min(1).max(120).optional(), code: z.string().trim().max(40).optional(), active: z.boolean().optional() }) }), async (req, res) => {
  if (req.body.code && (await Unit.exists({ code: req.body.code, _id: { $ne: req.params.id } }))) throw badRequest(`Code "${req.body.code}" is already used`);
  const u = await Unit.findByIdAndUpdate(req.params.id, { $set: req.body }, { new: true }).lean();
  if (!u) throw notFound('Unit');
  res.json(u);
});

/** Move a unit (and its whole subtree) under another parent of the level above it. */
router.post('/units/:id/move', validate({ params: idParam, body: z.object({ parentId: objectId }) }), async (req, res) => {
  const bp = (await getBlueprint(req.user!.tenantId))!;
  const [unit, parent] = await Promise.all([Unit.findById(req.params.id).lean(), Unit.findById(req.body.parentId).lean()]);
  if (!unit || !parent) throw notFound('Unit');
  if ((bp.levelIndex.get(parent.type) ?? -1) !== (bp.levelIndex.get(unit.type) ?? -9) - 1) throw badRequest(`A ${bp.level.get(unit.type)?.label} must sit under a ${bp.levels[(bp.levelIndex.get(unit.type) ?? 1) - 1]?.label}`);
  if (parent.anc.some((a) => String(a) === String(unit._id))) throw badRequest('Cannot move a unit under itself');
  const oldLen = unit.anc.length - 1; // ancestors above the unit
  const prefix = parent.anc;
  // Rewrite the ancestor chain of the subtree and of every record that rolls up through it
  const rewrite = [{ $set: { anc: { $concatArrays: [prefix, { $slice: ['$anc', oldLen, { $size: '$anc' }] }] } } }];
  const match = { anc: unit._id };
  await Unit.updateOne({ _id: unit._id }, { parentId: parent._id });
  await Promise.all([Unit, RevTarget, RevEntry, AuditPara, Task, AssignedTarget, TargetDrive].map((M: any) => M.updateMany(match, rewrite)));
  await audit('unit.move', 'Unit', unit._id, { from: unit.parentId, to: parent._id });
  res.json({ moved: true });
});

router.delete('/units/:id', validate({ params: idParam }), async (req, res) => {
  const id = new Types.ObjectId(req.params.id as string);
  const [kids, charges, targets, entries, items] = await Promise.all([
    Unit.exists({ parentId: id }), Charge.exists({ unitId: id }), RevTarget.exists({ anc: id }), RevEntry.exists({ anc: id }), AuditPara.exists({ anc: id }),
  ]);
  if (kids) throw badRequest('Remove or move its sub-units first');
  if (charges || targets || entries || items) throw badRequest('This unit has postings or recorded data; mark it inactive instead');
  await Unit.deleteOne({ _id: id });
  await audit('unit.delete', 'Unit', id);
  res.status(204).end();
});

/* ---------------- Bulk imports ---------------- */
router.post(
  '/imports',
  express.json({ limit: '10mb' }),
  validate({ body: z.object({ kind: z.enum(['units', 'users', 'charges']), csv: z.string().min(1).max(10_000_000), dryRun: z.boolean().default(true), defaultPassword: z.string().min(8).max(128).optional() }) }),
  async (req, res) => {
    const { kind, csv, dryRun, defaultPassword } = req.body;
    let total = 0;
    try {
      total = parseCsv(csv).length;
    } catch (e) {
      throw badRequest(`Could not read the CSV: ${(e as Error).message}`);
    }
    if (!total) throw badRequest('The file has no data rows');
    if (total > 50_000) throw badRequest('Split the file: at most 50,000 rows per import');
    const run = await ImportRun.create({ kind, dryRun, total, createdBy: req.user!.id });
    await enqueue('import', { tenantId: req.user!.tenantId, runId: String(run._id), csv, defaultPassword });
    res.status(202).json(run);
  },
);

router.get('/imports', async (_req, res) => {
  res.json(await ImportRun.find().select('-errors').populate('createdBy', 'name').sort({ createdAt: -1 }).limit(50).lean());
});

router.get('/imports/:id', validate({ params: idParam }), async (req, res) => {
  const run = await ImportRun.findById(req.params.id).lean();
  if (!run) throw notFound('Import');
  res.json(run);
});

export default router;

import { Router } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { audit, notify } from '../../lib/notify.js';
import { requireRole, type AuthUser } from '../../middleware/auth.js';
import { objectId, q, validate } from '../../middleware/validate.js';
import { AuditPara, Charge, ScoreConfig, Task, Unit, User } from '../../models/index.js';
import type { BP } from '../org/blueprint.js';
import { bpOf } from '../org/service.js';
import { activeFilter, assertCanRead, assertCanSee, hasCap, holdsOn, myCharges, scopeRoots } from './access.js';
import { configResolver } from './scoring.js';

const router = Router();

/* ================================================================== *
 *  Registers (e.g. audit paras) — itemised, defined in the blueprint
 * ================================================================== */
const registerOf = (bp: BP, key?: string) => {
  const r = key ? bp.register.get(key) : bp.registers[0];
  if (!r) throw badRequest('Unknown register');
  return r;
};

router.get(
  '/audit-paras',
  validate({ query: z.object({ unitId: objectId, register: z.string().max(40).optional(), status: z.enum(['pending', 'settled']).optional(), category: z.string().max(80).optional() }) }),
  async (req, res) => {
    const bp = bpOf(req);
    const { unitId, status, category } = q<any>(req);
    const reg = registerOf(bp, q<any>(req).register);
    const unit = await assertCanRead(req.user!, unitId);
    const base = { anc: unit._id, register: reg.key };
    const filter: Record<string, unknown> = { ...base };
    if (status) filter.status = status;
    if (category) filter.category = category;
    const items = await AuditPara.find(filter).populate('unitId', 'name type').sort({ status: 1, auditYear: -1, paraNo: 1 }).limit(500).lean();
    const summary = await AuditPara.aggregate([
      { $match: base },
      { $group: { _id: '$category', n: { $sum: 1 }, amount: { $sum: '$amount' }, recovered: { $sum: '$recovered' }, settled: { $sum: { $cond: [{ $eq: ['$status', 'settled'] }, 1, 0] } } } },
      { $sort: { _id: 1 } },
    ]);
    res.json({ register: reg, unit: { _id: unit._id, name: unit.name, type: unit.type }, items, summary });
  },
);

/** Holders of the register's enter posts on (or above) the unit may maintain its items. */
const canMaintain = (me: AuthUser, bp: BP, regKey: string, unit: { anc: Types.ObjectId[]; type: string }) => {
  const reg = bp.register.get(regKey);
  if (!reg || !reg.levels.includes(unit.type)) return Promise.resolve(false);
  return holdsOn(me, reg.enterPosts, unit);
};

const paraBody = z.object({
  unitId: objectId,
  register: z.string().max(40).optional(),
  category: z.string().trim().min(1).max(80),
  auditYear: z.string().regex(/^\d{4}(-\d{2})?$/),
  paraNo: z.string().trim().min(1).max(30),
  subject: z.string().trim().max(300).optional(),
  amount: z.number().min(0).max(1e12),
  recovered: z.number().min(0).max(1e12).default(0),
  status: z.enum(['pending', 'settled']).default('pending'),
  remarks: z.string().trim().max(1000).optional(),
});

router.post('/audit-paras', validate({ body: paraBody }), async (req, res) => {
  const bp = bpOf(req);
  const reg = registerOf(bp, req.body.register);
  const unit = await assertCanSee(req.user!, req.body.unitId, bp);
  if (!reg.levels.includes(unit.type)) throw badRequest(`${reg.label} are recorded against ${reg.levels.map((l) => bp.level.get(l)?.label).join(' or ')}`);
  if (!reg.categories.includes(req.body.category)) throw badRequest('Unknown category');
  if (!(await canMaintain(req.user!, bp, reg.key, unit))) throw forbidden(`You cannot record ${reg.label.toLowerCase()} here`);
  if (req.body.recovered > req.body.amount) throw badRequest('Recovered cannot exceed the amount');
  const para = await AuditPara.create({ ...req.body, register: reg.key, anc: unit.anc, enteredBy: req.user!.id, settledAt: req.body.status === 'settled' ? new Date() : undefined });
  await audit('register.create', 'AuditPara', para._id, { register: reg.key });
  res.status(201).json(para);
});

router.patch('/audit-paras/:id', validate({ params: z.object({ id: objectId }), body: paraBody.omit({ unitId: true, register: true }).partial() }), async (req, res) => {
  const bp = bpOf(req);
  const para = await AuditPara.findById(req.params.id);
  if (!para) throw notFound('Item');
  const unit = await Unit.findById(para.unitId).lean();
  if (!unit || !(await canMaintain(req.user!, bp, para.register, unit))) throw forbidden();
  const wasSettled = para.status === 'settled';
  Object.assign(para, req.body);
  if (para.recovered > para.amount) throw badRequest('Recovered cannot exceed the amount');
  if (!wasSettled && para.status === 'settled') para.settledAt = new Date();
  await para.save();
  await audit('register.update', 'AuditPara', para._id, { fields: Object.keys(req.body) });
  res.json(para);
});

router.delete('/audit-paras/:id', validate({ params: z.object({ id: objectId }) }), async (req, res) => {
  const bp = bpOf(req);
  const para = await AuditPara.findById(req.params.id);
  if (!para) throw notFound('Item');
  if (!(await hasCap(req.user!, bp, 'manage_registers', { anc: para.anc as Types.ObjectId[] }))) throw forbidden('You cannot delete register items');
  await para.deleteOne();
  await audit('register.delete', 'AuditPara', para._id);
  res.status(204).end();
});

/* ================================================================== *
 *  Tasks — any officer can assign to anyone inside their jurisdiction
 * ================================================================== */
router.get('/tasks/assignees', validate({ query: z.object({ search: z.string().max(60).optional() }) }), async (req, res) => {
  const bp = bpOf(req);
  const roots = await scopeRoots(req.user!, bp);
  if (!roots.length) return res.json([]);
  const units = await Unit.find({ anc: { $in: roots } }).select('_id name type').lean();
  const unitName = new Map(units.map((u) => [String(u._id), u]));
  const charges = await Charge.find({ unitId: { $in: units.map((u) => u._id) }, userId: { $ne: req.user!.id }, ...activeFilter() })
    .populate('userId', 'name designation')
    .limit(3000)
    .lean();
  const search = q<any>(req).search?.toLowerCase();
  const out = charges
    .filter((c) => c.userId && (!search || (c.userId as any).name.toLowerCase().includes(search) || unitName.get(String(c.unitId))?.name.toLowerCase().includes(search)))
    .map((c) => ({ userId: (c.userId as any)._id, name: (c.userId as any).name, post: c.post, postLabel: bp.postLabel(c.post), unitId: c.unitId, unitName: unitName.get(String(c.unitId))?.name }));
  res.json(out.slice(0, 200));
});

router.get('/tasks', validate({ query: z.object({ box: z.enum(['mine', 'assigned']).default('mine'), status: z.enum(['open', 'done']).optional() }) }), async (req, res) => {
  const { box, status } = q<any>(req);
  const filter: Record<string, unknown> = box === 'mine' ? { assigneeId: req.user!.id } : { assignedBy: req.user!.id };
  if (status) filter.status = status;
  const items = await Task.find(filter)
    .populate('assigneeId', 'name designation')
    .populate('assignedBy', 'name designation')
    .populate('unitId', 'name type')
    .sort({ status: 1, dueDate: 1 })
    .limit(300)
    .lean();
  res.json(items);
});

router.post(
  '/tasks',
  validate({
    body: z.object({
      title: z.string().trim().min(3).max(200),
      details: z.string().trim().max(2000).optional(),
      assigneeId: objectId,
      unitId: objectId,
      dueDate: z.coerce.date(),
      priority: z.enum(['normal', 'high', 'urgent']).default('normal'),
    }),
  }),
  async (req, res) => {
    const unit = await assertCanSee(req.user!, req.body.unitId, bpOf(req));
    if (req.body.assigneeId === req.user!.id) throw badRequest('You cannot assign a task to yourself');
    const holds = await Charge.exists({ userId: req.body.assigneeId, unitId: unit._id, ...activeFilter() });
    if (!holds) throw badRequest('That officer does not hold charge of this unit');
    const task = await Task.create({ ...req.body, anc: unit.anc, assignedBy: req.user!.id });
    await notify(req.body.assigneeId, { type: 'task.assigned', title: `New task: ${task.title}`, body: `Due ${task.dueDate.toDateString()}`, link: '/tasks' });
    res.status(201).json(task);
  },
);

router.post('/tasks/:id/complete', validate({ params: z.object({ id: objectId }), body: z.object({ note: z.string().trim().max(1000).optional() }) }), async (req, res) => {
  const task = await Task.findById(req.params.id);
  if (!task) throw notFound('Task');
  if (String(task.assigneeId) !== req.user!.id) throw forbidden('Only the assignee can complete this task');
  if (task.status === 'done') throw badRequest('Already completed');
  task.status = 'done';
  task.completedAt = new Date();
  task.completionNote = req.body.note;
  await task.save();
  await notify(task.assignedBy, { type: 'task.done', title: `Task completed: ${task.title}`, link: '/tasks?box=assigned' });
  res.json(task);
});

router.delete('/tasks/:id', validate({ params: z.object({ id: objectId }) }), async (req, res) => {
  const task = await Task.findById(req.params.id);
  if (!task) throw notFound('Task');
  if (String(task.assignedBy) !== req.user!.id) throw forbidden('Only the assigning officer can withdraw a task');
  await task.deleteOne();
  res.status(204).end();
});

/* ================================================================== *
 *  Scoring overrides — admins, for the organisation or any area
 * ================================================================== */
router.get('/score-config', validate({ query: z.object({ scopeUnitId: objectId.optional() }) }), async (req, res) => {
  const bp = bpOf(req);
  const { scopeUnitId } = q<any>(req);
  let anc: string[] = [];
  if (scopeUnitId) anc = (await assertCanSee(req.user!, scopeUnitId, bp)).anc.map(String);
  const resolve = await configResolver(bp);
  const own = await ScoreConfig.findOne({ scopeUnitId: scopeUnitId ?? null }).lean();
  res.json({
    effective: resolve(anc),
    inherited: scopeUnitId ? resolve(anc.slice(0, -1)) : null,
    hasOverride: !!own,
    profiles: bp.raw.profiles.map((p) => ({ key: p.key, label: p.label })),
    blocks: bp.blocks,
    // legacy names
    levels: bp.raw.profiles.map((p) => p.key),
  });
});

router.put(
  '/score-config',
  requireRole('admin'),
  validate({
    body: z.object({
      scopeUnitId: objectId.nullish(),
      blocks: z.record(z.string(), z.record(z.string(), z.number().min(0).max(100))),
      heads: z.record(z.string(), z.number().min(0).max(1000)),
    }),
  }),
  async (req, res) => {
    const bp = bpOf(req);
    const scopeUnitId = req.body.scopeUnitId ?? null;
    if (scopeUnitId) await assertCanSee(req.user!, scopeUnitId, bp);
    for (const [p, w] of Object.entries(req.body.blocks) as [string, Record<string, number>][]) {
      if (!bp.profiles.has(p)) throw badRequest(`Unknown profile "${p}"`);
      for (const k of Object.keys(w)) if (!bp.block.has(k)) throw badRequest(`Unknown block "${k}"`);
      const total = Object.values(w).reduce((s, v) => s + v, 0);
      if (Math.round(total) !== 100) throw badRequest(`Weights for ${bp.profiles.get(p)!.label} must add up to 100 (currently ${total})`);
    }
    for (const k of Object.keys(req.body.heads)) if (!bp.metric.has(k)) throw badRequest(`Unknown KPI "${k}"`);
    const cfg = await ScoreConfig.findOneAndUpdate(
      { scopeUnitId },
      { $set: { blocks: req.body.blocks, heads: req.body.heads, updatedBy: req.user!.id }, $setOnInsert: { scopeUnitId } },
      { upsert: true, new: true },
    );
    await audit('scoreConfig.update', 'ScoreConfig', cfg._id, { scopeUnitId });
    res.json(cfg);
  },
);

router.delete('/score-config', requireRole('admin'), validate({ query: z.object({ scopeUnitId: objectId }) }), async (req, res) => {
  await ScoreConfig.deleteOne({ scopeUnitId: q<any>(req).scopeUnitId });
  res.status(204).end();
});

/* ================================================================== *
 *  Postings (charges) — admins
 * ================================================================== */
router.get('/charges', validate({ query: z.object({ unitId: objectId }) }), async (req, res) => {
  const bp = bpOf(req);
  const unit = await assertCanSee(req.user!, q<any>(req).unitId, bp);
  const items = await Charge.find({ unitId: unit._id }).populate('userId', 'name designation bps').sort({ to: 1, from: -1 }).lean();
  res.json(items.map((c) => ({ ...c, postLabel: bp.postLabel(c.post), active: !c.to || c.to > new Date() })));
});

router.get('/my-charges', async (req, res) => {
  res.json(await myCharges(req.user!.id));
});

/** Validates a new posting against the blueprint (levels, single holder, exclusive posts). */
export async function checkPosting(bp: BP, input: { userId: string; unitId: string; post: string }, unit: { _id: Types.ObjectId; type: string }) {
  const def = bp.post.get(input.post);
  if (!def) throw badRequest(`Unknown post "${input.post}"`);
  if (!def.levels.includes(unit.type)) throw badRequest(`${def.label} is posted to a ${def.levels.map((l) => bp.level.get(l)?.label ?? l).join(' or ')}`);
  const conflicting = [...(def.single ? [def.key] : []), ...def.exclusiveWith];
  if (conflicting.length) {
    const existing = await Charge.findOne({ unitId: unit._id, post: { $in: conflicting }, ...activeFilter() }).lean();
    if (existing) throw badRequest(`This ${bp.level.get(unit.type)?.label ?? unit.type} already has a ${bp.postLabel(existing.post)}; end that charge first`);
  }
}

router.post(
  '/charges',
  requireRole('admin'),
  validate({
    body: z.object({
      userId: objectId,
      unitId: objectId,
      post: z.string().max(40),
      chargeType: z.enum(['regular', 'additional', 'look_after']).default('regular'),
      from: z.coerce.date().default(() => new Date()),
    }),
  }),
  async (req, res) => {
    const bp = bpOf(req);
    const { userId, unitId, post, chargeType, from } = req.body;
    const unit = await assertCanSee(req.user!, unitId, bp);
    if (!(await User.exists({ _id: userId, status: 'active' }))) throw notFound('User');
    await checkPosting(bp, { userId, unitId, post }, unit);
    const charge = await Charge.create({ userId, unitId, post, chargeType, from });
    await audit('charge.create', 'Charge', charge._id, { userId, unitId, post });
    res.status(201).json(charge);
  },
);

router.post('/charges/:id/end', requireRole('admin'), validate({ params: z.object({ id: objectId }) }), async (req, res) => {
  const charge = await Charge.findById(req.params.id);
  if (!charge) throw notFound('Charge');
  charge.to = new Date();
  await charge.save();
  await audit('charge.end', 'Charge', charge._id);
  res.json(charge);
});

export default router;

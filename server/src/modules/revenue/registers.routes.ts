import { Router } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { audit, notify } from '../../lib/notify.js';
import { requireRole } from '../../middleware/auth.js';
import { objectId, q, validate } from '../../middleware/validate.js';
import { AuditPara, Charge, ScoreConfig, Task, Unit, User } from '../../models/index.js';
import { activeFilter, assertCanSee, isWasilBaqiFor, myCharges, scopeRoots } from './access.js';
import { AUDIT_CATEGORIES, BLOCKS, LEVELS, POSTS, POST_LABEL, POST_UNIT, SINGLE_HOLDER, type Post } from './catalog.js';
import { configResolver } from './scoring.js';

const router = Router();

/* ================================================================== *
 *  Audit paras — entered by the Patwari (circle) or Wasil Baqi (tehsil)
 * ================================================================== */
router.get(
  '/audit-paras',
  validate({ query: z.object({ unitId: objectId, status: z.enum(['pending', 'settled']).optional(), category: z.enum(AUDIT_CATEGORIES).optional() }) }),
  async (req, res) => {
    const { unitId, status, category } = q<any>(req);
    const unit = await assertCanSee(req.user!, unitId);
    const filter: Record<string, unknown> = { anc: unit._id };
    if (status) filter.status = status;
    if (category) filter.category = category;
    const items = await AuditPara.find(filter).populate('unitId', 'name type').sort({ status: 1, auditYear: -1, paraNo: 1 }).limit(500).lean();
    const summary = await AuditPara.aggregate([
      { $match: { anc: unit._id } },
      { $group: { _id: '$category', n: { $sum: 1 }, amount: { $sum: '$amount' }, recovered: { $sum: '$recovered' }, settled: { $sum: { $cond: [{ $eq: ['$status', 'settled'] }, 1, 0] } } } },
      { $sort: { _id: 1 } },
    ]);
    res.json({ unit: { _id: unit._id, name: unit.name, type: unit.type }, items, summary });
  },
);

/** Patwari of the circle, or Wasil Baqi of the tehsil, may maintain paras. */
async function canMaintainParas(me: any, unit: { _id: Types.ObjectId; anc: Types.ObjectId[]; type: string }) {
  if (await isWasilBaqiFor(me, unit)) return true;
  return unit.type === 'circle' && !!(await Charge.exists({ userId: me.id, post: 'patwari', unitId: unit._id, ...activeFilter() }));
}

const paraBody = z.object({
  unitId: objectId,
  category: z.enum(AUDIT_CATEGORIES),
  auditYear: z.string().regex(/^\d{4}-\d{2}$/),
  paraNo: z.string().trim().min(1).max(30),
  subject: z.string().trim().max(300).optional(),
  amount: z.number().min(0).max(1e12),
  recovered: z.number().min(0).max(1e12).default(0),
  status: z.enum(['pending', 'settled']).default('pending'),
  remarks: z.string().trim().max(1000).optional(),
});

router.post('/audit-paras', validate({ body: paraBody }), async (req, res) => {
  const unit = await assertCanSee(req.user!, req.body.unitId);
  if (!['tehsil', 'circle'].includes(unit.type)) throw badRequest('Audit paras are recorded against a tehsil or a patwar circle');
  if (!(await canMaintainParas(req.user!, unit))) throw forbidden('Only the Patwari of this circle or the Wasil Baqi Navees can record audit paras');
  if (req.body.recovered > req.body.amount) throw badRequest('Recovered cannot exceed the para amount');
  const para = await AuditPara.create({ ...req.body, anc: unit.anc, enteredBy: req.user!.id, settledAt: req.body.status === 'settled' ? new Date() : undefined });
  await audit('auditPara.create', 'AuditPara', para._id);
  res.status(201).json(para);
});

router.patch(
  '/audit-paras/:id',
  validate({ params: z.object({ id: objectId }), body: paraBody.omit({ unitId: true }).partial() }),
  async (req, res) => {
    const para = await AuditPara.findById(req.params.id);
    if (!para) throw notFound('Audit para');
    const unit = await Unit.findById(para.unitId).lean();
    if (!unit || !(await canMaintainParas(req.user!, unit))) throw forbidden();
    const wasSettled = para.status === 'settled';
    Object.assign(para, req.body);
    if (para.recovered > para.amount) throw badRequest('Recovered cannot exceed the para amount');
    if (!wasSettled && para.status === 'settled') para.settledAt = new Date();
    await para.save();
    await audit('auditPara.update', 'AuditPara', para._id, { fields: Object.keys(req.body) });
    res.json(para);
  },
);

router.delete('/audit-paras/:id', validate({ params: z.object({ id: objectId }) }), async (req, res) => {
  const para = await AuditPara.findById(req.params.id);
  if (!para) throw notFound('Audit para');
  if (!(await isWasilBaqiFor(req.user!, { anc: para.anc as Types.ObjectId[] }))) throw forbidden('Only Wasil Baqi Navees can delete audit paras');
  await para.deleteOne();
  await audit('auditPara.delete', 'AuditPara', para._id);
  res.status(204).end();
});

/* ================================================================== *
 *  Tasks — any officer can assign to anyone inside their jurisdiction
 * ================================================================== */

/** Officers (any post) whose charge lies inside the caller's jurisdiction, excluding the caller. */
router.get('/tasks/assignees', validate({ query: z.object({ search: z.string().max(60).optional() }) }), async (req, res) => {
  const roots = await scopeRoots(req.user!);
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
    .map((c) => ({ userId: (c.userId as any)._id, name: (c.userId as any).name, post: c.post, postLabel: POST_LABEL[c.post as Post], unitId: c.unitId, unitName: unitName.get(String(c.unitId))?.name }));
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
      unitId: objectId, // the assignee's charge unit
      dueDate: z.coerce.date(),
      priority: z.enum(['normal', 'high', 'urgent']).default('normal'),
    }),
  }),
  async (req, res) => {
    const unit = await assertCanSee(req.user!, req.body.unitId);
    if (req.body.assigneeId === req.user!.id) throw badRequest('You cannot assign a task to yourself');
    const holds = await Charge.exists({ userId: req.body.assigneeId, unitId: unit._id, ...activeFilter() });
    if (!holds) throw badRequest('That officer does not hold charge of this unit');
    const task = await Task.create({ ...req.body, anc: unit.anc, assignedBy: req.user!.id });
    await notify(req.body.assigneeId, { type: 'task.assigned', title: `New task: ${task.title}`, body: `Due ${task.dueDate.toDateString()}`, link: '/tasks' });
    res.status(201).json(task);
  },
);

router.post(
  '/tasks/:id/complete',
  validate({ params: z.object({ id: objectId }), body: z.object({ note: z.string().trim().max(1000).optional() }) }),
  async (req, res) => {
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
  },
);

router.delete('/tasks/:id', validate({ params: z.object({ id: objectId }) }), async (req, res) => {
  const task = await Task.findById(req.params.id);
  if (!task) throw notFound('Task');
  if (String(task.assignedBy) !== req.user!.id) throw forbidden('Only the assigning officer can withdraw a task');
  await task.deleteOne();
  res.status(204).end();
});

/* ================================================================== *
 *  Scoring configuration — admins, per organisation / division / district / tehsil
 * ================================================================== */
router.get('/score-config', validate({ query: z.object({ scopeUnitId: objectId.optional() }) }), async (req, res) => {
  const { scopeUnitId } = q<any>(req);
  let anc: string[] = [];
  if (scopeUnitId) {
    const unit = await assertCanSee(req.user!, scopeUnitId);
    if (!['division', 'district', 'tehsil'].includes(unit.type)) throw badRequest('Scoring can be configured for a division, district or tehsil');
    anc = unit.anc.map(String);
  }
  const resolve = await configResolver();
  const own = await ScoreConfig.findOne({ scopeUnitId: scopeUnitId ?? null }).lean();
  const effective = resolve(anc);
  const inherited = resolve(anc.slice(0, -1));
  res.json({ effective, inherited: scopeUnitId ? inherited : null, hasOverride: !!own, levels: LEVELS, blocks: BLOCKS });
});

const blockSchema = z.object(Object.fromEntries(BLOCKS.map((b) => [b, z.number().min(0).max(100)])) as Record<(typeof BLOCKS)[number], z.ZodNumber>);
router.put(
  '/score-config',
  requireRole('admin'),
  validate({
    body: z.object({
      scopeUnitId: objectId.nullish(),
      blocks: z.object(Object.fromEntries(LEVELS.map((l) => [l, blockSchema])) as Record<(typeof LEVELS)[number], typeof blockSchema>),
      heads: z.record(z.string(), z.number().min(0).max(100)),
    }),
  }),
  async (req, res) => {
    const scopeUnitId = req.body.scopeUnitId ?? null;
    if (scopeUnitId) await assertCanSee(req.user!, scopeUnitId);
    for (const [lvl, w] of Object.entries(req.body.blocks) as [string, Record<string, number>][]) {
      const total = Object.values(w).reduce((s, v) => s + v, 0);
      if (Math.round(total) !== 100) throw badRequest(`Block weights for ${lvl} must add up to 100 (currently ${total})`);
    }
    const cfg = await ScoreConfig.findOneAndUpdate(
      { scopeUnitId },
      { $set: { blocks: req.body.blocks, heads: req.body.heads, updatedBy: req.user!.id }, $setOnInsert: { scopeUnitId } },
      { upsert: true, new: true, runValidators: true },
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
  const unit = await assertCanSee(req.user!, q<any>(req).unitId);
  const items = await Charge.find({ unitId: unit._id }).populate('userId', 'name designation bps').sort({ to: 1, from: -1 }).lean();
  res.json(items.map((c) => ({ ...c, postLabel: POST_LABEL[c.post as Post], active: !c.to || c.to > new Date() })));
});

router.get('/my-charges', async (req, res) => {
  res.json(await myCharges(req.user!.id));
});

router.post(
  '/charges',
  requireRole('admin'),
  validate({
    body: z.object({
      userId: objectId,
      unitId: objectId,
      post: z.enum(POSTS),
      chargeType: z.enum(['regular', 'additional', 'look_after']).default('regular'),
      from: z.coerce.date().default(() => new Date()),
    }),
  }),
  async (req, res) => {
    const { userId, unitId, post, chargeType, from } = req.body;
    const unit = await assertCanSee(req.user!, unitId);
    const allowed = post === 'tehsildar' ? ['tehsil', 'qanungoi'] : [POST_UNIT[post as Post]];
    if (!allowed.includes(unit.type)) throw badRequest(`${POST_LABEL[post as Post]} is posted to a ${allowed.join(' or ')}`);
    if (!(await User.exists({ _id: userId, status: 'active' }))) throw notFound('User');
    if (post === 'naib_tehsildar' || (post === 'tehsildar' && unit.type === 'qanungoi')) {
      // A qanungoi has exactly one revenue officer
      const ro = await Charge.exists({ unitId, post: { $in: ['tehsildar', 'naib_tehsildar'] }, ...activeFilter() });
      if (ro) throw badRequest('This qanungoi already has a revenue officer; end that charge first');
    } else if (SINGLE_HOLDER.includes(post)) {
      const existing = await Charge.exists({ unitId, post, ...activeFilter() });
      if (existing) throw badRequest(`This ${unit.type} already has a ${POST_LABEL[post as Post]}; end that charge first`);
    }
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

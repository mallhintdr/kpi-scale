/**
 * Assigned targets.
 *  - Individual: a supervisory officer sets a target for one head for one subordinate.
 *  - Area drive: a target for an area (qanungoi / tehsil / district / division) is distributed to its
 *    patwar circles IN PROPORTION TO EACH CIRCLE'S REMAINING BALANCE for that head.
 * Durations: 1 week, 15 days or 1 month. Progress counts only after verification by the KPI's verify posts.
 */
import { Router } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import { AppError, badRequest, forbidden, notFound } from '../../lib/errors.js';
import { audit, notify } from '../../lib/notify.js';
import { objectId, q, validate } from '../../middleware/validate.js';
import { AssignedTarget, Charge, RevEntry, TargetDrive, Unit, User } from '../../models/index.js';
import type { AuthUser } from '../../middleware/auth.js';
import type { BP } from '../org/blueprint.js';
import { bpOf } from '../org/service.js';
import { activeFilter, assertCanRead, autoVerifies, canVerify, hasCap, scopeRoots } from './access.js';
import { loadFacts } from './scoring.js';

const router = Router();
const PERIOD_DAYS = { week: 7, fortnight: 15, month: 30 } as const;
type Period = keyof typeof PERIOD_DAYS;
const DAY = 86_400_000;
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const endOf = (start: Date, period: Period) => new Date(start.getTime() + PERIOD_DAYS[period] * DAY - 1);

/** Derived state for display and scoring (uses VERIFIED achievement only). */
/** The part of a target that was due: the full target, or — if its drive was stopped early — the pro-rata share up to the stop date. */
export function effectiveTarget(t: { targetValue: number; startDate: Date; endDate: Date; status: string; stoppedAt?: Date | null }) {
  if (t.status !== 'stopped' || !t.stoppedAt) return t.targetValue;
  const span = t.endDate.getTime() - t.startDate.getTime();
  const done = Math.max(0, Math.min(1, (t.stoppedAt.getTime() - t.startDate.getTime()) / span));
  return Math.max(1, Math.round(t.targetValue * done));
}

export function describe(t: { targetValue: number; achieved: number; startDate: Date; endDate: Date; status: string; stoppedAt?: Date | null }, now = new Date()) {
  const due = effectiveTarget(t);
  const pct = Math.min(100, (t.achieved / due) * 100);
  const span = t.endDate.getTime() - t.startDate.getTime();
  const elapsed = Math.max(0, Math.min(100, ((now.getTime() - t.startDate.getTime()) / span) * 100));
  const ended = now > t.endDate;
  const state = t.status === 'cancelled' ? 'cancelled' : t.status === 'stopped' ? 'stopped' : pct >= 100 ? 'achieved' : ended ? 'missed' : now < t.startDate ? 'upcoming' : 'running';
  const daysLeft = ended ? 0 : Math.ceil((t.endDate.getTime() - now.getTime()) / DAY);
  return { pct: Math.round(pct * 10) / 10, elapsed: Math.round(elapsed), state, daysLeft, dueTarget: due };
}

const withState = <T extends { targetValue: number; achieved: number; startDate: Date; endDate: Date; status: string }>(bp: BP, t: T) => ({
  ...t,
  ...describe(t),
  headName: bp.metric.get((t as any).head)?.name,
  money: bp.metric.get((t as any).head)?.unit === 'money',
});
const isMoney = (bp: BP, code: string) => bp.metric.get(code)?.unit === 'money';

/** The unit must lie inside the assigning officer's own jurisdiction. */
async function inMyJurisdiction(me: AuthUser, bp: BP, unitId: Types.ObjectId | string) {
  const unit = await Unit.findById(unitId).select('anc').lean();
  if (!unit) return false;
  const roots = (await scopeRoots(me, bp)).map(String);
  return unit.anc.some((a) => roots.includes(String(a)));
}

/** Recompute verified / pending totals from the progress log. */
function recompute(t: any) {
  t.achieved = t.progress.filter((p: any) => p.status === 'verified').reduce((s: number, p: any) => s + p.value, 0);
  t.achievedPending = t.progress.filter((p: any) => p.status === 'submitted').reduce((s: number, p: any) => s + p.value, 0);
}

/* ================================================================== *
 *  Lists
 * ================================================================== */
router.get(
  '/assigned',
  validate({ query: z.object({ box: z.enum(['mine', 'assigned', 'unit']).default('mine'), unitId: objectId.optional(), state: z.enum(['open', 'closed', 'all']).default('all'), driveId: objectId.optional() }) }),
  async (req, res) => {
    const { box, unitId, state, driveId } = q<any>(req);
    const filter: Record<string, unknown> = { status: { $ne: 'cancelled' } };
    if (driveId) filter.driveId = driveId;
    else if (box === 'mine') filter.assigneeId = req.user!.id;
    else if (box === 'assigned') { filter.assignedBy = req.user!.id; filter.driveId = null; }
    else {
      if (!unitId) throw badRequest('unitId required');
      const unit = await assertCanRead(req.user!, unitId);
      filter.anc = unit._id;
    }
    const now = new Date();
    if (state === 'open') filter.endDate = { $gte: startOfDay(now) };
    if (state === 'closed') filter.endDate = { $lt: startOfDay(now) };
    const rows = await AssignedTarget.find(filter)
      .populate('assigneeId', 'name designation')
      .populate('assignedBy', 'name designation')
      .populate('unitId', 'name type')
      .sort(driveId ? { targetValue: -1 } : { endDate: -1 })
      .limit(500)
      .lean();
    res.json(rows.map((r) => withState(bpOf(req), r as any)));
  },
);

/* ================================================================== *
 *  Individual target
 * ================================================================== */
const baseBody = {
  head: z.string().max(40),
  period: z.enum(['week', 'fortnight', 'month']),
  startDate: z.coerce.date(),
  note: z.string().trim().max(500).optional(),
};

router.post(
  '/assigned',
  validate({ body: z.object({ ...baseBody, assigneeId: objectId, unitId: objectId, targetValue: z.number().positive().max(1e12) }) }),
  async (req, res) => {
    const bp = bpOf(req);
    const { head, assigneeId, unitId, period, startDate, targetValue, note } = req.body as any;
    const h = bp.metric.get(head);
    if (!h || !h.active) throw badRequest('Unknown KPI');
    if (!(await hasCap(req.user!, bp, 'assign_targets'))) throw forbidden('Your post cannot assign targets');
    if (assigneeId === req.user!.id) throw badRequest('You cannot assign a target to yourself');
    const holds = await Charge.findOne({ userId: assigneeId, unitId, ...activeFilter() }).lean();
    if (!holds || bp.dataPosts.has(holds.post)) throw badRequest('That officer does not hold a scored charge of this unit');
    if (!(await inMyJurisdiction(req.user!, bp, unitId))) throw forbidden('You can only assign targets within your own jurisdiction');
    const unit = await Unit.findById(unitId).select('anc').lean();
    const start = startOfDay(startDate);
    const t = await AssignedTarget.create({ head, assigneeId, unitId, anc: unit!.anc, assignedBy: req.user!.id, period, startDate: start, endDate: endOf(start, period), targetValue, note });
    await notify(assigneeId, { type: 'target.assigned', title: `New target: ${h.name}`, body: `${h.unit === 'money' ? `${bp.raw.money.symbol} ${targetValue.toLocaleString()}` : targetValue.toLocaleString()} by ${t.endDate.toDateString()}`, link: '/assigned' });
    await audit('assignedTarget.create', 'AssignedTarget', t._id, { head, assigneeId, period, targetValue });
    res.status(201).json(withState(bp, t.toObject() as any));
  },
);

/* ================================================================== *
 *  Area drive — proportional distribution by remaining balance
 * ================================================================== */
const driveBody = z.object({
  ...baseBody,
  unitId: objectId,
  basis: z.enum(['percent', 'amount']),
  value: z.number().positive().max(1e12),
  includeArrears: z.boolean().default(true),
});

/**
 * A drive for the same head that is still running (or about to start) in an overlapping area —
 * the same unit, an area containing it, or an area inside it. Only one may run at a time.
 */
async function runningDriveFor(head: string, unit: { _id: Types.ObjectId; anc: Types.ObjectId[] }) {
  return TargetDrive.findOne({
    head,
    status: 'active',
    endDate: { $gte: new Date() },
    $or: [{ unitId: { $in: unit.anc } }, { anc: unit._id }],
  }).populate('unitId', 'name type').populate('assignedBy', 'name').lean();
}

/** The scored post whose holders receive drive shares on units of a KPI's level. */
function sharePostsFor(bp: BP, level: string, enterPosts: string[]) {
  const atLevel = bp.posts.filter((p) => p.scored && p.levels.includes(level));
  const preferred = atLevel.filter((p) => enterPosts.includes(p.key));
  return (preferred.length ? preferred : atLevel).map((p) => p.key);
}

/** Remaining balance per staffed unit (at the KPI's level) for a KPI, and each unit's proportional share. */
async function planDrive(me: AuthUser, bp: BP, b: z.infer<typeof driveBody>) {
  const head = bp.metric.get(b.head);
  if (!head || !head.active) throw badRequest('Unknown KPI');
  if (head.perHolder) throw badRequest(`${head.name} is recorded per person and cannot be distributed`);
  if (!(await hasCap(me, bp, 'assign_targets'))) throw forbidden('Your post cannot set drives');
  if (b.basis === 'percent' && b.value > 100) throw badRequest('Percentage cannot exceed 100');
  const unit = await Unit.findById(b.unitId).lean();
  if (!unit) throw notFound('Unit');
  if ((bp.levelIndex.get(unit.type) ?? 99) >= (bp.levelIndex.get(head.level) ?? 0)) throw badRequest(`Area drives are set for an area above ${bp.level.get(head.level)?.label ?? head.level} level`);
  if (!(await inMyJurisdiction(me, bp, unit._id))) throw forbidden('You can only set drives within your own jurisdiction');
  const isTarget = bp.kindOf(head.code) === 'target';

  const running = await runningDriveFor(b.head, unit);
  if (running) {
    const ru = running.unitId as any;
    throw new AppError(409, `A ${head.name} drive is already running in ${ru?.name} until ${running.endDate.toDateString()}. Stop it first; the new drive will start from the remaining balance.`, 'DRIVE_RUNNING', {
      driveId: running._id, unit: ru?.name, assignedBy: (running.assignedBy as any)?.name, endDate: running.endDate,
      canStop: await inMyJurisdiction(me, bp, running.unitId as any),
    });
  }

  const fy = bp.fy.of(b.startDate);
  const facts = await loadFacts(unit._id, fy, bp);
  const circles = [...facts.units.values()].filter((u) => u.type === head.level);

  // Verified drive recoveries logged after a circle's last verified monthly entry are not yet in the
  // accounts; deduct them so the new drive starts from what is really still outstanding.
  const lastEntry = new Map(
    (await RevEntry.aggregate<{ _id: Types.ObjectId; m: string }>([
      { $match: { fy, head: b.head, anc: unit._id, status: 'verified' } },
      { $group: { _id: '$unitId', m: { $max: '$month' } } },
    ])).map((x) => [String(x._id), x.m]),
  );
  const driveProgress = await AssignedTarget.find({ head: b.head, anc: unit._id, driveId: { $ne: null }, status: { $in: ['active', 'stopped'] } })
    .select('unitId progress').lean();
  const unbooked = new Map<string, number>();
  for (const t of driveProgress) {
    const m = lastEntry.get(String(t.unitId));
    const after = m ? new Date(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 1) : new Date(0); // first day after that month
    for (const pr of (t.progress as any[]) ?? []) {
      if (pr.status === 'verified' && new Date(pr.date) >= after) unbooked.set(String(t.unitId), (unbooked.get(String(t.unitId)) ?? 0) + pr.value);
    }
  }
  const patwaris = await Charge.find({ post: { $in: sharePostsFor(bp, head.level, head.enterPosts) }, unitId: { $in: circles.map((c) => c._id) }, ...activeFilter() }).populate('userId', 'name').lean();
  const holder = new Map(patwaris.map((p) => [String(p.unitId), p.userId as any]));

  const rows = circles.map((c) => {
    const f = facts.rows.find((r) => r.unitId === String(c._id) && !r.roUserId)?.f;
    let remaining = 0;
    if (isTarget) {
      const v = f?.rev[b.head];
      if (v) remaining = Math.max(0, v.t - v.cur) + (b.includeArrears ? Math.max(0, v.ad - v.arr) : 0);
    } else {
      const v = f?.cases[b.head];
      if (v) remaining = Math.max(0, v.open + v.rec - v.disp);
    }
    remaining = Math.max(0, remaining - (unbooked.get(String(c._id)) ?? 0));
    const p = holder.get(String(c._id));
    return { unitId: String(c._id), circle: c.name, anc: c.anc, patwariId: p ? String(p._id) : null, patwari: p?.name ?? null, remaining };
  });
  const staffed = rows.filter((r) => r.patwariId && r.remaining > 0);
  const remainingTotal = staffed.reduce((s, r) => s + r.remaining, 0);
  if (!remainingTotal) throw badRequest('No remaining balance in this KPI for the staffed units of this area');
  const total = b.basis === 'percent' ? (remainingTotal * b.value) / 100 : b.value;
  if (total > remainingTotal) throw badRequest(`Target exceeds the remaining balance (${remainingTotal.toLocaleString()})`);

  // Proportional shares, rounded (Rs 100 for money, whole cases for counts); rounding drift goes to the largest share
  const unitOf = head.unit === 'money' ? 100 : 1;
  const shares = staffed.map((r) => ({ ...r, share: Math.round(((total * r.remaining) / remainingTotal) / unitOf) * unitOf }));
  const drift = Math.round(total / unitOf) * unitOf - shares.reduce((s, r) => s + r.share, 0);
  if (shares.length && drift) shares.sort((a, b2) => b2.remaining - a.remaining)[0].share += drift;
  const positive = shares.filter((r) => r.share > 0).sort((a, b2) => b2.share - a.share);
  return {
    unit: { _id: unit._id, name: unit.name, type: unit.type, anc: unit.anc },
    head: { code: head.code, name: head.name, money: head.unit === 'money' },
    remainingTotal,
    targetTotal: positive.reduce((s, r) => s + r.share, 0),
    rows: positive.map((r) => ({ ...r, pctOfRemaining: Math.round((r.share / r.remaining) * 1000) / 10 })),
    vacant: rows.filter((r) => !r.patwariId).map((r) => ({ circle: r.circle, remaining: r.remaining })),
    zeroBalance: rows.filter((r) => r.patwariId && r.remaining === 0).length,
  };
}

router.post('/assigned/drive/preview', validate({ body: driveBody }), async (req, res) => {
  const plan = await planDrive(req.user!, bpOf(req), req.body);
  const start = startOfDay(req.body.startDate);
  res.json({ ...plan, startDate: start, endDate: endOf(start, req.body.period), rows: plan.rows.map(({ anc: _a, ...r }) => r) });
});

router.post('/assigned/drive', validate({ body: driveBody }), async (req, res) => {
  const b = req.body as z.infer<typeof driveBody>;
  const plan = await planDrive(req.user!, bpOf(req), b);
  const start = startOfDay(b.startDate);
  const end = endOf(start, b.period);
  const drive = await TargetDrive.create({
    head: b.head, unitId: plan.unit._id, anc: plan.unit.anc, assignedBy: req.user!.id, period: b.period, startDate: start, endDate: end,
    basis: b.basis, value: b.value, includeArrears: b.includeArrears, remainingTotal: plan.remainingTotal, targetTotal: plan.targetTotal,
    shares: plan.rows.length, vacantCircles: plan.vacant.length, note: b.note,
  });
  await AssignedTarget.insertMany(plan.rows.map((r) => ({
    tenantId: drive.tenantId, head: b.head, assigneeId: r.patwariId, unitId: r.unitId, anc: r.anc, assignedBy: req.user!.id,
    period: b.period, startDate: start, endDate: end, targetValue: r.share, note: b.note, driveId: drive._id, remainingAtAssign: r.remaining,
  })));
  await notify(plan.rows.map((r) => r.patwariId!), {
    type: 'target.assigned',
    title: `New target: ${plan.head.name}`,
    body: `Your share of the ${plan.unit.name} drive, due ${end.toDateString()}`,
    link: '/assigned',
  });
  await audit('drive.create', 'TargetDrive', drive._id, { head: b.head, unitId: b.unitId, basis: b.basis, value: b.value, shares: plan.rows.length });
  res.status(201).json(drive);
});

/** Drives with their aggregate progress (verified, size-weighted). */
router.get('/assigned/drives', validate({ query: z.object({ box: z.enum(['assigned', 'unit']).default('assigned'), unitId: objectId.optional() }) }), async (req, res) => {
  const { box, unitId } = q<any>(req);
  const filter: Record<string, unknown> = { status: { $in: ['active', 'stopped'] } };
  if (box === 'assigned') filter.assignedBy = req.user!.id;
  else {
    if (!unitId) throw badRequest('unitId required');
    filter.anc = (await assertCanRead(req.user!, unitId))._id;
  }
  const drives = await TargetDrive.find(filter).populate('unitId', 'name type').populate('assignedBy', 'name').sort({ startDate: -1 }).limit(100).lean();
  const shares = await AssignedTarget.find({ driveId: { $in: drives.map((d) => d._id) }, status: { $in: ['active', 'stopped'] } })
    .select('driveId targetValue achieved achievedPending startDate endDate status stoppedAt').lean();
  const by = new Map<string, { due: number; capped: number; pending: number; met: number }>();
  for (const t of shares) {
    const k = String(t.driveId);
    const v = by.get(k) ?? { due: 0, capped: 0, pending: 0, met: 0 };
    const due = effectiveTarget(t as any);
    v.due += due; v.capped += Math.min(t.achieved, due); v.pending += t.achievedPending ?? 0; if (t.achieved >= due) v.met++;
    by.set(k, v);
  }
  res.json(await Promise.all(drives.map(async (d) => {
    const a = by.get(String(d._id));
    const st = describe({ targetValue: a?.due || d.targetTotal, achieved: a?.capped ?? 0, startDate: d.startDate, endDate: d.endDate, status: d.status }); // dueTotal is already pro-rata: do not pro-rate twice
    return {
      ...d, ...st, headName: bpOf(req).metric.get(d.head)?.name, money: isMoney(bpOf(req), d.head),
      dueTotal: a?.due ?? d.targetTotal, achieved: a?.capped ?? 0, pending: a?.pending ?? 0, met: a?.met ?? 0,
      canStop: d.status === 'active' && d.endDate >= new Date() && (await inMyJurisdiction(req.user!, bpOf(req), (d.unitId as any)._id)),
    };
  })));
});

router.post('/assigned/drives/:id/stop', validate({ params: z.object({ id: objectId }) }), async (req, res) => {
  const d = await TargetDrive.findById(req.params.id);
  if (!d) throw notFound('Drive');
  if (d.status !== 'active' || d.endDate < new Date()) throw badRequest('This drive is not running');
  if (!(await inMyJurisdiction(req.user!, bpOf(req), d.unitId as any))) throw forbidden('Only the officer who set the drive, or a senior officer over this area, can stop it');
  const now = new Date();
  d.status = 'stopped';
  d.stoppedAt = now;
  d.stoppedBy = new Types.ObjectId(req.user!.id) as any;
  await d.save();
  await AssignedTarget.updateMany({ driveId: d._id, status: 'active' }, { status: 'stopped', stoppedAt: now });
  const assignees = await AssignedTarget.find({ driveId: d._id }).distinct('assigneeId');
  await notify(assignees, { type: 'drive.stopped', title: `Drive stopped: ${bpOf(req).metric.get(d.head)?.name}`, body: 'Your share is judged on progress up to today.', link: '/assigned' });
  await audit('drive.stop', 'TargetDrive', d._id);
  res.json(d);
});

router.post('/assigned/drives/:id/cancel', validate({ params: z.object({ id: objectId }) }), async (req, res) => {
  const d = await TargetDrive.findById(req.params.id);
  if (!d) throw notFound('Drive');
  if (String(d.assignedBy) !== req.user!.id) throw forbidden('Only the officer who set the drive can withdraw it');
  d.status = 'cancelled';
  await d.save();
  await AssignedTarget.updateMany({ driveId: d._id }, { status: 'cancelled' });
  res.json(d);
});

/* ================================================================== *
 *  Progress + verification
 * ================================================================== */
router.post(
  '/assigned/:id/progress',
  validate({ params: z.object({ id: objectId }), body: z.object({ value: z.number().positive().max(1e12), date: z.coerce.date(), note: z.string().trim().max(300).optional() }) }),
  async (req, res) => {
    const bp = bpOf(req);
    const t = await AssignedTarget.findById(req.params.id);
    if (!t) throw notFound('Target');
    const me = req.user!.id;
    const unit = { anc: t.anc as Types.ObjectId[] };
    const dataOfficer = await autoVerifies(req.user!, bp, t.head, unit);
    if (String(t.assigneeId) !== me && String(t.assignedBy) !== me && !dataOfficer) {
      throw forbidden('Only the assignee, the assigning officer, or a verifier of this KPI can log progress');
    }
    if (t.status === 'cancelled') throw badRequest('This target was withdrawn');
    if (t.status === 'stopped') throw badRequest('This drive was stopped; progress can no longer be logged');
    const d = startOfDay(req.body.date);
    if (d < startOfDay(t.startDate) || d > t.endDate) throw badRequest('Progress date must fall within the target period');
    if (d > new Date()) throw badRequest('Progress cannot be logged for a future date');
    const now = new Date();
    t.progress.push({
      date: d, value: req.body.value, note: req.body.note, by: new Types.ObjectId(me),
      // The verifying data officer's own entries are verified on save
      status: dataOfficer ? 'verified' : 'submitted', verifiedBy: dataOfficer ? new Types.ObjectId(me) : undefined, verifiedAt: dataOfficer ? now : undefined,
    } as any);
    recompute(t);
    await t.save();
    if (!dataOfficer) {
      const verifiers = await Charge.find({ post: { $in: bp.metric.get(t.head)?.verifyPosts ?? [] }, unitId: { $in: t.anc }, ...activeFilter() }).distinct('userId');
      await notify(verifiers, { type: 'target.progress', title: 'Target progress to verify', body: bp.metric.get(t.head)?.name, link: '/verify?tab=targets' });
    }
    res.json(withState(bp, t.toObject() as any));
  },
);

router.delete('/assigned/:id/progress/:pid', validate({ params: z.object({ id: objectId, pid: objectId }) }), async (req, res) => {
  const t = await AssignedTarget.findById(req.params.id);
  if (!t) throw notFound('Target');
  const p: any = t.progress.find((x: any) => String(x._id) === req.params.pid);
  if (!p) throw notFound('Progress entry');
  if (p.status === 'verified') throw badRequest('Verified progress cannot be deleted');
  if (String(p.by) !== req.user!.id && String(t.assignedBy) !== req.user!.id) throw forbidden();
  t.progress = t.progress.filter((x: any) => String(x._id) !== req.params.pid) as any;
  recompute(t);
  await t.save();
  res.json(withState(bpOf(req), t.toObject() as any));
});

/** Verification queue: each KPI's verify posts see its progress, in the areas where they are posted. */
router.get('/assigned/verify', async (req, res) => {
  const me = req.user!;
  const bp = bpOf(req);
  const verifyPosts = [...new Set(bp.metrics.flatMap((m) => m.verifyPosts))];
  const charges = await Charge.find({ userId: me.id, post: { $in: verifyPosts }, ...activeFilter() }).lean();
  if (!charges.length) return res.json([]);
  const out: unknown[] = [];
  for (const c of charges) {
    const heads = bp.metrics.filter((m) => m.verifyPosts.includes(c.post)).map((m) => m.code);
    const rows = await AssignedTarget.find({ anc: c.unitId, head: { $in: heads }, 'progress.status': 'submitted', status: 'active' })
      .populate('assigneeId', 'name').populate('unitId', 'name').lean();
    for (const t of rows) {
      for (const p of (t.progress as any[]).filter((x) => x.status === 'submitted')) {
        out.push({ targetId: t._id, progressId: p._id, head: t.head, headName: bp.metric.get(t.head)?.name, money: isMoney(bp, t.head),
          assignee: t.assigneeId, unit: t.unitId, date: p.date, value: p.value, note: p.note, targetValue: t.targetValue });
      }
    }
  }
  res.json(out);
});

router.post(
  '/assigned/verify',
  validate({ body: z.object({ items: z.array(z.object({ targetId: objectId, progressId: objectId })).min(1).max(300), action: z.enum(['verify', 'reject']) }) }),
  async (req, res) => {
    const bp = bpOf(req);
    let updated = 0;
    const now = new Date();
    for (const it of req.body.items as { targetId: string; progressId: string }[]) {
      const t = await AssignedTarget.findById(it.targetId);
      if (!t) continue;
      const head = bp.metric.get(t.head);
      const allowed = await canVerify(req.user!, bp, t.head, { anc: t.anc as Types.ObjectId[] });
      if (!allowed) throw forbidden(`You cannot verify ${head?.name} in this area`);
      const p: any = t.progress.find((x: any) => String(x._id) === it.progressId);
      if (!p || p.status !== 'submitted') continue;
      p.status = req.body.action === 'verify' ? 'verified' : 'rejected';
      p.verifiedBy = new Types.ObjectId(req.user!.id);
      p.verifiedAt = now;
      recompute(t);
      await t.save();
      updated++;
      if (describe(t).state === 'achieved') {
        await notify(t.assignedBy, { type: 'target.achieved', title: `Target achieved: ${head?.name}`, link: '/assigned?box=assigned' });
      }
    }
    res.json({ updated });
  },
);

/* ---------- Withdraw an individual target ---------- */
router.post('/assigned/:id/cancel', validate({ params: z.object({ id: objectId }) }), async (req, res) => {
  const t = await AssignedTarget.findById(req.params.id);
  if (!t) throw notFound('Target');
  if (String(t.assignedBy) !== req.user!.id) throw forbidden('Only the assigning officer can withdraw a target');
  t.status = 'cancelled';
  await t.save();
  await notify(t.assigneeId, { type: 'target.cancelled', title: `Target withdrawn: ${bpOf(req).metric.get(t.head)?.name}`, link: '/assigned' });
  res.json(withState(bpOf(req), t.toObject() as any));
});

/* ================================================================== *
 *  Targets-mode summary per officer per charge
 * ================================================================== */
/**
 * For each charge of the post in the area, take every started target inside that charge's unit
 * (a Patwari's own circle; for a Girdawar / Revenue Officer / AC, all shares in their area).
 * Per head: Σ min(achieved, target) / Σ target  — larger shares weigh more, over-achievement in one
 * circle cannot hide shortfall in another. Heads are then averaged equally, so money and case
 * counts never mix. Only VERIFIED achievement counts. No targets → null (not 0, not 100).
 */
router.get(
  '/assigned/summary',
  validate({ query: z.object({ unitId: objectId, post: z.string().max(40), fy: z.string().optional() }) }),
  async (req, res) => {
    const bp = bpOf(req);
    const { unitId, post, fy } = q<{ unitId: string; post: string; fy?: string }>(req);
    if (!bp.post.has(post)) throw badRequest('Unknown post');
    const unit = await assertCanRead(req.user!, unitId);
    const filter: Record<string, unknown> = { anc: unit._id, status: { $in: ['active', 'stopped'] }, startDate: { $lte: new Date() } };
    if (fy && bp.fy.valid(fy)) filter.startDate = { $gte: bp.fy.start(fy), $lt: bp.fy.end(fy), $lte: new Date() };
    const targets = await AssignedTarget.find(filter).select('anc head targetValue achieved startDate endDate status stoppedAt').lean();
    const subtree = await Unit.find({ anc: unit._id }).select('_id').lean();
    const charges = await Charge.find({ post, unitId: { $in: subtree.map((u) => u._id) }, ...activeFilter() }).lean();
    const users = new Map((await User.find({ _id: { $in: charges.map((c) => c.userId) } }).select('name designation').lean()).map((u) => [String(u._id), u]));
    const now = new Date();
    const items = charges
      .map((c) => {
        const mine = targets.filter((t) => t.anc.some((a) => String(a) === String(c.unitId)));
        if (!mine.length) return null;
        const byHead = new Map<string, { cap: number; tgt: number }>();
        let met = 0, running = 0, missed = 0;
        for (const t of mine) {
          const v = byHead.get(t.head) ?? { cap: 0, tgt: 0 };
          const due = effectiveTarget(t as any);
          v.cap += Math.min(t.achieved, due);
          v.tgt += due;
          byHead.set(t.head, v);
          const s = describe(t as any, now).state;
          if (s === 'achieved' || (s === 'stopped' && t.achieved >= effectiveTarget(t as any))) met++; else if (s === 'missed' || s === 'stopped') missed++; else running++;
        }
        const pcts = [...byHead.values()].map((v) => (v.cap / v.tgt) * 100);
        return {
          user: users.get(String(c.userId)), unitId: String(c.unitId), targets: mine.length, met, running, missed, heads: byHead.size,
          pct: Math.round((pcts.reduce((s, p) => s + p, 0) / pcts.length) * 10) / 10,
        };
      })
      .filter((x): x is NonNullable<typeof x> => !!x && !!x.user)
      .sort((a, b) => b.pct - a.pct || b.met - a.met)
      .map((x, i) => ({ ...x, rank: i + 1 }));
    res.json({ unit: { _id: unit._id, name: unit.name, type: unit.type }, post, postLabel: bp.postLabel(post), items });
  },
);

export default router;

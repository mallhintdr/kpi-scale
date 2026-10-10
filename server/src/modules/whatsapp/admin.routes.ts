/**
 * WhatsApp coaching administration (organisation owner / admin): schedule, language, escalation,
 * previews, test messages, the outbox / inbox log and the escalation list.
 */
import { Router } from 'express';
import { z } from 'zod';
import { badRequest, notFound } from '../../lib/errors.js';
import { audit } from '../../lib/notify.js';
import { requireRole } from '../../middleware/auth.js';
import { objectId, q, validate } from '../../middleware/validate.js';
import { Tenant, User, WaMessage, WaState } from '../../models/index.js';
import { notify } from '../../lib/notify.js';
import { localNow, withdrawalNotice, type Lang } from './coach.js';
import { queueMessage, recipients, runSlot } from './engine.js';
import { handleInbound } from './webhook.routes.js';
import { normalizePhone } from './phone.js';
import { whatsappMode } from './providers.js';

const router = Router();
router.use(requireRole('admin'));
const hm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM');

router.get('/whatsapp', async (req, res) => {
  const t = await Tenant.findById(req.user!.tenantId).select('whatsapp settings').lean();
  const { day } = localNow(t?.settings?.timezone ?? 'Asia/Karachi');
  const [people, withPhone, today, escalations] = await Promise.all([
    recipients(req.user!.tenantId, (t?.whatsapp as any)?.audience ?? 'scored').then((r) => r.length),
    User.countDocuments({ status: 'active', phoneE164: { $exists: true, $ne: null } }),
    WaMessage.aggregate([{ $match: { day } }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
    WaState.countDocuments({ level: { $gte: 2 } }),
  ]);
  res.json({
    mode: whatsappMode(),
    settings: t?.whatsapp,
    timezone: t?.settings?.timezone,
    stats: { recipients: people, withPhone, today: Object.fromEntries(today.map((x) => [x._id, x.n])), underReview: escalations },
  });
});

router.put(
  '/whatsapp',
  validate({
    body: z.object({
      enabled: z.boolean(),
      language: z.enum(['english', 'urdu', 'bilingual']),
      morningAt: hm,
      followupsAt: z.array(hm).max(4),
      eveningAt: hm,
      workdays: z.array(z.number().int().min(0).max(6)).min(1),
      holidays: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).max(100).default([]),
      audience: z.enum(['scored', 'all']),
      allowOptOut: z.boolean(),
      escalation: z.object({ enabled: z.boolean(), paceGap: z.number().min(0).max(100), overdueTasks: z.number().int().min(1).max(50), days: z.number().int().min(1).max(30), notifySupervisor: z.boolean() }),
    }),
  }),
  async (req, res) => {
    const b = req.body;
    if (b.morningAt >= b.eveningAt) throw badRequest('The evening summary must be later than the morning message');
    const t = await Tenant.findByIdAndUpdate(req.user!.tenantId, { $set: { whatsapp: b } }, { new: true }).select('whatsapp').lean();
    await audit('whatsapp.settings', 'Tenant', req.user!.tenantId, { enabled: b.enabled });
    res.json(t?.whatsapp);
  },
);

/* Preview what one person would receive now (nothing is sent or recorded) */
router.get('/whatsapp/preview', validate({ query: z.object({ userId: objectId, slot: z.enum(['morning', 'followup', 'evening']) }) }), async (req, res) => {
  const { userId, slot } = q<{ userId: string; slot: 'morning' | 'followup' | 'evening' }>(req);
  const t = await Tenant.findById(req.user!.tenantId).select('settings').lean();
  const r = await runSlot(req.user!.tenantId, slot, localNow(t?.settings?.timezone ?? 'Asia/Karachi').day, { onlyUserId: userId, dryRun: true });
  if (!r.preview.length) throw notFound('That person does not receive messages (no phone number, opted out, or no scored posting)');
  res.json({ text: r.preview[0].text });
});

/* Send a slot now — to one person (test) or everyone */
router.post('/whatsapp/send', validate({ body: z.object({ slot: z.enum(['morning', 'followup', 'evening']), userId: objectId.optional(), day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }) }), async (req, res) => {
  const t = await Tenant.findById(req.user!.tenantId).select('settings').lean();
  // day: which working day the escalation ladder counts this run as (defaults to today)
  const day = req.body.day ?? localNow(t?.settings?.timezone ?? 'Asia/Karachi').day;
  const r = await runSlot(req.user!.tenantId, req.body.slot, day, { onlyUserId: req.body.userId });
  await audit('whatsapp.send', 'Tenant', req.user!.tenantId, { slot: req.body.slot, userId: req.body.userId, queued: r.queued });
  res.json({ queued: r.queued });
});

/* A free-form test message to any number */
router.post('/whatsapp/test', validate({ body: z.object({ phone: z.string().max(30), text: z.string().trim().min(1).max(1000) }) }), async (req, res) => {
  const phone = normalizePhone(req.body.phone);
  if (!phone) throw badRequest('Invalid phone number');
  const m = await queueMessage(req.user!.tenantId, { phone, kind: 'test', text: req.body.text });
  res.json({ queued: true, id: m._id, phone });
});

/* Simulate an employee replying (mock mode / training) */
router.post('/whatsapp/simulate', validate({ body: z.object({ userId: objectId, text: z.string().trim().min(1).max(500) }) }), async (req, res) => {
  const u = await User.findById(req.body.userId).select('phoneE164').lean();
  if (!u?.phoneE164) throw badRequest('That person has no phone number');
  const ok = await handleInbound({ waMessageId: `sim_${Date.now()}`, phone: u.phoneE164, text: req.body.text });
  res.json({ handled: ok });
});

/* Message log */
router.get('/whatsapp/messages', validate({ query: z.object({ userId: objectId.optional(), kind: z.string().max(20).optional(), status: z.string().max(20).optional(), page: z.coerce.number().int().min(1).default(1) }) }), async (req, res) => {
  const { userId, kind, status, page } = q<{ userId?: string; kind?: string; status?: string; page: number }>(req);
  const filter: Record<string, unknown> = {};
  if (userId) filter.userId = userId;
  if (kind) filter.kind = kind;
  if (status) filter.status = status;
  const [items, total] = await Promise.all([
    WaMessage.find(filter).populate('userId', 'name designation').sort({ createdAt: -1 }).skip((page - 1) * 50).limit(50).lean(),
    WaMessage.countDocuments(filter),
  ]);
  res.json({ items, total, page });
});

/* People on the escalation ladder */
router.get('/whatsapp/escalations', async (_req, res) => {
  const rows = await WaState.find({ level: { $gte: 1 } }).populate('userId', 'name designation phone').sort({ level: -1, behindDays: -1 }).limit(300).lean();
  res.json(rows);
});

/** Withdraw a person's warning: back to "on track", recorded in their history, and the person is informed. */
async function withdraw(tenantId: string, userId: string, by: string, why: string, inform: boolean) {
  const st = await WaState.findOne({ userId });
  const had = st && st.level > 0;
  if (st) {
    st.set({ level: 0, behindDays: 0 });
    st.history.push({ day: new Date().toISOString().slice(0, 10), level: 0, reason: `Warning withdrawn by ${by}${why ? `: ${why}` : ''}` });
    await st.save();
  }
  if (had && inform) {
    const [u, t] = await Promise.all([User.findById(userId).select('name phoneE164 whatsappOptOut').lean(), Tenant.findById(tenantId).select('whatsapp').lean()]);
    await notify(userId, { type: 'performance.withdrawn', title: 'Performance notice withdrawn', body: why || 'Withdrawn by the administration', link: '/' });
    if (u?.phoneE164 && !u.whatsappOptOut) await queueMessage(tenantId, { userId, phone: u.phoneE164, kind: 'notice', text: withdrawalNotice(u.name, ((t?.whatsapp as any)?.language ?? 'english') as Lang) });
  }
  return !!had;
}

router.post('/whatsapp/escalations/:userId/reset', validate({ params: z.object({ userId: objectId }), body: z.object({ reason: z.string().trim().max(200).optional(), inform: z.boolean().default(true) }) }), async (req, res) => {
  const withdrawn = await withdraw(req.user!.tenantId, req.params.userId as string, req.user!.name, req.body.reason ?? '', req.body.inform);
  await audit('whatsapp.warning.withdraw', 'User', req.params.userId as string, { reason: req.body.reason });
  res.json({ withdrawn });
});

/* Leave: no messages and no warnings for the period; any current warning is withdrawn */
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
router.get('/whatsapp/leave', async (_req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  res.json(await WaState.find({ leaveUntil: { $gte: today } }).populate('userId', 'name designation').populate('leaveSetBy', 'name').sort({ leaveFrom: 1 }).lean());
});
router.put('/whatsapp/leave/:userId', validate({ params: z.object({ userId: objectId }), body: z.object({ from: day, until: day, note: z.string().trim().max(200).optional() }) }), async (req, res) => {
  const { from, until, note } = req.body;
  if (until < from) throw badRequest('Leave must end on or after it starts');
  if (!(await User.exists({ _id: req.params.userId }))) throw notFound('User');
  await WaState.updateOne({ userId: req.params.userId }, { $set: { leaveFrom: from, leaveUntil: until, leaveNote: note, leaveSetBy: req.user!.id }, $setOnInsert: { userId: req.params.userId } }, { upsert: true });
  await withdraw(req.user!.tenantId, req.params.userId as string, req.user!.name, `on leave ${from} to ${until}${note ? ` (${note})` : ''}`, true);
  await audit('whatsapp.leave.set', 'User', req.params.userId as string, { from, until, note });
  res.json({ ok: true });
});
router.delete('/whatsapp/leave/:userId', validate({ params: z.object({ userId: objectId }) }), async (req, res) => {
  await WaState.updateOne({ userId: req.params.userId }, { $unset: { leaveFrom: 1, leaveUntil: 1, leaveNote: 1, leaveSetBy: 1 } });
  await audit('whatsapp.leave.clear', 'User', req.params.userId as string);
  res.status(204).end();
});

export default router;

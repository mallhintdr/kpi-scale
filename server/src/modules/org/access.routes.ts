/**
 * Access rights administration (organisation owner / admin).
 *
 * Rights come from two places:
 *   - posts: what the organisation setup says each post may do (shown read-only here)
 *   - grants: rights given to one person on a unit and everything below it, optionally only some KPIs
 *     and until a date — set here
 */
import { Router } from 'express';
import { z } from 'zod';
import { invalidate } from '../../lib/cache.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { audit, notify } from '../../lib/notify.js';
import { requireRole } from '../../middleware/auth.js';
import { idParam, objectId, q, validate } from '../../middleware/validate.js';
import { AccessGrant, Charge, GRANT_RIGHTS, Unit, User } from '../../models/index.js';
import { getBlueprint } from './service.js';

const router = Router();
router.use(requireRole('admin'));

export const RIGHT_LABEL: Record<(typeof GRANT_RIGHTS)[number], string> = {
  view: 'View',
  enter: 'Enter figures',
  edit: 'Edit verified figures',
  verify: 'Verify',
  set_targets: 'Set annual targets',
  assign_targets: 'Assign targets',
  compare: 'Compare areas',
  manage_registers: 'Manage registers',
  litigation: 'Litigation entry',
  state_land: 'State land entry',
  state_land_verify: 'State land verification',
  state_land_approve: 'State land approval',
};

/** Drop a person's cached grants on every API instance. */
const refresh = (tenantId: string, userId: string) => invalidate('grants', `${tenantId}:${userId}`);

const body = z.object({
  userId: objectId,
  unitId: objectId,
  rights: z.array(z.enum(GRANT_RIGHTS)).min(1),
  metrics: z.array(z.string().max(40)).max(300).default([]),
  expiresAt: z.coerce.date().nullish(),
  note: z.string().trim().max(300).optional(),
});

async function checkMetrics(tenantId: string, codes: string[]) {
  if (!codes.length) return;
  const bp = await getBlueprint(tenantId);
  const unknown = codes.filter((c) => !bp?.metric.has(c));
  if (unknown.length) throw badRequest(`Unknown KPI: ${unknown.join(', ')}`);
}

/* All grants (optionally one person's or one unit's) */
router.get('/access', validate({ query: z.object({ userId: objectId.optional(), unitId: objectId.optional() }) }), async (req, res) => {
  const { userId, unitId } = q<{ userId?: string; unitId?: string }>(req);
  const filter: Record<string, unknown> = {};
  if (userId) filter.userId = userId;
  if (unitId) filter.anc = unitId;
  const rows = await AccessGrant.find(filter)
    .populate('userId', 'name email designation')
    .populate('unitId', 'name type')
    .populate('grantedBy', 'name')
    .sort({ createdAt: -1 })
    .limit(500)
    .lean();
  const now = new Date();
  res.json(rows.map((g) => ({ ...g, expired: !!g.expiresAt && g.expiresAt <= now })));
});

/* One person's effective rights: from postings (via organisation setup) and direct grants */
router.get('/access/user/:id', validate({ params: idParam }), async (req, res) => {
  const bp = await getBlueprint(req.user!.tenantId);
  const user = await User.findById(req.params.id).select('name email designation role').lean();
  if (!user) throw notFound('User');
  const charges = await Charge.find({ userId: user._id, $or: [{ to: null }, { to: { $gt: new Date() } }] }).populate('unitId', 'name type').lean();
  const fromPosts = charges.map((c) => {
    const post = bp?.post.get(c.post);
    const enters = bp?.metrics.filter((m) => m.enterPosts.includes(c.post) || (m.perHolder && m.holderPosts.includes(c.post))).map((m) => m.name) ?? [];
    const verifies = bp?.metrics.filter((m) => m.verifyPosts.includes(c.post)).map((m) => m.name) ?? [];
    return {
      post: c.post, postLabel: bp?.postLabel(c.post), unit: c.unitId, chargeType: c.chargeType,
      scored: post?.scored ?? true,
      rights: [
        'view',
        ...(enters.length ? ['enter'] : []),
        ...(verifies.length ? ['verify', 'edit'] : []),
        ...(post?.caps ?? []),
      ],
      enters, verifies,
    };
  });
  const grants = await AccessGrant.find({ userId: user._id }).populate('unitId', 'name type').populate('grantedBy', 'name').sort({ createdAt: -1 }).lean();
  res.json({ user, isAdmin: ['owner', 'admin'].includes(user.role), fromPosts, grants });
});

router.post('/access', validate({ body }), async (req, res) => {
  const b = req.body as z.infer<typeof body>;
  const [user, unit] = await Promise.all([User.findById(b.userId).select('name').lean(), Unit.findById(b.unitId).select('anc name').lean()]);
  if (!user) throw notFound('User');
  if (!unit) throw notFound('Unit');
  await checkMetrics(req.user!.tenantId, b.metrics);
  const g = await AccessGrant.create({ ...b, rights: [...new Set(b.rights)], anc: unit.anc, grantedBy: req.user!.id });
  await refresh(req.user!.tenantId, b.userId);
  await audit('access.grant', 'AccessGrant', g._id, { userId: b.userId, unitId: b.unitId, rights: b.rights, metrics: b.metrics });
  await notify(b.userId, { type: 'access.granted', title: 'New access rights', body: `${b.rights.map((r) => RIGHT_LABEL[r]).join(', ')} · ${unit.name}`, link: '/' });
  res.status(201).json(g);
});

router.patch('/access/:id', validate({ params: idParam, body: body.omit({ userId: true }).partial() }), async (req, res) => {
  const g = await AccessGrant.findById(req.params.id);
  if (!g) throw notFound('Grant');
  const b = req.body as Partial<z.infer<typeof body>>;
  if (b.metrics) await checkMetrics(req.user!.tenantId, b.metrics);
  if (b.unitId) {
    const unit = await Unit.findById(b.unitId).select('anc').lean();
    if (!unit) throw notFound('Unit');
    g.set({ unitId: unit._id, anc: unit.anc });
  }
  if (b.rights) g.set('rights', [...new Set(b.rights)]);
  if (b.metrics) g.set('metrics', b.metrics);
  if (b.expiresAt !== undefined) g.set('expiresAt', b.expiresAt);
  if (b.note !== undefined) g.set('note', b.note);
  await g.save();
  await refresh(req.user!.tenantId, String(g.userId));
  await audit('access.update', 'AccessGrant', g._id, { fields: Object.keys(b) });
  res.json(g);
});

router.delete('/access/:id', validate({ params: idParam }), async (req, res) => {
  const g = await AccessGrant.findById(req.params.id);
  if (!g) throw notFound('Grant');
  await g.deleteOne();
  await refresh(req.user!.tenantId, String(g.userId));
  await audit('access.revoke', 'AccessGrant', g._id, { userId: g.userId, rights: g.rights });
  res.status(204).end();
});

export default router;

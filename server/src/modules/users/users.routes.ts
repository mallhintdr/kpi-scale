import { Router } from 'express';
import { z } from 'zod';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { audit, notify } from '../../lib/notify.js';
import { atLeast, requireRole } from '../../middleware/auth.js';
import { idParam, pagination, q, validate } from '../../middleware/validate.js';
import { Charge, ROLES, Session, User } from '../../models/index.js';
import { getBlueprint } from '../org/service.js';
import { activeFilter } from '../revenue/access.js';
import { hashPassword, password } from '../auth/auth.routes.js';

const router = Router();
/** Roles an organisation admin may give; 'superadmin' exists only in the platform tenant. */
const ORG_ROLES = ROLES.filter((r) => r !== 'superadmin') as unknown as ['owner', 'admin', 'manager', 'employee'];
const SAFE = 'name email role status designation employeeCode bps phone lastLoginAt createdAt';
/** Non-owners may only grant roles below their own; owners may grant any org role. */
const canGrant = (me: { role: any }, role: any) => me.role === 'owner' || !atLeast(role, me.role);
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/* Paged list with current postings (admins) */
router.get(
  '/',
  requireRole('admin'),
  validate({ query: pagination.extend({ role: z.enum(ORG_ROLES).optional(), status: z.enum(['active', 'invited', 'disabled']).optional() }) }),
  async (req, res) => {
    const { page, limit, search, role, status } = q<any>(req);
    const filter: Record<string, unknown> = {};
    if (role) filter.role = role;
    if (status) filter.status = status;
    if (search) {
      const rx = new RegExp(escape(search), 'i');
      filter.$or = [{ name: rx }, { email: rx }, { designation: rx }, { employeeCode: rx }];
    }
    const [items, total] = await Promise.all([
      User.find(filter).select(SAFE).sort({ name: 1 }).skip((page - 1) * limit).limit(limit).lean(),
      User.countDocuments(filter),
    ]);
    const bp = await getBlueprint(req.user!.tenantId);
    const charges = await Charge.find({ userId: { $in: items.map((u) => u._id) }, ...activeFilter() }).populate('unitId', 'name type').lean();
    const byUser = new Map<string, { post: string; postLabel: string; unit: string }[]>();
    for (const c of charges) {
      const list = byUser.get(String(c.userId)) ?? [];
      list.push({ post: c.post, postLabel: bp?.postLabel(c.post) ?? c.post, unit: (c.unitId as any)?.name });
      byUser.set(String(c.userId), list);
    }
    res.json({ items: items.map((u) => ({ ...u, charges: byUser.get(String(u._id)) ?? [] })), total, page, limit });
  },
);

router.get('/:id', requireRole('admin'), validate({ params: idParam }), async (req, res) => {
  const user = await User.findById(req.params.id).select(SAFE).lean();
  if (!user) throw notFound('User');
  res.json(user);
});

const userBody = z.object({
  name: z.string().trim().min(2).max(100),
  email: z.string().trim().toLowerCase().email(),
  role: z.enum(ORG_ROLES).default('employee'),
  designation: z.string().trim().max(100).optional(),
  employeeCode: z.string().trim().max(40).optional(),
  bps: z.number().int().min(1).max(22).nullish(),
  phone: z.string().trim().max(30).optional(),
});

router.post('/', requireRole('admin'), validate({ body: userBody.extend({ password }) }), async (req, res) => {
  const { password: pw, ...data } = req.body;
  if (!canGrant(req.user!, data.role)) throw forbidden('You cannot create a user with a role at or above your own');
  const user = await User.create({ ...data, passwordHash: await hashPassword(pw) });
  await audit('user.create', 'User', user._id, { email: user.email, role: user.role });
  await notify(user._id, { type: 'welcome', title: 'Welcome', body: 'Your account is ready.', link: '/' });
  const { passwordHash: _omit, ...safe } = user.toObject();
  res.status(201).json(safe);
});

router.patch(
  '/:id',
  requireRole('admin'),
  validate({ params: idParam, body: userBody.partial().extend({ status: z.enum(['active', 'disabled']).optional(), password: password.optional() }) }),
  async (req, res) => {
    const target = await User.findById(req.params.id);
    if (!target) throw notFound('User');
    const me = req.user!;
    const self = target.id === me.id;
    if (self && (req.body.role || req.body.status === 'disabled')) throw badRequest('You cannot change your own role or disable yourself');
    // Admin and owner accounts can be edited only by an owner (or by themselves for non-role fields).
    if (!self && me.role !== 'owner' && atLeast(target.role as any, 'admin')) throw forbidden('Only an owner can change admins or owners');
    if (req.body.role && !canGrant(me, req.body.role)) throw forbidden('You cannot grant a role at or above your own');
    const { password: pw, ...rest } = req.body;
    const emailChanged = rest.email !== undefined && rest.email !== target.email;
    Object.assign(target, rest);
    if (pw) target.passwordHash = await hashPassword(pw);
    if (pw || emailChanged || rest.status === 'disabled' || rest.role) {
      target.tokenVersion = (target.tokenVersion ?? 0) + 1;
      await Session.deleteMany({ userId: target._id });
    }
    await target.save();
    await audit('user.update', 'User', target._id, { fields: Object.keys(req.body) });
    const { passwordHash: _omit, ...safe } = target.toObject();
    res.json(safe);
  },
);

export default router;

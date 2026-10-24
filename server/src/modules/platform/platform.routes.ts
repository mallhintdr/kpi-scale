/**
 * Platform console — super-admins only.
 * Creates organisations (each fully isolated), sets their plan / status / limits, and creates the
 * organisation's first administrator, who then configures everything inside the organisation.
 */
import { Router, type NextFunction, type Request, type Response } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import { forbidden, notFound } from '../../lib/errors.js';
import { runAsTenant, runUnscoped } from '../../lib/tenantContext.js';
import { idParam, validate } from '../../middleware/validate.js';
import { Blueprint, BlueprintHistory, Charge, RevEntry, Session, Tenant, Unit, User } from '../../models/index.js';
import { hashPassword, password, uniqueSlug } from '../auth/auth.routes.js';
import { saveBlueprint } from '../org/service.js';
import { TEMPLATES } from '../org/templates.js';

const router = Router();

function superOnly(req: Request, _res: Response, next: NextFunction) {
  if (req.user?.role !== 'superadmin' || !req.user.isPlatform) throw forbidden('Platform administrators only');
  next();
}
router.use(superOnly);

const adminBody = z.object({
  name: z.string().trim().min(2).max(100),
  email: z.string().trim().toLowerCase().email(),
  password,
  designation: z.string().trim().max(100).optional(),
});

router.get('/templates', (_req, res) => {
  res.json(Object.entries(TEMPLATES).map(([key, t]) => ({ key, label: t.label, category: t.category, description: t.description, levels: t.blueprint.levels.map((l) => l.label), kpis: t.blueprint.metrics.length })));
});

/* Organisations with headline counts */
router.get('/tenants', async (_req, res) => {
  const out = await runUnscoped(async () => {
    const tenants = await Tenant.find({ isPlatform: { $ne: true } }).sort({ createdAt: -1 }).lean();
    const ids = tenants.map((t) => t._id);
    const count = async (model: any, extra: Record<string, unknown> = {}) =>
      new Map(((await model.aggregate([{ $match: { tenantId: { $in: ids }, ...extra } }, { $group: { _id: '$tenantId', n: { $sum: 1 } } }])) as { _id: Types.ObjectId; n: number }[]).map((r) => [String(r._id), r.n]));
    const [users, units, charges, entries, bps] = await Promise.all([
      count(User, { status: 'active' }),
      count(Unit),
      count(Charge, { to: null }),
      count(RevEntry),
      Blueprint.find({ tenantId: { $in: ids } }).select('tenantId version doc.name doc.metrics.code').lean(),
    ]);
    const bpBy = new Map(bps.map((b) => [String(b.tenantId), b]));
    return tenants.map((t) => {
      const id = String(t._id);
      const b = bpBy.get(id) as any;
      return {
        ...t,
        stats: { users: users.get(id) ?? 0, units: units.get(id) ?? 0, postings: charges.get(id) ?? 0, entries: entries.get(id) ?? 0 },
        blueprint: b ? { version: b.version, name: b.doc?.name, kpis: b.doc?.metrics?.length ?? 0 } : null,
      };
    });
  });
  res.json(out);
});

/* Create an organisation, its blueprint (from a template) and its first administrator */
router.post(
  '/tenants',
  validate({
    body: z.object({
      name: z.string().trim().min(2).max(120),
      slug: z.string().trim().toLowerCase().regex(/^[a-z0-9-]{2,40}$/).optional(),
      industry: z.string().trim().max(60).optional(),
      plan: z.enum(['free', 'pro', 'enterprise']).default('pro'),
      template: z.string().default('blank'),
      contact: z.object({ name: z.string().max(100).optional(), email: z.string().email().optional(), phone: z.string().max(30).optional() }).optional(),
      maxUsers: z.number().int().min(1).max(1_000_000).optional(),
      admin: adminBody,
    }),
  }),
  async (req, res) => {
    const b = req.body;
    const tpl = TEMPLATES[b.template];
    if (!tpl) throw notFound('Template');
    const slug = b.slug ?? (await runUnscoped(() => uniqueSlug(b.name)));
    // Everything that can fail without touching the database happens first
    const passwordHash = await hashPassword(b.admin.password);
    const tenant = await runUnscoped(() =>
      Tenant.create({ name: b.name, slug, industry: b.industry ?? tpl.blueprint.industry, plan: b.plan, contact: b.contact, limits: b.maxUsers ? { maxUsers: b.maxUsers } : undefined }),
    );
    try {
      const admin = await runAsTenant(tenant._id, async () => {
        await saveBlueprint(String(tenant._id), { ...tpl.blueprint, name: b.name }, { userId: req.user!.id, template: b.template, note: `Created from template "${tpl.label}"`, skipUsageCheck: true });
        return User.create({ name: b.admin.name, email: b.admin.email, designation: b.admin.designation ?? 'Administrator', passwordHash, role: 'owner' });
      });
      res.status(201).json({ tenant, admin: { _id: admin._id, name: admin.name, email: admin.email, role: admin.role } });
    } catch (err) {
      // nothing half-created: the blueprint, its history and any user go with the organisation
      await runUnscoped(() =>
        Promise.allSettled([
          Blueprint.deleteMany({ tenantId: tenant._id }),
          BlueprintHistory.deleteMany({ tenantId: tenant._id }),
          User.deleteMany({ tenantId: tenant._id }),
        ]),
      );
      await runUnscoped(() => Tenant.deleteOne({ _id: tenant._id }));
      throw err;
    }
  },
);

router.patch(
  '/tenants/:id',
  validate({
    params: idParam,
    body: z.object({
      name: z.string().trim().min(2).max(120).optional(),
      status: z.enum(['active', 'suspended']).optional(),
      plan: z.enum(['free', 'pro', 'enterprise']).optional(),
      industry: z.string().trim().max(60).optional(),
      maxUsers: z.number().int().min(1).max(1_000_000).optional(),
      maxUnits: z.number().int().min(1).max(10_000_000).optional(),
    }),
  }),
  async (req, res) => {
    const { maxUsers, maxUnits, ...rest } = req.body;
    const set: Record<string, unknown> = { ...rest };
    if (maxUsers) set['limits.maxUsers'] = maxUsers;
    if (maxUnits) set['limits.maxUnits'] = maxUnits;
    const t = await runUnscoped(() => Tenant.findOneAndUpdate({ _id: req.params.id, isPlatform: { $ne: true } }, { $set: set }, { new: true }).lean());
    if (!t) throw notFound('Organisation');
    // Suspending signs everyone out
    if (rest.status === 'suspended') await runUnscoped(() => Session.deleteMany({ tenantId: t._id }));
    res.json(t);
  },
);

/* Administrators of an organisation; add another (e.g. if the first one left) */
router.get('/tenants/:id/admins', validate({ params: idParam }), async (req, res) => {
  const admins = await runAsTenant(req.params.id as string, () => User.find({ role: { $in: ['owner', 'admin'] } }).select('name email role status lastLoginAt').lean());
  res.json(admins);
});

router.post('/tenants/:id/admins', validate({ params: idParam, body: adminBody }), async (req, res) => {
  const tenant = await runUnscoped(() => Tenant.findOne({ _id: req.params.id, isPlatform: { $ne: true } }).lean());
  if (!tenant) throw notFound('Organisation');
  const b = req.body;
  const user = await runAsTenant(tenant._id, async () =>
    User.create({ name: b.name, email: b.email, designation: b.designation ?? 'Administrator', passwordHash: await hashPassword(b.password), role: 'owner' }),
  );
  res.status(201).json({ _id: user._id, name: user.name, email: user.email, role: user.role });
});

export default router;

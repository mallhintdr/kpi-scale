import { Router, type Request, type Response } from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { badRequest, conflict, unauthorized } from '../../lib/errors.js';
import { runAsTenant, runUnscoped } from '../../lib/tenantContext.js';
import { authenticate } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { Session, Tenant, User } from '../../models/index.js';
import { hashToken, newRefreshToken, signAccessToken } from './tokens.js';

const router = Router();
const COOKIE = 'kpi_rt';

const authLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false });

export const password = z
  .string()
  .min(8, 'At least 8 characters')
  .max(128)
  .regex(/[A-Za-z]/, 'Must contain a letter')
  .regex(/\d/, 'Must contain a number');

export const hashPassword = (p: string) => bcrypt.hash(p, 12);

const slugify = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'org';

async function uniqueSlug(name: string) {
  const base = slugify(name);
  for (let i = 0; i < 20; i++) {
    const slug = i === 0 ? base : `${base}-${Math.random().toString(36).slice(2, 6)}`;
    if (!(await Tenant.exists({ slug }))) return slug;
  }
  throw conflict('Could not allocate organisation id');
}

const publicUser = (u: any) => ({
  id: String(u._id),
  name: u.name,
  email: u.email,
  role: u.role,
  designation: u.designation,
  bps: u.bps ?? null,
});
const publicTenant = (t: any) => ({ id: String(t._id), name: t.name, slug: t.slug, settings: t.settings });

const SHORT_SESSION_MS = 12 * 3_600_000;

/**
 * remember=true: persistent cookie, sliding REFRESH_TOKEN_DAYS expiry.
 * remember=false: browser-session cookie with a fixed 12h ceiling that refreshes never extend.
 */
async function issueSession(req: Request, res: Response, user: any, tenant: any, opts: { remember?: boolean; expiresAt?: Date } = {}) {
  const remember = opts.remember ?? true;
  const refresh = newRefreshToken();
  const expiresAt =
    opts.expiresAt ?? new Date(Date.now() + (remember ? env.REFRESH_TOKEN_DAYS * 86_400_000 : SHORT_SESSION_MS));
  await Session.create({
    userId: user._id,
    tenantId: tenant._id,
    tokenHash: hashToken(refresh),
    userAgent: req.get('user-agent')?.slice(0, 300),
    ip: req.ip,
    remember,
    expiresAt,
  });
  res.cookie(COOKIE, refresh, {
    httpOnly: true,
    secure: env.isProd,
    sameSite: 'strict',
    path: '/api/auth',
    ...(remember ? { maxAge: env.REFRESH_TOKEN_DAYS * 86_400_000 } : {}), // no maxAge = cleared when browser closes
  });
  const accessToken = signAccessToken({ sub: String(user._id), tid: String(tenant._id), role: user.role, tv: user.tokenVersion ?? 0 });
  return { accessToken, user: publicUser(user), tenant: publicTenant(tenant) };
}

/* Create a new organisation with its owner account */
router.post(
  '/register-org',
  authLimiter,
  validate({
    body: z.object({
      orgName: z.string().trim().min(2).max(120),
      name: z.string().trim().min(2).max(100),
      email: z.string().trim().toLowerCase().email(),
      password,
    }),
  }),
  async (req, res) => {
    const { orgName, name, email, password: pw } = req.body;
    const tenant = await Tenant.create({ name: orgName, slug: await uniqueSlug(orgName) });
    const user = await runAsTenant(tenant._id, async () =>
      User.create({ name, email, passwordHash: await hashPassword(pw), role: 'owner' }),
    );
    res.status(201).json(await issueSession(req, res, user, tenant));
  },
);

/* Login. If the email exists in several organisations, the client must pick one. */
router.post(
  '/login',
  authLimiter,
  validate({
    body: z.object({
      email: z.string().trim().toLowerCase().email(),
      password: z.string().min(1).max(128),
      tenantSlug: z.string().trim().toLowerCase().optional(),
      remember: z.boolean().default(true),
    }),
  }),
  async (req, res) => {
    const { email, password: pw, tenantSlug, remember } = req.body;
    const invalid = () => unauthorized('Invalid email or password');

    const candidates = await runUnscoped(() =>
      User.find({ email, status: 'active' }).select('+passwordHash').limit(20).populate('tenantId', 'name slug status settings'),
    );
    const matches = [];
    for (const u of candidates) {
      const t = u.tenantId as any;
      if (t?.status !== 'active') continue;
      if (tenantSlug && t.slug !== tenantSlug) continue;
      if (await bcrypt.compare(pw, u.passwordHash)) matches.push(u);
    }
    if (!matches.length) {
      if (!candidates.length) await bcrypt.compare(pw, '$2b$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinva'); // timing equaliser
      throw invalid();
    }
    if (matches.length > 1) {
      return res.status(300).json({
        error: { code: 'CHOOSE_ORG', message: 'Choose an organisation' },
        organisations: matches.map((m) => ({ slug: (m.tenantId as any).slug, name: (m.tenantId as any).name })),
      });
    }
    const user = matches[0];
    const tenant = user.tenantId as any;
    await runUnscoped(() => User.updateOne({ _id: user._id }, { lastLoginAt: new Date() }));
    res.json(await issueSession(req, res, user, tenant, { remember }));
  },
);

/* Rotate refresh token and issue a new access token */
router.post('/refresh', async (req, res) => {
  const token = req.cookies?.[COOKIE];
  if (!token) throw unauthorized();
  const session = await Session.findOneAndDelete({ tokenHash: hashToken(token) });
  if (!session || session.expiresAt < new Date()) {
    res.clearCookie(COOKIE, { path: '/api/auth' });
    throw unauthorized('Session expired');
  }
  const [user, tenant] = await runUnscoped(() =>
    Promise.all([User.findOne({ _id: session.userId, tenantId: session.tenantId }), Tenant.findById(session.tenantId)]),
  );
  if (!user || user.status !== 'active' || !tenant || tenant.status !== 'active') throw unauthorized();
  const remember = session.remember !== false;
  // Short sessions keep their original ceiling; remembered sessions slide forward.
  res.json(await issueSession(req, res, user, tenant, { remember, expiresAt: remember ? undefined : session.expiresAt }));
});

router.post('/logout', async (req, res) => {
  const token = req.cookies?.[COOKIE];
  if (token) await Session.deleteOne({ tokenHash: hashToken(token) });
  res.clearCookie(COOKIE, { path: '/api/auth' });
  res.status(204).end();
});

router.get('/me', authenticate, async (req, res) => {
  const [user, tenant] = await Promise.all([User.findById(req.user!.id).lean(), Tenant.findById(req.user!.tenantId).lean()]);
  res.json({ user: publicUser(user), tenant: publicTenant(tenant) });
});

router.post(
  '/change-password',
  authenticate,
  validate({ body: z.object({ currentPassword: z.string().min(1), newPassword: password }) }),
  async (req, res) => {
    const user = await User.findById(req.user!.id).select('+passwordHash');
    if (!user || !(await bcrypt.compare(req.body.currentPassword, user.passwordHash))) {
      throw badRequest('Current password is incorrect');
    }
    user.passwordHash = await hashPassword(req.body.newPassword);
    user.tokenVersion = (user.tokenVersion ?? 0) + 1; // revoke other access tokens
    await user.save();
    await Session.deleteMany({ userId: user._id });
    const tenant = await Tenant.findById(req.user!.tenantId);
    res.json(await issueSession(req, res, user, tenant));
  },
);

export default router;

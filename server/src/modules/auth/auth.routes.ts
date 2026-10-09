import { Router, type Request, type Response } from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { RedisStore } from 'rate-limit-redis';
import { env } from '../../config/env.js';
import { redis } from '../../lib/redis.js';
import { badRequest, conflict, unauthorized } from '../../lib/errors.js';
import { runUnscoped } from '../../lib/tenantContext.js';
import { authenticate } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { Session, Tenant, User } from '../../models/index.js';
import { hashToken, newRefreshToken, signAccessToken } from './tokens.js';

const router = Router();
const COOKIE = 'kpi_rt';

// Many officers share one office IP: guard each account tightly, and each IP only loosely.
const limiterStore = (prefix: string) => {
  const r = redis();
  return r ? new RedisStore({ prefix, sendCommand: (...args: string[]) => r.call(args[0], ...args.slice(1)) as any }) : undefined;
};
const perAccount = rateLimit({
  windowMs: 15 * 60_000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false, store: limiterStore('rl:login:acct:'),
  keyGenerator: (req) => `${String(req.body?.email ?? '').toLowerCase()}|${req.ip}`,
  skipSuccessfulRequests: true, // only failed attempts count
  message: { error: { code: 'TOO_MANY_ATTEMPTS', message: 'Too many failed attempts for this account. Try again in 15 minutes.' } },
});
const perIp = rateLimit({
  windowMs: 15 * 60_000, limit: 500, standardHeaders: 'draft-8', legacyHeaders: false, store: limiterStore('rl:login:ip:'),
  message: { error: { code: 'TOO_MANY_REQUESTS', message: 'Too many sign-in attempts from this network. Try again shortly.' } },
});
const authLimiter = [perIp, perAccount];

export const password = z
  .string()
  .min(8, 'At least 8 characters')
  .max(128)
  .regex(/[A-Za-z]/, 'Must contain a letter')
  .regex(/\d/, 'Must contain a number');

export const hashPassword = (p: string) => bcrypt.hash(p, 12);

const slugify = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'org';

export async function uniqueSlug(name: string) {
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
const publicTenant = (t: any) => ({ id: String(t._id), name: t.name, slug: t.slug, settings: t.settings, isPlatform: !!t.isPlatform, industry: t.industry, branding: t.branding ?? {} });

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

// Organisations are created only by the platform super-admin (see modules/platform).

/* Public branding for an organisation's sign-in page (/login?org=slug) */
router.get('/branding/:slug', async (req, res) => {
  const t = await runUnscoped(() => Tenant.findOne({ slug: String(req.params.slug).toLowerCase(), status: 'active', isPlatform: { $ne: true } }).select('name slug branding').lean());
  if (!t) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Organisation not found' } });
  res.set('Cache-Control', 'public, max-age=300').json({ name: t.name, slug: t.slug, branding: t.branding ?? {} });
});

/* Login. If the email exists in several organisations, the client must pick one. */
router.post(
  '/login',
  ...authLimiter,
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
      User.find({ email, status: 'active' }).select('+passwordHash').limit(20).populate('tenantId', 'name slug status settings isPlatform industry branding'),
    );
    let matches = [];
    for (const u of candidates) {
      const t = u.tenantId as any;
      if (t?.status !== 'active') continue;
      if (await bcrypt.compare(pw, u.passwordHash)) matches.push(u);
    }
    // The organisation from the sign-in link is a preference, not a filter: a super-admin, or someone
    // whose browser remembers another organisation, can still sign in to the account the password matches.
    if (tenantSlug) {
      const preferred = matches.filter((u) => (u.tenantId as any).slug === tenantSlug);
      if (preferred.length) matches = preferred;
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

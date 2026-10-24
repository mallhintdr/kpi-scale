import { Router, type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import { logger } from '../../lib/logger.js';
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
const loginEmail = (req: Request) => String(req.body?.email ?? '').trim().toLowerCase();
const perAccount = rateLimit({
  windowMs: 15 * 60_000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false, store: limiterStore('rl:login:acct:'),
  keyGenerator: (req) => `${loginEmail(req)}|${req.ip}`,
  skipSuccessfulRequests: true, // only failed attempts count
  message: { error: { code: 'TOO_MANY_ATTEMPTS', message: 'Too many failed attempts for this account. Try again in 15 minutes.' } },
});
const perIp = rateLimit({
  windowMs: 15 * 60_000, limit: 500, standardHeaders: 'draft-8', legacyHeaders: false, store: limiterStore('rl:login:ip:'),
  message: { error: { code: 'TOO_MANY_REQUESTS', message: 'Too many sign-in attempts from this network. Try again shortly.' } },
});
// Distributed guessing against one account from many IPs: cap failures per email regardless of IP.
const perEmail = rateLimit({
  windowMs: 15 * 60_000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false, store: limiterStore('rl:login:email:'),
  keyGenerator: (req) => loginEmail(req),
  skipSuccessfulRequests: true,
  message: { error: { code: 'TOO_MANY_ATTEMPTS', message: 'Too many failed attempts for this account. Try again in 15 minutes.' } },
});
const authLimiter = [perIp, perAccount, perEmail];
const DUMMY_HASH = bcrypt.hashSync('timing-equaliser-not-a-password', 12);
/** Fixed number of bcrypt compares per login, so response time reveals neither existence nor account count. */
const LOGIN_COMPARES = 3;

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
const REUSE_GRACE_MS = 30_000;

/**
 * remember=true: persistent cookie, sliding REFRESH_TOKEN_DAYS expiry.
 * remember=false: browser-session cookie with a fixed 12h ceiling that refreshes never extend.
 */
async function issueSession(req: Request, res: Response, user: any, tenant: any, opts: { remember?: boolean; expiresAt?: Date; familyId?: string; readOnly?: boolean } = {}) {
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
    familyId: opts.familyId ?? randomUUID(),
    readOnly: !!opts.readOnly,
  });
  res.cookie(COOKIE, refresh, {
    httpOnly: true,
    secure: env.cookieSecure,
    sameSite: 'strict',
    path: '/api/auth',
    ...(remember ? { maxAge: env.REFRESH_TOKEN_DAYS * 86_400_000 } : {}), // no maxAge = cleared when browser closes
  });
  const accessToken = signAccessToken({ sub: String(user._id), tid: String(tenant._id), role: user.role, tv: user.tokenVersion ?? 0, ...(opts.readOnly ? { ro: true } : {}) });
  return { accessToken, user: { ...publicUser(user), readOnly: !!opts.readOnly }, tenant: publicTenant(tenant) };
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
    let compared = 0;
    for (const u of candidates) {
      const t = u.tenantId as any;
      if (t?.status !== 'active') continue;
      if (env.SINGLE_TENANT && t.slug !== env.DEFAULT_TENANT) continue; // only the one organisation
      compared++;
      if (await bcrypt.compare(pw, u.passwordHash)) matches.push(u);
    }
    for (; compared < LOGIN_COMPARES; compared++) await bcrypt.compare(pw, DUMMY_HASH); // timing equaliser
    // The organisation from the sign-in link is a preference, not a filter: a super-admin, or someone
    // whose browser remembers another organisation, can still sign in to the account the password matches.
    if (tenantSlug) {
      const preferred = matches.filter((u) => (u.tenantId as any).slug === tenantSlug);
      if (preferred.length) matches = preferred;
    }
    if (!matches.length) {
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

/* Demo guest: one click signs in as the configured read-only account (browser-session only). */
router.post('/guest', perIp, async (req, res) => {
  if (!env.GUEST_EMAIL) throw unauthorized('Guest access is not enabled');
  const candidates = await runUnscoped(() => User.find({ email: env.GUEST_EMAIL, status: 'active' }).populate('tenantId', 'name slug status settings isPlatform industry branding'));
  const user = candidates.find((u) => (u.tenantId as any)?.status === 'active' && (u.tenantId as any).slug === env.DEFAULT_TENANT);
  if (!user) throw unauthorized('Guest account not found');
  res.json({ ...(await issueSession(req, res, user, user.tenantId, { remember: false })), guest: true });
});

/* Rotate refresh token and issue a new access token */
router.post('/refresh', async (req, res) => {
  const token = req.cookies?.[COOKIE];
  if (!token) throw unauthorized();
  const tokenHash = hashToken(token);
  // Claim the token atomically; the row is kept as a tombstone so a replayed token can be detected.
  const session = await Session.findOneAndUpdate({ tokenHash, rotatedAt: null }, { $set: { rotatedAt: new Date() } });
  if (!session) {
    const used = await Session.findOne({ tokenHash }).select('familyId userId rotatedAt').lean();
    // Reuse of an already-rotated token (outside a short grace for parallel tabs) means it was stolen: revoke the whole sign-in.
    if (used?.rotatedAt && Date.now() - used.rotatedAt.getTime() > REUSE_GRACE_MS) {
      await Session.deleteMany(used.familyId ? { familyId: used.familyId } : { userId: used.userId });
      logger.warn({ userId: String(used.userId) }, 'refresh token reuse detected; sessions revoked');
    }
    res.clearCookie(COOKIE, { path: '/api/auth' });
    throw unauthorized('Session expired');
  }
  if (session.expiresAt < new Date()) {
    res.clearCookie(COOKIE, { path: '/api/auth' });
    throw unauthorized('Session expired');
  }
  const [user, tenant] = await runUnscoped(() =>
    Promise.all([User.findOne({ _id: session.userId, tenantId: session.tenantId }), Tenant.findById(session.tenantId)]),
  );
  if (!user || user.status !== 'active' || !tenant || tenant.status !== 'active') throw unauthorized();
  const remember = session.remember !== false;
  // Short sessions keep their original ceiling; remembered sessions slide forward.
  res.json(await issueSession(req, res, user, tenant, { remember, expiresAt: remember ? undefined : session.expiresAt, familyId: session.familyId ?? undefined, readOnly: !!session.readOnly }));
});

router.post('/logout', async (req, res) => {
  const token = req.cookies?.[COOKIE];
  if (token) {
    const s = await Session.findOneAndDelete({ tokenHash: hashToken(token) }).lean();
    if (s?.familyId) await Session.deleteMany({ familyId: s.familyId });
  }
  res.clearCookie(COOKIE, { path: '/api/auth' });
  res.status(204).end();
});

router.get('/me', authenticate, async (req, res) => {
  const [user, tenant] = await Promise.all([User.findById(req.user!.id).lean(), Tenant.findById(req.user!.tenantId).lean()]);
  res.json({ user: { ...publicUser(user), readOnly: !!req.user!.readOnly }, tenant: publicTenant(tenant) });
});

/* Guest demo: is it available, and for which organisation? */
router.get('/demo', async (_req, res) => {
  if (!env.demoEnabled) return res.json({ enabled: false });
  const t = await runUnscoped(() => Tenant.findOne({ slug: env.DEMO_TENANT_SLUG!.toLowerCase(), status: 'active', isPlatform: { $ne: true } }).select('name').lean());
  res.json(t ? { enabled: true, organisation: t.name } : { enabled: false });
});

/* Guest demo: a short, read-only session on the configured demo account. No password involved. */
router.post('/demo', perIp, async (req, res) => {
  if (!env.demoEnabled) throw unauthorized('The demo is not available');
  const tenant = await runUnscoped(() => Tenant.findOne({ slug: env.DEMO_TENANT_SLUG!.toLowerCase(), status: 'active', isPlatform: { $ne: true } }));
  const user = tenant && (await runUnscoped(() => User.findOne({ tenantId: tenant._id, email: env.DEMO_LOGIN_EMAIL!.toLowerCase(), status: 'active' })));
  if (!tenant || !user) throw unauthorized('The demo is not available');
  res.json(await issueSession(req, res, user, tenant, { remember: false, readOnly: true, expiresAt: new Date(Date.now() + 2 * 3_600_000) }));
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

/**
 * Who can see, enter, verify and set targets. Two sources, combined:
 *   1. posts — the blueprint says what each post may do (capabilities, each KPI's enter/verify posts)
 *   2. access grants — rights an admin gives a person directly on a unit and everything below it,
 *      optionally only for some KPIs and until a date
 * No post names here.
 */
import { Types } from 'mongoose';
import { cached } from '../../lib/cache.js';
import { forbidden, notFound } from '../../lib/errors.js';
import { atLeast, type AuthUser } from '../../middleware/auth.js';
import { AccessGrant, Charge, Unit, type GrantRight } from '../../models/index.js';
import type { BP, Cap } from '../org/blueprint.js';
import { getBlueprint } from '../org/service.js';

export interface Grant { _id: string; unitId: string; anc: string[]; rights: GrantRight[]; metrics: string[] }

/** A person's live grants (cached briefly; invalidated when an admin changes grants). */
export async function grantsOf(me: AuthUser): Promise<Grant[]> {
  return cached(`grants:${me.tenantId}:${me.id}`, 120, async () => {
    const rows = await AccessGrant.find({ userId: me.id, $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }] }).select('unitId anc rights metrics').lean();
    return rows.map((g) => ({ _id: String(g._id), unitId: String(g.unitId), anc: g.anc.map(String), rights: g.rights as GrantRight[], metrics: g.metrics ?? [] }));
  });
}

/** Does a grant give `right` on this unit (it, or an ancestor, is the granted unit) for this KPI? */
const covers = (g: Grant, right: GrantRight, unit?: { anc: Types.ObjectId[] | string[] }, code?: string) =>
  g.rights.includes(right) && (!unit || unit.anc.some((a) => String(a) === g.unitId)) && (!code || !g.metrics.length || g.metrics.includes(code));

export async function hasGrant(me: AuthUser, right: GrantRight, unit?: { anc: Types.ObjectId[] | string[] }, code?: string) {
  return (await grantsOf(me)).some((g) => covers(g, right, unit, code));
}

export interface MyCharge {
  _id: Types.ObjectId;
  post: string;
  chargeType: string;
  unit: { _id: Types.ObjectId; type: string; name: string; anc: Types.ObjectId[]; parentId?: Types.ObjectId };
}
type UnitLike = { _id: Types.ObjectId; anc: Types.ObjectId[]; type: string };

const activeFilter = () => ({ $or: [{ to: null }, { to: { $gt: new Date() } }] });
const isAdmin = (me: AuthUser) => atLeast(me.role, 'admin');

export async function myCharges(userId: string): Promise<MyCharge[]> {
  const rows = await Charge.find({ userId, ...activeFilter() })
    .populate('unitId', 'type name anc parentId')
    .lean();
  return rows.filter((r) => r.unitId).map((r) => ({ _id: r._id, post: r.post, chargeType: r.chargeType, unit: r.unitId as any }));
}

/** Top-level units of the organisation. */
export const topUnits = (bp: BP) => Unit.find({ type: bp.topLevel }).select('type name').sort({ name: 1 }).lean();

/** Units a user can see the whole subtree of (work jurisdiction). Admins see every top-level unit. */
export async function scopeRoots(me: AuthUser, bp: BP): Promise<Types.ObjectId[]> {
  if (isAdmin(me)) return (await topUnits(bp)).map((u) => u._id);
  const charges = await myCharges(me.id);
  // A post with `widenTo` sees its whole ancestor at that level (e.g. a Naib Tehsildar sees the tehsil).
  const roots = charges.map((c) => {
    const widen = bp.post.get(c.post)?.widenTo;
    const wi = widen ? bp.levelIndex.get(widen) : undefined;
    const ci = bp.levelIndex.get(c.unit.type);
    if (wi != null && ci != null && wi < ci) {
      // anc is root-first and includes self; anc[wi] is the ancestor at the widened level
      const depth = c.unit.anc.length - 1 - (ci - wi);
      if (depth >= 0) return { id: c.unit.anc[depth], anc: c.unit.anc.slice(0, depth + 1).map(String) };
    }
    return { id: c.unit._id, anc: c.unit.anc.map(String) };
  });
  // Units granted to the person directly are part of their jurisdiction too
  for (const g of await grantsOf(me)) roots.push({ id: new Types.ObjectId(g.unitId), anc: g.anc });
  // Drop roots already covered by another root, and duplicates
  const set = new Set(roots.map((r) => String(r.id)));
  const out = new Map<string, Types.ObjectId>();
  for (const r of roots) if (!r.anc.slice(0, -1).some((x) => set.has(x))) out.set(String(r.id), r.id);
  return [...out.values()];
}

export async function loadUnit(unitId: string) {
  const unit = await Unit.findById(unitId).lean();
  if (!unit) throw notFound('Unit');
  return unit;
}

/**
 * Read access. By default every employee may view any unit of their organisation (tenant isolation
 * still applies). When the organisation restricts viewing to jurisdiction, a person sees only their own
 * area, areas they were granted, and the path above them. Writes use assertCanSee / capability checks.
 */
export async function assertCanRead(me: AuthUser, unitId: string) {
  const unit = await loadUnit(unitId);
  if (isAdmin(me)) return unit;
  const bp = await getBlueprint(me.tenantId);
  if (!bp || bp.raw.access?.viewScope !== 'jurisdiction') return unit;
  const roots = (await scopeRoots(me, bp)).map(String);
  // Inside one of my areas, or an ancestor of one of them (to see where I stand)
  if (unit.anc.some((a) => roots.includes(String(a)))) return unit;
  const mine = await Unit.find({ _id: { $in: roots } }).select('anc').lean();
  if (mine.some((m) => m.anc.some((a) => String(a) === String(unit._id)))) return unit;
  throw forbidden('This area is outside what you are allowed to view');
}

/** Units a person may browse from (whole organisation, or their own areas when viewing is restricted). */
export async function browseRootsFor(me: AuthUser, bp: BP) {
  if (isAdmin(me) || bp.raw.access?.viewScope !== 'jurisdiction') return topUnits(bp);
  return Unit.find({ _id: { $in: await scopeRoots(me, bp) } }).select('type name').sort({ name: 1 }).lean();
}

export async function canSeeUnit(me: AuthUser, unit: { anc: Types.ObjectId[] }, bp: BP) {
  if (isAdmin(me)) return true;
  const roots = (await scopeRoots(me, bp)).map(String);
  return unit.anc.some((a) => roots.includes(String(a)));
}

export async function assertCanSee(me: AuthUser, unitId: string, bp: BP) {
  const unit = await loadUnit(unitId);
  if (!(await canSeeUnit(me, unit, bp))) throw forbidden('This unit is outside your jurisdiction');
  return unit;
}

/** Does the user hold one of `posts` on this unit or any of its ancestors (admins always do)? */
export async function holdsOn(me: AuthUser, posts: string[], unit: { anc: Types.ObjectId[] }) {
  if (isAdmin(me)) return true;
  if (!posts.length) return false;
  return !!(await Charge.exists({ userId: me.id, post: { $in: posts }, unitId: { $in: unit.anc }, ...activeFilter() }));
}

/** Does the user hold a post with this capability anywhere (or on/above `unit`)? */
export async function hasCap(me: AuthUser, bp: BP, cap: Cap, unit?: { anc: Types.ObjectId[] }) {
  if (isAdmin(me)) return true;
  if (await hasGrant(me, cap, unit)) return true;
  const posts = bp.postsWithCap(cap);
  if (!posts.length) return false;
  if (unit) return holdsOn(me, posts, unit);
  return !!(await Charge.exists({ userId: me.id, post: { $in: posts }, ...activeFilter() }));
}

/** Can set annual targets / demand for units under this one. */
export const canSetTargets = (me: AuthUser, bp: BP, unit: { anc: Types.ObjectId[] }) => hasCap(me, bp, 'set_targets', unit);

/** Can verify this KPI's figures on this unit. Verifiers' own entries are official on save. */
export async function canVerify(me: AuthUser, bp: BP, code: string, unit: { anc: Types.ObjectId[] }) {
  const m = bp.metric.get(code);
  if (!m) return false;
  if (await hasGrant(me, 'verify', unit, code)) return true;
  return holdsOn(me, m.verifyPosts, unit);
}
export const autoVerifies = canVerify;

/** May correct figures that are already verified (without being their verifier). */
export async function canEditVerified(me: AuthUser, bp: BP, code: string, unit: { anc: Types.ObjectId[] }) {
  if (isAdmin(me)) return true;
  return (await hasGrant(me, 'edit', unit, code)) || canVerify(me, bp, code, unit);
}

/**
 * Can the user enter figures for this KPI on this unit?
 *  - the unit must be at the KPI's level
 *  - per-holder KPIs: the holder themselves (holding a holder post inside the unit), or an enter post above
 *  - otherwise: an enter post on the unit or any ancestor
 */
export async function canEnter(me: AuthUser, bp: BP, code: string, unit: UnitLike, roUserId?: string | null) {
  const m = bp.metric.get(code);
  if (!m || !m.active || unit.type !== m.level) return false;
  // A direct grant to enter (or edit) this KPI on this area
  if (!m.perHolder && ((await hasGrant(me, 'enter', unit, code)) || (await hasGrant(me, 'edit', unit, code)))) return true;
  if (m.perHolder) {
    if (!roUserId) return false;
    if (roUserId === me.id) {
      const held = await Charge.find({ userId: me.id, post: { $in: m.holderPosts }, ...activeFilter() }).populate('unitId', 'anc').lean();
      if (held.some((h) => (h.unitId as any)?.anc?.some((a: Types.ObjectId) => String(a) === String(unit._id)))) return true;
    }
    return holdsOn(me, m.enterPosts.filter((p) => !m.holderPosts.includes(p)), unit);
  }
  return holdsOn(me, m.enterPosts, unit);
}

/** People holding any of `posts` inside a unit's subtree (the rows of a per-holder KPI). */
export async function holdersIn(bp: BP, unitId: Types.ObjectId | string, posts: string[]) {
  const id = new Types.ObjectId(String(unitId));
  const units = await Unit.find({ anc: id }).select('_id').lean();
  const rows = await Charge.find({ post: { $in: posts }, unitId: { $in: units.map((u) => u._id) }, ...activeFilter() })
    .populate('userId', 'name designation bps')
    .lean();
  const order = (p: string) => bp.posts.findIndex((x) => x.key === p);
  const seen = new Map<string, { _id: Types.ObjectId; name: string; post: string; bps?: number }>();
  for (const r of rows) {
    const u = r.userId as any;
    if (!u) continue;
    const prev = seen.get(String(u._id));
    if (!prev || order(r.post) < order(prev.post)) seen.set(String(u._id), { _id: u._id, name: u.name, post: r.post, bps: u.bps });
  }
  return [...seen.values()].sort((a, b) => order(a.post) - order(b.post) || a.name.localeCompare(b.name));
}

/** The ancestor of `unit` at `level` (or the unit itself), or null if the unit sits above that level. */
export function ancestorAt(bp: BP, unit: { anc: Types.ObjectId[]; type: string }, level: string) {
  const li = bp.levelIndex.get(level);
  const ui = bp.levelIndex.get(unit.type);
  if (li == null || ui == null || li > ui) return null;
  return unit.anc[unit.anc.length - 1 - (ui - li)] ?? null;
}

export { activeFilter };

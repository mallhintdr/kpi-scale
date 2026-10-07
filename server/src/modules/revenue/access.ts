import { Types } from 'mongoose';
import { forbidden, notFound } from '../../lib/errors.js';
import { atLeast, type AuthUser } from '../../middleware/auth.js';
import { Charge, Unit } from '../../models/index.js';
import { HEAD_BY_CODE, type Post } from './catalog.js';

export interface MyCharge {
  _id: Types.ObjectId;
  post: Post;
  chargeType: string;
  unit: { _id: Types.ObjectId; type: string; name: string; anc: Types.ObjectId[]; parentId?: Types.ObjectId };
}

const activeFilter = () => ({ $or: [{ to: null }, { to: { $gt: new Date() } }] });

export async function myCharges(userId: string): Promise<MyCharge[]> {
  const rows = await Charge.find({ userId, ...activeFilter() })
    .populate('unitId', 'type name anc parentId')
    .lean();
  return rows.filter((r) => r.unitId).map((r) => ({ _id: r._id, post: r.post as Post, chargeType: r.chargeType, unit: r.unitId as any }));
}

/** Units a user can see the whole subtree of. Admins see every division. */
export async function scopeRoots(me: AuthUser): Promise<Types.ObjectId[]> {
  if (atLeast(me.role, 'admin')) return (await Unit.find({ type: 'division' }).select('_id').lean()).map((u) => u._id);
  const charges = await myCharges(me.id);
  // Revenue officers (Tehsildar / Naib Tehsildar) see every staff member of their tehsil,
  // so a qanungoi charge widens to its parent tehsil.
  const roots = charges.map((c) => {
    const widen = (c.post === 'naib_tehsildar' || c.post === 'tehsildar') && c.unit.type === 'qanungoi' && c.unit.parentId;
    return widen ? { id: c.unit.parentId as Types.ObjectId, anc: c.unit.anc.slice(0, -1).map(String) } : { id: c.unit._id, anc: c.unit.anc.map(String) };
  });
  // Drop roots already covered by another root (e.g. tehsil + one of its qanungois), and duplicates
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

export async function canSeeUnit(me: AuthUser, unit: { anc: Types.ObjectId[] }) {
  if (atLeast(me.role, 'admin')) return true;
  const roots = (await scopeRoots(me)).map(String);
  return unit.anc.some((a) => roots.includes(String(a)));
}

export async function assertCanSee(me: AuthUser, unitId: string) {
  const unit = await loadUnit(unitId);
  if (!(await canSeeUnit(me, unit))) throw forbidden('This unit is outside your jurisdiction');
  return unit;
}

/** Tehsil id for any unit at or below tehsil level. */
export const tehsilOf = async (unit: { anc: Types.ObjectId[]; type: string; _id: Types.ObjectId }) => {
  if (unit.type === 'tehsil') return unit._id;
  const ancestors = await Unit.find({ _id: { $in: unit.anc }, type: 'tehsil' }).select('_id').lean();
  return ancestors[0]?._id ?? null;
};

/** Is the user Wasil Baqi Navees (or admin) for the tehsil containing this unit? */
export async function isWasilBaqiFor(me: AuthUser, unit: { anc: Types.ObjectId[] }) {
  if (atLeast(me.role, 'admin')) return true;
  return !!(await Charge.exists({ userId: me.id, post: 'wasilbaqi', unitId: { $in: unit.anc }, ...activeFilter() }));
}

/** Is the user the Service Centre In-charge (or admin) for the tehsil containing this unit? */
export async function isSciFor(me: AuthUser, unit: { anc: Types.ObjectId[] }) {
  if (atLeast(me.role, 'admin')) return true;
  return !!(await Charge.exists({ userId: me.id, post: 'sci', unitId: { $in: unit.anc }, ...activeFilter() }));
}

/** Entries by Wasil Baqi or SCI are official on save; others wait for Wasil Baqi's verification. */
export async function autoVerifies(me: AuthUser, headCode: string, unit: { anc: Types.ObjectId[] }) {
  const head = HEAD_BY_CODE.get(headCode);
  if (head?.enteredBy === 'sci') return isSciFor(me, unit);
  return isWasilBaqiFor(me, unit);
}

/**
 * Can the user enter values for this head on this unit?
 *  - sci heads (GPC, inheritance, KMI, missing mutations): only the tehsil's SCI
 *  - patwari heads: the circle's Patwari, or the tehsil's Wasil Baqi
 *  - wasilbaqi heads: the tehsil's Wasil Baqi
 *  - ro heads: the revenue officer themselves (Tehsildar / Naib Tehsildar of that tehsil), or Wasil Baqi
 */
export async function canEnter(me: AuthUser, headCode: string, unit: { _id: Types.ObjectId; anc: Types.ObjectId[]; type: string }, roUserId?: string | null) {
  const head = HEAD_BY_CODE.get(headCode);
  if (!head) return false;
  if (head.enteredBy === 'sci') return unit.type === 'circle' && isSciFor(me, unit);
  if (await isWasilBaqiFor(me, unit)) return true;
  if (head.enteredBy === 'patwari') {
    return unit.type === 'circle' && !!(await Charge.exists({ userId: me.id, post: 'patwari', unitId: unit._id, ...activeFilter() }));
  }
  if (head.enteredBy === 'ro') {
    // RO registers live on the tehsil; the officer must hold a charge inside that tehsil.
    if (roUserId !== me.id || unit.type !== 'tehsil') return false;
    const held = await Charge.find({ userId: me.id, post: { $in: ['tehsildar', 'naib_tehsildar'] }, ...activeFilter() })
      .populate('unitId', 'anc')
      .lean();
    return held.some((h) => (h.unitId as any)?.anc?.some((a: Types.ObjectId) => String(a) === String(unit._id)));
  }
  return false;
}

/** Revenue officers (Tehsildar + Naib Tehsildars) currently posted in a tehsil. */
export async function revenueOfficersOf(tehsilId: Types.ObjectId | string) {
  const qanungois = await Unit.find({ parentId: tehsilId, type: 'qanungoi' }).select('_id').lean();
  const rows = await Charge.find({
    post: { $in: ['tehsildar', 'naib_tehsildar'] },
    unitId: { $in: [new Types.ObjectId(String(tehsilId)), ...qanungois.map((q) => q._id)] },
    ...activeFilter(),
  })
    .populate('userId', 'name designation bps')
    .lean();
  const seen = new Map<string, { _id: Types.ObjectId; name: string; post: string; bps?: number }>();
  for (const r of rows) {
    const u = r.userId as any;
    if (!u) continue;
    if (!seen.has(String(u._id)) || r.post === 'tehsildar') seen.set(String(u._id), { _id: u._id, name: u.name, post: r.post, bps: u.bps });
  }
  return [...seen.values()].sort((a, b) => (a.post === 'tehsildar' ? -1 : b.post === 'tehsildar' ? 1 : a.name.localeCompare(b.name)));
}

export { activeFilter };

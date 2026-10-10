import { Router } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import { badRequest, forbidden } from '../../lib/errors.js';
import { audit, notify } from '../../lib/notify.js';
import { atLeast } from '../../middleware/auth.js';
import { objectId, q, validate } from '../../middleware/validate.js';
import { Charge, RevEntry, RevTarget, Unit } from '../../models/index.js';
import type { BP } from '../org/blueprint.js';
import { bpOf } from '../org/service.js';
import { activeFilter, assertCanSee, autoVerifies, canEditVerified, canEnter, canSetTargets, canVerify, grantsOf, holdersIn } from './access.js';

const router = Router();
const num = z.number().min(0).max(1e12);
const month = z.string().regex(/^\d{4}-\d{2}$/);
const metricOf = (bp: BP, code: string) => {
  const m = bp.metric.get(code);
  if (!m) throw badRequest('Unknown KPI');
  return m;
};

/* ------------------------------------------------------------------ *
 *  Targets / demand — set by posts with the 'set_targets' capability, for the units under them
 * ------------------------------------------------------------------ */

/* Grid of target rows for one KPI under a unit (its units at the KPI's level, or its holders for per-person KPIs) */
router.get('/targets', validate({ query: z.object({ tehsilId: objectId, fy: z.string(), head: z.string() }) }), async (req, res) => {
  const bp = bpOf(req);
  const { tehsilId: unitId, fy, head } = q<{ tehsilId: string; fy: string; head: string }>(req);
  if (!bp.fy.valid(fy)) throw badRequest('Invalid financial year');
  const def = metricOf(bp, head);
  const parent = await assertCanSee(req.user!, unitId, bp);
  const pi = bp.levelIndex.get(parent.type) ?? 0;
  if (pi > (bp.levelIndex.get(def.level) ?? 0)) throw badRequest(`Targets for this KPI are set at ${bp.level.get(def.level)?.label} level or above`);
  const existing = await RevTarget.find({ fy, head, anc: parent._id }).lean();
  const byKey = new Map(existing.map((t) => [`${t.unitId}|${t.roUserId ?? ''}`, t]));

  let rows;
  if (def.perHolder) {
    // Per-person KPIs live on the unit at the KPI's level; one row per holder there
    const base = parent.type === def.level ? parent : null;
    if (!base) throw badRequest(`Open a ${bp.level.get(def.level)?.label} to set these targets`);
    const holders = await holdersIn(bp, base._id, def.holderPosts);
    rows = holders.map((r) => {
      const t = byKey.get(`${base._id}|${r._id}`);
      return { unitId: base._id, roUserId: r._id, label: r.name, sub: bp.postLabel(r.post), target: t?.target ?? 0, arrearDemand: t?.arrearDemand ?? 0, opening: t?.opening ?? 0 };
    });
  } else {
    const units = await Unit.find({ anc: parent._id, type: def.level }).select('name parentId').sort({ name: 1 }).lean();
    const parents = new Map((await Unit.find({ _id: { $in: [...new Set(units.map((u) => String(u.parentId)))] } }).select('name').lean()).map((x) => [String(x._id), x.name]));
    rows = units.map((c) => {
      const t = byKey.get(`${c._id}|`);
      return { unitId: c._id, roUserId: null, label: c.name, sub: parents.get(String(c.parentId)), target: t?.target ?? 0, arrearDemand: t?.arrearDemand ?? 0, opening: t?.opening ?? 0 };
    });
  }
  res.json({ fy, head: def, kind: bp.kindOf(def.code), tehsil: { _id: parent._id, name: parent.name }, canEdit: await canSetTargets(req.user!, bp, parent), rows });
});

router.put(
  '/targets',
  validate({
    body: z.object({
      tehsilId: objectId,
      fy: z.string(),
      head: z.string(),
      rows: z.array(z.object({ unitId: objectId, roUserId: objectId.nullish(), target: num.default(0), arrearDemand: num.default(0), opening: num.default(0) })).max(5000),
    }),
  }),
  async (req, res) => {
    const bp = bpOf(req);
    const { tehsilId: unitId, fy, head, rows } = req.body;
    if (!bp.fy.valid(fy)) throw badRequest('Invalid financial year');
    const def = metricOf(bp, head);
    const parent = await assertCanSee(req.user!, unitId, bp);
    if (!(await canSetTargets(req.user!, bp, parent))) throw forbidden('You cannot set targets here');
    const units = new Map((await Unit.find({ _id: { $in: rows.map((r: any) => r.unitId) }, anc: parent._id, type: def.level }).select('anc').lean()).map((u) => [String(u._id), u]));
    if (units.size !== new Set(rows.map((r: any) => r.unitId)).size) throw badRequest(`Some units are not ${bp.level.get(def.level)?.plural ?? def.level} of ${parent.name}`);
    const tenantId = parent.tenantId;
    await RevTarget.bulkWrite(
      rows.map((r: any) => ({
        updateOne: {
          filter: { tenantId, fy, head, unitId: new Types.ObjectId(r.unitId), roUserId: r.roUserId ? new Types.ObjectId(r.roUserId) : null },
          update: {
            $set: { target: r.target, arrearDemand: r.arrearDemand, opening: r.opening, anc: units.get(r.unitId)!.anc, setBy: new Types.ObjectId(req.user!.id) },
            $setOnInsert: { tenantId },
          },
          upsert: true,
        },
      })),
    );
    await audit('targets.set', 'RevTarget', parent._id, { fy, head, rows: rows.length });
    res.json({ saved: rows.length });
  },
);

/* ------------------------------------------------------------------ *
 *  Monthly entries
 * ------------------------------------------------------------------ */

/* Entry sheet for one unit + month: every KPI the caller may enter, with target and year-to-date */
router.get('/entries', validate({ query: z.object({ unitId: objectId, month, roUserId: objectId.optional() }) }), async (req, res) => {
  const bp = bpOf(req);
  const { unitId, month: mo, roUserId } = q<{ unitId: string; month: string; roUserId?: string }>(req);
  const unit = await assertCanSee(req.user!, unitId, bp);
  const fy = bp.fy.of(new Date(`${mo}-15`));
  const ro = roUserId ?? null;
  const candidates = bp.metrics.filter((m) => m.perHolder === !!ro && m.level === unit.type);
  const allowed = [];
  for (const m of candidates) if (await canEnter(req.user!, bp, m.code, unit, ro)) allowed.push(m);

  const filter = { fy, unitId: unit._id, roUserId: ro ? new Types.ObjectId(ro) : null };
  const [targets, entries, ytd] = await Promise.all([
    RevTarget.find(filter).lean(),
    RevEntry.find({ ...filter, month: mo }).populate('enteredBy', 'name').populate('verifiedBy', 'name').lean(),
    RevEntry.aggregate([
      { $match: { ...filter, tenantId: unit.tenantId, status: { $ne: 'rejected' } } },
      { $group: { _id: '$head', cur: { $sum: '$current' }, arr: { $sum: '$arrear' }, rec: { $sum: '$received' }, disp: { $sum: '$disposed' } } },
    ]),
  ]);
  const auto = new Map<string, boolean>();
  for (const m of allowed) auto.set(m.code, await autoVerifies(req.user!, bp, m.code, unit));
  const tBy = new Map(targets.map((t) => [t.head, t]));
  const eBy = new Map(entries.map((e) => [e.head, e]));
  const yBy = new Map(ytd.map((y) => [y._id, y]));
  res.json({
    fy,
    month: mo,
    months: bp.fy.months(fy),
    unit: { _id: unit._id, name: unit.name, type: unit.type },
    isWasilBaqi: await canSetTargets(req.user!, bp, unit),
    items: allowed.map((m) => ({
      head: { ...m, kind: bp.kindOf(m.code) === 'target' ? 'revenue' : 'case', crop: m.tag },
      autoVerify: auto.get(m.code), target: tBy.get(m.code) ?? null, entry: eBy.get(m.code) ?? null, ytd: yBy.get(m.code) ?? null,
    })),
  });
});

router.put(
  '/entries',
  validate({
    body: z.object({
      unitId: objectId,
      roUserId: objectId.nullish(),
      month,
      items: z.array(z.object({
        head: z.string(),
        current: num.default(0), arrear: num.default(0), received: num.default(0), disposed: num.default(0),
        ref: z.string().trim().max(60).optional(), note: z.string().trim().max(500).optional(),
      })).min(1).max(100),
    }),
  }),
  async (req, res) => {
    const bp = bpOf(req);
    const { unitId, roUserId, month: mo, items } = req.body;
    const unit = await assertCanSee(req.user!, unitId, bp);
    const fy = bp.fy.of(new Date(`${mo}-15`));
    const now = new Date();
    if (mo > `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`) throw badRequest('Cannot enter figures for a future month');
    const ro = roUserId ?? null;

    const saved = [];
    const submittedCodes = new Set<string>();
    for (const it of items) {
      const m = metricOf(bp, it.head);
      if (!(await canEnter(req.user!, bp, it.head, unit, ro))) throw forbidden(`You cannot enter ${m.name} here`);
      const filter = { fy, month: mo, head: it.head, unitId: unit._id, roUserId: ro ? new Types.ObjectId(ro) : null };
      const existing = await RevEntry.findOne(filter);
      const auto = await autoVerifies(req.user!, bp, it.head, unit);
      if (!auto) submittedCodes.add(it.head);
      // Verified figures can be corrected only by a verifier or someone granted "edit" (the change is then re-verified)
      if (existing?.status === 'verified' && !auto && !(await canEditVerified(req.user!, bp, it.head, unit))) throw forbidden(`${m.name} for ${mo} is already verified`);
      const doc = existing ?? new RevEntry({ ...filter, anc: unit.anc });
      Object.assign(doc, {
        current: it.current, arrear: it.arrear, received: it.received, disposed: it.disposed, ref: it.ref, note: it.note,
        enteredBy: req.user!.id,
        // Verifiers' entries are official on save; everyone else's wait for verification.
        status: auto ? 'verified' : 'submitted',
        verifiedBy: auto ? req.user!.id : undefined,
        verifiedAt: auto ? now : undefined,
      });
      saved.push(await doc.save());
    }
    if (submittedCodes.size) {
      const verifyPosts = [...new Set([...submittedCodes].flatMap((c) => bp.metric.get(c)!.verifyPosts))];
      const verifiers = await Charge.find({ post: { $in: verifyPosts }, unitId: { $in: unit.anc }, ...activeFilter() }).distinct('userId');
      await notify(verifiers, { type: 'entry.submitted', title: 'Figures awaiting verification', body: `${unit.name} · ${mo} · ${saved.length} KPI(s)`, link: '/verify' });
    }
    res.json({ saved: saved.length, status: submittedCodes.size ? 'submitted' : 'verified' });
  },
);

/* ------------------------------------------------------------------ *
 *  Verification: each KPI's verify posts, for units on or under where they are posted
 * ------------------------------------------------------------------ */
router.get('/verify', validate({ query: z.object({ tehsilId: objectId.optional() }) }), async (req, res) => {
  const me = req.user!;
  const bp = bpOf(req);
  const { tehsilId } = q<{ tehsilId?: string }>(req);
  const or: Record<string, unknown>[] = [];
  if (tehsilId) {
    const unit = await assertCanSee(me, tehsilId, bp);
    const codes = [];
    for (const m of bp.metrics) if (await canVerify(me, bp, m.code, unit)) codes.push(m.code);
    if (!codes.length) throw forbidden();
    or.push({ anc: unit._id, head: { $in: codes } });
  } else if (atLeast(me.role, 'admin')) {
    or.push({ head: { $in: bp.metrics.map((m) => m.code) } }); // the whole organisation
  } else {
    const mine = await Charge.find({ userId: me.id, ...activeFilter() }).lean();
    for (const c of mine) {
      const codes = bp.metrics.filter((m) => m.verifyPosts.includes(c.post)).map((m) => m.code);
      if (codes.length) or.push({ anc: c.unitId, head: { $in: codes } });
    }
    // Areas where the person was granted the right to verify
    for (const g of await grantsOf(me)) {
      if (!g.rights.includes('verify')) continue;
      const codes = g.metrics.length ? g.metrics : bp.metrics.map((m) => m.code);
      or.push({ anc: new Types.ObjectId(g.unitId), head: { $in: codes } });
    }
  }
  if (!or.length) return res.json([]);
  const items = await RevEntry.find({ status: 'submitted', $or: or })
    .populate('unitId', 'name')
    .populate('enteredBy', 'name designation')
    .populate('roUserId', 'name')
    .sort({ month: -1, createdAt: -1 })
    .limit(500)
    .lean();
  res.json(items.map((e) => ({ ...e, headName: bp.metric.get(e.head)?.name, kind: bp.kindOf(e.head) === 'target' ? 'revenue' : 'case', unit: bp.metric.get(e.head)?.unit })));
});

router.post(
  '/verify',
  validate({ body: z.object({ ids: z.array(objectId).min(1).max(500), action: z.enum(['verify', 'reject']), reason: z.string().max(300).optional() }) }),
  async (req, res) => {
    const bp = bpOf(req);
    const { ids, action, reason } = req.body;
    const entries = await RevEntry.find({ _id: { $in: ids }, status: 'submitted' });
    for (const e of entries) {
      if (!(await canVerify(req.user!, bp, e.head, { anc: e.anc as Types.ObjectId[] }))) throw forbidden('Some entries are outside your verification authority');
    }
    const now = new Date();
    for (const e of entries) {
      e.status = action === 'verify' ? 'verified' : 'rejected';
      e.verifiedBy = new Types.ObjectId(req.user!.id) as any;
      e.verifiedAt = now;
      if (action === 'reject' && reason) e.note = `Rejected: ${reason}`.slice(0, 500);
      await e.save();
    }
    if (action === 'reject') {
      const owners = [...new Set(entries.map((e) => String(e.enteredBy)))];
      await notify(owners, { type: 'entry.rejected', title: 'Figures returned for correction', body: reason ?? 'Please review and resubmit', link: '/entry' });
    }
    res.json({ updated: entries.length });
  },
);

export default router;

import { Router } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import { badRequest, forbidden } from '../../lib/errors.js';
import { audit, notify } from '../../lib/notify.js';
import { objectId, q, validate } from '../../middleware/validate.js';
import { Charge, RevEntry, RevTarget, Unit } from '../../models/index.js';
import { activeFilter, assertCanSee, autoVerifies, canEnter, isWasilBaqiFor, revenueOfficersOf } from './access.js';
import { HEAD_BY_CODE, HEADS, fyMonths, fyOf, isValidFy } from './catalog.js';

const router = Router();
const fySchema = z.string().refine(isValidFy, 'Invalid fiscal year');
const headSchema = z.string().refine((h) => HEAD_BY_CODE.has(h), 'Unknown head');
const num = z.number().min(0).max(1e12);

/* ------------------------------------------------------------------ *
 *  Targets / demand — set by Wasil Baqi Navees per tehsil
 * ------------------------------------------------------------------ */

/* Grid of target rows for one head across a tehsil (circles, or revenue officers for RO registers) */
router.get(
  '/targets',
  validate({ query: z.object({ tehsilId: objectId, fy: fySchema, head: headSchema }) }),
  async (req, res) => {
    const { tehsilId, fy, head } = q<{ tehsilId: string; fy: string; head: string }>(req);
    const tehsil = await assertCanSee(req.user!, tehsilId);
    if (tehsil.type !== 'tehsil') throw badRequest('Targets are set per tehsil');
    const def = HEAD_BY_CODE.get(head)!;
    const existing = await RevTarget.find({ fy, head, anc: tehsil._id }).lean();
    const byKey = new Map(existing.map((t) => [`${t.unitId}|${t.roUserId ?? ''}`, t]));

    let rows;
    if (def.level === 'ro') {
      const ros = await revenueOfficersOf(tehsil._id);
      rows = ros.map((r) => {
        const t = byKey.get(`${tehsil._id}|${r._id}`);
        return { unitId: tehsil._id, roUserId: r._id, label: r.name, sub: r.post === 'tehsildar' ? 'Tehsildar' : 'Naib Tehsildar', target: t?.target ?? 0, arrearDemand: t?.arrearDemand ?? 0, opening: t?.opening ?? 0 };
      });
    } else {
      const circles = await Unit.find({ anc: tehsil._id, type: 'circle' }).select('name parentId').sort({ name: 1 }).lean();
      const qs = new Map((await Unit.find({ parentId: tehsil._id, type: 'qanungoi' }).select('name').lean()).map((x) => [String(x._id), x.name]));
      rows = circles.map((c) => {
        const t = byKey.get(`${c._id}|`);
        return { unitId: c._id, roUserId: null, label: c.name, sub: qs.get(String(c.parentId)), target: t?.target ?? 0, arrearDemand: t?.arrearDemand ?? 0, opening: t?.opening ?? 0 };
      });
    }
    res.json({ fy, head: def, tehsil: { _id: tehsil._id, name: tehsil.name }, canEdit: await isWasilBaqiFor(req.user!, tehsil), rows });
  },
);

router.put(
  '/targets',
  validate({
    body: z.object({
      tehsilId: objectId,
      fy: fySchema,
      head: headSchema,
      rows: z.array(z.object({ unitId: objectId, roUserId: objectId.nullish(), target: num.default(0), arrearDemand: num.default(0), opening: num.default(0) })).max(2000),
    }),
  }),
  async (req, res) => {
    const { tehsilId, fy, head, rows } = req.body;
    const tehsil = await assertCanSee(req.user!, tehsilId);
    if (!(await isWasilBaqiFor(req.user!, tehsil))) throw forbidden('Only the Wasil Baqi Navees of this tehsil can set targets');
    const units = new Map((await Unit.find({ _id: { $in: rows.map((r: any) => r.unitId) }, anc: tehsil._id }).select('anc').lean()).map((u) => [String(u._id), u]));
    if (units.size !== new Set(rows.map((r: any) => r.unitId)).size) throw badRequest('Some units are not in this tehsil');
    const tenantId = tehsil.tenantId;
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
    await audit('targets.set', 'RevTarget', tehsil._id, { fy, head, rows: rows.length });
    res.json({ saved: rows.length });
  },
);

/* ------------------------------------------------------------------ *
 *  Monthly entries
 * ------------------------------------------------------------------ */

/* Entry sheet for one unit + month: every head the caller may enter, with target and year-to-date */
router.get(
  '/entries',
  validate({ query: z.object({ unitId: objectId, month: z.string().regex(/^\d{4}-\d{2}$/), roUserId: objectId.optional() }) }),
  async (req, res) => {
    const { unitId, month, roUserId } = q<{ unitId: string; month: string; roUserId?: string }>(req);
    const unit = await assertCanSee(req.user!, unitId);
    const fy = fyOf(new Date(`${month}-15`));
    const ro = roUserId ?? null;
    const candidates = HEADS.filter((h) => (ro ? h.level === 'ro' : h.level === 'circle'));
    const allowed = [];
    for (const h of candidates) if (await canEnter(req.user!, h.code, unit, ro)) allowed.push(h);

    const filter = { fy, unitId: unit._id, roUserId: ro ? new Types.ObjectId(ro) : null };
    const [targets, entries, ytd] = await Promise.all([
      RevTarget.find(filter).lean(),
      RevEntry.find({ ...filter, month }).populate('enteredBy', 'name').populate('verifiedBy', 'name').lean(),
      RevEntry.aggregate([
        { $match: { ...filter, tenantId: unit.tenantId, status: { $ne: 'rejected' } } },
        { $group: { _id: '$head', cur: { $sum: '$current' }, arr: { $sum: '$arrear' }, rec: { $sum: '$received' }, disp: { $sum: '$disposed' } } },
      ]),
    ]);
    const auto = new Map<string, boolean>();
    for (const h of allowed) auto.set(h.code, await autoVerifies(req.user!, h.code, unit));
    const tBy = new Map(targets.map((t) => [t.head, t]));
    const eBy = new Map(entries.map((e) => [e.head, e]));
    const yBy = new Map(ytd.map((y) => [y._id, y]));
    res.json({
      fy,
      month,
      months: fyMonths(fy),
      unit: { _id: unit._id, name: unit.name, type: unit.type },
      isWasilBaqi: await isWasilBaqiFor(req.user!, unit),
      items: allowed.map((h) => ({ head: h, autoVerify: auto.get(h.code), target: tBy.get(h.code) ?? null, entry: eBy.get(h.code) ?? null, ytd: yBy.get(h.code) ?? null })),
    });
  },
);

router.put(
  '/entries',
  validate({
    body: z.object({
      unitId: objectId,
      roUserId: objectId.nullish(),
      month: z.string().regex(/^\d{4}-\d{2}$/),
      items: z.array(z.object({
        head: headSchema,
        current: num.default(0), arrear: num.default(0), received: num.default(0), disposed: num.default(0),
        ref: z.string().trim().max(60).optional(), note: z.string().trim().max(500).optional(),
      })).min(1).max(30),
    }),
  }),
  async (req, res) => {
    const { unitId, roUserId, month, items } = req.body;
    const unit = await assertCanSee(req.user!, unitId);
    const fy = fyOf(new Date(`${month}-15`));
    const now = new Date();
    if (month > `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`) throw badRequest('Cannot enter figures for a future month');
    const ro = roUserId ?? null;

    const saved = [];
    let anySubmitted = false;
    for (const it of items) {
      if (!(await canEnter(req.user!, it.head, unit, ro))) throw forbidden(`You cannot enter ${HEAD_BY_CODE.get(it.head)!.name} here`);
      const filter = { fy, month, head: it.head, unitId: unit._id, roUserId: ro ? new Types.ObjectId(ro) : null };
      const existing = await RevEntry.findOne(filter);
      const auto = await autoVerifies(req.user!, it.head, unit);
      if (!auto) anySubmitted = true;
      if (existing?.status === 'verified' && !auto) throw forbidden(`${HEAD_BY_CODE.get(it.head)!.name} for ${month} is already verified`);
      const doc = existing ?? new RevEntry({ ...filter, anc: unit.anc });
      Object.assign(doc, {
        current: it.current, arrear: it.arrear, received: it.received, disposed: it.disposed, ref: it.ref, note: it.note,
        enteredBy: req.user!.id,
        // Wasil Baqi / SCI entries are official on save; everyone else's wait for Wasil Baqi.
        status: auto ? 'verified' : 'submitted',
        verifiedBy: auto ? req.user!.id : undefined,
        verifiedAt: auto ? now : undefined,
      });
      saved.push(await doc.save());
    }
    if (anySubmitted) {
      const wbs = await Charge.find({ post: 'wasilbaqi', unitId: { $in: unit.anc }, ...activeFilter() }).distinct('userId');
      await notify(wbs, { type: 'entry.submitted', title: 'Figures awaiting verification', body: `${unit.name} · ${month} · ${saved.length} head(s)`, link: '/verify' });
    }
    res.json({ saved: saved.length, status: anySubmitted ? 'submitted' : 'verified' });
  },
);

/* ------------------------------------------------------------------ *
 *  Verification by Wasil Baqi Navees
 * ------------------------------------------------------------------ */
router.get('/verify', validate({ query: z.object({ tehsilId: objectId.optional() }) }), async (req, res) => {
  const me = req.user!;
  let tehsilIds: Types.ObjectId[];
  const { tehsilId } = q<{ tehsilId?: string }>(req);
  if (tehsilId) {
    const t = await assertCanSee(me, tehsilId);
    if (!(await isWasilBaqiFor(me, t))) throw forbidden();
    tehsilIds = [t._id];
  } else {
    tehsilIds = (await Charge.find({ userId: me.id, post: 'wasilbaqi', ...activeFilter() }).lean()).map((c) => c.unitId as Types.ObjectId);
  }
  if (!tehsilIds.length) return res.json([]);
  const items = await RevEntry.find({ status: 'submitted', anc: { $in: tehsilIds } })
    .populate('unitId', 'name')
    .populate('enteredBy', 'name designation')
    .populate('roUserId', 'name')
    .sort({ month: -1, createdAt: -1 })
    .limit(300)
    .lean();
  res.json(items.map((e) => ({ ...e, headName: HEAD_BY_CODE.get(e.head)?.name, kind: HEAD_BY_CODE.get(e.head)?.kind })));
});

router.post(
  '/verify',
  validate({ body: z.object({ ids: z.array(objectId).min(1).max(300), action: z.enum(['verify', 'reject']), reason: z.string().max(300).optional() }) }),
  async (req, res) => {
    const { ids, action, reason } = req.body;
    const entries = await RevEntry.find({ _id: { $in: ids }, status: 'submitted' });
    for (const e of entries) {
      if (!(await isWasilBaqiFor(req.user!, { anc: e.anc as Types.ObjectId[] }))) throw forbidden('Some entries are outside your tehsil');
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

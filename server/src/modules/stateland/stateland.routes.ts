/**
 * State Land Directory: every piece of state-owned land in every mouza (see STATE_LAND_PLAN.md).
 *  - one record per holding, permanent ID <TEHSIL>-<MOUZA>-SL-<NNNN> (serial runs per tehsil)
 *  - entry by posts with 'state_land' (Patwari) on the mouza; two-step check:
 *    'state_land_verify' (Girdawar) verifies, then 'state_land_approve' (Tehsildar / Naib Tehsildar) approves
 *  - any later edit sends the holding back for verification
 *  - documents through lib/storage (photos → one compact PDF), litigation linked by case
 *  - the Patwari marks each mouza's listing complete, the Girdawar confirms it
 * Viewing: everyone within their jurisdiction.
 */
import ExcelJS from 'exceljs';
import express, { Router } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { audit } from '../../lib/notify.js';
import { getFile, putFile, removeFile } from '../../lib/storage.js';
import { finishSheet } from '../../lib/xlsxStyle.js';
import { atLeast, type AuthUser } from '../../middleware/auth.js';
import { objectId, q, validate } from '../../middleware/validate.js';
import { Counter, LitigationCase, StateLand, StateLandDoc, StateLandMouza, Unit } from '../../models/index.js';
import type { BP, Cap } from '../org/blueprint.js';
import { bpOf } from '../org/service.js';
import { ancestorAt, hasCap, scopeRoots } from '../revenue/access.js';
import { codeOf, courtName, landBody } from '../litigation/litigation.routes.js';
import { imagesToPdf, pdfPages } from '../litigation/pdf.js';
import {
  CATEGORIES, CATEGORY, DEPARTMENTS, DOC_CATEGORIES, ENCROACHMENT_ACTION, ENCROACHMENT_NATURE, LAND_CLASS, POSSESSION, POSSESSION_LABEL,
  RECORD_LABEL, RECORD_STATUS, USES, categoryLabel, isEncroached, toAcres,
} from './lists.js';

const router = Router();
const isAdmin = (me: AuthUser) => atLeast(me.role, 'admin');
const DAY = 86_400_000;

/* ---------- access ---------- */
const can = (me: AuthUser, bp: BP, cap: Cap, unit?: { anc: Types.ObjectId[] }) => (isAdmin(me) ? Promise.resolve(true) : hasCap(me, bp, cap, unit));
async function scopeFilter(me: AuthUser, bp: BP) {
  if (isAdmin(me)) return {};
  return { anc: { $in: await scopeRoots(me, bp) } };
}
async function loadHolding(me: AuthUser, bp: BP, id: string) {
  const h = await StateLand.findOne({ _id: id, deleted: { $ne: true } });
  if (!h) throw notFound('Holding');
  if (!isAdmin(me)) {
    const roots = (await scopeRoots(me, bp)).map(String);
    if (!h.anc.some((a) => roots.includes(String(a)))) throw forbidden('This holding is outside your jurisdiction');
  }
  return h;
}
const rights = async (me: AuthUser, bp: BP, h: { anc: Types.ObjectId[] }) => ({
  canEdit: await can(me, bp, 'state_land', h),
  canVerify: await can(me, bp, 'state_land_verify', h),
  canApprove: await can(me, bp, 'state_land_approve', h),
});

/* ================================================================== *
 *  Reference data
 * ================================================================== */
router.get('/meta', async (req, res) => {
  const me = req.user!;
  const bp = bpOf(req);
  res.json({
    categories: CATEGORIES, departments: DEPARTMENTS, possession: POSSESSION, recordStatus: RECORD_STATUS, landClass: LAND_CLASS, uses: USES,
    encroachmentNature: ENCROACHMENT_NATURE, encroachmentAction: ENCROACHMENT_ACTION, docCategories: DOC_CATEGORIES.map(([key, label]) => ({ key, label })),
    canEnter: await can(me, bp, 'state_land'), canVerify: await can(me, bp, 'state_land_verify'), canApprove: await can(me, bp, 'state_land_approve'),
  });
});

/** Mouzas the user may enter holdings for (optionally searched). */
router.get('/mouzas', validate({ query: z.object({ search: z.string().max(60).optional() }) }), async (req, res) => {
  const me = req.user!;
  const bp = bpOf(req);
  const { search } = q<{ search?: string }>(req);
  const filter: Record<string, unknown> = { type: 'mouza' };
  if (!isAdmin(me)) filter.anc = { $in: await scopeRoots(me, bp) };
  if (search) filter.name = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  const mouzas = await Unit.find(filter).select('name anc type').sort({ name: 1 }).limit(300).lean();
  const out = [];
  for (const m of mouzas) if (await can(me, bp, 'state_land', m as any)) out.push(m);
  const tehsils = new Map((await Unit.find({ _id: { $in: out.map((m) => ancestorAt(bp, m as any, 'tehsil')).filter(Boolean) } }).select('name').lean()).map((t) => [String(t._id), t.name]));
  res.json(out.map((m) => ({ _id: m._id, name: m.name, tehsilId: ancestorAt(bp, m as any, 'tehsil'), tehsil: tehsils.get(String(ancestorAt(bp, m as any, 'tehsil'))) })));
});

/** Litigation cases on a mouza, to link to a holding. */
router.get('/mouza-cases', validate({ query: z.object({ unitId: objectId }) }), async (req, res) => {
  const me = req.user!;
  const filter: Record<string, unknown> = { deleted: { $ne: true }, unitId: new Types.ObjectId(q<{ unitId: string }>(req).unitId), ...(await scopeFilter(me, bpOf(req))) };
  const rows = await LitigationCase.find(filter).select('caseId caseType court courtOther status applicants respondents').sort({ caseId: 1 }).limit(500).lean();
  res.json(rows.map((c) => ({ _id: c._id, caseId: c.caseId, label: `${c.caseId} · ${c.caseType} · ${courtName(c.court, c.courtOther)} · ${c.status === 'decided' ? 'Decided' : 'Pending'}` })));
});

/* ================================================================== *
 *  Holdings
 * ================================================================== */
const listQuery = z.object({
  search: z.string().max(100).optional(), unitId: objectId.optional(), category: z.string().max(40).optional(), custodian: z.string().max(200).optional(),
  possession: z.string().max(40).optional(), recordStatus: z.string().max(40).optional(), status: z.enum(['entered', 'verified', 'approved', 'returned']).optional(),
  litigation: z.enum(['yes', 'no']).optional(), leases: z.enum(['expired', 'expiring']).optional(), page: z.coerce.number().int().min(1).default(1),
});
type ListQ = z.infer<typeof listQuery>;

async function listFilter(me: AuthUser, bp: BP, f: Partial<ListQ>) {
  const filter: Record<string, unknown> = { deleted: { $ne: true }, ...(await scopeFilter(me, bp)) };
  if (f.unitId) filter.anc = Array.isArray((filter.anc as any)?.$in) ? { $all: [new Types.ObjectId(f.unitId)], $in: (filter.anc as any).$in } : new Types.ObjectId(f.unitId);
  if (f.category) filter.category = f.category;
  if (f.custodian) filter.custodian = f.custodian;
  if (f.possession === 'any_encroached') filter.possession = { $in: ['encroached', 'part_encroached'] };
  else if (f.possession) filter.possession = f.possession;
  if (f.recordStatus) filter['record.status'] = f.recordStatus;
  if (f.status) filter.status = f.status;
  if (f.litigation) filter.underLitigation = f.litigation === 'yes';
  if (f.leases === 'expired') filter['allotment.leaseTo'] = { $lt: new Date() };
  if (f.leases === 'expiring') filter['allotment.leaseTo'] = { $gte: new Date(), $lte: new Date(Date.now() + 60 * DAY) };
  if (f.search) {
    const rx = new RegExp(f.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [{ holdingId: rx }, { khewat: rx }, { khatauni: rx }, { 'land.khasraNos': rx }, { 'land.murabba': rx }, { location: rx }, { 'allotment.allottee': rx }, { 'encroachment.encroachers': rx }, { subType: rx }, { custodian: rx }];
  }
  return filter;
}

router.get('/', validate({ query: listQuery }), async (req, res) => {
  const me = req.user!;
  const f = q<ListQ>(req);
  const filter = await listFilter(me, bpOf(req), f);
  const [items, total] = await Promise.all([
    StateLand.find(filter).select('holdingId unitId category subType custodian khewat land.murabba land.khasraNos acres possession encroachment.acres underLitigation record.status status allotment.leaseTo updatedAt').populate('unitId', 'name').sort({ holdingId: 1 }).skip((f.page - 1) * 50).limit(50).lean(),
    StateLand.countDocuments(filter),
  ]);
  res.json({ items: items.map((h) => ({ ...h, categoryLabel: categoryLabel(h.category), possessionLabel: POSSESSION_LABEL.get(h.possession) ?? h.possession, recordLabel: RECORD_LABEL.get(h.record?.status ?? '') ?? '' })), total, page: f.page });
});

/** Totals, category-wise area, mouza summary and listing completion for an area (or the whole jurisdiction). */
router.get('/summary', validate({ query: z.object({ unitId: objectId.optional() }) }), async (req, res) => {
  const me = req.user!;
  const bp = bpOf(req);
  const { unitId } = q<{ unitId?: string }>(req);
  const base = await listFilter(me, bp, { unitId });
  const now = new Date();
  const encAcres = { $cond: [{ $in: ['$possession', ['encroached', 'part_encroached']] }, { $ifNull: ['$encroachment.acres', { $cond: [{ $eq: ['$possession', 'encroached'] }, '$acres', 0] }] }, 0] };
  const sums = {
    holdings: { $sum: 1 }, acres: { $sum: { $ifNull: ['$acres', 0] } }, encroachedAcres: { $sum: encAcres },
    encroached: { $sum: { $cond: [{ $in: ['$possession', ['encroached', 'part_encroached']] }, 1, 0] } },
    litigation: { $sum: { $cond: ['$underLitigation', 1, 0] } },
    notMutated: { $sum: { $cond: [{ $in: ['$record.status', ['not_mutated', 'partly', 'not_traceable']] }, 1, 0] } },
    leasesExpired: { $sum: { $cond: [{ $and: [{ $ne: [{ $ifNull: ['$allotment.leaseTo', null] }, null] }, { $lt: ['$allotment.leaseTo', now] }] }, 1, 0] } },
    approved: { $sum: { $cond: [{ $eq: ['$status', 'approved'] }, 1, 0] } },
    verified: { $sum: { $cond: [{ $eq: ['$status', 'verified'] }, 1, 0] } },
    returned: { $sum: { $cond: [{ $eq: ['$status', 'returned'] }, 1, 0] } },
  };
  // Mouzas in the chosen area (for listing completion)
  const areaFilter: Record<string, unknown> = { type: 'mouza' };
  if (unitId) areaFilter.anc = new Types.ObjectId(unitId);
  else if (!isAdmin(me)) areaFilter.anc = { $in: await scopeRoots(me, bp) };
  const [totals, byCategory, byMouza, mouzaIds] = await Promise.all([
    StateLand.aggregate([{ $match: base }, { $group: { _id: null, ...sums } }]),
    StateLand.aggregate([{ $match: base }, { $group: { _id: '$category', ...sums } }, { $sort: { acres: -1 } }]),
    StateLand.aggregate([{ $match: base }, { $group: { _id: '$unitId', ...sums } }, { $sort: { acres: -1 } }, { $limit: 3000 }]),
    Unit.find(areaFilter).select('_id').lean(),
  ]);
  const ids = mouzaIds.map((m) => m._id);
  const marks = await StateLandMouza.find({ unitId: { $in: ids } }).lean();
  const mark = new Map(marks.map((m) => [String(m.unitId), m]));
  const names = new Map((await Unit.find({ _id: { $in: [...byMouza.map((m) => m._id), ...marks.map((m) => m.unitId)] } }).select('name anc type').lean()).map((u) => [String(u._id), u]));
  const tehsilNames = new Map((await Unit.find({ _id: { $in: [...names.values()].map((u) => ancestorAt(bp, u as any, 'tehsil')).filter(Boolean) } }).select('name').lean()).map((t) => [String(t._id), t.name]));
  const mouzaRow = (id: string, s: any) => {
    const u = names.get(id);
    const m = mark.get(id);
    return { _id: id, name: u?.name ?? '—', tehsil: u ? tehsilNames.get(String(ancestorAt(bp, u as any, 'tehsil'))) : undefined, ...s, complete: !!m?.complete, confirmed: !!m?.confirmed };
  };
  const seen = new Set(byMouza.map((m) => String(m._id)));
  const empty = { holdings: 0, acres: 0, encroachedAcres: 0, encroached: 0, litigation: 0, notMutated: 0, leasesExpired: 0, approved: 0, verified: 0, returned: 0 };
  res.json({
    totals: totals[0] ? { ...totals[0], _id: undefined } : empty,
    leasesExpiring: await StateLand.countDocuments({ ...base, 'allotment.leaseTo': { $gte: now, $lte: new Date(+now + 60 * DAY) } }),
    byCategory: byCategory.map((c) => ({ ...c, label: categoryLabel(c._id) })),
    byMouza: [...byMouza.map((m) => mouzaRow(String(m._id), m)), ...marks.filter((m) => !seen.has(String(m.unitId))).map((m) => mouzaRow(String(m.unitId), empty))],
    mouzas: { total: ids.length, complete: marks.filter((m) => m.complete).length, confirmed: marks.filter((m) => m.confirmed).length },
  });
});

/* ---------- create / edit ---------- */
const area = z.object({ kanal: z.number().min(0).max(1e7).optional(), marla: z.number().min(0).max(1e7).optional(), feet: z.number().min(0).max(1e9).optional() });
const date = z.coerce.date().nullish();
const str = (n = 200) => z.string().trim().max(n).optional();
const holdingBody = z.object({
  unitId: objectId,
  hadbast: str(40), khewat: str(60), khatauni: str(60),
  land: landBody,
  jamabandiYear: str(20), location: str(500),
  gps: z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180), at: date }).nullish(),
  boundaries: z.object({ north: str(), south: str(), east: str(), west: str() }).optional(),
  area,
  linear: z.object({ lengthFt: z.number().min(0).max(1e8).optional(), widthFt: z.number().min(0).max(1e6).optional() }).optional(),
  category: z.string().max(40),
  subType: str(120), ownerRecord: str(200), custodian: str(200), landClass: str(80), use: str(80), structures: str(500),
  acquisition: z.object({ department: str(), purpose: str(), awardNo: str(80), awardDate: date, compensation: z.enum(['yes', 'no', 'partly']).nullish(), compensationAmount: z.number().min(0).max(1e13).nullish(), mutationNo: str(80), mutationDate: date }).optional(),
  allotment: z.object({ scheme: str(120), allottee: str(), parentage: str(), orderNo: str(80), orderDate: date, authority: str(), leaseFrom: date, leaseTo: date, conditionsMet: z.enum(['yes', 'no', 'review']).nullish(), proprietary: z.enum(['granted', 'pending', 'na']).nullish(), mutationNo: str(80) }).optional(),
  possession: z.string().max(40),
  encroachment: z.object({ area: area.optional(), encroachers: z.array(z.string().trim().min(1).max(200)).max(100).default([]), nature: str(80), since: z.number().int().min(1900).max(2100).nullish(), action: str(80), retrievedOn: date, retrievedArea: area.optional() }).optional(),
  underLitigation: z.boolean().default(false),
  litigationIds: z.array(objectId).max(50).default([]),
  record: z.object({ status: z.string().max(40), mutationNos: str(200), demarcation: z.enum(['yes', 'no']).nullish(), demarcationDate: date, demarcationRef: str(120), computerised: z.enum(['yes', 'no', 'unchecked']).nullish(), discrepancy: str(1000) }),
  lastVisit: date,
  note: str(2000),
});
type HoldingBody = z.infer<typeof holdingBody>;

function check(b: Partial<HoldingBody>) {
  if (b.category !== undefined && !CATEGORY.has(b.category)) throw badRequest('Choose a category from the list');
  if (b.possession !== undefined && !POSSESSION_LABEL.has(b.possession)) throw badRequest('Choose the possession status');
  if (b.record && !RECORD_LABEL.has(b.record.status)) throw badRequest('Choose the record status');
  if (b.area && !toAcres(b.area)) throw badRequest('Enter the area (kanal / marla / feet)');
  if (b.land && !b.land.khasraNos?.length) throw badRequest('Enter at least one khasra / killa no.');
  if (b.allotment?.leaseFrom && b.allotment.leaseTo && b.allotment.leaseTo < b.allotment.leaseFrom) throw badRequest('Lease end must be after lease start');
}
/** Derived fields: acres, encroached acres, litigation flag; encroachment details only when encroached. */
function derive(h: any) {
  h.acres = toAcres(h.area);
  if (isEncroached(h.possession)) {
    const enc = toAcres(h.encroachment?.area);
    h.set ? h.set('encroachment.acres', enc || (h.possession === 'encroached' ? h.acres : 0)) : (h.encroachment = { ...(h.encroachment ?? {}), acres: enc || (h.possession === 'encroached' ? h.acres : 0) });
  } else if (h.set) h.set('encroachment', undefined);
  else delete h.encroachment;
  if (h.litigationIds?.length) h.underLitigation = true;
}

router.post('/', validate({ body: holdingBody }), async (req, res) => {
  const me = req.user!;
  const bp = bpOf(req);
  const b = req.body as HoldingBody;
  check(b);
  const mouza = await Unit.findById(b.unitId).select('name type anc code').lean();
  if (!mouza || mouza.type !== 'mouza') throw badRequest('Choose a mouza');
  if (!(await can(me, bp, 'state_land', mouza as any))) throw forbidden('You cannot enter state land for this mouza');
  const tehsilId = ancestorAt(bp, mouza as any, 'tehsil');
  const tehsil = tehsilId ? await Unit.findById(tehsilId).select('name type code').lean() : null;
  // Possible duplicate: same category on the same mouza with an overlapping khasra
  const dup = await StateLand.findOne({ deleted: { $ne: true }, unitId: mouza._id, category: b.category, 'land.khasraNos': { $in: b.land.khasraNos } }).select('holdingId').lean();
  if (dup && req.query.force !== 'true') return res.status(409).json({ error: { code: 'POSSIBLE_DUPLICATE', message: `Possible duplicate of ${dup.holdingId}`, details: { caseId: dup.holdingId, id: dup._id } } });
  const counter = await Counter.findOneAndUpdate({ key: `stateland:${tehsilId ?? 'none'}` }, { $inc: { seq: 1 } }, { upsert: true, new: true });
  const holdingId = `${tehsil ? await codeOf(tehsil as any, 'tehsil') : 'X'}-${await codeOf(mouza as any, 'mouza')}-SL-${String(counter!.seq).padStart(4, '0')}`;
  const doc: any = { ...b, holdingId, serial: counter!.seq, anc: mouza.anc, tehsilId, status: 'entered', createdBy: me.id, updatedBy: me.id, history: [{ at: new Date(), by: me.id, action: 'entered' }] };
  derive(doc);
  const h = await StateLand.create(doc);
  await audit('stateland.create', 'StateLand', h._id, { holdingId });
  res.status(201).json(h);
});

router.get('/:id', validate({ params: z.object({ id: objectId }) }), async (req, res) => {
  const me = req.user!;
  const bp = bpOf(req);
  const h = await loadHolding(me, bp, req.params.id as string);
  await h.populate([{ path: 'unitId', select: 'name' }, { path: 'createdBy', select: 'name' }, { path: 'updatedBy', select: 'name' }, { path: 'verifiedBy', select: 'name' }, { path: 'approvedBy', select: 'name' }, { path: 'history.by', select: 'name' }, { path: 'litigationIds', select: 'caseId caseType court courtOther status nextHearing' }]);
  const [docs, tehsil] = await Promise.all([
    StateLandDoc.find({ holdingRef: h._id }).populate('uploadedBy', 'name').sort({ category: 1, docDate: 1, createdAt: 1 }).lean(),
    h.tehsilId ? Unit.findById(h.tehsilId).select('name').lean() : null,
  ]);
  const cases = (h.litigationIds as any[]).map((c) => ({ _id: c._id, caseId: c.caseId, caseType: c.caseType, courtName: courtName(c.court, c.courtOther), status: c.status, nextHearing: c.nextHearing }));
  res.json({ holding: h, cases, tehsil: tehsil?.name, docs, categoryLabel: categoryLabel(h.category), ...(await rights(me, bp, h)) });
});

router.patch('/:id', validate({ params: z.object({ id: objectId }), body: holdingBody.omit({ unitId: true }).partial() }), async (req, res) => {
  const me = req.user!;
  const bp = bpOf(req);
  const h: any = await loadHolding(me, bp, req.params.id as string);
  if (!(await can(me, bp, 'state_land', h))) throw forbidden('You can view this holding but not change it');
  const b = req.body as Partial<HoldingBody>;
  check(b);
  const wasChecked = h.status !== 'entered';
  h.set({ ...b, updatedBy: me.id, status: 'entered', returnRemarks: undefined, verifiedBy: undefined, verifiedAt: undefined, approvedBy: undefined, approvedAt: undefined });
  derive(h);
  h.history.push({ at: new Date(), by: me.id, action: wasChecked ? 'edited — sent for verification again' : 'edited' });
  await h.save();
  res.json(h);
});

router.delete('/:id', validate({ params: z.object({ id: objectId }) }), async (req, res) => {
  const me = req.user!;
  const h: any = await loadHolding(me, bpOf(req), req.params.id as string);
  if (!isAdmin(me)) throw forbidden('Only an administrator can remove a holding');
  h.set({ deleted: true, updatedBy: me.id });
  h.history.push({ at: new Date(), by: me.id, action: 'removed' });
  await h.save();
  await audit('stateland.remove', 'StateLand', h._id, { holdingId: h.holdingId });
  res.status(204).end();
});

/* ---------- two-step verification ---------- */
router.post('/:id/verify', validate({ params: z.object({ id: objectId }), body: z.object({ remarks: z.string().trim().max(1000).optional() }) }), async (req, res) => {
  const me = req.user!;
  const bp = bpOf(req);
  const h: any = await loadHolding(me, bp, req.params.id as string);
  if (!(await can(me, bp, 'state_land_verify', h))) throw forbidden('Only the Girdawar of this area can verify');
  if (h.status !== 'entered') throw badRequest(h.status === 'returned' ? 'The holding was returned; it must be corrected first' : 'Already verified');
  h.set({ status: 'verified', verifiedBy: me.id, verifiedAt: new Date(), returnRemarks: undefined });
  h.history.push({ at: new Date(), by: me.id, action: 'verified', remarks: req.body.remarks });
  await h.save();
  res.json(h);
});

router.post('/:id/approve', validate({ params: z.object({ id: objectId }), body: z.object({ remarks: z.string().trim().max(1000).optional() }) }), async (req, res) => {
  const me = req.user!;
  const bp = bpOf(req);
  const h: any = await loadHolding(me, bp, req.params.id as string);
  if (!(await can(me, bp, 'state_land_approve', h))) throw forbidden('Only the Tehsildar / Naib Tehsildar can approve');
  if (h.status !== 'verified') throw badRequest('The Girdawar must verify it first');
  h.set({ status: 'approved', approvedBy: me.id, approvedAt: new Date() });
  h.history.push({ at: new Date(), by: me.id, action: 'approved', remarks: req.body.remarks });
  await h.save();
  res.json(h);
});

router.post('/:id/return', validate({ params: z.object({ id: objectId }), body: z.object({ remarks: z.string().trim().min(3).max(1000) }) }), async (req, res) => {
  const me = req.user!;
  const bp = bpOf(req);
  const h: any = await loadHolding(me, bp, req.params.id as string);
  const r = await rights(me, bp, h);
  if (!(r.canVerify || r.canApprove)) throw forbidden('Only the Girdawar or Tehsildar can return a holding');
  if (h.status === 'returned') throw badRequest('Already returned');
  h.set({ status: 'returned', returnRemarks: req.body.remarks, verifiedBy: undefined, verifiedAt: undefined, approvedBy: undefined, approvedAt: undefined });
  h.history.push({ at: new Date(), by: me.id, action: 'returned for correction', remarks: req.body.remarks });
  await h.save();
  res.json(h);
});

/* ---------- mouza listing complete (Patwari) / confirmed (Girdawar) ---------- */
router.get('/mouza/:unitId', validate({ params: z.object({ unitId: objectId }) }), async (req, res) => {
  const me = req.user!;
  const bp = bpOf(req);
  const u = await Unit.findById(req.params.unitId).select('name anc type').lean();
  if (!u) throw notFound('Mouza');
  const m = await StateLandMouza.findOne({ unitId: u._id }).populate('completedBy', 'name').populate('confirmedBy', 'name').lean();
  res.json({ mark: m, canMark: await can(me, bp, 'state_land', u as any), canConfirm: await can(me, bp, 'state_land_verify', u as any) });
});

router.post('/mouza/:unitId', validate({ params: z.object({ unitId: objectId }), body: z.object({ action: z.enum(['complete', 'reopen', 'confirm']) }) }), async (req, res) => {
  const me = req.user!;
  const bp = bpOf(req);
  const u = await Unit.findById(req.params.unitId).select('name anc type').lean();
  if (!u || u.type !== 'mouza') throw badRequest('Choose a mouza');
  const { action } = req.body as { action: 'complete' | 'reopen' | 'confirm' };
  if (action === 'confirm') {
    if (!(await can(me, bp, 'state_land_verify', u as any))) throw forbidden('Only the Girdawar can confirm');
    const m = await StateLandMouza.findOne({ unitId: u._id });
    if (!m?.complete) throw badRequest('The Patwari has not marked this mouza complete yet');
    m.set({ confirmed: true, confirmedBy: me.id, confirmedAt: new Date() });
    await m.save();
    return res.json(m);
  }
  if (!(await can(me, bp, 'state_land', u as any))) throw forbidden('Only the Patwari can mark the listing');
  const set = action === 'complete' ? { complete: true, completedBy: me.id, completedAt: new Date(), confirmed: false } : { complete: false, confirmed: false };
  const m = await StateLandMouza.findOneAndUpdate({ unitId: u._id }, { $set: { ...set, anc: u.anc } }, { upsert: true, new: true });
  res.json(m);
});

/* ================================================================== *
 *  Documents (same handling as litigation)
 * ================================================================== */
const MAX_FILE = 10 * 1024 * 1024;
const docBody = z.object({
  category: z.enum(DOC_CATEGORIES.map((c) => c[0]) as [string, ...string[]]),
  title: z.string().trim().max(200).optional(),
  docDate: z.coerce.date().nullish(),
  files: z.array(z.object({ name: z.string().max(200), mime: z.string().max(100), data: z.string() })).min(1).max(40),
});
const sniff = (b: Buffer) => (b.subarray(0, 4).toString() === '%PDF' ? 'application/pdf' : b[0] === 0xff && b[1] === 0xd8 ? 'image/jpeg' : b[0] === 0x89 && b.subarray(1, 4).toString() === 'PNG' ? 'image/png' : null);

router.post('/:id/docs', express.json({ limit: '40mb' }), validate({ params: z.object({ id: objectId }), body: docBody }), async (req, res) => {
  const me = req.user!;
  const bp = bpOf(req);
  const h: any = await loadHolding(me, bp, req.params.id as string);
  if (!(await can(me, bp, 'state_land', h))) throw forbidden('You can view this holding but not change it');
  const b = req.body as z.infer<typeof docBody>;
  const files = b.files.map((f) => {
    const data = Buffer.from(f.data, 'base64');
    const mime = sniff(data);
    if (!mime) throw badRequest(`${f.name}: only PDF, JPG or PNG files are accepted`);
    if (data.length > MAX_FILE) throw badRequest(`${f.name} is larger than 10 MB`);
    return { name: f.name, mime, data };
  });
  const pdfs = files.filter((f) => f.mime === 'application/pdf');
  if (pdfs.length && files.length > 1) throw badRequest('Upload one PDF at a time, or several photos together');
  let doc: { data: Buffer; pages: number };
  try {
    doc = pdfs.length ? { data: pdfs[0].data, pages: await pdfPages(pdfs[0].data) } : await imagesToPdf(files);
  } catch {
    throw badRequest('The file could not be read — take the photo again or upload another file');
  }
  const stored = await putFile(doc.data, `${h.holdingId}-${b.category}.pdf`, 'application/pdf', { tenantId: me.tenantId, holdingId: h.holdingId });
  const d = await StateLandDoc.create({ holdingRef: h._id, category: b.category, title: b.title, docDate: b.docDate, backend: stored.backend, storageKey: stored.key, mime: 'application/pdf', size: doc.data.length, pages: doc.pages, uploadedBy: me.id });
  h.history.push({ at: new Date(), by: me.id, action: `document added (${b.category})` });
  await h.save();
  res.status(201).json(d);
});

router.get('/:id/docs/:docId', validate({ params: z.object({ id: objectId, docId: objectId }) }), async (req, res) => {
  const h = await loadHolding(req.user!, bpOf(req), req.params.id as string);
  const d = await StateLandDoc.findOne({ _id: req.params.docId, holdingRef: h._id }).lean();
  if (!d) throw notFound('Document');
  const name = `${h.holdingId} ${d.title ?? d.category}.pdf`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `${req.query.inline === 'true' ? 'inline' : 'attachment'}; filename="${encodeURIComponent(name)}"; filename*=UTF-8''${encodeURIComponent(name)}`);
  res.send(await getFile(d.storageKey));
});

router.delete('/:id/docs/:docId', validate({ params: z.object({ id: objectId, docId: objectId }) }), async (req, res) => {
  const me = req.user!;
  const bp = bpOf(req);
  const h: any = await loadHolding(me, bp, req.params.id as string);
  if (!(await can(me, bp, 'state_land', h))) throw forbidden('You can view this holding but not change it');
  const d = await StateLandDoc.findOne({ _id: req.params.docId, holdingRef: h._id });
  if (!d) throw notFound('Document');
  await removeFile(d.storageKey);
  await d.deleteOne();
  h.history.push({ at: new Date(), by: me.id, action: `document removed (${d.category})` });
  await h.save();
  res.status(204).end();
});

/* ================================================================== *
 *  Excel: the (filtered) directory
 * ================================================================== */
router.get('/export/xlsx', validate({ query: listQuery }), async (req, res) => {
  const me = req.user!;
  const filter = await listFilter(me, bpOf(req), q<ListQ>(req));
  const rows = await StateLand.find(filter).populate('unitId', 'name').populate('tehsilId', 'name').populate('litigationIds', 'caseId').sort({ holdingId: 1 }).limit(50000).lean();
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('State Land');
  const d = (x?: Date | null) => (x ? new Date(x) : '');
  ws.addRow(['S.No', 'Holding ID', 'Tehsil', 'Mouza', 'Hadbast', 'Khewat', 'Khatauni', 'Murabba (Killa / Khasra)', 'Khasra Nos.', 'Kanal', 'Marla', 'Feet', 'Acres', 'Category', 'Sub-type', 'Owner as per Record', 'Custodian Department', 'Land Class', 'Present Use', 'Possession', 'Encroached Acres', 'Encroachers', 'Action on Encroachment', 'Record Status', 'Mutation Nos.', 'Demarcation', 'Under Litigation', 'Litigation Cases', 'Allottee / Lessee', 'Scheme', 'Lease To', 'Award No.', 'Location', 'GPS', 'Status', 'Last Site Visit']);
  rows.forEach((h: any, i) => ws.addRow([
    i + 1, h.holdingId, h.tehsilId?.name, h.unitId?.name, h.hadbast, h.khewat, h.khatauni, h.land?.murabba, (h.land?.khasraNos ?? []).join(', '), h.area?.kanal, h.area?.marla, h.area?.feet, h.acres,
    categoryLabel(h.category), h.subType, h.ownerRecord, h.custodian, h.landClass, h.use, POSSESSION_LABEL.get(h.possession) ?? h.possession, h.encroachment?.acres ?? '', (h.encroachment?.encroachers ?? []).join('; '), h.encroachment?.action,
    RECORD_LABEL.get(h.record?.status) ?? '', h.record?.mutationNos, h.record?.demarcation === 'yes' ? 'Done' : h.record?.demarcation === 'no' ? 'Not done' : '', h.underLitigation ? 'Yes' : 'No', (h.litigationIds ?? []).map((c: any) => c.caseId).join(', '),
    h.allotment?.allottee, h.allotment?.scheme, d(h.allotment?.leaseTo), h.acquisition?.awardNo, h.location, h.gps?.lat ? `${h.gps.lat.toFixed(6)}, ${h.gps.lng.toFixed(6)}` : '',
    { entered: 'Entered', verified: 'Verified', approved: 'Approved', returned: 'Returned' }[h.status as string], d(h.lastVisit),
  ]));
  finishSheet(ws, { headerRow: 1, keyCols: 4 });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="state-land-directory.xlsx"');
  res.send(Buffer.from(await wb.xlsx.writeBuffer()));
});

export default router;

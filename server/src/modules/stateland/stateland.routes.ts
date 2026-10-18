/**
 * State Land Directory: every state-owned khasra in every mouza (see STATE_LAND_PLAN.md).
 *  - one record per khasra: Murabba / Mustateel no. → killa (1–25) → optional sub-killa, each with its own area
 *  - entry in batches: pick a murabba, tick any of its 25 killas (split into sub-killas where needed),
 *    give khewat / khatauni once and the classification once for the whole selection
 *  - entry by posts with 'state_land' (Patwari); two-step check: 'state_land_verify' (Girdawar) verifies,
 *    then 'state_land_approve' (Tehsildar / Naib Tehsildar) approves; any later edit goes back for verification
 *  - categories, sub-types and departments come from admin-managed lists so names stay uniform
 *  - documents through lib/storage, litigation linked by case
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
import { LitigationCase, StateLand, StateLandDoc, StateLandMouza, Tenant, Unit } from '../../models/index.js';
import type { BP, Cap } from '../org/blueprint.js';
import { bpOf } from '../org/service.js';
import { ancestorAt, hasCap, scopeRoots } from '../revenue/access.js';
import { codeOf, courtName } from '../litigation/litigation.routes.js';
import { imagesToPdf, pdfPages } from '../litigation/pdf.js';
import {
  DOC_CATEGORIES, ENCROACHMENT_ACTION, ENCROACHMENT_NATURE, LAND_CLASS, POSSESSION, POSSESSION_LABEL, RECORD_LABEL, RECORD_STATUS, USES,
  isEncroached, labelIn, slSettings, toAcres, type Category,
} from './lists.js';

const router = Router();
const isAdmin = (me: AuthUser) => atLeast(me.role, 'admin');
const DAY = 86_400_000;
const STATUS_LABEL: Record<string, string> = { entered: 'Entered', verified: 'Verified', approved: 'Approved', returned: 'Returned' };
export const khasraLabel = (murabba: string, killa: number, sub?: string | null) => `${murabba}//${killa}${sub ? `/${sub}` : ''}`;

/* ---------- access ---------- */
const can = (me: AuthUser, bp: BP, cap: Cap, unit?: { anc: Types.ObjectId[] }) => (isAdmin(me) ? Promise.resolve(true) : hasCap(me, bp, cap, unit));
async function scopeFilter(me: AuthUser, bp: BP) {
  if (isAdmin(me)) return {};
  return { anc: { $in: await scopeRoots(me, bp) } };
}
async function loadKhasra(me: AuthUser, bp: BP, id: string) {
  const h = await StateLand.findOne({ _id: id, deleted: { $ne: true } });
  if (!h) throw notFound('Khasra');
  if (!isAdmin(me)) {
    const roots = (await scopeRoots(me, bp)).map(String);
    if (!h.anc.some((a) => roots.includes(String(a)))) throw forbidden('This khasra is outside your jurisdiction');
  }
  return h;
}
const rights = async (me: AuthUser, bp: BP, h: { anc: Types.ObjectId[] }) => ({
  canEdit: await can(me, bp, 'state_land', h),
  canVerify: await can(me, bp, 'state_land_verify', h),
  canApprove: await can(me, bp, 'state_land_approve', h),
});

/* ================================================================== *
 *  Reference data and settings
 * ================================================================== */
router.get('/meta', async (req, res) => {
  const me = req.user!;
  const bp = bpOf(req);
  const s = await slSettings(me.tenantId);
  res.json({
    categories: s.categories, departments: s.departments, possession: POSSESSION, recordStatus: RECORD_STATUS, landClass: LAND_CLASS, uses: USES,
    encroachmentNature: ENCROACHMENT_NATURE, encroachmentAction: ENCROACHMENT_ACTION, docCategories: DOC_CATEGORIES.map(([key, label]) => ({ key, label })),
    canEnter: await can(me, bp, 'state_land'), canVerify: await can(me, bp, 'state_land_verify'), canApprove: await can(me, bp, 'state_land_approve'), isAdmin: isAdmin(me),
  });
});

const catSchema = z.object({
  key: z.string().trim().regex(/^[a-z0-9_]{2,40}$/), label: z.string().trim().min(2).max(120), owner: z.string().trim().max(120).optional(),
  subTypes: z.array(z.string().trim().min(1).max(120)).max(200), sections: z.array(z.enum(['acquisition', 'allotment'])).max(2).optional(),
});
router.put('/settings', validate({ body: z.object({ categories: z.array(catSchema).min(1).max(60), departments: z.array(z.string().trim().min(1).max(200)).min(1).max(300) }) }), async (req, res) => {
  const me = req.user!;
  if (!isAdmin(me)) throw forbidden('Only an administrator can change the lists');
  const { categories, departments } = req.body as { categories: Category[]; departments: string[] };
  if (new Set(categories.map((c) => c.key)).size !== categories.length) throw badRequest('Category keys must be unique');
  // A category in use cannot be dropped (its records would lose their name)
  const used: string[] = await StateLand.distinct('category', { deleted: { $ne: true } });
  const missing = used.filter((k) => !categories.some((c) => c.key === k));
  if (missing.length) throw badRequest(`Category in use, cannot be removed: ${missing.join(', ')}`);
  const clean = categories.map((c) => ({ ...c, subTypes: [...new Set(c.subTypes)] }));
  await Tenant.updateOne({ _id: me.tenantId }, { $set: { stateLand: { categories: clean, departments: [...new Set(departments)] } } });
  res.json(await slSettings(me.tenantId));
});

/** Mouzas the user may enter state land for (optionally searched). */
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

/** Killas of a murabba already entered on a mouza (to grey them out in the picker). */
router.get('/taken', validate({ query: z.object({ unitId: objectId, murabba: z.string().trim().min(1).max(40) }) }), async (req, res) => {
  const { unitId, murabba } = q<{ unitId: string; murabba: string }>(req);
  const rows = await StateLand.find({ deleted: { $ne: true }, unitId, murabba, ...(await scopeFilter(req.user!, bpOf(req))) }).select('killa subKilla khasraNo khewat khatauni').lean();
  res.json(rows.map((r) => ({ _id: r._id, killa: r.killa, subKilla: r.subKilla, khasraNo: r.khasraNo })));
});

/** Litigation cases on a mouza, to link to khasras. */
router.get('/mouza-cases', validate({ query: z.object({ unitId: objectId }) }), async (req, res) => {
  const me = req.user!;
  const filter: Record<string, unknown> = { deleted: { $ne: true }, unitId: new Types.ObjectId(q<{ unitId: string }>(req).unitId), ...(await scopeFilter(me, bpOf(req))) };
  const rows = await LitigationCase.find(filter).select('caseId caseType court courtOther status').sort({ caseId: 1 }).limit(500).lean();
  res.json(rows.map((c) => ({ _id: c._id, caseId: c.caseId, label: `${c.caseId} · ${c.caseType} · ${courtName(c.court, c.courtOther)} · ${c.status === 'decided' ? 'Decided' : 'Pending'}` })));
});

/* ================================================================== *
 *  Directory
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
    const t = f.search.trim();
    const rx = new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [{ khasraNo: new RegExp(`^${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i') }, { murabba: t }, { holdingId: rx }, { khewat: rx }, { khatauni: rx }, { 'allotment.allottee': rx }, { 'encroachment.encroachers': rx }, { subType: rx }, { custodian: rx }];
  }
  return filter;
}

router.get('/', validate({ query: listQuery }), async (req, res) => {
  const me = req.user!;
  const f = q<ListQ>(req);
  const filter = await listFilter(me, bpOf(req), f);
  const s = await slSettings(me.tenantId);
  const [items, total] = await Promise.all([
    StateLand.find(filter).select('holdingId khasraNo murabba killa subKilla unitId category subType custodian khewat khatauni area acres possession encroachment.acres underLitigation record.status status allotment.leaseTo updatedAt').populate('unitId', 'name')
      .collation({ locale: 'en', numericOrdering: true }).sort({ unitId: 1, murabba: 1, killa: 1, subKilla: 1 }).skip((f.page - 1) * 100).limit(100).lean(),
    StateLand.countDocuments(filter),
  ]);
  res.json({ items: items.map((h) => ({ ...h, categoryLabel: labelIn(s.categories, h.category), possessionLabel: POSSESSION_LABEL.get(h.possession) ?? h.possession, recordLabel: RECORD_LABEL.get(h.record?.status ?? '') ?? '' })), total, page: f.page, pageSize: 100 });
});

/** Totals, category-wise area, mouza summary and listing completion for an area (or the whole jurisdiction). */
router.get('/summary', validate({ query: z.object({ unitId: objectId.optional() }) }), async (req, res) => {
  const me = req.user!;
  const bp = bpOf(req);
  const { unitId } = q<{ unitId?: string }>(req);
  const base = await listFilter(me, bp, { unitId });
  const s = await slSettings(me.tenantId);
  const now = new Date();
  const encAcres = { $cond: [{ $in: ['$possession', ['encroached', 'part_encroached']] }, { $ifNull: ['$encroachment.acres', { $cond: [{ $eq: ['$possession', 'encroached'] }, '$acres', 0] }] }, 0] };
  const sums = {
    khasras: { $sum: 1 }, acres: { $sum: { $ifNull: ['$acres', 0] } }, encroachedAcres: { $sum: encAcres },
    encroached: { $sum: { $cond: [{ $in: ['$possession', ['encroached', 'part_encroached']] }, 1, 0] } },
    litigation: { $sum: { $cond: ['$underLitigation', 1, 0] } },
    notMutated: { $sum: { $cond: [{ $in: ['$record.status', ['not_mutated', 'partly', 'not_traceable']] }, 1, 0] } },
    leasesExpired: { $sum: { $cond: [{ $and: [{ $ne: [{ $ifNull: ['$allotment.leaseTo', null] }, null] }, { $lt: ['$allotment.leaseTo', now] }] }, 1, 0] } },
    approved: { $sum: { $cond: [{ $eq: ['$status', 'approved'] }, 1, 0] } },
    verified: { $sum: { $cond: [{ $eq: ['$status', 'verified'] }, 1, 0] } },
    returned: { $sum: { $cond: [{ $eq: ['$status', 'returned'] }, 1, 0] } },
  };
  const areaFilter: Record<string, unknown> = { type: 'mouza' };
  if (unitId) areaFilter.anc = new Types.ObjectId(unitId);
  else if (!isAdmin(me)) areaFilter.anc = { $in: await scopeRoots(me, bp) };
  const [totals, byCategory, byMouza, mouzaIds] = await Promise.all([
    StateLand.aggregate([{ $match: base }, { $group: { _id: null, ...sums } }]),
    StateLand.aggregate([{ $match: base }, { $group: { _id: '$category', ...sums } }, { $sort: { acres: -1 } }]),
    StateLand.aggregate([{ $match: base }, { $group: { _id: '$unitId', murabbas: { $addToSet: '$murabba' }, ...sums } }, { $sort: { acres: -1 } }, { $limit: 3000 }]),
    Unit.find(areaFilter).select('_id').lean(),
  ]);
  const ids = mouzaIds.map((m) => m._id);
  const marks = await StateLandMouza.find({ unitId: { $in: ids } }).lean();
  const mark = new Map(marks.map((m) => [String(m.unitId), m]));
  const names = new Map((await Unit.find({ _id: { $in: [...byMouza.map((m) => m._id), ...marks.map((m) => m.unitId)] } }).select('name anc type').lean()).map((u) => [String(u._id), u]));
  const tehsilNames = new Map((await Unit.find({ _id: { $in: [...names.values()].map((u) => ancestorAt(bp, u as any, 'tehsil')).filter(Boolean) } }).select('name').lean()).map((t) => [String(t._id), t.name]));
  const mouzaRow = (id: string, x: any) => {
    const u = names.get(id);
    const m = mark.get(id);
    return { _id: id, name: u?.name ?? '—', tehsil: u ? tehsilNames.get(String(ancestorAt(bp, u as any, 'tehsil'))) : undefined, ...x, murabbas: x.murabbas?.length ?? 0, complete: !!m?.complete, confirmed: !!m?.confirmed };
  };
  const seen = new Set(byMouza.map((m) => String(m._id)));
  const empty = { khasras: 0, acres: 0, encroachedAcres: 0, encroached: 0, litigation: 0, notMutated: 0, leasesExpired: 0, approved: 0, verified: 0, returned: 0 };
  res.json({
    totals: totals[0] ? { ...totals[0], _id: undefined } : empty,
    leasesExpiring: await StateLand.countDocuments({ ...base, 'allotment.leaseTo': { $gte: now, $lte: new Date(+now + 60 * DAY) } }),
    byCategory: byCategory.map((c) => ({ ...c, label: labelIn(s.categories, c._id) })),
    byMouza: [...byMouza.map((m) => mouzaRow(String(m._id), m)), ...marks.filter((m) => !seen.has(String(m.unitId))).map((m) => mouzaRow(String(m.unitId), empty))],
    mouzas: { total: ids.length, complete: marks.filter((m) => m.complete).length, confirmed: marks.filter((m) => m.confirmed).length },
  });
});

/* ================================================================== *
 *  Entry: a batch of khasras sharing one classification
 * ================================================================== */
const area = z.object({ kanal: z.number().min(0).max(1e7).optional(), marla: z.number().min(0).max(1e7).optional(), feet: z.number().min(0).max(1e9).optional() });
const date = z.coerce.date().nullish();
const str = (n = 200) => z.string().trim().max(n).optional();
const killaNo = z.number().int().min(1).max(25);
const subNo = z.string().trim().max(10).regex(/^[0-9A-Za-z-]*$/, 'Sub-killa: digits or letters only').default('');

/** Details shared by every khasra of an entry (and editable per khasra later). */
const details = z.object({
  jamabandiYear: str(20),
  category: z.string().max(40),
  subType: str(120), ownerRecord: str(200), custodian: str(200), landClass: str(80), use: str(80), structures: str(500),
  acquisition: z.object({ department: str(), purpose: str(), awardNo: str(80), awardDate: date, compensation: z.enum(['yes', 'no', 'partly']).nullish(), compensationAmount: z.number().min(0).max(1e13).nullish(), mutationNo: str(80), mutationDate: date }).optional(),
  allotment: z.object({ scheme: str(120), allottee: str(), parentage: str(), orderNo: str(80), orderDate: date, authority: str(), leaseFrom: date, leaseTo: date, conditionsMet: z.enum(['yes', 'no', 'review']).nullish(), proprietary: z.enum(['granted', 'pending', 'na']).nullish(), mutationNo: str(80) }).optional(),
  possession: z.string().max(40),
  encroachment: z.object({ encroachers: z.array(z.string().trim().min(1).max(200)).max(100).default([]), nature: str(80), since: z.number().int().min(1900).max(2100).nullish(), action: str(80), retrievedOn: date, retrievedArea: area.optional() }).optional(),
  underLitigation: z.boolean().default(false),
  litigationIds: z.array(objectId).max(50).default([]),
  record: z.object({ status: z.string().max(40), mutationNos: str(200), demarcation: z.enum(['yes', 'no']).nullish(), demarcationDate: date, demarcationRef: str(120), computerised: z.enum(['yes', 'no', 'unchecked']).nullish(), discrepancy: str(1000) }),
  lastVisit: date,
  note: str(2000),
});
type Details = z.infer<typeof details>;

const batchBody = z.object({
  unitId: objectId,
  khewat: str(60), khatauni: str(60),
  murabbas: z.array(z.object({
    murabba: z.string().trim().min(1).max(40),
    khewat: str(60), khatauni: str(60), // when different from the entry's
    killas: z.array(z.object({ killa: killaNo, subKilla: subNo, area, encroachedArea: area.optional() })).min(1).max(250),
  })).min(1).max(40),
  details,
});

async function checkDetails(tenantId: string, d: Partial<Details>) {
  if (d.category !== undefined || d.subType !== undefined || d.custodian !== undefined) {
    const s = await slSettings(tenantId);
    const cat = s.categories.find((c) => c.key === d.category);
    if (d.category !== undefined && !cat) throw badRequest('Choose a category from the list');
    if (d.subType && cat && !cat.subTypes.includes(d.subType)) throw badRequest(`"${d.subType}" is not a sub-type of ${cat.label}. Ask the administrator to add it.`);
    if (d.custodian && !s.departments.includes(d.custodian)) throw badRequest(`"${d.custodian}" is not in the department list. Ask the administrator to add it.`);
  }
  if (d.possession !== undefined && !POSSESSION_LABEL.has(d.possession)) throw badRequest('Choose the possession status');
  if (d.record && !RECORD_LABEL.has(d.record.status)) throw badRequest('Choose the record status');
  if (d.allotment?.leaseFrom && d.allotment.leaseTo && d.allotment.leaseTo < d.allotment.leaseFrom) throw badRequest('Lease end must be after lease start');
}
/** Derived fields: acres, encroached acres (whole khasra when fully encroached), litigation flag. */
function derive(h: any, encroachedArea?: { kanal?: number; marla?: number; feet?: number }) {
  h.acres = toAcres(h.area);
  if (isEncroached(h.possession)) {
    const enc = h.encroachment ?? {};
    if (encroachedArea) enc.area = encroachedArea;
    if (h.possession === 'encroached') enc.area = h.area;
    enc.acres = toAcres(enc.area);
    h.encroachment = enc;
  } else h.encroachment = undefined;
  if (h.litigationIds?.length) h.underLitigation = true;
}

router.post('/batch', validate({ body: batchBody }), async (req, res) => {
  const me = req.user!;
  const bp = bpOf(req);
  const b = req.body as z.infer<typeof batchBody>;
  await checkDetails(me.tenantId, b.details);
  const mouza = await Unit.findById(b.unitId).select('name type anc code').lean();
  if (!mouza || mouza.type !== 'mouza') throw badRequest('Choose a mouza');
  if (!(await can(me, bp, 'state_land', mouza as any))) throw forbidden('You cannot enter state land for this mouza');
  const tehsilId = ancestorAt(bp, mouza as any, 'tehsil');
  const tehsil = tehsilId ? await Unit.findById(tehsilId).select('name type code').lean() : null;
  const prefix = `${tehsil ? await codeOf(tehsil as any, 'tehsil') : 'X'}-${await codeOf(mouza as any, 'mouza')}`;

  // Every khasra must have an area; a killa is entered either whole or as sub-killas, never both; no repeats
  const rows: { murabba: string; killa: number; subKilla: string; area: any; encroachedArea?: any; khewat?: string; khatauni?: string }[] = [];
  const seen = new Set<string>();
  for (const m of b.murabbas) {
    for (const k of m.killas) {
      const key = khasraLabel(m.murabba, k.killa, k.subKilla);
      if (seen.has(key)) throw badRequest(`${key} is entered twice`);
      seen.add(key);
      if (!toAcres(k.area)) throw badRequest(`Enter the area of ${key}`);
      if (b.details.possession === 'part_encroached' && !toAcres(k.encroachedArea)) throw badRequest(`Enter the encroached area of ${key}`);
      rows.push({ murabba: m.murabba, killa: k.killa, subKilla: k.subKilla, area: k.area, encroachedArea: k.encroachedArea, khewat: m.khewat || b.khewat, khatauni: m.khatauni || b.khatauni });
    }
    const whole = new Set(m.killas.filter((k) => !k.subKilla).map((k) => k.killa));
    const split = m.killas.find((k) => k.subKilla && whole.has(k.killa));
    if (split) throw badRequest(`Killa ${split.killa} of murabba ${m.murabba} is entered both whole and as sub-killas`);
  }
  // Already in the directory? (whole killa vs its sub-killas conflict too)
  const existing = await StateLand.find({ deleted: { $ne: true }, unitId: mouza._id, murabba: { $in: b.murabbas.map((m) => m.murabba) } }).select('murabba killa subKilla khasraNo').lean();
  const clash = rows.filter((r) => existing.some((e) => e.murabba === r.murabba && e.killa === r.killa && (e.subKilla === r.subKilla || !e.subKilla || !r.subKilla)));
  if (clash.length) {
    const list = [...new Set(clash.map((r) => khasraLabel(r.murabba, r.killa, r.subKilla)))];
    return res.status(409).json({ error: { code: 'ALREADY_ENTERED', message: `Already in the directory: ${list.slice(0, 15).join(', ')}${list.length > 15 ? ` and ${list.length - 15} more` : ''}`, details: { khasras: list } } });
  }
  const now = new Date();
  const docs = rows.map((r) => {
    const d: any = {
      ...b.details, encroachment: b.details.encroachment ? { ...b.details.encroachment } : undefined,
      unitId: mouza._id, anc: mouza.anc, tehsilId, murabba: r.murabba, killa: r.killa, subKilla: r.subKilla, khasraNo: khasraLabel(r.murabba, r.killa, r.subKilla),
      holdingId: `${prefix}-${khasraLabel(r.murabba, r.killa, r.subKilla)}`, khewat: r.khewat, khatauni: r.khatauni, area: r.area,
      status: 'entered', createdBy: me.id, updatedBy: me.id, history: [{ at: now, by: me.id, action: 'entered' }],
    };
    derive(d, r.encroachedArea);
    return d;
  });
  const created = await StateLand.insertMany(docs);
  await audit('stateland.create', 'Unit', mouza._id, { khasras: created.length, murabbas: b.murabbas.map((m) => m.murabba) });
  res.status(201).json({ created: created.length, ids: created.map((c) => c._id), acres: Math.round(docs.reduce((a, d) => a + d.acres, 0) * 10_000) / 10_000 });
});

/* ---------- one khasra ---------- */
router.get('/:id', validate({ params: z.object({ id: objectId }) }), async (req, res) => {
  const me = req.user!;
  const bp = bpOf(req);
  const h = await loadKhasra(me, bp, req.params.id as string);
  await h.populate([{ path: 'unitId', select: 'name' }, { path: 'createdBy', select: 'name' }, { path: 'updatedBy', select: 'name' }, { path: 'verifiedBy', select: 'name' }, { path: 'approvedBy', select: 'name' }, { path: 'history.by', select: 'name' }, { path: 'litigationIds', select: 'caseId caseType court courtOther status nextHearing' }]);
  const [docs, tehsil, s, siblings] = await Promise.all([
    StateLandDoc.find({ holdingRef: h._id }).populate('uploadedBy', 'name').sort({ category: 1, docDate: 1, createdAt: 1 }).lean(),
    h.tehsilId ? Unit.findById(h.tehsilId).select('name').lean() : null,
    slSettings(me.tenantId),
    StateLand.find({ deleted: { $ne: true }, unitId: (h.unitId as any)._id, murabba: h.murabba }).select('killa subKilla khasraNo').collation({ locale: 'en', numericOrdering: true }).sort({ killa: 1, subKilla: 1 }).lean(),
  ]);
  const cases = (h.litigationIds as any[]).map((c) => ({ _id: c._id, caseId: c.caseId, caseType: c.caseType, courtName: courtName(c.court, c.courtOther), status: c.status, nextHearing: c.nextHearing }));
  res.json({ khasra: h, cases, tehsil: tehsil?.name, docs, categoryLabel: labelIn(s.categories, h.category), siblings, ...(await rights(me, bp, h)) });
});

const patchBody = details.partial().extend({ khewat: str(60), khatauni: str(60), area: area.optional(), encroachedArea: area.optional() });
router.patch('/:id', validate({ params: z.object({ id: objectId }), body: patchBody }), async (req, res) => {
  const me = req.user!;
  const bp = bpOf(req);
  const h: any = await loadKhasra(me, bp, req.params.id as string);
  if (!(await can(me, bp, 'state_land', h))) throw forbidden('You can view this khasra but not change it');
  const { encroachedArea, ...b } = req.body as z.infer<typeof patchBody>;
  await checkDetails(me.tenantId, b);
  if (b.area && !toAcres(b.area)) throw badRequest('Enter the area (kanal / marla / feet)');
  const wasChecked = h.status !== 'entered';
  const next: any = { ...h.toObject(), ...b };
  derive(next, encroachedArea);
  h.set({ ...b, acres: next.acres, encroachment: next.encroachment, underLitigation: next.underLitigation, updatedBy: me.id, status: 'entered', returnRemarks: undefined, verifiedBy: undefined, verifiedAt: undefined, approvedBy: undefined, approvedAt: undefined });
  h.history.push({ at: new Date(), by: me.id, action: wasChecked ? 'edited — sent for verification again' : 'edited' });
  await h.save();
  res.json(h);
});

router.delete('/:id', validate({ params: z.object({ id: objectId }) }), async (req, res) => {
  const me = req.user!;
  const bp = bpOf(req);
  const h: any = await loadKhasra(me, bp, req.params.id as string);
  // The Patwari may remove his own unchecked entry (e.g. entered by mistake); otherwise admins only
  if (!isAdmin(me)) {
    if (!(await can(me, bp, 'state_land', h))) throw forbidden('You cannot remove this khasra');
    if (h.status === 'verified' || h.status === 'approved') throw forbidden('A verified khasra can only be removed by an administrator');
  }
  h.set({ deleted: true, updatedBy: me.id });
  h.history.push({ at: new Date(), by: me.id, action: 'removed' });
  await h.save();
  await audit('stateland.remove', 'StateLand', h._id, { khasra: h.holdingId });
  res.status(204).end();
});

/* ---------- two-step verification (one or many khasras) ---------- */
type Act = 'verify' | 'approve' | 'return';
async function apply(me: AuthUser, bp: BP, h: any, action: Act, remarks?: string): Promise<string | null> {
  const r = await rights(me, bp, h);
  if (action === 'verify') {
    if (!r.canVerify) return 'only the Girdawar of the area can verify';
    if (h.status !== 'entered') return h.status === 'returned' ? 'returned — must be corrected first' : 'already verified';
    h.set({ status: 'verified', verifiedBy: me.id, verifiedAt: new Date(), returnRemarks: undefined });
  } else if (action === 'approve') {
    if (!r.canApprove) return 'only the Tehsildar / Naib Tehsildar can approve';
    if (h.status !== 'verified') return 'the Girdawar must verify it first';
    h.set({ status: 'approved', approvedBy: me.id, approvedAt: new Date() });
  } else {
    if (!(r.canVerify || r.canApprove)) return 'only the Girdawar or Tehsildar can return';
    if (h.status === 'returned') return 'already returned';
    h.set({ status: 'returned', returnRemarks: remarks, verifiedBy: undefined, verifiedAt: undefined, approvedBy: undefined, approvedAt: undefined });
  }
  h.history.push({ at: new Date(), by: me.id, action: action === 'return' ? 'returned for correction' : `${action === 'verify' ? 'verified' : 'approved'}`, remarks });
  await h.save();
  return null;
}
const actBody = z.object({ remarks: z.string().trim().max(1000).optional() });
for (const action of ['verify', 'approve', 'return'] as const) {
  router.post(`/:id/${action}`, validate({ params: z.object({ id: objectId }), body: actBody }), async (req, res) => {
    const me = req.user!;
    const bp = bpOf(req);
    if (action === 'return' && (req.body.remarks ?? '').length < 3) throw badRequest('Write what is to be corrected');
    const h: any = await loadKhasra(me, bp, req.params.id as string);
    const err = await apply(me, bp, h, action, req.body.remarks);
    if (err) throw (err.startsWith('only') ? forbidden(err[0].toUpperCase() + err.slice(1)) : badRequest(err[0].toUpperCase() + err.slice(1)));
    res.json(h);
  });
}
/** Verify / approve / return many khasras at once (e.g. a whole murabba). */
router.post('/bulk', validate({ body: z.object({ ids: z.array(objectId).min(1).max(1000), action: z.enum(['verify', 'approve', 'return']), remarks: z.string().trim().max(1000).optional() }) }), async (req, res) => {
  const me = req.user!;
  const bp = bpOf(req);
  const { ids, action, remarks } = req.body as { ids: string[]; action: Act; remarks?: string };
  if (action === 'return' && (remarks ?? '').length < 3) throw badRequest('Write what is to be corrected');
  let done = 0;
  const skipped: { khasra: string; reason: string }[] = [];
  for (const id of ids) {
    const h: any = await loadKhasra(me, bp, id).catch(() => null);
    if (!h) { skipped.push({ khasra: id, reason: 'not found' }); continue; }
    const err = await apply(me, bp, h, action, remarks);
    if (err) skipped.push({ khasra: h.khasraNo, reason: err });
    else done++;
  }
  res.json({ done, skipped });
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
  const h: any = await loadKhasra(me, bp, req.params.id as string);
  if (!(await can(me, bp, 'state_land', h))) throw forbidden('You can view this khasra but not change it');
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
  const stored = await putFile(doc.data, `${h.holdingId}-${b.category}.pdf`, 'application/pdf', { tenantId: me.tenantId, khasra: h.holdingId });
  const d = await StateLandDoc.create({ holdingRef: h._id, category: b.category, title: b.title, docDate: b.docDate, backend: stored.backend, storageKey: stored.key, mime: 'application/pdf', size: doc.data.length, pages: doc.pages, uploadedBy: me.id });
  h.history.push({ at: new Date(), by: me.id, action: `document added (${b.category})` });
  await h.save();
  res.status(201).json(d);
});

router.get('/:id/docs/:docId', validate({ params: z.object({ id: objectId, docId: objectId }) }), async (req, res) => {
  const h = await loadKhasra(req.user!, bpOf(req), req.params.id as string);
  const d = await StateLandDoc.findOne({ _id: req.params.docId, holdingRef: h._id }).lean();
  if (!d) throw notFound('Document');
  const name = `${h.holdingId.replace(/\//g, '-')} ${d.title ?? d.category}.pdf`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `${req.query.inline === 'true' ? 'inline' : 'attachment'}; filename="${encodeURIComponent(name)}"; filename*=UTF-8''${encodeURIComponent(name)}`);
  res.send(await getFile(d.storageKey));
});

router.delete('/:id/docs/:docId', validate({ params: z.object({ id: objectId, docId: objectId }) }), async (req, res) => {
  const me = req.user!;
  const bp = bpOf(req);
  const h: any = await loadKhasra(me, bp, req.params.id as string);
  if (!(await can(me, bp, 'state_land', h))) throw forbidden('You can view this khasra but not change it');
  const d = await StateLandDoc.findOne({ _id: req.params.docId, holdingRef: h._id });
  if (!d) throw notFound('Document');
  await removeFile(d.storageKey);
  await d.deleteOne();
  h.history.push({ at: new Date(), by: me.id, action: `document removed (${d.category})` });
  await h.save();
  res.status(204).end();
});

/* ================================================================== *
 *  Excel: the (filtered) directory, khasra-wise
 * ================================================================== */
router.get('/export/xlsx', validate({ query: listQuery }), async (req, res) => {
  const me = req.user!;
  const filter = await listFilter(me, bpOf(req), q<ListQ>(req));
  const s = await slSettings(me.tenantId);
  const rows = await StateLand.find(filter).populate('unitId', 'name').populate('tehsilId', 'name').populate('litigationIds', 'caseId')
    .collation({ locale: 'en', numericOrdering: true }).sort({ tehsilId: 1, unitId: 1, murabba: 1, killa: 1, subKilla: 1 }).limit(100000).lean();
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('State Land');
  const d = (x?: Date | null) => (x ? new Date(x) : '');
  ws.addRow(['S.No', 'Tehsil', 'Mouza', 'Murabba / Mustateel', 'Killa', 'Sub-killa', 'Khasra No.', 'Khewat', 'Khatauni', 'Kanal', 'Marla', 'Feet', 'Acres', 'Category', 'Sub-type', 'Owner as per Record', 'Custodian Department', 'Land Class', 'Present Use', 'Possession', 'Encroached Acres', 'Encroachers', 'Action on Encroachment', 'Record Status', 'Mutation Nos.', 'Demarcation', 'Under Litigation', 'Litigation Cases', 'Allottee / Lessee', 'Scheme', 'Lease To', 'Award No.', 'Status', 'Last Site Visit']);
  rows.forEach((h: any, i) => ws.addRow([
    i + 1, h.tehsilId?.name, h.unitId?.name, h.murabba, h.killa, h.subKilla || '', h.khasraNo, h.khewat, h.khatauni, h.area?.kanal, h.area?.marla, h.area?.feet, h.acres,
    labelIn(s.categories, h.category), h.subType, h.ownerRecord, h.custodian, h.landClass, h.use, POSSESSION_LABEL.get(h.possession) ?? h.possession, h.encroachment?.acres ?? '', (h.encroachment?.encroachers ?? []).join('; '), h.encroachment?.action,
    RECORD_LABEL.get(h.record?.status) ?? '', h.record?.mutationNos, h.record?.demarcation === 'yes' ? 'Done' : h.record?.demarcation === 'no' ? 'Not done' : '', h.underLitigation ? 'Yes' : 'No', (h.litigationIds ?? []).map((c: any) => c.caseId).join(', '),
    h.allotment?.allottee, h.allotment?.scheme, d(h.allotment?.leaseTo), h.acquisition?.awardNo, STATUS_LABEL[h.status as string], d(h.lastVisit),
  ]));
  finishSheet(ws, { headerRow: 1, keyCols: 7 });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="state-land-directory.xlsx"');
  res.send(Buffer.from(await wb.xlsx.writeBuffer()));
});

export default router;

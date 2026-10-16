/**
 * Litigation: a central register of court cases affecting land, per jurisdiction.
 *  - one permanent case ID for the whole life of a case: <TEHSIL>-<MOUZA>-<NNNN> (serial runs per tehsil)
 *  - hearings timeline, decision, appeal; an appeal continues as the next stage of the same case
 *  - documents (camera photos → compact PDF, or uploaded PDF / JPG) stored through lib/storage
 *  - complete case file as one structured PDF
 * Entry: posts with the 'litigation' capability (Patwari, Reader, Colony Clerk, PA) on the mouza or above,
 * people granted 'litigation', and admins. Viewing: everyone within their jurisdiction.
 */
import ExcelJS from 'exceljs';
import express, { Router } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { audit } from '../../lib/notify.js';
import { getFile, putFile, removeFile } from '../../lib/storage.js';
import { atLeast, type AuthUser } from '../../middleware/auth.js';
import { objectId, q, validate } from '../../middleware/validate.js';
import { Counter, LitigationCase, LitigationDoc, Tenant, Unit } from '../../models/index.js';
import type { BP } from '../org/blueprint.js';
import { bpOf } from '../org/service.js';
import { ancestorAt, hasCap, scopeRoots } from '../revenue/access.js';
import { CATEGORY_ORDER, caseFilePdf, imagesToPdf, pdfPages } from './pdf.js';

const router = Router();
const isAdmin = (me: AuthUser) => atLeast(me.role, 'admin');

/* ---------- reference lists ---------- */
export const COURTS: { group: string; items: [string, string][] }[] = [
  { group: 'Revenue Courts', items: [['naib_tehsildar', 'Naib Tehsildar'], ['tehsildar', 'Tehsildar'], ['ac', 'Assistant Commissioner'], ['adc_rev', 'ADC (Revenue)'], ['dc', 'Deputy Commissioner'], ['addl_commissioner_rev', 'Additional Commissioner (Revenue)'], ['addl_commissioner_cons', 'Additional Commissioner (Consolidation)'], ['commissioner', 'Commissioner']] },
  { group: 'Board of Revenue', items: [['member_judicial', 'Member Judicial-BOR'], ['member_colonies', 'Member Colonies-BOR'], ['senior_member', 'Senior Member-BOR'], ['full_board', 'Full Board-BOR']] },
  { group: 'Civil / Judicial Courts', items: [['civil_court', 'Civil Court'], ['senior_civil_judge', 'Senior Civil Judge'], ['addl_district_judge', 'Additional District & Sessions Judge'], ['district_judge', 'District & Sessions Judge'], ['high_court', 'High Court'], ['supreme_court', 'Supreme Court']] },
  { group: 'Other', items: [['ombudsman', 'Ombudsman'], ['other', 'Other']] },
];
const COURT_LABEL = new Map(COURTS.flatMap((g) => g.items));
const courtName = (code?: string | null, other?: string | null) => (code === 'other' ? other || 'Other' : COURT_LABEL.get(code ?? '') ?? code ?? '');
const DEFAULT_TYPES = ['Partition', 'Correction of record (Fard Badar)', 'Mutation / review of mutation', 'Demarcation', 'Possession / ejectment', 'Declaration', 'Injunction', 'Encroachment / state land', 'Colony / allotment', 'Consolidation', 'Inheritance', 'Lease', 'Writ petition', 'Revision', 'Review', 'Appeal', 'Execution', 'Contempt', 'Other'];
const CATS = CATEGORY_ORDER.map((c) => c[0]) as [string, ...string[]];

async function settings(tenantId: string) {
  const t = await Tenant.findById(tenantId).select('litigation').lean();
  const l: any = t?.litigation ?? {};
  return { caseTypes: (l.caseTypes?.length ? l.caseTypes : DEFAULT_TYPES) as string[], appealDays: (l.appealDays ?? {}) as Record<string, number> };
}

/* ---------- abbreviations for the case ID ---------- */
const clean = (s: string) => s.replace(/\(test\)/gi, '').replace(/^\s*mouza\s+/i, '').trim();
function abbreviate(name: string, type: 'tehsil' | 'mouza') {
  const n = clean(name).toUpperCase();
  const words = n.split(/[^A-Z0-9]+/).filter(Boolean);
  if (type === 'mouza') return (words.join('').slice(0, 6) || 'M');
  if (words.length > 1) return words.map((w) => w[0]).join('').slice(0, 4);
  const w = words[0] ?? 'T';
  return (w[0] + w.slice(1).replace(/[AEIOU]/g, '')).slice(0, 3).padEnd(3, w[1] ?? 'X');
}
/** The unit's own code if set, otherwise a generated abbreviation saved on the unit (kept unique per level). */
async function codeOf(unit: { _id: Types.ObjectId; name: string; type: string; code?: string | null }, kind: 'tehsil' | 'mouza') {
  const own = (unit.code ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  if (own.length >= 2) return own; // a one-letter code is too vague for a case ID
  if (own) return abbreviate(unit.name, kind);
  const base = abbreviate(unit.name, kind);
  let code = base;
  for (let i = 2; await Unit.exists({ type: unit.type, code, _id: { $ne: unit._id } }); i++) code = `${base}${i}`;
  await Unit.updateOne({ _id: unit._id }, { code });
  return code;
}

/* ---------- access ---------- */
const canEnterOn = (me: AuthUser, bp: BP, unit: { anc: Types.ObjectId[] }) => (isAdmin(me) ? Promise.resolve(true) : hasCap(me, bp, 'litigation', unit));
async function scopeFilter(me: AuthUser, bp: BP) {
  if (isAdmin(me)) return {};
  return { anc: { $in: await scopeRoots(me, bp) } };
}
async function loadCase(me: AuthUser, bp: BP, id: string) {
  const c = await LitigationCase.findOne({ _id: id, deleted: { $ne: true } });
  if (!c) throw notFound('Case');
  if (!isAdmin(me)) {
    const roots = (await scopeRoots(me, bp)).map(String);
    if (!c.anc.some((a) => roots.includes(String(a)))) throw forbidden('This case is outside your jurisdiction');
  }
  return c;
}
async function mustEdit(me: AuthUser, bp: BP, c: any) {
  if (!(await canEnterOn(me, bp, c))) throw forbidden('You can view this case but not change it');
}

/** Keep the summary fields in line with the hearings timeline. */
function syncHearings(c: any) {
  const hs = [...c.hearings].sort((a: any, b: any) => +new Date(a.date) - +new Date(b.date));
  const last = hs[hs.length - 1];
  c.lastHearing = last?.date ?? null;
  c.lastProceedings = last?.proceedingsDone ?? '';
  c.nextAction = last?.nextAction ?? '';
  if (last?.nextDate) c.nextHearing = last.nextDate;
  if (c.status === 'decided') c.nextHearing = null;
}

/* ================================================================== *
 *  Reference data
 * ================================================================== */
router.get('/meta', async (req, res) => {
  const s = await settings(req.user!.tenantId);
  res.json({ courts: COURTS, caseTypes: s.caseTypes, appealDays: s.appealDays, categories: CATEGORY_ORDER.map(([key, label]) => ({ key, label })), canEnter: isAdmin(req.user!) || (await hasCap(req.user!, bpOf(req), 'litigation')) });
});

router.put('/settings', validate({ body: z.object({ caseTypes: z.array(z.string().trim().min(1).max(120)).max(100).optional(), appealDays: z.record(z.string(), z.number().int().min(0).max(3650)).optional() }) }), async (req, res) => {
  if (!isAdmin(req.user!)) throw forbidden();
  const set: Record<string, unknown> = {};
  if (req.body.caseTypes) set['litigation.caseTypes'] = req.body.caseTypes;
  if (req.body.appealDays) set['litigation.appealDays'] = req.body.appealDays;
  await Tenant.updateOne({ _id: req.user!.tenantId }, { $set: set });
  res.json(await settings(req.user!.tenantId));
});

/** Mouzas the user may enter cases for (optionally searched). */
router.get('/mouzas', validate({ query: z.object({ search: z.string().max(60).optional() }) }), async (req, res) => {
  const me = req.user!;
  const bp = bpOf(req);
  const { search } = q<{ search?: string }>(req);
  const filter: Record<string, unknown> = { type: 'mouza' };
  if (!isAdmin(me)) filter.anc = { $in: await scopeRoots(me, bp) };
  if (search) filter.name = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  const mouzas = await Unit.find(filter).select('name anc type').sort({ name: 1 }).limit(300).lean();
  const out = [];
  for (const m of mouzas) if (await canEnterOn(me, bp, m as any)) out.push(m);
  const tehsils = new Map((await Unit.find({ _id: { $in: out.map((m) => ancestorAt(bp, m as any, 'tehsil')).filter(Boolean) } }).select('name').lean()).map((t) => [String(t._id), t.name]));
  res.json(out.map((m) => ({ _id: m._id, name: m.name, tehsil: tehsils.get(String(ancestorAt(bp, m as any, 'tehsil'))) })));
});

/* ================================================================== *
 *  Cases
 * ================================================================== */
const listQuery = z.object({
  search: z.string().max(100).optional(), unitId: objectId.optional(), status: z.enum(['pending', 'decided']).optional(), court: z.string().max(40).optional(), caseType: z.string().max(120).optional(),
  hearingFrom: z.string().optional(), hearingTo: z.string().optional(), page: z.coerce.number().int().min(1).default(1),
});

async function listFilter(me: AuthUser, bp: BP, f: z.infer<typeof listQuery>) {
  const filter: Record<string, unknown> = { deleted: { $ne: true }, ...(await scopeFilter(me, bp)) };
  if (f.unitId) filter.anc = Array.isArray((filter.anc as any)?.$in) ? { $all: [new Types.ObjectId(f.unitId)], $in: (filter.anc as any).$in } : new Types.ObjectId(f.unitId);
  if (f.status) filter.status = f.status;
  if (f.court) filter.court = f.court;
  if (f.caseType) filter.caseType = f.caseType;
  if (f.hearingFrom || f.hearingTo) filter.nextHearing = { ...(f.hearingFrom ? { $gte: new Date(f.hearingFrom) } : {}), ...(f.hearingTo ? { $lte: new Date(`${f.hearingTo}T23:59:59`) } : {}) };
  if (f.search) {
    const rx = new RegExp(f.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [{ caseId: rx }, { applicants: rx }, { respondents: rx }, { courtCaseNo: rx }, { 'land.khasraNos': rx }];
  }
  return filter;
}

router.get('/', validate({ query: listQuery }), async (req, res) => {
  const me = req.user!;
  const bp = bpOf(req);
  const f = q<z.infer<typeof listQuery>>(req);
  const filter = await listFilter(me, bp, f);
  const [items, total] = await Promise.all([
    LitigationCase.find(filter).select('caseId unitId caseType court courtOther applicants respondents nextHearing lastHearing status stage decision appeal updatedAt').populate('unitId', 'name').sort({ status: 1, nextHearing: 1, updatedAt: -1 }).skip((f.page - 1) * 50).limit(50).lean(),
    LitigationCase.countDocuments(filter),
  ]);
  res.json({ items: items.map((c) => ({ ...c, courtName: courtName(c.court, c.courtOther) })), total, page: f.page });
});

/** Dashboard counts within the user's jurisdiction. */
router.get('/dashboard', async (req, res) => {
  const me = req.user!;
  const bp = bpOf(req);
  const base = { deleted: { $ne: true }, ...(await scopeFilter(me, bp)) };
  const now = new Date();
  const day = 86_400_000;
  const s = await settings(me.tenantId);
  const [total, pending, decided, thisWeek, overdue, decidedNoAppeal] = await Promise.all([
    LitigationCase.countDocuments(base),
    LitigationCase.countDocuments({ ...base, status: 'pending' }),
    LitigationCase.countDocuments({ ...base, status: 'decided' }),
    LitigationCase.countDocuments({ ...base, status: 'pending', nextHearing: { $gte: new Date(now.toDateString()), $lt: new Date(+new Date(now.toDateString()) + 7 * day) } }),
    LitigationCase.countDocuments({ ...base, status: 'pending', nextHearing: { $lt: new Date(+now - 2 * day) } }),
    LitigationCase.find({ ...base, status: 'decided', 'appeal.filed': 'undecided' }).select('court decision caseId').lean(),
  ]);
  // Appeal watch: only courts whose appeal period the admin has set
  const appealDue = decidedNoAppeal
    .map((c) => ({ caseId: c.caseId, _id: c._id, days: s.appealDays[c.court] ? s.appealDays[c.court] - Math.floor((+now - +new Date(c.decision?.date ?? now)) / day) : null }))
    .filter((x) => x.days != null && x.days >= 0 && x.days <= 15);
  res.json({ total, pending, decided, thisWeek, overdue, appealDue, decidedNoAppeal: decidedNoAppeal.length });
});

const caseBody = z.object({
  unitId: objectId,
  caseType: z.string().trim().min(1).max(120),
  institutedOn: z.coerce.date(),
  court: z.string().max(40),
  courtOther: z.string().trim().max(200).optional(),
  bench: z.string().trim().max(200).optional(),
  courtCaseNo: z.string().trim().max(100).optional(),
  applicants: z.array(z.string().trim().min(1).max(200)).min(1).max(50),
  respondents: z.array(z.string().trim().min(1).max(200)).min(1).max(50),
  land: z.object({ kanal: z.number().min(0).max(1e7).optional(), marla: z.number().min(0).max(1e7).optional(), sarsai: z.number().min(0).max(1e7).optional(), khasraNos: z.array(z.string().trim().max(40)).max(200).default([]), khewat: z.string().max(60).optional(), khatauni: z.string().max(60).optional() }).default({ khasraNos: [] }),
  landSpec: z.string().trim().max(1000).optional(),
  governmentParty: z.boolean().default(false),
  nextHearing: z.coerce.date().nullish(),
  note: z.string().trim().max(3000).optional(),
});
const checkCourt = (court: string, other?: string) => {
  if (!COURT_LABEL.has(court)) throw badRequest('Choose a court from the list');
  if (court === 'other' && !other) throw badRequest('Write the name of the court');
};

router.post('/', validate({ body: caseBody }), async (req, res) => {
  const me = req.user!;
  const bp = bpOf(req);
  const b = req.body as z.infer<typeof caseBody>;
  checkCourt(b.court, b.courtOther);
  const mouza = await Unit.findById(b.unitId).select('name type anc code').lean();
  if (!mouza || mouza.type !== 'mouza') throw badRequest('Choose a mouza');
  if (!(await canEnterOn(me, bp, mouza as any))) throw forbidden('You cannot enter cases for this mouza');
  const tehsilId = ancestorAt(bp, mouza as any, 'tehsil');
  const tehsil = tehsilId ? await Unit.findById(tehsilId).select('name type code').lean() : null;
  // Possible duplicate: same court case number, or same parties on the same mouza
  const dup = await LitigationCase.findOne({ deleted: { $ne: true }, $or: [...(b.courtCaseNo ? [{ courtCaseNo: b.courtCaseNo, court: b.court }] : []), { unitId: mouza._id, applicants: b.applicants[0], respondents: b.respondents[0], caseType: b.caseType }] }).select('caseId').lean();
  if (dup && req.query.force !== 'true') return res.status(409).json({ error: { code: 'POSSIBLE_DUPLICATE', message: `Possible duplicate of ${dup.caseId}`, details: { caseId: dup.caseId, id: dup._id } } });
  // Serial per tehsil, allocated atomically
  const counter = await Counter.findOneAndUpdate({ key: `litigation:${tehsilId ?? 'none'}` }, { $inc: { seq: 1 } }, { upsert: true, new: true });
  const caseId = `${tehsil ? await codeOf(tehsil as any, 'tehsil') : 'X'}-${await codeOf(mouza as any, 'mouza')}-${String(counter!.seq).padStart(4, '0')}`;
  const c = await LitigationCase.create({
    ...b, caseId, serial: counter!.seq, anc: mouza.anc, tehsilId, stage: 1, createdBy: me.id, updatedBy: me.id,
    history: [{ at: new Date(), by: me.id, action: 'created' }],
  });
  await audit('litigation.create', 'LitigationCase', c._id, { caseId });
  res.status(201).json(c);
});

router.get('/:id', validate({ params: z.object({ id: objectId }) }), async (req, res) => {
  const me = req.user!;
  const bp = bpOf(req);
  const c = await loadCase(me, bp, req.params.id as string);
  await c.populate([{ path: 'unitId', select: 'name' }, { path: 'createdBy', select: 'name' }, { path: 'updatedBy', select: 'name' }, { path: 'notes.by', select: 'name' }, { path: 'history.by', select: 'name' }, { path: 'hearings.by', select: 'name' }]);
  const [docs, tehsil, s] = await Promise.all([
    LitigationDoc.find({ caseRef: c._id }).populate('uploadedBy', 'name').sort({ category: 1, docDate: 1, createdAt: 1 }).lean(),
    c.tehsilId ? Unit.findById(c.tehsilId).select('name').lean() : null,
    settings(me.tenantId),
  ]);
  const appealDays = s.appealDays[c.court];
  const appealDeadline = c.status === 'decided' && c.decision?.date && appealDays ? new Date(+c.decision.date + appealDays * 86_400_000) : null;
  res.json({ case: c, courtName: courtName(c.court, c.courtOther), tehsil: tehsil?.name, docs, canEdit: await canEnterOn(me, bp, c as any), appealDeadline });
});

const patchBody = caseBody.omit({ unitId: true }).partial().extend({
  status: z.enum(['pending', 'decided']).optional(),
  decision: z.object({ date: z.coerce.date().nullish(), result: z.string().max(200).optional(), summary: z.string().max(3000).optional() }).optional(),
  appeal: z.object({ filed: z.enum(['yes', 'no', 'undecided']), court: z.string().max(40).optional(), courtOther: z.string().max(200).optional(), filedOn: z.coerce.date().nullish(), appealNo: z.string().max(100).optional(), reasonNotFiled: z.string().max(1000).optional() }).optional(),
});

router.patch('/:id', validate({ params: z.object({ id: objectId }), body: patchBody }), async (req, res) => {
  const me = req.user!;
  const bp = bpOf(req);
  const c: any = await loadCase(me, bp, req.params.id as string);
  await mustEdit(me, bp, c);
  const b = req.body as z.infer<typeof patchBody>;
  if (b.court) checkCourt(b.court, b.courtOther ?? c.courtOther);
  const next = { ...c.toObject(), ...b };
  if (next.status === 'decided' && !(b.decision?.date ?? c.decision?.date)) throw badRequest('Enter the date of decision');
  const ap = b.appeal ?? c.appeal;
  if (ap?.filed === 'yes' && !ap.court) throw badRequest('Choose the appellate court');
  if (ap?.filed === 'yes' && ap.court === 'other' && !ap.courtOther) throw badRequest('Write the name of the appellate court');
  if (ap?.filed === 'no' && !ap.reasonNotFiled) throw badRequest('Give the reason for not filing an appeal');
  c.set({ ...b, updatedBy: me.id });
  if (c.status === 'pending') c.set('decision', {});
  syncHearings(c);
  c.history.push({ at: new Date(), by: me.id, action: 'updated', fields: Object.keys(b) });
  await c.save();
  res.json(c);
});

router.delete('/:id', validate({ params: z.object({ id: objectId }) }), async (req, res) => {
  const me = req.user!;
  const bp = bpOf(req);
  const c: any = await loadCase(me, bp, req.params.id as string);
  if (!isAdmin(me)) throw forbidden('Only an administrator can remove a case');
  c.set({ deleted: true, updatedBy: me.id });
  c.history.push({ at: new Date(), by: me.id, action: 'removed' });
  await c.save();
  await audit('litigation.remove', 'LitigationCase', c._id, { caseId: c.caseId });
  res.status(204).end();
});

/* ---------- hearings: one continuing record per case ---------- */
const hearingBody = z.object({ date: z.coerce.date(), court: z.string().max(40).optional(), proceedingsDone: z.string().trim().max(3000).optional(), nextAction: z.string().trim().max(3000).optional(), nextDate: z.coerce.date().nullish(), attendedBy: z.string().trim().max(200).optional() });

router.post('/:id/hearings', validate({ params: z.object({ id: objectId }), body: hearingBody }), async (req, res) => {
  const me = req.user!;
  const bp = bpOf(req);
  const c: any = await loadCase(me, bp, req.params.id as string);
  await mustEdit(me, bp, c);
  const h = req.body as z.infer<typeof hearingBody>;
  if (h.nextDate && h.nextDate < h.date) throw badRequest('The next date must be after the hearing date');
  c.hearings.push({ ...h, court: h.court ?? c.court, by: me.id });
  syncHearings(c);
  c.history.push({ at: new Date(), by: me.id, action: 'hearing added' });
  await c.save();
  res.json(c);
});

router.patch('/:id/hearings/:hid', validate({ params: z.object({ id: objectId, hid: objectId }), body: hearingBody.partial() }), async (req, res) => {
  const me = req.user!;
  const bp = bpOf(req);
  const c: any = await loadCase(me, bp, req.params.id as string);
  await mustEdit(me, bp, c);
  const h = c.hearings.id(req.params.hid);
  if (!h) throw notFound('Hearing');
  h.set(req.body);
  syncHearings(c);
  c.history.push({ at: new Date(), by: me.id, action: 'hearing edited' });
  await c.save();
  res.json(c);
});

router.delete('/:id/hearings/:hid', validate({ params: z.object({ id: objectId, hid: objectId }) }), async (req, res) => {
  const me = req.user!;
  const bp = bpOf(req);
  const c: any = await loadCase(me, bp, req.params.id as string);
  await mustEdit(me, bp, c);
  c.hearings.pull({ _id: req.params.hid });
  syncHearings(c);
  c.history.push({ at: new Date(), by: me.id, action: 'hearing removed' });
  await c.save();
  res.json(c);
});

/* ---------- appeal continues as the next stage of the same case ---------- */
router.post('/:id/appeal-stage', validate({ params: z.object({ id: objectId }), body: z.object({ court: z.string().max(40), courtOther: z.string().max(200).optional(), bench: z.string().max(200).optional(), courtCaseNo: z.string().max(100).optional(), filedOn: z.coerce.date(), nextHearing: z.coerce.date().nullish() }) }), async (req, res) => {
  const me = req.user!;
  const bp = bpOf(req);
  const c: any = await loadCase(me, bp, req.params.id as string);
  await mustEdit(me, bp, c);
  const b = req.body;
  checkCourt(b.court, b.courtOther);
  if (c.status !== 'decided') throw badRequest('Record the decision of the current court first');
  c.stages.push({ stage: c.stage, court: c.court, courtOther: c.courtOther, bench: c.bench, courtCaseNo: c.courtCaseNo, institutedOn: c.institutedOn, decidedOn: c.decision?.date, result: c.decision?.result, summary: c.decision?.summary });
  c.set({
    stage: c.stage + 1, court: b.court, courtOther: b.courtOther, bench: b.bench, courtCaseNo: b.courtCaseNo, institutedOn: b.filedOn,
    status: 'pending', decision: {}, nextHearing: b.nextHearing ?? null,
    appeal: { filed: 'undecided' }, updatedBy: me.id,
  });
  c.history.push({ at: new Date(), by: me.id, action: `appeal stage ${c.stage} in ${courtName(b.court, b.courtOther)}` });
  await c.save();
  res.json(c);
});

router.post('/:id/notes', validate({ params: z.object({ id: objectId }), body: z.object({ text: z.string().trim().min(1).max(2000) }) }), async (req, res) => {
  const me = req.user!;
  const c: any = await loadCase(me, bpOf(req), req.params.id as string);
  c.notes.push({ text: req.body.text, by: me.id, at: new Date() });
  await c.save();
  res.json(c);
});

/* ================================================================== *
 *  Documents
 * ================================================================== */
const MAX_FILE = 10 * 1024 * 1024;
const docBody = z.object({
  category: z.enum(CATS),
  title: z.string().trim().max(200).optional(),
  docDate: z.coerce.date().nullish(),
  /** Either several page photos (combined into one PDF) or one PDF / image file. */
  files: z.array(z.object({ name: z.string().max(200), mime: z.string().max(100), data: z.string() })).min(1).max(40),
});
const sniff = (b: Buffer) => (b.subarray(0, 4).toString() === '%PDF' ? 'application/pdf' : b[0] === 0xff && b[1] === 0xd8 ? 'image/jpeg' : b[0] === 0x89 && b.subarray(1, 4).toString() === 'PNG' ? 'image/png' : null);

router.post('/:id/docs', express.json({ limit: '40mb' }), validate({ params: z.object({ id: objectId }), body: docBody }), async (req, res) => {
  const me = req.user!;
  const bp = bpOf(req);
  const c: any = await loadCase(me, bp, req.params.id as string);
  await mustEdit(me, bp, c);
  const b = req.body as z.infer<typeof docBody>;
  const files = b.files.map((f) => {
    const data = Buffer.from(f.data, 'base64');
    const mime = sniff(data); // trust the content, not the extension
    if (!mime) throw badRequest(`${f.name}: only PDF, JPG or PNG files are accepted`);
    if (data.length > MAX_FILE) throw badRequest(`${f.name} is larger than 10 MB`);
    return { name: f.name, mime, data };
  });
  const pdfs = files.filter((f) => f.mime === 'application/pdf');
  if (pdfs.length && files.length > 1) throw badRequest('Upload one PDF at a time, or several photos together');
  // Photos become one compact PDF document; a PDF is kept as uploaded
  let doc: { data: Buffer; pages: number };
  try {
    doc = pdfs.length ? { data: pdfs[0].data, pages: await pdfPages(pdfs[0].data) } : await imagesToPdf(files);
  } catch {
    throw badRequest('The file could not be read — take the photo again or upload another file');
  }
  const stored = await putFile(doc.data, `${c.caseId}-${b.category}.pdf`, 'application/pdf', { tenantId: me.tenantId, caseId: c.caseId });
  const d = await LitigationDoc.create({ caseRef: c._id, stage: c.stage, category: b.category, title: b.title, docDate: b.docDate, backend: stored.backend, storageKey: stored.key, mime: 'application/pdf', size: doc.data.length, pages: doc.pages, uploadedBy: me.id });
  c.history.push({ at: new Date(), by: me.id, action: `document added (${b.category})` });
  await c.save();
  res.status(201).json(d);
});

const sendPdf = (res: express.Response, name: string, data: Buffer, inline = false) => {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${encodeURIComponent(name)}"; filename*=UTF-8''${encodeURIComponent(name)}`);
  res.send(data);
};

router.get('/:id/docs/:docId', validate({ params: z.object({ id: objectId, docId: objectId }) }), async (req, res) => {
  const c = await loadCase(req.user!, bpOf(req), req.params.id as string);
  const d = await LitigationDoc.findOne({ _id: req.params.docId, caseRef: c._id }).lean();
  if (!d) throw notFound('Document');
  sendPdf(res, `${c.caseId} ${d.title ?? d.category}.pdf`, await getFile(d.storageKey), req.query.inline === 'true');
});

router.delete('/:id/docs/:docId', validate({ params: z.object({ id: objectId, docId: objectId }) }), async (req, res) => {
  const me = req.user!;
  const bp = bpOf(req);
  const c: any = await loadCase(me, bp, req.params.id as string);
  await mustEdit(me, bp, c);
  const d = await LitigationDoc.findOne({ _id: req.params.docId, caseRef: c._id });
  if (!d) throw notFound('Document');
  await removeFile(d.storageKey);
  await d.deleteOne();
  c.history.push({ at: new Date(), by: me.id, action: `document removed (${d.category})` });
  await c.save();
  res.status(204).end();
});

/** The complete case file as one structured PDF. */
router.get('/:id/pdf', validate({ params: z.object({ id: objectId }) }), async (req, res) => {
  const c: any = await loadCase(req.user!, bpOf(req), req.params.id as string);
  const [mouza, tehsil, docs] = await Promise.all([Unit.findById(c.unitId).select('name').lean(), c.tehsilId ? Unit.findById(c.tehsilId).select('name').lean() : null, LitigationDoc.find({ caseRef: c._id }).sort({ docDate: 1, createdAt: 1 }).lean()]);
  const withData = await Promise.all(docs.map(async (d) => ({ category: d.category, title: d.title ?? undefined, docDate: d.docDate ?? undefined, data: await getFile(d.storageKey) })));
  const out = await caseFilePdf(c.toObject(), { mouza: mouza?.name, tehsil: tehsil?.name, courtName }, withData);
  sendPdf(res, `Case ${c.caseId}.pdf`, out);
});

/** The (filtered) list as Excel. */
router.get('/export/xlsx', validate({ query: listQuery }), async (req, res) => {
  const me = req.user!;
  const bp = bpOf(req);
  const filter = await listFilter(me, bp, q<z.infer<typeof listQuery>>(req));
  const rows = await LitigationCase.find(filter).populate('unitId', 'name').populate('tehsilId', 'name').sort({ caseId: 1 }).limit(20000).lean();
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Litigation');
  const head = ['S.No', 'Case ID', 'Tehsil', 'Mouza', 'Type of Case', 'Date of Institution', 'Court', 'Court Case No.', 'Applicant(s)', 'Respondent(s)', 'Kanal', 'Marla', 'Sarsai', 'Khasra Nos.', 'Land Specification', 'Last Hearing', 'Next Hearing', 'Proceedings (Last Date)', 'To Be Done (Next Date)', 'Status', 'Date of Decision', 'Appeal', 'Appellate Court', 'Reason Appeal Not Filed', 'Note'];
  const h = ws.addRow(head);
  h.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  h.eachCell((cl) => { cl.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF187A43' } }; });
  const d = (x?: Date | null) => (x ? new Date(x) : '');
  rows.forEach((c: any, i) => ws.addRow([i + 1, c.caseId, c.tehsilId?.name, c.unitId?.name, c.caseType, d(c.institutedOn), courtName(c.court, c.courtOther), c.courtCaseNo, c.applicants.join('; '), c.respondents.join('; '), c.land?.kanal, c.land?.marla, c.land?.sarsai, (c.land?.khasraNos ?? []).join(', '), c.landSpec, d(c.lastHearing), d(c.nextHearing), c.lastProceedings, c.nextAction, c.status === 'decided' ? 'Decided' : 'Pending', d(c.decision?.date), c.appeal?.filed === 'yes' ? 'Filed' : c.appeal?.filed === 'no' ? 'Not filed' : '', c.appeal?.filed === 'yes' ? courtName(c.appeal.court, c.appeal.courtOther) : '', c.appeal?.reasonNotFiled, c.note]));
  ws.columns.forEach((col) => { col.width = 16; });
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="litigation.xlsx"');
  res.send(Buffer.from(await wb.xlsx.writeBuffer()));
});

export default router;

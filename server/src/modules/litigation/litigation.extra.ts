/**
 * Litigation, phase 2: cause list, ZIP of documents, settings (case types, appeal periods), Excel import
 * of existing registers, and daily reminders (hearings tomorrow / today, overdue updates, appeal periods).
 * Mounted before the main litigation router so its fixed paths are not taken for case ids.
 */
import ExcelJS from 'exceljs';
import express, { Router } from 'express';
import JSZip from 'jszip';
import { Types } from 'mongoose';
import { z } from 'zod';
import { badRequest, forbidden } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { audit, notify } from '../../lib/notify.js';
import { defineJob, enqueue, schedule } from '../../lib/queue.js';
import { getFile } from '../../lib/storage.js';
import { runAsTenant, runUnscoped } from '../../lib/tenantContext.js';
import { atLeast } from '../../middleware/auth.js';
import { objectId, q, validate } from '../../middleware/validate.js';
import { Charge, Counter, LitigationCase, LitigationDoc, Tenant, Unit, User } from '../../models/index.js';
import { bpOf, getBlueprint } from '../org/service.js';
import { activeFilter, ancestorAt, hasCap } from '../revenue/access.js';
import { queueMessage } from '../whatsapp/engine.js';
import { COURTS, canEnterOn, codeOf, courtName, loadCase, scopeFilter, settings } from './litigation.routes.js';
import { CATEGORY_ORDER } from './pdf.js';

const router = Router();
const DAY = 86_400_000;
const day0 = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

/* ================================================================== *
 *  Cause list: pending cases by next hearing date
 * ================================================================== */
router.get('/causelist', validate({ query: z.object({ from: z.string().optional(), to: z.string().optional(), unitId: objectId.optional() }) }), async (req, res) => {
  const me = req.user!;
  const bp = bpOf(req);
  const { from, to, unitId } = q<{ from?: string; to?: string; unitId?: string }>(req);
  const start = from ? new Date(from) : day0(new Date());
  const end = to ? new Date(`${to}T23:59:59`) : new Date(+start + 14 * DAY - 1);
  const filter: Record<string, unknown> = { deleted: { $ne: true }, status: 'pending', nextHearing: { $gte: start, $lte: end }, ...(await scopeFilter(me, bp)) };
  if (unitId) filter.anc = Array.isArray((filter.anc as any)?.$in) ? { $all: [new Types.ObjectId(unitId)], $in: (filter.anc as any).$in } : new Types.ObjectId(unitId);
  const rows = await LitigationCase.find(filter).select('caseId unitId tehsilId court courtOther bench courtCaseNo applicants respondents nextHearing nextAction caseType').populate('unitId', 'name').populate('tehsilId', 'name').sort({ nextHearing: 1, court: 1 }).limit(2000).lean();
  res.json({ from: start, to: end, items: rows.map((c: any) => ({ ...c, courtName: courtName(c.court, c.courtOther) })) });
});

/* ================================================================== *
 *  Suggestions: values already used in the user's jurisdiction, so entries stay uniform
 * ================================================================== */
router.get('/suggest', async (req, res) => {
  const base = { deleted: { $ne: true }, ...(await scopeFilter(req.user!, bpOf(req))) };
  const fields = ['caseType', 'bench', 'landSpec', 'applicants', 'respondents', 'land.murabba', 'decision.result', 'hearings.nextAction', 'hearings.proceedingsDone', 'hearings.attendedBy'] as const;
  const top = (f: string) => LitigationCase.aggregate([
    { $match: base },
    { $sort: { updatedAt: -1 } },
    { $limit: 2000 },
    ...(f.includes('.') && f.split('.')[0] === 'hearings' ? [{ $unwind: '$hearings' }] : []),
    ...(['applicants', 'respondents'].includes(f) ? [{ $unwind: `$${f}` }] : []),
    { $group: { _id: `$${f}`, n: { $sum: 1 } } },
    { $match: { _id: { $nin: [null, ''] } } },
    { $sort: { n: -1 } },
    { $limit: 200 },
  ]);
  const out = await Promise.all(fields.map(top));
  res.json(Object.fromEntries(fields.map((f, i) => [f, out[i].map((x) => String(x._id))])));
});

/* ================================================================== *
 *  Monitoring: where the cases are and what needs attention
 * ================================================================== */
router.get('/stats', async (req, res) => {
  const me = req.user!;
  const bp = bpOf(req);
  const base = { deleted: { $ne: true }, ...(await scopeFilter(me, bp)) };
  const group = (key: string) => LitigationCase.aggregate([
    { $match: base },
    { $group: { _id: key, total: { $sum: 1 }, pending: { $sum: { $cond: [{ $eq: ['$status', 'pending'] }, 1, 0] } }, decided: { $sum: { $cond: [{ $eq: ['$status', 'decided'] }, 1, 0] } } } },
    { $sort: { pending: -1, total: -1 } },
  ]);
  const [byCourt, byType, byTehsil, oldest, noHearing, againstGovt] = await Promise.all([
    group('$court'),
    group('$caseType'),
    group('$tehsilId'),
    LitigationCase.find({ ...base, status: 'pending' }).select('caseId institutedOn court courtOther unitId nextHearing').populate('unitId', 'name').sort({ institutedOn: 1 }).limit(10).lean(),
    LitigationCase.find({ ...base, status: 'pending', $or: [{ nextHearing: null }, { nextHearing: { $exists: false } }] }).select('caseId unitId court courtOther institutedOn').populate('unitId', 'name').sort({ institutedOn: 1 }).limit(50).lean(),
    LitigationCase.find({ ...base, status: 'decided', 'decision.result': /against government/i, 'appeal.filed': 'undecided' }).select('caseId unitId court courtOther decision').populate('unitId', 'name').sort({ 'decision.date': -1 }).limit(50).lean(),
  ]);
  const tehsils = new Map((await Unit.find({ _id: { $in: byTehsil.map((t) => t._id).filter(Boolean) } }).select('name').lean()).map((t) => [String(t._id), t.name]));
  const now = Date.now();
  res.json({
    byCourt: byCourt.map((x) => ({ ...x, label: courtName(x._id) })),
    byType: byType.map((x) => ({ ...x, label: x._id })),
    byTehsil: byTehsil.map((x) => ({ ...x, label: tehsils.get(String(x._id)) ?? '—' })),
    oldest: oldest.map((c: any) => ({ ...c, courtName: courtName(c.court, c.courtOther), years: Math.round(((now - +new Date(c.institutedOn)) / (365.25 * DAY)) * 10) / 10 })),
    noHearing: noHearing.map((c: any) => ({ ...c, courtName: courtName(c.court, c.courtOther) })),
    againstGovt: againstGovt.map((c: any) => ({ ...c, courtName: courtName(c.court, c.courtOther) })),
  });
});

/* ================================================================== *
 *  Settings: case types and appeal periods (admins)
 * ================================================================== */
router.get('/settings', async (req, res) => {
  const s = await settings(req.user!.tenantId);
  res.json({ ...s, courts: COURTS });
});

/* ================================================================== *
 *  Excel import of existing litigation registers
 * ================================================================== */
const COLS = ['Tehsil', 'Mouza', 'Type of Case', 'Date of Institution', 'Court', 'Court Case No.', 'Applicant(s)', 'Respondent(s)', 'Kanal', 'Marla', 'Sarsai', 'Mustateel / Murabba', 'Khasra Nos.', 'Land Specification', 'Last Hearing', 'Next Hearing', 'Proceedings (Last Date)', 'To Be Done (Next Date)', 'Status', 'Date of Decision', 'Appeal', 'Appellate Court', 'Reason Appeal Not Filed', 'Note'];

router.get('/import/template', async (_req, res) => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Litigation');
  const h = ws.addRow(COLS);
  h.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  h.eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF187A43' } }; });
  ws.addRow(['Hasilpur', 'Chak 12', 'Partition', '2024-05-10', 'Civil Court', 'CS-123', 'Ali Ahmad; Bashir', 'Province of Punjab', 4, 10, '', '45', '45/2, 46', 'State land, nehri', '2026-10-01', '2026-11-20', 'Reply filed', 'Arguments', 'Pending', '', '', '', '', '']);
  const list = wb.addWorksheet('Courts');
  list.addRow(['Court names to use']);
  COURTS.flatMap((g) => g.items).forEach(([, l]) => list.addRow([l]));
  ws.columns.forEach((c) => { c.width = 18; });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="litigation-import-template.xlsx"');
  res.send(Buffer.from(await wb.xlsx.writeBuffer()));
});

const cellText = (v: unknown): string => (v == null ? '' : v instanceof Date ? v.toISOString().slice(0, 10) : typeof v === 'object' && 'text' in (v as any) ? String((v as any).text) : typeof v === 'object' && 'result' in (v as any) ? String((v as any).result) : String(v)).trim();
const toDate = (s: string) => {
  if (!s) return undefined;
  const m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/); // dd-mm-yyyy
  const d = m ? new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1])) : new Date(s);
  return Number.isNaN(+d) ? null : d;
};
const COURT_BY_NAME = new Map(COURTS.flatMap((g) => g.items).flatMap(([k, l]) => [[l.toLowerCase(), k], [k, k]]));

router.post('/import', express.json({ limit: '15mb' }), validate({ body: z.object({ file: z.string().min(10), dryRun: z.boolean().default(true) }) }), async (req, res) => {
  const me = req.user!;
  const bp = bpOf(req);
  if (!(atLeast(me.role, 'admin') || (await hasCap(me, bp, 'litigation')))) throw forbidden();
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(Buffer.from(req.body.file, 'base64') as any); } catch { throw badRequest('Upload the Excel template (.xlsx)'); }
  const ws = wb.worksheets[0];
  const header = (ws.getRow(1).values as unknown[]).slice(1).map((v) => cellText(v).toLowerCase());
  const col = (name: string) => header.indexOf(name.toLowerCase()) + 1;
  if (!col('Mouza') || !col('Court')) throw badRequest('Use the template: the first row must have the column names');
  const tehsils = await Unit.find({ type: 'tehsil' }).select('name code anc type').lean();
  const errors: { row: number; message: string }[] = [];
  const ok: { row: number; doc: Record<string, unknown>; mouza: any }[] = [];
  const s = await settings(me.tenantId);
  for (let r = 2; r <= ws.actualRowCount; r++) {
    const row = ws.getRow(r);
    const v = (name: string) => (col(name) ? cellText(row.getCell(col(name)).value) : '');
    if (!v('Mouza') && !v('Applicant(s)')) continue;
    const fail = (m: string) => errors.push({ row: r, message: m });
    const teh = v('Tehsil') ? tehsils.find((t) => t.name.toLowerCase() === v('Tehsil').toLowerCase() || t.code?.toLowerCase() === v('Tehsil').toLowerCase()) : null;
    if (v('Tehsil') && !teh) { fail(`Tehsil "${v('Tehsil')}" not found`); continue; }
    const mq: Record<string, unknown> = { type: 'mouza', $or: [{ name: new RegExp(`^(mouza\\s+)?${v('Mouza').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s*\\(test\\))?$`, 'i') }, { code: v('Mouza').toUpperCase() }] };
    if (teh) mq.anc = teh._id;
    const ms = await Unit.find(mq).select('name anc type code').limit(3).lean();
    if (!ms.length) { fail(`Mouza "${v('Mouza')}" not found${teh ? ` in ${teh.name}` : ''}`); continue; }
    if (ms.length > 1) { fail(`Mouza "${v('Mouza')}" exists in more than one tehsil — fill the Tehsil column`); continue; }
    const mouza = ms[0];
    if (!(await canEnterOn(me, bp, mouza as any))) { fail(`You cannot enter cases for ${mouza.name}`); continue; }
    const courtTxt = v('Court');
    const court = COURT_BY_NAME.get(courtTxt.toLowerCase()) ?? 'other';
    const inst = toDate(v('Date of Institution'));
    if (!inst) { fail('Date of Institution is missing or not a date'); continue; }
    const applicants = v('Applicant(s)').split(/[;\n]/).map((x) => x.trim()).filter(Boolean);
    const respondents = v('Respondent(s)').split(/[;\n]/).map((x) => x.trim()).filter(Boolean);
    if (!applicants.length || !respondents.length) { fail('Applicant(s) and Respondent(s) are required'); continue; }
    const decided = /^decided/i.test(v('Status'));
    const decDate = toDate(v('Date of Decision'));
    if (decided && !decDate) { fail('Decided cases need a Date of Decision'); continue; }
    const appealTxt = v('Appeal').toLowerCase();
    const appeal = /^(yes|filed)/.test(appealTxt)
      ? { filed: 'yes', court: COURT_BY_NAME.get(v('Appellate Court').toLowerCase()) ?? 'other', courtOther: COURT_BY_NAME.has(v('Appellate Court').toLowerCase()) ? undefined : v('Appellate Court') }
      : /^(no|not)/.test(appealTxt) ? { filed: 'no', reasonNotFiled: v('Reason Appeal Not Filed') || 'Not recorded' } : { filed: 'undecided' };
    const num = (x: string) => (x ? Number(x) : undefined);
    const last = toDate(v('Last Hearing'));
    const next = toDate(v('Next Hearing'));
    ok.push({
      row: r, mouza,
      doc: {
        unitId: mouza._id, anc: mouza.anc, tehsilId: ancestorAt(bp, mouza as any, 'tehsil'),
        caseType: v('Type of Case') || 'Other', institutedOn: inst, court, courtOther: court === 'other' ? courtTxt || 'Other' : undefined, courtCaseNo: v('Court Case No.') || undefined,
        applicants, respondents,
        land: { kanal: num(v('Kanal')), marla: num(v('Marla')), sarsai: num(v('Sarsai')), murabba: v('Mustateel / Murabba') || undefined, khasraNos: v('Khasra Nos.').split(/[,;]/).map((x) => x.trim()).filter(Boolean) },
        landSpec: v('Land Specification') || undefined,
        lastHearing: last ?? undefined, nextHearing: decided ? undefined : next ?? undefined,
        lastProceedings: v('Proceedings (Last Date)') || undefined, nextAction: v('To Be Done (Next Date)') || undefined,
        hearings: last ? [{ date: last, proceedingsDone: v('Proceedings (Last Date)') || undefined, nextAction: v('To Be Done (Next Date)') || undefined, nextDate: next ?? undefined, by: me.id }] : [],
        status: decided ? 'decided' : 'pending', decision: decided ? { date: decDate } : {}, appeal, note: v('Note') || undefined,
        createdBy: me.id, updatedBy: me.id, history: [{ at: new Date(), by: me.id, action: 'imported' }],
      },
    });
  }
  if (ok.length > 5000) throw badRequest('Split the file: at most 5,000 cases per import');
  if (req.body.dryRun || errors.length) return res.json({ dryRun: true, valid: ok.length, errors: errors.slice(0, 500), imported: 0 });
  let imported = 0;
  for (const x of ok) {
    const tehsilId = x.doc.tehsilId as Types.ObjectId | null;
    const tehsil = tehsilId ? tehsils.find((t) => String(t._id) === String(tehsilId)) : null;
    const counter = await Counter.findOneAndUpdate({ key: `litigation:${tehsilId ?? 'none'}` }, { $inc: { seq: 1 } }, { upsert: true, new: true });
    const caseId = `${tehsil ? await codeOf(tehsil as any, 'tehsil') : 'X'}-${await codeOf(x.mouza, 'mouza')}-${String(counter!.seq).padStart(4, '0')}`;
    await LitigationCase.create({ ...x.doc, caseId, serial: counter!.seq, stage: 1 });
    imported++;
  }
  await audit('litigation.import', 'LitigationCase', undefined, { imported });
  void s;
  res.json({ dryRun: false, valid: ok.length, errors: [], imported });
});

/* ================================================================== *
 *  ZIP of the original documents
 * ================================================================== */
router.get('/:id/zip', validate({ params: z.object({ id: objectId }) }), async (req, res) => {
  const c = await loadCase(req.user!, bpOf(req), req.params.id as string);
  const docs = await LitigationDoc.find({ caseRef: c._id }).sort({ category: 1, docDate: 1, createdAt: 1 }).lean();
  const zip = new JSZip();
  const label = new Map(CATEGORY_ORDER);
  const order = new Map(CATEGORY_ORDER.map(([k], i) => [k, i + 1]));
  for (const [i, d] of docs.entries()) {
    const folder = `${order.get(d.category)} ${label.get(d.category)}`.replace(/[\\/:*?"<>|]/g, '-');
    zip.file(`${folder}/${String(i + 1).padStart(2, '0')} ${(d.title ?? label.get(d.category) ?? 'document').replace(/[\\/:*?"<>|]/g, '-')}.pdf`, await getFile(d.storageKey));
  }
  const data = await zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' });
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="Case ${c.caseId} documents.zip"`);
  res.send(data);
});

/* ================================================================== *
 *  Reminders (daily 07:00): hearings today / tomorrow, overdue updates, appeal periods
 * ================================================================== */
async function recipientsFor(c: { anc: Types.ObjectId[]; createdBy?: unknown }, litigationPosts: string[]) {
  const holders = await Charge.find({ unitId: { $in: c.anc }, post: { $in: litigationPosts }, ...activeFilter() }).distinct('userId');
  return [...new Set([...holders.map(String), ...(c.createdBy ? [String(c.createdBy)] : [])])];
}

export async function runLitigationReminders(tenantId: string, now = new Date()) {
  const bp = await getBlueprint(tenantId);
  if (!bp) return { sent: 0 };
  const posts = bp.postsWithCap('litigation');
  const t = await Tenant.findById(tenantId).select('whatsapp litigation').lean();
  const wa = !!(t?.whatsapp as any)?.enabled;
  const today = day0(now);
  const tomorrow = new Date(+today + DAY);
  const s = await settings(tenantId);
  let sent = 0;
  const tell = async (userIds: string[], title: string, body: string, link: string) => {
    if (!userIds.length) return;
    await notify(userIds, { type: 'litigation.reminder', title, body, link });
    if (wa) {
      const users = await User.find({ _id: { $in: userIds }, phoneE164: { $exists: true }, whatsappOptOut: { $ne: true } }).select('phoneE164').lean();
      for (const u of users) await queueMessage(tenantId, { userId: String(u._id), phone: u.phoneE164!, kind: 'litigation', text: `*${title}*\n${body}` });
    }
    sent += userIds.length;
  };
  // Hearings today and tomorrow
  const soon = await LitigationCase.find({ deleted: { $ne: true }, status: 'pending', nextHearing: { $gte: today, $lt: new Date(+tomorrow + DAY) } }).select('caseId anc createdBy nextHearing court courtOther nextAction').lean();
  for (const c of soon) {
    const when = +day0(c.nextHearing!) === +today ? 'today' : 'tomorrow';
    await tell(await recipientsFor(c, posts), `Hearing ${when}: ${c.caseId}`, `${courtName(c.court, c.courtOther)}${c.nextAction ? ` — to be done: ${c.nextAction}` : ''}`, `/litigation/${c._id}`);
  }
  // Hearing date passed two days ago with nothing recorded
  const overdue = await LitigationCase.find({ deleted: { $ne: true }, status: 'pending', nextHearing: { $lt: new Date(+today - 2 * DAY), $gte: new Date(+today - 3 * DAY) } }).select('caseId anc createdBy nextHearing').lean();
  for (const c of overdue) await tell(await recipientsFor(c, posts), `Update needed: ${c.caseId}`, `The hearing of ${c.nextHearing!.toDateString()} has not been recorded. Record the proceedings and the next date.`, `/litigation/${c._id}`);
  // Appeal period ending (15 and 5 days left), where the admin has set the period for that court
  const decided = await LitigationCase.find({ deleted: { $ne: true }, status: 'decided', 'appeal.filed': 'undecided', 'decision.date': { $exists: true } }).select('caseId anc createdBy court decision').lean();
  for (const c of decided) {
    const days = s.appealDays[c.court];
    if (!days) continue;
    const left = Math.round((+day0(c.decision!.date!) + days * DAY - +today) / DAY);
    if (left === 15 || left === 5) await tell(await recipientsFor(c, posts), `Appeal period ends in ${left} days: ${c.caseId}`, 'Record whether an appeal is being filed, and file it in time if required.', `/litigation/${c._id}`);
  }
  return { sent, hearings: soon.length, overdue: overdue.length };
}

defineJob('litigation-reminders', async (d) => {
  if (d.tenantId) return runLitigationReminders(String(d.tenantId));
  const tenants = await runUnscoped(() => Tenant.find({ status: 'active', isPlatform: { $ne: true } }).select('_id').lean());
  for (const t of tenants) await enqueue('litigation-reminders', { tenantId: String(t._id) }, { jobId: `lit-rem-${t._id}-${new Date().toISOString().slice(0, 10)}` }).catch((err) => logger.warn({ err }, 'reminder enqueue failed'));
});
schedule('litigation-reminders', '0 7 * * *');

/* Run reminders now (admins; for testing) */
router.post('/reminders/run', async (req, res) => {
  if (!atLeast(req.user!.role, 'admin')) throw forbidden();
  res.json(await runAsTenant(req.user!.tenantId, () => runLitigationReminders(req.user!.tenantId)));
});

export default router;

/**
 * Tameel (information requests). An admin uploads the government's Excel format; its header row
 * becomes the columns. Every holder of the chosen posts inside the area fills one sheet per unit
 * they hold (rows can be added, edited, deleted), then submits. Each submission rebuilds and stores
 * the combined Excel file for its group (e.g. the tehsil). Admins edit, return (with a note) or accept.
 */
import ExcelJS from 'exceljs';
import express, { Router } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { audit, notify } from '../../lib/notify.js';
import { atLeast, requireRole, type AuthUser } from '../../middleware/auth.js';
import { objectId, q, validate } from '../../middleware/validate.js';
import { Charge, Tameel, TameelFile, TameelSheet, Unit, User } from '../../models/index.js';
import type { BP } from '../org/blueprint.js';
import { bpOf } from '../org/service.js';
import { finishSheet } from '../../lib/xlsxStyle.js';
import { activeFilter, ancestorAt, canSeeUnit, hasCap, myCharges } from '../revenue/access.js';

const router = Router();
const isAdmin = (me: AuthUser) => atLeast(me.role, 'admin');
/** Admins, or the officer who issued this Tameel. */
const canManage = (me: AuthUser, t: { createdBy?: unknown }) => isAdmin(me) || String((t.createdBy as any)?._id ?? t.createdBy) === me.id;
/** Officers who may assign work (their posts have 'assign_targets'), or admins. */
const canIssue = async (me: AuthUser, bp: BP, unit?: { anc: Types.ObjectId[] }) => isAdmin(me) || ((await hasCap(me, bp, 'assign_targets')) && (!unit || (await canSeeUnit(me, unit, bp))));
const clean = (v: unknown) => (v == null ? '' : typeof v === 'object' && 'text' in (v as any) ? String((v as any).text) : typeof v === 'object' && 'result' in (v as any) ? String((v as any).result) : v instanceof Date ? v.toISOString().slice(0, 10) : String(v)).trim();

/* ---------- Excel ---------- */
async function readHeaders(base64: string) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(base64, 'base64') as any);
  const ws = wb.worksheets[0];
  if (!ws) throw badRequest('The file has no worksheet');
  // First row with at least two filled cells is the header row
  let header: string[] = [];
  let headerRow = 0;
  ws.eachRow({ includeEmpty: false }, (row, n) => {
    if (header.length) return;
    const cells = (row.values as unknown[]).slice(1).map(clean);
    if (cells.filter(Boolean).length >= 2) {
      header = cells;
      headerRow = n;
    }
  });
  if (!header.length) throw badRequest('Could not find a header row (a row with column names)');
  // Trim trailing empty headers; name blank ones
  while (header.length && !header[header.length - 1]) header.pop();
  const columns = header.map((h, i) => ({ key: `c${i + 1}`, label: h || `Column ${i + 1}` }));
  return { sheet: ws.name, headerRow, columns, dataRows: Math.max(0, ws.actualRowCount - headerRow) };
}

async function buildWorkbook(t: any, sheets: any[], units: Map<string, any>, users: Map<string, string>, groupName?: string) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'KPI Dashboard';
  const ws = wb.addWorksheet((groupName ?? t.title).slice(0, 31).replace(/[\\/?*[\]:]/g, ' '));
  const isTask = t.kind === 'task';
  const extra = ['Sr. No', 'Unit', 'Status', 'Submitted By', 'Submitted At'];
  ws.addRow([`${t.title}${groupName ? ` — ${groupName}` : ''}`]).font = { bold: true, size: 13 };
  ws.addRow([`Deadline: ${new Date(t.deadline).toLocaleDateString('en-GB')} · Generated: ${new Date().toLocaleString('en-GB')}`]);
  const head = ws.addRow([...extra.slice(0, 2), ...(isTask ? ['What Was Done'] : t.columns.map((c: any) => c.label)), ...extra.slice(2)]);
  head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  head.eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF187A43' } }; c.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true }; });
  let n = 0;
  for (const s of sheets) {
    const unit = units.get(String(s.unitId))?.name ?? '';
    if (isTask) {
      n++;
      ws.addRow([n, unit, s.doneNote ?? '', s.status, users.get(String(s.submittedBy)) ?? '', s.submittedAt ? new Date(s.submittedAt).toLocaleString('en-GB') : '']);
      continue;
    }
    for (const r of s.rows) {
      n++;
      ws.addRow([n, unit, ...t.columns.map((c: any) => r.values?.[c.key] ?? ''), s.status, users.get(String(s.submittedBy)) ?? '', s.submittedAt ? new Date(s.submittedAt).toLocaleString('en-GB') : '']);
    }
  }
  finishSheet(ws, { headerRow: 3, keyCols: 2 });
  ws.views = [{ state: 'frozen', ySplit: 3 }];
  return { buffer: Buffer.from(await wb.xlsx.writeBuffer()), rows: n };
}

/** Rebuild and store the combined Excel file of one group (e.g. one tehsil). */
async function rebuildGroupFile(t: any, groupId: Types.ObjectId | null) {
  if (!groupId) return;
  const sheets = await TameelSheet.find({ tameelId: t._id, groupId, status: { $in: ['submitted', 'accepted'] } }).lean();
  const units = new Map((await Unit.find({ _id: { $in: [groupId, ...sheets.map((s) => s.unitId)] } }).select('name').lean()).map((u) => [String(u._id), u]));
  const users = new Map((await User.find({ _id: { $in: sheets.map((s) => s.submittedBy).filter(Boolean) } }).select('name').lean()).map((u) => [String(u._id), u.name]));
  sheets.sort((a, b) => (units.get(String(a.unitId))?.name ?? '').localeCompare(units.get(String(b.unitId))?.name ?? ''));
  const groupName = units.get(String(groupId))?.name;
  const { buffer, rows } = await buildWorkbook(t, sheets, units, users, groupName);
  const name = `${t.title} - ${groupName ?? 'group'}.xlsx`.replace(/[\\/:*?"<>|]/g, ' ');
  await TameelFile.updateOne({ tameelId: t._id, groupId }, { $set: { name, data: buffer, rows, builtAt: new Date() }, $setOnInsert: { tameelId: t._id, groupId } }, { upsert: true });
}

/* ---------- who fills what ---------- */
/** Units inside the Tameel's area held (via one of its posts) by this user. */
async function myUnits(me: AuthUser, t: any) {
  const charges = await myCharges(me.id);
  return charges.filter((c) => t.posts.includes(c.post) && c.unit.anc.some((a) => String(a) === String(t.unitId)));
}

/** Every unit that must submit: units inside the area held by any of the Tameel's posts. */
async function assignedUnits(t: any) {
  const inArea = await Unit.find({ anc: t.unitId }).select('_id').lean();
  const charges = await Charge.find({ post: { $in: t.posts }, unitId: { $in: inArea.map((u) => u._id) }, ...activeFilter() }).populate('userId', 'name').lean();
  const byUnit = new Map<string, string[]>();
  for (const c of charges) byUnit.set(String(c.unitId), [...(byUnit.get(String(c.unitId)) ?? []), (c.userId as any)?.name].filter(Boolean));
  return byUnit;
}

async function loadTameel(id: string) {
  const t = await Tameel.findById(id).lean();
  if (!t) throw notFound('Tameel');
  return t;
}

/** Sheet access: the holder of the unit (any post of the Tameel) edits until submitted; admins always. */
async function sheetAccess(me: AuthUser, t: any, unitId: string) {
  if (canManage(me, t)) return 'admin' as const;
  const mine = await myUnits(me, t);
  if (mine.some((c) => String(c.unit._id) === unitId)) return 'holder' as const;
  return null;
}

async function getOrCreateSheet(bp: BP, t: any, unitId: string) {
  let s = await TameelSheet.findOne({ tameelId: t._id, unitId });
  if (!s) {
    const unit = await Unit.findById(unitId).select('anc type').lean();
    if (!unit || !unit.anc.some((a) => String(a) === String(t.unitId))) throw badRequest('That unit is outside this Tameel');
    s = await TameelSheet.create({ tameelId: t._id, unitId, anc: unit.anc, groupId: ancestorAt(bp, unit as any, t.groupLevel) });
  }
  return s;
}

const editable = (access: 'admin' | 'holder', status: string) => access === 'admin' || status === 'draft' || status === 'returned';

/* ================================================================== *
 *  Admin: create / list / manage
 * ================================================================== */
router.post('/parse', express.json({ limit: '12mb' }), validate({ body: z.object({ file: z.string().min(10).max(16_000_000), name: z.string().max(200).optional() }) }), async (req, res) => {
  if (!(await canIssue(req.user!, bpOf(req)))) throw forbidden('You cannot issue a Tameel');
  try {
    res.json(await readHeaders(req.body.file));
  } catch (e) {
    if ((e as any)?.status) throw e;
    throw badRequest('Could not read the file. Upload an Excel workbook (.xlsx).');
  }
});

const body = z.object({
  title: z.string().trim().min(3).max(200),
  description: z.string().trim().min(10).max(5000),
  deadline: z.coerce.date(),
  kind: z.enum(['proforma', 'task']).default('proforma'),
  columns: z.array(z.object({ key: z.string().max(20), label: z.string().trim().min(1).max(120) })).max(80).default([]),
  unitId: objectId,
  posts: z.array(z.string().max(40)).min(1).default(['patwari']),
  groupLevel: z.string().max(40).optional(),
  sourceFile: z.string().max(200).optional(),
});

router.post('/', validate({ body }), async (req, res) => {
  const bp = bpOf(req);
  const b = req.body as z.infer<typeof body>;
  if (b.kind === 'proforma' && !b.columns.length) throw badRequest('Upload the Excel format, or choose a to-do task');
  if (b.kind === 'task') b.columns = [];
  if (b.deadline.getTime() < Date.now() - 86_400_000) throw badRequest('The deadline is in the past');
  const unknown = b.posts.filter((p) => !bp.post.has(p));
  if (unknown.length) throw badRequest(`Unknown post: ${unknown.join(', ')}`);
  const unit = await Unit.findById(b.unitId).select('anc type').lean();
  if (!unit) throw notFound('Area');
  if (!(await canIssue(req.user!, bp, unit as any))) throw forbidden('You can issue a Tameel only within your own jurisdiction');
  const groupLevel = b.groupLevel && bp.level.has(b.groupLevel) ? b.groupLevel : bp.level.has('tehsil') ? 'tehsil' : unit.type;
  const t = await Tameel.create({ ...b, anc: unit.anc, groupLevel, createdBy: req.user!.id });
  // Tell everyone who must fill it in
  const inArea = await Unit.find({ anc: unit._id }).select('_id').lean();
  const people = await Charge.find({ post: { $in: b.posts }, unitId: { $in: inArea.map((u) => u._id) }, ...activeFilter() }).distinct('userId');
  await notify(people, { type: 'tameel.new', title: `${b.kind === 'task' ? 'New task' : 'New Tameel'}: ${b.title}`, body: `Due ${b.deadline.toDateString()}`, link: `/tameel/${t._id}` });
  await audit('tameel.create', 'Tameel', t._id, { title: b.title, assignees: people.length });
  res.status(201).json(t);
});

router.patch('/:id', validate({ params: z.object({ id: objectId }), body: z.object({ title: z.string().trim().min(3).max(200).optional(), description: z.string().trim().min(10).max(5000).optional(), deadline: z.coerce.date().optional(), status: z.enum(['open', 'closed']).optional() }) }), async (req, res) => {
  if (!canManage(req.user!, await loadTameel(req.params.id as string))) throw forbidden();
  const t = await Tameel.findByIdAndUpdate(req.params.id, { $set: req.body }, { new: true }).lean();
  if (!t) throw notFound('Tameel');
  await audit('tameel.update', 'Tameel', t._id, { fields: Object.keys(req.body) });
  res.json(t);
});

router.delete('/:id', validate({ params: z.object({ id: objectId }) }), async (req, res) => {
  const t = await loadTameel(req.params.id as string);
  if (!canManage(req.user!, t)) throw forbidden();
  await Promise.all([TameelSheet.deleteMany({ tameelId: t._id }), TameelFile.deleteMany({ tameelId: t._id }), Tameel.deleteOne({ _id: t._id })]);
  await audit('tameel.delete', 'Tameel', t._id, { title: t.title });
  res.status(204).end();
});

/* ---------- lists ---------- */
router.get('/', async (req, res) => {
  const me = req.user!;
  const all = await Tameel.find(isAdmin(me) ? {} : { $or: [{ status: 'open' }, { createdBy: me.id }] }).populate('unitId', 'name type').sort({ status: 1, deadline: 1 }).limit(300).lean();
  const sheets = await TameelSheet.find({ tameelId: { $in: all.map((t) => t._id) } }).select('tameelId unitId status rows').lean();
  const charges = isAdmin(me) ? [] : await myCharges(me.id);
  const out = [];
  for (const t of all) {
    const mine = charges.filter((c) => t.posts.includes(c.post) && c.unit.anc.some((a) => String(a) === String((t.unitId as any)?._id ?? t.unitId)));
    const manager = canManage(me, t);
    if (!manager && !mine.length) continue;
    const ts = sheets.filter((s) => String(s.tameelId) === String(t._id));
    const own = mine.map((c) => ({ unitId: c.unit._id, unitName: c.unit.name, status: ts.find((s) => String(s.unitId) === String(c.unit._id))?.status ?? 'not started', rows: ts.find((s) => String(s.unitId) === String(c.unit._id))?.rows.length ?? 0 }));
    out.push({
      ...t,
      counts: { submitted: ts.filter((s) => s.status === 'submitted').length, accepted: ts.filter((s) => s.status === 'accepted').length, returned: ts.filter((s) => s.status === 'returned').length, draft: ts.filter((s) => s.status === 'draft').length },
      mine: own,
      manager,
    });
  }
  res.json(out);
});

/* Detail with progress per unit (admins and supervisors see every unit; holders see their own) */
router.get('/:id', validate({ params: z.object({ id: objectId }) }), async (req, res) => {
  const me = req.user!;
  const t = await Tameel.findById(req.params.id).populate('unitId', 'name type').populate('createdBy', 'name').lean();
  if (!t) throw notFound('Tameel');
  const admin = canManage(me, t);
  const assigned = await assignedUnits(t);
  const unitIds = [...assigned.keys()];
  const [units, sheets, files] = await Promise.all([
    Unit.find({ _id: { $in: unitIds } }).select('name type anc').lean(),
    TameelSheet.find({ tameelId: t._id }).select('unitId groupId status rows submittedAt returnNote').lean(),
    TameelFile.find({ tameelId: t._id }).select('groupId name rows builtAt').populate('groupId', 'name').lean(),
  ]);
  const bp = bpOf(req);
  const groups = new Map((await Unit.find({ _id: { $in: units.map((u) => ancestorAt(bp, u as any, t.groupLevel)).filter(Boolean) } }).select('name').lean()).map((g) => [String(g._id), g.name]));
  const mine = new Set((await myUnits(me, t)).map((c) => String(c.unit._id)));
  const progress = units
    .filter((u) => admin || mine.has(String(u._id)))
    .map((u) => {
      const s = sheets.find((x) => String(x.unitId) === String(u._id));
      const g = ancestorAt(bp, u as any, t.groupLevel);
      return { unitId: u._id, unitName: u.name, group: g ? groups.get(String(g)) : undefined, groupId: g, holders: assigned.get(String(u._id)) ?? [], status: s?.status ?? 'not started', rows: s?.rows.length ?? 0, submittedAt: s?.submittedAt, returnNote: s?.returnNote };
    })
    .sort((a, b) => (a.group ?? '').localeCompare(b.group ?? '') || a.unitName.localeCompare(b.unitName));
  res.json({ ...t, admin, progress, files: admin ? files : [] });
});

/* ================================================================== *
 *  Sheets
 * ================================================================== */
router.get('/:id/sheet/:unitId', validate({ params: z.object({ id: objectId, unitId: objectId }) }), async (req, res) => {
  const t = await loadTameel(req.params.id as string);
  const access = await sheetAccess(req.user!, t, req.params.unitId as string);
  if (!access) throw forbidden('This sheet belongs to another unit');
  const s = await getOrCreateSheet(bpOf(req), t, req.params.unitId as string);
  const unit = await Unit.findById(s.unitId).select('name type').lean();
  res.json({ tameel: t, unit, sheet: s, access, canEdit: editable(access, s.status) && t.status === 'open' });
});

const rowBody = z.object({ values: z.record(z.string().max(20), z.string().max(2000)) });

/** Add (no rowId) or update one row. */
router.put('/:id/sheet/:unitId/rows{/:rowId}', validate({ params: z.object({ id: objectId, unitId: objectId, rowId: objectId.optional() }), body: rowBody }), async (req, res) => {
  const t = await loadTameel(req.params.id as string);
  if (t.status !== 'open' && !canManage(req.user!, t)) throw badRequest('This Tameel is closed');
  const access = await sheetAccess(req.user!, t, req.params.unitId as string);
  if (!access) throw forbidden();
  const s = await getOrCreateSheet(bpOf(req), t, req.params.unitId as string);
  if (!editable(access, s.status)) throw badRequest('This sheet has been submitted; ask the administrator to return it for changes');
  const keys = new Set(t.columns.map((c) => c.key));
  const values = Object.fromEntries(Object.entries(req.body.values as Record<string, string>).filter(([k]) => keys.has(k)).map(([k, v]) => [k, v.trim()]));
  const now = new Date();
  if (req.params.rowId) {
    const row: any = s.rows.find((r: any) => String(r._id) === req.params.rowId);
    if (!row) throw notFound('Row');
    row.set({ values, updatedBy: req.user!.id, updatedAt: now });
  } else {
    if (s.rows.length >= 5000) throw badRequest('A sheet can hold at most 5,000 rows');
    s.rows.push({ values, updatedBy: req.user!.id, updatedAt: now } as any);
  }
  s.markModified('rows');
  await s.save();
  // Admin edits to a submitted sheet update the stored Excel straight away
  if (s.status === 'submitted' || s.status === 'accepted') await rebuildGroupFile(t, s.groupId as any);
  res.json(s);
});

router.delete('/:id/sheet/:unitId/rows/:rowId', validate({ params: z.object({ id: objectId, unitId: objectId, rowId: objectId }) }), async (req, res) => {
  const t = await loadTameel(req.params.id as string);
  const access = await sheetAccess(req.user!, t, req.params.unitId as string);
  if (!access) throw forbidden();
  const s = await TameelSheet.findOne({ tameelId: t._id, unitId: req.params.unitId });
  if (!s) throw notFound('Sheet');
  if (!editable(access, s.status)) throw badRequest('This sheet has been submitted; ask the administrator to return it for changes');
  s.rows = s.rows.filter((r: any) => String(r._id) !== req.params.rowId) as any;
  await s.save();
  if (s.status === 'submitted' || s.status === 'accepted') await rebuildGroupFile(t, s.groupId as any);
  res.json(s);
});

router.post('/:id/sheet/:unitId/submit', validate({ params: z.object({ id: objectId, unitId: objectId }), body: z.object({ note: z.string().trim().max(2000).optional() }) }), async (req, res) => {
  const t = await loadTameel(req.params.id as string);
  if (t.status !== 'open') throw badRequest('This Tameel is closed');
  const access = await sheetAccess(req.user!, t, req.params.unitId as string);
  if (!access) throw forbidden();
  const s = await getOrCreateSheet(bpOf(req), t, req.params.unitId as string);
  if (t.kind !== 'task' && !s.rows.length) throw badRequest('Add at least one row before submitting');
  if (t.kind === 'task') s.set('doneNote', req.body.note);
  if (!['draft', 'returned'].includes(s.status) && access !== 'admin') throw badRequest('Already submitted');
  const now = new Date();
  s.set({ status: 'submitted', submittedBy: req.user!.id, submittedAt: now, returnNote: undefined });
  s.history.push({ at: now, by: req.user!.id, action: `${t.kind === 'task' ? 'done' : 'submitted'}${now > t.deadline ? ' (late)' : ''}`, note: req.body.note } as any);
  await s.save();
  await rebuildGroupFile(t, s.groupId as any);
  await notify(t.createdBy, { type: 'tameel.submitted', title: `Tameel submitted: ${t.title}`, body: `${(await Unit.findById(s.unitId).select('name').lean())?.name} · ${s.rows.length} row(s)`, link: `/tameel/${t._id}` });
  res.json(s);
});

/* Admin: return for correction (with a note) or accept */
router.post('/:id/sheet/:unitId/review', validate({ params: z.object({ id: objectId, unitId: objectId }), body: z.object({ action: z.enum(['return', 'accept']), note: z.string().trim().max(1000).optional() }) }), async (req, res) => {
  const t = await loadTameel(req.params.id as string);
  if (!canManage(req.user!, t)) throw forbidden();
  const s = await TameelSheet.findOne({ tameelId: t._id, unitId: req.params.unitId });
  if (!s) throw notFound('Sheet');
  const { action, note } = req.body;
  if (action === 'return' && !note) throw badRequest('Write what needs to be corrected');
  s.set({ status: action === 'return' ? 'returned' : 'accepted', returnNote: action === 'return' ? note : undefined });
  s.history.push({ at: new Date(), by: req.user!.id, action: action === 'return' ? 'returned' : 'accepted', note } as any);
  await s.save();
  await rebuildGroupFile(t, s.groupId as any);
  if (action === 'return') {
    const holders = await Charge.find({ unitId: s.unitId, post: { $in: t.posts }, ...activeFilter() }).distinct('userId');
    await notify(holders, { type: 'tameel.returned', title: `Tameel returned for correction: ${t.title}`, body: note, link: `/tameel/${t._id}` });
  }
  await audit(`tameel.${action}`, 'TameelSheet', s._id, { note });
  res.json(s);
});

/* ================================================================== *
 *  Excel downloads
 * ================================================================== */
const sendXlsx = (res: express.Response, name: string, data: Buffer) => {
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(name)}"; filename*=UTF-8''${encodeURIComponent(name)}`);
  res.send(data);
};

/** The stored combined file of one group (e.g. a tehsil). */
router.get('/:id/files/:groupId', validate({ params: z.object({ id: objectId, groupId: objectId }) }), async (req, res) => {
  if (!canManage(req.user!, await loadTameel(req.params.id as string))) throw forbidden();
  const f = await TameelFile.findOne({ tameelId: req.params.id, groupId: req.params.groupId });
  if (!f) throw notFound('File');
  const data = Buffer.from(f.get('data') as Buffer);
  sendXlsx(res, f.name ?? 'tameel.xlsx', data);
});

/** Everything (or one unit's own sheet for its holder), generated now. */
router.get('/:id/export', validate({ params: z.object({ id: objectId }), query: z.object({ unitId: objectId.optional(), all: z.enum(['true', 'false']).optional() }) }), async (req, res) => {
  const me = req.user!;
  const t = await loadTameel(req.params.id as string);
  const { unitId } = q<{ unitId?: string }>(req);
  let filter: Record<string, unknown> = { tameelId: t._id };
  if (unitId) {
    if (!(await sheetAccess(me, t, unitId))) throw forbidden();
    filter = { ...filter, unitId };
  } else if (!canManage(me, t)) throw forbidden();
  const sheets = await TameelSheet.find(filter).lean();
  const units = new Map((await Unit.find({ _id: { $in: sheets.map((s) => s.unitId) } }).select('name').lean()).map((u) => [String(u._id), u]));
  const users = new Map((await User.find({ _id: { $in: sheets.map((s) => s.submittedBy).filter(Boolean) } }).select('name').lean()).map((u) => [String(u._id), u.name]));
  sheets.sort((a, b) => (units.get(String(a.unitId))?.name ?? '').localeCompare(units.get(String(b.unitId))?.name ?? ''));
  const { buffer } = await buildWorkbook(t, sheets, units, users);
  sendXlsx(res, `${t.title}${unitId ? ` - ${units.get(unitId)?.name ?? ''}` : ' - all'}.xlsx`.replace(/[\\/:*?"<>|]/g, ' '), buffer);
});


export default router;


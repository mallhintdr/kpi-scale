/**
 * Bulk import of an organisation's hierarchy, people and postings from CSV, run as a background job.
 *
 *   units    level,name,code,parent_code          (parents first; top level has no parent_code)
 *   users    name,email,role,designation,employee_code,phone,password
 *   charges  email,unit_code,post,charge_type,from
 *
 * Rows are matched on code / email, so re-running an import updates instead of duplicating.
 * A dry run validates every row and reports errors without writing anything.
 */
import { parse } from 'csv-parse/sync';
import { Types } from 'mongoose';
import { defineJob } from '../../lib/queue.js';
import { Charge, ImportRun, Tenant, Unit, User } from '../../models/index.js';
import { hashPassword } from '../auth/auth.routes.js';
import { normalizePhone } from '../whatsapp/phone.js';
import { checkPosting } from '../revenue/registers.routes.js';
import type { BP } from './blueprint.js';
import { getBlueprint } from './service.js';

type Row = Record<string, string>;
const ROLES = ['owner', 'admin', 'manager', 'employee'];

export function parseCsv(text: string): Row[] {
  return parse(text, { columns: (h: string[]) => h.map((x) => x.trim().toLowerCase().replace(/\s+/g, '_')), skip_empty_lines: true, trim: true, bom: true });
}

interface Ctx { bp: BP; dryRun: boolean; errors: { row: number; message: string }[]; created: number; updated: number; defaultPasswordHash?: string; actorRole?: string }

async function importUnits(rows: Row[], c: Ctx) {
  const { bp } = c;
  // Parents before children
  const order = (r: Row) => bp.levelIndex.get(r.level?.toLowerCase()) ?? 99;
  const indexed = rows.map((r, i) => ({ r, i: i + 2 })).sort((a, b) => order(a.r) - order(b.r));
  const byCode = new Map((await Unit.find({ code: { $in: rows.flatMap((r) => [r.code, r.parent_code]).filter(Boolean) } }).select('code type anc').lean()).map((u) => [u.code!, u]));
  for (const { r, i } of indexed) {
    const level = r.level?.toLowerCase();
    const li = bp.levelIndex.get(level);
    if (li == null) { c.errors.push({ row: i, message: `Unknown level "${r.level}"` }); continue; }
    if (!r.name || !r.code) { c.errors.push({ row: i, message: 'name and code are required' }); continue; }
    let parent: any = null;
    if (li > 0) {
      parent = byCode.get(r.parent_code);
      if (!parent) { c.errors.push({ row: i, message: `Parent "${r.parent_code}" not found` }); continue; }
      if (bp.levelIndex.get(parent.type) !== li - 1) { c.errors.push({ row: i, message: `A ${bp.levels[li].label} must sit under a ${bp.levels[li - 1].label}` }); continue; }
    }
    const existing = byCode.get(r.code);
    if (existing && existing.type !== level) { c.errors.push({ row: i, message: `Code "${r.code}" already belongs to a ${existing.type}` }); continue; }
    if (c.dryRun) {
      if (!existing) byCode.set(r.code, { _id: new Types.ObjectId(), code: r.code, type: level, anc: [] } as any);
      existing ? c.updated++ : c.created++;
      continue;
    }
    if (existing) {
      await Unit.updateOne({ _id: existing._id }, { name: r.name });
      c.updated++;
    } else {
      const _id = new Types.ObjectId();
      const anc = [...(parent?.anc ?? []), _id];
      await Unit.create({ _id, type: level, name: r.name, code: r.code, parentId: parent?._id ?? null, anc });
      byCode.set(r.code, { _id, code: r.code, type: level, anc } as any);
      c.created++;
    }
  }
}

async function importUsers(rows: Row[], c: Ctx) {
  const existing = new Map((await User.find({ email: { $in: rows.map((r) => r.email?.toLowerCase()) } }).select('email').lean()).map((u) => [u.email, u]));
  for (const [idx, r] of rows.entries()) {
    const i = idx + 2;
    const email = r.email?.toLowerCase();
    if (!r.name || !email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { c.errors.push({ row: i, message: 'name and a valid email are required' }); continue; }
    const role = (r.role || 'employee').toLowerCase();
    if (!ROLES.includes(role)) { c.errors.push({ row: i, message: `Unknown role "${r.role}"` }); continue; }
    // Only an owner may create owners; imports never change an existing person's role
    if (role === 'owner' && c.actorRole !== 'owner') { c.errors.push({ row: i, message: 'Only an organisation owner can create owners' }); continue; }
    const pw = r.password;
    const data = { name: r.name, role, designation: r.designation || undefined, employeeCode: r.employee_code || undefined, phone: r.phone || undefined, phoneE164: normalizePhone(r.phone) || undefined };
    if (existing.has(email)) {
      const { role: _ignored, ...profile } = data;
      if (!c.dryRun) await User.updateOne({ email }, profile);
      c.updated++;
      continue;
    }
    if ((!pw && !c.defaultPasswordHash) || (pw && pw.length < 8)) { c.errors.push({ row: i, message: 'A password of 8+ characters is required (column or default)' }); continue; }
    if (!c.dryRun) await User.create({ ...data, email, passwordHash: pw ? await hashPassword(pw) : c.defaultPasswordHash });
    existing.set(email, {} as any);
    c.created++;
  }
}

async function importCharges(rows: Row[], c: Ctx) {
  const users = new Map((await User.find({ email: { $in: rows.map((r) => r.email?.toLowerCase()) } }).select('email').lean()).map((u) => [u.email, u]));
  const units = new Map((await Unit.find({ code: { $in: rows.map((r) => r.unit_code) } }).select('code type anc').lean()).map((u) => [u.code!, u]));
  for (const [idx, r] of rows.entries()) {
    const i = idx + 2;
    const user = users.get(r.email?.toLowerCase());
    const unit = units.get(r.unit_code);
    if (!user) { c.errors.push({ row: i, message: `User "${r.email}" not found` }); continue; }
    if (!unit) { c.errors.push({ row: i, message: `Unit "${r.unit_code}" not found` }); continue; }
    const chargeType = (r.charge_type || 'regular').toLowerCase();
    if (!['regular', 'additional', 'look_after'].includes(chargeType)) { c.errors.push({ row: i, message: `Unknown charge type "${r.charge_type}"` }); continue; }
    const already = await Charge.exists({ userId: user._id, unitId: unit._id, post: r.post, to: null });
    if (already) { c.updated++; continue; }
    try {
      await checkPosting(c.bp, { userId: String(user._id), unitId: String(unit._id), post: r.post }, unit as any);
    } catch (e) {
      c.errors.push({ row: i, message: (e as Error).message });
      continue;
    }
    const from = r.from ? new Date(r.from) : new Date();
    if (Number.isNaN(from.getTime())) { c.errors.push({ row: i, message: `Bad date "${r.from}"` }); continue; }
    if (!c.dryRun) await Charge.create({ userId: user._id, unitId: unit._id, post: r.post, chargeType, from });
    c.created++;
  }
}

defineJob('import', async (d) => {
  // The CSV and options live on the run document, never in the queue's job data
  const run = await ImportRun.findById(d.runId).select('+payload');
  if (!run) return;
  const payload = (run.get('payload') ?? {}) as { csv?: string; defaultPasswordHash?: string; actorRole?: string };
  run.status = 'running';
  await run.save();
  try {
    const bp = await getBlueprint(String(d.tenantId));
    if (!bp) throw new Error('Organisation is not configured');
    const rows = parseCsv(String(payload.csv ?? ''));
    run.total = rows.length;
    const ctx: Ctx = { bp, dryRun: run.dryRun, errors: [], created: 0, updated: 0, defaultPasswordHash: payload.defaultPasswordHash, actorRole: payload.actorRole };
    if (run.kind === 'units') {
      const t = await Tenant.findById(d.tenantId).select('limits').lean();
      const now = await Unit.countDocuments();
      if (now + rows.length > (t?.limits?.maxUnits ?? 50000)) throw new Error('This import would exceed the organisation\'s unit limit');
      await importUnits(rows, ctx);
    } else if (run.kind === 'users') {
      const t = await Tenant.findById(d.tenantId).select('limits').lean();
      const now = await User.countDocuments({ status: 'active' });
      if (now + rows.length > (t?.limits?.maxUsers ?? 5000)) throw new Error('This import would exceed the organisation\'s user limit');
      await importUsers(rows, ctx);
    } else await importCharges(rows, ctx);
    run.set({ status: 'done', created: ctx.created, updated: ctx.updated, errors: ctx.errors.slice(0, 500), finishedAt: new Date() });
  } catch (err) {
    run.set({ status: 'failed', errors: [{ row: 0, message: (err as Error).message }], finishedAt: new Date() });
  }
  run.set('payload', undefined);
  await run.save();
});

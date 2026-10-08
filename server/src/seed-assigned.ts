/**
 * Adds sample assigned targets (weekly / 15-day / monthly drives) to the existing pilot data.
 * Safe to re-run: removes previously seeded drives first. Usage: npm run seed:assigned
 */
import { Types } from 'mongoose';
import { connectDb, disconnectDb } from './lib/db.js';
import { logger } from './lib/logger.js';
import { runAsTenant } from './lib/tenantContext.js';
import { AssignedTarget, Charge, Tenant, Unit } from './models/index.js';
import { CASE_HEADS, REVENUE_HEADS } from './modules/revenue/catalog.js';

let s = 777;
const rnd = () => {
  s = (s + 0x6d2b79f5) | 0;
  let t = Math.imul(s ^ (s >>> 15), 1 | s);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = <T>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)];
const DAY = 86_400_000;
const DAYS = { week: 7, fortnight: 15, month: 30 } as const;

async function main() {
  await connectDb();
  const tenant = await Tenant.findOne({ slug: 'bor-bahawalpur' });
  if (!tenant) throw new Error('Run npm run seed first');
  await runAsTenant(tenant._id, async () => {
    await AssignedTarget.deleteMany({ note: /\(sample\)$/ });
    const charges = await Charge.find({ to: null }).lean();
    const units = new Map((await Unit.find().select('anc parentId type').lean()).map((u) => [String(u._id), u]));
    // supervisor of a unit = holder of the parent unit's supervising post
    const supervisorFor: Record<string, string[]> = { patwari: ['girdawar', 'naib_tehsildar', 'tehsildar'], girdawar: ['tehsildar', 'naib_tehsildar'], naib_tehsildar: ['ac', 'tehsildar'] };
    const byUnitPost = new Map<string, string>();
    for (const c of charges) byUnitPost.set(`${c.unitId}|${c.post}`, String(c.userId));
    const today = new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate());
    const docs: any[] = [];
    for (const c of charges) {
      if (!supervisorFor[c.post] || rnd() > 0.55) continue;
      const unit = units.get(String(c.unitId));
      if (!unit) continue;
      // walk up the tree for a supervisor
      let sup: string | undefined;
      for (const a of [...unit.anc].reverse().slice(1)) {
        for (const p of supervisorFor[c.post]) sup ??= byUnitPost.get(`${a}|${p}`);
        if (sup) break;
      }
      if (!sup || sup === String(c.userId)) continue;
      const n = 1 + Math.floor(rnd() * 3);
      for (let i = 0; i < n; i++) {
        const period = pick(['week', 'fortnight', 'month'] as const);
        const ago = Math.floor(rnd() * 60); // started up to 60 days ago
        const start = new Date(today.getTime() - ago * DAY);
        const end = new Date(start.getTime() + DAYS[period] * DAY - 1);
        const isCase = c.post === 'patwari' ? rnd() < 0.25 : rnd() < 0.5;
        const head = isCase ? pick(CASE_HEADS.filter((h) => h.level === 'circle').map((h) => h.code)) : pick(REVENUE_HEADS.map((h) => h.code));
        const targetValue = isCase ? 5 + Math.floor(rnd() * 25) : Math.round((50_000 + rnd() * 450_000) / 1000) * 1000;
        const skill = 0.4 + rnd() * 0.8;
        const elapsed = Math.min(1, (today.getTime() - start.getTime()) / (end.getTime() - start.getTime()));
        const achievedTotal = targetValue * skill * Math.max(0.15, elapsed);
        const steps = 1 + Math.floor(rnd() * 4);
        const progress = Array.from({ length: steps }, (_, k) => ({
          _id: new Types.ObjectId(),
          date: new Date(start.getTime() + Math.floor(((k + 1) / (steps + 1)) * Math.min(today.getTime() - start.getTime(), end.getTime() - start.getTime()))),
          value: Math.max(1, isCase ? Math.round(achievedTotal / steps) : Math.round(achievedTotal / steps / 100) * 100),
          by: c.userId,
          status: rnd() < 0.85 ? 'verified' : 'submitted',
        })).filter((p) => p.date <= today);
        docs.push({
          tenantId: tenant._id, head, assigneeId: c.userId, unitId: c.unitId, anc: unit.anc, assignedBy: sup, period,
          startDate: start, endDate: end, targetValue, progress,
          achieved: progress.filter((p) => p.status === 'verified').reduce((sum, p) => sum + p.value, 0),
          achievedPending: progress.filter((p) => p.status === 'submitted').reduce((sum, p) => sum + p.value, 0),
          note: 'Drive (sample)', status: 'active',
        });
      }
    }
    await AssignedTarget.insertMany(docs, { ordered: false });
    logger.info(`Seeded ${docs.length} assigned targets`);
  });
  await disconnectDb();
}

main().catch(async (err) => {
  logger.error({ err }, 'seed:assigned failed');
  await disconnectDb();
  process.exit(1);
});

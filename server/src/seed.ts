/**
 * Seeds the Bahawalpur Division pilot.
 *  - Division, districts and tehsils are real (source: Bahawalpur Division, Wikipedia).
 *  - Qanungois, patwar circles and mouzas are SYNTHETIC test names (marked "(test)") — replace via import.
 *  - All officers, figures, audit paras and tasks are random test data.
 * Usage: npm run seed
 */
import { Types } from 'mongoose';
import { connectDb, disconnectDb } from './lib/db.js';
import { logger } from './lib/logger.js';
import { runAsTenant, runUnscoped } from './lib/tenantContext.js';
import {
  Audit, AuditPara, Charge, Notification, RevEntry, RevTarget, ScoreConfig, Session, Task, Tenant, Unit, User,
} from './models/index.js';
import { AUDIT_CATEGORIES, CASE_HEADS, REVENUE_HEADS, fyMonths } from './seedCatalog.js';
import { hashPassword } from './modules/auth/auth.routes.js';
import { saveBlueprint } from './modules/org/service.js';
import { revenueDepartment } from './modules/org/templates.js';
import { closeRedis } from './lib/redis.js';

const PASSWORD = 'Password123';
const SLUG = 'bor-bahawalpur';

const DIVISION = {
  name: 'Bahawalpur',
  districts: [
    { name: 'Bahawalpur', tehsils: ['Ahmadpur East', 'Bahawalpur City', 'Bahawalpur Saddar', 'Hasilpur', 'Khairpur Tamewali', 'Yazman'] },
    { name: 'Bahawalnagar', tehsils: ['Bahawalnagar', 'Chishtian', 'Fort Abbas', 'Haroonabad', 'Minchinabad'] },
    { name: 'Rahim Yar Khan', tehsils: ['Khanpur', 'Liaqatpur', 'Rahim Yar Khan', 'Sadiqabad'] },
  ],
};

/* Deterministic PRNG so every seed run produces the same data */
// mulberry32: 32-bit integer PRNG (the previous LCG lost precision in doubles and cycled)
let s = 20251;
const rnd = () => {
  s = (s + 0x6d2b79f5) | 0;
  let t = Math.imul(s ^ (s >>> 15), 1 | s);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const int = (a: number, b: number) => Math.floor(a + rnd() * (b - a + 1));
const pick = <T>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)];
const round = (v: number, to = 100) => Math.round(v / to) * to;

const FIRST = ['Muhammad', 'Ahmed', 'Ali', 'Usman', 'Bilal', 'Hamza', 'Imran', 'Kashif', 'Asif', 'Tariq', 'Shahid', 'Naveed', 'Zahid', 'Farhan', 'Rizwan', 'Waqas', 'Sajid', 'Javed', 'Nadeem', 'Irfan', 'Khalid', 'Abdul', 'Ghulam', 'Riaz', 'Akram', 'Saleem', 'Arshad', 'Mushtaq', 'Ayesha', 'Sana', 'Rabia', 'Nazia'];
const LAST = ['Khan', 'Ahmad', 'Iqbal', 'Hussain', 'Butt', 'Chaudhry', 'Malik', 'Akhtar', 'Shah', 'Javed', 'Rana', 'Sheikh', 'Gill', 'Bhatti', 'Awan', 'Qureshi', 'Siddiqui', 'Abbasi', 'Jatoi', 'Bajwa', 'Arain', 'Sial', 'Baloch', 'Leghari'];
const personName = () => `${pick(FIRST)} ${pick(LAST)}`;
const slug = (x: string) => x.toLowerCase().replace(/[^a-z0-9]+/g, '');
const abbr = (x: string) => x.split(/\s+/).map((w) => w[0]).join('').toUpperCase();

async function wipe() {
  for (const sl of [SLUG, 'demo', 'second']) {
    const t = await Tenant.findOne({ slug: sl });
    if (!t) continue;
    await runUnscoped(async () => {
      const db = Tenant.db;
      for (const name of await db.listCollections()) {
        if (name.name === 'tenants') continue;
        await db.collection(name.name).deleteMany({ tenantId: t._id });
      }
    });
    await t.deleteOne();
  }
}

async function main() {
  await connectDb();
  await wipe();
  // Make sure indexes exist for the new collections
  await Promise.all([Unit, Charge, RevTarget, RevEntry, AuditPara, Task, ScoreConfig, User, Notification, Audit, Session].map((m: any) => m.syncIndexes()));

  const tenant = await Tenant.create({ name: 'Board of Revenue — Bahawalpur Division', slug: SLUG, industry: 'Public sector', branding: { logoUrl: '/punjab-logo-white.png', tagline: 'Government of the Punjab', shortName: 'Board of Revenue' }, settings: { timezone: 'Asia/Karachi', currency: 'PKR', ratingScale: 5 } });
  const passwordHash = await hashPassword(PASSWORD);
  const tid = tenant._id;

  await runAsTenant(tid, () => saveBlueprint(String(tid), { ...revenueDepartment, name: tenant.name }, { template: 'revenue_department', note: 'Seeded', skipUsageCheck: true }));

  await runAsTenant(tid, async () => {
    const units: any[] = [];
    const mkUnit = (type: string, name: string, parent: any | null, code?: string) => {
      const _id = new Types.ObjectId();
      const u = { _id, tenantId: tid, type, name, code, parentId: parent?._id ?? null, anc: [...(parent?.anc ?? []), _id] };
      units.push(u);
      return u;
    };
    const users: any[] = [];
    const usedEmails = new Set<string>();
    const mkUser = (email: string, designation: string, bps: number, role = 'employee', name = personName()) => {
      let e = email, i = 2;
      while (usedEmails.has(e)) e = email.replace('@', `${i++}@`);
      usedEmails.add(e);
      const u = { _id: new Types.ObjectId(), tenantId: tid, name, email: e, passwordHash, role, designation, bps, status: 'active', employeeCode: `BWP-${1000 + users.length}` };
      users.push(u);
      return u;
    };
    const charges: any[] = [];
    const posted = new Date('2025-07-01');
    const charge = (user: any, unit: any, post: string, chargeType = 'regular') =>
      charges.push({ tenantId: tid, userId: user._id, unitId: unit._id, post, chargeType, from: posted, to: null });

    mkUser('admin@bwp.test', 'System Administrator (BoR)', 18, 'admin', 'BoR Administrator');
    const division = mkUnit('division', DIVISION.name, null, 'BWP');
    charge(mkUser('commissioner@bwp.test', 'Commissioner', 20), division, 'commissioner');

    const circles: any[] = [];
    const tehsils: any[] = [];
    const ros: { user: any; tehsil: any }[] = [];
    for (const d of DIVISION.districts) {
      const district = mkUnit('district', d.name, division, abbr(d.name));
      charge(mkUser(`dc.${slug(d.name)}@bwp.test`, 'Deputy Commissioner', 19), district, 'dc');
      charge(mkUser(`adc.${slug(d.name)}@bwp.test`, 'Additional Deputy Commissioner (Revenue)', 18), district, 'adc_rev');

      for (const tName of d.tehsils) {
        const ts = slug(tName);
        const tehsil = mkUnit('tehsil', tName, district, abbr(tName));
        tehsils.push(tehsil);
        charge(mkUser(`ac.${ts}@bwp.test`, 'Assistant Commissioner', 17), tehsil, 'ac');
        charge(mkUser(`wasilbaqi.${ts}@bwp.test`, 'Wasil Baqi Navees', 11), tehsil, 'wasilbaqi');
        charge(mkUser(`sci.${ts}@bwp.test`, 'Service Centre In-charge', 14), tehsil, 'sci');
        const tehsildar = mkUser(`tehsildar.${ts}@bwp.test`, 'Tehsildar', 16);
        charge(tehsildar, tehsil, 'tehsildar');
        ros.push({ user: tehsildar, tehsil });
        const naibs = Array.from({ length: int(1, 3) }, (_, i) => mkUser(`naib${i + 1}.${ts}@bwp.test`, 'Naib Tehsildar', 14));
        naibs.forEach((n) => ros.push({ user: n, tehsil }));

        const nQ = int(4, 6);
        const qanungois = Array.from({ length: nQ }, (_, i) => mkUnit('qanungoi', `${tName} Qanungoi-${i + 1} (test)`, tehsil, `${abbr(tName)}-Q${i + 1}`));
        // Revenue officers: Tehsildar holds ~1/3, Naib Tehsildars share the rest
        qanungois.forEach((q, i) => {
          const holder = i % (naibs.length + 1) === 0 ? null : naibs[(i - 1) % naibs.length];
          if (holder) charge(holder, q, 'naib_tehsildar');
          else charge(tehsildar, q, 'tehsildar');
        });
        // Girdawars: some hold two qanungois
        let gi = 0;
        for (let i = 0; i < qanungois.length; ) {
          const g = mkUser(`girdawar${++gi}.${ts}@bwp.test`, 'Girdawar (Qanungo)', 11);
          const take = rnd() < 0.3 && i + 1 < qanungois.length ? 2 : 1;
          for (let k = 0; k < take; k++) charge(g, qanungois[i + k], 'girdawar', k ? 'additional' : 'regular');
          i += take;
        }
        // Patwar circles and mouzas
        let pi = 0;
        for (const q of qanungois) {
          const nC = int(5, 8);
          const qCircles = Array.from({ length: nC }, (_, i) => {
            const c = mkUnit('circle', `PC ${q.code}-${String(i + 1).padStart(2, '0')} (test)`, q, `${q.code}-${i + 1}`);
            const nM = int(1, 4);
            for (let m = 0; m < nM; m++) mkUnit('mouza', `Mouza ${q.code}-${i + 1}${String.fromCharCode(97 + m)} (test)`, c);
            return c;
          });
          circles.push(...qCircles);
          for (let i = 0; i < qCircles.length; ) {
            if (rnd() < 0.04) { i++; continue; } // vacant circle
            const p = mkUser(`patwari${++pi}.${ts}@bwp.test`, 'Patwari', 9);
            const take = rnd() < 0.15 && i + 1 < qCircles.length ? 2 : 1;
            for (let k = 0; k < take; k++) charge(p, qCircles[i + k], 'patwari', k ? 'additional' : 'regular');
            i += take;
          }
        }
      }
    }

    await Unit.insertMany(units, { ordered: false });
    await User.insertMany(users, { ordered: false });
    await Charge.insertMany(charges, { ordered: false });
    logger.info(`Units ${units.length} (circles ${circles.length}), users ${users.length}, charges ${charges.length}`);

    /* ---------------- Targets and monthly entries ---------------- */
    const BASE: Record<string, [number, number]> = {
      WR_RABI: [300_000, 1_500_000], WR_KHARIF: [300_000, 1_600_000], TAWAN_RABI: [0, 120_000], TAWAN_KHARIF: [0, 120_000],
      AIT_LAND: [80_000, 600_000], AIT_INCOME: [0, 250_000], LEASE: [0, 500_000], MUT_FEE: [100_000, 800_000],
      COND_FEE: [0, 120_000], STAMP: [400_000, 3_000_000], FBR_236C: [200_000, 2_000_000], FBR_236K: [100_000, 1_000_000],
    };
    // Share of a year's collection by FY month index (0 = July) for crop heads
    const RABI = [0, 0, 0, 0, 0, 0, 0, 0.05, 0.15, 0.3, 0.3, 0.2];
    const KHARIF = [0.05, 0, 0, 0.15, 0.3, 0.3, 0.15, 0.05, 0, 0, 0, 0];
    const FLAT = Array(12).fill(1 / 12);
    const curve = (code: string) => (code.endsWith('RABI') ? RABI : code.endsWith('KHARIF') ? KHARIF : FLAT);

    const now = new Date();
    const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const FYS = ['2025-26', '2026-27'];
    const targets: any[] = [];
    const entries: any[] = [];
    const flush = async (force = false) => {
      if (entries.length >= 20_000 || (force && entries.length)) {
        // Verified figures are verified a few days after their month closes (never in the future);
        // derived from position, not the PRNG, so the seeded figures themselves stay identical
        const now = Date.now();
        entries.forEach((e: any, i: number) => {
          if (e.status !== 'verified' || e.verifiedAt) return;
          const [y, mo] = e.month.split('-').map(Number);
          e.verifiedAt = new Date(Math.min(now, new Date(y, mo, 2 + (i % 10), 10 + (i % 7)).getTime()));
        });
        await RevEntry.insertMany(entries.splice(0), { ordered: false });
      }
      if (targets.length >= 20_000 || (force && targets.length)) await RevTarget.insertMany(targets.splice(0), { ordered: false });
    };
    const patwariOf = new Map(charges.filter((c) => c.post === 'patwari').map((c) => [String(c.unitId), c.userId]));
    const wbOf = new Map(charges.filter((c) => c.post === 'wasilbaqi').map((c) => [String(c.unitId), c.userId]));
    const sciOf = new Map(charges.filter((c) => c.post === 'sci').map((c) => [String(c.unitId), c.userId]));

    for (const c of circles) {
      const tehsilId = String(c.anc[2]);
      const skill = 0.45 + rnd() * 0.65; // circle performance factor
      for (const fy of FYS) {
        const months = fyMonths(fy).filter((m) => m < thisMonth); // up to last completed month
        for (const h of REVENUE_HEADS) {
          const [lo, hi] = BASE[h.code];
          const target = rnd() < (lo === 0 ? 0.25 : 0) ? 0 : round(lo + rnd() * (hi - lo), 1000);
          const arrearDemand = round(target * (0.1 + rnd() * 0.4), 1000);
          targets.push({ tenantId: tid, fy, head: h.code, unitId: c._id, roUserId: null, anc: c.anc, target, arrearDemand, setBy: wbOf.get(tehsilId) });
          if (!target && !arrearDemand) continue;
          const cv = curve(h.code);
          months.forEach((m, i) => {
            const cur = round(target * cv[i] * skill * (0.8 + rnd() * 0.4));
            const arr = round((arrearDemand / 12) * skill * 0.8 * (0.5 + rnd()));
            if (!cur && !arr) return;
            const latest = m === months[months.length - 1] && fy === FYS[1];
            const enteredBy = h.enteredBy === 'patwari' ? patwariOf.get(String(c._id)) ?? wbOf.get(tehsilId) : wbOf.get(tehsilId);
            const pending = latest && h.enteredBy === 'patwari' && rnd() < 0.5;
            entries.push({
              tenantId: tid, fy, month: m, head: h.code, unitId: c._id, roUserId: null, anc: c.anc, current: cur, arrear: arr,
              ref: `PSID-${int(100000, 999999)}`, status: pending ? 'submitted' : 'verified', enteredBy, verifiedBy: pending ? undefined : wbOf.get(tehsilId),
            });
          });
        }
        for (const h of CASE_HEADS.filter((x) => x.level === 'circle')) {
          const opening = int(0, h.code === 'GPC' ? 120 : 40);
          targets.push({ tenantId: tid, fy, head: h.code, unitId: c._id, roUserId: null, anc: c.anc, opening, setBy: wbOf.get(tehsilId) });
          months.forEach((m) => {
            const received = int(0, h.code === 'GPC' ? 20 : 6);
            const disposed = Math.max(0, Math.round((received + opening / 12) * skill * (0.7 + rnd() * 0.5)));
            if (!received && !disposed) return;
            entries.push({ tenantId: tid, fy, month: m, head: h.code, unitId: c._id, roUserId: null, anc: c.anc, received, disposed, status: 'verified', enteredBy: sciOf.get(tehsilId), verifiedBy: sciOf.get(tehsilId) });
          });
        }
        await flush();
      }
    }
    // Revenue-officer registers (pending registries, partition cases)
    for (const { user, tehsil } of ros) {
      const skill = 0.5 + rnd() * 0.6;
      for (const fy of FYS) {
        const months = fyMonths(fy).filter((m) => m < thisMonth);
        for (const h of CASE_HEADS.filter((x) => x.level === 'ro')) {
          const opening = int(10, h.code === 'REGISTRY' ? 150 : 60);
          targets.push({ tenantId: tid, fy, head: h.code, unitId: tehsil._id, roUserId: user._id, anc: tehsil.anc, opening });
          months.forEach((m) => {
            const received = int(2, h.code === 'REGISTRY' ? 40 : 10);
            const disposed = Math.max(0, Math.round((received + opening / 12) * skill * (0.7 + rnd() * 0.5)));
            entries.push({ tenantId: tid, fy, month: m, head: h.code, unitId: tehsil._id, roUserId: user._id, anc: tehsil.anc, received, disposed, status: 'verified', enteredBy: user._id });
          });
        }
      }
    }
    await flush(true);

    /* ---------------- Audit paras (only some circles have them) ---------------- */
    const paras: any[] = [];
    const addParas = (unit: any, n: number, scale: number) => {
      for (let i = 0; i < n; i++) {
        const amount = round(scale * (0.2 + rnd() * 2), 1000);
        const settled = rnd() < 0.3;
        paras.push({
          tenantId: tid, unitId: unit._id, anc: unit.anc, category: pick(AUDIT_CATEGORIES), auditYear: pick(['2021-22', '2022-23', '2023-24', '2024-25']),
          paraNo: `${int(1, 60)}-${i + 1}`, subject: 'Short realisation / non-recovery observed by audit (test)', amount,
          recovered: settled ? amount : round(amount * rnd() * 0.7, 1000), status: settled ? 'settled' : 'pending', settledAt: settled ? new Date('2026-03-01') : undefined,
        });
      }
    };
    for (const c of circles) if (rnd() < 0.4) addParas(c, int(1, 4), 250_000);
    for (const t of tehsils) addParas(t, int(3, 8), 1_000_000);
    await AuditPara.insertMany(paras, { ordered: false });

    /* ---------------- Tasks ---------------- */
    const tasks: any[] = [];
    const byUnit = new Map(units.map((u) => [String(u._id), u]));
    const TITLES = ['Complete khasra girdawari for current crop', 'Submit recovery statement', 'Verify pending inheritance mutations', 'Update record of rights', 'Attend revenue court hearing', 'Field inspection of state land', 'Reconcile Wasil Baqi register', 'Clear GPC backlog'];
    const supervisorOf = (unitId: string) => {
      const u = byUnit.get(unitId);
      const parent = u?.parentId ? String(u.parentId) : null;
      return charges.find((c) => c.unitId.toString() === parent && ['girdawar', 'ac', 'dc', 'commissioner'].includes(c.post))?.userId;
    };
    for (const c of charges.filter((x) => ['patwari', 'girdawar', 'naib_tehsildar'].includes(x.post))) {
      if (rnd() > 0.5) continue;
      const by = supervisorOf(String(c.unitId)) ?? users[1]._id;
      const unit = byUnit.get(String(c.unitId));
      for (let i = 0; i < int(1, 3); i++) {
        const due = new Date(2026, int(6, 10), int(1, 28));
        const done = due < now ? rnd() < 0.75 : rnd() < 0.2;
        const late = rnd() < 0.25;
        tasks.push({
          tenantId: tid, title: pick(TITLES), assignedBy: by, assigneeId: c.userId, unitId: c.unitId, anc: unit.anc, dueDate: due,
          priority: pick(['normal', 'normal', 'high', 'urgent']), status: done ? 'done' : 'open',
          completedAt: done ? new Date(due.getTime() + (late ? 5 : -3) * 86_400_000) : undefined,
        });
      }
    }
    await Task.insertMany(tasks, { ordered: false });

    // Example of a district-level scoring override (Rahim Yar Khan puts more weight on audit paras)
    const ryk = units.find((u) => u.type === 'district' && u.name === 'Rahim Yar Khan');
    await ScoreConfig.create({
      scopeUnitId: ryk._id,
      blocks: {
        patwari: { revenue: 40, arrears: 15, cases: 25, audit: 10, tasks: 10 },
        girdawar: { revenue: 35, arrears: 15, cases: 25, audit: 10, tasks: 15 },
        ro: { revenue: 30, arrears: 10, cases: 25, audit: 20, tasks: 15 },
        tehsil: { revenue: 30, arrears: 10, cases: 20, audit: 25, tasks: 15 },
        district: { revenue: 30, arrears: 10, cases: 20, audit: 25, tasks: 15 },
        division: { revenue: 30, arrears: 10, cases: 25, audit: 25, tasks: 10 },
      },
      heads: {},
    });

    logger.info(`Targets/entries written; audit paras ${paras.length}; tasks ${tasks.length}`);
  });

  logger.info(`Seeded ${SLUG}. Password for all test users: ${PASSWORD}`);
  logger.info('Try: admin@bwp.test · sci.hasilpur@bwp.test · commissioner@bwp.test · dc.bahawalpur@bwp.test · ac.hasilpur@bwp.test · tehsildar.hasilpur@bwp.test · wasilbaqi.hasilpur@bwp.test · girdawar1.hasilpur@bwp.test · patwari1.hasilpur@bwp.test');
  await closeRedis();
  await disconnectDb();
}

main().catch(async (err) => {
  logger.error({ err }, 'Seed failed');
  await closeRedis();
  await disconnectDb();
  process.exit(1);
});

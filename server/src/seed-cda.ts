/**
 * Adds mock data for the Cholistan Development Authority (CDA) to the existing Bahawalpur Division,
 * without touching anything else. Safe to run again: the CDA's previous mock data is replaced.
 *   CDA (district level)   MD, DRC, Reader, Colony Clerk
 *   ├─ Colonization Officer-I  (tehsil level)  CO, Tehsildar, Wasil Baqi, SCI, 9 qanungois
 *   └─ Colonization Officer-II (tehsil level)  CO, Tehsildar (additional charge), Wasil Baqi, SCI, 9 qanungois
 *   18 qanungois (a Girdawar each; 3 Naib Tehsildars and the Tehsildar share them)
 *   200 patwar circles (a Patwari each) with 1–3 chaks / mouzas each
 *   Targets and monthly figures for two financial years, like the other districts.
 * Usage: npm run seed:cda
 */
import { Types } from 'mongoose';
import { bumpData, invalidate } from './lib/cache.js';
import { connectDb, disconnectDb } from './lib/db.js';
import { logger } from './lib/logger.js';
import { closeRedis } from './lib/redis.js';
import { runAsTenant, runUnscoped } from './lib/tenantContext.js';
import { Charge, RevEntry, RevTarget, Task, Tenant, Unit, User } from './models/index.js';
import { hashPassword } from './modules/auth/auth.routes.js';
import { getBlueprint } from './modules/org/service.js';
import { buildRollups } from './modules/revenue/rollup.js';
import { CASE_HEADS, REVENUE_HEADS, fyMonths } from './seedCatalog.js';

const SLUG = 'bor-bahawalpur';
const PASSWORD = 'Password123';
const EMAIL = (x: string) => `${x}.cda@bwp.test`;

let s = 77_031;
const rnd = () => {
  s = (s + 0x6d2b79f5) | 0;
  let t = Math.imul(s ^ (s >>> 15), 1 | s);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const int = (a: number, b: number) => Math.floor(a + rnd() * (b - a + 1));
const pick = <T>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)];
const round = (v: number, to = 100) => Math.round(v / to) * to;
const FIRST = ['Muhammad', 'Ahmed', 'Ali', 'Usman', 'Bilal', 'Hamza', 'Imran', 'Kashif', 'Asif', 'Tariq', 'Shahid', 'Naveed', 'Zahid', 'Farhan', 'Rizwan', 'Waqas', 'Sajid', 'Javed', 'Nadeem', 'Irfan', 'Khalid', 'Abdul', 'Ghulam', 'Riaz', 'Akram', 'Saleem', 'Arshad', 'Mushtaq', 'Allah Ditta', 'Manzoor', 'Rabia', 'Nazia'];
const LAST = ['Khan', 'Ahmad', 'Iqbal', 'Hussain', 'Chaudhry', 'Malik', 'Akhtar', 'Shah', 'Rana', 'Sheikh', 'Bhatti', 'Awan', 'Qureshi', 'Abbasi', 'Jatoi', 'Arain', 'Sial', 'Baloch', 'Leghari', 'Mazari', 'Laar', 'Chachar', 'Dahar', 'Kalhoro'];
const personName = () => `${pick(FIRST)} ${pick(LAST)}`;

async function main() {
  await connectDb();
  const tenant = await runUnscoped(() => Tenant.findOne({ slug: SLUG }));
  if (!tenant) throw new Error(`Organisation ${SLUG} not found — run npm run seed first`);
  const tid = tenant._id;
  const passwordHash = await hashPassword(PASSWORD);

  await runAsTenant(tid, async () => {
    const division = await Unit.findOne({ type: 'division', name: /bahawalpur/i }).lean();
    if (!division) throw new Error('Bahawalpur Division not found');
    let cda: any = await Unit.findOne({ type: 'district', name: /cholistan/i }).lean();
    if (!cda) {
      const _id = new Types.ObjectId();
      cda = (await Unit.create({ _id, type: 'district', name: 'Cholistan Development Authority', code: 'CDA', parentId: division._id, anc: [...division.anc, _id] })).toObject();
    }
    const coUnits: any[] = [];
    for (const [name, code] of [['Colonization Officer-I (CDA)', 'COI'], ['Colonization Officer-II (CDA)', 'COII']]) {
      let u: any = await Unit.findOne({ type: 'tehsil', parentId: cda._id, name }).lean();
      if (!u) {
        const _id = new Types.ObjectId();
        u = (await Unit.create({ _id, type: 'tehsil', name, code, parentId: cda._id, anc: [...cda.anc, _id] })).toObject();
      }
      coUnits.push(u);
    }

    // Replace any earlier CDA mock data
    const below = await Unit.find({ anc: cda._id, type: { $in: ['qanungoi', 'circle', 'mouza'] } }).select('_id').lean();
    const oldUsers = await User.find({ email: /\.cda@bwp\.test$/ }).select('_id').lean();
    await Promise.all([
      RevEntry.deleteMany({ anc: cda._id }), RevTarget.deleteMany({ anc: cda._id }), Task.deleteMany({ anc: cda._id }),
      Charge.deleteMany({ $or: [{ unitId: { $in: [cda._id, ...coUnits.map((u) => u._id), ...below.map((u) => u._id)] } }, { userId: { $in: oldUsers.map((u) => u._id) } }] }),
    ]);
    await Unit.deleteMany({ _id: { $in: below.map((u) => u._id) } });
    await User.deleteMany({ _id: { $in: oldUsers.map((u) => u._id) } });

    const units: any[] = [];
    const mkUnit = (type: string, name: string, parent: any, code?: string) => {
      const _id = new Types.ObjectId();
      const u = { _id, tenantId: tid, type, name, code, parentId: parent._id, anc: [...parent.anc, _id] };
      units.push(u);
      return u;
    };
    const users: any[] = [];
    const mkUser = (key: string, designation: string, bps: number) => {
      const n = users.length;
      const u = { _id: new Types.ObjectId(), tenantId: tid, name: personName(), email: EMAIL(key), passwordHash, role: 'employee', designation, bps, status: 'active', employeeCode: `CDA-${1000 + n}`, phone: `0301-${String(10000000 + n).slice(1)}`, phoneE164: `+92301${String(10000000 + n).slice(1)}` };
      users.push(u);
      return u;
    };
    const charges: any[] = [];
    const posted = new Date('2025-07-01');
    const charge = (user: any, unit: any, post: string, chargeType = 'regular') => charges.push({ tenantId: tid, userId: user._id, unitId: unit._id, post, chargeType, from: posted, to: null });

    // CDA headquarters
    charge(mkUser('md', 'Managing Director, CDA', 20), cda, 'md_cda');
    charge(mkUser('drc', 'Director Revenue & Colonies, CDA', 19), cda, 'drc');
    charge(mkUser('reader', 'Reader, CDA', 14), cda, 'reader');
    charge(mkUser('colonyclerk', 'Colony Clerk, CDA', 11), cda, 'colony_clerk');

    // Colonization Officers, one Tehsildar for both, support staff per CO
    const tehsildar = mkUser('tehsildar', 'Tehsildar, CDA', 16);
    const naibs = [1, 2, 3].map((i) => mkUser(`naib${i}`, 'Naib Tehsildar, CDA', 14));
    const ros: { user: any; tehsil: any }[] = [];
    coUnits.forEach((co, i) => {
      charge(mkUser(`co${i + 1}`, `Colonization Officer-${i ? 'II' : 'I'}, CDA`, 18), co, 'co');
      charge(tehsildar, co, 'tehsildar', i ? 'additional' : 'regular');
      charge(mkUser(`wasilbaqi${i + 1}`, 'Wasil Baqi Navees, CDA', 11), co, 'wasilbaqi');
      charge(mkUser(`sci${i + 1}`, 'Service Centre In-charge, CDA', 14), co, 'sci');
      ros.push({ user: tehsildar, tehsil: co });
    });
    naibs.forEach((n, i) => ros.push({ user: n, tehsil: coUnits[i < 2 ? 0 : 1] }));

    // 18 qanungois, 9 under each CO; revenue officers: CO-I → Tehsildar, Naib-1, Naib-2; CO-II → Tehsildar, Naib-3
    const qanungois: any[] = [];
    coUnits.forEach((co, ci) => {
      for (let i = 0; i < 9; i++) {
        const n = ci * 9 + i + 1;
        const q = mkUnit('qanungoi', `CDA Qanungoi-${n} (test)`, co, `CDA-Q${n}`);
        qanungois.push(q);
        const ro = ci === 0 ? [tehsildar, naibs[0], naibs[1]][Math.floor(i / 3)] : i < 3 ? tehsildar : naibs[2];
        charge(ro, q, ro === tehsildar ? 'tehsildar' : 'naib_tehsildar');
        charge(mkUser(`girdawar${n}`, 'Girdawar (Qanungo), CDA', 11), q, 'girdawar');
      }
    });

    // 200 patwar circles (11–12 per qanungoi), a Patwari each, 1–3 chaks each
    const circles: any[] = [];
    let p = 0;
    qanungois.forEach((q, qi) => {
      const nC = qi < 200 - 11 * 18 ? 12 : 11; // 2 × 12 + 16 × 11 = 200
      for (let i = 0; i < nC; i++) {
        const c = mkUnit('circle', `PC ${q.code}-${String(i + 1).padStart(2, '0')} (test)`, q, `${q.code}-${i + 1}`);
        circles.push(c);
        for (let m = 0; m < int(1, 3); m++) mkUnit('mouza', `Chak ${q.code}-${i + 1}${String.fromCharCode(97 + m)} (test)`, c);
        charge(mkUser(`patwari${++p}`, 'Patwari, CDA', 9), c, 'patwari');
      }
    });

    await Unit.insertMany(units, { ordered: false });
    await User.insertMany(users, { ordered: false });
    await Charge.insertMany(charges, { ordered: false });
    logger.info(`CDA: ${qanungois.length} qanungois, ${circles.length} circles, ${units.length - qanungois.length - circles.length} mouzas; ${users.length} officers; ${charges.length} postings`);

    /* ---------------- Targets and monthly figures (same pattern as the districts) ---------------- */
    const BASE: Record<string, [number, number]> = {
      WR_RABI: [200_000, 1_200_000], WR_KHARIF: [200_000, 1_300_000], TAWAN_RABI: [0, 100_000], TAWAN_KHARIF: [0, 100_000],
      AIT_LAND: [60_000, 500_000], AIT_INCOME: [0, 200_000], LEASE: [100_000, 900_000], MUT_FEE: [60_000, 600_000],
      COND_FEE: [0, 100_000], STAMP: [200_000, 2_000_000], FBR_236C: [100_000, 1_500_000], FBR_236K: [50_000, 800_000],
    };
    const RABI = [0, 0, 0, 0, 0, 0, 0, 0.05, 0.15, 0.3, 0.3, 0.2];
    const KHARIF = [0.05, 0, 0, 0.15, 0.3, 0.3, 0.15, 0.05, 0, 0, 0, 0];
    const FLAT = Array(12).fill(1 / 12);
    const curve = (code: string) => (code.endsWith('RABI') ? RABI : code.endsWith('KHARIF') ? KHARIF : FLAT);
    const now = new Date();
    const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const FYS = ['2025-26', '2026-27'];
    const targets: any[] = [];
    const entries: any[] = [];
    const patwariOf = new Map(charges.filter((c) => c.post === 'patwari').map((c) => [String(c.unitId), c.userId]));
    const wbOf = new Map(charges.filter((c) => c.post === 'wasilbaqi').map((c) => [String(c.unitId), c.userId]));
    const sciOf = new Map(charges.filter((c) => c.post === 'sci').map((c) => [String(c.unitId), c.userId]));
    for (const c of circles) {
      const coId = String(c.anc[2]);
      const skill = 0.4 + rnd() * 0.65;
      for (const fy of FYS) {
        const months = fyMonths(fy).filter((m) => m < thisMonth);
        for (const h of REVENUE_HEADS) {
          const [lo, hi] = BASE[h.code];
          const target = rnd() < (lo === 0 ? 0.25 : 0) ? 0 : round(lo + rnd() * (hi - lo), 1000);
          const arrearDemand = round(target * (0.1 + rnd() * 0.4), 1000);
          targets.push({ tenantId: tid, fy, head: h.code, unitId: c._id, roUserId: null, anc: c.anc, target, arrearDemand, setBy: wbOf.get(coId) });
          if (!target && !arrearDemand) continue;
          const cv = curve(h.code);
          months.forEach((m, i) => {
            const cur = round(target * cv[i] * skill * (0.8 + rnd() * 0.4));
            const arr = round((arrearDemand / 12) * skill * 0.8 * (0.5 + rnd()));
            if (!cur && !arr) return;
            const latest = m === months[months.length - 1] && fy === FYS[1];
            const pending = latest && h.enteredBy === 'patwari' && rnd() < 0.5;
            const [y, mo] = m.split('-').map(Number);
            entries.push({
              tenantId: tid, fy, month: m, head: h.code, unitId: c._id, roUserId: null, anc: c.anc, current: cur, arrear: arr, ref: `PSID-${int(100000, 999999)}`,
              status: pending ? 'submitted' : 'verified', enteredBy: h.enteredBy === 'patwari' ? patwariOf.get(String(c._id)) : wbOf.get(coId),
              verifiedBy: pending ? undefined : wbOf.get(coId), verifiedAt: pending ? undefined : new Date(Math.min(Date.now(), new Date(y, mo, int(2, 10)).getTime())),
            });
          });
        }
        for (const h of CASE_HEADS.filter((x) => x.level === 'circle')) {
          const opening = int(0, h.code === 'GPC' ? 100 : 35);
          targets.push({ tenantId: tid, fy, head: h.code, unitId: c._id, roUserId: null, anc: c.anc, opening, setBy: wbOf.get(coId) });
          months.forEach((m) => {
            const received = int(0, h.code === 'GPC' ? 16 : 5);
            const disposed = Math.max(0, Math.round((received + opening / 12) * skill * (0.7 + rnd() * 0.5)));
            if (received || disposed) entries.push({ tenantId: tid, fy, month: m, head: h.code, unitId: c._id, roUserId: null, anc: c.anc, received, disposed, status: 'verified', enteredBy: sciOf.get(coId), verifiedBy: sciOf.get(coId) });
          });
        }
      }
    }
    for (const { user, tehsil } of ros) {
      const skill = 0.5 + rnd() * 0.6;
      for (const fy of FYS) {
        const months = fyMonths(fy).filter((m) => m < thisMonth);
        for (const h of CASE_HEADS.filter((x) => x.level === 'ro')) {
          if (targets.some((t) => t.fy === fy && t.head === h.code && String(t.unitId) === String(tehsil._id) && String(t.roUserId) === String(user._id))) continue;
          const opening = int(10, h.code === 'REGISTRY' ? 120 : 50);
          targets.push({ tenantId: tid, fy, head: h.code, unitId: tehsil._id, roUserId: user._id, anc: tehsil.anc, opening });
          months.forEach((m) => {
            const received = int(2, h.code === 'REGISTRY' ? 30 : 8);
            const disposed = Math.max(0, Math.round((received + opening / 12) * skill * (0.7 + rnd() * 0.5)));
            entries.push({ tenantId: tid, fy, month: m, head: h.code, unitId: tehsil._id, roUserId: user._id, anc: tehsil.anc, received, disposed, status: 'verified', enteredBy: user._id });
          });
        }
      }
    }
    for (let i = 0; i < targets.length; i += 20_000) await RevTarget.insertMany(targets.slice(i, i + 20_000), { ordered: false });
    for (let i = 0; i < entries.length; i += 20_000) await RevEntry.insertMany(entries.slice(i, i + 20_000), { ordered: false });
    logger.info(`CDA: ${targets.length} targets, ${entries.length} monthly figures`);

    // Refresh the pre-computed totals and caches so the CDA shows up at once
    const bp = await getBlueprint(String(tid));
    for (const fy of FYS) await buildRollups(String(tid), fy, bp!);
    await bumpData(String(tid));
    await invalidate('units', String(tid)).catch(() => {});
  });

  logger.info(`CDA mock data ready. Sign in with md.cda@bwp.test, drc.cda@bwp.test, co1.cda@bwp.test, tehsildar.cda@bwp.test, naib1.cda@bwp.test, girdawar1.cda@bwp.test, patwari1.cda@bwp.test — password ${PASSWORD}`);
  await closeRedis();
  await disconnectDb();
  process.exit(0); // job-queue connections opened by the rollup module would otherwise keep the process alive
}

main().catch(async (err) => {
  logger.error({ err }, 'CDA seed failed');
  await closeRedis();
  await disconnectDb();
  process.exit(1);
});

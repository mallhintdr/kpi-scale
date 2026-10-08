import { Router } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import { badRequest, forbidden } from '../../lib/errors.js';
import { atLeast } from '../../middleware/auth.js';
import { objectId, q, validate } from '../../middleware/validate.js';
import { Charge, RevEntry, RevTarget, Unit, User } from '../../models/index.js';
import { activeFilter, assertCanRead, browseRoots, myCharges, scopeRoots } from './access.js';
import {
  AUDIT_CATEGORIES, DATA_POSTS, HEADS, POSTS, POST_LABEL, POST_LEVEL, UNIT_LEVEL, fyElapsed, fyMonths, fyOf, isValidFy, type Post,
} from './catalog.js';
import { band, breakdown, configResolver, inUnit, loadFacts, rollup, scoreFacts, type FactSet } from './scoring.js';

const router = Router();
const fyQuery = z.object({ fy: z.string().optional() });
const resolveFy = (fy?: string) => {
  if (!fy) return fyOf(new Date());
  if (!isValidFy(fy)) throw badRequest('Invalid fiscal year, expected e.g. 2025-26');
  return fy;
};

/* Static metadata for the client */
router.get('/meta', (_req, res) => {
  const current = fyOf(new Date());
  const y = Number(current.slice(0, 4));
  res.json({
    heads: HEADS,
    posts: POSTS.map((p) => ({ code: p, label: POST_LABEL[p] })),
    auditCategories: AUDIT_CATEGORIES,
    currentFy: current,
    fys: [0, 1, 2].map((i) => `${y - i}-${String((y - i + 1) % 100).padStart(2, '0')}`),
  });
});

/* My postings and what I can do */
router.get('/me', async (req, res) => {
  const me = req.user!;
  const [charges, roots] = await Promise.all([myCharges(me.id), scopeRoots(me)]);
  const [rootUnits, browse] = await Promise.all([
    Unit.find({ _id: { $in: roots } }).select('type name').sort({ type: 1, name: 1 }).lean(),
    browseRoots(),
  ]);
  // Breadcrumb names for each charge
  const ancIds = [...new Set(charges.flatMap((c) => c.unit.anc.map(String)))];
  const names = new Map((await Unit.find({ _id: { $in: ancIds } }).select('name type').lean()).map((u) => [String(u._id), u]));
  res.json({
    isAdmin: atLeast(me.role, 'admin'),
    roots: rootUnits,
    browseRoots: browse,
    canCompare: atLeast(me.role, 'admin') || charges.some((c) => ['commissioner', 'dc', 'adc_rev'].includes(c.post)),
    charges: charges.map((c) => ({
      _id: c._id,
      post: c.post,
      postLabel: POST_LABEL[c.post],
      chargeType: c.chargeType,
      unit: { _id: c.unit._id, type: c.unit.type, name: c.unit.name },
      path: c.unit.anc.map((a) => names.get(String(a))?.name).filter(Boolean),
    })),
  });
});

/* Child units for pickers */
router.get('/units/:id/children', validate({ params: z.object({ id: objectId }) }), async (req, res) => {
  await assertCanRead(req.user!, req.params.id as string);
  res.json(await Unit.find({ parentId: req.params.id }).select('type name code').sort({ name: 1 }).lean());
});

/* Units of a type under a root (e.g. all circles of a tehsil) */
router.get(
  '/units/:id/descendants',
  validate({ params: z.object({ id: objectId }), query: z.object({ type: z.enum(['district', 'tehsil', 'qanungoi', 'circle', 'mouza']) }) }),
  async (req, res) => {
    await assertCanRead(req.user!, req.params.id as string);
    const items = await Unit.find({ anc: new Types.ObjectId(req.params.id as string), type: q<any>(req).type }).select('type name code parentId').sort({ name: 1 }).lean();
    res.json(items);
  },
);

async function holdersOf(unitIds: Types.ObjectId[]) {
  const rows = await Charge.find({ unitId: { $in: unitIds }, ...activeFilter() }).populate('userId', 'name designation bps phone').lean();
  return rows
    .filter((r) => r.userId)
    .map((r) => ({ unitId: String(r.unitId), post: r.post, postLabel: POST_LABEL[r.post as Post], chargeType: r.chargeType, user: r.userId }));
}

/* Unit explorer: score, breakdown, ranked children, officers in charge */
router.get('/units/:id', validate({ params: z.object({ id: objectId }), query: fyQuery }), async (req, res) => {
  const fy = resolveFy(q<any>(req).fy);
  const unit = await assertCanRead(req.user!, req.params.id as string);
  const [facts, resolve, path, children] = await Promise.all([
    loadFacts(unit._id, fy),
    configResolver(),
    Unit.find({ _id: { $in: unit.anc } }).select('type name').lean(),
    Unit.find({ parentId: unit._id }).select('type name code').sort({ name: 1 }).lean(),
  ]);
  const level = UNIT_LEVEL[unit.type as keyof typeof UNIT_LEVEL] ?? 'patwari';
  const anc = unit.anc.map(String);
  const f = rollup(facts.rows, inUnit(String(unit._id)));
  const own = scoreFacts(f, level, resolve(anc));

  const childLevel = (t: string) => UNIT_LEVEL[t as keyof typeof UNIT_LEVEL] ?? 'patwari';
  const scoredChildren = children
    .map((c) => {
      const cf = rollup(facts.rows, inUnit(String(c._id)));
      const s = scoreFacts(cf, childLevel(c.type), resolve([...anc, String(c._id)]));
      const b = breakdown(cf);
      return { ...c, score: s.score, band: band(s.score), blocks: s.blocks, target: b.totals.target, collected: b.totals.collected };
    })
    .sort((a, b) => (b.score ?? -1) - (a.score ?? -1))
    .map((c, i) => ({ ...c, rank: c.score == null ? null : i + 1 }));

  // Monthly verified collections (this FY and last FY) for the trend chart
  const prevFy = `${Number(fy.slice(0, 4)) - 1}-${fy.slice(2, 4)}`;
  const revenueCodes = HEADS.filter((h) => h.kind === 'revenue').map((h) => h.code);
  const monthly = await RevEntry.aggregate<{ _id: { fy: string; m: string }; cur: number; arr: number }>([
    { $match: { fy: { $in: [fy, prevFy] }, anc: unit._id, status: 'verified', head: { $in: revenueCodes } } },
    { $group: { _id: { fy: '$fy', m: '$month' }, cur: { $sum: '$current' }, arr: { $sum: '$arrear' } } },
  ]);
  const prevTarget = (await RevTarget.aggregate<{ t: number }>([
    { $match: { fy: prevFy, anc: unit._id, head: { $in: revenueCodes } } },
    { $group: { _id: null, t: { $sum: '$target' } } },
  ]))[0]?.t ?? 0;
  const series = (f: string) => fyMonths(f).map((m) => {
    const r = monthly.find((x) => x._id.fy === f && x._id.m === m);
    return { month: m, current: r?.cur ?? 0, arrear: r?.arr ?? 0 };
  });

  const holders = await holdersOf([unit._id, ...children.map((c) => c._id)]);
  const sortedPath = unit.anc.map((a) => path.find((p) => String(p._id) === String(a))).filter(Boolean);

  res.json({
    fy,
    elapsed: Math.round(fyElapsed(fy) * 1000) / 10,
    unit: { _id: unit._id, type: unit.type, name: unit.name, code: unit.code },
    path: sortedPath,
    level,
    score: own.score,
    band: band(own.score),
    blocks: own.blocks,
    weights: own.weights,
    configSource: resolve(anc).sourceUnitId,
    ...breakdown(f),
    children: scoredChildren,
    trend: { fy, prevFy, current: series(fy), previous: series(prevFy), prevTarget },
    holders: holders.filter((h) => h.unitId === String(unit._id)),
    childHolders: holders.filter((h) => h.unitId !== String(unit._id)),
  });
});

/* ------------------------------------------------------------------ *
 *  Officer scores
 * ------------------------------------------------------------------ */

interface OfficerCharge { userId: string; post: Post; unitId: string; anc: string[] }

/** Facts for one officer: the units they hold (+ their own RO registers). */
function officerFacts(facts: FactSet, charges: OfficerCharge[], post: Post, includeRo = true) {
  const userId = charges[0].userId;
  const isRo = (post === 'tehsildar' || post === 'naib_tehsildar') && includeRo;
  // RO score uses directly-held qanungois (+ own registers); tehsil-level charge is scored as the tehsil.
  const unitIds = charges.filter((c) => !(isRo && c.post === 'tehsildar' && facts.units.get(c.unitId)?.type === 'tehsil')).map((c) => c.unitId);
  const f = rollup(facts.rows, (r) => (r.roUserId ? isRo && r.roUserId === userId : unitIds.some((u) => r.anc.includes(u))));
  return { f, unitIds };
}

const r1 = (v: number) => Math.round(v * 10) / 10;

/** Score one officer from the charges they hold, using an already-loaded fact set. */
function officerScore(facts: FactSet, resolve: Awaited<ReturnType<typeof configResolver>>, charges: OfficerCharge[], post: Post, includeRo = true) {
  const { f, unitIds } = officerFacts(facts, charges, post, includeRo);
  const s = scoreFacts(f, POST_LEVEL[post], resolve(charges[0].anc));
  const b = breakdown(f);
  // Compact per-head figures for the staff matrix
  const heads: Record<string, { pct: number | null; done: number; of: number }> = {};
  for (const r of b.revenue) if (r.target > 0) heads[r.code] = { pct: r.pct, done: r.collected, of: r.target };
  for (const c of b.cases) if (c.opening + c.received > 0) heads[c.code] = { pct: c.pct, done: c.disposed, of: c.opening + c.received };
  const ad = b.arrears.total;
  if (ad.demand > 0) heads.ARREARS = { pct: r1(Math.min(100, (ad.collected / ad.demand) * 100)), done: ad.collected, of: ad.demand };
  if (b.audit.n > 0) heads.AUDIT = { pct: b.audit.amt ? r1(Math.min(100, (b.audit.rec / b.audit.amt) * 100)) : null, done: b.audit.settled, of: b.audit.n };
  if (b.tasks.due > 0) heads.TASKS = { pct: r1((b.tasks.onTime / b.tasks.due) * 100), done: b.tasks.onTime, of: b.tasks.due };
  return { score: s.score, band: band(s.score), blocks: s.blocks, target: b.totals.target, collected: b.totals.collected, units: unitIds.length, heads };
}

/* League table of officers of one post within a unit */
router.get(
  '/league',
  validate({ query: fyQuery.extend({ unitId: objectId, post: z.enum(POSTS) }) }),
  async (req, res) => {
    const { unitId, post } = q<{ unitId: string; post: Post }>(req);
    const fy = resolveFy(q<any>(req).fy);
    const unit = await assertCanRead(req.user!, unitId);
    if (DATA_POSTS.includes(post)) throw badRequest(`${POST_LABEL[post]} is not scored`);

    const [facts, resolve] = await Promise.all([loadFacts(unit._id, fy), configResolver()]);
    const subtree = [...facts.units.keys()];
    const posts = post === 'tehsildar' ? ['tehsildar'] : [post];
    const rows = await Charge.find({ post: { $in: posts }, unitId: { $in: subtree }, ...activeFilter() }).lean();
    const byUser = new Map<string, OfficerCharge[]>();
    for (const r of rows) {
      const anc = facts.units.get(String(r.unitId))?.anc.map(String) ?? [];
      const list = byUser.get(String(r.userId)) ?? [];
      list.push({ userId: String(r.userId), post: r.post as Post, unitId: String(r.unitId), anc });
      byUser.set(String(r.userId), list);
    }
    const users = new Map((await User.find({ _id: { $in: [...byUser.keys()] } }).select('name designation bps phone').lean()).map((u) => [String(u._id), u]));
    const unitName = (id: string) => facts.units.get(id)?.name;
    const typeOf = (id: string) => facts.units.get(id)?.type;
    const chargeType = new Map(rows.map((r) => [`${r.userId}|${r.unitId}`, r.chargeType]));
    const isRoPost = post === 'tehsildar' || post === 'naib_tehsildar';
    // One row per charge: an officer with an additional charge is listed (and scored) once per unit held.
    const items = [...byUser.entries()]
      .flatMap(([uid, charges]) => {
        // A Tehsildar's tehsil-level charge is scored as the tehsil, not as a revenue officer: skip that row
        // when they also hold qanungois directly.
        const own = isRoPost && charges.some((c) => typeOf(c.unitId) === 'qanungoi') ? charges.filter((c) => typeOf(c.unitId) !== 'tehsil') : charges;
        return own.map((c, i) => {
          const u = facts.units.get(c.unitId);
          const context = u?.anc.slice(1, -1).map((a) => unitName(String(a))).filter(Boolean).slice(-2).join(' › ');
          const ofType = (t: string) => u?.anc.map((x) => facts.units.get(String(x))).find((x) => x?.type === t)?.name;
          return {
            user: users.get(uid),
            unitId: c.unitId,
            charges: [unitName(c.unitId)],
            chargeType: chargeType.get(`${uid}|${c.unitId}`) ?? 'regular',
            chargeCount: own.length,
            district: ofType('district'),
            tehsil: ofType('tehsil'),
            context,
            // RO registers belong to the person, not a qanungoi: counted on their first row only
            ...officerScore(facts, resolve, [c], post, i === 0),
          };
        });
      })
      .filter((x) => x.user)
      .sort((a, b) => (b.score ?? -1) - (a.score ?? -1))
      .map((x, i) => ({ ...x, rank: x.score == null ? null : i + 1 }));
    res.json({ fy, unit: { _id: unit._id, name: unit.name, type: unit.type }, post, postLabel: POST_LABEL[post], items });
  },
);

/* My own officer score(s), one per post held */
router.get('/my-score', validate({ query: fyQuery }), async (req, res) => {
  const fy = resolveFy(q<any>(req).fy);
  const charges = await myCharges(req.user!.id);
  const scored = charges.filter((c) => !DATA_POSTS.includes(c.post));
  if (!scored.length) return res.json({ fy, items: [] });
  const resolve = await configResolver();
  // Load facts once at the broadest unit held (its tehsil or higher covers the RO registers too)
  const tehsilOrTop = (c: (typeof scored)[number]) => c.unit.anc[Math.min(c.unit.anc.length - 1, 2)] ?? c.unit._id;
  const root = tehsilOrTop(scored.reduce((a, b) => (a.unit.anc.length <= b.unit.anc.length ? a : b)));
  const facts = await loadFacts(root, fy);
  const byPost = new Map<Post, OfficerCharge[]>();
  for (const c of scored) {
    const p: Post = c.post === 'tehsildar' && c.unit.type === 'qanungoi' ? 'tehsildar' : c.post;
    const list = byPost.get(p) ?? [];
    list.push({ userId: req.user!.id, post: c.post, unitId: String(c.unit._id), anc: c.unit.anc.map(String) });
    byPost.set(p, list);
  }
  res.json({
    fy,
    items: [...byPost.entries()].map(([post, list]) => ({ post, postLabel: POST_LABEL[post], ...officerScore(facts, resolve, list, post) })),
  });
});

/* ------------------------------------------------------------------ *
 *  One officer's full breakdown (visible to the officer and anyone above them)
 * ------------------------------------------------------------------ */
type MyChargeLite = Awaited<ReturnType<typeof myCharges>>[number];

/* ------------------------------------------------------------------ *
 *  Comparison: every district / tehsil / qanungoi under a unit, per head
 *  (Commissioner, DC, ADC(R) and admins)
 * ------------------------------------------------------------------ */
router.get(
  '/compare',
  validate({ query: fyQuery.extend({ unitId: objectId, type: z.enum(['district', 'tehsil', 'qanungoi']) }) }),
  async (req, res) => {
    const me = req.user!;
    const charges = await myCharges(me.id);
    if (!atLeast(me.role, 'admin') && !charges.some((c) => ['commissioner', 'dc', 'adc_rev'].includes(c.post))) {
      throw forbidden('Comparison is available to the Commissioner, DC and ADC (Revenue)');
    }
    const { unitId, type } = q<{ unitId: string; type: 'district' | 'tehsil' | 'qanungoi' }>(req);
    const fy = resolveFy(q<any>(req).fy);
    const root = await assertCanRead(me, unitId);
    const [facts, resolve] = await Promise.all([loadFacts(root._id, fy), configResolver()]);
    const units = [...facts.units.values()].filter((u) => u.type === type).sort((a, b) => a.name.localeCompare(b.name));
    const parentName = (u: (typeof units)[number]) => (u.parentId ? facts.units.get(String(u.parentId))?.name : undefined);

    const items = units.map((u) => {
      const f = rollup(facts.rows, inUnit(String(u._id)));
      const b = breakdown(f);
      const s = scoreFacts(f, UNIT_LEVEL[type] ?? 'tehsil', resolve(u.anc.map(String)));
      const heads: Record<string, { pct: number | null; done: number; of: number }> = {};
      const pct = (d: number, o: number) => (o > 0 ? Math.round(Math.min(100, (d / o) * 100) * 10) / 10 : null);
      for (const r of b.revenue) if (r.target > 0) heads[r.code] = { pct: r.pct, done: r.collected, of: r.target };
      for (const c of b.cases) if (c.opening + c.received > 0) heads[c.code] = { pct: c.pct, done: c.disposed, of: c.opening + c.received };
      heads.REVENUE = { pct: pct(b.totals.collected, b.totals.target), done: b.totals.collected, of: b.totals.target };
      if (b.arrears.total.demand > 0) heads.ARREARS = { pct: pct(b.arrears.total.collected, b.arrears.total.demand), done: b.arrears.total.collected, of: b.arrears.total.demand };
      if (b.audit.n > 0) heads.AUDIT = { pct: b.audit.amt ? pct(b.audit.rec, b.audit.amt) : null, done: b.audit.rec, of: b.audit.amt };
      if (b.tasks.due > 0) heads.TASKS = { pct: pct(b.tasks.onTime, b.tasks.due), done: b.tasks.onTime, of: b.tasks.due };
      if (s.score != null) heads.SCORE = { pct: s.score, done: s.score, of: 100 };
      return { _id: u._id, name: u.name, parent: parentName(u), heads };
    });
    res.json({ fy, root: { _id: root._id, name: root.name, type: root.type }, type, items });
  },
);

router.get(
  '/officers/:userId',
  validate({ params: z.object({ userId: objectId }), query: fyQuery.extend({ post: z.enum(POSTS).optional() }) }),
  async (req, res) => {
    const fy = resolveFy(q<any>(req).fy);
    const { userId } = req.params as { userId: string };
    const [user, all] = await Promise.all([
      User.findById(userId).select('name designation bps phone email employeeCode').lean(),
      myCharges(userId),
    ]);
    if (!user) throw badRequest('Officer not found');
    const charges = all.filter((c) => !DATA_POSTS.includes(c.post));
    if (!charges.length) throw badRequest('This officer holds no scored posting');

    // Read-only: every employee may view any officer's performance in the organisation.

    // Group charges by scoring post; an officer may hold more than one
    const byPost = new Map<Post, MyChargeLite[]>();
    for (const c of charges) {
      const p: Post = c.post === 'tehsildar' && c.unit.type === 'qanungoi' ? 'tehsildar' : c.post;
      byPost.set(p, [...(byPost.get(p) ?? []), c]);
    }
    const posts = [...byPost.keys()];
    const wanted = q<any>(req).post as Post | undefined;
    const post = (wanted && byPost.has(wanted) ? wanted : posts[0]) as Post;
    const list = byPost.get(post)!;
    const oc: OfficerCharge[] = list.map((c) => ({ userId, post: c.post, unitId: String(c.unit._id), anc: c.unit.anc.map(String) }));

    const top = list.reduce((a, b) => (a.unit.anc.length <= b.unit.anc.length ? a : b)).unit;
    const factsRoot = top.anc[Math.min(top.anc.length - 1, 2)] ?? top._id; // tehsil or higher also covers RO registers
    const [facts, resolve] = await Promise.all([loadFacts(factsRoot, fy), configResolver()]);
    const { f, unitIds } = officerFacts(facts, oc, post);
    const s = scoreFacts(f, POST_LEVEL[post], resolve(oc[0].anc));

    // Monthly trend across the officer's units
    const prevFy = `${Number(fy.slice(0, 4)) - 1}-${fy.slice(2, 4)}`;
    const revenueCodes = HEADS.filter((h) => h.kind === 'revenue').map((h) => h.code);
    const ids = unitIds.map((u) => new Types.ObjectId(u));
    const monthly = ids.length
      ? await RevEntry.aggregate<{ _id: { fy: string; m: string }; cur: number; arr: number }>([
          { $match: { fy: { $in: [fy, prevFy] }, anc: { $in: ids }, status: 'verified', head: { $in: revenueCodes } } },
          { $group: { _id: { fy: '$fy', m: '$month' }, cur: { $sum: '$current' }, arr: { $sum: '$arrear' } } },
        ])
      : [];
    const series = (fyx: string) => fyMonths(fyx).map((m) => {
      const r = monthly.find((x) => x._id.fy === fyx && x._id.m === m);
      return { month: m, current: r?.cur ?? 0, arrear: r?.arr ?? 0 };
    });

    const ancIds = [...new Set(list.flatMap((c) => c.unit.anc.map(String)))];
    const names = new Map((await Unit.find({ _id: { $in: ancIds } }).select('name type').lean()).map((u) => [String(u._id), u]));
    res.json({
      fy,
      elapsed: Math.round(fyElapsed(fy) * 1000) / 10,
      officer: user,
      post,
      postLabel: POST_LABEL[post],
      posts: posts.map((p) => ({ code: p, label: POST_LABEL[p] })),
      charges: list.map((c) => ({
        post: c.post, postLabel: POST_LABEL[c.post], chargeType: c.chargeType,
        unit: { _id: c.unit._id, name: c.unit.name, type: c.unit.type },
        path: c.unit.anc.map((a) => names.get(String(a))?.name).filter(Boolean),
      })),
      // Same shape as the unit explorer so the client can reuse its views
      unit: { _id: String(top._id), type: top.type, name: user.name },
      path: [],
      level: POST_LEVEL[post],
      score: s.score,
      band: band(s.score),
      blocks: s.blocks,
      weights: s.weights,
      configSource: null,
      ...breakdown(f),
      children: [],
      holders: [],
      childHolders: [],
      trend: { fy, prevFy, current: series(fy), previous: series(prevFy), prevTarget: 0 },
    });
  },
);

export default router;

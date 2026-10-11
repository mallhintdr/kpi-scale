import { Router } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import { cached, dataVersion } from '../../lib/cache.js';
import { badRequest, forbidden } from '../../lib/errors.js';
import { atLeast } from '../../middleware/auth.js';
import { objectId, q, validate } from '../../middleware/validate.js';
import { Charge, RevEntry, RevTarget, Unit, User } from '../../models/index.js';
import { publicBlueprint, type BP } from '../org/blueprint.js';
import { bpOf } from '../org/service.js';
import { activeFilter, assertCanRead, browseRootsFor, grantsOf, hasCap, myCharges, scopeRoots } from './access.js';
import { breakdown, configResolver, headCells, inUnit, loadFacts, rollup, scoreFacts, type FactSet } from './scoring.js';

const router = Router();
const fyQuery = z.object({ fy: z.string().optional() });
const resolveFy = (bp: BP, fy?: string) => {
  if (!fy) return bp.fy.of(new Date());
  if (!bp.fy.valid(fy)) throw badRequest(`Invalid financial year, expected e.g. ${bp.fy.of(new Date())}`);
  return fy;
};
/**
 * Read-only views are the same for every viewer in an organisation, so whole responses are cached
 * under the organisation's data version + blueprint version: any write makes them stale at once.
 */
async function view<T>(req: { user?: { tenantId: string } }, bp: BP, key: string, fn: () => Promise<T>): Promise<T> {
  const t = req.user!.tenantId;
  const dv = await dataVersion(t);
  return cached(`view:${t}:${key}:${dv}:${bp.version}`, 600, fn);
}

const levelKey = (bp: BP) => z.string().refine((v) => bp.level.has(v), 'Unknown level');

/* Organisation metadata for the client: the blueprint plus legacy head list */
router.get('/meta', (req, res) => {
  const bp = bpOf(req);
  res.json({
    ...publicBlueprint(bp),
    // Flat KPI list in the shape lists and entry screens use
    heads: bp.metrics.map((m) => ({
      code: m.code, name: m.name, group: m.group, block: m.block, unit: m.unit,
      kind: bp.kindOf(m.code) === 'target' ? 'revenue' : 'case',
      crop: m.tag, tag: m.tag, perHolder: m.perHolder, level: m.level, weight: m.weight, arrears: m.arrears,
      enterPosts: m.enterPosts, verifyPosts: m.verifyPosts, holderPosts: m.holderPosts,
    })),
    auditCategories: bp.registers[0]?.categories ?? [],
    currentFy: bp.fy.of(new Date()),
    fys: bp.fy.list(3),
  });
});

/* My postings and what I can do */
router.get('/me', async (req, res) => {
  const me = req.user!;
  const bp = bpOf(req);
  const [charges, roots] = await Promise.all([myCharges(me.id), scopeRoots(me, bp)]);
  const [rootUnits, browse, grants] = await Promise.all([
    Unit.find({ _id: { $in: roots } }).select('type name').sort({ type: 1, name: 1 }).lean(),
    browseRootsFor(me, bp),
    grantsOf(me),
  ]);
  const grantUnits = new Map((await Unit.find({ _id: { $in: grants.map((g) => g.unitId) } }).select('type name anc').lean()).map((u) => [String(u._id), u]));
  const granted = (r: string) => grants.some((g) => g.rights.includes(r as never));
  const ancIds = [...new Set(charges.flatMap((c) => c.unit.anc.map(String)))];
  const names = new Map((await Unit.find({ _id: { $in: ancIds } }).select('name type').lean()).map((u) => [String(u._id), u]));
  const admin = atLeast(me.role, 'admin');
  const posts = new Set(charges.map((c) => c.post));
  const any = (list: string[]) => list.some((p) => posts.has(p));
  const capOf = (cap: Parameters<BP['postsWithCap']>[0]) => admin || any(bp.postsWithCap(cap)) || granted(cap);
  res.json({
    isAdmin: admin,
    roots: rootUnits,
    browseRoots: browse,
    canCompare: capOf('compare'),
    caps: {
      canEnter: admin || granted('enter') || granted('edit') || bp.metrics.some((m) => any(m.enterPosts) || (m.perHolder && any(m.holderPosts))),
      canVerify: admin || granted('verify') || bp.metrics.some((m) => any(m.verifyPosts)),
      canSetTargets: capOf('set_targets'),
      canAssign: capOf('assign_targets'),
      canCompare: capOf('compare'),
      canManageRegisters: capOf('manage_registers'),
      registers: bp.registers.filter((r) => admin || any(r.enterPosts) || granted('manage_registers')).map((r) => r.key),
      isScored: [...posts].some((p) => bp.post.get(p)?.scored),
    },
    // Rights granted to this person directly (the entry and target screens use them as extra areas)
    grants: grants.map((g) => ({ ...g, unit: grantUnits.get(g.unitId) ? { _id: g.unitId, type: grantUnits.get(g.unitId)!.type, name: grantUnits.get(g.unitId)!.name, anc: grantUnits.get(g.unitId)!.anc.map(String) } : null })),
    charges: charges.map((c) => ({
      _id: c._id,
      post: c.post,
      postLabel: bp.postLabel(c.post),
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

/* Units of a level under a root (e.g. all circles of a tehsil) */
router.get('/units/:id/descendants', validate({ params: z.object({ id: objectId }), query: z.object({ type: z.string().max(40) }) }), async (req, res) => {
  const bp = bpOf(req);
  const type = q<{ type: string }>(req).type;
  if (!bp.level.has(type)) throw badRequest('Unknown level');
  await assertCanRead(req.user!, req.params.id as string);
  const items = await Unit.find({ anc: new Types.ObjectId(req.params.id as string), type }).select('type name code parentId').sort({ name: 1 }).lean();
  res.json(items);
});

async function holdersOf(bp: BP, unitIds: Types.ObjectId[]) {
  const rows = await Charge.find({ unitId: { $in: unitIds }, ...activeFilter() }).populate('userId', 'name designation bps phone').lean();
  return rows
    .filter((r) => r.userId)
    .map((r) => ({ unitId: String(r.unitId), post: r.post, postLabel: bp.postLabel(r.post), chargeType: r.chargeType, user: r.userId }));
}

/** Monthly verified achievement on money target KPIs, this FY and last, for trend charts. */
async function trendFor(bp: BP, fy: string, match: Record<string, unknown>) {
  const prevFy = bp.fy.prev(fy);
  const codes = bp.targetMetrics.filter((m) => m.unit === 'money').map((m) => m.code);
  const monthly = await RevEntry.aggregate<{ _id: { fy: string; m: string }; cur: number; arr: number }>([
    { $match: { fy: { $in: [fy, prevFy] }, status: 'verified', head: { $in: codes }, ...match } },
    { $group: { _id: { fy: '$fy', m: '$month' }, cur: { $sum: '$current' }, arr: { $sum: '$arrear' } } },
  ]);
  const series = (f: string) => bp.fy.months(f).map((m) => {
    const r = monthly.find((x) => x._id.fy === f && x._id.m === m);
    return { month: m, current: r?.cur ?? 0, arrear: r?.arr ?? 0 };
  });
  return { prevFy, codes, current: series(fy), previous: series(prevFy) };
}

/* Unit explorer: score, breakdown, ranked children, officers in charge */
router.get('/units/:id', validate({ params: z.object({ id: objectId }), query: fyQuery }), async (req, res) => {
  const bp = bpOf(req);
  const fy = resolveFy(bp, q<any>(req).fy);
  const unit = await assertCanRead(req.user!, req.params.id as string);
  res.json(await view(req, bp, `unit:${unit._id}:${fy}`, () => unitView(bp, unit, fy)));
});

async function unitView(bp: BP, unit: any, fy: string) {
  const [facts, resolve, path, children] = await Promise.all([
    loadFacts(unit._id, fy, bp),
    configResolver(bp),
    Unit.find({ _id: { $in: unit.anc } }).select('type name').lean(),
    Unit.find({ parentId: unit._id }).select('type name code').sort({ name: 1 }).lean(),
  ]);
  const level = bp.profileForLevel(unit.type);
  const anc: string[] = unit.anc.map(String);
  const f = rollup(facts.rows, inUnit(String(unit._id)));
  const own = scoreFacts(f, level, resolve(anc), bp);

  const scoredChildren = children
    .map((c) => {
      const cf = rollup(facts.rows, inUnit(String(c._id)));
      const s = scoreFacts(cf, bp.profileForLevel(c.type), resolve([...anc, String(c._id)]), bp);
      const b = breakdown(cf, bp);
      return { ...c, score: s.score, band: bp.band(s.score), blocks: s.blocks, target: b.totals.target, collected: b.totals.collected };
    })
    .sort((a, b) => (b.score ?? -1) - (a.score ?? -1))
    .map((c, i) => ({ ...c, rank: c.score == null ? null : i + 1 }));

  const trend = await trendFor(bp, fy, { anc: unit._id });
  const prevTarget = (await RevTarget.aggregate<{ t: number }>([
    { $match: { fy: trend.prevFy, anc: unit._id, head: { $in: trend.codes } } },
    { $group: { _id: null, t: { $sum: '$target' } } },
  ]))[0]?.t ?? 0;

  const holders = await holdersOf(bp, [unit._id, ...children.map((c) => c._id)]);
  const sortedPath = unit.anc.map((a: Types.ObjectId) => path.find((p) => String(p._id) === String(a))).filter(Boolean);

  return {
    fy,
    elapsed: Math.round(bp.fy.elapsed(fy) * 1000) / 10,
    unit: { _id: unit._id, type: unit.type, name: unit.name, code: unit.code },
    path: sortedPath,
    level,
    score: own.score,
    band: bp.band(own.score),
    blocks: own.blocks,
    weights: own.weights,
    configSource: resolve(anc).sourceUnitId,
    ...breakdown(f, bp),
    children: scoredChildren,
    trend: { fy, prevFy: trend.prevFy, current: trend.current, previous: trend.previous, prevTarget },
    holders: holders.filter((h) => h.unitId === String(unit._id)),
    childHolders: holders.filter((h) => h.unitId !== String(unit._id)),
  };
}

/* ------------------------------------------------------------------ *
 *  Officer scores
 * ------------------------------------------------------------------ */
interface OfficerCharge { userId: string; post: string; unitId: string; anc: string[] }

/**
 * Facts for one officer: the units they hold, plus their own per-holder KPI rows.
 * Charges at a post's `oversightAt` levels are supervisory and are not counted as the officer's own area.
 */
function officerFacts(bp: BP, facts: FactSet, charges: OfficerCharge[], post: string, includeHolder = true) {
  const userId = charges[0].userId;
  const isHolder = bp.holderPosts.has(post) && includeHolder;
  const oversight = bp.post.get(post)?.oversightAt ?? [];
  const unitIds = charges.filter((c) => !(isHolder && oversight.includes(facts.units.get(c.unitId)?.type ?? ''))).map((c) => c.unitId);
  const f = rollup(facts.rows, (r) => (r.roUserId ? isHolder && r.roUserId === userId : unitIds.some((u) => r.anc.includes(u))));
  return { f, unitIds };
}

/** Score one officer from the charges they hold, using an already-loaded fact set. */
function officerScore(bp: BP, facts: FactSet, resolve: Awaited<ReturnType<typeof configResolver>>, charges: OfficerCharge[], post: string, includeHolder = true) {
  const { f, unitIds } = officerFacts(bp, facts, charges, post, includeHolder);
  const lvl = facts.units.get(charges[0].unitId)?.type;
  const s = scoreFacts(f, bp.profileForPost(post, lvl), resolve(charges[0].anc), bp);
  const b = breakdown(f, bp);
  return { score: s.score, band: bp.band(s.score), blocks: s.blocks, weights: s.weights, target: b.totals.target, collected: b.totals.collected, units: unitIds.length, heads: headCells(b, bp) };
}

/** Facts root for an officer: their shallowest unit, raised to the shallowest per-holder KPI level so their own rows are covered. */
function factsRootFor(bp: BP, units: { anc: Types.ObjectId[] | string[]; _id: Types.ObjectId | string }[]) {
  const top = units.reduce((a, b) => (a.anc.length <= b.anc.length ? a : b));
  const holderDepths = bp.metrics.filter((m) => m.perHolder).map((m) => bp.levelIndex.get(m.level) ?? 0);
  if (!holderDepths.length) return top._id;
  const depth = Math.min(top.anc.length - 1, Math.min(...holderDepths));
  return top.anc[depth] ?? top._id;
}

/** Name of each ancestor by level key, for list columns. */
const areasOf = (facts: FactSet, unitId: string) => {
  const u = facts.units.get(unitId);
  const out: Record<string, string> = {};
  for (const a of u?.anc ?? []) {
    const x = facts.units.get(String(a));
    if (x) out[x.type] = x.name;
  }
  return out;
};

/* League table of officers of one post within a unit */
router.get('/league', validate({ query: fyQuery.extend({ unitId: objectId, post: z.string().max(40) }) }), async (req, res) => {
  const bp = bpOf(req);
  const { unitId, post } = q<{ unitId: string; post: string }>(req);
  if (!bp.post.has(post)) throw badRequest('Unknown post');
  const fy = resolveFy(bp, q<any>(req).fy);
  const unit = await assertCanRead(req.user!, unitId);
  if (bp.dataPosts.has(post)) throw badRequest(`${bp.postLabel(post)} is not scored`);
  res.json(await view(req, bp, `league:${unit._id}:${post}:${fy}`, () => leagueView(bp, unit, post, fy)));
});

export async function leagueView(bp: BP, unit: any, post: string, fy: string) {

  const [facts, resolve] = await Promise.all([loadFacts(unit._id, fy, bp), configResolver(bp)]);
  const subtree = [...facts.units.keys()];
  const rows = await Charge.find({ post, unitId: { $in: subtree }, ...activeFilter() }).lean();
  const byUser = new Map<string, OfficerCharge[]>();
  for (const r of rows) {
    const anc = facts.units.get(String(r.unitId))?.anc ?? [];
    const list = byUser.get(String(r.userId)) ?? [];
    list.push({ userId: String(r.userId), post: r.post, unitId: String(r.unitId), anc });
    byUser.set(String(r.userId), list);
  }
  const users = new Map((await User.find({ _id: { $in: [...byUser.keys()] } }).select('name designation bps phone').lean()).map((u) => [String(u._id), u]));
  const unitName = (id: string) => facts.units.get(id)?.name;
  const typeOf = (id: string) => facts.units.get(id)?.type ?? '';
  const chargeType = new Map(rows.map((r) => [`${r.userId}|${r.unitId}`, r.chargeType]));
  const isHolderPost = bp.holderPosts.has(post);
  const oversight = bp.post.get(post)?.oversightAt ?? [];
  // One row per charge: an officer with an additional charge is listed (and scored) once per unit held.
  const items = [...byUser.entries()]
    .flatMap(([uid, charges]) => {
      // A supervisory (oversight-level) charge is not a row of its own when the officer also holds units directly.
      const own = isHolderPost && charges.some((c) => !oversight.includes(typeOf(c.unitId))) ? charges.filter((c) => !oversight.includes(typeOf(c.unitId))) : charges;
      return own.map((c, i) => {
        const u = facts.units.get(c.unitId);
        const context = u?.anc.slice(1, -1).map((a) => unitName(String(a))).filter(Boolean).slice(-2).join(' › ');
        const areas = areasOf(facts, c.unitId);
        return {
          user: users.get(uid),
          unitId: c.unitId,
          charges: [unitName(c.unitId)],
          chargeType: chargeType.get(`${uid}|${c.unitId}`) ?? 'regular',
          chargeCount: own.length,
          areas,
          context,
          // Per-holder rows belong to the person, not a unit: counted on their first row only
          ...officerScore(bp, facts, resolve, [c], post, i === 0),
        };
      });
    })
    .filter((x) => x.user)
    .sort((a, b) => (b.score ?? -1) - (a.score ?? -1))
    .map((x, i) => ({ ...x, rank: x.score == null ? null : i + 1 }));
  return { fy, unit: { _id: unit._id, name: unit.name, type: unit.type }, post, postLabel: bp.postLabel(post), items };
}

/* My own officer score(s), one per post held */
/** A person's own score(s), one per scored post they hold (also used by the WhatsApp digests). */
export async function scoresForUser(bp: BP, userId: string, fy: string) {
  const charges = await myCharges(userId);
  const scored = charges.filter((c) => !bp.dataPosts.has(c.post));
  if (!scored.length) return [];
  const resolve = await configResolver(bp);
  const facts = await loadFacts(factsRootFor(bp, scored.map((c) => c.unit)), fy, bp);
  const byPost = new Map<string, OfficerCharge[]>();
  for (const c of scored) {
    const list = byPost.get(c.post) ?? [];
    list.push({ userId, post: c.post, unitId: String(c.unit._id), anc: c.unit.anc.map(String) });
    byPost.set(c.post, list);
  }
  return [...byPost.entries()].map(([post, list]) => ({ post, postLabel: bp.postLabel(post), unitIds: list.map((l) => l.unitId), ...officerScore(bp, facts, resolve, list, post) }));
}

router.get('/my-score', validate({ query: fyQuery }), async (req, res) => {
  const bp = bpOf(req);
  const fy = resolveFy(bp, q<any>(req).fy);
  res.json({ fy, items: (await scoresForUser(bp, req.user!.id, fy)).map(({ unitIds: _u, ...x }) => x) });
});

/* ------------------------------------------------------------------ *
 *  Comparison: every unit of one level under a unit, per KPI (posts with the 'compare' capability)
 * ------------------------------------------------------------------ */
router.get('/compare', validate({ query: fyQuery.extend({ unitId: objectId, type: z.string().max(40) }) }), async (req, res) => {
  const me = req.user!;
  const bp = bpOf(req);
  if (!(await hasCap(me, bp, 'compare'))) throw forbidden('Comparison is available to senior officers');
  const { unitId, type } = q<{ unitId: string; type: string }>(req);
  levelKey(bp).parse(type);
  const fy = resolveFy(bp, q<any>(req).fy);
  const root = await assertCanRead(me, unitId);
  res.json(await view(req, bp, `compare:${root._id}:${type}:${fy}`, () => compareView(bp, root, type, fy)));
});

async function compareView(bp: BP, root: any, type: string, fy: string) {
  const [facts, resolve] = await Promise.all([loadFacts(root._id, fy, bp), configResolver(bp)]);
  const units = [...facts.units.values()].filter((u) => u.type === type).sort((a, b) => a.name.localeCompare(b.name));
  const parentName = (u: (typeof units)[number]) => (u.parentId ? facts.units.get(String(u.parentId))?.name : undefined);
  const pct = (d: number, o: number) => (o > 0 ? Math.round(Math.min(100, (d / o) * 100) * 10) / 10 : null);

  const items = units.map((u) => {
    const f = rollup(facts.rows, inUnit(String(u._id)));
    const b = breakdown(f, bp);
    const s = scoreFacts(f, bp.profileForLevel(type), resolve(u.anc.map(String)), bp);
    const heads = headCells(b, bp);
    heads.REVENUE = { pct: pct(b.totals.collected, b.totals.target), done: b.totals.collected, of: b.totals.target };
    // Comparison shows audit as amount recovered of amount, not paras settled
    if (b.audit.n > 0) heads.AUDIT = { pct: b.audit.amt ? pct(b.audit.rec, b.audit.amt) : null, done: b.audit.rec, of: b.audit.amt };
    if (s.score != null) heads.SCORE = { pct: s.score, done: s.score, of: 100 };
    return { _id: u._id, name: u.name, parent: parentName(u), heads };
  });
  return { fy, root: { _id: root._id, name: root.name, type: root.type }, type, items };
}

/* ------------------------------------------------------------------ *
 *  One officer's full breakdown (read-only for everyone in the organisation)
 * ------------------------------------------------------------------ */
router.get('/officers/:userId', validate({ params: z.object({ userId: objectId }), query: fyQuery.extend({ post: z.string().max(40).optional() }) }), async (req, res) => {
  const bp = bpOf(req);
  const fy = resolveFy(bp, q<any>(req).fy);
  const { userId } = req.params as { userId: string };
  const [user, all] = await Promise.all([User.findById(userId).select('name designation bps phone email employeeCode').lean(), myCharges(userId)]);
  if (!user) throw badRequest('Officer not found');
  const charges = all.filter((c) => !bp.dataPosts.has(c.post));
  if (!charges.length) throw badRequest('This officer holds no scored posting');
  if (bp.raw.access?.viewScope === 'jurisdiction') {
    let ok = false;
    for (const c of charges) {
      try {
        await assertCanRead(req.user!, String(c.unit._id));
        ok = true;
        break;
      } catch {
        /* try the next posting */
      }
    }
    if (!ok) throw forbidden('This officer is outside what you are allowed to view');
  }

  const byPost = new Map<string, typeof charges>();
  for (const c of charges) byPost.set(c.post, [...(byPost.get(c.post) ?? []), c]);
  const posts = [...byPost.keys()];
  const wanted = q<any>(req).post as string | undefined;
  const post = wanted && byPost.has(wanted) ? wanted : posts[0];
  const list = byPost.get(post)!;
  const oc: OfficerCharge[] = list.map((c) => ({ userId, post: c.post, unitId: String(c.unit._id), anc: c.unit.anc.map(String) }));

  const top = list.reduce((a, b) => (a.unit.anc.length <= b.unit.anc.length ? a : b)).unit;
  const [facts, resolve] = await Promise.all([loadFacts(factsRootFor(bp, list.map((c) => c.unit)), fy, bp), configResolver(bp)]);
  const { f, unitIds } = officerFacts(bp, facts, oc, post);
  const profile = bp.profileForPost(post, list[0].unit.type);
  const s = scoreFacts(f, profile, resolve(oc[0].anc), bp);

  const ids = unitIds.map((u) => new Types.ObjectId(u));
  const trend = ids.length ? await trendFor(bp, fy, { anc: { $in: ids } }) : { prevFy: bp.fy.prev(fy), current: [], previous: [] };

  const ancIds = [...new Set(list.flatMap((c) => c.unit.anc.map(String)))];
  const names = new Map((await Unit.find({ _id: { $in: ancIds } }).select('name type').lean()).map((u) => [String(u._id), u]));
  res.json({
    fy,
    elapsed: Math.round(bp.fy.elapsed(fy) * 1000) / 10,
    officer: user,
    post,
    postLabel: bp.postLabel(post),
    posts: posts.map((p) => ({ code: p, label: bp.postLabel(p) })),
    charges: list.map((c) => ({
      post: c.post, postLabel: bp.postLabel(c.post), chargeType: c.chargeType,
      unit: { _id: c.unit._id, name: c.unit.name, type: c.unit.type },
      path: c.unit.anc.map((a) => names.get(String(a))?.name).filter(Boolean),
    })),
    // Same shape as the unit explorer so the client can reuse its views
    unit: { _id: String(top._id), type: top.type, name: user.name },
    path: [],
    level: profile,
    score: s.score,
    band: bp.band(s.score),
    blocks: s.blocks,
    weights: s.weights,
    configSource: null,
    ...breakdown(f, bp),
    children: [],
    holders: [],
    childHolders: [],
    trend: { fy, prevFy: trend.prevFy, current: trend.current, previous: trend.previous, prevTarget: 0 },
  });
});

export default router;

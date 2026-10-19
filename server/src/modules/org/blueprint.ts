/**
 * Org Blueprint: everything that used to be hard-coded for the Board of Revenue, as per-organisation data.
 *
 *   levels    hierarchy, root first          e.g. Division › District › Tehsil … or Region › Branch › Team
 *   posts     roles held through postings   with the levels they sit at and their capabilities
 *   blocks    scoring blocks                 target / arrears / flow / register / tasks
 *   metrics   KPI definitions               who enters, who verifies, where, in which block
 *   registers itemised registers             e.g. audit paras (amount + settled / pending)
 *   profiles  block weights                  per level of the hierarchy (and per post)
 *   bands     grade thresholds
 *   calendar  financial-year start month
 *   money     currency and display scale
 */
import { z } from 'zod';

const key = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, 'Use lower-case letters, digits and _ (start with a letter)');
const code = z.string().regex(/^[A-Z][A-Z0-9_]{0,39}$/, 'Use upper-case letters, digits and _ (start with a letter)');
const label = z.string().trim().min(1).max(80);

export const CAPS = ['set_targets', 'assign_targets', 'compare', 'manage_registers', 'litigation', 'state_land', 'state_land_verify', 'state_land_approve'] as const;
export type Cap = (typeof CAPS)[number];
export const BLOCK_KINDS = ['target', 'arrears', 'flow', 'register', 'tasks'] as const;
export type BlockKind = (typeof BLOCK_KINDS)[number];

export const levelSchema = z.object({
  key,
  label,
  plural: label.optional(),
  /** Weight profile used when an area at this level is scored. */
  profile: key.optional(),
});

export const postSchema = z.object({
  key,
  label,
  /** Levels a holder of this post may be posted at. */
  levels: z.array(key).min(1),
  /** Only one holder per unit. */
  single: z.boolean().default(false),
  /** Posts that cannot hold the same unit at the same time (e.g. one revenue officer per qanungoi). */
  exclusiveWith: z.array(key).default([]),
  /** Scored posts appear in leagues and get a personal score; data posts (clerks) do not. */
  scored: z.boolean().default(true),
  /** Weight profile for this post's personal score (defaults to the profile of the level held). */
  profile: key.optional(),
  /** Widen this post's working jurisdiction to its ancestor at this level (e.g. a Naib Tehsildar sees the whole tehsil). */
  widenTo: key.optional(),
  /** Levels at which holding this post is supervisory only and is not counted as the holder's own area. */
  oversightAt: z.array(key).default([]),
  caps: z.array(z.enum(CAPS)).default([]),
  /** Ranked in the league of this post (e.g. DRC with ADC Revenue, MD with DC): one table, one ranking. */
  rankWith: key.optional(),
});

export const blockSchema = z.object({ key, label, kind: z.enum(BLOCK_KINDS) });

export const metricSchema = z.object({
  code,
  name: label,
  group: label,
  /** Block it is scored in: a 'target' block (target vs achieved) or a 'flow' block (pending vs disposed). */
  block: key,
  unit: z.enum(['money', 'count', 'number']).default('money'),
  /** Optional tag (e.g. season: rabi / kharif) used for tag-wise reporting. */
  tag: key.optional(),
  /** Level of the units it is recorded on. */
  level: key,
  /** Recorded per person (e.g. a revenue officer's own register) instead of per unit. */
  perHolder: z.boolean().default(false),
  /** perHolder only: posts whose holders own a row. */
  holderPosts: z.array(key).default([]),
  /** Posts allowed to enter figures (on the unit itself or any ancestor). */
  enterPosts: z.array(key).min(1),
  /** Posts that verify figures; their own entries are verified on save. */
  verifyPosts: z.array(key).min(1),
  /** Weight inside its block. */
  weight: z.number().min(0).max(1000).default(1),
  /** Target metrics only: tracks arrears (uncollected demand of earlier years). */
  arrears: z.boolean().default(false),
  active: z.boolean().default(true),
  description: z.string().max(500).optional(),
});

export const registerSchema = z.object({
  key,
  label,
  block: key,
  /** Levels whose units can hold register items. */
  levels: z.array(key).min(1),
  enterPosts: z.array(key).min(1),
  categories: z.array(label).min(1),
  /** Name of the amount column (e.g. "Recoverable"). */
  amountLabel: label.default('Amount'),
});

export const profileSchema = z.object({ key, label, weights: z.record(key, z.number().min(0).max(100)) });

export const blueprintSchema = z
  .object({
    name: label,
    industry: z.string().max(60).optional(),
    levels: z.array(levelSchema).min(1).max(12),
    posts: z.array(postSchema).min(1).max(100),
    blocks: z.array(blockSchema).min(1).max(20),
    metrics: z.array(metricSchema).max(300),
    registers: z.array(registerSchema).max(20).default([]),
    profiles: z.array(profileSchema).min(1).max(50),
    tags: z.array(z.object({ key, label })).max(20).default([]),
    bands: z
      .array(z.object({ key, label, min: z.number().min(0).max(100) }))
      .min(1)
      .max(10),
    calendar: z.object({ fyStartMonth: z.number().int().min(1).max(12).default(7) }),
    /** Who may view what: everyone the whole organisation (default), or only their own jurisdiction + granted areas. */
    access: z.object({ viewScope: z.enum(['organisation', 'jurisdiction']).default('organisation') }).default({}),
    /** The organisation's own words on screens and reports. */
    terms: z
      .object({
        money: z.string().max(40).default('Revenue'), // headline for money KPIs, e.g. Revenue / Sales / Collections
        achieved: z.string().max(30).default('Achieved'), // e.g. Recovered / Achieved / Sold
        flowGroup: z.string().max(40).default('Workload'), // e.g. Case registers / Requests
        disposed: z.string().max(30).default('Disposed'), // e.g. Disposed / Closed
        pending: z.string().max(30).default('Pending'),
        items: z.string().max(30).default('items'), // plural noun for flow counts, e.g. cases / requests
        reference: z.string().max(40).default('Reference no.'), // e.g. Challan / PSID no.
      })
      .default({}),
    money: z.object({
      currency: z.string().max(8).default('PKR'),
      symbol: z.string().max(8).default('Rs'),
      scale: z.number().positive().default(1e6),
      scaleLabel: z.string().max(20).default('Millions'),
      decimals: z.number().int().min(0).max(4).default(2),
    }),
  })
  .superRefine((b, ctx) => {
    const err = (path: (string | number)[], message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });
    const dup = <T>(list: T[], f: (x: T) => string, path: string) => {
      const seen = new Set<string>();
      list.forEach((x, i) => {
        if (seen.has(f(x))) err([path, i], `Duplicate "${f(x)}"`);
        seen.add(f(x));
      });
    };
    dup(b.levels, (l) => l.key, 'levels');
    dup(b.posts, (p) => p.key, 'posts');
    dup(b.blocks, (x) => x.key, 'blocks');
    dup(b.metrics, (m) => m.code, 'metrics');
    dup(b.registers, (r) => r.key, 'registers');
    dup(b.profiles, (p) => p.key, 'profiles');

    const levels = new Set(b.levels.map((l) => l.key));
    const posts = new Set(b.posts.map((p) => p.key));
    const blocks = new Map(b.blocks.map((x) => [x.key, x.kind]));
    const profiles = new Set(b.profiles.map((p) => p.key));
    const tags = new Set(b.tags.map((t) => t.key));
    const checkPosts = (list: string[], path: (string | number)[]) => list.forEach((p) => posts.has(p) || err(path, `Unknown post "${p}"`));

    b.levels.forEach((l, i) => l.profile && !profiles.has(l.profile) && err(['levels', i, 'profile'], `Unknown profile "${l.profile}"`));
    b.posts.forEach((p, i) => {
      p.levels.forEach((l) => levels.has(l) || err(['posts', i, 'levels'], `Unknown level "${l}"`));
      if (p.widenTo && !levels.has(p.widenTo)) err(['posts', i, 'widenTo'], `Unknown level "${p.widenTo}"`);
      p.oversightAt.forEach((l) => levels.has(l) || err(['posts', i, 'oversightAt'], `Unknown level "${l}"`));
      if (p.profile && !profiles.has(p.profile)) err(['posts', i, 'profile'], `Unknown profile "${p.profile}"`);
      checkPosts(p.exclusiveWith, ['posts', i, 'exclusiveWith']);
    });
    b.metrics.forEach((m, i) => {
      const kind = blocks.get(m.block);
      if (!kind) err(['metrics', i, 'block'], `Unknown block "${m.block}"`);
      else if (kind !== 'target' && kind !== 'flow') err(['metrics', i, 'block'], 'A KPI must sit in a "target" or "flow" block');
      if (!levels.has(m.level)) err(['metrics', i, 'level'], `Unknown level "${m.level}"`);
      if (m.tag && !tags.has(m.tag)) err(['metrics', i, 'tag'], `Unknown tag "${m.tag}"`);
      if (m.perHolder && !m.holderPosts.length) err(['metrics', i, 'holderPosts'], 'Per-person KPIs need at least one holder post');
      if (m.arrears && kind !== 'target') err(['metrics', i, 'arrears'], 'Arrears apply to target KPIs only');
      checkPosts(m.enterPosts, ['metrics', i, 'enterPosts']);
      checkPosts(m.verifyPosts, ['metrics', i, 'verifyPosts']);
      checkPosts(m.holderPosts, ['metrics', i, 'holderPosts']);
    });
    b.registers.forEach((r, i) => {
      if (blocks.get(r.block) !== 'register') err(['registers', i, 'block'], 'A register must sit in a "register" block');
      r.levels.forEach((l) => levels.has(l) || err(['registers', i, 'levels'], `Unknown level "${l}"`));
      checkPosts(r.enterPosts, ['registers', i, 'enterPosts']);
    });
    b.profiles.forEach((p, i) => Object.keys(p.weights).forEach((k) => blocks.has(k) || err(['profiles', i, 'weights'], `Unknown block "${k}"`)));
  });

export type Blueprint = z.infer<typeof blueprintSchema>;
export type LevelDef = z.infer<typeof levelSchema>;
export type PostDef = z.infer<typeof postSchema>;
export type BlockDef = z.infer<typeof blockSchema>;
export type MetricDef = z.infer<typeof metricSchema>;
export type RegisterDef = z.infer<typeof registerSchema>;
export type ProfileDef = z.infer<typeof profileSchema>;

/* ------------------------------------------------------------------ *
 *  Compiled view: lookups the engine needs on every request
 * ------------------------------------------------------------------ */
export interface FyHelpers {
  startMonth: number;
  of(d: Date): string;
  startYear(fy: string): number;
  start(fy: string): Date;
  end(fy: string): Date;
  months(fy: string): string[];
  valid(fy: string): boolean;
  elapsed(fy: string, now?: Date): number;
  prev(fy: string): string;
  list(n: number): string[];
}

export function fyHelpers(startMonth: number): FyHelpers {
  const sm = startMonth - 1; // 0-based
  const label = (y: number) => (sm === 0 ? `${y}` : `${y}-${String((y + 1) % 100).padStart(2, '0')}`);
  const startYear = (fy: string) => Number(fy.slice(0, 4));
  const h: FyHelpers = {
    startMonth,
    of: (d) => label(d.getMonth() >= sm ? d.getFullYear() : d.getFullYear() - 1),
    startYear,
    start: (fy) => new Date(startYear(fy), sm, 1),
    end: (fy) => new Date(startYear(fy) + 1, sm, 1),
    months: (fy) => {
      const y = startYear(fy);
      return Array.from({ length: 12 }, (_, i) => {
        const m = (sm + i) % 12;
        return `${sm + i >= 12 ? y + 1 : y}-${String(m + 1).padStart(2, '0')}`;
      });
    },
    valid: (fy) => (sm === 0 ? /^\d{4}$/.test(fy) : /^\d{4}-\d{2}$/.test(fy) && (startYear(fy) + 1) % 100 === Number(fy.slice(5))),
    elapsed: (fy, now = new Date()) => {
      const s = h.start(fy).getTime();
      const e = h.end(fy).getTime();
      return Math.max(0, Math.min(1, (now.getTime() - s) / (e - s)));
    },
    prev: (fy) => label(startYear(fy) - 1),
    list: (n) => {
      const y = startYear(h.of(new Date()));
      return Array.from({ length: n }, (_, i) => label(y - i));
    },
  };
  return h;
}

export interface BP {
  version: number;
  raw: Blueprint;
  levels: LevelDef[];
  levelIndex: Map<string, number>;
  level: Map<string, LevelDef>;
  topLevel: string;
  posts: PostDef[];
  post: Map<string, PostDef>;
  postLabel(key: string): string;
  blocks: BlockDef[];
  block: Map<string, BlockDef>;
  metrics: MetricDef[]; // active only
  metric: Map<string, MetricDef>; // all, including retired
  kindOf(code: string): BlockKind | undefined;
  targetMetrics: MetricDef[];
  flowMetrics: MetricDef[];
  registers: RegisterDef[];
  register: Map<string, RegisterDef>;
  profiles: Map<string, ProfileDef>;
  /** Profile used to score an area at this level. */
  profileForLevel(levelKey: string): string;
  /** Profile used to score a holder of this post (at the given level). */
  profileForPost(postKey: string, levelKey?: string): string;
  holderPosts: Set<string>;
  dataPosts: Set<string>;
  postsWithCap(cap: Cap): string[];
  /** The post whose league this post is ranked in (itself unless rankWith is set). */
  leagueOf(post: string): string;
  /** All posts ranked together in a league: the post and those ranked with it. */
  leaguePosts(post: string): string[];
  bands: { key: string; label: string; min: number }[];
  band(score: number | null): string;
  fy: FyHelpers;
}

export function compile(raw: Blueprint, version: number): BP {
  const level = new Map(raw.levels.map((l) => [l.key, l]));
  const levelIndex = new Map(raw.levels.map((l, i) => [l.key, i]));
  const post = new Map(raw.posts.map((p) => [p.key, p]));
  const block = new Map(raw.blocks.map((b) => [b.key, b]));
  const metric = new Map(raw.metrics.map((m) => [m.code, m]));
  const active = raw.metrics.filter((m) => m.active);
  const kindOf = (c: string) => {
    const m = metric.get(c);
    return m ? block.get(m.block)?.kind : undefined;
  };
  const profiles = new Map(raw.profiles.map((p) => [p.key, p]));
  const firstProfile = raw.profiles[0].key;
  const bands = [...raw.bands].sort((a, b) => b.min - a.min);
  const profileForLevel = (l: string) => {
    // Nearest level (this one, then ancestors) that names a profile
    for (let i = levelIndex.get(l) ?? raw.levels.length - 1; i >= 0; i--) {
      const p = raw.levels[i].profile;
      if (p) return p;
    }
    return firstProfile;
  };
  return {
    version,
    raw,
    levels: raw.levels,
    levelIndex,
    level,
    topLevel: raw.levels[0].key,
    posts: raw.posts,
    post,
    postLabel: (k) => post.get(k)?.label ?? k,
    blocks: raw.blocks,
    block,
    metrics: active,
    metric,
    kindOf,
    targetMetrics: active.filter((m) => block.get(m.block)?.kind === 'target'),
    flowMetrics: active.filter((m) => block.get(m.block)?.kind === 'flow'),
    registers: raw.registers,
    register: new Map(raw.registers.map((r) => [r.key, r])),
    profiles,
    profileForLevel,
    profileForPost: (p, l) => post.get(p)?.profile ?? (l ? profileForLevel(l) : firstProfile),
    holderPosts: new Set(active.filter((m) => m.perHolder).flatMap((m) => m.holderPosts)),
    dataPosts: new Set(raw.posts.filter((p) => !p.scored).map((p) => p.key)),
    postsWithCap: (cap) => raw.posts.filter((p) => p.caps.includes(cap)).map((p) => p.key),
    leagueOf: (post) => raw.posts.find((p) => p.key === post)?.rankWith ?? post,
    leaguePosts: (post) => {
      const base = raw.posts.find((p) => p.key === post)?.rankWith ?? post;
      return [base, ...raw.posts.filter((p) => p.rankWith === base && p.key !== base).map((p) => p.key)];
    },
    bands,
    band: (s) => (s == null ? 'n/a' : (bands.find((b) => s >= b.min)?.key ?? bands[bands.length - 1].key)),
    fy: fyHelpers(raw.calendar.fyStartMonth),
  };
}

/** Client-safe view sent by /meta. */
export function publicBlueprint(bp: BP) {
  const r = bp.raw;
  return {
    version: bp.version,
    name: r.name,
    industry: r.industry,
    levels: r.levels,
    posts: r.posts,
    blocks: r.blocks,
    metrics: r.metrics,
    registers: r.registers,
    profiles: r.profiles,
    tags: r.tags,
    bands: bp.bands,
    calendar: r.calendar,
    money: r.money,
    terms: r.terms,
    access: r.access,
  };
}

/** Blueprint as authored (defaults not yet applied) — templates and the editor use this shape. */
export type BlueprintInput = z.input<typeof blueprintSchema>;

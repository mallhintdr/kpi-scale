/**
 * Two-tier cache.
 *   L1  in-process LRU (fast, per API instance)
 *   L2  Redis (shared by every API instance), when REDIS_URL is set
 *
 * Score data is cached under a per-organisation *data version*. Any write to targets, entries,
 * registers, tasks, postings or units bumps the version (see dataVersionPlugin), so a stale
 * figure is never served and nothing has to be deleted explicitly.
 * Concurrent requests for the same key share one computation (single-flight).
 */
import { logger } from './logger.js';
import { redis, subscribe } from './redis.js';

class Lru<V> {
  private map = new Map<string, { v: V; exp: number }>();
  constructor(private max: number) {}
  get(k: string): V | undefined {
    const e = this.map.get(k);
    if (!e) return undefined;
    if (e.exp < Date.now()) {
      this.map.delete(k);
      return undefined;
    }
    this.map.delete(k); // refresh recency
    this.map.set(k, e);
    return e.v;
  }
  set(k: string, v: V, ttlSec: number) {
    this.map.delete(k);
    this.map.set(k, { v, exp: Date.now() + ttlSec * 1000 });
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value!);
  }
  deletePrefix(prefix: string) {
    for (const k of this.map.keys()) if (k.startsWith(prefix)) this.map.delete(k);
  }
}

const l1 = new Lru<unknown>(Number(process.env.CACHE_L1_MAX ?? 300));
const inflight = new Map<string, Promise<unknown>>();
/** Bumped by invalidate(): a computation that started before it must not repopulate L1. */
const generations = new Map<string, number>();
const genOf = (key: string) => {
  let g = 0;
  for (const [prefix, n] of generations) if (key.startsWith(prefix)) g += n;
  return g;
};
const localVersions = new Map<string, number>(); // used only without Redis

export interface Codec<T> {
  encode(v: T): unknown;
  decode(raw: any): T;
}

/** Get-or-compute through L1 → L2 → fn. */
export async function cached<T>(key: string, ttlSec: number, fn: () => Promise<T>, codec?: Codec<T>): Promise<T> {
  const hit = l1.get(key);
  if (hit !== undefined) return hit as T;
  const running = inflight.get(key);
  if (running) return running as Promise<T>;

  const gen = genOf(key);
  const fresh = () => genOf(key) === gen;
  const p = (async () => {
    const r = redis();
    if (r) {
      try {
        const raw = await r.get(`c:${key}`);
        if (raw != null) {
          const v = codec ? codec.decode(JSON.parse(raw)) : (JSON.parse(raw) as T);
          if (fresh()) l1.set(key, v, ttlSec);
          return v;
        }
      } catch (err) {
        logger.warn({ err }, 'cache read failed');
      }
    }
    const v = await fn();
    if (!fresh()) return v; // invalidated while computing: serve it once, cache nothing
    l1.set(key, v, ttlSec);
    if (r) {
      r.set(`c:${key}`, JSON.stringify(codec ? codec.encode(v) : v), 'EX', ttlSec).catch((err) => logger.warn({ err }, 'cache write failed'));
    }
    return v;
  })();
  inflight.set(key, p);
  try {
    return await p;
  } finally {
    if (inflight.get(key) === p) inflight.delete(key);
  }
}

/** Current data version of an organisation. */
export async function dataVersion(tenantId: string): Promise<number> {
  const r = redis();
  if (!r) return localVersions.get(tenantId) ?? 0;
  try {
    return Number((await r.get(`dv:${tenantId}`)) ?? 0);
  } catch {
    return localVersions.get(tenantId) ?? 0;
  }
}

/** Mark an organisation's score data as changed. */
export async function bumpData(tenantId: string) {
  localVersions.set(tenantId, (localVersions.get(tenantId) ?? 0) + 1);
  const r = redis();
  if (r) await r.incr(`dv:${tenantId}`).catch((err) => logger.warn({ err }, 'data version bump failed'));
}

/* ---------- cross-instance invalidation (e.g. a blueprint was edited) ---------- */
const CHANNEL = 'kpi:invalidate';
const listeners: ((msg: { kind: string; tenantId: string }) => void)[] = [];

export function onInvalidate(fn: (msg: { kind: string; tenantId: string }) => void) {
  listeners.push(fn);
}

const bumpGeneration = (prefix: string) => {
  generations.set(prefix, (generations.get(prefix) ?? 0) + 1);
  for (const k of inflight.keys()) if (k.startsWith(prefix)) inflight.delete(k); // later callers recompute
};

export async function invalidate(kind: string, tenantId: string) {
  bumpGeneration(`${kind}:${tenantId}`);
  l1.deletePrefix(`${kind}:${tenantId}`);
  for (const fn of listeners) fn({ kind, tenantId });
  const r = redis();
  if (r) {
    await r.del(`c:${kind}:${tenantId}`).catch(() => undefined);
    await r.publish(CHANNEL, JSON.stringify({ kind, tenantId })).catch(() => undefined);
  }
}

subscribe(CHANNEL, (raw) => {
  try {
    const msg = JSON.parse(raw);
    bumpGeneration(`${msg.kind}:${msg.tenantId}`);
    l1.deletePrefix(`${msg.kind}:${msg.tenantId}`);
    for (const fn of listeners) fn(msg);
  } catch {
    /* ignore malformed */
  }
});

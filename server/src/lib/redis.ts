import { Redis } from 'ioredis';
import { env } from '../config/env.js';
import { logger } from './logger.js';

let client: Redis | null = null;
let sub: Redis | null = null;

/** Shared command connection, or null when Redis is not configured. */
export function redis(): Redis | null {
  if (!env.REDIS_URL) return null;
  if (!client) {
    client = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 2, enableOfflineQueue: true });
    client.on('error', (err) => logger.warn({ err: err.message }, 'redis error'));
  }
  return client;
}

/** New connection for BullMQ (it requires maxRetriesPerRequest: null). */
export const bullConnection = () => new Redis(env.REDIS_URL!, { maxRetriesPerRequest: null });

/** Subscribe to a pub/sub channel (one subscriber connection per process). */
export function subscribe(channel: string, onMessage: (msg: string) => void) {
  if (!env.REDIS_URL) return;
  if (!sub) {
    sub = new Redis(env.REDIS_URL);
    sub.on('error', (err) => logger.warn({ err: err.message }, 'redis sub error'));
  }
  sub.subscribe(channel).catch((err) => logger.warn({ err }, 'redis subscribe failed'));
  sub.on('message', (ch, msg) => ch === channel && onMessage(msg));
}

export async function closeRedis() {
  await Promise.allSettled([client?.quit(), sub?.quit()]);
  client = sub = null;
}

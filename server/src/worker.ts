/**
 * Standalone job worker. Run one or more of these (`npm run worker`) and set RUN_WORKER=false on the
 * API instances, so heavy jobs (imports, cache warm-up, notification fan-out) never compete with
 * user requests. Requires REDIS_URL.
 */
import { env } from './config/env.js';
import { connectDb, disconnectDb } from './lib/db.js';
import { logger } from './lib/logger.js';
import { startWorker, stopQueue } from './lib/queue.js';
import { closeRedis } from './lib/redis.js';
import './lib/notify.js';
import './modules/org/imports.js';
import './modules/revenue/warm.js';
import './modules/revenue/rollup.js';

async function main() {
  if (!env.REDIS_URL) throw new Error('REDIS_URL is required for a standalone worker');
  await connectDb();
  startWorker();
  const stop = async () => {
    await stopQueue();
    await closeRedis();
    await disconnectDb();
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

main().catch((err) => {
  logger.fatal({ err }, 'Worker failed to start');
  process.exit(1);
});

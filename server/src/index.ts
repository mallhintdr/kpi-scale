import { env } from './config/env.js';
import { createApp } from './app.js';
import { bootstrapPlatform } from './lib/bootstrap.js';
import { connectDb, disconnectDb } from './lib/db.js';
import { logger } from './lib/logger.js';
import { stopQueue, startWorker } from './lib/queue.js';
import { closeRedis } from './lib/redis.js';
import { startWaWorker, stopWaWorker } from './modules/whatsapp/engine.js';

async function main() {
  await connectDb(); // connect before accepting traffic
  await bootstrapPlatform();
  if (env.RUN_WORKER) {
    startWorker();
    startWaWorker();
  }
  const server = createApp().listen(env.PORT, env.HOST, () => logger.info(`API listening on :${env.PORT}${env.REDIS_URL ? ' (Redis enabled)' : ' (no Redis: in-process cache, inline jobs)'}`));

  const shutdown = (signal: string) => {
    logger.info({ signal }, 'Shutting down');
    server.close(async () => {
      await stopQueue();
      await stopWaWorker();
      await closeRedis();
      await disconnectDb();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  logger.fatal({ err }, 'Failed to start');
  process.exit(1);
});

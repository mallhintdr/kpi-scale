import { env } from './config/env.js';
import { createApp } from './app.js';
import { connectDb, disconnectDb } from './lib/db.js';
import { logger } from './lib/logger.js';

async function main() {
  await connectDb(); // connect before accepting traffic
  const server = createApp().listen(env.PORT, () => logger.info(`API listening on :${env.PORT}`));

  const shutdown = (signal: string) => {
    logger.info({ signal }, 'Shutting down');
    server.close(async () => {
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

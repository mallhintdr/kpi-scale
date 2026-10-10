import compression from 'compression';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import { createHash } from 'node:crypto';
import express, { Router, type Request } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import mongoose from 'mongoose';
import { pinoHttp } from 'pino-http';
import { RedisStore } from 'rate-limit-redis';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { redis } from './lib/redis.js';
import { authenticate } from './middleware/auth.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';
import authRoutes from './modules/auth/auth.routes.js';
import notificationRoutes from './modules/notifications/notifications.routes.js';
import './modules/org/imports.js';
import accessRoutes from './modules/org/access.routes.js';
import orgRoutes from './modules/org/org.routes.js';
import { withBlueprint } from './modules/org/service.js';
import platformRoutes from './modules/platform/platform.routes.js';
import assignedRoutes from './modules/revenue/assigned.routes.js';
import entryRoutes from './modules/revenue/entry.routes.js';
import performanceRoutes from './modules/revenue/performance.routes.js';
import registerRoutes from './modules/revenue/registers.routes.js';
import './modules/revenue/rollup.js';
import statsRoutes from './modules/revenue/stats.routes.js';
import './modules/revenue/warm.js';
import userRoutes from './modules/users/users.routes.js';

/** Shared limiter store across API instances when Redis is available. */
const store = (prefix: string) => {
  const r = redis();
  return r ? new RedisStore({ prefix, sendCommand: (...args: string[]) => r.call(args[0], ...args.slice(1)) as any }) : undefined;
};

/** Officers in one office share a public IP: limit per signed-in session where possible. */
const clientKey = (req: Request) => {
  const h = req.headers.authorization;
  return h?.startsWith('Bearer ') ? `t:${createHash('sha1').update(h.slice(7)).digest('hex').slice(0, 20)}` : `ip:${req.ip}`;
};

export function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(helmet());
  app.use(cors({ origin: env.corsOrigins, credentials: true }));
  app.use(compression());
  // Bulk imports carry CSV files; everything else stays small
  app.use((req, res, next) => (req.path === '/api/org/imports' ? next() : express.json({ limit: '200kb' })(req, res, next)));
  app.use(cookieParser());
  app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => req.url === '/health' } }));

  app.get('/health', async (_req, res) => {
    const db = mongoose.connection.readyState === 1;
    let cache: boolean | null = null;
    const r = redis();
    if (r) cache = await r.ping().then(() => true).catch(() => false);
    res.status(db ? 200 : 503).json({ status: db ? 'ok' : 'degraded', db, redis: cache });
  });

  const api = Router();
  api.use(rateLimit({ windowMs: 60_000, limit: 600, standardHeaders: 'draft-8', legacyHeaders: false, keyGenerator: clientKey, store: store('rl:api:') }));
  api.use('/auth', authRoutes);

  // Everything below requires a valid session and runs inside the caller's tenant context.
  api.use(authenticate);
  api.use('/platform', platformRoutes);
  api.use('/users', userRoutes);
  api.use('/notifications', notificationRoutes);
  api.use('/org', orgRoutes, accessRoutes);
  api.use('/rev', withBlueprint, performanceRoutes, entryRoutes, registerRoutes, assignedRoutes, statsRoutes);

  app.use('/api', api);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

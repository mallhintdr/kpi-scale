import compression from 'compression';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { Router } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import mongoose from 'mongoose';
import { pinoHttp } from 'pino-http';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { authenticate } from './middleware/auth.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';
import authRoutes from './modules/auth/auth.routes.js';
import notificationRoutes from './modules/notifications/notifications.routes.js';
import entryRoutes from './modules/revenue/entry.routes.js';
import performanceRoutes from './modules/revenue/performance.routes.js';
import registerRoutes from './modules/revenue/registers.routes.js';
import userRoutes from './modules/users/users.routes.js';

export function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(helmet());
  app.use(cors({ origin: env.corsOrigins, credentials: true }));
  app.use(compression());
  app.use(express.json({ limit: '200kb' }));
  app.use(cookieParser());
  app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => req.url === '/health' } }));

  app.get('/health', (_req, res) => {
    const db = mongoose.connection.readyState === 1;
    res.status(db ? 200 : 503).json({ status: db ? 'ok' : 'degraded', db });
  });

  const api = Router();
  api.use(rateLimit({ windowMs: 60_000, limit: 300, standardHeaders: 'draft-8', legacyHeaders: false }));
  api.use('/auth', authRoutes);

  // Everything below requires a valid session and runs inside the caller's tenant context.
  api.use(authenticate);
  api.use('/users', userRoutes);
  api.use('/notifications', notificationRoutes);
  api.use('/rev', performanceRoutes, entryRoutes, registerRoutes);

  app.use('/api', api);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

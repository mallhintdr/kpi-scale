import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(4000),
  MONGO_URI: z.string().min(1),
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_DAYS: z.coerce.number().default(30),
  CORS_ORIGINS: z.string().default('http://localhost:5173'),
  /** Optional. Without it the cache is in-process and jobs run inline (single instance only). */
  REDIS_URL: z.string().optional().transform((v) => v || undefined),
  RUN_WORKER: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  MONGO_POOL: z.coerce.number().default(50),
  /** Platform super-admin seeded on first start (only if no super-admin exists). */
  SUPERADMIN_EMAIL: z.string().email().optional(),
  SUPERADMIN_PASSWORD: z.string().min(10).optional(),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = {
  ...parsed.data,
  isProd: parsed.data.NODE_ENV === 'production',
  corsOrigins: parsed.data.CORS_ORIGINS.split(',').map((s) => s.trim()),
};

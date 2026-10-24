import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(4000),
  /** 127.0.0.1 = reachable only through nginx on the same server. */
  HOST: z.string().default('0.0.0.0'),
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
  /** WhatsApp: mock (default, log only) | wasender | cloud (Meta). */
  WHATSAPP_MODE: z.enum(['mock', 'wasender', 'cloud']).default('mock'),
  WHATSAPP_ACCESS_TOKEN: z.string().optional(),
  WHATSAPP_PHONE_NUMBER_ID: z.string().optional(),
  WHATSAPP_VERIFY_TOKEN: z.string().optional(),
  WHATSAPP_APP_SECRET: z.string().optional(),
  /** Shared secret for the WASender webhook (?secret=… or X-Webhook-Signature). */
  WHATSAPP_WEBHOOK_SECRET: z.string().optional(),
  /** Meta: approved utility template with one body variable, used outside the 24-hour window. */
  WHATSAPP_CLOUD_TEMPLATE: z.string().optional(),
  WHATSAPP_CLOUD_TEMPLATE_LANG: z.string().default('en'),
  /** Outbound messages per second across all organisations (provider rate limit). */
  WHATSAPP_RATE_PER_SEC: z.coerce.number().default(10),
  /** Single-organisation mode (Board of Revenue): platform console, templates and organisation switching are off. */
  SINGLE_TENANT: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  /** The one organisation used in single-organisation mode. */
  DEFAULT_TENANT: z.string().default('bor-bahawalpur'),
  /** Demo: /guest signs visitors in as this account, read-only. Empty = no guest access. */
  GUEST_EMAIL: z.string().trim().toLowerCase().default(''),
  /** Platform super-admin seeded on first start (only if no super-admin exists). */
  /** Override the refresh cookie's Secure flag (defaults to on in production). */
  COOKIE_SECURE: z.preprocess((v) => (v === '' ? undefined : v), z.enum(['true', 'false']).optional()),
  /** Guest demo: "View demo as guest" signs visitors in to this account in read-only mode. Off unless both are set. */
  DEMO_TENANT_SLUG: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
  DEMO_LOGIN_EMAIL: z.preprocess((v) => (v === '' ? undefined : v), z.string().email().optional()),
  // Empty in .env means "not set" (the example file lists them blank)
  SUPERADMIN_EMAIL: z.preprocess((v) => (v === '' ? undefined : v), z.string().email().optional()),
  SUPERADMIN_PASSWORD: z.preprocess((v) => (v === '' ? undefined : v), z.string().min(10).optional()),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = {
  ...parsed.data,
  isProd: parsed.data.NODE_ENV === 'production',
  demoEnabled: !!(parsed.data.DEMO_TENANT_SLUG && parsed.data.DEMO_LOGIN_EMAIL),
  cookieSecure: parsed.data.COOKIE_SECURE ? parsed.data.COOKIE_SECURE === 'true' : parsed.data.NODE_ENV === 'production',
  corsOrigins: parsed.data.CORS_ORIGINS.split(',').map((s) => s.trim()),
};

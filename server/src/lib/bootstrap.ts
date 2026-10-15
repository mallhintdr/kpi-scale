import { env } from '../config/env.js';
import { Tenant, User } from '../models/index.js';
import { hashPassword } from '../modules/auth/auth.routes.js';
import { logger } from './logger.js';
import { runAsTenant, runUnscoped } from './tenantContext.js';

/** Ensures the platform tenant exists, and creates the first super-admin from env if there is none. */
export async function bootstrapPlatform() {
  if (env.SINGLE_TENANT) return; // no platform tenant or super-admin in single-organisation mode
  const platform =
    (await runUnscoped(() => Tenant.findOne({ isPlatform: true }))) ??
    (await runUnscoped(() => Tenant.create({ name: 'KPI Platform', slug: 'platform', isPlatform: true, plan: 'enterprise' })));
  const hasSuper = await runUnscoped(() => User.exists({ tenantId: platform._id, role: 'superadmin' }));
  if (hasSuper) return;
  if (!env.SUPERADMIN_EMAIL || !env.SUPERADMIN_PASSWORD) {
    logger.warn('No platform super-admin exists. Set SUPERADMIN_EMAIL and SUPERADMIN_PASSWORD and restart to create one.');
    return;
  }
  await runAsTenant(platform._id, async () =>
    User.create({ name: 'Platform Administrator', email: env.SUPERADMIN_EMAIL!.toLowerCase(), passwordHash: await hashPassword(env.SUPERADMIN_PASSWORD!), role: 'superadmin', designation: 'Platform Administrator' }),
  );
  logger.info({ email: env.SUPERADMIN_EMAIL }, 'Platform super-admin created');
}

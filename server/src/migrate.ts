/**
 * One-off / repeatable migration:
 *   1. every organisation without a blueprint gets one (default: the Revenue Department template,
 *      which reproduces the original hard-coded Board of Revenue framework exactly)
 *   2. register items without a register key are tagged 'audit'
 *   3. indexes are synced (new compound indexes created, obsolete ones dropped)
 *
 * Usage: npm run migrate [-- --template revenue_department]
 */
import mongoose from 'mongoose';
import { connectDb, disconnectDb } from './lib/db.js';
import { logger } from './lib/logger.js';
import { runAsTenant, runUnscoped } from './lib/tenantContext.js';
import { AuditPara, Blueprint, Tenant, User } from './models/index.js';
import { normalizePhone } from './modules/whatsapp/phone.js';
import { saveBlueprint } from './modules/org/service.js';
import { TEMPLATES } from './modules/org/templates.js';
import { closeRedis } from './lib/redis.js';

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};

async function main() {
  await connectDb();
  const template = arg('template') ?? 'revenue_department';
  if (!TEMPLATES[template]) throw new Error(`Unknown template ${template}`);

  const tenants = await runUnscoped(() => Tenant.find({ isPlatform: { $ne: true } }).lean());
  for (const t of tenants) {
    await runAsTenant(t._id, async () => {
      if (!(await Blueprint.exists({}))) {
        const r = await saveBlueprint(String(t._id), { ...TEMPLATES[template].blueprint, name: t.name }, { template, note: 'Migrated from the built-in catalogue', skipUsageCheck: true });
        logger.info({ tenant: t.slug, version: r.version }, 'blueprint created');
      }
      // Blueprints saved before organisation terms existed take them from their template
      const row = await Blueprint.findOne().lean();
      const tpl = row?.template ? TEMPLATES[row.template] : undefined;
      if (row && tpl && !(row.doc as any).terms && (tpl.blueprint as any).terms) {
        const r = await saveBlueprint(String(t._id), { ...(row.doc as object), terms: (tpl.blueprint as any).terms }, { note: 'Added organisation terms', skipUsageCheck: true });
        logger.info({ tenant: t.slug, version: r.version }, 'terms added');
      }
      // The Revenue Department pilot keeps the Government of the Punjab identity, now as organisation branding
      if (row?.template === 'revenue_department' && !t.branding?.logoUrl) {
        await runUnscoped(() => Tenant.updateOne({ _id: t._id }, { $set: { 'branding.logoUrl': '/punjab-logo-white.png', 'branding.tagline': 'Government of the Punjab', 'branding.shortName': 'Board of Revenue' } }));
        logger.info({ tenant: t.slug }, 'branding set');
      }
      // E.164 phone numbers for WhatsApp matching
      const users = await User.find({ phone: { $exists: true, $ne: '' }, phoneE164: { $exists: false } }).select('phone');
      for (const u of users) { u.set('phoneE164', normalizePhone(u.get('phone')) || undefined); await u.save(); }
      if (users.length) logger.info({ tenant: t.slug, n: users.length }, 'phone numbers normalised');
      const tagged = await AuditPara.updateMany({ register: { $exists: false } }, { $set: { register: 'audit' } });
      if (tagged.modifiedCount) logger.info({ tenant: t.slug, n: tagged.modifiedCount }, 'register items tagged');
    });
  }

  for (const name of mongoose.modelNames()) {
    const dropped = await mongoose.model(name).syncIndexes();
    if (dropped.length) logger.info({ model: name, dropped }, 'obsolete indexes dropped');
  }
  logger.info('Migration complete');
  await closeRedis();
  await disconnectDb();
}

main().catch(async (err) => {
  logger.fatal({ err }, 'Migration failed');
  await disconnectDb();
  process.exit(1);
});

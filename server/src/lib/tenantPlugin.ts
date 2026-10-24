import mongoose, { Schema, type Query } from 'mongoose';
import { getContext } from './tenantContext.js';

/**
 * Enforces tenant isolation for every model that uses it:
 *  - adds an indexed, required `tenantId` field
 *  - injects `tenantId` into every query filter and aggregate pipeline
 *  - stamps `tenantId` on new documents (save, insertMany, bulkWrite)
 *  - scopes every bulkWrite operation's filter
 * Any query without a tenant in context throws, unless explicitly run via runUnscoped().
 */
const QUERY_OPS = [
  'find', 'findOne', 'findOneAndUpdate', 'findOneAndDelete', 'findOneAndReplace',
  'countDocuments', 'updateOne', 'updateMany', 'deleteOne', 'deleteMany', 'replaceOne', 'distinct',
] as const;

const requireTenant = () => {
  const ctx = getContext();
  if (ctx?.bypassTenant) return null;
  if (!ctx?.tenantId) throw new Error('Tenant context missing: refusing to run unscoped query');
  return new mongoose.Types.ObjectId(String(ctx.tenantId));
};

export function tenantPlugin(schema: Schema) {
  if (!schema.path('tenantId')) {
    schema.add({ tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, immutable: true } });
  }

  for (const op of QUERY_OPS) {
    schema.pre(op as any, { document: false, query: true }, function (this: Query<unknown, unknown>) {
      const tenantId = requireTenant();
      if (tenantId) this.where({ tenantId });
    });
  }

  schema.pre('aggregate', function () {
    const tenantId = requireTenant();
    if (tenantId) this.pipeline().unshift({ $match: { tenantId } });
  });

  schema.pre('validate', function () {
    const tenantId = requireTenant();
    if (!tenantId) return;
    if (!this.get('tenantId')) this.set('tenantId', tenantId);
    else if (String(this.get('tenantId')) !== String(tenantId)) throw new Error('Cross-tenant write blocked');
  });

  // bulkWrite bypasses query middleware: scope every operation's filter and stamp every new document
  schema.pre('bulkWrite' as any, function (next: (err?: Error) => void, ops: any[]) {
    try {
      const tenantId = requireTenant();
      if (tenantId) {
        const stamp = (d: any) => {
          if (!d) return;
          if (d.tenantId == null) d.tenantId = tenantId;
          else if (String(d.tenantId) !== String(tenantId)) throw new Error('Cross-tenant write blocked');
        };
        for (const op of ops ?? []) {
          const [kind, body] = Object.entries(op ?? {})[0] ?? [];
          if (!body) continue;
          if (kind === 'insertOne') stamp((body as any).document);
          else {
            const b = body as any;
            b.filter ??= {};
            stamp(b.filter);
            if (kind === 'replaceOne') stamp(b.replacement);
            if ((kind === 'updateOne' || kind === 'updateMany') && b.update && !Array.isArray(b.update)) {
              const soi = b.update.$setOnInsert;
              if (soi?.tenantId != null && String(soi.tenantId) !== String(tenantId)) throw new Error('Cross-tenant write blocked');
              const set = b.update.$set;
              if (set?.tenantId != null && String(set.tenantId) !== String(tenantId)) throw new Error('Cross-tenant write blocked');
            }
          }
        }
      }
      next();
    } catch (e) {
      next(e as Error);
    }
  });

  schema.pre('insertMany', function (next: (err?: Error) => void, docs: any[]) {
    try {
      const tenantId = requireTenant();
      if (tenantId) for (const d of docs) d.tenantId ??= tenantId;
      next();
    } catch (e) {
      next(e as Error);
    }
  });
}

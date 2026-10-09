import type { Schema } from 'mongoose';
import { bumpData } from './cache.js';
import { getContext } from './tenantContext.js';

const changeHooks: ((tenantId: string) => void)[] = [];
/** Called (debounced by the caller) whenever an organisation's score data changes. */
export const onDataChange = (fn: (tenantId: string) => void) => changeHooks.push(fn);

const fire = (tenantId: unknown) => {
  const t = tenantId ?? getContext()?.tenantId;
  if (!t) return;
  const id = String(t);
  void bumpData(id);
  for (const fn of changeHooks) fn(id);
};

/** Bumps the organisation's data version after any write, so cached scores are never stale. */
export function dataVersionPlugin(schema: Schema) {
  schema.post('save', function () {
    fire(this.get('tenantId'));
  });
  schema.post('insertMany', function (docs: any[]) {
    fire(docs?.[0]?.tenantId);
  });
  for (const op of ['updateOne', 'updateMany', 'findOneAndUpdate', 'deleteOne', 'deleteMany', 'findOneAndDelete', 'replaceOne'] as const) {
    schema.post(op as any, { document: false, query: true }, function (this: any) {
      fire(this.getFilter?.()?.tenantId);
    });
  }
  schema.post('deleteOne', { document: true, query: false }, function (this: any) {
    fire(this.get('tenantId'));
  });
  schema.post('bulkWrite' as any, function () {
    fire(undefined);
  });
}

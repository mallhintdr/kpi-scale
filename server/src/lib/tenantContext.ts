import { AsyncLocalStorage } from 'node:async_hooks';
import type { Types } from 'mongoose';

export interface RequestContext {
  tenantId?: Types.ObjectId | string;
  userId?: string;
  /** Explicit opt-out of tenant scoping (auth lookups, tenant signup, system jobs). */
  bypassTenant?: boolean;
}

const storage = new AsyncLocalStorage<RequestContext>();

export const runWithContext = <T>(ctx: RequestContext, fn: () => T): T => storage.run(ctx, fn);

export const getContext = (): RequestContext | undefined => storage.getStore();

// Mongoose queries are lazy thenables: awaiting inside the scope makes them execute with this context.

/** Run code that must see data across tenants. Use sparingly and only in trusted paths. */
export const runUnscoped = <T>(fn: () => T): Promise<Awaited<T>> =>
  storage.run({ ...getContext(), bypassTenant: true }, async (): Promise<Awaited<T>> => await fn());

/** Run code as a specific tenant (e.g. right after signup or in background jobs). */
export const runAsTenant = <T>(tenantId: Types.ObjectId | string, fn: () => T): Promise<Awaited<T>> =>
  storage.run({ ...getContext(), tenantId, bypassTenant: false }, async (): Promise<Awaited<T>> => await fn());

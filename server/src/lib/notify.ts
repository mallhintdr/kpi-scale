import type { Types } from 'mongoose';
import { Audit, Notification } from '../models/index.js';
import { getContext } from './tenantContext.js';
import { logger } from './logger.js';
import { defineJob, enqueue } from './queue.js';

type Id = string | Types.ObjectId;
interface Note { type: string; title: string; body?: string; link?: string }

defineJob('notify', async (d) => {
  const ids = d.userIds as string[];
  const n = d.note as Note;
  await Notification.insertMany(ids.map((userId) => ({ userId, ...n })), { ordered: false });
});

/**
 * Creates in-app notifications through the job queue, so a large fan-out never slows the request
 * and a notification failure never fails the business action.
 */
export async function notify(userIds: Id | Id[], n: Note) {
  const ids = [...new Set((Array.isArray(userIds) ? userIds : [userIds]).filter(Boolean).map(String))];
  const tenantId = getContext()?.tenantId;
  if (!ids.length || !tenantId) return;
  try {
    await enqueue('notify', { tenantId: String(tenantId), userIds: ids, note: n });
  } catch (err) {
    logger.warn({ err }, 'notify failed');
  }
}

export async function audit(action: string, entity: string, entityId?: Id, meta?: unknown) {
  try {
    await Audit.create({ actorId: getContext()?.userId, action, entity, entityId, meta });
  } catch (err) {
    logger.warn({ err }, 'audit failed');
  }
}

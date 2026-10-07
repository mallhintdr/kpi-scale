import type { Types } from 'mongoose';
import { Audit, Notification } from '../models/index.js';
import { getContext } from './tenantContext.js';
import { logger } from './logger.js';

type Id = string | Types.ObjectId;

/**
 * Creates in-app notifications. Kept fire-and-forget so a notification failure never
 * fails the business action. Swap for a queue (BullMQ) + push/email workers at scale.
 */
export async function notify(userIds: Id | Id[], n: { type: string; title: string; body?: string; link?: string }) {
  const ids = (Array.isArray(userIds) ? userIds : [userIds]).filter(Boolean);
  if (!ids.length) return;
  try {
    await Notification.insertMany(ids.map((userId) => ({ userId, ...n })), { ordered: false });
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

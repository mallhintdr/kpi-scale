import { Router } from 'express';
import { z } from 'zod';
import { idParam, q, validate } from '../../middleware/validate.js';
import { Notification } from '../../models/index.js';

const router = Router();

router.get(
  '/',
  validate({ query: z.object({ unread: z.enum(['true', 'false']).optional(), before: z.coerce.date().optional() }) }),
  async (req, res) => {
    const { unread, before } = q<any>(req);
    const filter: Record<string, unknown> = { userId: req.user!.id };
    if (unread === 'true') filter.readAt = null;
    if (before) filter.createdAt = { $lt: before }; // cursor pagination
    const items = await Notification.find(filter).sort({ createdAt: -1 }).limit(30).lean();
    res.json(items);
  },
);

router.get('/unread-count', async (req, res) => {
  res.json({ count: await Notification.countDocuments({ userId: req.user!.id, readAt: null }) });
});

router.post('/:id/read', validate({ params: idParam }), async (req, res) => {
  await Notification.updateOne({ _id: req.params.id, userId: req.user!.id }, { readAt: new Date() });
  res.status(204).end();
});

router.post('/read-all', async (req, res) => {
  await Notification.updateMany({ userId: req.user!.id, readAt: null }, { readAt: new Date() });
  res.status(204).end();
});

export default router;

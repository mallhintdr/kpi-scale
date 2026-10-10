/**
 * Inbound WhatsApp (public, no session): provider webhooks → reply commands from employees.
 *   GET  /api/whatsapp/webhook   Meta verification handshake
 *   POST /api/whatsapp/webhook   WASender (shared secret) or Meta (HMAC signature) messages
 * Ack first, dedupe by message id, identify the employee by phone, then handle the command in a job.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { Router, type Request } from 'express';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { notify } from '../../lib/notify.js';
import { defineJob, enqueue } from '../../lib/queue.js';
import { redis } from '../../lib/redis.js';
import { runUnscoped } from '../../lib/tenantContext.js';
import { Task, Tenant, User, WaMessage } from '../../models/index.js';
import { getBlueprint } from '../org/service.js';
import { buildDigest, helpReply, statusReply, tasksReply, type Lang } from './coach.js';
import { queueMessage } from './engine.js';
import { normalizePhone } from './phone.js';

const router = Router();

interface Inbound { waMessageId: string; phone: string; text: string | null; contactName?: string }

/* ---------- parsing ---------- */
function parseWasender(body: any): Inbound[] {
  if (body?.event !== 'messages.received') return [];
  const list = Array.isArray(body?.data?.messages) ? body.data.messages : [body?.data?.messages].filter(Boolean);
  return list.map((m: any) => ({
    waMessageId: m?.key?.id ?? m?.id,
    phone: normalizePhone(m?.key?.cleanedSenderPn ?? m?.key?.senderPn ?? m?.remoteJid ?? m?.key?.remoteJid),
    text: m?.message?.conversation ?? m?.messageBody ?? m?.message?.extendedTextMessage?.text ?? null,
    contactName: m?.pushName,
  })).filter((x: Inbound) => x.waMessageId && x.phone && !m_fromMe(x));
}
const m_fromMe = (_x: Inbound) => false;

function parseCloud(body: any): Inbound[] {
  const out: Inbound[] = [];
  for (const e of body?.entry ?? []) {
    for (const c of e?.changes ?? []) {
      const v = c?.value;
      for (const m of v?.messages ?? []) {
        out.push({ waMessageId: m.id, phone: normalizePhone(m.from), text: m?.text?.body ?? null, contactName: v?.contacts?.[0]?.profile?.name });
      }
    }
  }
  return out.filter((x) => x.phone);
}

/* ---------- authentication ---------- */
function verified(req: Request) {
  if (env.NODE_ENV === 'development' && env.WHATSAPP_MODE === 'mock') return true;
  if (env.WHATSAPP_MODE === 'cloud') {
    const sig = String(req.headers['x-hub-signature-256'] ?? '');
    const raw = (req as any).rawBody as Buffer | undefined;
    if (!env.WHATSAPP_APP_SECRET || !sig || !raw) return false;
    const expected = `sha256=${createHmac('sha256', env.WHATSAPP_APP_SECRET).update(raw).digest('hex')}`;
    return sig.length === expected.length && timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  }
  // WASender: shared secret in the URL (?secret=) or the X-Webhook-Signature header
  const secret = env.WHATSAPP_WEBHOOK_SECRET;
  if (!secret) return false;
  const given = String(req.query.secret ?? req.headers['x-webhook-signature'] ?? '');
  return given.length === secret.length && timingSafeEqual(Buffer.from(given), Buffer.from(secret));
}

router.get('/webhook', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && env.WHATSAPP_VERIFY_TOKEN && req.query['hub.verify_token'] === env.WHATSAPP_VERIFY_TOKEN) return res.status(200).send(String(req.query['hub.challenge'] ?? ''));
  res.sendStatus(403);
});

router.post('/webhook', async (req, res) => {
  res.sendStatus(200); // providers retry on slow or non-2xx responses
  try {
    if (!verified(req)) return logger.warn('whatsapp webhook: rejected (signature / secret)');
    const msgs = env.WHATSAPP_MODE === 'cloud' ? parseCloud(req.body) : parseWasender(req.body);
    for (const m of msgs) {
      const r = redis();
      if (r && !(await r.set(`wa:msg:${m.waMessageId}`, '1', 'EX', 86_400, 'NX'))) continue; // provider retry
      await handleInbound(m);
    }
  } catch (err) {
    logger.error({ err }, 'whatsapp webhook failed');
  }
});

/** Find who wrote (by phone) and hand the message to a job in their organisation. */
export async function handleInbound(m: Inbound) {
  const users = await runUnscoped(() => User.find({ phoneE164: m.phone, status: 'active' }).select('_id tenantId').lean());
  for (const u of users) {
    const t = await runUnscoped(() => Tenant.findOne({ _id: u.tenantId, status: 'active', 'whatsapp.enabled': true }).select('_id').lean());
    if (!t) continue;
    await enqueue('wa-inbound', { tenantId: String(t._id), userId: String(u._id), phone: m.phone, text: m.text ?? '' });
    return true;
  }
  logger.info({ phone: m.phone }, 'whatsapp message from an unknown number');
  return false;
}

/* ---------- commands ---------- */
defineJob('wa-inbound', async (d) => {
  const tenantId = String(d.tenantId);
  const text = String(d.text ?? '').trim();
  await WaMessage.create({ userId: d.userId, phone: d.phone, direction: 'in', kind: 'inbound', text: text.slice(0, 4096), status: 'received' });
  const [tenant, bp, user] = await Promise.all([
    runUnscoped(() => Tenant.findById(tenantId).select('whatsapp settings').lean()),
    getBlueprint(tenantId),
    User.findById(d.userId).select('name phoneE164 whatsappOptOut').lean(),
  ]);
  if (!tenant || !bp || !user) return;
  const lang = ((tenant.whatsapp as any)?.language ?? 'english') as Lang;
  const tz = tenant.settings?.timezone ?? 'Asia/Karachi';
  const reply = (t: string) => queueMessage(tenantId, { userId: String(user._id), phone: String(d.phone), kind: 'reply', text: t });
  const cmd = text.toUpperCase();
  const digest = () => buildDigest(bp, { _id: user._id, name: user.name, phoneE164: String(d.phone) }, tz, new Map(), async () => ({ ids: [], label: '' }));

  if (/^(STATUS|STATS|SCORE)\b/.test(cmd)) return reply(statusReply(bp, await digest(), lang));
  if (/^TASKS?\b/.test(cmd)) return reply(tasksReply(await digest(), lang));
  const done = /^DONE\s+(\d+)/.exec(cmd);
  if (done) {
    const open = await Task.find({ assigneeId: user._id, status: 'open' }).sort({ dueDate: 1 }).limit(20);
    const t = open[Number(done[1]) - 1];
    if (!t) return reply(`There is no open task number ${done[1]}. Reply TASKS to see the list.`);
    t.set({ status: 'done', completedAt: new Date(), completionNote: 'Marked done on WhatsApp' });
    await t.save();
    await notify(t.assignedBy, { type: 'task.done', title: `Task completed: ${t.title}`, body: `by ${user.name} (WhatsApp)`, link: '/tasks?box=assigned' });
    return reply(`✅ Done: ${t.title}${t.completedAt! > t.dueDate ? ' (completed late)' : ''}`);
  }
  if (/^STOP\b/.test(cmd)) {
    if (!(tenant.whatsapp as any)?.allowOptOut) return reply('Daily updates are required by your organisation and cannot be switched off. Contact your administrator if this is a problem.');
    await User.updateOne({ _id: user._id }, { whatsappOptOut: true });
    return reply('You will no longer receive daily updates. Reply START to turn them back on.');
  }
  if (/^START\b/.test(cmd)) {
    await User.updateOne({ _id: user._id }, { whatsappOptOut: false });
    return reply('Daily updates are on again.');
  }
  return reply(helpReply(lang));
});

export default router;

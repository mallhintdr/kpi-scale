/**
 * WhatsApp delivery engine.
 *   wa-tick   every 5 minutes: for each organisation with coaching on, start any slot that is due
 *             (morning / follow-ups / evening) in its own timezone, on working days only, once a day
 *   wa-run    builds every recipient's message for that slot (and the evening escalation), logs it
 *   wa-send   separate, rate-limited queue that talks to the provider
 * Without Redis the same steps run inline (sends are spaced out).
 */
import { Queue, Worker } from 'bullmq';
import { Types } from 'mongoose';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { notify } from '../../lib/notify.js';
import { defineJob, enqueue, schedule } from '../../lib/queue.js';
import { bullConnection, redis } from '../../lib/redis.js';
import { runAsTenant, runUnscoped } from '../../lib/tenantContext.js';
import { Charge, Tenant, Unit, User, WaMessage, WaState } from '../../models/index.js';
import { getBlueprint } from '../org/service.js';
import { leagueView } from '../revenue/performance.routes.js';
import {
  behindReasons, buildDigest, evaluateEscalation, evening, followup, localNow, morning, supervisorAlert, supervisorOf,
  type Digest, type EscalationCfg, type Lang, type RankCache, type Slot,
} from './coach.js';
import { sendWhatsApp } from './providers.js';

/* ---------------- sending (rate-limited) ---------------- */
let waQueue: Queue | null = null;
let waWorker: Worker | null = null;

/**
 * Atomically claim the message (queued|retrying -> sending) so a duplicate or stalled job cannot send it twice.
 * On failure it goes back to `retrying` while BullMQ attempts remain, else `failed`; the error is rethrown.
 * Statuses are written with update operators (no save) — 'sending' / 'retrying' must be in the WaMessage enum.
 */
async function deliver(messageId: string, attempt = 1, attempts = 1) {
  const m = await WaMessage.findOneAndUpdate({ _id: messageId, status: { $in: ['queued', 'retrying'] } }, { $set: { status: 'sending' } }, { new: true }).lean();
  if (!m) return;
  try {
    const r = await sendWhatsApp(m.phone, m.text ?? '', { session: m.kind === 'reply' });
    await WaMessage.updateOne({ _id: m._id }, { $set: { status: 'sent', provider: r.provider, providerId: r.id ?? undefined, sentAt: new Date() }, $unset: { error: 1 } });
  } catch (err) {
    await WaMessage.updateOne({ _id: m._id }, { $set: { status: attempt < attempts ? 'retrying' : 'failed', error: (err as Error).message.slice(0, 500) } });
    throw err;
  }
}

/** Queue one message for delivery (logged first, so every attempt is auditable). */
export async function queueMessage(tenantId: string, x: { userId?: string; phone: string; kind: string; text: string; day?: string }) {
  const m = await runAsTenant(tenantId, () => WaMessage.create({ ...x, direction: 'out', status: 'queued' }));
  if (env.REDIS_URL) {
    waQueue ??= new Queue('wa', { connection: bullConnection() });
    await waQueue.add('send', { tenantId, messageId: String(m._id) }, { attempts: 3, backoff: { type: 'exponential', delay: 5000 }, removeOnComplete: { count: 2000 }, removeOnFail: { count: 5000 } });
  } else {
    setTimeout(() => runAsTenant(tenantId, () => deliver(String(m._id))).catch((err) => logger.warn({ err }, 'whatsapp send failed')), 50).unref?.();
  }
  return m;
}

/** Start the delivery worker: at most WHATSAPP_RATE_PER_SEC messages per second across all instances. */
export function startWaWorker() {
  if (!env.REDIS_URL || waWorker) return;
  waWorker = new Worker('wa', async (job) => runAsTenant(job.data.tenantId, () => deliver(job.data.messageId, job.attemptsMade + 1, job.opts.attempts ?? 1)), {
    connection: bullConnection(),
    concurrency: 5,
    limiter: { max: env.WHATSAPP_RATE_PER_SEC, duration: 1000 },
  });
  waWorker.on('failed', (job, err) => logger.warn({ err: err.message, id: job?.id }, 'whatsapp delivery failed'));
}
export async function stopWaWorker() {
  await Promise.allSettled([waWorker?.close(), waQueue?.close()]);
  waWorker = null;
  waQueue = null;
}

/* ---------------- recipients & content ---------------- */
interface WaSettings {
  enabled: boolean; language: Lang; morningAt: string; followupsAt: string[]; eveningAt: string; workdays: number[]; holidays: string[];
  audience: 'scored' | 'all'; escalation: EscalationCfg; allowOptOut: boolean;
}

export async function recipients(tenantId: string, audience: 'scored' | 'all', onlyUserId?: string) {
  const bp = await getBlueprint(tenantId);
  const charges = await Charge.find({ $or: [{ to: null }, { to: { $gt: new Date() } }], ...(onlyUserId ? { userId: onlyUserId } : {}) }).select('userId post').lean();
  const ids = [...new Set(charges.filter((c) => audience === 'all' || !bp?.dataPosts.has(c.post)).map((c) => String(c.userId)))];
  return User.find({ _id: { $in: ids }, status: 'active', phoneE164: { $exists: true, $ne: null }, whatsappOptOut: { $ne: true } }).select('name phoneE164').lean();
}

/** Ranks are computed once per (area, post) per run and shared by everyone in it. */
function leagueCache(bp: NonNullable<Awaited<ReturnType<typeof getBlueprint>>>) {
  const fy = bp.fy.of(new Date());
  return async (unitId: string, post: string) => {
    const unit = await Unit.findById(unitId).select('name type').lean();
    if (!unit) return { ids: [], label: '' };
    const l = await leagueView(bp, unit, post, fy);
    const seen = new Set<string>();
    const ids = l.items.filter((x: any) => x.score != null).map((x: any) => String(x.user._id)).filter((id: string) => (seen.has(id) ? false : (seen.add(id), true)));
    const plural = bp.postLabel(post).replace(/([^s])$/, '$1s');
    return { ids, label: `among ${plural} in ${unit.name.replace(' (test)', '')}` };
  };
}

/** Build (and for the evening, escalate) and queue one slot's messages for an organisation. */
export async function runSlot(tenantId: string, slot: Slot, day: string, opts: { onlyUserId?: string; dryRun?: boolean } = {}) {
  const tenant = await runUnscoped(() => Tenant.findById(tenantId).select('whatsapp settings').lean());
  const bp = await getBlueprint(tenantId);
  if (!tenant || !bp) return { queued: 0, preview: [] as { userId: string; text: string }[] };
  const s = tenant.whatsapp as unknown as WaSettings;
  const tz = tenant.settings?.timezone ?? 'Asia/Karachi';
  const lang: Lang = s?.language ?? 'english';
  // People on leave today get nothing, and their day does not count towards warnings
  const onLeave = new Set((await WaState.find({ leaveFrom: { $lte: day }, leaveUntil: { $gte: day } }).select('userId').lean()).map((x) => String(x.userId)));
  const people = (await recipients(tenantId, s?.audience ?? 'scored', opts.onlyUserId)).filter((u) => !onLeave.has(String(u._id)));
  const ranks: RankCache = new Map();
  const leagueFor = leagueCache(bp);
  const label = new Date().toLocaleDateString('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short' });
  const time = new Date().toLocaleTimeString('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit' });
  const preview: { userId: string; text: string }[] = [];
  let queued = 0;
  for (const u of people) {
    let d: Digest;
    try {
      d = await buildDigest(bp, u as any, tz, ranks, leagueFor);
    } catch (err) {
      logger.warn({ err, userId: u._id }, 'digest failed');
      continue;
    }
    let text: string;
    if (slot === 'morning') text = morning(bp, d, lang, label);
    else if (slot === 'followup') text = followup(bp, d, lang, time);
    else {
      const esc = s?.escalation ?? { enabled: false } as EscalationCfg;
      let warn = null;
      if (esc.enabled) {
        const reasons = behindReasons(bp, d, esc);
        const r = opts.dryRun ? { level: reasons.length ? 1 : 0, days: reasons.length ? 1 : 0, changed: false } : await evaluateEscalation(String(u._id), day, reasons, esc);
        warn = { level: r.level, days: r.days, reasons };
        // Level 2+: the person is notified in-app too, and the supervisor and admins are informed
        if (!opts.dryRun && r.level >= 2 && r.changed) {
          const reason = reasons.map((x) => x.en).join('; ');
          await notify(String(u._id), { type: 'performance.warning', title: r.level >= 3 ? 'Final performance warning' : 'Performance under review', body: reason, link: '/' });
          if (esc.notifySupervisor) {
            const sup = await supervisorOf(bp, String(u._id));
            if (sup) {
              await notify(String(sup._id), { type: 'performance.alert', title: `Performance alert: ${d.name}`, body: `${r.days} working days behind — ${reason}`, link: `/officers/${u._id}` });
              if (sup.phoneE164 && !sup.whatsappOptOut) await queueMessage(tenantId, { userId: String(sup._id), phone: sup.phoneE164, kind: 'supervisor', text: supervisorAlert(d, r.level, r.days, reason, lang), day });
            }
            if (r.level >= 3) {
              const admins = await User.find({ role: { $in: ['owner', 'admin'] }, status: 'active' }).select('_id').lean();
              await notify(admins.map((a) => String(a._id)), { type: 'performance.alert', title: `Final warning issued: ${d.name}`, body: reason, link: `/officers/${u._id}` });
            }
          }
        }
      }
      text = evening(bp, d, lang, label, warn);
    }
    if (opts.dryRun) {
      preview.push({ userId: String(u._id), text });
      continue;
    }
    await queueMessage(tenantId, { userId: String(u._id), phone: d.phone, kind: slot, text, day });
    queued++;
  }
  logger.info({ tenantId, slot, day, queued, people: people.length }, 'whatsapp slot run');
  return { queued, preview };
}

/* ---------------- schedule ---------------- */
const SLOT_WINDOW_MIN = 60; // a slot missed by downtime still runs within the hour
const toMin = (hm: string) => {
  const [h, m] = hm.split(':').map(Number);
  return h * 60 + m;
};
const doneLocal = new Map<string, number>(); // key -> expiry (ms), pruned on every claim
async function claim(key: string) {
  const r = redis();
  if (r) return !!(await r.set(key, '1', 'EX', 2 * 86_400, 'NX'));
  const now = Date.now();
  for (const [k, exp] of doneLocal) if (exp < now) doneLocal.delete(k);
  if (doneLocal.has(key)) return false;
  doneLocal.set(key, now + 2 * 86_400_000);
  return true;
}
async function release(key: string) {
  const r = redis();
  if (r) await r.del(key);
  else doneLocal.delete(key);
}

defineJob('wa-tick', async () => {
  const tenants = await runUnscoped(() => Tenant.find({ status: 'active', isPlatform: { $ne: true }, 'whatsapp.enabled': true }).select('whatsapp settings').lean());
  for (const t of tenants) {
    const s = t.whatsapp as unknown as WaSettings;
    const tz = t.settings?.timezone ?? 'Asia/Karachi';
    const at0 = new Date();
    const now = toMin(localNow(tz, at0).hm);
    const slots: [Slot, string, string][] = [['morning', s.morningAt, 'morning'], ...(s.followupsAt ?? []).map((f, i) => ['followup', f, `followup${i}`] as [Slot, string, string]), ['evening', s.eveningAt, 'evening']];
    for (const [slot, at, tag] of slots) {
      const due = toMin(at);
      // minutes since the slot was due, wrapping past midnight (a 23:30 slot is still caught up at 00:10)
      const late = (now - due + 1440) % 1440;
      if (late > SLOT_WINDOW_MIN) continue;
      // the slot belongs to the local day on which it fell due (yesterday, after a wrap)
      const { day, weekday } = localNow(tz, new Date(at0.getTime() - late * 60_000));
      if (!s.workdays?.includes(weekday) || s.holidays?.includes(day)) continue;
      const key = `wa:slot:${t._id}:${day}:${tag}`;
      if (!(await claim(key))) continue;
      try {
        await enqueue('wa-run', { tenantId: String(t._id), slot, day }, { jobId: `wa-run-${t._id}-${day}-${tag}` });
      } catch (err) {
        await release(key); // try again on the next tick
        throw err;
      }
    }
  }
});
defineJob('wa-run', async (d) => runSlot(String(d.tenantId), d.slot as Slot, String(d.day)));
schedule('wa-tick', '*/5 * * * *');

export { Types };

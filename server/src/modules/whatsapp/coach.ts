/**
 * Daily coaching content: what each person should do today, how they are doing, and — when they keep
 * falling behind — a fair, step-by-step escalation (nudge → under review → disciplinary warning) with
 * the supervisor informed. Messages are built per person from their own KPIs, targets and tasks.
 */
import { Types } from 'mongoose';
import { AssignedTarget, Charge, RevEntry, Task, Unit, User, WaState } from '../../models/index.js';
import type { BP } from '../org/blueprint.js';
import { scoresForUser } from '../revenue/performance.routes.js';

export type Slot = 'morning' | 'followup' | 'evening';
export type Lang = 'english' | 'urdu' | 'bilingual';
export interface EscalationCfg { enabled: boolean; paceGap: number; overdueTasks: number; days: number; notifySupervisor: boolean }

/* ---------------- time in the organisation's timezone ---------------- */
export function localNow(tz: string, now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false }).formatToParts(now).map((p) => [p.type, p.value]));
  const day = `${parts.year}-${parts.month}-${parts.day}`;
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
  return { day, hm: `${parts.hour === '24' ? '00' : parts.hour}:${parts.minute}`, weekday: wd };
}
/** Start of the organisation's local day as a UTC instant (approximation via offset). */
export function startOfLocalDay(tz: string, now = new Date()) {
  const { day } = localNow(tz, now);
  const guess = new Date(`${day}T00:00:00Z`);
  const offsetMin = (new Date(guess.toLocaleString('en-US', { timeZone: tz })).getTime() - new Date(guess.toLocaleString('en-US', { timeZone: 'UTC' })).getTime()) / 60000;
  return new Date(guess.getTime() - offsetMin * 60000);
}

/* ---------------- per-person facts ---------------- */
export interface Digest {
  userId: string; name: string; first: string; phone: string;
  post?: string; unitName?: string;
  money: { target: number; done: number; pct: number | null };
  elapsed: number;
  score: number | null; band?: string;
  rank?: { pos: number; of: number; label: string };
  targets: { name: string; target: number; achieved: number; pending: number; remaining: number; daysLeft: number; perDay: number; money: boolean; end: Date; expectedPct: number }[];
  tasks: { id: string; title: string; due: Date; overdue: boolean; today: boolean }[];
  today: { entries: number; progress: number; tasksDone: number };
  toVerify: number;
  weakest?: { name: string; pct: number | null };
}

/** Amounts the way people read them on a phone: Rs 13,450 · Rs 2.5 M (crores / lakhs avoided for clarity). */
const fmtMoney = (bp: BP, v: number) => {
  const sym = bp.raw.money.symbol;
  const a = Math.abs(v);
  if (a < 1e6) return `${sym} ${Math.round(v).toLocaleString('en-PK')}`;
  return `${sym} ${(v / 1e6).toLocaleString('en-PK', { maximumFractionDigits: 2 })} M`;
};
const fmtVal = (bp: BP, v: number, money: boolean) => (money ? fmtMoney(bp, v) : Math.round(v).toLocaleString('en-PK'));

/** Rank cache shared by every person in one run: league per (area, post). */
export type RankCache = Map<string, { ids: string[]; label: string }>;

export async function buildDigest(bp: BP, user: { _id: Types.ObjectId; name: string; phoneE164: string }, tz: string, ranks: RankCache, leagueFor: (unitId: string, post: string) => Promise<{ ids: string[]; label: string }>): Promise<Digest> {
  const uid = String(user._id);
  const fy = bp.fy.of(new Date());
  const dayStart = startOfLocalDay(tz);
  const now = new Date();
  const [scores, targets, tasks, entriesToday, doneToday, charges] = await Promise.all([
    scoresForUser(bp, uid, fy),
    AssignedTarget.find({ assigneeId: user._id, status: 'active', startDate: { $lte: now }, endDate: { $gte: dayStart } }).lean(),
    Task.find({ assigneeId: user._id, status: 'open' }).sort({ dueDate: 1 }).limit(20).lean(),
    RevEntry.countDocuments({ enteredBy: user._id, updatedAt: { $gte: dayStart } }),
    Task.countDocuments({ assigneeId: user._id, status: 'done', completedAt: { $gte: dayStart } }),
    Charge.find({ userId: user._id, $or: [{ to: null }, { to: { $gt: now } }] }).populate('unitId', 'name anc type').lean(),
  ]);
  const s = scores[0];
  const money = { target: s?.target ?? 0, done: s?.collected ?? 0, pct: s && s.target ? Math.min(100, Math.round((s.collected / s.target) * 1000) / 10) : null };

  // Rank among peers of the same post, within the area two levels up (e.g. a Patwari in the tehsil)
  let rank: Digest['rank'];
  if (s) {
    const unit = charges.find((c) => c.post === s.post)?.unitId as any;
    const area = unit?.anc?.[Math.max(0, unit.anc.length - 3)];
    if (area) {
      const k = `${area}|${s.post}`;
      if (!ranks.has(k)) ranks.set(k, await leagueFor(String(area), s.post));
      const l = ranks.get(k)!;
      const pos = l.ids.indexOf(uid);
      if (pos >= 0) rank = { pos: pos + 1, of: l.ids.length, label: l.label };
    }
  }

  const progressToday = targets.reduce((sum, t) => sum + (t.progress ?? []).filter((p: any) => p.by && String(p.by) === uid && p.createdAt && new Date(p.createdAt) >= dayStart).reduce((a: number, p: any) => a + p.value, 0), 0);
  const tlist = targets.map((t) => {
    const m = bp.metric.get(t.head);
    const remaining = Math.max(0, t.targetValue - t.achieved);
    const daysLeft = Math.max(1, Math.ceil((t.endDate.getTime() - now.getTime()) / 86_400_000));
    const span = t.endDate.getTime() - t.startDate.getTime();
    return {
      name: m?.name ?? t.head, target: t.targetValue, achieved: t.achieved, pending: t.achievedPending ?? 0, remaining, daysLeft,
      perDay: remaining / daysLeft, money: m?.unit === 'money', end: t.endDate,
      expectedPct: Math.min(100, ((now.getTime() - t.startDate.getTime()) / span) * 100),
    };
  });
  const tk = tasks.map((t) => ({ id: String(t._id), title: t.title, due: t.dueDate, overdue: t.dueDate < dayStart, today: t.dueDate >= dayStart && t.dueDate < new Date(dayStart.getTime() + 86_400_000) }));

  // Verification queue for verifiers
  let toVerify = 0;
  const vposts = new Set(bp.metrics.flatMap((m) => m.verifyPosts));
  const vcharges = charges.filter((c) => vposts.has(c.post));
  if (vcharges.length) {
    const or = vcharges.map((c) => ({ anc: (c.unitId as any)?._id, head: { $in: bp.metrics.filter((m) => m.verifyPosts.includes(c.post)).map((m) => m.code) } }));
    toVerify = await RevEntry.countDocuments({ status: 'submitted', $or: or });
  }

  const heads = s?.heads ?? {};
  const weakest = Object.entries(heads)
    .filter(([c, h]) => bp.metric.has(c) && h.of > 0)
    .sort((a, b) => (a[1].pct ?? 0) - (b[1].pct ?? 0))[0];

  return {
    userId: uid, name: user.name, first: user.name.split(' ')[0], phone: user.phoneE164,
    post: s?.postLabel ?? (charges[0] ? bp.postLabel(charges[0].post) : undefined), unitName: (charges[0]?.unitId as any)?.name,
    money, elapsed: Math.round(bp.fy.elapsed(fy) * 1000) / 10, score: s?.score ?? null, band: s?.band, rank,
    targets: tlist, tasks: tk, today: { entries: entriesToday, progress: progressToday, tasksDone: doneToday }, toVerify,
    weakest: weakest ? { name: bp.metric.get(weakest[0])!.name, pct: weakest[1].pct } : undefined,
  };
}

/* ---------------- escalation ---------------- */
export function behindReasons(bp: BP, d: Digest, cfg: EscalationCfg) {
  const out: { en: string; ur: string }[] = [];
  if (d.money.pct != null && d.money.target > 0 && d.money.pct < d.elapsed - cfg.paceGap) {
    out.push({ en: `${bp.raw.terms?.money ?? 'achievement'} at ${d.money.pct}% against ${d.elapsed}% of the year gone`, ur: `${d.money.pct}% ہدف حاصل، جبکہ سال کا ${d.elapsed}% گزر چکا` });
  }
  const overdue = d.tasks.filter((t) => t.overdue).length;
  if (overdue >= cfg.overdueTasks) out.push({ en: `${overdue} overdue tasks`, ur: `${overdue} کام تاخیر کا شکار` });
  const lagging = d.targets.filter((t) => t.target > 0 && (t.achieved / t.target) * 100 < t.expectedPct - 25);
  if (lagging.length) out.push({ en: `behind on ${lagging.map((t) => t.name).join(', ')}`, ur: `${lagging.map((t) => t.name).join('، ')} میں پیچھے` });
  return out;
}

/** Update the person's ladder for today (once per day) and return the level reached. */
export async function evaluateEscalation(userId: string, day: string, reasons: { en: string }[], cfg: EscalationCfg) {
  const st = (await WaState.findOne({ userId })) ?? new WaState({ userId });
  if (st.lastDay === day) return { level: st.level, days: st.behindDays, changed: false };
  const behind = reasons.length > 0;
  st.behindDays = behind ? st.behindDays + 1 : 0;
  const prev = st.level;
  st.level = !behind ? 0 : st.behindDays >= cfg.days * 2 ? 3 : st.behindDays >= cfg.days ? 2 : 1;
  st.lastDay = day;
  st.lastReason = reasons.map((r) => r.en).join('; ') || undefined;
  st.history.push({ day, level: st.level, reason: st.lastReason ?? '' });
  if (st.history.length > 60) st.history.splice(0, st.history.length - 60);
  await st.save();
  return { level: st.level, days: st.behindDays, changed: st.level !== prev };
}

/** The nearest supervising officer (a post that can assign targets, on an ancestor unit). */
export async function supervisorOf(bp: BP, userId: string) {
  const posts = bp.postsWithCap('assign_targets');
  const mine = await Charge.find({ userId, $or: [{ to: null }, { to: { $gt: new Date() } }] }).populate('unitId', 'anc').lean();
  const anc = (mine[0]?.unitId as any)?.anc as Types.ObjectId[] | undefined;
  if (!anc?.length) return null;
  const above = anc.slice(0, -1).map(String);
  const rows = await Charge.find({ unitId: { $in: above }, post: { $in: posts }, userId: { $ne: userId }, $or: [{ to: null }, { to: { $gt: new Date() } }] }).lean();
  rows.sort((a, b) => above.indexOf(String(b.unitId)) - above.indexOf(String(a.unitId))); // deepest first
  if (!rows[0]) return null;
  return User.findById(rows[0].userId).select('name phoneE164 whatsappOptOut').lean();
}

/* ---------------- message text ---------------- */
const bi = (lang: Lang, en: string, ur: string) => (lang === 'english' ? en : lang === 'urdu' ? ur : `${en}\n\n${ur}`);
const dateEn = (d: Date) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

export function morning(bp: BP, d: Digest, lang: Lang, dayLabel: string) {
  const T = bp.raw.terms ?? ({} as any);
  const tl = d.targets.slice(0, 5);
  const tasksDue = d.tasks.filter((t) => t.today || t.overdue);
  const pace = d.money.pct == null ? null : Math.round((d.money.pct - d.elapsed) * 10) / 10;
  const en = [
    `*Good morning, ${d.first}!* ☀️`,
    `*Today's goals — ${dayLabel}*`,
    ...(tl.length ? ['', '🎯 *Targets*', ...tl.map((t) => `• ${t.name}: ${fmtVal(bp, t.remaining, t.money)} left — about *${fmtVal(bp, t.perDay, t.money)} per day* to finish by ${dateEn(t.end)}`)] : []),
    ...(tasksDue.length ? ['', `📋 *Tasks* (${tasksDue.length})`, ...tasksDue.slice(0, 5).map((t, i) => `${i + 1}. ${t.title}${t.overdue ? ' — *overdue*' : ' — due today'}`)] : []),
    ...(d.money.pct != null ? ['', `📊 ${T.money ?? 'Achievement'} so far: *${d.money.pct}%* of target (year ${d.elapsed}% gone) — ${pace! >= 0 ? `ahead of pace by ${pace} pts` : `*behind pace by ${-pace!} pts*`}`] : []),
    ...(d.weakest ? [`Focus today: *${d.weakest.name}*${d.weakest.pct != null ? ` (${Math.round(d.weakest.pct)}%)` : ''}`] : []),
    ...(d.toVerify ? ['', `✅ ${d.toVerify} entr${d.toVerify === 1 ? 'y waits' : 'ies wait'} for your verification`] : []),
    '', '_Reply STATUS for your latest position, TASKS for your task list._',
  ].join('\n');
  const ur = [
    `*صبح بخیر، ${d.first}!* ☀️`,
    `*آج کے اہداف — ${dayLabel}*`,
    ...(tl.length ? ['', '🎯 *اہداف*', ...tl.map((t) => `• ${t.name}: ${fmtVal(bp, t.remaining, t.money)} باقی — ${dateEn(t.end)} تک مکمل کرنے کے لیے *روزانہ تقریباً ${fmtVal(bp, t.perDay, t.money)}*`)] : []),
    ...(tasksDue.length ? ['', `📋 *کام* (${tasksDue.length})`, ...tasksDue.slice(0, 5).map((t, i) => `${i + 1}. ${t.title}${t.overdue ? ' — *تاخیر*' : ' — آج'}`)] : []),
    ...(d.money.pct != null ? ['', `📊 اب تک: ہدف کا *${d.money.pct}%* (سال کا ${d.elapsed}% گزر چکا)`] : []),
    ...(d.toVerify ? ['', `✅ ${d.toVerify} اندراجات آپ کی تصدیق کے منتظر ہیں`] : []),
    '', '_تازہ صورتحال کے لیے STATUS لکھیں_',
  ].join('\n');
  return bi(lang, en, ur);
}

export function followup(bp: BP, d: Digest, lang: Lang, timeLabel: string) {
  const did = d.today.entries + d.today.tasksDone > 0 || d.today.progress > 0;
  const open = d.tasks.filter((t) => t.today || t.overdue);
  const tl = d.targets.filter((t) => t.remaining > 0).slice(0, 3);
  const en = [
    `⏰ *Progress check — ${timeLabel}*`,
    did
      ? `Good, ${d.first} — today so far: ${d.today.entries} entr${d.today.entries === 1 ? 'y' : 'ies'}, ${d.today.tasksDone} task${d.today.tasksDone === 1 ? '' : 's'} done${d.today.progress ? `, ${d.today.progress.toLocaleString()} logged against targets` : ''}.`
      : `${d.first}, nothing has been recorded yet today. Please update your progress now.`,
    ...(tl.length ? ['', '*Still to do today*', ...tl.map((t) => `• ${t.name}: ${fmtVal(bp, t.perDay, t.money)} today`)] : []),
    ...(open.length ? [...open.slice(0, 4).map((t, i) => `${i + 1}. ${t.title}${t.overdue ? ' (overdue)' : ''}`), '_Reply DONE <number> when a task is finished._'] : []),
  ].join('\n');
  const ur = [
    `⏰ *پیش رفت کا جائزہ — ${timeLabel}*`,
    did ? `شاباش ${d.first} — آج اب تک ${d.today.entries} اندراجات، ${d.today.tasksDone} کام مکمل۔` : `${d.first}، آج ابھی تک کچھ درج نہیں ہوا۔ براہ کرم ابھی اپنی پیش رفت درج کریں۔`,
    ...(tl.length ? ['', '*آج باقی*', ...tl.map((t) => `• ${t.name}: آج ${fmtVal(bp, t.perDay, t.money)}`)] : []),
    ...(open.length ? [...open.slice(0, 4).map((t, i) => `${i + 1}. ${t.title}${t.overdue ? ' (تاخیر)' : ''}`), '_کام مکمل ہونے پر DONE اور نمبر لکھیں_'] : []),
  ].join('\n');
  return bi(lang, en, ur);
}

export function evening(bp: BP, d: Digest, lang: Lang, dayLabel: string, warn: { level: number; days: number; reasons: { en: string; ur: string }[] } | null) {
  const T = bp.raw.terms ?? ({} as any);
  const band = d.band ? bp.bands.find((b) => b.key === d.band)?.label : undefined;
  const en = [
    `🌙 *Daily summary — ${dayLabel}*`,
    `Today: ${d.today.entries} entr${d.today.entries === 1 ? 'y' : 'ies'} · ${d.today.tasksDone} task${d.today.tasksDone === 1 ? '' : 's'} done${d.today.progress ? ` · ${d.today.progress.toLocaleString()} against targets` : ''}`,
    ...(d.money.pct != null ? [`${T.money ?? 'Achievement'}: *${d.money.pct}%* of target (expected ${d.elapsed}% by now)`] : []),
    ...(d.score != null ? [`KPI score: *${d.score}*${band ? ` (${band})` : ''}${d.rank ? ` · Rank *${d.rank.pos} of ${d.rank.of}* ${d.rank.label}` : ''}`] : []),
    ...(d.targets.length ? ['', '🎯 *Targets*', ...d.targets.slice(0, 5).map((t) => `• ${t.name}: ${fmtVal(bp, t.achieved, t.money)} of ${fmtVal(bp, t.target, t.money)} (${t.target ? Math.round((t.achieved / t.target) * 100) : 0}%)${t.pending ? ` + ${fmtVal(bp, t.pending, t.money)} awaiting verification` : ''}`)] : []),
    ...(d.weakest ? ['', `Tomorrow's focus: *${d.weakest.name}*`] : []),
    ...(warn && warn.level ? ['', warningText(warn.level, warn.days, warn.reasons.map((r) => r.en).join('; '), 'en')] : ['', '👍 Keep it up.']),
  ].join('\n');
  const ur = [
    `🌙 *روزانہ خلاصہ — ${dayLabel}*`,
    `آج: ${d.today.entries} اندراجات · ${d.today.tasksDone} کام مکمل`,
    ...(d.money.pct != null ? [`ہدف کا *${d.money.pct}%* حاصل (اب تک متوقع ${d.elapsed}%)`] : []),
    ...(d.score != null ? [`کارکردگی اسکور: *${d.score}*${d.rank ? ` · درجہ *${d.rank.pos}/${d.rank.of}*` : ''}`] : []),
    ...(d.weakest ? ['', `کل کی توجہ: *${d.weakest.name}*`] : []),
    ...(warn && warn.level ? ['', warningText(warn.level, warn.days, warn.reasons.map((r) => r.ur).join('؛ '), 'ur')] : ['', '👍 اسی طرح جاری رکھیں۔']),
  ].join('\n');
  return bi(lang, en, ur);
}

export function warningText(level: number, days: number, reason: string, l: 'en' | 'ur') {
  if (l === 'ur') {
    if (level === 1) return `⚠️ آپ پیچھے ہیں: ${reason}۔ براہ کرم کل رفتار تیز کریں۔`;
    if (level === 2) return `⚠️ *کارکردگی زیرِ جائزہ۔* مسلسل ${days} ورکنگ دنوں سے آپ پیچھے ہیں (${reason})۔ آپ کے افسر کو مطلع کر دیا گیا ہے۔ فوری بہتری لائیں۔`;
    return `🚫 *حتمی انتباہ۔* مسلسل ${days} ورکنگ دنوں سے آپ کی کارکردگی مطلوبہ معیار سے کم ہے (${reason})۔ بہتری نہ آنے کی صورت میں انتظامی یا تادیبی کارروائی شروع کی جا سکتی ہے۔ آپ کے افسر اور انتظامیہ کو مطلع کر دیا گیا ہے۔`;
  }
  if (level === 1) return `⚠️ You are falling behind: ${reason}. Please speed up tomorrow.`;
  if (level === 2) return `⚠️ *Performance under review.* For ${days} working days in a row you have been behind (${reason}). Your supervisor has been informed. Improve immediately.`;
  return `🚫 *Final warning.* Your performance has stayed below the required level for ${days} working days (${reason}). If it does not improve, administrative or disciplinary proceedings may be initiated. Your supervisor and the administration have been informed.`;
}

export function supervisorAlert(d: Digest, level: number, days: number, reason: string, lang: Lang) {
  const tag = level >= 3 ? 'final warning issued' : 'placed under review';
  const en = `📣 *Staff performance alert*\n${d.name}${d.post ? ` (${d.post}${d.unitName ? `, ${d.unitName}` : ''})` : ''} has been behind for ${days} working days: ${reason}.\nStatus: *${tag}*. Please review and take action as appropriate.`;
  const ur = `📣 *عملے کی کارکردگی الرٹ*\n${d.name}${d.post ? ` (${d.post})` : ''} مسلسل ${days} ورکنگ دنوں سے پیچھے ہیں۔\nحیثیت: *${level >= 3 ? 'حتمی انتباہ' : 'زیرِ جائزہ'}*۔ براہ کرم جائزہ لیں۔`;
  return bi(lang, en, ur);
}

export function statusReply(bp: BP, d: Digest, lang: Lang) {
  return evening(bp, d, lang, `${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} (so far)`, null).replace(/\n\n👍.*$/s, '');
}

export function tasksReply(d: Digest, lang: Lang) {
  if (!d.tasks.length) return bi(lang, '✅ You have no open tasks.', '✅ آپ کے ذمے کوئی زیرِ التوا کام نہیں۔');
  const list = d.tasks.slice(0, 10).map((t, i) => `${i + 1}. ${t.title} — ${t.overdue ? 'overdue' : `due ${dateEn(t.due)}`}`).join('\n');
  return bi(lang, `📋 *Your open tasks*\n${list}\n\n_Reply DONE <number> to close one._`, `📋 *آپ کے کام*\n${list}\n\n_مکمل کام کے لیے DONE اور نمبر لکھیں_`);
}

export const helpReply = (lang: Lang) =>
  bi(lang, '*Commands*\nSTATUS — your position today\nTASKS — your open tasks\nDONE 2 — mark task 2 as done\nHELP — this list', '*ہدایات*\nSTATUS — آج کی صورتحال\nTASKS — زیرِ التوا کام\nDONE 2 — کام نمبر 2 مکمل\nHELP — یہ فہرست');

export { Unit };

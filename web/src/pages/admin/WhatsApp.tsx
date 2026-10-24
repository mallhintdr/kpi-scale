/**
 * WhatsApp coaching — daily goals in the morning, follow-ups during the day, an evening summary
 * against each person's KPIs, and a step-by-step escalation for people who keep falling behind.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { AlertTriangle, MessageCircle, Plus, RotateCcw, Save, Send, Trash2, UserRound } from 'lucide-react';
import { useDeferredValue, useRef, useState } from 'react';
import { PageHeader } from '../../components/AppShell';
import { Badge, Button, Card, Empty, ErrorState, Field, FormError, Input, Loading, SectionTitle, Segmented, Select, useToast } from '../../components/ui';
import { del, get, post, put } from '../../lib/api';
import { useSave } from './shared';

interface Settings {
  enabled: boolean; language: 'english' | 'urdu' | 'bilingual'; morningAt: string; followupsAt: string[]; eveningAt: string;
  workdays: number[]; holidays: string[]; audience: 'scored' | 'all'; allowOptOut: boolean;
  escalation: { enabled: boolean; paceGap: number; overdueTasks: number; days: number; notifySupervisor: boolean };
}
interface Info { mode: string; timezone?: string; settings?: Settings; stats: { recipients: number; withPhone: number; today: Record<string, number>; underReview: number } }
interface Msg { _id: string; direction: 'in' | 'out'; kind: string; text: string; status: string; error?: string; phone: string; createdAt: string; userId?: { name: string; designation?: string } }
interface Esc { _id: string; level: number; behindDays: number; lastDay: string; lastReason?: string; userId: { _id: string; name: string; designation?: string; phone?: string } | null }
interface UserRow { _id: string; name: string; designation?: string; phone?: string }

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DEFAULTS: Settings = {
  enabled: false, language: 'english', morningAt: '08:30', followupsAt: ['11:30', '14:30'], eveningAt: '18:00', workdays: [1, 2, 3, 4, 5, 6], holidays: [],
  audience: 'scored', allowOptOut: false, escalation: { enabled: true, paceGap: 15, overdueTasks: 3, days: 3, notifySupervisor: true },
};
const LEVEL = ['On track', 'Notice issued', 'Under review', 'Final warning'];
const LEVEL_TONE = ['bg-emerald-100 text-emerald-800', 'bg-amber-100 text-amber-800', 'bg-orange-100 text-orange-800', 'bg-rose-100 text-rose-800'];

export default function WhatsApp() {
  const [tab, setTab] = useState<'settings' | 'preview' | 'log' | 'review'>('settings');
  const info = useQuery({ queryKey: ['org', 'whatsapp'], queryFn: () => get<Info>('/org/whatsapp') });
  if (info.isLoading) return <Loading />;
  if (info.error) return <ErrorState error={info.error} retry={info.refetch} />;
  const d = info.data!;
  return (
    <>
      <PageHeader title="WhatsApp coaching" subtitle="Morning goals · follow-ups · evening summary · escalation for those falling behind" />
      <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {[
          { l: 'Status', v: d.settings?.enabled ? 'On' : 'Off', tone: d.settings?.enabled ? 'text-emerald-700' : 'text-slate-500' },
          { l: 'Receive daily', v: d.stats.recipients.toLocaleString() },
          { l: 'Sent today', v: (d.stats.today.sent ?? 0).toLocaleString(), sub: d.stats.today.failed ? `${d.stats.today.failed} failed` : undefined },
          { l: 'Under review', v: d.stats.underReview.toLocaleString(), tone: d.stats.underReview ? 'text-rose-700' : undefined },
        ].map((s) => (
          <Card key={s.l} className="p-3">
            <div className={clsx('text-xl font-bold tabular-nums', s.tone)}>{s.v}</div>
            <div className="text-[12px] font-semibold uppercase tracking-wide text-slate-500">{s.l}</div>
            {s.sub && <div className="text-[12px] text-rose-600">{s.sub}</div>}
          </Card>
        ))}
      </div>
      {d.mode === 'mock' && (
        <Card className="mb-3 flex items-start gap-2 p-3 text-sm text-amber-800 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <span>Test mode: messages are recorded in the log but <b>not delivered</b>. Connect a WhatsApp provider (WASender or Meta Cloud API) on the server to go live.</span>
        </Card>
      )}
      <div className="mb-3 overflow-x-auto"><Segmented value={tab} onChange={setTab} options={[{ value: 'settings', label: 'Settings' }, { value: 'preview', label: 'Preview & test' }, { value: 'log', label: 'Message log' }, { value: 'review', label: 'Under review' }]} /></div>
      {tab === 'settings' && <SettingsForm initial={{ ...DEFAULTS, ...(d.settings ?? {}), escalation: { ...DEFAULTS.escalation, ...(d.settings?.escalation ?? {}) } }} tz={d.timezone} withPhone={d.stats.withPhone} />}
      {tab === 'preview' && <PreviewTool />}
      {tab === 'log' && <Log />}
      {tab === 'review' && <Review />}
    </>
  );
}

function SettingsForm({ initial, tz, withPhone }: { initial: Settings; tz?: string; withPhone: number }) {
  const [s, setS] = useState<Settings>(initial);
  // Client-only stable keys for the follow-up time rows (kept in step with s.followupsAt).
  const fuSeq = useRef(0);
  const fuIds = useRef<number[]>([]);
  while (fuIds.current.length < s.followupsAt.length) fuIds.current.push(++fuSeq.current);
  fuIds.current.length = s.followupsAt.length;
  const [holiday, setHoliday] = useState('');
  const save = useSave(() => put('/org/whatsapp', s), [['org', 'whatsapp']], 'WhatsApp settings saved');
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setS({ ...s, [k]: v });
  const esc = (k: keyof Settings['escalation'], v: number | boolean) => setS({ ...s, escalation: { ...s.escalation, [k]: v } });
  return (
    <div className="space-y-2.5">
      <Card className="space-y-2.5 p-4">
        <label className="flex items-center gap-3">
          <input type="checkbox" className="size-5 accent-brand-600" checked={s.enabled} onChange={(e) => set('enabled', e.target.checked)} />
          <span><b>Send daily WhatsApp coaching</b><span className="block text-xs text-slate-500">{withPhone.toLocaleString()} people have a phone number on file. Add numbers under People or by import.</span></span>
        </label>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Language">{(id) => <Select id={id} value={s.language} onChange={(e) => set('language', e.target.value as Settings['language'])}><option value="english">English</option><option value="urdu">اردو Urdu</option><option value="bilingual">English + اردو</option></Select>}</Field>
          <Field label="Who receives it">{(id) => <Select id={id} value={s.audience} onChange={(e) => set('audience', e.target.value as Settings['audience'])}><option value="scored">Scored staff</option><option value="all">Everyone with a posting</option></Select>}</Field>
          <Field label="Opt-out">{(id) => <Select id={id} value={s.allowOptOut ? 'yes' : 'no'} onChange={(e) => set('allowOptOut', e.target.value === 'yes')}><option value="no">Required for all staff</option><option value="yes">Staff may reply STOP</option></Select>}</Field>
        </div>
      </Card>

      <SectionTitle>Daily schedule {tz && <span className="text-xs font-normal normal-case text-slate-400">· {tz}</span>}</SectionTitle>
      <Card className="space-y-2.5 p-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="☀️ Morning goals">{(id) => <Input id={id} type="time" value={s.morningAt} onChange={(e) => set('morningAt', e.target.value)} />}</Field>
          <Field label="⏰ Follow-ups">
            {() => (
              <div className="space-y-1.5">
                {s.followupsAt.map((f, i) => (
                  <div key={fuIds.current[i]} className="flex gap-1.5">
                    <Input type="time" value={f} onChange={(e) => set('followupsAt', s.followupsAt.map((x, j) => (j === i ? e.target.value : x)))} />
                    <Button type="button" variant="ghost" onClick={() => { fuIds.current.splice(i, 1); set('followupsAt', s.followupsAt.filter((_, j) => j !== i)); }}><Trash2 className="size-4" /></Button>
                  </div>
                ))}
                {s.followupsAt.length < 4 && <Button type="button" size="sm" variant="ghost" onClick={() => set('followupsAt', [...s.followupsAt, '16:00'])}><Plus className="size-4" />Follow-up</Button>}
              </div>
            )}
          </Field>
          <Field label="🌙 Evening summary">{(id) => <Input id={id} type="time" value={s.eveningAt} onChange={(e) => set('eveningAt', e.target.value)} />}</Field>
        </div>
        <Field label="Working days">
          {() => (
            <div className="flex flex-wrap gap-1.5">
              {DAYS.map((d, i) => (
                <button type="button" key={d} onClick={() => set('workdays', s.workdays.includes(i) ? s.workdays.filter((x) => x !== i) : [...s.workdays, i].sort())}
                  className={clsx('h-9 w-12 rounded-lg text-sm font-medium ring-1', s.workdays.includes(i) ? 'bg-brand-600 text-white ring-brand-600' : 'bg-white text-slate-600 ring-slate-200 dark:bg-slate-900 dark:ring-slate-700')}>{d}</button>
              ))}
            </div>
          )}
        </Field>
        <Field label="Holidays (no messages)">
          {() => (
            <div className="space-y-2">
              <div className="flex gap-2">
                <Input type="date" value={holiday} onChange={(e) => setHoliday(e.target.value)} />
                <Button type="button" variant="secondary" disabled={!holiday} onClick={() => { set('holidays', [...new Set([...s.holidays, holiday])].sort()); setHoliday(''); }}><Plus className="size-4" />Add</Button>
              </div>
              <div className="flex flex-wrap gap-1.5">{s.holidays.map((h) => <button type="button" key={h} onClick={() => set('holidays', s.holidays.filter((x) => x !== h))}><Badge>{h} ✕</Badge></button>)}</div>
            </div>
          )}
        </Field>
      </Card>

      <SectionTitle>Escalation for people falling behind</SectionTitle>
      <Card className="space-y-2.5 p-4">
        <label className="flex items-center gap-3">
          <input type="checkbox" className="size-5 accent-brand-600" checked={s.escalation.enabled} onChange={(e) => esc('enabled', e.target.checked)} />
          <b>Warn people who keep falling behind</b>
        </label>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Behind pace by more than (points)" hint="Achievement vs the share of the year gone">{(id) => <Input id={id} type="number" min={0} max={100} value={s.escalation.paceGap} onChange={(e) => esc('paceGap', Number(e.target.value))} />}</Field>
          <Field label="…or overdue tasks reach">{(id) => <Input id={id} type="number" min={1} max={50} value={s.escalation.overdueTasks} onChange={(e) => esc('overdueTasks', Number(e.target.value))} />}</Field>
          <Field label="Working days before review" hint={`Final warning after ${s.escalation.days * 2}`}>{(id) => <Input id={id} type="number" min={1} max={30} value={s.escalation.days} onChange={(e) => esc('days', Number(e.target.value))} />}</Field>
        </div>
        <ol className="space-y-1 rounded-lg bg-slate-50 p-3 text-xs text-slate-600 dark:bg-slate-800 dark:text-slate-300">
          <li><Badge tone={LEVEL_TONE[1]}>1</Badge> First behind day: a nudge in the evening summary.</li>
          <li><Badge tone={LEVEL_TONE[2]}>2</Badge> {s.escalation.days} working days in a row: "performance under review"{s.escalation.notifySupervisor ? ' — supervisor informed' : ''}.</li>
          <li><Badge tone={LEVEL_TONE[3]}>3</Badge> {s.escalation.days * 2} days: final warning that administrative / disciplinary proceedings may be initiated — supervisor and admins informed. Any action remains a human decision.</li>
          <li>One good day resets the count. Admins can also reset a person under "Under review".</li>
        </ol>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="size-4 accent-brand-600" checked={s.escalation.notifySupervisor} onChange={(e) => esc('notifySupervisor', e.target.checked)} />Inform the supervisor (WhatsApp + in-app)</label>
      </Card>

      <div className="sticky bottom-20 z-10 lg:bottom-3">
        <Card className="flex items-center gap-3 p-3 shadow-lg ring-2 ring-brand-100">
          <FormError error={save.error} />
          <div className="flex-1" />
          <Button loading={save.isPending} onClick={() => save.mutate(undefined)}><Save className="size-4" />Save</Button>
        </Card>
      </div>
    </div>
  );
}

function PersonPicker({ value, onChange }: { value: UserRow | null; onChange: (u: UserRow | null) => void }) {
  const [q, setQ] = useState('');
  const term = useDeferredValue(q);
  const users = useQuery({ queryKey: ['users', 'wa', term], queryFn: () => get<{ items: UserRow[] }>(`/users?search=${encodeURIComponent(term)}&limit=10&status=active`), enabled: !value && term.length > 1 });
  if (value) return (
    <Card className="flex items-center gap-3 p-3">
      <UserRound className="size-5 text-slate-400" />
      <div className="min-w-0 flex-1"><div className="font-medium">{value.name}</div><div className="truncate text-xs text-slate-500">{value.designation} {value.phone && `· ${value.phone}`}</div></div>
      <Button size="sm" variant="ghost" onClick={() => onChange(null)}>Change</Button>
    </Card>
  );
  return (
    <div className="space-y-1.5">
      <Input placeholder="Search a person…" value={q} onChange={(e) => setQ(e.target.value)} />
      {users.data?.items.map((u) => <button key={u._id} onClick={() => onChange(u)} className="block w-full rounded-lg px-3 py-2 text-left text-sm ring-1 ring-slate-200 hover:bg-brand-50 dark:ring-slate-700"><b>{u.name}</b> <span className="text-xs text-slate-500">{u.designation}</span></button>)}
    </div>
  );
}

/** WhatsApp-like bubble; *bold* and _italic_ rendered. */
function Bubble({ text, mine = false, meta }: { text: string; mine?: boolean; meta?: string }) {
  const html = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/\*([^*\n]+)\*/g, '<b>$1</b>').replace(/_([^_\n]+)_/g, '<i>$1</i>');
  return (
    <div className={clsx('flex', mine ? 'justify-end' : 'justify-start')}>
      <div className={clsx('max-w-[85%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-[14.5px] leading-snug shadow-sm', mine ? 'rounded-br-sm bg-[#d9fdd3] text-slate-900' : 'rounded-bl-sm bg-white text-slate-900')} dir="auto">
        <span dangerouslySetInnerHTML={{ __html: html }} />
        {meta && <div className="mt-1 text-right text-[11px] text-slate-500">{meta}</div>}
      </div>
    </div>
  );
}

function PreviewTool() {
  const qc = useQueryClient();
  const toast = useToast();
  const [who, setWho] = useState<UserRow | null>(null);
  const [slot, setSlot] = useState<'morning' | 'followup' | 'evening'>('morning');
  const [reply, setReply] = useState('STATUS');
  const preview = useQuery({ queryKey: ['org', 'whatsapp', 'preview', who?._id, slot], queryFn: () => get<{ text: string }>(`/org/whatsapp/preview?userId=${who!._id}&slot=${slot}`), enabled: !!who, retry: false });
  const thread = useQuery({ queryKey: ['org', 'whatsapp', 'thread', who?._id], queryFn: () => get<{ items: Msg[] }>(`/org/whatsapp/messages?userId=${who!._id}`), enabled: !!who, refetchInterval: 10_000, refetchIntervalInBackground: false });
  const send = async () => {
    const r = await post<{ queued: number }>('/org/whatsapp/send', { slot, userId: who!._id });
    toast(r.queued ? 'Sent' : 'Nothing sent (no phone number?)');
    qc.invalidateQueries({ queryKey: ['org', 'whatsapp'] });
  };
  const simulate = async () => {
    await post('/org/whatsapp/simulate', { userId: who!._id, text: reply });
    toast('Reply simulated — the answer appears below in a moment');
  };
  return (
    <div className="grid gap-3 lg:grid-cols-[minmax(0,22rem)_1fr]">
      <Card className="space-y-2.5 p-4">
        <Field label="Person">{() => <PersonPicker value={who} onChange={setWho} />}</Field>
        <Segmented value={slot} onChange={setSlot} options={[{ value: 'morning', label: 'Morning' }, { value: 'followup', label: 'Follow-up' }, { value: 'evening', label: 'Evening' }]} />
        <Button block disabled={!who} onClick={send}><Send className="size-4" />Send this now to {who?.name.split(' ')[0] ?? '…'}</Button>
        <div className="border-t border-slate-200 pt-3 dark:border-slate-700">
          <Field label="Simulate their reply" hint="STATUS · TASKS · DONE 1 · HELP">{(id) => <div className="flex gap-2"><Input id={id} value={reply} onChange={(e) => setReply(e.target.value)} /><Button variant="secondary" disabled={!who} onClick={simulate}><MessageCircle className="size-4" /></Button></div>}</Field>
        </div>
      </Card>
      <div className="space-y-2 rounded-2xl bg-[#efeae2] p-3 dark:bg-slate-800">
        {!who ? <div className="py-16 text-center text-sm text-slate-500">Choose a person to see exactly what they receive.</div> : (
          <>
            <div className="text-center text-[12px] text-slate-500">Preview — not sent</div>
            {preview.isLoading ? <Loading /> : preview.error ? <div className="text-center text-sm text-rose-700">{(preview.error as Error).message}</div> : <Bubble text={preview.data!.text} />}
            {!!thread.data?.items.length && <div className="pt-3 text-center text-[12px] text-slate-500">Conversation</div>}
            {thread.data?.items.slice().reverse().slice(-12).map((m) => (
              <Bubble key={m._id} text={m.text} mine={m.direction === 'in'} meta={`${new Date(m.createdAt).toLocaleString()} · ${m.kind}${m.direction === 'out' ? ` · ${m.status}` : ''}`} />
            ))}
          </>
        )}
      </div>
    </div>
  );
}

function Log() {
  const [kind, setKind] = useState('');
  const { data, isLoading } = useQuery({ queryKey: ['org', 'whatsapp', 'log', kind], queryFn: () => get<{ items: Msg[]; total: number }>(`/org/whatsapp/messages${kind ? `?kind=${kind}` : ''}`), refetchInterval: 10_000 });
  return (
    <>
      <div className="mb-2 flex items-center gap-2">
        <Select value={kind} onChange={(e) => setKind(e.target.value)} className="max-w-48">
          <option value="">All messages</option><option value="morning">Morning</option><option value="followup">Follow-up</option><option value="evening">Evening</option><option value="supervisor">Supervisor alerts</option><option value="inbound">Replies received</option><option value="reply">Answers sent</option>
        </Select>
        <span className="text-xs text-slate-500">{data?.total.toLocaleString() ?? 0} messages</span>
      </div>
      {isLoading ? <Loading /> : !data?.items.length ? <Card><Empty icon={MessageCircle} title="No messages yet" /></Card> : (
        <Card className="divide-y divide-slate-100 dark:divide-slate-800">
          {data.items.map((m) => (
            <div key={m._id} className="flex gap-3 px-3 py-2 text-sm">
              <div className="w-28 shrink-0 text-xs text-slate-500"><span className="font-semibold">{new Date(m.createdAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span></div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <b>{m.userId?.name ?? m.phone}</b>
                  <Badge>{m.direction === 'in' ? 'received' : m.kind}</Badge>
                  {m.direction === 'out' && <Badge tone={m.status === 'sent' ? 'bg-emerald-100 text-emerald-800' : m.status === 'failed' ? 'bg-rose-100 text-rose-800' : undefined}>{m.status}</Badge>}
                </div>
                <div className="line-clamp-2 text-xs text-slate-600 dark:text-slate-300">{m.text}</div>
                {m.error && <div className="text-xs text-rose-600">{m.error}</div>}
              </div>
            </div>
          ))}
        </Card>
      )}
    </>
  );
}

interface Leave { _id: string; leaveFrom: string; leaveUntil: string; leaveNote?: string; userId: { _id: string; name: string; designation?: string } | null; leaveSetBy?: { name: string } }

function Review() {
  const { data, isLoading } = useQuery({ queryKey: ['org', 'whatsapp', 'esc'], queryFn: () => get<Esc[]>('/org/whatsapp/escalations') });
  const leave = useQuery({ queryKey: ['org', 'whatsapp', 'leave'], queryFn: () => get<Leave[]>('/org/whatsapp/leave') });
  const withdraw = useSave((v: { id: string; reason: string }) => post(`/org/whatsapp/escalations/${v.id}/reset`, { reason: v.reason, inform: true }), [['org', 'whatsapp']], 'Warning withdrawn — the person has been informed');
  const endLeave = useSave((id: string) => del(`/org/whatsapp/leave/${id}`), [['org', 'whatsapp']], 'Leave removed');
  const [who, setWho] = useState<UserRow | null>(null);
  const today = new Date().toISOString().slice(0, 10);
  const [from, setFrom] = useState(today);
  const [until, setUntil] = useState(today);
  const [note, setNote] = useState('');
  const markLeave = useSave(() => put(`/org/whatsapp/leave/${who!._id}`, { from, until, note: note || undefined }), [['org', 'whatsapp']], 'Marked on leave — no messages or warnings for that period', () => { setWho(null); setNote(''); });

  return (
    <div className="space-y-2.5">
      <div>
        <SectionTitle>Under review</SectionTitle>
        {isLoading ? <Loading /> : !data?.length ? <Card><Empty title="Nobody is behind" body="People who fall behind appear here with their level and the reason." /></Card> : (
          <Card className="divide-y divide-slate-100 dark:divide-slate-800">
            {data.map((e) => (
              <div key={e._id} className="flex flex-wrap items-start gap-3 px-3 py-2 text-sm">
                <Badge tone={LEVEL_TONE[e.level]}>{LEVEL[e.level]}</Badge>
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{e.userId?.name} <span className="text-xs font-normal text-slate-500">{e.userId?.designation}</span></div>
                  <div className="text-xs text-slate-500">{e.behindDays} consecutive working day{e.behindDays === 1 ? '' : 's'} behind · last {e.lastDay}</div>
                  {e.lastReason && <div className="text-xs text-slate-600 dark:text-slate-300">{e.lastReason}</div>}
                </div>
                <div className="flex gap-1">
                  <Button size="sm" variant="secondary" onClick={() => { if (!e.userId) return; const reason = prompt(`Reason for withdrawing ${e.userId.name}'s warning (e.g. on approved leave):`); if (reason !== null) withdraw.mutate({ id: e.userId._id, reason }); }}>
                    <RotateCcw className="size-4" />Withdraw warning
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => e.userId && setWho({ _id: e.userId._id, name: e.userId.name, designation: e.userId.designation })}>On leave…</Button>
                </div>
              </div>
            ))}
          </Card>
        )}
      </div>

      <div>
        <SectionTitle>On leave</SectionTitle>
        <Card className="space-y-2.5 p-4">
          <p className="text-xs text-slate-500">People on leave receive no WhatsApp messages and their days do not count towards warnings. Marking leave also withdraws any current warning, and the person is informed.</p>
          <div className="grid gap-3 lg:grid-cols-[minmax(0,1.4fr)_repeat(2,minmax(0,0.7fr))_minmax(0,1fr)_auto] lg:items-end">
            <Field label="Person">{() => <PersonPicker value={who} onChange={setWho} />}</Field>
            <Field label="From">{(id) => <Input id={id} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />}</Field>
            <Field label="Until">{(id) => <Input id={id} type="date" value={until} min={from} onChange={(e) => setUntil(e.target.value)} />}</Field>
            <Field label="Note">{(id) => <Input id={id} placeholder="e.g. Earned leave" value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
            <Button disabled={!who} loading={markLeave.isPending} onClick={() => markLeave.mutate(undefined)}>Mark on leave</Button>
          </div>
          {!!leave.data?.length && (
            <div className="divide-y divide-slate-100 rounded-lg ring-1 ring-slate-200 dark:divide-slate-800 dark:ring-slate-700">
              {leave.data.map((l) => (
                <div key={l._id} className="flex items-center gap-3 px-3 py-2 text-sm">
                  <div className="min-w-0 flex-1">
                    <b>{l.userId?.name}</b> <span className="text-xs text-slate-500">{l.userId?.designation}</span>
                    <div className="text-xs text-slate-500">{l.leaveFrom} → {l.leaveUntil}{l.leaveNote && ` · ${l.leaveNote}`}{l.leaveSetBy && ` · by ${l.leaveSetBy.name}`}</div>
                  </div>
                  {l.leaveFrom <= today && <Badge tone="bg-sky-100 text-sky-800">On leave now</Badge>}
                  <Button size="sm" variant="ghost" onClick={() => l.userId && confirm(`End leave for ${l.userId.name}?`) && endLeave.mutate(l.userId._id)}><Trash2 className="size-4" /></Button>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

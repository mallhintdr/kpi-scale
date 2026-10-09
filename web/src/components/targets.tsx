import { useMutation, useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { CalendarClock, CheckCircle2, Hourglass, OctagonX, Plus, Search, XCircle } from 'lucide-react';
import { useDeferredValue, useState, type FormEvent } from 'react';
import { ApiError, get, post } from '../lib/api';
import { fmtDate, toDateInput } from '../lib/format';
import { fmtFull, fmtPKR, MILLIONS, parentLevels, symCaption, T, useMeta, type UnitRef } from '../lib/rev';
import { useSave } from '../pages/admin/shared';
import { Bullet } from './charts';
import { UnitField } from './rev';
import { Button, Field, FormError, Input, Loading, Segmented, Select, Sheet, Textarea } from './ui';

export type TState = 'running' | 'achieved' | 'missed' | 'upcoming' | 'cancelled' | 'stopped';
export interface AssignedTarget {
  _id: string; head: string; headName: string; money: boolean; period: 'week' | 'fortnight' | 'month';
  startDate: string; endDate: string; targetValue: number; achieved: number; achievedPending: number; note?: string;
  pct: number; elapsed: number; state: TState; daysLeft: number; driveId?: string | null; remainingAtAssign?: number;
  assigneeId: { _id: string; name: string; designation?: string };
  assignedBy: { _id: string; name: string; designation?: string };
  unitId: { _id: string; name: string };
  progress: { _id: string; date: string; value: number; note?: string; status: 'submitted' | 'verified' | 'rejected' }[];
}

export const PERIOD_LABEL = { week: '1 week', fortnight: '15 days', month: '1 month' } as const;
const STATE: Record<TState, { label: string; tone: string; icon: typeof CheckCircle2 }> = {
  running: { label: 'Running', tone: 'bg-sky-50 text-sky-800 ring-sky-200', icon: CalendarClock },
  achieved: { label: 'Achieved', tone: 'bg-emerald-50 text-emerald-800 ring-emerald-200', icon: CheckCircle2 },
  missed: { label: 'Missed', tone: 'bg-rose-50 text-rose-800 ring-rose-200', icon: XCircle },
  upcoming: { label: 'Starts soon', tone: 'bg-slate-50 text-slate-700 ring-slate-200', icon: CalendarClock },
  cancelled: { label: 'Withdrawn', tone: 'bg-slate-50 text-slate-500 ring-slate-200', icon: XCircle },
  stopped: { label: 'Stopped', tone: 'bg-amber-50 text-amber-800 ring-amber-200', icon: OctagonX },
};

export const StateChip = ({ state }: { state: TState }) => {
  const s = STATE[state];
  return <span className={clsx('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ring-inset', s.tone)}><s.icon className="size-3" />{s.label}</span>;
};

/** One assigned target: verified figures on top, bar with time-pace tick, pending (unverified) shown separately. */
export function TargetCard({ t, viewer, compact }: { t: AssignedTarget; viewer: string; compact?: boolean }) {
  const [logging, setLogging] = useState(false);
  const fmt = (v: number) => (t.money ? fmtPKR(v) : v.toLocaleString());
  const mine = t.assigneeId._id === viewer;
  const assignedByMe = t.assignedBy._id === viewer;
  const open = t.state === 'running' || t.state === 'upcoming';
  const withdraw = useSave(() => post(`/rev/assigned/${t._id}/cancel`), [['rev']], 'Target withdrawn');
  return (
    <div className="flex h-full flex-col rounded-xl bg-white p-3 ring-1 ring-slate-200/80 dark:bg-slate-900 dark:ring-slate-800">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-slate-800 dark:text-slate-100">{t.headName}</div>
          <div className="truncate text-[11px] text-slate-500">
            {mine ? `From ${t.assignedBy.name}` : `To ${t.assigneeId.name}`} · {t.unitId?.name?.replace(' (test)', '')}
            {t.driveId && <span className="ml-1 rounded bg-brand-50 px-1 font-semibold text-brand-700">Area share</span>}
          </div>
        </div>
        <span className="shrink-0 text-lg font-bold text-slate-900 tabular-nums dark:text-white">{Math.round(t.pct)}%</span>
      </div>
      <div className="mt-2 grid grid-cols-3 divide-x divide-slate-100 rounded-lg bg-slate-50 py-1.5 text-center dark:divide-slate-800 dark:bg-slate-800/50">
        {[['Target', t.targetValue], ['Verified', t.achieved], ['Balance', Math.max(0, t.targetValue - t.achieved)]].map(([l, v]) => (
          <div key={l as string} className="px-1">
            <div className="text-[10px] font-medium uppercase tracking-wide text-slate-500">{l}</div>
            <div className={clsx('font-bold text-slate-900 tabular-nums dark:text-white', compact ? 'text-sm' : 'text-base')}>{fmt(v as number)}</div>
          </div>
        ))}
      </div>
      <div className="mt-2"><Bullet value={t.pct} pace={open ? t.elapsed : null} height={7} /></div>
      {t.achievedPending > 0 && (
        <div className="mt-1 flex items-center gap-1 text-[11px] font-medium text-amber-700"><Hourglass className="size-3" />Awaiting verification {fmt(t.achievedPending)}</div>
      )}
      <div className="mt-1.5 flex flex-wrap items-center justify-between gap-1.5 text-[11px] text-slate-500">
        <span className="flex items-center gap-1.5"><StateChip state={t.state} /><span>{PERIOD_LABEL[t.period]}</span></span>
        <span className="tabular-nums">{fmtDate(t.startDate)} – {fmtDate(t.endDate)}{t.state === 'running' && <b className="ml-1 text-slate-700 dark:text-slate-200">· {t.daysLeft}d left</b>}</span>
      </div>
      {t.remainingAtAssign != null && <div className="mt-1 text-[11px] text-slate-400 tabular-nums">Share of remaining balance {fmt(t.remainingAtAssign)}</div>}
      <div className="mt-auto pt-2 text-center text-[10px] font-medium text-slate-400">{t.money ? MILLIONS : '(Cases)'}</div>
      {(mine || assignedByMe) && open && (
        <div className="mt-2 flex gap-2">
          <Button size="sm" variant="secondary" className="flex-1" onClick={() => setLogging(true)}><Plus className="size-4" />Log progress</Button>
          {assignedByMe && !t.driveId && <Button size="sm" variant="ghost" loading={withdraw.isPending} onClick={() => confirm('Withdraw this target?') && withdraw.mutate(undefined)}>Withdraw</Button>}
        </div>
      )}
      {logging && <ProgressSheet t={t} onClose={() => setLogging(false)} />}
    </div>
  );
}

const PSTATUS = { submitted: 'text-amber-700', verified: 'text-emerald-700', rejected: 'text-rose-700 line-through' } as const;

function ProgressSheet({ t, onClose }: { t: AssignedTarget; onClose: () => void }) {
  const today = toDateInput();
  const maxDate = t.endDate.slice(0, 10) < today ? t.endDate.slice(0, 10) : today;
  const [f, setF] = useState({ value: '', date: maxDate, note: '' });
  const save = useSave(() => post(`/rev/assigned/${t._id}/progress`, { value: Number(f.value), date: f.date, note: f.note || undefined }), [['rev']], 'Progress logged — awaiting verification', onClose);
  const submit = (e: FormEvent) => { e.preventDefault(); save.mutate(undefined); };
  return (
    <Sheet open onClose={onClose} title={`Log progress · ${t.headName}`} footer={<Button form="prog-form" type="submit" block loading={save.isPending}>Save</Button>}>
      <form id="prog-form" onSubmit={submit} className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label={t.money ? `Amount ${T.achieved.toLowerCase()} ${symCaption()}` : `${T.items[0].toUpperCase()}${T.items.slice(1)} ${T.disposed.toLowerCase()}`}>{(id) => <Input id={id} type="number" inputMode="decimal" min={1} required autoFocus value={f.value} onChange={(e) => setF({ ...f, value: e.target.value })} />}</Field>
          <Field label="Date">{(id) => <Input id={id} type="date" required min={t.startDate.slice(0, 10)} max={maxDate} value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} />}</Field>
        </div>
        <Field label={`Note / ${T.reference.toLowerCase()} (optional)`}>{(id) => <Textarea id={id} rows={2} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />}</Field>
        <p className="text-xs text-slate-500">Progress counts once verified by the verifier of this KPI.</p>
        {t.progress.length > 0 && (
          <div>
            <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Logged so far</div>
            <div className="divide-y divide-slate-100 rounded-lg ring-1 ring-slate-200 dark:divide-slate-800 dark:ring-slate-700">
              {t.progress.slice().reverse().map((p) => (
                <div key={p._id} className="flex items-center justify-between gap-2 px-3 py-1.5 text-sm tabular-nums">
                  <span>{fmtDate(p.date)}{p.note && <span className="ml-1 text-xs text-slate-500">· {p.note}</span>}</span>
                  <span className="flex items-center gap-2">
                    <span className={clsx('text-[11px] font-semibold capitalize', PSTATUS[p.status ?? 'submitted'])}>{p.status ?? 'submitted'}</span>
                    <b>{t.money ? fmtFull(p.value) : p.value}</b>
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
        <FormError error={save.error} />
      </form>
    </Sheet>
  );
}

interface Assignee { userId: string; name: string; post: string; postLabel: string; unitId: string; unitName: string }
interface DrivePlan {
  head: { code: string; name: string; money: boolean }; remainingTotal: number; targetTotal: number; startDate: string; endDate: string;
  rows: { unitId: string; circle: string; patwari: string; remaining: number; share: number; pctOfRemaining: number }[];
  vacant: { circle: string; remaining: number }[]; zeroBalance: number;
}

/** Assign a target: to an area (distributed to circles by remaining balance) or to one subordinate. */
export function AssignTargetSheet({ onClose, defaultMode = 'area' }: { onClose: () => void; defaultMode?: 'area' | 'individual' }) {
  const [mode, setMode] = useState<'area' | 'individual'>(defaultMode);
  return (
    <Sheet open onClose={onClose} title="Assign a target">
      <Segmented value={mode} onChange={setMode} options={[{ value: 'area', label: 'Area (proportional)' }, { value: 'individual', label: 'One officer' }]} />
      {mode === 'area' ? <AreaForm onDone={onClose} /> : <IndividualForm onDone={onClose} />}
    </Sheet>
  );
}

function CommonFields({ f, setF, circleOnly }: { f: any; setF: (v: any) => void; circleOnly?: boolean }) {
  const { data: meta } = useMeta();
  const heads = (meta?.heads ?? []).filter((h) => !circleOnly || !h.perHolder);
  const days = { week: 7, fortnight: 15, month: 30 }[f.period as 'week'];
  const end = new Date(new Date(f.startDate).getTime() + (days - 1) * 86_400_000);
  return (
    <>
      <Field label="KPI">
        {(id) => (
          <Select id={id} value={f.head} onChange={(e) => setF({ ...f, head: e.target.value })}>
            <optgroup label={T.money}>{heads.filter((h) => h.kind === 'revenue').map((h) => <option key={h.code} value={h.code}>{h.name}</option>)}</optgroup>
            <optgroup label={T.flowGroup}>{heads.filter((h) => h.kind === 'case').map((h) => <option key={h.code} value={h.code}>{h.name}</option>)}</optgroup>
          </Select>
        )}
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Duration">
          {(id) => (
            <Select id={id} value={f.period} onChange={(e) => setF({ ...f, period: e.target.value })}>
              <option value="week">1 week</option><option value="fortnight">15 days</option><option value="month">1 month</option>
            </Select>
          )}
        </Field>
        <Field label="Starts">{(id) => <Input id={id} type="date" required value={f.startDate} onChange={(e) => setF({ ...f, startDate: e.target.value })} />}</Field>
      </div>
      <p className="-mt-2 text-xs text-slate-500">Ends {end.toDateString()}</p>
    </>
  );
}

function AreaForm({ onDone }: { onDone: () => void }) {
  const { data: meta } = useMeta();
  const [area, setArea] = useState<UnitRef | null>(null);
  const [f, setF] = useState({ head: 'WR_KHARIF', period: 'fortnight', startDate: toDateInput(), basis: 'percent', value: '20', includeArrears: true, note: '' });
  const head = meta?.heads.find((h) => h.code === f.head);
  const body = () => ({ ...f, unitId: area?._id, value: Number(f.value), note: f.note || undefined });
  const preview = useMutation({ mutationFn: () => post<DrivePlan>('/rev/assigned/drive/preview', body()) });
  // A drive for this head already running in an overlapping area must be stopped first
  const conflict = preview.error instanceof ApiError && preview.error.code === 'DRIVE_RUNNING'
    ? (preview.error.body?.error?.details as { driveId: string; unit: string; assignedBy: string; endDate: string; canStop: boolean })
    : null;
  const stopAndRetry = useMutation({
    mutationFn: () => post(`/rev/assigned/drives/${conflict!.driveId}/stop`),
    onSuccess: () => preview.mutate(),
  });
  const create = useSave(() => post('/rev/assigned/drive', body()), [['rev']], 'Area target distributed', onDone);
  const set = (v: typeof f) => { setF(v); preview.reset(); };
  const plan = preview.data;
  const fmt = (v: number) => (plan?.head.money ? fmtPKR(v) : v.toLocaleString());

  return (
    <div className="space-y-4">
      <Field label="Area">{() => <UnitField value={area} onChange={(u) => { setArea(u); preview.reset(); }} accept={parentLevels()} scope="work" placeholder="Choose an area" />}</Field>
      <CommonFields f={f} setF={set} circleOnly />
      <div className="grid grid-cols-2 gap-3">
        <Field label="Target as">
          {(id) => (
            <Select id={id} value={f.basis} onChange={(e) => set({ ...f, basis: e.target.value })}>
              <option value="percent">% of remaining balance</option>
              <option value="amount">{head?.unit !== 'money' ? `Total ${T.items}` : `Total amount ${symCaption()}`}</option>
            </Select>
          )}
        </Field>
        <Field label={f.basis === 'percent' ? 'Percent' : head?.unit !== 'money' ? 'Number' : `Amount ${symCaption()}`}>
          {(id) => <Input id={id} type="number" inputMode="decimal" min={0.1} max={f.basis === 'percent' ? 100 : undefined} step="any" required value={f.value} onChange={(e) => set({ ...f, value: e.target.value })} />}
        </Field>
      </div>
      {head?.kind === 'revenue' && (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" className="size-4 accent-brand-600" checked={f.includeArrears} onChange={(e) => set({ ...f, includeArrears: e.target.checked })} />
          Include arrears in the remaining balance
        </label>
      )}
      <Field label="Instructions (optional)">{(id) => <Textarea id={id} rows={2} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />}</Field>
      {conflict ? (
        <div className="space-y-2 rounded-xl bg-amber-50 p-3 text-sm ring-1 ring-amber-200 dark:bg-amber-500/10 dark:ring-amber-500/30">
          <div className="flex items-start gap-2 font-medium text-amber-900 dark:text-amber-200">
            <OctagonX className="mt-0.5 size-4 shrink-0" />
            <span>A drive for this KPI is already running in {conflict.unit?.replace(' (test)', '')} (set by {conflict.assignedBy}, until {new Date(conflict.endDate).toDateString()}).</span>
          </div>
          <p className="text-xs text-amber-800 dark:text-amber-300">Only one drive per KPI can run at a time. Stopping it closes it today — each officer is judged on the part of their share due by today — and this drive then starts from the remaining balance.</p>
          {conflict.canStop ? (
            <Button block variant="danger" loading={stopAndRetry.isPending} onClick={() => confirm('Stop the running drive and start this one?') && stopAndRetry.mutate()}>Stop it and start this one</Button>
          ) : (
            <p className="text-xs font-medium text-amber-900">Ask {conflict.assignedBy} or a senior officer over that area to stop it.</p>
          )}
          <FormError error={stopAndRetry.error} />
        </div>
      ) : (
        <FormError error={preview.error ?? create.error} />
      )}

      {!plan ? (
        <Button block variant="secondary" disabled={!area || !f.value} loading={preview.isPending} onClick={() => preview.mutate()}>Preview distribution</Button>
      ) : (
        <div className="space-y-3">
          <div className="grid grid-cols-3 divide-x divide-slate-200 rounded-lg bg-slate-50 py-2 text-center dark:divide-slate-700 dark:bg-slate-800">
            <div><div className="text-[10px] font-medium uppercase text-slate-500">Remaining</div><div className="font-bold tabular-nums">{fmt(plan.remainingTotal)}</div></div>
            <div><div className="text-[10px] font-medium uppercase text-slate-500">Target</div><div className="font-bold tabular-nums">{fmt(plan.targetTotal)}</div></div>
            <div><div className="text-[10px] font-medium uppercase text-slate-500">Circles</div><div className="font-bold tabular-nums">{plan.rows.length}</div></div>
          </div>
          <div className="max-h-72 overflow-auto rounded-lg ring-1 ring-slate-300 dark:ring-slate-600">
            <table className="w-full border-separate border-spacing-0 text-[12px]">
              <thead className="sticky top-0 bg-brand-700 text-center text-[11.5px] font-semibold uppercase tracking-wide text-white">
                <tr>
                  <th className="w-8 border-r border-white/50 px-1 py-2 text-center">#</th>
                  <th className="border-r border-white/50 px-2 py-2 text-left">Unit · Officer</th>
                  <th className="border-r border-white/50 px-2 py-2 text-right">Remaining</th>
                  <th className="px-2 py-2 text-right">Share</th>
                </tr>
              </thead>
              <tbody>
                {plan.rows.map((r, i) => (
                  <tr key={r.unitId}>
                    <td className="border-b border-r border-b-slate-200 border-r-slate-400 text-center text-slate-500 tabular-nums">{i + 1}</td>
                    <td className="border-b border-r border-b-slate-200 border-r-slate-400 px-2 py-1"><div className="font-medium">{r.circle.replace(' (test)', '')}</div><div className="text-[11px] text-slate-500">{r.patwari}</div></td>
                    <td className="border-b border-r border-b-slate-200 border-r-slate-400 px-2 py-1 text-right tabular-nums">{fmt(r.remaining)}</td>
                    <td className="border-b border-b-slate-200 px-2 py-1 text-right font-semibold tabular-nums">{fmt(r.share)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-[11px] text-slate-500">
            Each unit gets the same share of its own remaining balance{f.basis === 'percent' ? ` (${f.value}%)` : ''} — larger balances carry larger targets.
            {plan.vacant.length > 0 && <> {plan.vacant.length} vacant unit(s) skipped.</>}
            {plan.zeroBalance > 0 && <> {plan.zeroBalance} unit(s) with no balance skipped.</>}
            {plan.head.money && <> Amounts {MILLIONS}.</>}
          </p>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => preview.reset()}>Edit</Button>
            <Button className="flex-1" loading={create.isPending} onClick={() => create.mutate(undefined)}>Assign to {plan.rows.length} circles</Button>
          </div>
        </div>
      )}
    </div>
  );
}

function IndividualForm({ onDone }: { onDone: () => void }) {
  const { data: meta } = useMeta();
  const [search, setSearch] = useState('');
  const term = useDeferredValue(search);
  const { data: people = [], isLoading } = useQuery({ queryKey: ['rev', 'assignees', term], queryFn: () => get<Assignee[]>(`/rev/tasks/assignees?search=${encodeURIComponent(term)}`) });
  const scored = people.filter((p) => !['wasilbaqi', 'sci'].includes(p.post));
  const [who, setWho] = useState<Assignee | null>(null);
  const [f, setF] = useState({ head: 'WR_KHARIF', period: 'week', startDate: toDateInput(), targetValue: '', note: '' });
  const head = meta?.heads.find((h) => h.code === f.head);
  const save = useSave(
    () => post('/rev/assigned', { ...f, targetValue: Number(f.targetValue), note: f.note || undefined, assigneeId: who!.userId, unitId: who!.unitId }),
    [['rev']], 'Target assigned', onDone,
  );
  const submit = (e: FormEvent) => { e.preventDefault(); save.mutate(undefined); };
  return (
    <form onSubmit={submit} className="space-y-4">
      {who ? (
        <div className="flex items-center gap-3 rounded-xl p-3 ring-1 ring-slate-200 dark:ring-slate-700">
          <div className="min-w-0 flex-1"><div className="font-medium">{who.name}</div><div className="text-xs text-slate-500">{who.postLabel} · {who.unitName}</div></div>
          <Button type="button" size="sm" variant="ghost" onClick={() => setWho(null)}>Change</Button>
        </div>
      ) : (
        <div className="space-y-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
            <Input placeholder="Search subordinate or unit" value={search} onChange={(e) => setSearch(e.target.value)} className="pl-9" />
          </div>
          <div className="max-h-56 divide-y divide-slate-100 overflow-y-auto rounded-xl ring-1 ring-slate-200 dark:divide-slate-800 dark:ring-slate-700">
            {isLoading ? <div className="p-3"><Loading /></div> : scored.length ? scored.map((p) => (
              <button type="button" key={`${p.userId}${p.unitId}`} onClick={() => setWho(p)} className="block w-full px-3 py-2 text-left hover:bg-slate-50 dark:hover:bg-slate-800">
                <div className="truncate text-sm font-medium">{p.name}</div>
                <div className="truncate text-xs text-slate-500">{p.postLabel} · {p.unitName}</div>
              </button>
            )) : <div className="p-3 text-sm text-slate-500">No subordinates found</div>}
          </div>
        </div>
      )}
      <CommonFields f={f} setF={setF} />
      <Field label={head?.unit !== 'money' ? `Target (${T.items})` : `Target amount ${symCaption()}`}>
        {(id) => <Input id={id} type="number" inputMode="decimal" min={1} required value={f.targetValue} onChange={(e) => setF({ ...f, targetValue: e.target.value })} />}
      </Field>
      <Field label="Instructions (optional)">{(id) => <Textarea id={id} rows={2} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />}</Field>
      <FormError error={save.error} />
      <Button type="submit" block disabled={!who} loading={save.isPending}>Assign target</Button>
    </form>
  );
}

export const useAssigned = (box: 'mine' | 'assigned' | 'unit', unitId?: string, state: 'open' | 'closed' | 'all' = 'all', driveId?: string) =>
  useQuery({
    queryKey: ['rev', 'assigned', box, unitId, state, driveId],
    queryFn: () => get<AssignedTarget[]>(`/rev/assigned?box=${box}&state=${state}${unitId ? `&unitId=${unitId}` : ''}${driveId ? `&driveId=${driveId}` : ''}`),
    enabled: box !== 'unit' || !!unitId || !!driveId,
  });

interface TSum { user: { _id: string; name: string }; unitId: string; targets: number; met: number; running: number; missed: number; pct: number }
/** Targets mode: assigned-target achievement per officer per charge (null = no targets in the period). */
export function useTargetSummary(unitId: string | undefined, post: string, fy: string, enabled: boolean) {
  const { data } = useQuery({
    queryKey: ['rev', 'assigned-summary', unitId, post, fy],
    queryFn: () => get<{ items: TSum[] }>(`/rev/assigned/summary?unitId=${unitId}&post=${post}&fy=${fy}`),
    enabled: enabled && !!unitId && !!fy,
  });
  // keyed per officer per charge unit, matching the per-charge league rows
  return new Map((data?.items ?? []).map((i) => [`${i.user._id}|${i.unitId}`, i]));
}

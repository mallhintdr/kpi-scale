import { CalendarClock, CheckCircle2, Gauge, Plus, Target as TargetIcon, Timer, XCircle } from 'lucide-react';
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { PageHeader } from '../components/AppShell';
import { AssignTargetSheet, TargetCard, type AssignedTarget } from '../components/targets';
import { Button, Card, Empty, ErrorState, Loading, Segmented } from '../components/ui';
import { useMe } from '../lib/auth';
import { useCaps } from '../lib/rev';
import { useAssigned } from '../components/targets';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown } from 'lucide-react';
import { get, post } from '../lib/api';
import { MILLIONS, fmtPKR } from '../lib/rev';
import { fmtDate } from '../lib/format';
import { Bullet } from '../components/charts';
import { PERIOD_LABEL, StateChip, type TState } from '../components/targets';
import { useSave } from './admin/shared';

/** Summary strip: how many targets, average achievement, achieved / running / missed. */
export function TargetSummary({ items }: { items: AssignedTarget[] }) {
  const counted = items.filter((t) => t.state !== 'upcoming' && t.state !== 'cancelled');
  const avg = counted.length ? counted.reduce((s, t) => s + t.pct, 0) / counted.length : null;
  const n = (s: AssignedTarget['state']) => items.filter((t) => t.state === s).length;
  // Each tile: solid accent bar + tinted background + icon, colour carries the meaning
  const tiles = [
    { l: 'Achievement', v: avg == null ? '—' : `${Math.round(avg)}%`, Icon: Gauge, c: 'from-brand-50 to-white ring-1 ring-brand-200 dark:from-brand-500/15 dark:to-slate-900 dark:ring-brand-500/30', ic: 'bg-brand-100 text-brand-700 dark:bg-brand-500/20 dark:text-brand-200', lc: 'text-brand-700 dark:text-brand-300' },
    { l: 'Targets', v: counted.length, Icon: TargetIcon, c: 'from-slate-50 to-white ring-1 ring-slate-200 dark:from-slate-800 dark:to-slate-900 dark:ring-slate-700', ic: 'bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-200', lc: 'text-slate-500' },
    { l: 'Achieved', v: n('achieved'), Icon: CheckCircle2, c: 'from-emerald-50 to-white ring-1 ring-emerald-200 dark:from-emerald-500/15 dark:to-slate-900 dark:ring-emerald-500/30', ic: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300', lc: 'text-emerald-700 dark:text-emerald-300' },
    { l: 'Running', v: n('running'), Icon: Timer, c: 'from-sky-50 to-white ring-1 ring-sky-200 dark:from-sky-500/15 dark:to-slate-900 dark:ring-sky-500/30', ic: 'bg-sky-100 text-sky-700 dark:bg-sky-500/20 dark:text-sky-300', lc: 'text-sky-700 dark:text-sky-300' },
    { l: 'Missed', v: n('missed'), Icon: XCircle, c: 'from-rose-50 to-white ring-1 ring-rose-200 dark:from-rose-500/15 dark:to-slate-900 dark:ring-rose-500/30', ic: 'bg-rose-100 text-rose-700 dark:bg-rose-500/20 dark:text-rose-300', lc: 'text-rose-700 dark:text-rose-300' },
  ];
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
      {tiles.map((t, i) => (
        <div key={t.l} className={`flex items-center gap-2.5 rounded-xl bg-gradient-to-br p-3 shadow-sm ${t.c} ${i === 0 ? 'col-span-2 sm:col-span-1' : ''}`}>
          <span className={`grid size-9 shrink-0 place-items-center rounded-lg ${t.ic}`}><t.Icon className="size-5" /></span>
          <div className="min-w-0">
            <div className={`text-xl font-bold tabular-nums leading-tight text-slate-900 dark:text-white`}>{t.v}</div>
            <div className={`text-[11px] font-semibold uppercase tracking-wide ${t.lc}`}>{t.l}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

export default function Assigned() {
  const { user } = useMe();
  const caps = useCaps();
  const [params, setParams] = useSearchParams();
  const box = (params.get('box') as 'mine' | 'assigned' | 'drives') ?? 'mine';
  const [state, setState] = useState<'open' | 'closed' | 'all'>('open');
  const [creating, setCreating] = useState(false);
  const { data, isLoading, error, refetch } = useAssigned(box === 'drives' ? 'assigned' : box, undefined, state);
  const canAssign = caps.isOfficer;

  return (
    <>
      <PageHeader
        title="Assigned targets"
        subtitle="Short-term targets for a head · 1 week, 15 days or 1 month"
        actions={canAssign && <Button size="sm" onClick={() => setCreating(true)}><Plus className="size-4" />Assign target</Button>}
      />
      <div className="mb-3 grid gap-2 sm:grid-cols-2">
        {canAssign && (
          <Segmented value={box} onChange={(b) => setParams({ box: b }, { replace: true })} options={[{ value: 'mine', label: 'To me' }, { value: 'drives', label: 'Area drives' }, { value: 'assigned', label: 'Individual' }]} />
        )}
        <Segmented value={state} onChange={setState} options={[{ value: 'open', label: 'Current' }, { value: 'closed', label: 'Ended' }, { value: 'all', label: 'All' }]} />
      </div>
      {box === 'drives' ? <Drives viewer={user.id} /> : isLoading ? <Loading /> : error ? <ErrorState error={error} retry={refetch} /> : !data?.length ? (
        <Card><Empty icon={state === 'open' ? CalendarClock : TargetIcon} title={box === 'mine' ? 'No targets assigned to you' : 'You have not assigned any targets'} body={canAssign && box === 'assigned' ? 'Use “Assign target” to set a weekly, 15-day or monthly target for a subordinate.' : undefined} /></Card>
      ) : (
        <>
          <TargetSummary items={data} />
          <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {data.map((t) => <TargetCard key={t._id} t={t} viewer={user.id} />)}
          </div>
        </>
      )}
      {creating && <AssignTargetSheet onClose={() => setCreating(false)} />}
    </>
  );
}

interface Drive {
  _id: string; head: string; headName: string; money: boolean; period: 'week' | 'fortnight' | 'month'; startDate: string; endDate: string;
  basis: 'percent' | 'amount'; value: number; includeArrears: boolean; remainingTotal: number; targetTotal: number; shares: number; vacantCircles: number;
  achieved: number; pending: number; met: number; pct: number; elapsed: number; state: TState; daysLeft: number;
  dueTotal: number; canStop: boolean; stoppedAt?: string;
  unitId: { _id: string; name: string; type: string };
}

/** Area drives set by me: aggregate progress (verified, capped per circle) and the per-circle shares. */
function Drives({ viewer }: { viewer: string }) {
  const { data, isLoading } = useQuery({ queryKey: ['rev', 'drives'], queryFn: () => get<Drive[]>('/rev/assigned/drives') });
  const [open, setOpen] = useState<string | null>(null);
  if (isLoading) return <Loading />;
  if (!data?.length) return <Card><Empty icon={TargetIcon} title="No area drives yet" body="Use “Assign target → Area (proportional)” to distribute a target across circles by their remaining balance." /></Card>;
  return (
    <div className="space-y-2">
      {data.map((d) => {
        const fmt = (v: number) => (d.money ? fmtPKR(v) : v.toLocaleString());
        return (
          <Card key={d._id} className="overflow-hidden">
            <button className="w-full p-3 text-left" onClick={() => setOpen(open === d._id ? null : d._id)}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold">{d.headName} · {d.unitId.name.replace(' (test)', '')}</div>
                  <div className="text-[11px] text-slate-500">
                    {d.basis === 'percent' ? `${d.value}% of remaining${d.money && d.includeArrears ? ' (incl. arrears)' : ''}` : 'Fixed total'} · {d.shares} circles{d.vacantCircles ? ` · ${d.vacantCircles} vacant skipped` : ''}
                  </div>
                </div>
                <div className="flex items-center gap-2"><span className="text-lg font-bold tabular-nums">{Math.round(d.pct)}%</span><ChevronDown className={`size-4 text-slate-400 transition ${open === d._id ? 'rotate-180' : ''}`} /></div>
              </div>
              <div className="mt-2 grid grid-cols-4 divide-x divide-slate-100 rounded-lg bg-slate-50 py-1.5 text-center dark:divide-slate-800 dark:bg-slate-800/50">
                {[['Remaining', d.remainingTotal], [d.state === 'stopped' ? 'Due at stop' : 'Target', d.state === 'stopped' ? d.dueTotal : d.targetTotal], ['Verified', d.achieved], ['Circles met', null]].map(([l, v]) => (
                  <div key={l as string}><div className="text-[10px] font-medium uppercase text-slate-500">{l}</div><div className="text-sm font-bold tabular-nums">{v == null ? `${d.met}/${d.shares}` : fmt(v as number)}</div></div>
                ))}
              </div>
              <div className="mt-2"><Bullet value={d.pct} pace={d.state === 'running' ? d.elapsed : null} height={7} /></div>
              <div className="mt-1.5 flex flex-wrap items-center justify-between gap-1 text-[11px] text-slate-500">
                <span className="flex items-center gap-1.5"><StateChip state={d.state} />{PERIOD_LABEL[d.period]}{d.pending > 0 && <span className="text-amber-700">· {fmt(d.pending)} awaiting verification</span>}</span>
                <span className="tabular-nums"><span className="font-semibold">{fmtDate(d.startDate)}</span> – {d.state === 'stopped' && d.stoppedAt ? <>stopped <span className="font-semibold">{fmtDate(d.stoppedAt)}</span></> : fmtDate(d.endDate)}</span>
              </div>
              <div className="mt-1 text-center text-[10px] font-medium text-slate-400">{d.money ? MILLIONS : '(Cases)'}</div>
            </button>
            {open === d._id && <DriveShares drive={d} viewer={viewer} />}
          </Card>
        );
      })}
    </div>
  );
}

function DriveShares({ drive, viewer }: { drive: Drive; viewer: string }) {
  const { data, isLoading } = useAssigned('unit', undefined, 'all', drive._id);
  const stop = useSave(() => post(`/rev/assigned/drives/${drive._id}/stop`), [['rev']], 'Drive stopped');
  return (
    <div className="border-t border-slate-200 bg-slate-50/60 p-3 dark:border-slate-700 dark:bg-slate-800/30">
      {isLoading ? <Loading /> : <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">{data?.map((t) => <TargetCard key={t._id} t={t} viewer={viewer} compact />)}</div>}
      {drive.canStop && <Button size="sm" variant="danger" className="mt-2" loading={stop.isPending} onClick={() => confirm('Stop this drive? Shares are judged on what was due up to today, and a new drive can then be set from the remaining balance.') && stop.mutate(undefined)}>Stop drive</Button>}
    </div>
  );
}

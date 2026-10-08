import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, CheckCircle2, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { PageHeader } from '../components/AppShell';
import { Button, Card, Empty, ErrorState, Loading, SectionTitle, Segmented, useToast } from '../components/ui';
import { useSearchParams } from 'react-router-dom';
import { fmtDate } from '../lib/format';
import { useCaps } from '../lib/rev';
import { get, post } from '../lib/api';
import { fmtPKR, monthLabel } from '../lib/rev';

interface Pending {
  _id: string; head: string; headName: string; kind: 'revenue' | 'case'; month: string;
  current: number; arrear: number; received: number; disposed: number; ref?: string;
  unitId: { _id: string; name: string }; roUserId?: { name: string } | null; enteredBy: { name: string; designation?: string };
}

export default function Verify() {
  const caps = useCaps();
  const [params, setParams] = useSearchParams();
  // SCI only verifies target progress for case heads; Wasil Baqi verifies both monthly entries and revenue-head progress
  const onlyTargets = caps.isSci && !caps.isWasilBaqi;
  const tab = onlyTargets ? 'targets' : ((params.get('tab') as 'entries' | 'targets') ?? 'entries');
  return (
    <>
      <PageHeader title="Verify" subtitle={tab === 'entries' ? 'Monthly figures submitted by Patwaris in your tehsil' : 'Progress logged against assigned targets'} />
      {!onlyTargets && (
        <div className="mb-3"><Segmented value={tab} onChange={(t) => setParams({ tab: t }, { replace: true })} options={[{ value: 'entries', label: 'Monthly entries' }, { value: 'targets', label: 'Target progress' }]} /></div>
      )}
      {tab === 'entries' ? <EntryQueue /> : <TargetQueue />}
    </>
  );
}

function EntryQueue() {
  const qc = useQueryClient();
  const toast = useToast();
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['rev', 'verify'], queryFn: () => get<Pending[]>('/rev/verify') });
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const groups = useMemo(() => {
    const m = new Map<string, Pending[]>();
    for (const e of data ?? []) {
      const k = `${e.roUserId ? e.roUserId.name + ' (RO)' : e.unitId.name}|${e.month}`;
      m.set(k, [...(m.get(k) ?? []), e]);
    }
    return [...m.entries()];
  }, [data]);

  const act = useMutation({
    mutationFn: ({ action, reason }: { action: 'verify' | 'reject'; reason?: string }) => post<{ updated: number }>('/rev/verify', { ids: [...selected], action, reason }),
    onSuccess: (r, v) => {
      toast(`${r.updated} ${v.action === 'verify' ? 'verified' : 'returned'}`);
      setSelected(new Set());
      qc.invalidateQueries({ queryKey: ['rev'] });
    },
    onError: (e) => toast((e as Error).message, 'error'),
  });
  const toggle = (ids: string[], on: boolean) => setSelected((s) => { const n = new Set(s); ids.forEach((i) => (on ? n.add(i) : n.delete(i))); return n; });

  return (
    <>
      {isLoading ? <Loading /> : error ? <ErrorState error={error} retry={refetch} /> : !data?.length ? (
        <Card><Empty icon={CheckCircle2} title="Nothing to verify" body="New submissions will appear here." /></Card>
      ) : (
        <div className="pb-24 lg:pb-0">
          <div className="mb-2 flex items-center justify-between px-1 text-sm">
            <span className="text-slate-500">{data.length} entries pending · {selected.size} selected</span>
            <button className="font-medium text-brand-600" onClick={() => toggle(data.map((d) => d._id), selected.size !== data.length)}>{selected.size === data.length ? 'Clear' : 'Select all'}</button>
          </div>
          {groups.map(([k, items]) => {
            const [name, month] = k.split('|');
            const allOn = items.every((i) => selected.has(i._id));
            return (
              <div key={k}>
                <SectionTitle action={<button className="text-sm font-medium text-brand-600" onClick={() => toggle(items.map((i) => i._id), !allOn)}>{allOn ? 'Clear' : 'Select'}</button>}>
                  {name} · {monthLabel(month)} · by {items[0].enteredBy.name}
                </SectionTitle>
                <Card className="divide-y divide-slate-100 dark:divide-slate-800">
                  {items.map((e) => (
                    <label key={e._id} className="flex cursor-pointer items-center gap-3 px-4 py-3">
                      <input type="checkbox" className="size-5 accent-brand-600" checked={selected.has(e._id)} onChange={(ev) => toggle([e._id], ev.target.checked)} />
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium">{e.headName}</div>
                        <div className="text-xs text-slate-500">
                          {e.kind === 'revenue' ? <>Current {fmtPKR(e.current, { exact: true })} · Arrears {fmtPKR(e.arrear, { exact: true })} (Rs){e.ref && <> · {e.ref}</>}</> : <>Received {e.received} · Disposed {e.disposed}</>}
                        </div>
                      </div>
                    </label>
                  ))}
                </Card>
              </div>
            );
          })}
          <div className="pb-safe fixed inset-x-0 bottom-16 z-30 grid grid-cols-2 gap-2 border-t border-slate-200 bg-white/95 p-3 backdrop-blur lg:static lg:mt-4 lg:border-0 lg:bg-transparent lg:p-0 dark:border-slate-800 dark:bg-slate-900/95">
            <Button variant="secondary" disabled={!selected.size} loading={act.isPending && act.variables?.action === 'reject'} onClick={() => {
              const reason = prompt('Reason for returning these entries?');
              if (reason !== null) act.mutate({ action: 'reject', reason });
            }}><X className="size-4" />Return</Button>
            <Button disabled={!selected.size} loading={act.isPending && act.variables?.action === 'verify'} onClick={() => act.mutate({ action: 'verify' })}><Check className="size-4" />Verify {selected.size || ''}</Button>
          </div>
        </div>
      )}
    </>
  );
}

interface TP {
  targetId: string; progressId: string; head: string; headName: string; money: boolean;
  assignee: { _id: string; name: string }; unit: { _id: string; name: string }; date: string; value: number; note?: string; targetValue: number;
}

/** Progress against assigned targets awaiting verification (Wasil Baqi: revenue heads · SCI: case heads). */
function TargetQueue() {
  const qc = useQueryClient();
  const toast = useToast();
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['rev', 'assigned-verify'], queryFn: () => get<TP[]>('/rev/assigned/verify') });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const key = (p: TP) => `${p.targetId}:${p.progressId}`;
  const act = useMutation({
    mutationFn: (action: 'verify' | 'reject') =>
      post<{ updated: number }>('/rev/assigned/verify', { items: (data ?? []).filter((p) => selected.has(key(p))).map((p) => ({ targetId: p.targetId, progressId: p.progressId })), action }),
    onSuccess: (r, action) => {
      toast(`${r.updated} ${action === 'verify' ? 'verified' : 'rejected'}`);
      setSelected(new Set());
      qc.invalidateQueries({ queryKey: ['rev'] });
    },
    onError: (e) => toast((e as Error).message, 'error'),
  });
  if (isLoading) return <Loading />;
  if (error) return <ErrorState error={error} retry={refetch} />;
  if (!data?.length) return <Card><Empty icon={CheckCircle2} title="No target progress to verify" /></Card>;
  const all = data.every((p) => selected.has(key(p)));
  return (
    <div className="pb-24 lg:pb-0">
      <div className="mb-2 flex items-center justify-between px-1 text-sm">
        <span className="text-slate-500">{data.length} pending · {selected.size} selected</span>
        <button className="font-medium text-brand-600" onClick={() => setSelected(all ? new Set() : new Set(data.map(key)))}>{all ? 'Clear' : 'Select all'}</button>
      </div>
      <Card className="divide-y divide-slate-200 overflow-hidden dark:divide-slate-700">
        {data.map((p) => (
          <label key={key(p)} className="flex cursor-pointer items-center gap-3 px-4 py-3">
            <input type="checkbox" className="size-5 accent-brand-600" checked={selected.has(key(p))} onChange={(e) => setSelected((s) => { const n = new Set(s); e.target.checked ? n.add(key(p)) : n.delete(key(p)); return n; })} />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium">{p.assignee?.name} · {p.headName}</div>
              <div className="text-xs text-slate-500">{p.unit?.name} · {fmtDate(p.date)}{p.note && <> · {p.note}</>}</div>
            </div>
            <div className="text-right text-sm tabular-nums">
              <b>{p.money ? `Rs ${p.value.toLocaleString()}` : p.value}</b>
              <div className="text-[11px] text-slate-500">of {p.money ? `Rs ${p.targetValue.toLocaleString()}` : p.targetValue}</div>
            </div>
          </label>
        ))}
      </Card>
      <div className="pb-safe fixed inset-x-0 bottom-16 z-30 grid grid-cols-2 gap-2 border-t border-slate-200 bg-white/95 p-3 backdrop-blur lg:static lg:mt-4 lg:border-0 lg:bg-transparent lg:p-0 dark:border-slate-800 dark:bg-slate-900/95">
        <Button variant="secondary" disabled={!selected.size} loading={act.isPending && act.variables === 'reject'} onClick={() => act.mutate('reject')}><X className="size-4" />Reject</Button>
        <Button disabled={!selected.size} loading={act.isPending && act.variables === 'verify'} onClick={() => act.mutate('verify')}><Check className="size-4" />Verify {selected.size || ''}</Button>
      </div>
    </div>
  );
}

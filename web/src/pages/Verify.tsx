import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, CheckCircle2, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { PageHeader } from '../components/AppShell';
import { Button, Card, Empty, ErrorState, Loading, SectionTitle, useToast } from '../components/ui';
import { get, post } from '../lib/api';
import { fmtPKR, monthLabel } from '../lib/rev';

interface Pending {
  _id: string; head: string; headName: string; kind: 'revenue' | 'case'; month: string;
  current: number; arrear: number; received: number; disposed: number; ref?: string;
  unitId: { _id: string; name: string }; roUserId?: { name: string } | null; enteredBy: { name: string; designation?: string };
}

export default function Verify() {
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
      <PageHeader title="Verify figures" subtitle="Entries submitted by Patwaris in your tehsil" />
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
                          {e.kind === 'revenue' ? <>Current Rs {fmtPKR(e.current, { short: false })} · Arrears Rs {fmtPKR(e.arrear, { short: false })}{e.ref && <> · {e.ref}</>}</> : <>Received {e.received} · Disposed {e.disposed}</>}
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
